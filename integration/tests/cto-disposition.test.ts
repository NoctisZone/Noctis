// cto-disposition.test.ts
//
// A takeover's freeze and disposition on the creator's vesting allocation.
// Every transaction built here is run through the compiled validators by
// Mesh's offline evaluator (Scalus): vesting.ak, lp_escrow.ak, staking_pool.ak
// and the venue pool, exactly as the blueprint and the applied record hold
// them. A test passes only if every script in the transaction accepts it.

import { Data } from '@lucid-evolution/lucid';
import { resolveNativeScriptHash } from '@meshsdk/core';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  type CtoGovernanceDatumData,
  CtoGovernanceDatumSchema,
  type ProposalAnchorData,
} from '../cardano-cto-anchor-submitter.js';
import {
  planDisposition,
  planVestingFreeze,
  type VestingTakeoverPlan,
  type VestingTakeoverState,
} from '../cto-disposition.js';
import type { DatumUtxo } from '../cto-takeover-tx.js';
import type { PlanAssets } from '../mesh-curve-spend.js';
import { MAX_TX_BYTES, scriptHashOf } from '../reference-script.js';
import { STAKE_EMPTY_ROOT } from '../stake-accumulator-tree.js';
import {
  type LpEscrowDatumData,
  LpEscrowDatumSchema,
  type StakingPoolDatumData,
  StakingPoolDatumSchema,
  threadNftAssetName,
  type VestingDatumData,
  VestingDatumSchema,
  venueAssetName,
} from '../tier-a-schemas.js';
import { VENUE_MAX_LQ_CAP, type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import {
  at,
  buildEvaluated,
  datumCborAt,
  launchScript,
  onChain,
  quantityIn,
  referenced,
  referenceOutput,
  venueScript,
} from './support/takeover-chain.js';

const VESTING = launchScript('vesting.vesting.spend');
const GOVERNANCE = launchScript('cto_governance.cto_governance.spend');
const LP_ESCROW = launchScript('lp_escrow.lp_escrow.spend');
const STAKING = launchScript('staking_pool.staking_pool.spend');
const POOL = venueScript('royalty_pool/pool.pool.spend');

const GOVERNANCE_HASH = scriptHashOf(GOVERNANCE);

const GOVERNOR = '22'.repeat(28);
const COMMUNITY = '77'.repeat(28);
const CREATOR = '11'.repeat(28);
const THREAD_POLICY = resolveNativeScriptHash({ type: 'sig', keyHash: GOVERNOR });
const FACTORY = '1e'.repeat(28);
const LAUNCH = `ab${'cd'.repeat(31)}`;
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN_NAME = '746f6b';
const TOKEN = TOKEN_POLICY + TOKEN_NAME;
const LQ = FACTORY + venueAssetName('lq', LAUNCH);
const POOL_NFT = FACTORY + venueAssetName('pool', LAUNCH);
const thread = (role: Parameters<typeof threadNftAssetName>[0]) => THREAD_POLICY + threadNftAssetName(role, LAUNCH);

const HELD = 50_000_000n;
const NOW = Date.UTC(2026, 9, 1, 12);

// -- fixtures ---------------------------------------------------------------

function vestingDatum(overrides: Partial<VestingDatumData> = {}): VestingDatumData {
  return {
    launch_id: LAUNCH,
    creator_pub_key_hash: CREATOR,
    governor_pub_key_hash: GOVERNOR,
    token_allocation: HELD,
    vest_days: 180n,
    vesting_state: 'CTOFrozen',
    claimed_tokens: 0n,
    vest_start_timestamp: BigInt(NOW - 200 * 86_400_000),
    cto_triggered: true,
    community_treasury_wallet: COMMUNITY,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_NAME,
    cto_governance_credential: { ScriptCredential: [GOVERNANCE_HASH] },
    thread_nft_policy: THREAD_POLICY,
    last_claimed_allocation_timestamp: 0n,
    ...overrides,
  } as VestingDatumData;
}

function proposal(overrides: Partial<ProposalAnchorData> = {}): ProposalAnchorData {
  return {
    proposal_type: 'VestingToTreasury',
    description_hash: '20'.repeat(32),
    proof_bundle_hash: '21'.repeat(32),
    yes_votes: 60_000_000n,
    no_votes: 10_000_000n,
    voter_count: 20n,
    creator_yes_votes: 0n,
    creator_no_votes: 0n,
    outcome: 'Passed',
    start_timestamp: 0n,
    end_timestamp: 1n,
    anchor_timestamp: 1n,
    execution_status: 'Executed',
    target_dex_credential: null,
    allocation_amount: 0n,
    allocation_recipient_hash: '',
    relayer_credential_hash: '23'.repeat(28),
    ...overrides,
  };
}

function governanceDatum(executed: ProposalAnchorData): CtoGovernanceDatumData {
  return {
    launch_id: LAUNCH,
    cto_state: 'CTOTriggered',
    community_wallet_hash: COMMUNITY,
    governor_credential_hash: GOVERNOR,
    total_supply: 1_000_000_000n,
    quorum_bps: 500n,
    creator_vote_cap_bps: 100n,
    min_voter_count: 15n,
    active_proposal: executed,
    proposal_count: 2n,
    last_executed_proposal: executed,
    pending_relayer_bond: 0n,
    pending_relayer_key_hash: '',
    payout_pub_key_hash: '44'.repeat(28),
    thread_nft_policy: THREAD_POLICY,
    ballot_duration: 259_200_000n,
    last_ballot_end_timestamp: 1n,
  };
}

let seq = 0;
function utxo<D>(address: string, assets: PlanAssets, datum: D): DatumUtxo<D> {
  seq += 1;
  return { txHash: seq.toString(16).padStart(2, '0').repeat(32), outputIndex: 0, address, assets, datum };
}

function stakingDatum(overrides: Partial<StakingPoolDatumData> = {}): StakingPoolDatumData {
  return {
    launch_id: LAUNCH,
    creator_pub_key_hash: CREATOR,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_NAME,
    thread_nft_policy: THREAD_POLICY,
    emission_per_day: 100_000n,
    stake_root: bytesToHex(STAKE_EMPTY_ROOT),
    acc_reward_per_token: 0n,
    total_staked: 0n,
    unallocated: 200_000_000n,
    last_update_ms: BigInt(NOW - 86_400_000),
    exhausted_at: null,
    governor_pub_key_hash: GOVERNOR,
    unstake_lock_ms: 604_800_000n,
    ...overrides,
  };
}

const RX = 30_000_000_000n;
const RY = 200_000_000n;
const LQ0 = 1_000_000_000n;
const TREASURY_X = 7_000_000n;
const ROYALTY_X = 11_000_000n;

function poolConfig(): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: venueAssetName('pool', LAUNCH) },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: TOKEN_POLICY, name: TOKEN_NAME },
    pool_lq: { policy: FACTORY, name: venueAssetName('lq', LAUNCH) },
    fee_num: 99_700n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: TREASURY_X,
    treasury_y: 0n,
    royalty_x: ROYALTY_X,
    royalty_y: 0n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(28),
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
  };
}

function escrowDatum(): LpEscrowDatumData {
  return {
    launch_id: LAUNCH,
    lock_timestamp: BigInt(NOW - 300 * 86_400_000),
    lock_duration: 31_536_000_000n,
    lp_state: 'Locked',
    governor_pub_key_hash: GOVERNOR,
    community_wallet_hash: COMMUNITY,
    cto_triggered: true,
    fee_recipient_pub_key_hash: COMMUNITY,
    dex_whitelist: [],
    multisig_signers: [GOVERNOR],
    multisig_threshold: 1n,
    pending_dex_change: null,
    lp_token_policy_id: FACTORY,
    lp_token_name: venueAssetName('lq', LAUNCH),
    lp_token_amount: LQ0,
    cto_governance_credential: { ScriptCredential: [GOVERNANCE_HASH] },
    thread_nft_policy: THREAD_POLICY,
    last_migration_timestamp: 0n,
  } as LpEscrowDatumData;
}

function stateFor(executed: ProposalAnchorData, vesting: Partial<VestingDatumData> = {}): VestingTakeoverState {
  return {
    vesting: utxo(at(VESTING), { lovelace: 2_000_000n, [thread('vesting')]: 1n, [TOKEN]: HELD }, vestingDatum(vesting)),
    governance: utxo(
      at(GOVERNANCE),
      { lovelace: 5_000_000n, [thread('ctoGovernance')]: 1n },
      governanceDatum(executed),
    ),
  };
}

function withStakingPool(state: VestingTakeoverState, overrides: Partial<StakingPoolDatumData> = {}) {
  const datum = stakingDatum(overrides);
  state.stakingPool = utxo(
    at(STAKING),
    { lovelace: 3_000_000n, [thread('stakingPool')]: 1n, [TOKEN]: datum.unallocated + datum.total_staked },
    datum,
  );
  return state;
}

function withLiquidity(state: VestingTakeoverState) {
  state.lpEscrow = utxo(at(LP_ESCROW), { lovelace: 2_000_000n, [thread('lpEscrow')]: 1n, [LQ]: LQ0 }, escrowDatum());
  state.venuePool = utxo(
    at(POOL),
    {
      lovelace: RX + TREASURY_X + ROYALTY_X,
      [TOKEN]: RY,
      [LQ]: VENUE_MAX_LQ_CAP - LQ0,
      [POOL_NFT]: 1n,
    },
    poolConfig(),
  );
  return state;
}

// -- the chain the evaluator reads -------------------------------------------

/** Published reference scripts, as the sites hold them for the escrow, the staking pool and the venue pool. */
const REFS = {
  lpEscrow: referenceOutput(LP_ESCROW, 0xe1),
  stakingPool: referenceOutput(STAKING, 0xe2),
  venuePool: referenceOutput(POOL, 0xe3),
};

// Vesting has no published reference, so it is carried.
const SCRIPTS = {
  vesting: { compiledScriptCbor: VESTING },
  lpEscrow: referenced(LP_ESCROW, REFS.lpEscrow),
  stakingPool: referenced(STAKING, REFS.stakingPool),
  venuePool: referenced(POOL, REFS.venuePool),
};

/** Everything on "chain" for this state. */
function chain(state: VestingTakeoverState) {
  const known = [...Object.values(REFS)];
  known.push(onChain(state.vesting, Data.to(state.vesting.datum, VestingDatumSchema)));
  known.push(onChain(state.governance, Data.to(state.governance.datum, CtoGovernanceDatumSchema)));
  if (state.stakingPool)
    known.push(onChain(state.stakingPool, Data.to(state.stakingPool.datum, StakingPoolDatumSchema)));
  if (state.lpEscrow) known.push(onChain(state.lpEscrow, Data.to(state.lpEscrow.datum, LpEscrowDatumSchema)));
  if (state.venuePool) known.push(onChain(state.venuePool, Data.to(state.venuePool.datum, VenuePoolConfigSchema)));
  return known;
}

const build = (plan: VestingTakeoverPlan, state: VestingTakeoverState) => buildEvaluated(plan, chain(state), SCRIPTS);
const tokensIn = (txHex: string, index: number) => quantityIn(txHex, index, TOKEN);

// -- tests -------------------------------------------------------------------

describe('freezing the allocation a takeover holds', () => {
  const takeover = proposal({ proposal_type: 'SilenceLockTrigger', allocation_recipient_hash: COMMUNITY });
  const running = { vesting_state: 'Vesting', cto_triggered: false, community_treasury_wallet: '' } as const;

  it('is accepted by vesting and moves nothing', async () => {
    const state = stateFor(takeover, running);
    const plan = planVestingFreeze(state, { governanceScriptHash: GOVERNANCE_HASH });
    const tx = await build(plan, state);
    expect(tokensIn(tx, 0)).toBe(HELD);
    const datum = Data.from(datumCborAt(tx, 0), VestingDatumSchema);
    expect(datum).toMatchObject({
      vesting_state: 'CTOFrozen',
      cto_triggered: true,
      community_treasury_wallet: COMMUNITY,
    });
  });

  it('refuses a record whose last executed vote is not the takeover', () => {
    const state = stateFor(proposal({ proposal_type: 'VestingToTreasury' }), running);
    expect(() => planVestingFreeze(state, { governanceScriptHash: GOVERNANCE_HASH })).toThrow(
      /applied from the takeover's own execution/,
    );
  });

  it('refuses a schedule that is already frozen', () => {
    const state = stateFor(takeover);
    expect(() => planVestingFreeze(state, { governanceScriptHash: GOVERNANCE_HASH })).toThrow(/already frozen/);
  });
});

describe('keeping the allocation on the treasury terms', () => {
  it('is accepted by vesting, which keeps every token and records the decision', async () => {
    const state = stateFor(proposal({ proposal_type: 'VestingToTreasury' }));
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    expect(plan.moved).toBe(0n);
    const tx = await build(plan, state);
    expect(tokensIn(tx, 0)).toBe(HELD);
    const datum = Data.from(datumCborAt(tx, 0), VestingDatumSchema);
    expect(datum.vesting_state).toBe('Disposed');
  });

  it('refuses an allocation already disposed of', () => {
    const state = stateFor(proposal({ proposal_type: 'VestingToTreasury' }), { vesting_state: 'Disposed' });
    expect(() => planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW })).toThrow(/final/);
  });

  it('refuses before the freeze has been applied', () => {
    const state = stateFor(proposal({ proposal_type: 'VestingToTreasury' }), {
      vesting_state: 'Vesting',
      cto_triggered: false,
    });
    expect(() => planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW })).toThrow(
      /freeze has to be applied first/,
    );
  });
});

describe('moving the allocation into staking', () => {
  it("tops up the launch's pool with every token, accepted by vesting and the pool", async () => {
    const state = withStakingPool(stateFor(proposal({ proposal_type: 'VestingToStaking' })));
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    expect(plan.moved).toBe(HELD);
    expect(plan.requiredSignerHashes).toEqual([]);
    const tx = await build(plan, state);
    expect(tokensIn(tx, 0)).toBe(0n);
    expect(tokensIn(tx, 1)).toBe(200_000_000n + HELD);
    const pool = Data.from(datumCborAt(tx, 1), StakingPoolDatumSchema);
    expect(pool.unallocated).toBe(200_000_000n + HELD);
    expect(pool.emission_per_day).toBe(100_000n);
  });

  it('refills a pool whose budget ran dry with the governor as the launch party that signs', async () => {
    const state = withStakingPool(stateFor(proposal({ proposal_type: 'VestingToStaking' })), {
      unallocated: 0n,
      total_staked: 5_000_000n,
      exhausted_at: BigInt(NOW - 2 * 86_400_000),
    });
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    expect(plan.requiredSignerHashes).toEqual([GOVERNOR]);
    await build(plan, state);
  });

  it('opens a pool with the runway the vote named when the launch has none', async () => {
    const state = stateFor(proposal({ proposal_type: 'VestingToStaking', allocation_amount: 1_095n }));
    const plan = planDisposition(state, {
      governanceScriptHash: GOVERNANCE_HASH,
      nowMs: NOW,
      stakingPoolAddress: at(STAKING),
    });
    expect(plan.staking).toEqual({ created: true, runwayDays: 1_095n, emissionPerDay: HELD / 1_095n });
    expect(plan.requiredSignerHashes).toEqual([GOVERNOR]);
    const tx = await build(plan, state);
    const pool = Data.from(datumCborAt(tx, 1), StakingPoolDatumSchema);
    expect(pool.creator_pub_key_hash).toBe(COMMUNITY);
    expect(pool.unallocated).toBe(HELD);
    expect(pool.last_update_ms).toBe(BigInt(plan.validity?.fromMs ?? 0));
  });

  it('refuses a vote to top up a pool the launch does not have', () => {
    const state = stateFor(proposal({ proposal_type: 'VestingToStaking', allocation_amount: 0n }));
    expect(() => planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW })).toThrow(
      /cannot run as voted/,
    );
  });
});

describe('moving the allocation into liquidity', () => {
  const DX = 4_500_000_000n;

  it('deposits the voted ADA with the tokens it buys, accepted by vesting, the escrow and the pool', async () => {
    const state = withLiquidity(stateFor(proposal({ proposal_type: 'VestingToLp', allocation_amount: DX })));
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    // 4,500 ADA at 30,000 ADA : 200M tokens buys 30M, and mints 150M LP.
    expect(plan.lp).toEqual({ dx: DX, dy: 30_000_000n, dlq: 150_000_000n });
    expect(plan.requiredSignerHashes).toEqual([COMMUNITY]);
    const tx = await build(plan, state);
    expect(tx.length / 2).toBeLessThan(MAX_TX_BYTES);
    const escrow = Data.from(datumCborAt(tx, 1), LpEscrowDatumSchema);
    expect(escrow.lp_token_amount).toBe(LQ0 + 150_000_000n);
    expect(escrow.lock_timestamp).toBe(BigInt(plan.validity?.fromMs ?? 0));
    expect(tokensIn(tx, 0)).toBe(HELD - 30_000_000n);
    expect(tokensIn(tx, 2)).toBe(RY + 30_000_000n);
  });

  it('moves the whole allocation when the ADA buys more than it holds', async () => {
    const state = withLiquidity(
      stateFor(proposal({ proposal_type: 'VestingToLp', allocation_amount: 9_000_000_000n }), {}),
    );
    state.vesting.assets[TOKEN] = 40_000_000n;
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    expect(plan.moved).toBe(40_000_000n);
    await build(plan, state);
  });

  it('is refused by the validators when the pool is short one token', async () => {
    const state = withLiquidity(stateFor(proposal({ proposal_type: 'VestingToLp', allocation_amount: DX })));
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    const poolOut = plan.outputs[2];
    if (!poolOut) throw new Error('no pool output');
    poolOut.assets = { ...poolOut.assets, [TOKEN]: (poolOut.assets[TOKEN] ?? 0n) - 1n };
    const vestingOut = plan.outputs[0];
    if (!vestingOut) throw new Error('no vesting output');
    vestingOut.assets = { ...vestingOut.assets, [TOKEN]: (vestingOut.assets[TOKEN] ?? 0n) + 1n };
    await expect(build(plan, state)).rejects.toThrow(/evaluation failed/i);
  });
});

// Each is a transaction the validators accepted above with ONE thing changed,
// so a pass here means the check that one change breaks is really running.
describe('the validators refuse each arm with one thing changed', () => {
  /** Re-encodes one output's datum through `schema` with `change` applied. */
  function tamper<D>(plan: VestingTakeoverPlan, index: number, schema: D, change: (d: D) => D) {
    const out = plan.outputs[index];
    if (!out) throw new Error(`no output ${index}`);
    // The schema objects are Lucid's own; the cast only widens the generic.
    out.datumCbor = Data.to(change(Data.from(out.datumCbor, schema)) as never, schema);
  }
  const refused = /evaluation failed/i;

  it('a freeze that names a different wallet', async () => {
    const state = stateFor(proposal({ proposal_type: 'SilenceLockTrigger', allocation_recipient_hash: COMMUNITY }), {
      vesting_state: 'Vesting',
      cto_triggered: false,
      community_treasury_wallet: '',
    });
    const plan = planVestingFreeze(state, { governanceScriptHash: GOVERNANCE_HASH });
    tamper(plan, 0, VestingDatumSchema, (d) => ({ ...d, community_treasury_wallet: '66'.repeat(28) }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });

  it('a treasury disposition that leaves the allocation frozen', async () => {
    const state = stateFor(proposal({ proposal_type: 'VestingToTreasury' }));
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    tamper(plan, 0, VestingDatumSchema, (d) => ({ ...d, vesting_state: 'CTOFrozen' as const }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });

  it('a top-up whose pool records one token more than arrived', async () => {
    const state = withStakingPool(stateFor(proposal({ proposal_type: 'VestingToStaking' })));
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    tamper(plan, 1, StakingPoolDatumSchema, (d) => ({ ...d, unallocated: d.unallocated + 1n }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });

  it('a new pool paying a day more than the runway allows', async () => {
    const state = stateFor(proposal({ proposal_type: 'VestingToStaking', allocation_amount: 1_095n }));
    const plan = planDisposition(state, {
      governanceScriptHash: GOVERNANCE_HASH,
      nowMs: NOW,
      stakingPoolAddress: at(STAKING),
    });
    tamper(plan, 1, StakingPoolDatumSchema, (d) => ({ ...d, emission_per_day: d.emission_per_day + 1n }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });

  it('a deposit whose escrow keeps its old lock', async () => {
    const state = withLiquidity(
      stateFor(proposal({ proposal_type: 'VestingToLp', allocation_amount: 4_500_000_000n })),
    );
    const plan = planDisposition(state, { governanceScriptHash: GOVERNANCE_HASH, nowMs: NOW });
    tamper(plan, 1, LpEscrowDatumSchema, (d) => ({ ...d, lock_timestamp: escrowDatum().lock_timestamp }));
    await expect(build(plan, state)).rejects.toThrow(refused);
  });
});
