// ============================================================================
// Noctis Zone — a settled Midnight ballot, as the Cardano record takes it
// ============================================================================
// Pure conversion, shared by the server-side relayer (cto-vote-relayer.ts) and
// the browser, which hands the result to the Cardano steps
// (cto-vote-steps.ts). Two things change on the way across: a ballot's times,
// from Midnight's POSIX seconds to the milliseconds the Cardano record compares
// with a transaction's validity range, and a payee, from the ballot's 32-byte
// wallet field to the 28-byte payment key hash every Cardano contract pays.
// ============================================================================

import {
  ProposalType as MidnightProposalType,
  ProposalState,
} from '../contracts/midnight/compiled/cto_governance/contract/index.js';
import type { ProposalTypeData } from './cardano-cto-anchor-submitter.js';
import type { AnchoredBallot } from './cto-anchor-reference.js';
import { cardanoKeyHashFromBallotField } from './cto-wallet-field.js';

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
  /** POSIX seconds, as the Midnight ballot keeps time. */
  startTimestamp: bigint;
  /** POSIX seconds, as the Midnight ballot keeps time. */
  endTimestamp: bigint;
  allocationAmount: bigint;
  allocationRecipient: Uint8Array;
  /** The wallet a SilenceLockTrigger takes over with, pinned when the proposal was created. */
  proposedCommunityWallet: Uint8Array;
  /** Only meaningful for DexMigration/WhitelistUpdate — see this file's header for the ScriptCredential-always encoding decision. */
  targetDexAddr: Uint8Array;
}

/**
 * A Midnight ballot time, in POSIX seconds, as the Cardano governance record
 * keeps it: milliseconds. Every time on that record is compared with a
 * transaction's validity range, the launch's graduation time and the ballot
 * cooldown, all milliseconds. A value already at millisecond scale is refused
 * rather than scaled twice.
 */
export function midnightSecondsToCardanoMs(seconds: bigint): bigint {
  if (seconds < 0n || seconds >= 1_000_000_000_000n) {
    throw new Error(`${seconds} is not a Midnight ballot time in seconds.`);
  }
  return seconds * 1000n;
}

/**
 * Whom a ballot's execution pays, as the Cardano record keeps it: the wallet a
 * takeover names, or a fund allocation's recipient, as a 28-byte payment key
 * hash; empty for every other type. Each is read from the field the Midnight
 * proposal pinned it in when it was created.
 */
export function cardanoPayeeOf(proposal: MidnightProposalLike): string {
  switch (proposal.proposalType) {
    case MidnightProposalType.SilenceLockTrigger:
      return cardanoKeyHashFromBallotField(proposal.proposedCommunityWallet, 'The proposed community wallet');
    case MidnightProposalType.FundAllocation:
      return cardanoKeyHashFromBallotField(proposal.allocationRecipient, 'The allocation recipient');
    default:
      return '';
  }
}

/**
 * A settled Midnight ballot as the Cardano governance record takes it: its
 * outcome, its window in milliseconds, and its payee as a key hash. Pure; this
 * is what a browser hands to the Cardano side to record.
 *
 * Midnight's `state` carries the outcome: Passed or Failed once finalized, and
 * Executed once a passed proposal has been carried out on Midnight, which
 * requires it to have passed. Anything earlier has no outcome yet.
 */
export function anchoredBallotOf(proposal: MidnightProposalLike, proposalIdHex: string): AnchoredBallot {
  const settled =
    proposal.state === ProposalState.Passed ||
    proposal.state === ProposalState.Failed ||
    proposal.state === ProposalState.Executed;
  if (!settled) {
    throw new Error(
      `Proposal ${proposalIdHex} has not finalized yet (state is not Passed, Failed or Executed) — call finalizeProposal on Midnight first`,
    );
  }
  const isDexRelated =
    proposal.proposalType === MidnightProposalType.DexMigration ||
    proposal.proposalType === MidnightProposalType.WhitelistUpdate;
  return {
    proposalType: toCardanoProposalType(proposal.proposalType),
    descriptionHashHex: bytesToHex(proposal.descriptionHash),
    yesVotes: proposal.yesVotes,
    noVotes: proposal.noVotes,
    voterCount: proposal.voterCount,
    creatorYesVotes: proposal.creatorYesVotes,
    creatorNoVotes: proposal.creatorNoVotes,
    outcome: proposal.state === ProposalState.Failed ? 'Failed' : 'Passed',
    startTimestamp: midnightSecondsToCardanoMs(proposal.startTimestamp),
    endTimestamp: midnightSecondsToCardanoMs(proposal.endTimestamp),
    targetDexCredential: isDexRelated ? { kind: 'Script', hashHex: bytesToHex(proposal.targetDexAddr) } : null,
    allocationAmount: proposal.allocationAmount,
    allocationRecipientHashHex: cardanoPayeeOf(proposal),
  };
}
