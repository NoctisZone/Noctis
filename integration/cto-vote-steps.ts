// ============================================================================
// Noctis Zone — carrying a finished takeover vote through on Cardano
// ============================================================================
// A ballot runs on Midnight. What it decided reaches a launch's contracts
// through the launch's governance record on Cardano, in steps anyone may take
// and the vote's proposer is expected to, from their own wallet:
//
//   1. record    the ballot's result, posting the relayer bond
//   2. wait      24 hours, while the governor may void a result that is false
//   3. execute   a passed result; one that failed, or passed and went
//                unexecuted for 30 days, is marked expired instead
//   4. apply     an executed takeover or dissolve to each contract
//                (cto-takeover-effects.ts), or carry out a disposition
//                (cto-disposition.ts)
//   5. reclaim   the bond, which returns to the key that posted it
//   6. clear     the settled result, so the next vote's can be recorded
//
// This module reads where a launch's record stands and plans steps 1, 3, 5 and
// 6 for the shared builder (cto-takeover-tx.ts). Each plan writes the record
// exactly as cto_governance.ak's own transition does, since the validator
// compares the continuing record field by field, and each refuses up front,
// in words, what the validator would refuse.
// ============================================================================

import { Constr, credentialToAddress, Data, getAddressDetails } from '@lucid-evolution/lucid';
import {
  type AnchorVoteResultRedeemerData,
  AnchorVoteResultRedeemerSchema,
  type CtoGovernanceDatumData,
  CtoGovernanceDatumSchema,
  MIN_RELAYER_BOND_LOVELACE,
  type ProposalAnchorData,
} from './cardano-cto-anchor-submitter.js';
import { type AnchoredBallot, deriveAnchorReferenceHex } from './cto-anchor-reference.js';
import { threadUnit } from './cto-disposition.js';
import { type DatumUtxo, readByUnit, type TakeoverOutput, type TakeoverTxPlan } from './cto-takeover-tx.js';
import type { CurveNetwork, PlanAssets } from './mesh-curve-spend.js';
import { CTO_GOVERNANCE_REDEEMER } from './redeemer-indices.js';
import { type LpEscrowDatumData, LpEscrowDatumSchema, settlementDatum } from './tier-a-schemas.js';

// The governance validator's own windows, in milliseconds.
export const CHALLENGE_WINDOW_MS = 86_400_000n;
export const EXECUTION_WINDOW_MS = 2_592_000_000n;
export const BALLOT_COOLDOWN_MS = 7_776_000_000n;
export const POST_GRADUATION_DELAY_MS = 7_776_000_000n;

/**
 * How far either side of now a step's validity range reaches. The validator
 * caps a range at ten minutes; two either side leaves room for the wallet to
 * sign and the transaction to land.
 */
export const STEP_VALIDITY_HALF_WIDTH_MS = 120_000n;

/**
 * A step bound to a deadline waits this long past it: the whole validity range
 * has to be past the deadline, and the range's start is rounded down to a slot.
 */
const PAST_DEADLINE_MARGIN_MS = STEP_VALIDITY_HALF_WIDTH_MS + 2_000n;

export type GovernanceRecord = DatumUtxo<CtoGovernanceDatumData>;

export interface VoteRecordState {
  record: GovernanceRecord;
  /** The launch's LP escrow, read for its graduation time. Absent before graduation. */
  lpEscrow?: DatumUtxo<LpEscrowDatumData>;
}

export type VoteStep = 'record' | 'execute' | 'expire' | 'reclaim' | 'clear';

/** Where a launch's governance record stands, and the one step that can be taken next. */
export type VoteStage =
  | { kind: 'open'; next: 'record'; nextBallotFromMs: bigint | null }
  | { kind: 'challenge'; next: null; proposal: ProposalAnchorData; executableFromMs: bigint }
  | { kind: 'executable'; next: 'execute'; proposal: ProposalAnchorData; executableUntilMs: bigint }
  | { kind: 'awaiting-expiry'; next: null; proposal: ProposalAnchorData; expirableFromMs: bigint }
  | { kind: 'expirable'; next: 'expire'; proposal: ProposalAnchorData }
  | {
      kind: 'settled';
      next: 'reclaim' | 'clear';
      proposal: ProposalAnchorData;
      bondLovelace: bigint;
      relayerKeyHash: string;
    };

export function voteStage(record: CtoGovernanceDatumData, nowMs: bigint): VoteStage {
  const proposal = record.active_proposal;
  if (!proposal) {
    return {
      kind: 'open',
      next: 'record',
      nextBallotFromMs:
        record.last_ballot_end_timestamp === 0n ? null : record.last_ballot_end_timestamp + BALLOT_COOLDOWN_MS,
    };
  }
  if (proposal.execution_status !== 'PendingExecution') {
    return {
      kind: 'settled',
      next: record.pending_relayer_bond > 0n ? 'reclaim' : 'clear',
      proposal,
      bondLovelace: record.pending_relayer_bond,
      relayerKeyHash: record.pending_relayer_key_hash,
    };
  }
  const executableFromMs = proposal.anchor_timestamp + CHALLENGE_WINDOW_MS + PAST_DEADLINE_MARGIN_MS;
  const executableUntilMs = proposal.anchor_timestamp + EXECUTION_WINDOW_MS;
  const expirableFromMs = executableUntilMs + PAST_DEADLINE_MARGIN_MS;
  if (nowMs >= expirableFromMs) return { kind: 'expirable', next: 'expire', proposal };
  if (proposal.outcome === 'Passed') {
    if (nowMs < executableFromMs) return { kind: 'challenge', next: null, proposal, executableFromMs };
    if (nowMs <= executableUntilMs) return { kind: 'executable', next: 'execute', proposal, executableUntilMs };
  }
  return { kind: 'awaiting-expiry', next: null, proposal, expirableFromMs };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function continuing(record: GovernanceRecord, datum: CtoGovernanceDatumData, lovelaceDelta = 0n): TakeoverOutput {
  const assets: PlanAssets = { ...record.assets, lovelace: (record.assets.lovelace ?? 0n) + lovelaceDelta };
  return {
    address: record.address,
    assets,
    datumCbor: Data.to<CtoGovernanceDatumData>(datum, CtoGovernanceDatumSchema),
  };
}

function governanceSpend(record: GovernanceRecord, redeemerCbor: string): TakeoverTxPlan['spends'][number] {
  return { role: 'governance', utxo: record, redeemer: { cbor: redeemerCbor } };
}

function aroundNow(nowMs: bigint): TakeoverTxPlan['validity'] {
  return {
    fromMs: Number(nowMs - STEP_VALIDITY_HALF_WIDTH_MS),
    toMs: Number(nowMs + STEP_VALIDITY_HALF_WIDTH_MS),
  };
}

const ada = (lovelace: bigint) => `${Number(lovelace) / 1_000_000} ADA`;
const day = (ms: bigint) => new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 16);

function lucidCredential(target: AnchoredBallot['targetDexCredential']): ProposalAnchorData['target_dex_credential'] {
  if (target === null) return null;
  return target.kind === 'Script' ? { ScriptCredential: [target.hashHex] } : { PubKeyCredential: [target.hashHex] };
}

/**
 * Every rule `AnchorVoteResult` holds a result to, checked before anything is
 * signed so the reason is the recorder's to read rather than a failed script.
 */
function refuseUnrecordable(state: VoteRecordState, ballot: AnchoredBallot, nowMs: bigint): void {
  const g = state.record.datum;
  if (g.active_proposal) {
    throw new Error(
      "A result is already on this launch's record. It has to settle, and be cleared, before another is recorded.",
    );
  }
  if (ballot.voterCount < g.min_voter_count) {
    throw new Error(`The ballot drew ${ballot.voterCount} voters; a result needs at least ${g.min_voter_count}.`);
  }
  if (ballot.outcome === 'Passed') {
    const total = ballot.yesVotes + ballot.noVotes;
    if (total * 10_000n < g.total_supply * g.quorum_bps || ballot.yesVotes <= ballot.noVotes) {
      throw new Error('The ballot did not reach quorum with more yes than no, so it cannot be recorded as passed.');
    }
  } else if (ballot.proposalType === 'SilenceLockTrigger' || ballot.proposalType === 'DissolveCTOProposal') {
    throw new Error('A takeover or dissolve vote that failed changes nothing, so there is no result to record.');
  }
  if (ballot.endTimestamp - ballot.startTimestamp !== g.ballot_duration) {
    throw new Error(
      `The ballot ran ${ballot.endTimestamp - ballot.startTimestamp} ms; this launch's ballots run ${g.ballot_duration} ms.`,
    );
  }
  if (ballot.endTimestamp > nowMs) throw new Error(`The ballot is still open until ${day(ballot.endTimestamp)} UTC.`);
  const lockedAt = state.lpEscrow?.datum.lock_timestamp ?? 0n;
  if (lockedAt === 0n) throw new Error('This launch has not graduated, so it has no ballot to record.');
  if (ballot.startTimestamp < lockedAt + POST_GRADUATION_DELAY_MS) {
    throw new Error('The ballot opened less than 90 days after the launch graduated.');
  }
  if (g.last_ballot_end_timestamp !== 0n && ballot.startTimestamp < g.last_ballot_end_timestamp + BALLOT_COOLDOWN_MS) {
    throw new Error(
      `The ballot opened inside the cooldown after this launch's last one, which ended ${day(g.last_ballot_end_timestamp)} UTC.`,
    );
  }
  if ((ballot.creatorYesVotes + ballot.creatorNoVotes) * 10_000n > g.total_supply * g.creator_vote_cap_bps) {
    throw new Error("The creator's counted votes exceed the cap a result may carry.");
  }
  const takenOver = g.cto_state === 'CTOTriggered';
  switch (ballot.proposalType) {
    case 'SilenceLockTrigger':
      if (ballot.allocationRecipientHashHex === '') throw new Error('The takeover names no community wallet.');
      break;
    case 'FundAllocation':
      if (ballot.allocationAmount <= 0n || ballot.allocationRecipientHashHex === '') {
        throw new Error('A fund allocation needs an amount and a recipient.');
      }
      break;
    case 'VestingToLp':
    case 'VestingToStaking':
    case 'VestingToTreasury':
      if (!takenOver) throw new Error("A creator's allocation is decided only while a takeover holds it frozen.");
      if (ballot.proposalType === 'VestingToLp' && ballot.allocationAmount <= 0n) {
        throw new Error('Pairing the allocation into the pool needs an amount of ADA.');
      }
      break;
  }
}

export interface RecordResultOptions {
  nowMs: bigint;
  /** The key the bond returns to: the recording wallet's payment key hash. */
  relayerKeyHash: string;
  /** Defaults to the validator's floor. */
  bondLovelace?: bigint;
}

/**
 * Step 1: records a settled ballot's result, posting the bond into the record.
 * The bond comes back with step 5 once the result settles, unless the governor
 * voids the result as false within 24 hours.
 */
export function planRecordResult(
  state: VoteRecordState,
  proposalIdHex: string,
  ballot: AnchoredBallot,
  opts: RecordResultOptions,
): TakeoverTxPlan {
  const bond = opts.bondLovelace ?? MIN_RELAYER_BOND_LOVELACE;
  if (bond < MIN_RELAYER_BOND_LOVELACE) throw new Error(`The bond is at least ${ada(MIN_RELAYER_BOND_LOVELACE)}.`);
  if (!/^[0-9a-f]{56}$/i.test(opts.relayerKeyHash)) {
    throw new Error('The bond has to return to a payment key hash, 28 bytes of hex.');
  }
  refuseUnrecordable(state, ballot, opts.nowMs);

  const g = state.record.datum;
  const anchorTimestamp = opts.nowMs;
  const proposal: ProposalAnchorData = {
    proposal_type: ballot.proposalType,
    description_hash: ballot.descriptionHashHex,
    proof_bundle_hash: deriveAnchorReferenceHex({
      launchIdHex: g.launch_id,
      proposalCount: g.proposal_count,
      proposalIdHex,
      ballot,
    }),
    yes_votes: ballot.yesVotes,
    no_votes: ballot.noVotes,
    voter_count: ballot.voterCount,
    creator_yes_votes: ballot.creatorYesVotes,
    creator_no_votes: ballot.creatorNoVotes,
    outcome: ballot.outcome,
    start_timestamp: ballot.startTimestamp,
    end_timestamp: ballot.endTimestamp,
    anchor_timestamp: anchorTimestamp,
    execution_status: 'PendingExecution',
    target_dex_credential: lucidCredential(ballot.targetDexCredential),
    allocation_amount: ballot.allocationAmount,
    allocation_recipient_hash: ballot.allocationRecipientHashHex,
    relayer_credential_hash: opts.relayerKeyHash,
  };
  // Recording moves the slot, the ordinal and the bond. The cooldown starts
  // when the result settles, so last_ballot_end_timestamp is carried as it is.
  const recorded: CtoGovernanceDatumData = {
    ...g,
    active_proposal: proposal,
    proposal_count: g.proposal_count + 1n,
    pending_relayer_bond: bond,
    pending_relayer_key_hash: opts.relayerKeyHash,
  };
  const redeemer: AnchorVoteResultRedeemerData = {
    proposal_type: proposal.proposal_type,
    description_hash: proposal.description_hash,
    proposal_id: proposalIdHex,
    yes_votes: proposal.yes_votes,
    no_votes: proposal.no_votes,
    voter_count: proposal.voter_count,
    creator_yes_votes: proposal.creator_yes_votes,
    creator_no_votes: proposal.creator_no_votes,
    outcome: proposal.outcome,
    start_timestamp: proposal.start_timestamp,
    end_timestamp: proposal.end_timestamp,
    anchor_timestamp: anchorTimestamp,
    target_dex_credential: proposal.target_dex_credential,
    allocation_amount: proposal.allocation_amount,
    allocation_recipient_hash: proposal.allocation_recipient_hash,
    relayer_credential_hash: opts.relayerKeyHash,
    relayer_bond: bond,
  };
  if (!state.lpEscrow) throw new Error('This launch has not graduated, so it has no ballot to record.');
  return {
    action: 'record',
    spends: [
      governanceSpend(state.record, Data.to<AnchorVoteResultRedeemerData>(redeemer, AnchorVoteResultRedeemerSchema)),
    ],
    // Read for when the launch graduated, which the ballot has to follow by 90 days.
    referenceInputs: [state.lpEscrow],
    outputs: [continuing(state.record, recorded, bond)],
    requiredSignerHashes: [],
    validity: aroundNow(anchorTimestamp),
    fundingLovelace: bond,
  };
}

function requireStage<K extends VoteStage['kind']>(
  record: GovernanceRecord,
  nowMs: bigint,
  kind: K,
  refusal: (stage: VoteStage) => string,
): Extract<VoteStage, { kind: K }> {
  const stage = voteStage(record.datum, nowMs);
  if (stage.kind !== kind) throw new Error(refusal(stage));
  return stage as Extract<VoteStage, { kind: K }>;
}

function notYet(stage: VoteStage): string {
  switch (stage.kind) {
    case 'open':
      return "No result is on this launch's record.";
    case 'challenge':
      return `The result can be executed from ${day(stage.executableFromMs)} UTC, once its 24-hour challenge window has passed.`;
    case 'awaiting-expiry':
      return `The result can be marked expired from ${day(stage.expirableFromMs)} UTC.`;
    case 'executable':
      return 'The result is passed and can be executed now.';
    case 'expirable':
      return 'The result went unexecuted for 30 days and can be marked expired now.';
    case 'settled':
      return stage.next === 'reclaim'
        ? 'The result has settled; its bond can be reclaimed.'
        : 'The result has settled.';
  }
}

/** Step 3: executes a passed result once its challenge window has passed. */
export function planExecuteResult(record: GovernanceRecord, nowMs: bigint): TakeoverTxPlan {
  const { proposal } = requireStage(record, nowMs, 'executable', notYet);
  const g = record.datum;
  const executed: ProposalAnchorData = { ...proposal, execution_status: 'Executed' };
  const takeover = proposal.proposal_type === 'SilenceLockTrigger';
  const dissolve = proposal.proposal_type === 'DissolveCTOProposal';
  const datum: CtoGovernanceDatumData = {
    ...g,
    cto_state: takeover ? 'CTOTriggered' : dissolve ? 'CTODissolved' : g.cto_state,
    community_wallet_hash: takeover ? proposal.allocation_recipient_hash : dissolve ? '' : g.community_wallet_hash,
    active_proposal: executed,
    last_executed_proposal: executed,
    // The ballot ran its course: the cooldown before the next starts here.
    last_ballot_end_timestamp: proposal.end_timestamp,
  };
  return {
    action: 'execute',
    spends: [governanceSpend(record, Data.to(new Constr(CTO_GOVERNANCE_REDEEMER.ExecuteProposal, [nowMs])))],
    referenceInputs: [],
    outputs: [continuing(record, datum)],
    requiredSignerHashes: [],
    validity: aroundNow(nowMs),
    fundingLovelace: 0n,
  };
}

/** Step 3, the other way: marks a result expired once its 30-day window has passed unexecuted. */
export function planExpireResult(record: GovernanceRecord, nowMs: bigint): TakeoverTxPlan {
  const { proposal } = requireStage(record, nowMs, 'expirable', notYet);
  const datum: CtoGovernanceDatumData = {
    ...record.datum,
    active_proposal: { ...proposal, execution_status: 'Expired' },
    last_ballot_end_timestamp: proposal.end_timestamp,
  };
  return {
    action: 'expire',
    spends: [governanceSpend(record, Data.to(new Constr(CTO_GOVERNANCE_REDEEMER.ExpireProposal, [nowMs])))],
    referenceInputs: [],
    outputs: [continuing(record, datum)],
    requiredSignerHashes: [],
    validity: aroundNow(nowMs),
    fundingLovelace: 0n,
  };
}

const LUCID_NETWORK = { preview: 'Preview', preprod: 'Preprod', mainnet: 'Mainnet' } as const;

/**
 * Where a reclaimed bond is paid: `preferred` when its payment key is the one
 * that posted the bond (a wallet's own address keeps its stake key), otherwise
 * the plain address of that key.
 */
export function bondPayoutAddress(network: CurveNetwork, relayerKeyHash: string, preferred?: string): string {
  if (preferred) {
    try {
      if (getAddressDetails(preferred).paymentCredential?.hash === relayerKeyHash) return preferred;
    } catch {
      // Not an address this network reads: fall through to the key's own.
    }
  }
  return credentialToAddress(LUCID_NETWORK[network], { type: 'Key', hash: relayerKeyHash });
}

/**
 * Step 5: pays a settled result's bond back to the key that posted it. Anyone
 * may submit it; the payee is the record's, and the payout names the record it
 * settles so it cannot be counted for anything else.
 */
export function planReclaimBond(record: GovernanceRecord, payoutAddress: string): TakeoverTxPlan {
  const stage = voteStage(record.datum, 0n);
  if (stage.kind !== 'settled' || stage.next !== 'reclaim') {
    throw new Error(stage.kind === 'settled' ? "This result's bond has already been paid out." : notYet(stage));
  }
  if (getAddressDetails(payoutAddress).paymentCredential?.hash !== stage.relayerKeyHash) {
    throw new Error('The bond is paid only to the key that posted it.');
  }
  const datum: CtoGovernanceDatumData = { ...record.datum, pending_relayer_bond: 0n, pending_relayer_key_hash: '' };
  return {
    action: 'reclaim',
    spends: [governanceSpend(record, Data.to(new Constr(CTO_GOVERNANCE_REDEEMER.ReclaimRelayerBond, [])))],
    referenceInputs: [],
    outputs: [
      continuing(record, datum, -stage.bondLovelace),
      { address: payoutAddress, assets: { lovelace: stage.bondLovelace }, datumCbor: settlementDatum(record) },
    ],
    requiredSignerHashes: [],
    fundingLovelace: 0n,
  };
}

/** Step 6: clears a settled result whose bond is paid out, freeing the slot for the next. */
export function planClearResult(record: GovernanceRecord): TakeoverTxPlan {
  const stage = voteStage(record.datum, 0n);
  if (stage.kind !== 'settled') throw new Error(notYet(stage));
  if (stage.next !== 'clear') throw new Error('The bond has to be reclaimed before the result is cleared.');
  return {
    action: 'clear',
    spends: [governanceSpend(record, Data.to(new Constr(CTO_GOVERNANCE_REDEEMER.ClearProposal, [])))],
    referenceInputs: [],
    outputs: [continuing(record, { ...record.datum, active_proposal: null })],
    requiredSignerHashes: [],
    fundingLovelace: 0n,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface VoteRecordAddresses {
  governance: string;
  lpEscrow: string;
}

/**
 * The launch's governance record and LP escrow, each found by its thread NFT
 * under the platform's policy, so neither can be a look-alike paid to the
 * same address.
 */
export async function readVoteRecordState(
  get: (path: string) => Promise<unknown>,
  launch: { launchIdHex: string; threadNftPolicyId: string; addresses: VoteRecordAddresses },
): Promise<VoteRecordState> {
  const { launchIdHex, threadNftPolicyId: policy, addresses } = launch;
  const record = await readByUnit(
    get,
    addresses.governance,
    threadUnit(policy, 'ctoGovernance', launchIdHex),
    CtoGovernanceDatumSchema,
    'governance record',
  );
  if (!record || record.datum.launch_id !== launchIdHex) {
    throw new Error("This launch's governance record could not be found.");
  }
  const lpEscrow = await readByUnit(
    get,
    addresses.lpEscrow,
    threadUnit(policy, 'lpEscrow', launchIdHex),
    LpEscrowDatumSchema,
    'LP escrow',
  );
  return lpEscrow ? { record, lpEscrow } : { record };
}
