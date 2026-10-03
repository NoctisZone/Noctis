// ============================================================================
// Noctis Zone — carrying out a takeover on a creator's vesting allocation
// ============================================================================
// Two transactions act on `vesting.ak` after a community takeover, and both
// are built here.
//
// **The freeze** (`TriggerCTO`). A passed, executed `SilenceLockTrigger` stops
// the creator's schedule and records the community wallet the vote named. It
// is applied from the takeover's own execution, which the governance record
// shows as its most recent executed vote, so it follows the takeover
// directly. Permissionless; anyone may pay for it.
//
// **The disposition** (`ExecuteDisposition`). A second vote sends the frozen
// allocation to one destination, and the decision is final:
//
//   - `VestingToTreasury`: nothing moves. The allocation stays in vesting on
//     the treasury terms and leaves only by passed allocation votes.
//     Permissionless.
//   - `VestingToStaking`: the whole allocation goes to the launch's staking
//     pool. An existing pool is topped up at its own daily rate, which is
//     permissionless unless its budget has run dry, when the pool asks for the
//     creator's or the governor's signature. A launch without a pool gets one,
//     with the runway the vote named. Its thread NFT is minted under the
//     governor's key, so the governor signs that one.
//   - `VestingToLp`: the lovelace the vote named goes into the launch's pool
//     from the community wallet, which signs, together with as many tokens as
//     it buys at the pool's ratio. Every LP token the deposit mints goes into
//     the LP escrow, whose lock restarts.
//
// Every figure here is the one the validators recompute, so a plan either
// matches what the chain will accept or is refused before it is signed. The
// tests run the compiled validators against the transactions built here.
// ============================================================================

import { Constr, Data } from '@lucid-evolution/lucid';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type CtoGovernanceDatumData, CtoGovernanceDatumSchema } from './cardano-cto-anchor-submitter.js';
import {
  type DatumUtxo,
  readByUnit,
  type TakeoverOutput,
  type TakeoverSpend,
  type TakeoverTxPlan,
} from './cto-takeover-tx.js';
import {
  type LpEscrowDatumData,
  LpEscrowDatumSchema,
  type StakingPoolDatumData,
  StakingPoolDatumSchema,
  threadNftAssetName,
  type VestingDatumData,
  VestingDatumSchema,
  venueAssetName,
} from './launch-schemas.js';
import type { PlanAssets } from './mesh-curve-spend.js';
import { LP_ESCROW_REDEEMER, STAKING_POOL_REDEEMER, VESTING_REDEEMER } from './redeemer-indices.js';
import { STAKE_EMPTY_ROOT } from './stake-accumulator-tree.js';
import { advance, validityRangeFor } from './staking-math.js';
import { VENUE_MAX_LQ_CAP, type VenuePoolConfigData, VenuePoolConfigSchema } from './venue-pool.js';
import { VENUE_POOL_ACTION } from './venue-swap.js';

export type DispositionKind = 'VestingToTreasury' | 'VestingToStaking' | 'VestingToLp';
export const DISPOSITION_KINDS: readonly DispositionKind[] = ['VestingToTreasury', 'VestingToStaking', 'VestingToLp'];

/** `staking_pool_datum.max_unstake_lock_ms`: the lock a pool a vote opens is given. */
export const DISPOSITION_POOL_UNSTAKE_LOCK_MS = 604_800_000n;

/**
 * What the transactions read and spend. The governance record and vesting are
 * always needed; the rest only by the arm that touches them.
 */
export interface VestingTakeoverState {
  vesting: DatumUtxo<VestingDatumData>;
  governance: DatumUtxo<CtoGovernanceDatumData>;
  /** Absent when the launch never opened one. */
  stakingPool?: DatumUtxo<StakingPoolDatumData>;
  lpEscrow?: DatumUtxo<LpEscrowDatumData>;
  venuePool?: DatumUtxo<VenuePoolConfigData>;
}

/** A transaction on the vesting allocation. */
export interface VestingTakeoverPlan extends TakeoverTxPlan {
  action: 'freeze' | DispositionKind;
  /** The launch's tokens that leave vesting. */
  moved: bigint;
  /** The LP arm's deposit, as the pool and the escrow will read it. */
  lp?: { dx: bigint; dy: bigint; dlq: bigint };
  /** The staking arm's destination. */
  staking?: { created: false; exhausted: boolean } | { created: true; runwayDays: bigint; emissionPerDay: bigint };
}

export const tokenUnit = (d: Pick<VestingDatumData, 'token_policy_id' | 'token_asset_name'>) =>
  d.token_policy_id + d.token_asset_name;

export const threadUnit = (policy: string, role: Parameters<typeof threadNftAssetName>[0], launchIdHex: string) =>
  policy + threadNftAssetName(role, launchIdHex);

export function sameCredential(a: VestingDatumData['cto_governance_credential'], scriptHash: string): boolean {
  return JSON.stringify(a) === JSON.stringify({ ScriptCredential: [scriptHash] });
}

export function withQuantity(assets: PlanAssets, unit: string, delta: bigint): PlanAssets {
  const next = { ...assets, [unit]: (assets[unit] ?? 0n) + delta };
  if (next[unit] === 0n) delete next[unit];
  return next;
}

/**
 * The governance record's claims, checked the way vesting checks them before
 * either transaction trusts them: the launch's own record, by its NFT and its
 * launch id, carrying a passed, executed proposal of the type asked for.
 */
function executedProposal(state: VestingTakeoverState, governanceScriptHash: string) {
  const { vesting, governance } = state;
  const v = vesting.datum;
  const g = governance.datum;
  if (!sameCredential(v.cto_governance_credential, governanceScriptHash)) {
    throw new Error(
      "This launch's vesting names a different governance script than the one given, so it would not read this record.",
    );
  }
  if (governance.assets[threadUnit(v.thread_nft_policy, 'ctoGovernance', v.launch_id)] !== 1n) {
    throw new Error("The governance output does not carry this launch's governance NFT, so it is not its record.");
  }
  if (g.launch_id !== v.launch_id) throw new Error('The governance record belongs to a different launch.');
  const executed = g.last_executed_proposal;
  if (!executed) throw new Error('The governance record has executed no proposal yet.');
  if (executed.outcome !== 'Passed' || executed.execution_status !== 'Executed') {
    throw new Error('The last proposal the record shows has not passed and been executed.');
  }
  return executed;
}

/**
 * The freeze a passed takeover applies to the creator's schedule.
 *
 * Nothing moves: the whole allocation stays where it is, and only who may
 * later claim it changes.
 */
export function planVestingFreeze(
  state: VestingTakeoverState,
  opts: { governanceScriptHash: string },
): VestingTakeoverPlan {
  const executed = executedProposal(state, opts.governanceScriptHash);
  const v = state.vesting.datum;
  const g = state.governance.datum;
  if (executed.proposal_type !== 'SilenceLockTrigger') {
    throw new Error(
      `The last executed proposal is ${executed.proposal_type}, not the takeover. The freeze is applied from ` +
        "the takeover's own execution.",
    );
  }
  if (g.cto_state !== 'CTOTriggered' || g.community_wallet_hash === '') {
    throw new Error('The governance record no longer shows the takeover holding, so there is nothing to freeze for.');
  }
  if (g.community_wallet_hash !== executed.allocation_recipient_hash) {
    throw new Error("The record's community wallet is not the one the takeover named.");
  }
  if (v.cto_triggered) throw new Error('The allocation is already frozen.');
  if (v.vesting_state !== 'Vesting') {
    throw new Error(`Vesting is ${v.vesting_state}. Only a schedule that has started can be frozen.`);
  }
  const next: VestingDatumData = {
    ...v,
    cto_triggered: true,
    community_treasury_wallet: g.community_wallet_hash,
    vesting_state: 'CTOFrozen',
  };
  return {
    action: 'freeze',
    spends: [
      {
        role: 'vesting',
        utxo: state.vesting,
        redeemer: { cbor: Data.to(new Constr(VESTING_REDEEMER.TriggerCTO, [g.community_wallet_hash])) },
      },
    ],
    referenceInputs: [state.governance],
    outputs: [
      { address: state.vesting.address, assets: state.vesting.assets, datumCbor: Data.to(next, VestingDatumSchema) },
    ],
    requiredSignerHashes: [],
    fundingLovelace: 0n,
    moved: 0n,
  };
}

/**
 * The disposition the governance record's last executed vote decided.
 *
 * `nowMs` is the machine's clock. The validity range is set from it with the
 * same margin every staking spend uses, and the figures that depend on time
 * are computed from that range's lower bound, which is what the validators
 * read.
 */
export function planDisposition(
  state: VestingTakeoverState,
  opts: {
    governanceScriptHash: string;
    nowMs: number;
    /** Where a new staking pool is opened. Required only when the launch has none. */
    stakingPoolAddress?: string;
  },
): VestingTakeoverPlan {
  const executed = executedProposal(state, opts.governanceScriptHash);
  const v = state.vesting.datum;
  const g = state.governance.datum;
  const kind = executed.proposal_type;
  if (kind !== 'VestingToTreasury' && kind !== 'VestingToStaking' && kind !== 'VestingToLp') {
    throw new Error(`The last executed proposal is ${kind}, which is not a decision about the frozen allocation.`);
  }
  if (g.cto_state !== 'CTOTriggered' || g.community_wallet_hash === '') {
    throw new Error('The governance record no longer shows the takeover holding, and a disposition needs it to.');
  }
  if (!v.cto_triggered || v.vesting_state !== 'CTOFrozen') {
    throw new Error(
      v.vesting_state === 'Disposed'
        ? 'The allocation has already been disposed of. The decision is final.'
        : `Vesting is ${v.vesting_state}, not frozen. The takeover's freeze has to be applied first.`,
    );
  }

  const held = state.vesting.assets[tokenUnit(v)] ?? 0n;
  const disposed: VestingDatumData = { ...v, vesting_state: 'Disposed' };
  const vestingSpend = (): TakeoverSpend => ({
    role: 'vesting',
    utxo: state.vesting,
    redeemer: { cbor: Data.to(new Constr(VESTING_REDEEMER.ExecuteDisposition, [])) },
  });
  const vestingOutput = (moved: bigint): TakeoverOutput => ({
    address: state.vesting.address,
    assets: withQuantity(state.vesting.assets, tokenUnit(v), -moved),
    datumCbor: Data.to(disposed, VestingDatumSchema),
  });
  const base: Pick<VestingTakeoverPlan, 'action' | 'referenceInputs'> = {
    action: kind,
    referenceInputs: [state.governance],
  };

  if (kind === 'VestingToTreasury') {
    return {
      ...base,
      spends: [vestingSpend()],
      outputs: [vestingOutput(0n)],
      requiredSignerHashes: [],
      fundingLovelace: 0n,
      moved: 0n,
    };
  }

  if (held <= 0n) throw new Error('Vesting holds none of the launch tokens, so there is nothing to move.');
  const range = validityRangeFor(opts.nowMs, Number(state.stakingPool?.datum.last_update_ms ?? 0n));
  const now = BigInt(range.from);
  const validity = { fromMs: range.from, toMs: range.to };

  if (kind === 'VestingToStaking') {
    const moved = held;
    const pool = state.stakingPool;
    if (pool) {
      const p = pool.datum;
      if (p.launch_id !== v.launch_id || tokenUnit(p) !== tokenUnit(v)) {
        throw new Error("The staking pool given is not this launch's.");
      }
      if (pool.assets[threadUnit(v.thread_nft_policy, 'stakingPool', v.launch_id)] !== 1n) {
        throw new Error("The staking pool output does not carry this launch's staking NFT.");
      }
      if (p.unallocated === 0n && p.exhausted_at === null) {
        throw new Error('The staking pool has never been funded, and only a graduation may fund it first.');
      }
      const { acc, unallocated } = advance(p, now);
      const next: StakingPoolDatumData = {
        ...p,
        acc_reward_per_token: acc,
        unallocated: unallocated + moved,
        last_update_ms: now,
        exhausted_at: null,
      };
      const exhausted = p.exhausted_at !== null;
      return {
        ...base,
        spends: [
          vestingSpend(),
          {
            role: 'stakingPool',
            utxo: pool,
            redeemer: { cbor: Data.to(new Constr(STAKING_POOL_REDEEMER.TopUpPool, [moved])) },
          },
        ],
        outputs: [
          vestingOutput(moved),
          {
            address: pool.address,
            assets: withQuantity(pool.assets, tokenUnit(v), moved),
            datumCbor: Data.to(next, StakingPoolDatumSchema),
          },
        ],
        // A dry budget is refilled only by the launch's own parties. The
        // creator is gone, so it is the governor.
        requiredSignerHashes: exhausted ? [p.governor_pub_key_hash] : [],
        validity,
        fundingLovelace: 0n,
        moved,
        staking: { created: false, exhausted },
      };
    }

    const runwayDays = executed.allocation_amount;
    if (runwayDays === 0n) {
      throw new Error(
        'The vote topped up an existing staking pool, and this launch has none. The disposition cannot run as voted.',
      );
    }
    if (moved / runwayDays === 0n) {
      throw new Error('The allocation spread over the voted runway pays nothing a day, so the pool could not open.');
    }
    if (!opts.stakingPoolAddress) throw new Error('A new staking pool needs the staking pool address to open at.');
    const genesis: StakingPoolDatumData = {
      launch_id: v.launch_id,
      creator_pub_key_hash: g.community_wallet_hash,
      token_policy_id: v.token_policy_id,
      token_asset_name: v.token_asset_name,
      thread_nft_policy: v.thread_nft_policy,
      emission_per_day: moved / runwayDays,
      stake_root: bytesToHex(STAKE_EMPTY_ROOT),
      acc_reward_per_token: 0n,
      total_staked: 0n,
      unallocated: moved,
      last_update_ms: now,
      exhausted_at: null,
      governor_pub_key_hash: v.governor_pub_key_hash,
      unstake_lock_ms: DISPOSITION_POOL_UNSTAKE_LOCK_MS,
    };
    const nftName = threadNftAssetName('stakingPool', v.launch_id);
    return {
      ...base,
      spends: [vestingSpend()],
      outputs: [
        vestingOutput(moved),
        {
          address: opts.stakingPoolAddress,
          assets: { [v.thread_nft_policy + nftName]: 1n, [tokenUnit(v)]: moved },
          datumCbor: Data.to(genesis, StakingPoolDatumSchema),
        },
      ],
      mint: { governorKeyHash: v.governor_pub_key_hash, assetNameHex: nftName },
      requiredSignerHashes: [v.governor_pub_key_hash],
      validity,
      fundingLovelace: 0n,
      moved,
      staking: { created: true, runwayDays, emissionPerDay: genesis.emission_per_day },
    };
  }

  // VestingToLp.
  const { escrow, pool, lqUnit } = lpArmOf(state);
  const e = escrow.datum;
  const cfg = pool.datum;
  const dx = executed.allocation_amount;
  const { moved, dlq } = lpDepositOf(dx, held, poolReservesOf(pool, tokenUnit(v), lqUnit));
  if (moved <= 0n) throw new Error('The ADA the vote named buys no tokens at the pool price.');
  if (dlq <= 0n) throw new Error('The deposit is too small to mint any liquidity.');

  const nextEscrow: LpEscrowDatumData = { ...e, lock_timestamp: now, lp_token_amount: e.lp_token_amount + dlq };
  let poolAssets = withQuantity(pool.assets, 'lovelace', dx);
  poolAssets = withQuantity(poolAssets, tokenUnit(v), moved);
  poolAssets = withQuantity(poolAssets, lqUnit, -dlq);
  return {
    ...base,
    spends: [
      vestingSpend(),
      {
        role: 'lpEscrow',
        utxo: escrow,
        redeemer: { cbor: Data.to(new Constr(LP_ESCROW_REDEEMER.AddDisposedLiquidity, [now])) },
      },
      { role: 'venuePool', utxo: pool, redeemer: { venuePoolAction: VENUE_POOL_ACTION.Deposit } },
    ],
    outputs: [
      vestingOutput(moved),
      {
        address: escrow.address,
        assets: withQuantity(escrow.assets, lqUnit, dlq),
        datumCbor: Data.to(nextEscrow, LpEscrowDatumSchema),
      },
      // The pool's datum is unchanged by a deposit.
      { address: pool.address, assets: poolAssets, datumCbor: Data.to(cfg, VenuePoolConfigSchema) },
    ],
    requiredSignerHashes: [g.community_wallet_hash],
    validity,
    fundingLovelace: dx,
    moved,
    lp: { dx, dy: moved, dlq },
  };
}

// ---------------------------------------------------------------------------
// The LP arm's arithmetic, shared by the transaction and its preview
// ---------------------------------------------------------------------------

/** The launch's LP escrow and pool, each checked as this launch's, as the LP arm reads them. */
function lpArmOf(state: VestingTakeoverState) {
  const v = state.vesting.datum;
  const escrow = state.lpEscrow;
  const pool = state.venuePool;
  if (!escrow || !pool) throw new Error('Moving the allocation into liquidity needs the LP escrow and the pool.');
  const e = escrow.datum;
  const cfg = pool.datum;
  if (escrow.assets[threadUnit(v.thread_nft_policy, 'lpEscrow', v.launch_id)] !== 1n || e.launch_id !== v.launch_id) {
    throw new Error("The LP escrow given is not this launch's.");
  }
  if (e.lp_state !== 'Locked')
    throw new Error(`The LP escrow is ${e.lp_state}, and only a locked one takes liquidity.`);
  const poolNftUnit = e.lp_token_policy_id + venueAssetName('pool', v.launch_id);
  if (pool.assets[poolNftUnit] !== 1n) throw new Error("The pool given is not this launch's pool.");
  const lqUnit = e.lp_token_policy_id + e.lp_token_name;
  if (cfg.pool_lq.policy + cfg.pool_lq.name !== lqUnit) {
    throw new Error("The pool's liquidity token is not the one the escrow holds.");
  }
  if (cfg.pool_y.policy + cfg.pool_y.name !== tokenUnit(v)) {
    throw new Error("The pool does not trade this launch's token.");
  }
  if (cfg.pool_x.policy !== '' || cfg.pool_x.name !== '') throw new Error('The pool does not pair the token with ADA.');
  return { escrow, pool, lqUnit };
}

/** A pool's trading reserves (its value less the fees it holds for others) and its liquidity outstanding. */
export interface PoolReserves {
  /** Lovelace. */
  rx: bigint;
  /** The launch's tokens. */
  ry: bigint;
  /** Liquidity tokens outstanding. */
  lq0: bigint;
}

export function poolReservesOf(
  pool: Pick<DatumUtxo<VenuePoolConfigData>, 'assets' | 'datum'>,
  tokenUnitId: string,
  lqUnit: string,
): PoolReserves {
  const cfg = pool.datum;
  const rx = (pool.assets.lovelace ?? 0n) - cfg.treasury_x - cfg.royalty_x;
  const ry = (pool.assets[tokenUnitId] ?? 0n) - cfg.treasury_y - cfg.royalty_y;
  const lq0 = VENUE_MAX_LQ_CAP - (pool.assets[lqUnit] ?? 0n);
  if (rx <= 0n || ry <= 0n || lq0 <= 0n) throw new Error('The pool has no reserves to price a deposit against.');
  return { rx, ry, lq0 };
}

/**
 * The LP arm's deposit: `dx` lovelace, with as many of the `held` tokens as it
 * buys at the pool's ratio, and the liquidity that mints. When the ADA buys
 * more than vesting holds, every held token goes in and all of the ADA still
 * does, so the pool's price rises; the liquidity minted is what the smaller
 * side earns.
 */
export function lpDepositOf(dx: bigint, held: bigint, r: PoolReserves) {
  const buys = (dx * r.ry) / r.rx;
  const moved = held < buys ? held : buys;
  const byX = (dx * r.lq0) / r.rx;
  const byY = (moved * r.lq0) / r.ry;
  const dlq = byX < byY ? byX : byY;
  return { dx, buys, moved, dlq };
}

/** What pairing the frozen allocation into the pool with `dxLovelace` would do, read before anyone votes for it. */
export interface LpDispositionPreview {
  /** The launch tokens vesting holds. */
  held: bigint;
  /** Whether the takeover's freeze has been applied to vesting yet. */
  frozen: boolean;
  dx: bigint;
  /** The tokens the ADA buys at the pool's ratio. */
  buys: bigint;
  /** The tokens that go in: what the ADA buys, or every held token when it buys more. */
  moved: bigint;
  /** The tokens left in vesting, on the treasury terms. */
  left: bigint;
  /** Liquidity tokens the deposit mints, all of them into the LP escrow. */
  dlq: bigint;
  /** The LP escrow's position before and after. */
  escrowLq: bigint;
  escrowLqAfter: bigint;
  /** Liquidity outstanding before the deposit. */
  lq0: bigint;
  /** The pool's trading reserves before and after. */
  before: { rx: bigint; ry: bigint };
  after: { rx: bigint; ry: bigint };
}

/**
 * The LP arm's figures for a vote not yet filed: the same reads and the same
 * arithmetic the disposition will run, with nothing built or signed.
 */
export function previewLpDisposition(state: VestingTakeoverState, dxLovelace: bigint): LpDispositionPreview {
  if (dxLovelace <= 0n) throw new Error('Name a positive amount of ADA.');
  const v = state.vesting.datum;
  const { escrow, pool, lqUnit } = lpArmOf(state);
  const held = state.vesting.assets[tokenUnit(v)] ?? 0n;
  const reserves = poolReservesOf(pool, tokenUnit(v), lqUnit);
  const d = lpDepositOf(dxLovelace, held, reserves);
  return {
    held,
    frozen: v.cto_triggered && v.vesting_state === 'CTOFrozen',
    dx: d.dx,
    buys: d.buys,
    moved: d.moved,
    left: held - d.moved,
    dlq: d.dlq,
    escrowLq: escrow.datum.lp_token_amount,
    escrowLqAfter: escrow.datum.lp_token_amount + d.dlq,
    lq0: reserves.lq0,
    before: { rx: reserves.rx, ry: reserves.ry },
    after: { rx: reserves.rx + d.dx, ry: reserves.ry + d.moved },
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Reads a launch's vesting, governance record and, when asked, the outputs a
 * disposition touches, each found by the thread NFT that authenticates it.
 */
export async function readVestingTakeoverState(
  get: (path: string) => Promise<unknown>,
  args: {
    launchIdHex: string;
    threadNftPolicyId: string;
    addresses: { vesting: string; governance: string; stakingPool?: string; lpEscrow?: string; venuePool?: string };
  },
): Promise<VestingTakeoverState> {
  const { launchIdHex: id, threadNftPolicyId: policy, addresses } = args;
  const vesting = await readByUnit(
    get,
    addresses.vesting,
    threadUnit(policy, 'vesting', id),
    VestingDatumSchema,
    'vesting',
  );
  if (!vesting) throw new Error("This launch's vesting output could not be found.");
  const governance = await readByUnit(
    get,
    addresses.governance,
    threadUnit(policy, 'ctoGovernance', id),
    CtoGovernanceDatumSchema,
    'governance',
  );
  if (!governance) throw new Error("This launch's governance record could not be found.");
  const state: VestingTakeoverState = { vesting, governance };
  if (addresses.stakingPool) {
    state.stakingPool = await readByUnit(
      get,
      addresses.stakingPool,
      threadUnit(policy, 'stakingPool', id),
      StakingPoolDatumSchema,
      'staking pool',
    );
  }
  if (addresses.lpEscrow) {
    state.lpEscrow = await readByUnit(
      get,
      addresses.lpEscrow,
      threadUnit(policy, 'lpEscrow', id),
      LpEscrowDatumSchema,
      'LP escrow',
    );
    if (state.lpEscrow && addresses.venuePool) {
      state.venuePool = await readByUnit(
        get,
        addresses.venuePool,
        state.lpEscrow.datum.lp_token_policy_id + venueAssetName('pool', id),
        VenuePoolConfigSchema,
        'pool',
      );
    }
  }
  return state;
}
