// ============================================================================
// Noctis Zone — the staking pool's arithmetic, off chain
// ============================================================================
// A line-for-line mirror of contracts/cardano/validators/staking_pool.ak's
// `advance`, `owed_at` and `debt_at`.
//
// It has to be exact, not merely close. Every field of the pool's continuing
// datum is compared against what the validator derives for itself, so a value
// computed even one unit differently here builds a transaction that fails
// script evaluation — with a message naming neither the field nor the reason.
// The tests pin the same figures the .ak module's own tests do.
//
// All arithmetic is BigInt and every division floors, which is what Plutus
// integer division does. Number would lose the accumulator: it is scaled by
// 1e12 and multiplied by token amounts.
// ============================================================================

import type { StakePosition } from './stake-accumulator-tree.js';

/**
 * Fixed-point scale for `acc_reward_per_token`.
 *
 * The accumulator grows by `emitted * ACC_SCALE / total_staked`, and that
 * division is what would otherwise floor a small emission against a large
 * stake to nothing at all.
 */
export const ACC_SCALE = 1_000_000_000_000n;

export const MS_PER_DAY = 86_400_000n;

/** STAKING_BONDING_PERIOD_DAYS, as a lock on leaving rather than on earning. */
export const UNSTAKE_LOCK_MS = 604_800_000n;

/** How long an exhausted pool waits for a top-up before it can be retired. */
export const CLOSE_COOLDOWN_MS = 7_776_000_000n;

/**
 * Widest validity range the validator accepts. It reads the range's LOWER
 * bound as "now", so a builder must keep the window tight or the spend is
 * refused outright.
 */
export const MAX_VALIDITY_RANGE_MS = 600_000;

/**
 * How far behind the clock a spend's validity range opens, to absorb the gap
 * between wall-clock time and the chain tip's slot. Three minutes covers an
 * ordinary quiet stretch on Cardano with room to spare, and costs only that
 * much conservatism in accrual.
 */
export const TIP_LAG_MARGIN_MS = 180_000;

/** Just the fields the arithmetic reads. */
export interface PoolAccumulatorState {
  emission_per_day: bigint;
  acc_reward_per_token: bigint;
  total_staked: bigint;
  unallocated: bigint;
  last_update_ms: bigint;
}

export interface Advanced {
  acc: bigint;
  unallocated: bigint;
}

/**
 * The pool advanced to `nowMs`: what `acc_reward_per_token` and `unallocated`
 * become.
 *
 * Two behaviours are properties of this shape rather than separate rules. With
 * nothing staked nothing is emitted AND the budget is untouched, so a quiet
 * stretch moves the end date later instead of burning tokens nobody received.
 * And `unallocated` is the only stopping condition, so a top-up buys more days
 * at the same rate rather than a faster one.
 */
export function advance(pool: PoolAccumulatorState, nowMs: bigint): Advanced {
  const elapsed = nowMs - pool.last_update_ms;
  if (elapsed <= 0n || pool.total_staked <= 0n || pool.unallocated <= 0n) {
    return { acc: pool.acc_reward_per_token, unallocated: pool.unallocated };
  }
  const raw = (pool.emission_per_day * elapsed) / MS_PER_DAY;
  const emitted = raw > pool.unallocated ? pool.unallocated : raw;
  return {
    acc: pool.acc_reward_per_token + (emitted * ACC_SCALE) / pool.total_staked,
    unallocated: pool.unallocated - emitted,
  };
}

/**
 * What a position is owed at `acc`.
 *
 * Never negative for a position this validator wrote: `acc` only rises, `debt`
 * was this same expression at some earlier `acc`, and every change to `amount`
 * rewrites `debt` in the same breath.
 */
export function owedAt(pos: StakePosition, acc: bigint): bigint {
  return (pos.amount * acc) / ACC_SCALE - pos.debt;
}

/** The debt a position of `amount` carries from `acc` onward. */
export function debtAt(amount: bigint, acc: bigint): bigint {
  return (amount * acc) / ACC_SCALE;
}

/**
 * `exhausted_at` after a spend: stamped the first time the budget empties, and
 * never re-stamped while it stays empty.
 */
export function exhaustedAfter(current: bigint | null, unallocated: bigint, nowMs: bigint): bigint | null {
  return unallocated === 0n && current === null ? nowMs : current;
}

/**
 * The validity range a spend must carry: narrow enough for the validator to
 * accept, with `nowMs` as its lower bound because that is what the validator
 * reads as the current time.
 *
 * The bound is floored to the whole second, because that is what the chain
 * reports it as: a validity start travels as a slot, and both networks' era
 * start is itself a whole second. Callers must take their `now` from the
 * `from` this returns rather than from `nowMs` — the datum the validator
 * derives is pinned to the bound it reads, so a builder stamping the raw
 * clock disagrees with it by up to 999 ms and the spend is refused.
 *
 * It also starts BEHIND `nowMs`. A node validates against the slot of the
 * chain's tip, not against wall-clock time, and Cardano's block times are
 * probabilistic — a quiet minute or two leaves the tip well short of the
 * clock, and a range opening at "now" is then not yet valid. The margin only
 * makes accrual conservative: the validator reads the lower bound as the
 * current time, so it emits for slightly less elapsed time, and the next
 * spend picks the remainder up.
 *
 * `notBeforeMs` is the pool's own `last_update_ms`. Time may not run backwards
 * on the pool, so the margin is clamped rather than allowed to reach behind
 * the last spend — otherwise two spends in quick succession would leave the
 * second reaching back past the first.
 */
export function validityRangeFor(nowMs: number, notBeforeMs = 0): { from: number; to: number } {
  const toWholeSecond = (ms: number) => Math.floor(ms / 1000) * 1000;
  const from = Math.max(toWholeSecond(nowMs - TIP_LAG_MARGIN_MS), toWholeSecond(notBeforeMs));
  return { from, to: from + MAX_VALIDITY_RANGE_MS - 1_000 };
}

/**
 * What one token staked earns per year at the pool's CURRENT participation,
 * as a percentage.
 *
 * Deliberately a live figure rather than a headline: the emission is fixed, so
 * a staker's share is entirely decided by how much else is staked beside them.
 * Returns null when nothing is staked, because the rate is then undefined
 * rather than infinite — the first staker's eventual return depends on who
 * joins them.
 */
export function currentAprPercent(emissionPerDay: bigint, totalStaked: bigint): number | null {
  if (totalStaked <= 0n || emissionPerDay <= 0n) return null;
  return (Number(emissionPerDay) * 365 * 100) / Number(totalStaked);
}

/**
 * How long the budget lasts at the current participation, in days.
 *
 * Null when nothing is staked: emission stops entirely, so the runway is not
 * running down at all and no end date exists.
 */
export function runwayDaysRemaining(emissionPerDay: bigint, unallocated: bigint, totalStaked: bigint): number | null {
  if (totalStaked <= 0n || emissionPerDay <= 0n) return null;
  return Number(unallocated / emissionPerDay);
}
