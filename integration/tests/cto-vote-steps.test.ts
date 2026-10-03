// cto-vote-steps.test.ts
//
// A finished takeover vote carried through on Cardano: recorded, executed or
// expired, its bond reclaimed, the record cleared. The governance record and
// LP escrow are the genesis builder's own for a Cardano Launch, the ballot is a
// Midnight one at real-world scale (POSIX seconds) converted by the relayer,
// and every transaction runs through the compiled governance validator (see
// ./support/takeover-chain.ts). Each rejection is a passing transaction with
// one value changed.

import { credentialToAddress, Data } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { ProposalState, ProposalType } from '../../contracts/midnight/compiled/cto_governance/contract/index.js';
import {
  type CtoGovernanceDatumData,
  CtoGovernanceDatumSchema,
  type ProposalAnchorData,
} from '../cardano-cto-anchor-submitter.js';
import type { DatumUtxo, TakeoverTxPlan } from '../cto-takeover-tx.js';
import { anchoredBallotOf, type MidnightProposalLike } from '../cto-vote-relayer.js';
import {
  CHALLENGE_WINDOW_MS,
  EXECUTION_WINDOW_MS,
  type GovernanceRecord,
  planClearResult,
  planExecuteResult,
  planExpireResult,
  planReclaimBond,
  planRecordResult,
  type VoteRecordState,
  voteStage,
} from '../cto-vote-steps.js';
import { cardanoKeyHashToBallotField, cardanoScriptHashToBallotField } from '../cto-wallet-field.js';
import { buildGenesisDatums } from '../genesis-datums.js';
import { type LpEscrowDatumData, LpEscrowDatumSchema, threadNftAssetName } from '../launch-schemas.js';
import {
  at,
  BLUEPRINT,
  buildEvaluated,
  datumCborAt,
  launchScript,
  lovelaceIn,
  onChain,
  PAYER,
  PAYER_ADDRESS,
} from './support/takeover-chain.js';

const GOVERNANCE = launchScript('cto_governance.cto_governance.spend');
const LP_ESCROW = launchScript('lp_escrow.lp_escrow.spend');
const SCRIPTS = { governance: { compiledScriptCbor: GOVERNANCE } };
const THREAD_POLICY = 'a1'.repeat(28);
const COMMUNITY = 'c2'.repeat(28);
const PROPOSAL_ID = '9e'.repeat(32);
const BOND = 25_000_000n;

const genesis = await buildGenesisDatums({
  blueprint: BLUEPRINT as never,
  network: 'preprod',
  tier: 'B',
  creatorPubKeyHashHex: '11'.repeat(28),
  governorPubKeyHashHex: '22'.repeat(28),
  bondPayoutPubKeyHashHex: '44'.repeat(28),
  tokenPolicyIdHex: 'bb'.repeat(28),
  tokenBaseNameHex: Buffer.from('RESCUE').toString('hex'),
  tokenName: 'Rescue',
  tokenDescription: 'A launch its community voted to take over.',
  threadNftPolicyIdHex: THREAD_POLICY,
  poolNftPolicyIdHex: '1e'.repeat(28),
  basePrice: 3,
  maxPrice: 75,
  creatorAllocPct: 5,
  vestDays: 180,
  genesisTimestampMs: 1_785_000_000_000,
});
const LAUNCH = genesis.launchIdHex;
const thread = (role: Parameters<typeof threadNftAssetName>[0]) => THREAD_POLICY + threadNftAssetName(role, LAUNCH);
const BASE = Data.from(genesis.datums.ctoGovernance, CtoGovernanceDatumSchema);

// -- clocks: Cardano milliseconds, the ballot's own seconds ------------------

const GRADUATED_MS = 1_780_000_000_000n;
const START_S = (GRADUATED_MS + 7_776_000_000n) / 1000n + 3_600n;
const END_S = START_S + 259_200n;
const RECORDED_MS = END_S * 1000n + 3_600_000n;

// -- records -----------------------------------------------------------------

let seq = 0x60;
function utxo<D>(address: string, lovelace: bigint, unit: string, datum: D): DatumUtxo<D> {
  seq += 1;
  return {
    txHash: seq.toString(16).padStart(2, '0').repeat(32),
    outputIndex: 0,
    address,
    assets: { lovelace, [unit]: 1n },
    datum,
  };
}

function record(overrides: Partial<CtoGovernanceDatumData> = {}, lovelace = 5_000_000n): GovernanceRecord {
  return utxo(at(GOVERNANCE), lovelace, thread('ctoGovernance'), { ...BASE, ...overrides });
}

const escrow = Data.from(genesis.datums.lpEscrow, LpEscrowDatumSchema);
const LP_SEALED = utxo(at(LP_ESCROW), 2_000_000n, thread('lpEscrow'), {
  ...escrow,
  lock_timestamp: GRADUATED_MS,
} as LpEscrowDatumData);

const known = (r: GovernanceRecord) => [
  onChain(r, Data.to<CtoGovernanceDatumData>(r.datum, CtoGovernanceDatumSchema)),
  onChain(LP_SEALED, Data.to<LpEscrowDatumData>(LP_SEALED.datum, LpEscrowDatumSchema)),
];

/** A takeover ballot as Midnight holds it once finalized. */
function ballotOnMidnight(overrides: Partial<MidnightProposalLike> = {}): MidnightProposalLike {
  return {
    proposalType: ProposalType.SilenceLockTrigger,
    state: ProposalState.Passed,
    descriptionHash: new Uint8Array(32).fill(0x20),
    yesVotes: BASE.total_supply / 10n,
    noVotes: BASE.total_supply / 100n,
    voterCount: 20n,
    creatorYesVotes: 0n,
    creatorNoVotes: 0n,
    startTimestamp: START_S,
    endTimestamp: END_S,
    allocationAmount: 0n,
    allocationRecipient: new Uint8Array(32),
    proposedCommunityWallet: cardanoKeyHashToBallotField(COMMUNITY),
    targetDexAddr: new Uint8Array(32),
    ...overrides,
  };
}

function recordPlan(r = record(), overrides: Partial<MidnightProposalLike> = {}): TakeoverTxPlan {
  const state: VoteRecordState = { record: r, lpEscrow: LP_SEALED };
  return planRecordResult(state, PROPOSAL_ID, anchoredBallotOf(ballotOnMidnight(overrides), PROPOSAL_ID), {
    nowMs: RECORDED_MS,
    relayerKeyHash: PAYER,
    bondLovelace: BOND,
  });
}

/** The record as step 1 leaves it, for the steps after. */
function recorded(changes: Partial<ProposalAnchorData> = {}, bond = BOND): GovernanceRecord {
  const txDatum = Data.from(
    recordPlan().outputs[0]?.datumCbor ?? '',
    CtoGovernanceDatumSchema,
  ) as CtoGovernanceDatumData;
  const proposal = { ...(txDatum.active_proposal as ProposalAnchorData), ...changes };
  return record({ ...txDatum, active_proposal: proposal, pending_relayer_bond: bond }, 5_000_000n + bond);
}

function withOutput(plan: TakeoverTxPlan, index: number, change: Partial<TakeoverTxPlan['outputs'][number]>) {
  return { ...plan, outputs: plan.outputs.map((o, i) => (i === index ? { ...o, ...change } : o)) };
}

const decoded = (txHex: string) => Data.from(datumCborAt(txHex, 0), CtoGovernanceDatumSchema) as CtoGovernanceDatumData;

// -- 1. record ---------------------------------------------------------------

describe('recording a finished ballot', () => {
  it('records a real-scale Midnight ballot, with the bond, against the compiled validator', async () => {
    const r = record();
    const plan = recordPlan(r);
    const tx = await buildEvaluated(plan, known(r), SCRIPTS);
    const after = decoded(tx);
    expect(after.active_proposal?.start_timestamp).toBe(START_S * 1000n);
    expect(after.active_proposal?.allocation_recipient_hash).toBe(COMMUNITY);
    expect(after.active_proposal?.anchor_timestamp).toBe(RECORDED_MS);
    expect(after.pending_relayer_bond).toBe(BOND);
    expect(after.pending_relayer_key_hash).toBe(PAYER);
    expect(after.proposal_count).toBe(BASE.proposal_count + 1n);
    expect(after.last_ballot_end_timestamp).toBe(0n);
    expect(lovelaceIn(tx, 0)).toBe(5_000_000n + BOND);
  });

  it('records a DEX vote with its target as a 28-byte script credential, against the compiled validator', async () => {
    const dex = '5d'.repeat(28);
    const r = record({ cto_state: 'CTOTriggered', community_wallet_hash: COMMUNITY });
    const plan = recordPlan(r, {
      proposalType: ProposalType.DexMigration,
      proposedCommunityWallet: new Uint8Array(32),
      targetDexAddr: cardanoScriptHashToBallotField(dex),
    });
    const after = decoded(await buildEvaluated(plan, known(r), SCRIPTS));
    expect(after.active_proposal?.proposal_type).toBe('DexMigration');
    expect(after.active_proposal?.target_dex_credential).toEqual({ ScriptCredential: [dex] });
  });

  it('is refused when the record also starts the cooldown', async () => {
    const r = record();
    const plan = recordPlan(r);
    const tampered = Data.to<CtoGovernanceDatumData>(
      { ...decodedPlan(plan), last_ballot_end_timestamp: END_S * 1000n },
      CtoGovernanceDatumSchema,
    );
    await expect(buildEvaluated(withOutput(plan, 0, { datumCbor: tampered }), known(r), SCRIPTS)).rejects.toThrow(
      /evaluation failed/i,
    );
  });

  it('is refused when the bond is one lovelace short', async () => {
    const r = record();
    const plan = recordPlan(r);
    const short = { ...plan.outputs[0]?.assets, lovelace: 5_000_000n + BOND - 1n };
    await expect(buildEvaluated(withOutput(plan, 0, { assets: short }), known(r), SCRIPTS)).rejects.toThrow(
      /evaluation failed/i,
    );
  });

  it('refuses in words what the validator would refuse', () => {
    expect(() => recordPlan(recorded())).toThrow(/already on this launch's record/);
    expect(() => recordPlan(record(), { state: ProposalState.Failed })).toThrow(/failed changes nothing/);
    expect(() => recordPlan(record(), { voterCount: 14n })).toThrow(/at least 15/);
    expect(() => recordPlan(record(), { endTimestamp: END_S - 1n })).toThrow(/ballots run 259200000 ms/);
    expect(() => recordPlan(record({ last_ballot_end_timestamp: START_S * 1000n - 1n }))).toThrow(
      /inside the cooldown/,
    );
    expect(() => recordPlan(record(), { startTimestamp: START_S - 7_200n, endTimestamp: END_S - 7_200n })).toThrow(
      /less than 90 days after the launch graduated/,
    );
  });
});

function decodedPlan(plan: TakeoverTxPlan): CtoGovernanceDatumData {
  return Data.from(plan.outputs[0]?.datumCbor ?? '', CtoGovernanceDatumSchema) as CtoGovernanceDatumData;
}

// -- 3. execute or expire ----------------------------------------------------

describe('settling a recorded result', () => {
  const EXECUTABLE_MS = RECORDED_MS + CHALLENGE_WINDOW_MS + 300_000n;

  it('waits out the challenge window, then executes and starts the cooldown', async () => {
    const r = recorded();
    expect(voteStage(r.datum, RECORDED_MS + CHALLENGE_WINDOW_MS).kind).toBe('challenge');
    expect(() => planExecuteResult(r, RECORDED_MS + 3_600_000n)).toThrow(/24-hour challenge window/);
    const tx = await buildEvaluated(planExecuteResult(r, EXECUTABLE_MS), known(r), SCRIPTS);
    const after = decoded(tx);
    expect(after.cto_state).toBe('CTOTriggered');
    expect(after.community_wallet_hash).toBe(COMMUNITY);
    expect(after.active_proposal?.execution_status).toBe('Executed');
    expect(after.last_executed_proposal?.execution_status).toBe('Executed');
    expect(after.last_ballot_end_timestamp).toBe(END_S * 1000n);
  });

  it('is refused when the execution leaves the cooldown unrecorded', async () => {
    const r = recorded();
    const plan = planExecuteResult(r, EXECUTABLE_MS);
    const tampered = Data.to<CtoGovernanceDatumData>(
      { ...decodedPlan(plan), last_ballot_end_timestamp: 0n },
      CtoGovernanceDatumSchema,
    );
    await expect(buildEvaluated(withOutput(plan, 0, { datumCbor: tampered }), known(r), SCRIPTS)).rejects.toThrow(
      /evaluation failed/i,
    );
  });

  it('marks a result expired once it has gone unexecuted for 30 days', async () => {
    const r = recorded();
    const late = RECORDED_MS + EXECUTION_WINDOW_MS + 300_000n;
    expect(voteStage(r.datum, late).kind).toBe('expirable');
    const tx = await buildEvaluated(planExpireResult(r, late), known(r), SCRIPTS);
    expect(decoded(tx).active_proposal?.execution_status).toBe('Expired');
    expect(decoded(tx).last_ballot_end_timestamp).toBe(END_S * 1000n);
  });

  it('holds a failed result until its window closes, then expires it', async () => {
    const r = recorded({ proposal_type: 'FundAllocation', outcome: 'Failed' });
    expect(voteStage(r.datum, EXECUTABLE_MS).kind).toBe('awaiting-expiry');
    expect(() => planExecuteResult(r, EXECUTABLE_MS)).toThrow(/marked expired from/);
    const late = RECORDED_MS + EXECUTION_WINDOW_MS + 300_000n;
    await buildEvaluated(planExpireResult(r, late), known(r), SCRIPTS);
  });
});

// -- 5, 6. reclaim and clear -------------------------------------------------

describe('closing out a settled result', () => {
  const settled = (bond = BOND) => recorded({ execution_status: 'Executed' }, bond);

  it('pays the bond back to the key that posted it, tagged with the record it settles', async () => {
    const r = settled();
    expect(voteStage(r.datum, 0n)).toMatchObject({ kind: 'settled', next: 'reclaim' });
    const tx = await buildEvaluated(planReclaimBond(r, PAYER_ADDRESS), known(r), SCRIPTS);
    expect(lovelaceIn(tx, 1)).toBe(BOND);
    expect(lovelaceIn(tx, 0)).toBe(5_000_000n);
    expect(decoded(tx).pending_relayer_bond).toBe(0n);
  });

  it('is refused when the bond is paid to another key', async () => {
    const r = settled();
    const elsewhere = credentialToAddress('Preprod', { type: 'Key', hash: '77'.repeat(28) });
    expect(() => planReclaimBond(r, elsewhere)).toThrow(/only to the key that posted it/);
    const plan = withOutput(planReclaimBond(r, PAYER_ADDRESS), 1, { address: elsewhere });
    await expect(buildEvaluated(plan, known(r), SCRIPTS)).rejects.toThrow(/evaluation failed/i);
  });

  it('clears a settled result with no signature once its bond is paid out', async () => {
    const r = settled(0n);
    expect(voteStage(r.datum, 0n)).toMatchObject({ kind: 'settled', next: 'clear' });
    const plan = planClearResult(r);
    expect(plan.requiredSignerHashes).toEqual([]);
    const tx = await buildEvaluated(plan, known(r), SCRIPTS);
    expect(decoded(tx).active_proposal).toBeNull();
  });

  it('is refused when the bond is still in the record', async () => {
    const withBond = settled();
    expect(() => planClearResult(withBond)).toThrow(/reclaimed before the result is cleared/);
    const plan = planClearResult(settled(0n));
    const r = { ...withBond, datum: { ...withBond.datum } };
    const forced = {
      ...plan,
      spends: plan.spends.map((s) => ({ ...s, utxo: r })),
      outputs: [
        {
          address: r.address,
          assets: r.assets,
          datumCbor: Data.to<CtoGovernanceDatumData>({ ...r.datum, active_proposal: null }, CtoGovernanceDatumSchema),
        },
      ],
    };
    await expect(buildEvaluated(forced, known(r), SCRIPTS)).rejects.toThrow(/evaluation failed/i);
  });
});
