// The staking pool's arithmetic, pinned against the validator's own tests.
//
// Every field of the pool's continuing datum is compared on chain against what
// the validator derives for itself, so a value computed one unit differently
// here builds a transaction that fails script evaluation and names neither the
// field nor the reason. These use the SAME pool the .ak module's tests use — a
// 3,650,000 budget over 1,000 days, 3,650 a day — and assert the same figures,
// so a drift on either side fails on both.

import { describe, expect, it } from 'vitest';
import {
  ACC_SCALE,
  advance,
  currentAprPercent,
  debtAt,
  exhaustedAfter,
  MAX_VALIDITY_RANGE_MS,
  MS_PER_DAY,
  owedAt,
  type PoolAccumulatorState,
  runwayDaysRemaining,
  validityRangeFor,
} from '../staking-math.js';

const START_MS = 1_700_000_000_000n;
const DAY = MS_PER_DAY;

const pool = (over: Partial<PoolAccumulatorState> = {}): PoolAccumulatorState => ({
  emission_per_day: 3_650n,
  acc_reward_per_token: 0n,
  total_staked: 0n,
  unallocated: 3_650_000n,
  last_update_ms: START_MS,
  ...over,
});

describe('advance — agreement with staking_pool.ak', () => {
  it('emits nothing, and spends no budget, when nobody is staked', () => {
    // The property the whole runway rests on: a quiet stretch moves the end
    // date later rather than burning tokens nobody received.
    const { acc, unallocated } = advance(pool(), START_MS + 100n * DAY);
    expect(acc).toBe(0n);
    expect(unallocated).toBe(3_650_000n);
  });

  it("emits a day's worth per day", () => {
    const { acc, unallocated } = advance(pool({ total_staked: 1_000n }), START_MS + DAY);
    expect(acc).toBe((3_650n * ACC_SCALE) / 1_000n);
    expect(unallocated).toBe(3_650_000n - 3_650n);
  });

  it('is continuous, not daily', () => {
    // Half a day emits half a day's worth. There is no bucket to sit inside,
    // which is why the bonding period became a lock on leaving.
    const { acc } = advance(pool({ total_staked: 1_000n }), START_MS + DAY / 2n);
    expect(acc).toBe((1_825n * ACC_SCALE) / 1_000n);
  });

  it('never emits more than the budget holds', () => {
    // 2,000 days elapsed against a 1,000-day budget. Real time keeps passing;
    // the budget does not.
    const { unallocated } = advance(pool({ total_staked: 1_000n }), START_MS + 2_000n * DAY);
    expect(unallocated).toBe(0n);
  });

  it('lets a bigger budget buy more days at the same rate', () => {
    const doubled = pool({ total_staked: 1_000n, unallocated: 7_300_000n });
    expect(advance(doubled, START_MS + 1_000n * DAY)).toEqual({
      acc: (3_650_000n * ACC_SCALE) / 1_000n,
      unallocated: 3_650_000n,
    });
    expect(advance(doubled, START_MS + 2_000n * DAY).unallocated).toBe(0n);
  });

  it('does not run backwards on a stale timestamp', () => {
    const p = pool({ total_staked: 1_000n });
    expect(advance(p, START_MS - DAY)).toEqual({ acc: 0n, unallocated: 3_650_000n });
  });
});

describe('what a position is owed', () => {
  it('is zero for a position that just moved', () => {
    const acc = 5n * ACC_SCALE;
    expect(owedAt({ amount: 1_000n, debt: debtAt(1_000n, acc), since: START_MS }, acc)).toBe(0n);
  });

  it('is the accumulator movement since the position last moved', () => {
    const { acc } = advance(pool({ total_staked: 1_000n }), START_MS + DAY);
    expect(owedAt({ amount: 1_000n, debt: 0n, since: START_MS }, acc)).toBe(3_650n);
  });

  it('splits a day pro-rata by stake, and never over-pays the emission', () => {
    const { acc } = advance(pool({ total_staked: 1_000n }), START_MS + DAY);
    const big = owedAt({ amount: 750n, debt: 0n, since: START_MS }, acc);
    const small = owedAt({ amount: 250n, debt: 0n, since: START_MS }, acc);
    expect(big).toBe(2_737n);
    expect(small).toBe(912n);
    // Flooring means the pool keeps the remainder rather than owing more than
    // it emitted — the direction that has to be true for it to stay solvent.
    expect(big + small).toBeLessThanOrEqual(3_650n);
  });
});

describe('exhaustion', () => {
  it('stamps the moment the budget empties, and only once', () => {
    expect(exhaustedAfter(null, 0n, START_MS)).toBe(START_MS);
    expect(exhaustedAfter(START_MS, 0n, START_MS + DAY)).toBe(START_MS);
    expect(exhaustedAfter(null, 5n, START_MS)).toBeNull();
  });
});

describe('the validity range a spend carries', () => {
  it('starts at now, because the validator reads the lower bound as now', () => {
    const { from, to } = validityRangeFor(1_700_000_000_000);
    expect(from).toBe(1_700_000_000_000);
    expect(to - from).toBeLessThan(MAX_VALIDITY_RANGE_MS);
  });
});

describe('figures for the dashboard', () => {
  it('reports a live rate that falls as more is staked', () => {
    // The emission is fixed, so a staker's share is decided entirely by who
    // else is staked beside them. There is no headline APR to quote.
    expect(currentAprPercent(3_650n, 3_650n)).toBeCloseTo(36_500, 0);
    expect(currentAprPercent(3_650n, 36_500n)).toBeCloseTo(3_650, 0);
    expect(currentAprPercent(3_650n, 365_000n)).toBeCloseTo(365, 0);
  });

  it('has no rate and no end date while nothing is staked', () => {
    // Not zero and not infinite: emission stops entirely, so neither figure
    // is defined until somebody stakes.
    expect(currentAprPercent(3_650n, 0n)).toBeNull();
    expect(runwayDaysRemaining(3_650n, 3_650_000n, 0n)).toBeNull();
  });

  it('counts the remaining runway in days of emission', () => {
    expect(runwayDaysRemaining(3_650n, 3_650_000n, 1_000n)).toBe(1_000);
  });
});
