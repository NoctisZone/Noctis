// ============================================================================
// Noctis Zone — CTO Governance: Midnight-to-Cardano Vote Result Relayer
// ============================================================================
// Item #15. Once a proposal finalizes on Midnight's cto_governance.compact
// (finalizeProposal has set state to Passed/Failed, and for the types that
// take further action, executeProposal has run), its result needs to be
// anchored on cto_governance.ak (Cardano L1) so the reference-input
// checks already built into bonding_curve.ak/bonding_curve_tier_b.ak/
// lp_escrow.ak/vesting.ak have real evidence to verify TriggerCTO/
// DissolveCTO/ClaimCommunityAllocation against.
//
// Reuses cto-badge.ts's exact discovery mechanism (queryContractState +
// the compiled contract's own generated ledger() decoder, real Map
// iteration confirmed against the compiled .d.ts) — no separate Midnight
// read infrastructure needed. Same split as cto-badge.ts too: a pure
// conversion function (buildVoteResultFromProposal, trivially testable, no
// network/simulator needed) and a thin I/O wrapper (relayFinalizedProposal).
//
// DexMigration/WhitelistUpdate CREDENTIAL ENCODING (decided with Jinx,
// 2026-07-19): `target_dex_credential` — meaningful only for these two
// proposal types — is always encoded as a ScriptCredential. Every real
// Cardano DEX pool (Minswap/Splash/WingRiders/SundaeSwap/CSwap) is a script-controlled
// AMM pool, never a plain payment-key wallet, and lp_escrow.ak's own
// whitelist mechanism already models every real target DEX as a script
// credential exclusively (every `dex_whitelist` test entry in that file
// uses `from_script(...)`, never `from_verification_key(...)`). This anchor
// is a historical/audit record only — it does NOT drive any automatic
// fund movement or whitelist change on Cardano; lp_escrow.ak's real DEX
// whitelist stays gated behind its separate multisig+72h-notice
// mechanism, entirely untouched by this relay. That lower stakes (an
// anchor record, not live routing) is why a reasoned default was
// acceptable here rather than needing a fully bespoke encoding scheme.
// ============================================================================

import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { blake2b } from '@noble/hashes/blake2.js';
import {
  ledger,
  ProposalType as MidnightProposalType,
  ProposalState,
} from '../contracts/midnight/compiled/cto_governance/contract/index.js';
import type {
  CardanoCtoAnchorSubmitter,
  ProposalOutcomeData,
  ProposalTypeData,
  VoteResultParams,
} from './cardano-cto-anchor-submitter.js';
import { MIN_RELAYER_BOND_LOVELACE } from './cardano-cto-anchor-submitter.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Midnight's ProposalType enum -> Cardano's ProposalTypeSchema string literal. Verified index-for-index against both compiled sources (Midnight: contracts/midnight/compiled/cto_governance/contract/index.d.ts; Cardano: the fresh plutus.json) — same 5 variants, same declaration order in both languages. */
export function toCardanoProposalType(t: MidnightProposalType): ProposalTypeData {
  switch (t) {
    case MidnightProposalType.SilenceLockTrigger:
      return 'SilenceLockTrigger';
    case MidnightProposalType.FundAllocation:
      return 'FundAllocation';
    case MidnightProposalType.DexMigration:
      return 'DexMigration';
    case MidnightProposalType.WhitelistUpdate:
      return 'WhitelistUpdate';
    case MidnightProposalType.DissolveCTO:
      return 'DissolveCTOProposal';
    case MidnightProposalType.VestingToLp:
      return 'VestingToLp';
    case MidnightProposalType.VestingToStaking:
      return 'VestingToStaking';
    case MidnightProposalType.VestingToTreasury:
      return 'VestingToTreasury';
    default:
      throw new Error(`Unknown Midnight ProposalType: ${t}`);
  }
}

/**
 * The "proof bundle" pinned/hashed for a CTO vote result — same convention
 * zk-cert-relayer.ts already established for the Fair Launch Certificate
 * (fixed field order, deterministic JSON serialization, Blake2b-256). What
 * goes in here is everything a third party would need to independently
 * recompute and verify the anchored vote counts against Midnight's own
 * public ledger state — all of this is already public on Midnight (the
 * Proposal struct's own fields, per cto_governance.compact's PRIVACY
 * ANALYSIS section), so hashing it here is about giving Cardano a compact,
 * tamper-evident reference, not about hiding anything.
 */
export interface CtoVoteProofBundle {
  launchId: string;
  proposalId: string;
  proposalType: string;
  descriptionHash: string;
  yesVotes: string;
  noVotes: string;
  voterCount: string;
  creatorYesVotes: string;
  creatorNoVotes: string;
  outcome: string;
  startTimestamp: string;
  endTimestamp: string;
  /** Hex, only non-empty for DexMigration/WhitelistUpdate — included so two different target DEXes never hash identically. */
  targetDexAddrHex: string;
}

function canonicalizeVoteBundle(bundle: CtoVoteProofBundle): Uint8Array {
  const ordered = {
    launchId: bundle.launchId,
    proposalId: bundle.proposalId,
    proposalType: bundle.proposalType,
    descriptionHash: bundle.descriptionHash,
    yesVotes: bundle.yesVotes,
    noVotes: bundle.noVotes,
    voterCount: bundle.voterCount,
    creatorYesVotes: bundle.creatorYesVotes,
    creatorNoVotes: bundle.creatorNoVotes,
    outcome: bundle.outcome,
    startTimestamp: bundle.startTimestamp,
    endTimestamp: bundle.endTimestamp,
    targetDexAddrHex: bundle.targetDexAddrHex,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has an odd length (${clean.length}): ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The off-chain record of a relayed ballot, pinned for auditors.
 *
 * Distinct from the reference cto_governance.ak stores, which is derived
 * on-chain from a narrower preimage (see cto-anchor-reference.ts). This one
 * covers the whole bundle a third party would fetch from Midnight, including
 * the proposal id, and is what `CtoVoteProofBundle` is published under.
 */
export function computeCtoVoteProofBundleHash(bundle: CtoVoteProofBundle): Uint8Array {
  return blake2b(canonicalizeVoteBundle(bundle), { dkLen: 32 });
}

/** Minimal shape this needs from a decoded Midnight Proposal — matches the real compiled type's fields exactly, kept narrow so tests can construct fakes without touching real Midnight runtime types (same approach as cto-badge.ts's DecodedCtoLedger). */
export interface MidnightProposalLike {
  proposalType: MidnightProposalType;
  state: ProposalState;
  descriptionHash: Uint8Array;
  yesVotes: bigint;
  noVotes: bigint;
  voterCount: bigint;
  creatorYesVotes: bigint;
  creatorNoVotes: bigint;
  startTimestamp: bigint;
  endTimestamp: bigint;
  allocationAmount: bigint;
  allocationRecipient: Uint8Array;
  /** Only meaningful for DexMigration/WhitelistUpdate — see this file's header for the ScriptCredential-always encoding decision. */
  targetDexAddr: Uint8Array;
}

export interface BuiltVoteResult {
  bundle: CtoVoteProofBundle;
  proofBundleHash: Uint8Array;
  params: VoteResultParams;
}

/**
 * Pure conversion — no I/O. Validates the proposal has finalized, then
 * builds the proof bundle + submitter params for every proposal type.
 * Throws (never returns a partial/invalid result) on an unfinalized
 * proposal.
 */
export function buildVoteResultFromProposal(
  proposal: MidnightProposalLike,
  proposalIdHex: string,
  launchIdHex: string,
  relayerCredentialHashHex: string,
  // MILLISECONDS. cto_governance.ak binds anchor_timestamp through
  // interval.contains(validity_range, ...) and caps the range's width, and
  // every later deadline — the execution window, the challenge window — is
  // measured from it in ms.
  anchorTimestamp: bigint = BigInt(Date.now()),
  // Real ADA bond the relayer posts alongside the anchor — see
  // cardano-cto-anchor-submitter.ts's MIN_RELAYER_BOND_LOVELACE for the
  // enforced floor. Defaults to that floor; callers may post more.
  relayerBondLovelace: bigint = MIN_RELAYER_BOND_LOVELACE,
): BuiltVoteResult {
  if (proposal.state !== ProposalState.Passed && proposal.state !== ProposalState.Failed) {
    throw new Error(
      `Proposal ${proposalIdHex} has not finalized yet (state is neither Passed nor Failed) — call finalizeProposal on Midnight first`,
    );
  }

  const cardanoProposalType = toCardanoProposalType(proposal.proposalType);
  const isDexRelated =
    proposal.proposalType === MidnightProposalType.DexMigration ||
    proposal.proposalType === MidnightProposalType.WhitelistUpdate;
  const targetDexCredential: VoteResultParams['targetDexCredential'] = isDexRelated
    ? { ScriptCredential: [bytesToHex(proposal.targetDexAddr)] }
    : null;
  // Real semantic difference between the two sides, not a naming quirk:
  // Midnight's Proposal struct has NO separate outcome field — `state`
  // itself (Pending/Active/Passed/Failed/Executed) directly encodes
  // pass/fail as a state (confirmed against cto_governance.compact's own
  // struct declaration). Cardano's ProposalAnchor splits this into two
  // independent fields (outcome AND execution_status) — bridged here by
  // deriving Cardano's `outcome` from Midnight's `state` (already asserted
  // above to be Passed or Failed at this point).
  const outcome: ProposalOutcomeData = proposal.state === ProposalState.Passed ? 'Passed' : 'Failed';

  const bundle: CtoVoteProofBundle = {
    launchId: launchIdHex,
    proposalId: proposalIdHex,
    proposalType: cardanoProposalType,
    descriptionHash: bytesToHex(proposal.descriptionHash),
    yesVotes: proposal.yesVotes.toString(),
    noVotes: proposal.noVotes.toString(),
    voterCount: proposal.voterCount.toString(),
    creatorYesVotes: proposal.creatorYesVotes.toString(),
    creatorNoVotes: proposal.creatorNoVotes.toString(),
    outcome,
    startTimestamp: proposal.startTimestamp.toString(),
    endTimestamp: proposal.endTimestamp.toString(),
    targetDexAddrHex: isDexRelated ? bytesToHex(proposal.targetDexAddr) : '',
  };
  const proofBundleHash = computeCtoVoteProofBundleHash(bundle);

  const params: VoteResultParams = {
    proposalType: cardanoProposalType,
    descriptionHash: proposal.descriptionHash,
    // The ballot is named; the reference is not supplied. cto_governance.ak
    // derives that itself from its own datum, and the submitter recomputes it
    // to build a matching continuing datum — see cto-anchor-reference.ts.
    proposalId: hexToBytes(proposalIdHex),
    yesVotes: proposal.yesVotes,
    noVotes: proposal.noVotes,
    voterCount: proposal.voterCount,
    creatorYesVotes: proposal.creatorYesVotes,
    creatorNoVotes: proposal.creatorNoVotes,
    outcome,
    startTimestamp: proposal.startTimestamp,
    endTimestamp: proposal.endTimestamp,
    anchorTimestamp,
    targetDexCredential,
    allocationAmount: proposal.allocationAmount,
    allocationRecipientHash: bytesToHex(proposal.allocationRecipient),
    relayerCredentialHash: relayerCredentialHashHex,
    relayerBondLovelace,
  };

  return { bundle, proofBundleHash, params };
}

export interface RelayVoteResultResult {
  bundle: CtoVoteProofBundle;
  proofBundleHash: Uint8Array;
  txHash: string;
}

/**
 * Relays ONE finalized Midnight proposal's result to Cardano's
 * cto_governance.ak anchor. Caller supplies the launchId and proposalId
 * (hex) to look up — finding "which proposals are newly-finalized and not
 * yet anchored" (avoiding double-relay) is a separate, real operational
 * concern (polling cadence, an off-chain relay log) deliberately left to
 * the caller, same boundary this codebase already draws for
 * updateCreatorActivity's own periodic-invocation follow-up (Phase D).
 */
export async function relayFinalizedProposal(
  publicDataProvider: PublicDataProvider,
  midnightContractAddress: string,
  proposalIdHex: string,
  cardanoSubmitter: CardanoCtoAnchorSubmitter,
  relayerCredentialHashHex: string,
  // launchId is a `sealed` (non-exported) ledger field in
  // cto_governance.compact — confirmed absent from the compiled Ledger
  // type entirely (only appears as a constructor parameter) — so it
  // cannot be read back from decoded state and must be supplied by the
  // caller, who already knows which launch this relay is for.
  launchIdHex: string,
  // Real ADA bond posted alongside the anchor — see
  // buildVoteResultFromProposal's own comment.
  relayerBondLovelace: bigint = MIN_RELAYER_BOND_LOVELACE,
): Promise<RelayVoteResultResult> {
  const contractState = await publicDataProvider.queryContractState(midnightContractAddress);
  if (!contractState) {
    throw new Error(`No Midnight contract state found at ${midnightContractAddress}`);
  }
  const decoded = ledger(contractState.data);

  const proposalIdBytes = Uint8Array.from(Buffer.from(proposalIdHex, 'hex'));
  if (!decoded.proposals.member(proposalIdBytes)) {
    throw new Error(`No proposal ${proposalIdHex} found in this contract's state`);
  }
  const proposal = decoded.proposals.lookup(proposalIdBytes);

  const { bundle, proofBundleHash, params } = buildVoteResultFromProposal(
    proposal,
    proposalIdHex,
    launchIdHex,
    relayerCredentialHashHex,
    BigInt(Date.now()),
    relayerBondLovelace,
  );

  const { txHash } = await cardanoSubmitter.submitVoteResult(params);
  return { bundle, proofBundleHash, txHash };
}
