// ============================================================================
// Noctis Zone — CTO governance action CLI (the vote submitter)
// ============================================================================
// One process, one circuit call, against a deployed cto_governance.compact.
// The same contract as darkveil-action.ts's: JSON on stdin (never argv —
// secrets travel by pipe), JSON on stdout, progress on stderr.
//
//   read              publish what the contract holds; no wallet, no proof
//   derive-keys       print the keys a secret or seed derives to; no chain
//   publish-snapshot  attestor: approve a balance-snapshot root (2-of-3 or 3-of-3)
//   update-activity   attestor: attest the creator's last activity / claimable balance
//   heartbeat         creator: record activity, which resets the silence clock
//   create-proposal   proposer: file a proposal, bond taken from the wallet
//   vote              holder: cast a weighted vote with a snapshot leaf
//   finalize          anyone: close a ballot whose window has passed
//   execute           anyone: apply a passed proposal on the governance contract
//   claim-bond        proposer: reclaim a bond whose ballot drew quorum
//   sweep-bond        anyone: forfeit a bond whose ballot drew none
//
// Who is who: an ATTESTOR action carries `attestorSecretHex` (the governor's
// secret is attestor 1 by convention); an IDENTITY action carries
// `voterSeedHex`, the same wallet seed a DarkVeil registrant derives their
// identity from, so the wallets that bought can vote. Every submitting action
// carries `walletSeedHex`, which only pays. `currentTimestamp` defaults to
// now, in seconds — see cto-governance-actions.ts for the window.
//
// A Cardano Launch's redirects (curve fees, LP harvest, vesting freeze) are
// applied on Cardano by the Cardano execute submitter against the ANCHORED
// result; `execute` here only moves the governance contract itself. The
// relay from a finalized proposal to the Cardano anchor is cto-vote-relayer.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { MerkleProofEntry } from '../../contracts/midnight/witnesses.js';
import { deriveGovernorKey, deriveUserPublicKey } from '../../packages/zk-proofs/src/cto-governance.js';
import {
  type CtoAction,
  identityFor,
  isCtoAction,
  OFFLINE_ACTIONS,
  type ProposalInput,
  resolveCurrentTimestamp,
  resolveProposalArgs,
} from '../cto-governance-actions.js';
import { fromHex32 } from '../eligibility-gate-deploy-args.js';
import { describeError } from '../error-detail.js';
import { NoctisLaunchManager, NoctisMidnightClient } from '../midnight-client.js';
import { type CtoGovernanceSnapshot, readCtoGovernanceSnapshot } from '../midnight-public-state.js';
import {
  assertProofServerReachable,
  buildServerWallet,
  defaultNetworkConfig,
  hasUnshieldedNight,
  type MidnightNetwork,
  type SnapshotCliInput,
  snapshotOptionsFrom,
  waitForWalletState,
} from '../midnight-server-wallet.js';
import { deriveUserSecretFromSeed } from '../midnight-user-identity.js';
import { ephemeralPrivateStatePassword, inMemoryLevelFactory } from '../private-state-store.js';
import { assertZkConfigMatchesBuild } from '../zk-config-fingerprint.js';
import { jsonSafe, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface Input extends SnapshotCliInput, Partial<ProposalInput> {
  action: CtoAction;
  network: MidnightNetwork;
  contractAddress?: string;
  zkConfigBasePath?: string;
  proofServerUrl?: string;
  /** Pays. Any funded wallet; unrelated to the identity below. */
  walletSeedHex?: string;

  /** Attestor actions. `governorSecretHex` is accepted as the same thing. */
  attestorSecretHex?: string;
  governorSecretHex?: string;
  /**
   * Alternatively a wallet seed whose derived user secret is the attestor
   * secret — how a rehearsal makes a test wallet attestor 2 or 3 without a
   * second kind of secret. derive-keys reports the key such a seed gives.
   */
  attestorSeedHex?: string;
  /** Identity actions: the wallet seed the caller's launch identity derives from. */
  voterSeedHex?: string;
  /** derive-keys: the launch the voter key is scoped to. */
  launchIdHex?: string;

  /** POSIX seconds; defaults to now. */
  currentTimestamp?: string | number;

  /** publish-snapshot */
  snapshotRootHex?: string;
  /** update-activity */
  activityTimestamp?: string | number;
  hasClaimableBalance?: boolean;
  /** vote / finalize / execute / claim-bond / sweep-bond */
  proposalIdHex?: string;
  /** vote */
  support?: boolean;
  balance?: string | number;
  heldSinceTimestamp?: string | number;
  balanceProof?: Array<{ siblingHex: string; goesLeft: boolean }>;
  /** claim-bond */
  recipientAddrHex?: string;

  relayUrl?: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
  syncTimeoutMs?: number;
}

const step = (message: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function requireHex32(value: string | undefined, field: string): Uint8Array {
  if (!value) throw new Error(`${field} is required for this action.`);
  return fromHex32(value, field);
}

function requireBigint(value: string | number | undefined, field: string): bigint {
  if (value === undefined || value === '') throw new Error(`${field} is required for this action.`);
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${field} must be an integer, got ${JSON.stringify(value)}.`);
  }
  if (parsed < 0n) throw new Error(`${field} cannot be negative, got ${parsed}.`);
  return parsed;
}

function proofFrom(entries: Input['balanceProof'], field: string): MerkleProofEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${field} is required for this action — the voter's sibling path from the snapshot bundle.`);
  }
  return entries.map((entry, index) => ({
    sibling: fromHex32(entry.siblingHex, `${field}[${index}].siblingHex`),
    goesLeft: Boolean(entry.goesLeft),
  }));
}

function networkUrls(input: Input, proofServerUrl: string) {
  const netDefaults = input.network === 'mainnet' ? undefined : defaultNetworkConfig(input.network, proofServerUrl);
  const relayUrl = input.relayUrl ?? netDefaults?.relayUrl;
  const indexerHttpUrl = input.indexerHttpUrl ?? netDefaults?.indexerHttpUrl;
  const indexerWsUrl = input.indexerWsUrl ?? netDefaults?.indexerWsUrl;
  if (!relayUrl || !indexerHttpUrl || !indexerWsUrl) {
    throw new Error(
      'relayUrl/indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "mainnet" (no confirmed defaults exist yet).',
    );
  }
  return { relayUrl, indexerHttpUrl, indexerWsUrl };
}

/** The attestor secret an input names, from a secret or from a seed; undefined when it names neither. */
function attestorSecretFrom(input: Input): Uint8Array | undefined {
  const secretHex = input.attestorSecretHex ?? input.governorSecretHex;
  if (secretHex && input.attestorSeedHex) {
    throw new Error('Give attestorSecretHex or attestorSeedHex, not both.');
  }
  if (secretHex) return fromHex32(secretHex, 'attestorSecretHex');
  if (input.attestorSeedHex) return deriveUserSecretFromSeed(fromHex32(input.attestorSeedHex, 'attestorSeedHex'));
  return undefined;
}

/** The ids present after a call that were not present before: for create-proposal, the new proposal. */
function newProposalIds(before: CtoGovernanceSnapshot, after: CtoGovernanceSnapshot): string[] {
  const seen = new Set(before.proposals.map((p) => p.proposalIdHex));
  return after.proposals.map((p) => p.proposalIdHex).filter((id) => !seen.has(id));
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, ['action', 'network']);
  if (!isCtoAction(input.action)) {
    throw new Error(`Unknown action ${JSON.stringify(input.action)}.`);
  }
  setNetworkId(input.network);

  // ---- offline: derive-keys ------------------------------------------------
  if (input.action === 'derive-keys') {
    const out: Record<string, string> = {};
    const attestorSecret = attestorSecretFrom(input);
    if (attestorSecret) {
      out.attestorKeyHex = toHex(deriveGovernorKey(attestorSecret));
    }
    if (input.voterSeedHex) {
      const launchId = requireHex32(input.launchIdHex, 'launchIdHex');
      const secret = deriveUserSecretFromSeed(fromHex32(input.voterSeedHex, 'voterSeedHex'));
      out.voterKeyHex = toHex(deriveUserPublicKey(secret, launchId));
      out.launchIdHex = toHex(launchId);
    }
    if (Object.keys(out).length === 0) {
      throw new Error(
        'derive-keys needs attestorSecretHex or attestorSeedHex (for an attestor key) and/or voterSeedHex + launchIdHex (for a voter key).',
      );
    }
    process.stdout.write(JSON.stringify({ ok: true, action: input.action, ...out }));
    return;
  }

  // ---- read: public state only --------------------------------------------
  requireFieldsFalsy(input, ['contractAddress']);
  const contractAddress = input.contractAddress as string;

  if (input.action === 'read') {
    const { indexerHttpUrl, indexerWsUrl } = networkUrls(input, input.proofServerUrl ?? 'http://unused');
    const publicDataProvider = indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl);
    const state = await readCtoGovernanceSnapshot(publicDataProvider, contractAddress);
    process.stdout.write(JSON.stringify(jsonSafe({ ok: true, action: input.action, state })));
    return;
  }

  // ---- submitting actions --------------------------------------------------
  requireFieldsFalsy(input, ['zkConfigBasePath', 'proofServerUrl', 'walletSeedHex']);
  const zkConfigBasePath = input.zkConfigBasePath as string;
  const proofServerUrl = input.proofServerUrl as string;

  const requirement = identityFor(input.action);
  const namedAttestorSecret = attestorSecretFrom(input);
  if (requirement === 'attestor' && !namedAttestorSecret) {
    throw new Error(
      `Action "${input.action}" is made by an attestor, so it needs attestorSecretHex or attestorSeedHex.`,
    );
  }
  if (requirement === 'identity' && !input.voterSeedHex) {
    throw new Error(`Action "${input.action}" is made by a launch identity, so it needs voterSeedHex.`);
  }

  // Resolved before the wallet syncs, so a bad argument costs nothing.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const currentTimestamp = resolveCurrentTimestamp(input.currentTimestamp, nowSeconds);
  const proposal = input.action === 'create-proposal' ? resolveProposalArgs(input as ProposalInput) : null;

  // The identity the witnesses answer with. An attestor action's
  // getGovernorSecret is the attestor's own secret; an identity action's
  // getUserSecret is derived from the seed exactly as DarkVeil derives it.
  const attestorSecret = namedAttestorSecret ?? new Uint8Array(32);
  const identitySecret = input.voterSeedHex
    ? deriveUserSecretFromSeed(fromHex32(input.voterSeedHex, 'voterSeedHex'))
    : attestorSecret;

  assertZkConfigMatchesBuild(zkConfigBasePath, 'cto_governance');
  await assertProofServerReachable(proofServerUrl);
  const { relayUrl, indexerHttpUrl, indexerWsUrl } = networkUrls(input, proofServerUrl);

  const serverWallet = await buildServerWallet(
    fromHex32(input.walletSeedHex as string, 'walletSeedHex'),
    { network: input.network, relayUrl, provingServerUrl: proofServerUrl, indexerHttpUrl, indexerWsUrl },
    snapshotOptionsFrom(input, 'wallet_seed', (message) => process.stderr.write(`${message}\n`)),
  );

  try {
    // A proposal's bond is real NIGHT taken from this wallet, so the wait
    // includes having some; every other action only needs DUST for the fee.
    const needsNight = input.action === 'create-proposal';
    step('waiting for the wallet to catch up to the chain head');
    const synced = await waitForWalletState(
      serverWallet.facade,
      (state) => state.isSynced && state.dust.balance(new Date()) > 0n && (!needsNight || hasUnshieldedNight(state)),
      input.syncTimeoutMs ?? 900_000,
      needsNight
        ? 'the wallet to reach the chain head with spendable DUST and NIGHT for the bond'
        : 'the wallet to reach the chain head with spendable DUST',
    );
    step(`wallet ready — ${synced.dust.balance(new Date())} DUST across ${synced.dust.availableCoins.length} coin(s)`);

    const zkConfigProvider = new NodeZkConfigProvider(zkConfigBasePath);
    const providers: ContractProviders = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: 'noctis-cto-governance-action',
        signingKeyStoreName: 'noctis-cto-governance-action-signing',
        privateStoragePasswordProvider: ephemeralPrivateStatePassword(),
        accountId: `cto-${input.action}-${contractAddress}`,
        levelFactory: inMemoryLevelFactory(),
      }),
      publicDataProvider: indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(proofServerUrl, zkConfigProvider),
      walletProvider: serverWallet.walletProvider,
      midnightProvider: serverWallet.midnightProvider,
    };

    const before = await readCtoGovernanceSnapshot(providers.publicDataProvider, contractAddress);
    step(
      `contract is ${before.ctoState}, ${before.proposalCount} proposal(s), snapshot round ${before.snapshotRound}; running "${input.action}"`,
    );

    // A vote connects with its own leaf; everything else with an empty one.
    const leafBalance = input.action === 'vote' ? requireBigint(input.balance, 'balance') : 0n;
    const leafHeldSince = input.action === 'vote' ? requireBigint(input.heldSinceTimestamp, 'heldSinceTimestamp') : 0n;
    const leafProof = input.action === 'vote' ? proofFrom(input.balanceProof, 'balanceProof') : [];

    step('connecting to the contract');
    const client = new NoctisMidnightClient({ bytes: identitySecret }, { bytes: attestorSecret });
    await client.connectCtoGovernance(providers, contractAddress, leafBalance, leafProof, leafHeldSince);
    const manager = new NoctisLaunchManager(client);

    step('prove -> balance -> submit (the proof server does the first, this process the rest)');
    let result: unknown;
    switch (input.action) {
      case 'publish-snapshot':
        result = await manager.updateBalanceSnapshot(
          requireHex32(input.snapshotRootHex, 'snapshotRootHex'),
          currentTimestamp,
        );
        break;

      case 'update-activity': {
        if (typeof input.hasClaimableBalance !== 'boolean') {
          throw new Error('update-activity needs hasClaimableBalance (true or false).');
        }
        result = await manager.updateCreatorActivity(
          requireBigint(input.activityTimestamp, 'activityTimestamp'),
          input.hasClaimableBalance,
          currentTimestamp,
        );
        break;
      }

      case 'heartbeat':
        result = await manager.recordCreatorHeartbeat(currentTimestamp);
        break;

      case 'create-proposal': {
        const p = proposal as NonNullable<typeof proposal>;
        result = await manager.createCtoProposal(
          p.proposalType,
          p.descriptionHash,
          currentTimestamp,
          p.targetDexAddr,
          p.allocationAmount,
          p.allocationRecipient,
          p.proposedCommunityWallet,
          p.bondAmount,
        );
        break;
      }

      case 'vote': {
        if (typeof input.support !== 'boolean') throw new Error('vote needs support (true for yes, false for no).');
        result = await manager.castVote(
          requireHex32(input.proposalIdHex, 'proposalIdHex'),
          input.support,
          currentTimestamp,
        );
        break;
      }

      case 'finalize':
        result = await manager.finalizeCtoProposal(
          requireHex32(input.proposalIdHex, 'proposalIdHex'),
          currentTimestamp,
        );
        break;

      case 'execute':
        result = await manager.executeCtoProposalGovernanceOnly(requireHex32(input.proposalIdHex, 'proposalIdHex'));
        break;

      case 'claim-bond':
        result = await manager.claimProposalBond(
          requireHex32(input.proposalIdHex, 'proposalIdHex'),
          requireHex32(input.recipientAddrHex, 'recipientAddrHex'),
        );
        break;

      case 'sweep-bond':
        result = await manager.sweepForfeitedProposalBond(requireHex32(input.proposalIdHex, 'proposalIdHex'));
        break;

      default:
        throw new Error(`Action "${input.action}" is not a submitting action.`);
    }

    const after = await readCtoGovernanceSnapshot(providers.publicDataProvider, contractAddress);
    const created = input.action === 'create-proposal' ? newProposalIds(before, after) : [];

    process.stdout.write(
      JSON.stringify(
        jsonSafe({
          ok: true,
          action: input.action,
          currentTimestamp,
          ...(created.length === 1
            ? { proposalIdHex: created[0] }
            : created.length > 1
              ? { proposalIdsHex: created }
              : {}),
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

// OFFLINE_ACTIONS is the documented set; the switch above is the enforcement.
void OFFLINE_ACTIONS;

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: describeError(err) }));
  process.exitCode = 1;
});
