// ============================================================================
// Noctis Zone — drive a Cardano Launch DarkVeil phase on Midnight
// ============================================================================
// One action-dispatched CLI rather than nine near-identical files, matching
// tier-b-curve-action.ts and the other action CLIs: each action is a thin call
// onto NoctisLaunchManager, one process per call either way.
//
// TWO KINDS OF CALLER, and the difference decides which secret is needed:
//
//   GOVERNOR actions move the phase — advance-phase, start-registration,
//   start-buying, close, record-settlement, finalize-settlement, cancel,
//   mark-failed. They are checked in-circuit against the governorKey sealed at
//   deploy, so only the key that deployed the launch can make them.
//
//   OPENING A LAUNCH TAKES TWO OF THEM, not one. `phase` is the launch's
//   lifecycle and `dvState` is DarkVeil's sub-phase within it; registration
//   asserts both, so advance-phase(DarkVeil) AND start-registration are each
//   required before anyone can register. Neither is sufficient alone.
//
//   REGISTRANT actions are made by a participant — register, buy-commit,
//   reveal, claim-refund. Each is identified as
//   deriveUserPublicKey(getUserSecret(), launchId), and the secret is derived
//   from that registrant's own wallet seed (midnight-user-identity.ts), so the
//   seed is the only thing that has to survive between their calls.
//
// A registrant also needs their allowlist proof, which comes from the bundle
// built before the launch (build-dv-allowlist-bundle.ts) — one entry per
// registrant, keyed by role.
//
// THE COMMITMENT IS BUILT HERE, NOT ON CHAIN. `submitBuyCommit` stores whatever
// it is given and checks nothing about it; the REVEAL is what recomputes the
// value from the caller's identity and nonce. A commitment built from the wrong
// inputs therefore submits happily and fails at reveal — after buying has
// closed, with the bond locked. So `buy-commit` and `reveal` derive the nonce
// the same way from the same seed, and reveal must be given the same amount and
// price the commit used.
//
// Input: single JSON object on stdin, `action` selects the operation.
// Output: single JSON object on stdout.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { LaunchPhase } from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import type { MerkleProofEntry } from '../../contracts/midnight/witnesses.js';
import { computeBuyCommit } from '../../packages/zk-proofs/src/eligibility-gate.js';
import { fromHex32 } from '../eligibility-gate-deploy-args.js';
import { describeError } from '../error-detail.js';
import { NoctisLaunchManager, NoctisMidnightClient } from '../midnight-client.js';
import {
  assertProofServerReachable,
  buildServerWallet,
  defaultNetworkConfig,
  type MidnightNetwork,
  type SnapshotCliInput,
  snapshotOptionsFrom,
  waitForWalletState,
} from '../midnight-server-wallet.js';
import { deriveDarkVeilBuyNonce, deriveUserSecretFromSeed } from '../midnight-user-identity.js';
import { ephemeralPrivateStatePassword, inMemoryLevelFactory } from '../private-state-store.js';
import { assertZkConfigMatchesBuild } from '../zk-config-fingerprint.js';
import { jsonSafe, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

type Action =
  | 'advance-phase'
  | 'start-registration'
  | 'start-buying'
  | 'register'
  | 'buy-commit'
  | 'reveal'
  | 'close'
  | 'record-settlement'
  | 'finalize-settlement'
  | 'claim-refund'
  | 'cancel'
  | 'mark-failed'
  | 'read';

/** Actions the governor's own key must make. */
const GOVERNOR_ACTIONS = new Set<Action>([
  'advance-phase',
  'start-registration',
  'start-buying',
  'close',
  'record-settlement',
  'finalize-settlement',
  'cancel',
  'mark-failed',
]);

interface Input extends SnapshotCliInput {
  action: Action;
  network: MidnightNetwork;
  contractAddress: string;
  zkConfigBasePath: string;
  proofServerUrl: string;
  /** Pays the transaction fee. Any funded wallet; unrelated to the identity below. */
  walletSeedHex: string;

  /** Governor actions: the key sealed at deploy. */
  governorSecretHex?: string;

  /**
   * Registrant actions: the participant's own wallet seed. Their witness secret
   * and buy nonce are both derived from it, so it is the only value that has to
   * survive between their commit and their reveal.
   */
  registrantSeedHex?: string;
  /** Registrant actions: this registrant's allowlist membership proof. */
  allowlistProof?: Array<{ siblingHex: string; goesLeft: boolean }>;
  /** buy-commit / reveal: membership in the registrant tree published at start-buying. */
  registrantProof?: Array<{ siblingHex: string; goesLeft: boolean }>;

  /**
   * advance-phase: the target lifecycle phase, BY NAME ("DarkVeil", "Public",
   * …). A name rather than the underlying number because the two adjacent
   * phases either side of the one wanted are equally valid integers, and a
   * transition is one-way — an off-by-one here cannot be walked back.
   */
  phase?: string;
  /** start-buying: the root over the frozen registrant set. */
  registrantRootHex?: string;
  /** buy-commit, reveal: how many tokens, and the flat DarkVeil price. */
  tokenAmount?: string;
  pricePerToken?: string;
  /** close: when the phase closed, and the per-registrant allocation. */
  closeTimestamp?: string;
  baseSlot?: string;
  /** record-settlement: whose settlement, and how much they really settled. */
  buyerKeyHex?: string;
  settledAmount?: string;
  /** claim-refund: where the NIGHT goes, and the floor of the refund owed. */
  recipientAddrHex?: string;
  claimedRefund?: string;
  /** buy-commit, reveal, claim-refund: seconds, matching Midnight's own clock. */
  currentTimestamp?: string;

  relayUrl?: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
  syncTimeoutMs?: number;
}

function proofFrom(
  entries: Array<{ siblingHex: string; goesLeft: boolean }> | undefined,
  field: string,
): MerkleProofEntry[] {
  if (!entries) return [];
  return entries.map((entry, index) => ({
    sibling: fromHex32(entry.siblingHex, `${field}[${index}].siblingHex`),
    goesLeft: entry.goesLeft,
  }));
}

/**
 * Timestamped phase marker on stderr.
 *
 * Every phase below can block for minutes — catch-up, proving, balancing — and
 * without these a slow run and a wedged one look identical: one line of output
 * and then nothing. Which phase the silence falls in is the first thing worth
 * knowing about any failure here.
 */
const step = (message: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);

function requireBigint(value: string | undefined, field: string): bigint {
  if (value === undefined || value === '') {
    throw new Error(`${field} is required for this action.`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${field} must be an integer, got "${value}".`);
  }
  if (parsed < 0n) throw new Error(`${field} cannot be negative, got ${parsed}.`);
  return parsed;
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, ['action', 'network', 'contractAddress', 'zkConfigBasePath', 'proofServerUrl']);

  const isGovernorAction = GOVERNOR_ACTIONS.has(input.action);
  // Named per action rather than "one of these two", so the message says which
  // secret this particular call needs.
  if (isGovernorAction && !input.governorSecretHex) {
    throw new Error(`Action "${input.action}" moves the DarkVeil phase, so it needs governorSecretHex.`);
  }
  if (!isGovernorAction && input.action !== 'read' && !input.registrantSeedHex) {
    throw new Error(`Action "${input.action}" is made by a registrant, so it needs registrantSeedHex.`);
  }

  // Cheap checks before expensive ones — the artifacts are delivered by hand
  // and a missing proof server otherwise costs minutes to discover.
  assertZkConfigMatchesBuild(input.zkConfigBasePath);
  if (input.action !== 'read') await assertProofServerReachable(input.proofServerUrl);

  setNetworkId(input.network);

  const netDefaults =
    input.network === 'mainnet' ? undefined : defaultNetworkConfig(input.network, input.proofServerUrl);
  const relayUrl = input.relayUrl ?? netDefaults?.relayUrl;
  const indexerHttpUrl = input.indexerHttpUrl ?? netDefaults?.indexerHttpUrl;
  const indexerWsUrl = input.indexerWsUrl ?? netDefaults?.indexerWsUrl;
  if (!relayUrl || !indexerHttpUrl || !indexerWsUrl) {
    throw new Error(
      'relayUrl/indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "mainnet" (no confirmed defaults exist yet).',
    );
  }

  // Whose identity the circuits see. A governor action presents the governor
  // secret for both, matching what publish-allowlist-root does: no user-side
  // circuit runs, and the governor witness is the one being checked.
  const identitySecret = isGovernorAction
    ? fromHex32(input.governorSecretHex as string, 'governorSecretHex')
    : deriveUserSecretFromSeed(fromHex32(input.registrantSeedHex as string, 'registrantSeedHex'));
  const governorSecret = input.governorSecretHex
    ? fromHex32(input.governorSecretHex, 'governorSecretHex')
    : identitySecret;

  // Derived from the registrant's seed, so the same nonce is reproduced at
  // reveal without anything being carried between the two calls.
  const buyNonce = input.registrantSeedHex
    ? deriveDarkVeilBuyNonce(fromHex32(input.registrantSeedHex, 'registrantSeedHex'), input.contractAddress)
    : new Uint8Array(32);

  const serverWallet = await buildServerWallet(
    fromHex32(input.walletSeedHex, 'walletSeedHex'),
    { network: input.network, relayUrl, provingServerUrl: input.proofServerUrl, indexerHttpUrl, indexerWsUrl },
    snapshotOptionsFrom(input, 'wallet_seed', (message) => process.stderr.write(`${message}\n`)),
  );

  try {
    // Every action pays a fee, so it proves a DUST spend. Proved against a view
    // of the chain that has moved on, the node refuses it as an invalid proof —
    // a failure that names the proof rather than the staleness behind it.
    process.stderr.write('waiting for the wallet to catch up to the chain head\n');
    const synced = await waitForWalletState(
      serverWallet.facade,
      (state) => state.isSynced && state.dust.balance(new Date()) > 0n,
      input.syncTimeoutMs ?? 900_000,
      'the wallet to reach the chain head with spendable DUST',
    );

    // COINS, not just the balance. `balance(time)` is a generated figure for a
    // moment in time; the fee balancer chooses from these. The two can disagree,
    // and a wallet whose balance looks healthy while it holds nothing selectable
    // fails much later, inside the balancer, with an error that names neither.
    const dustCoins = synced.dust.availableCoins;
    step(
      `wallet ready — ${synced.dust.balance(new Date())} DUST across ${dustCoins.length} coin(s), dust index ${synced.dust.progress.appliedIndex}`,
    );

    const zkConfigProvider = new NodeZkConfigProvider(input.zkConfigBasePath);
    const providers: ContractProviders = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: 'noctis-darkveil-action',
        signingKeyStoreName: 'noctis-darkveil-action-signing',
        privateStoragePasswordProvider: ephemeralPrivateStatePassword(),
        accountId: `darkveil-${input.action}-${input.contractAddress}`,
        levelFactory: inMemoryLevelFactory(),
      }),
      publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(input.proofServerUrl, zkConfigProvider),
      walletProvider: serverWallet.walletProvider,
      midnightProvider: serverWallet.midnightProvider,
    };

    step('connecting to the contract');
    const client = new NoctisMidnightClient({ bytes: identitySecret }, { bytes: governorSecret });
    await client.connectEligibilityGate(
      providers,
      input.contractAddress,
      proofFrom(input.allowlistProof, 'allowlistProof'),
      buyNonce,
      // Only the buy actions verify against the registrant root; supplying it
      // for the others is harmless and supplying nothing for those is correct.
      input.registrantProof ? proofFrom(input.registrantProof, 'registrantProof') : undefined,
    );
    const manager = new NoctisLaunchManager(client);

    // Read first, so an action can report the state it acted on rather than
    // leaving the caller to query separately for it.
    const before = await manager.getDarkVeilSnapshot();
    step(`launch is phase=${before.phase} dvState=${before.dvState}; running "${input.action}"`);
    if (input.action !== 'read') {
      // One line, because the three stages inside it are the SDK's, not ours,
      // and it reports nothing between them — so a stall anywhere in here looks
      // the same from outside. Naming them at least says what is being waited on.
      step('prove -> balance -> submit (the proof server does the first, this process the rest)');
    }

    let result: unknown = null;
    let commitmentHex: string | undefined;

    switch (input.action) {
      case 'read':
        break;

      case 'advance-phase':
        result = await manager.advancePhase(launchPhaseFrom(input.phase));
        break;

      case 'start-registration':
        result = await manager.startRegistration();
        break;

      case 'start-buying':
        result = await manager.startBuying(
          fromHex32(requireHex(input.registrantRootHex, 'registrantRootHex'), 'registrantRootHex'),
        );
        break;

      case 'register':
        result = await manager.registerForDarkVeil();
        break;

      case 'buy-commit': {
        const tokenAmount = requireBigint(input.tokenAmount, 'tokenAmount');
        const pricePerToken = requireBigint(input.pricePerToken, 'pricePerToken');
        // Built from the same identity, launch, amount, price and nonce the
        // reveal will recompute from. The launch id comes off the contract's
        // own published certificate rather than an argument.
        const commitment = computeBuyCommit({
          buyerKey: client.callerPublicKeyFor(before.fairLaunchCert.launchId),
          launchId: before.fairLaunchCert.launchId,
          tokenAmount,
          pricePerToken,
          nonce: buyNonce,
        });
        commitmentHex = Buffer.from(commitment).toString('hex');
        result = await manager.submitDarkVeilBuyCommit(
          commitment,
          requireBigint(input.currentTimestamp, 'currentTimestamp'),
        );
        break;
      }

      case 'reveal': {
        const tokenAmount = requireBigint(input.tokenAmount, 'tokenAmount');
        const pricePerToken = requireBigint(input.pricePerToken, 'pricePerToken');
        const commitment = computeBuyCommit({
          buyerKey: client.callerPublicKeyFor(before.fairLaunchCert.launchId),
          launchId: before.fairLaunchCert.launchId,
          tokenAmount,
          pricePerToken,
          nonce: buyNonce,
        });
        commitmentHex = Buffer.from(commitment).toString('hex');
        result = await manager.revealDarkVeilBuyCommit(
          commitment,
          tokenAmount,
          pricePerToken,
          requireBigint(input.currentTimestamp, 'currentTimestamp'),
        );
        break;
      }

      case 'close':
        result = await manager.closeDarkVeil(
          requireBigint(input.closeTimestamp, 'closeTimestamp'),
          requireBigint(input.baseSlot, 'baseSlot'),
        );
        break;

      case 'record-settlement':
        result = await manager.recordDarkVeilSettlement(
          fromHex32(requireHex(input.buyerKeyHex, 'buyerKeyHex'), 'buyerKeyHex'),
          requireBigint(input.settledAmount, 'settledAmount'),
        );
        break;

      case 'finalize-settlement':
        result = await manager.finalizeDvSettlement();
        break;

      case 'claim-refund':
        result = await manager.claimRatioBondRefund(
          fromHex32(requireHex(input.recipientAddrHex, 'recipientAddrHex'), 'recipientAddrHex'),
          requireBigint(input.claimedRefund, 'claimedRefund'),
        );
        break;

      case 'cancel':
        result = await manager.cancelDarkVeil();
        break;

      case 'mark-failed':
        result = await manager.markDarkVeilFailed();
        break;

      default:
        throw new Error(`Unknown action "${input.action}".`);
    }

    // Re-read rather than reporting what was submitted: what the launch now
    // looks like is the thing a caller is driving towards.
    const after = input.action === 'read' ? before : await manager.getDarkVeilSnapshot();

    process.stdout.write(
      JSON.stringify(
        jsonSafe({
          ok: true,
          action: input.action,
          ...(commitmentHex ? { commitmentHex } : {}),
          ...(result && typeof result === 'object' && 'public' in result
            ? { tx: (result as { public: unknown }).public }
            : {}),
          state: after,
        }),
      ),
    );
  } finally {
    await serverWallet.shutdown();
  }
}

function requireHex(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required for this action.`);
  return value;
}

/**
 * Resolve a phase NAME to its enum value.
 *
 * Rejects numbers outright rather than accepting them alongside names: a
 * numeric enum carries a reverse mapping, so `LaunchPhase["1"]` is a valid
 * lookup that silently answers "DarkVeil" for a caller who meant to name a
 * phase and typed its index. Only the declared names are accepted, and the
 * error lists them.
 */
function launchPhaseFrom(name: string | undefined): LaunchPhase {
  const names = Object.keys(LaunchPhase).filter((key) => Number.isNaN(Number(key)));
  if (!name || !names.includes(name)) {
    throw new Error(`phase must be one of ${names.join(', ')} — got ${name === undefined ? 'nothing' : `"${name}"`}.`);
  }
  return LaunchPhase[name as keyof typeof LaunchPhase];
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: describeError(err) }));
  process.exitCode = 1;
});
