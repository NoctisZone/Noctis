// ============================================================================
// Noctis Zone — reading a DarkVeil launch's published state
// ============================================================================
// Everything a launch page needs to render — the phase, the DarkVeil price and
// allocation, how much has been committed, the Fair Launch Certificate — is
// published in the contract's own public ledger. This module reads it straight
// off the indexer.
//
// That makes these figures free and permissionless to read. No wallet, no
// proof server, no DUST, and no transaction: anyone can check a launch's
// published numbers against the chain without asking the platform, which is
// the point of publishing them.
//
// Verified against the real deployed Cardano Launch gate on Preprod (contract
// 5dd23569…) before this module was written: `queryContractState` returns the
// live state, and returns `null` for an address holding no contract.
// ============================================================================

import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import {
  type Ledger as CtoGovernanceLedger,
  CtoState,
  ledger as decodeCtoGovernanceLedger,
  type Proposal,
  ProposalState,
  ProposalType,
} from '../contracts/midnight/compiled/cto_governance/contract/index.js';
import {
  type DarkVeilState,
  ledger as decodeEligibilityGateLedger,
  type Ledger as EligibilityGateLedger,
  type FairLaunchCert,
  type LaunchPhase,
} from '../contracts/midnight/compiled/eligibility_gate/contract/index.js';

export type { CtoGovernanceLedger, EligibilityGateLedger };

export async function readCtoGovernanceLedger(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<CtoGovernanceLedger> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (contractState === null) {
    throw new Error(
      `No contract found at ${contractAddress}. Check the address and that the indexer is following the same network the contract was deployed to.`,
    );
  }
  return decodeCtoGovernanceLedger(contractState.data);
}

export interface CtoProposalSummary {
  proposalIdHex: string;
  proposalType: string;
  state: string;
  proposerKeyHex: string;
  descriptionHashHex: string;
  startTimestamp: string;
  endTimestamp: string;
  yesVotes: string;
  noVotes: string;
  voterCount: string;
  creatorYesVotes: string;
  creatorNoVotes: string;
  balanceSnapshotRootHex: string;
  bond: string | null;
}

export interface CtoGovernanceSnapshot {
  ctoState: string;
  communityWalletHex: string;
  hasClaimableBalance: boolean;
  lastCreatorActivity: string;
  lastProposalEnd: string;
  proposalCount: string;
  activeProposalCount: string;
  balanceSnapshotRootHex: string;
  lastSnapshotTimestamp: string;
  snapshotRound: string;
  pendingSnapshotRootHex: string;
  pendingSnapshotOpenedAt: string;
  snapshotApprovalsThisRound: number;
  proposals: CtoProposalSummary[];
}

const enumName = (table: Record<string, string | number>, value: number) =>
  (Object.entries(table).find(([, v]) => v === value)?.[0] ?? String(value)) as string;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function summarizeCtoProposal(idHex: string, p: Proposal, bond: bigint | null): CtoProposalSummary {
  return {
    proposalIdHex: idHex,
    proposalType: enumName(ProposalType, p.proposalType),
    state: enumName(ProposalState, p.state),
    proposerKeyHex: hex(p.proposerKey),
    descriptionHashHex: hex(p.descriptionHash),
    startTimestamp: p.startTimestamp.toString(),
    endTimestamp: p.endTimestamp.toString(),
    yesVotes: p.yesVotes.toString(),
    noVotes: p.noVotes.toString(),
    voterCount: p.voterCount.toString(),
    creatorYesVotes: p.creatorYesVotes.toString(),
    creatorNoVotes: p.creatorNoVotes.toString(),
    balanceSnapshotRootHex: hex(p.balanceSnapshotRoot),
    bond: bond === null ? null : bond.toString(),
  };
}

/**
 * The published governance state, JSON-ready. Proposal ids are what the
 * off-chain side keys everything on (vote, finalize, execute, relay), and
 * they are only discoverable by walking the map — the contract has no
 * enumeration circuit — so this is where they surface.
 */
export function summarizeCtoGovernance(ledger: CtoGovernanceLedger): CtoGovernanceSnapshot {
  const round = ledger.snapshotRound;
  let approvals = 0;
  for (const [, approvedRound] of ledger.snapshotApprovals) {
    if (approvedRound === round) approvals += 1;
  }
  const proposals: CtoProposalSummary[] = [];
  for (const [id, proposal] of ledger.proposals) {
    const bond = ledger.proposalBonds.member(id) ? ledger.proposalBonds.lookup(id) : null;
    proposals.push(summarizeCtoProposal(hex(id), proposal, bond));
  }
  return {
    ctoState: enumName(CtoState, ledger.ctoState),
    communityWalletHex: hex(ledger.communityWallet),
    hasClaimableBalance: ledger.hasClaimableBalance,
    lastCreatorActivity: ledger.lastCreatorActivity.toString(),
    lastProposalEnd: ledger.lastProposalEnd.toString(),
    proposalCount: ledger.proposalCount.toString(),
    activeProposalCount: ledger.activeProposalCount.toString(),
    balanceSnapshotRootHex: hex(ledger.balanceSnapshotRoot),
    lastSnapshotTimestamp: ledger.lastSnapshotTimestamp.toString(),
    snapshotRound: round.toString(),
    pendingSnapshotRootHex: hex(ledger.pendingSnapshotRoot),
    pendingSnapshotOpenedAt: ledger.pendingSnapshotOpenedAt.toString(),
    snapshotApprovalsThisRound: approvals,
    proposals,
  };
}

export async function readCtoGovernanceSnapshot(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<CtoGovernanceSnapshot> {
  return summarizeCtoGovernance(await readCtoGovernanceLedger(publicDataProvider, contractAddress));
}

/**
 * Reads and decodes the whole published ledger of a Cardano Launch eligibility gate.
 *
 * Callers wanting only the headline figures should prefer
 * {@link readDarkVeilSnapshot}, which returns a plain, serialisable object.
 * This one hands back the raw decoded ledger, including its map-shaped fields
 * (`lockedBonds`, `cumulativePurchases`, …), which are live objects with
 * `lookup`/`member` methods rather than data.
 *
 * @throws if no contract exists at `contractAddress`.
 */
export async function readEligibilityGateLedger(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<EligibilityGateLedger> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (contractState === null) {
    throw new Error(
      `No contract found at ${contractAddress}. Check the address and that the indexer is following the same network the contract was deployed to.`,
    );
  }
  return decodeEligibilityGateLedger(contractState.data);
}

/**
 * The headline figures of a DarkVeil phase, as a plain object.
 *
 * Deliberately flat and free of live map handles so it can be serialised
 * straight to JSON — a CLI's stdout, or a widget's state — without a caller
 * having to know which fields are really method-bearing objects.
 */
export interface DarkVeilSnapshot {
  /** Where the launch as a whole has got to. */
  phase: LaunchPhase;
  /** Where the DarkVeil phase specifically has got to. */
  dvState: DarkVeilState;
  /** Whether the phase ended in failure, which routes every bond back in full. */
  dvFailed: boolean;
  /** Flat DarkVeil price per token, in the launch's own denomination. */
  dvPrice: bigint;
  /** Total tokens the DarkVeil phase may distribute. */
  dvAllocation: bigint;
  /** Per-registrant allocation, fixed once the phase closes. Zero until then. */
  baseSlot: bigint;
  /** Registrants admitted so far. */
  registrationCount: bigint;
  /** Tokens committed by revealed buys. */
  totalTokensCommitted: bigint;
  /** Value committed by revealed buys. */
  totalRaisedCommitted: bigint;
  /** The published allowlist root registrants prove membership against. */
  allowlistRootHex: string;
  /** The registrant root published when buying opens. Zero before that. */
  registrantRootHex: string;
  /** Whether the settlement record has been closed. */
  settlementFinalized: boolean;
  /** The ZK Fair Launch Certificate, filled in when the phase closes. */
  fairLaunchCert: FairLaunchCert;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Narrows a decoded ledger to the headline figures. */
export function summarizeDarkVeil(ledger: EligibilityGateLedger): DarkVeilSnapshot {
  return {
    phase: ledger.phase,
    dvState: ledger.dvState,
    dvFailed: ledger.dvFailed,
    dvPrice: ledger.dvPrice,
    dvAllocation: ledger.dvAllocation,
    baseSlot: ledger.baseSlot,
    registrationCount: ledger.registrationCount,
    totalTokensCommitted: ledger.totalTokensCommitted,
    totalRaisedCommitted: ledger.totalRaisedCommitted,
    allowlistRootHex: toHex(ledger.allowlistRoot),
    registrantRootHex: toHex(ledger.registrantRoot),
    settlementFinalized: ledger.settlementFinalized,
    fairLaunchCert: ledger.fairLaunchCert,
  };
}

/** Reads a Cardano Launch gate and returns only its headline figures. */
export async function readDarkVeilSnapshot(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<DarkVeilSnapshot> {
  return summarizeDarkVeil(await readEligibilityGateLedger(publicDataProvider, contractAddress));
}
