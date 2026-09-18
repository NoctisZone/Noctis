// ============================================================================
// Noctis Zone — deploy the Cardano Launch eligibility gate to Midnight
// ============================================================================
// WHY THIS EXISTS
// `midnight-client.ts` has had seven working, unit-tested deploy methods for
// weeks, and not one of them had a caller outside its tests. There was no
// operational way to put a PSM on chain at all, which is why no launch carried
// a `midnight_contract_address` and why the whole DarkVeil path had never run.
//
// WHO ENDS UP GOVERNING
// The constructor calls exactly ONE witness — `getGovernorSecret()` — and
// writes the key derived from it into `governorKey`, sealed. Whoever deploys
// therefore becomes the governor permanently: only that key can publish an
// allowlist root, open buying, or close DarkVeil. `governorSecretHex` is not a
// convenience credential for this call; it is the launch's governance.
//
// The other four witnesses (user secret, allowlist proof, registrant proof,
// buy nonce) are lazy thunks the constructor never evaluates. They are passed
// as well-formed placeholders rather than empty values so that anything which
// later does read them fails on content rather than on shape.
//
// WHAT THIS REFUSES BEFORE SPENDING ANYTHING
// Every assertion the constructor makes is mirrored here. A deploy that fails
// on chain still costs a transaction and a round trip, and its error names the
// circuit rather than the field. The one rule the contract documents but
// cannot enforce — `walletCap = totalSupply * maxWalletPercent / 100`, because
// Compact circuits cannot divide — is computed here instead of trusted.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { MerkleProofEntry } from '../../contracts/midnight/witnesses.js';
import { DOMAINS, deriveRoleKey } from '../../contracts/midnight/witnesses.js';
import { resolveDarkVeilBond } from '../darkveil-bond-pricing.js';
import { fromHex32, resolveEligibilityGateDeployArgs } from '../eligibility-gate-deploy-args.js';
import { describeError, safeShow, unwrapForDiagnosis } from '../error-detail.js';
import { NoctisMidnightClient } from '../midnight-client.js';
import {
  assertProofServerReachable,
  buildServerWallet,
  defaultNetworkConfig,
  type MidnightNetwork,
  type SnapshotCliInput,
  snapshotOptionsFrom,
  waitForWalletState,
} from '../midnight-server-wallet.js';
import { ephemeralPrivateStatePassword, inMemoryLevelFactory } from '../private-state-store.js';
import { assertZkConfigMatchesBuild } from '../zk-config-fingerprint.js';
import { jsonSafe, parseJsonStdin, readStdin, requireFieldsFalsy, requireFieldsStrict } from './cli-io.js';

interface Input extends SnapshotCliInput {
  network: MidnightNetwork;
  /** Becomes the contract's permanent governor — see the header. */
  governorSecretHex: string;
  /** Funds the deployment transaction. */
  walletSeedHex: string;
  proofServerUrl: string;
  zkConfigBasePath: string;
  relayUrl?: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;

  launchIdHex: string;
  allowlistRootHex: string;
  creatorPubKeyHex: string;
  platformAddrHex: string;
  /**
   * The three attestors that may raise this contract's allowlist root, given
   * EITHER way round — exactly one of the two, never both.
   *
   * `allowlistAttestorSecretsHex` is the right one when one operator holds all
   * three (a rehearsal, a devnet): the keys are DERIVED here, so a value that
   * is merely 32 bytes of the right shape cannot reach the constructor.
   *
   * `allowlistAttestorKeysHex` is for the real arrangement, where the three
   * are separate parties who derive their own key and hand over only that.
   * Nothing can check a key has a holder — that is what the separation buys
   * and what it costs — so supply keys only when each came from its holder.
   */
  allowlistAttestorSecretsHex?: [string, string, string];
  allowlistAttestorKeysHex?: [string, string, string];
  allowlistThreshold: number;

  /**
   * Circuits this deploy leaves out, to be added afterwards by maintenance
   * update, authorised by a signing key derived from `governorSecretHex` and
   * `launchIdHex`.
   *
   * A deploy writes the contract's whole state at once — the constructor's
   * ledger state plus a verifier key per exported circuit — and a block caps
   * the bytes written in it. Naming circuits here is how a contract whose keys
   * total more than that budget reaches the chain intact.
   *
   * Omitted, the deploy carries every circuit.
   */
  deferCircuits?: string[];

  /**
   * How long to allow for the funding wallet to reach the chain head before
   * giving up. Resuming from a recent snapshot this is minutes; from an old one
   * or none at all it is much longer, and a bounded wait says so rather than
   * hanging.
   */
  syncTimeoutMs?: number;

  totalSupply: string;
  maxWalletPercent: number;
  /**
   * Optional. Omitted, the bond is priced at the current NIGHT rate from
   * `bondUsd` — which is what a launch should normally do, because the bond is
   * sealed for the life of the launch and a figure carried over from an
   * earlier deploy prices a different market. Supplied, it is held to that
   * same rate and refused if it disagrees beyond `bondToleranceBps`.
   *
   * Whatever is sealed here is the figure registration must pay. Registration
   * reads it back off the contract rather than re-deriving it — deriving it
   * twice, 48 hours apart, is how every registration comes to fail.
   */
  bondAmount?: string;
  /** Defaults to CLAUDE.md's NIGHT_BOND_USD. */
  bondUsd?: number;
  /** Defaults to BOND_SPOT_TOLERANCE_BPS. Only consulted when bondAmount is supplied. */
  bondToleranceBps?: string | number;
  dvAllocation: string;
  dvPrice: string;
  allowlistSize: number;
  registrationCloseTime: string;
  minDvParticipants: number;
  /**
   * Optional. Omitted, it is computed as totalSupply * maxWalletPercent / 100,
   * which is what the contract documents and cannot check. Supplied, it must
   * equal that — a mismatch is refused rather than silently mis-capping the
   * launch for its whole life.
   */
  walletCap?: string;
}

/**
 * Turn whichever attestor form was supplied into the three keys the
 * constructor takes, refusing both forms and neither.
 *
 * Exported for the same reason resolveEligibilityGateDeployArgs is: a CLI runs
 * main() on import and cannot be exercised directly, and this is the part
 * worth exercising.
 */
export function resolveAttestorKeysHex(input: Input): [string, string, string] {
  const secrets = input.allowlistAttestorSecretsHex;
  const keys = input.allowlistAttestorKeysHex;
  if (secrets && keys) {
    throw new Error(
      'Supply allowlistAttestorSecretsHex OR allowlistAttestorKeysHex, not both — ' +
        'two answers to who the attestors are is one answer too many.',
    );
  }
  if (!secrets && !keys) {
    throw new Error(
      'One of allowlistAttestorSecretsHex or allowlistAttestorKeysHex is required. ' +
        'Prefer secrets unless the three attestors are separate parties who derived their own keys.',
    );
  }
  if (keys) return keys;
  if (!Array.isArray(secrets) || secrets.length !== 3) {
    throw new Error('allowlistAttestorSecretsHex must be exactly three secrets.');
  }
  return secrets.map((hex, i) => {
    const sk = fromHex32(hex, `allowlistAttestorSecretsHex[${i}]`);
    return Buffer.from(deriveRoleKey({ bytes: sk }, DOMAINS.ELIGIBILITY_GOVERNOR).bytes).toString('hex');
  }) as [string, string, string];
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());

  requireFieldsFalsy(input, [
    'network',
    'governorSecretHex',
    'walletSeedHex',
    'proofServerUrl',
    'zkConfigBasePath',
    'launchIdHex',
    'allowlistRootHex',
    'creatorPubKeyHex',
    'platformAddrHex',
    'allowlistThreshold',
    'totalSupply',
    'maxWalletPercent',
    'dvAllocation',
    'dvPrice',
    'registrationCloseTime',
    'minDvParticipants',
  ]);

  // allowlistSize is the one field here that is legitimately zero: a launch
  // deploys before anyone has registered, and the governor raises the root as
  // registrants pass eligibility. A falsy check cannot express that, so it
  // gets the validator that rejects only undefined, null and '' — the count
  // is still bounds-checked downstream by resolveEligibilityGateDeployArgs.
  requireFieldsStrict(input, ['allowlistSize']);

  // A key is a hash, so any 32 bytes look like one. The allowlist attestor
  // slots are the only constructor arguments where that mattered and nothing
  // downstream could catch it: deploy with three values nobody holds a secret
  // for and every check still passes, the contract seals them, and
  // updateAllowlistRoot becomes unsatisfiable by anyone — no root, no
  // registration, for the life of the launch. Deriving from secrets here is
  // what makes the shape and the holder the same question.
  const attestorKeysHex = resolveAttestorKeysHex(input);

  // Before the wallet, the network, or anything that costs time or money.
  assertZkConfigMatchesBuild(input.zkConfigBasePath, 'eligibility_gate');

  // Same principle: cheap checks before expensive ones.
  await assertProofServerReachable(input.proofServerUrl);

  setNetworkId(input.network);

  // The bond is priced here, once, and sealed by this deploy. It is the cost
  // of a second DarkVeil identity rather than a display figure, so a stale one
  // is a cap that does not bind. A caller may still name its own figure; it is
  // held to the same rate and refused if it disagrees.
  //
  // This runs before the wallet because it is a cheap check that can refuse the
  // whole deploy, and after the reachability checks for the same reason.
  const bond = await resolveDarkVeilBond(input.bondAmount, input.bondUsd, input.bondToleranceBps);
  process.stderr.write(
    `DarkVeil bond: ${bond.bondAmount} atomic NIGHT ` +
      `(${(Number(bond.bondAmount) / 1e6).toFixed(6)} NIGHT) for $${bond.quote.usd} at ` +
      `$${bond.quote.nightUsdApprox.toPrecision(4)}/NIGHT over ${bond.quote.twapSamplesUsed} samples` +
      `${bond.wasSupplied ? ' — supplied by the caller and checked against that rate' : ' — priced now'}
`,
  );

  // Every constructor assertion, mirrored — and walletCap DERIVED rather than
  // trusted, since the contract can only check it is positive. Lifted into
  // eligibility-gate-deploy-args.ts so it is reachable by a test; this file
  // runs main() on import and is not.
  const args = resolveEligibilityGateDeployArgs({
    ...input,
    allowlistAttestorKeysHex: attestorKeysHex,
    bondAmount: bond.bondAmount.toString(),
  });

  // --- providers ----------------------------------------------------------

  const governorSecret = fromHex32(input.governorSecretHex, 'governorSecretHex');
  const walletSeed = fromHex32(input.walletSeedHex, 'walletSeedHex');

  const netDefaults = defaultNetworkConfig(input.network, input.proofServerUrl);
  const networkConfig = {
    network: input.network,
    provingServerUrl: input.proofServerUrl,
    relayUrl: input.relayUrl ?? netDefaults?.relayUrl,
    indexerHttpUrl: input.indexerHttpUrl ?? netDefaults?.indexerHttpUrl,
    indexerWsUrl: input.indexerWsUrl ?? netDefaults?.indexerWsUrl,
  };
  if (!networkConfig.relayUrl || !networkConfig.indexerHttpUrl || !networkConfig.indexerWsUrl) {
    throw new Error(`relayUrl/indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "${input.network}".`);
  }

  // A deployment is paid for in DUST, and a wallet only sees its DUST once it
  // has replayed far enough to find it. Resuming from a snapshot is what makes
  // that affordable here; without one this wallet replays from chain.
  const serverWallet = await buildServerWallet(
    walletSeed,
    {
      network: networkConfig.network,
      relayUrl: networkConfig.relayUrl,
      provingServerUrl: networkConfig.provingServerUrl,
      indexerHttpUrl: networkConfig.indexerHttpUrl,
      indexerWsUrl: networkConfig.indexerWsUrl,
    },
    snapshotOptionsFrom(input, 'wallet_seed', (message) => process.stderr.write(`${message}\n`)),
  );

  try {
    // A wallet is returned started, not synced. Proving a DUST spend against a
    // view of the chain that has moved on produces a proof the node rejects as
    // InvalidDustSpendProof (170) — the transaction is well-formed and the fee
    // is affordable, so the failure names the proof rather than the staleness
    // behind it. Resuming from a snapshot makes this a short catch-up rather
    // than a full replay, but it is still a wait that has to happen before
    // anything is built.
    const readyBy = Date.now() + (input.syncTimeoutMs ?? 900_000);
    process.stderr.write('waiting for the funding wallet to catch up to the chain head\n');
    const ready = await waitForWalletState(
      serverWallet.facade,
      (state) => state.isSynced && state.dust.balance(new Date()) > 0n,
      Math.max(readyBy - Date.now(), 1),
      'the funding wallet to reach the chain head with spendable DUST',
    );
    process.stderr.write(`caught up; spendable DUST ${ready.dust.balance(new Date())}\n`);

    const zkConfigProvider = new NodeZkConfigProvider(input.zkConfigBasePath);
    const providers: ContractProviders = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: 'noctis-deploy-eligibility-gate',
        signingKeyStoreName: 'noctis-deploy-eligibility-gate-signing',
        // One-shot process: the private state never needs to outlive it.
        privateStoragePasswordProvider: ephemeralPrivateStatePassword(),
        accountId: `deploy-eligibility-gate-${input.launchIdHex}`,
        levelFactory: inMemoryLevelFactory(),
      }),
      publicDataProvider: indexerPublicDataProvider(networkConfig.indexerHttpUrl, networkConfig.indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(networkConfig.provingServerUrl, zkConfigProvider),
      walletProvider: serverWallet.walletProvider,
      midnightProvider: serverWallet.midnightProvider,
    };

    // The governor secret is passed in BOTH positions deliberately: the
    // constructor reads it via getGovernorSecret, and this process has no
    // separate user identity to act as.
    const client = new NoctisMidnightClient({ bytes: governorSecret }, { bytes: governorSecret });

    // Shape-correct placeholders. The constructor evaluates none of these —
    // verified by brace-matching its body, whose only witness call is
    // getGovernorSecret — but a well-formed value fails on content rather than
    // on shape if that ever changes.
    const emptyProof: MerkleProofEntry[] = Array.from({ length: 20 }, () => ({
      sibling: new Uint8Array(32),
      goesLeft: false,
    }));
    const zeroNonce = new Uint8Array(32);

    const record = await client.deployEligibilityGate(
      providers,
      args,
      emptyProof,
      zeroNonce,
      input.deferCircuits ?? [],
    );

    process.stdout.write(
      JSON.stringify(
        jsonSafe({
          ok: true,
          contractAddress: record.contractAddress,
          launchIdHex: input.launchIdHex,
          walletCap: args.walletCap.toString(),
          // The sealed bond, and the quote that justified it. RECORD THIS
          // AGAINST THE LAUNCH. Registration reads the figure back off the
          // contract and pays that; this record is the second opinion that
          // makes a disagreement visible as an error instead of as a
          // registration that will not go through.
          bondAmount: bond.bondAmount.toString(),
          bondQuote: {
            usd: bond.quote.usd,
            nightUsdApprox: bond.quote.nightUsdApprox,
            twapSamplesUsed: bond.quote.twapSamplesUsed,
            sources: bond.quote.sources,
            quotedAtMs: bond.quote.quotedAtMs,
            suppliedByCaller: bond.wasSupplied,
          },
          ...(record.pendingCircuits ? { pendingCircuits: record.pendingCircuits } : {}),
          note: record.pendingCircuits
            ? 'Record contractAddress against the launch — the whole DarkVeil path keys off it. ' +
              'This contract does not yet answer the circuits in pendingCircuits: add their verifier ' +
              'keys with the same governor secret and launch id before relying on them.'
            : 'Record contractAddress against the launch — the whole DarkVeil path keys off it.',
        }),
      ),
    );
  } finally {
    await serverWallet.shutdown();
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: describeError(err) }));
  if (process.env.NP_STACK) {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? String(err)) : String(err)}\n`);
    for (let e: unknown = unwrapForDiagnosis(err), depth = 0; e && depth < 6; depth++) {
      const record = e as unknown as Record<string, unknown>;
      const own = [...Object.getOwnPropertyNames(e as object), ...Object.getOwnPropertySymbols(e as object)]
        .map((k) => `${String(k)}=${safeShow(record[k as string])}`)
        .join('\n    ');
      process.stderr.write(`  [${depth}] ${(e as object).constructor?.name}\n    ${own}\n`);
      e = record.cause;
    }
  }
  process.exitCode = 1;
});
