import { describe, expect, it } from 'vitest';
import {
  assertSupplyConserved,
  CREATOR_ALLOC_MAX_PCT,
  creatorVestingRequirement,
  DV_ALLOC_MAX_PCT,
  type LaunchAllocation,
  LP_RESERVE_PCT,
  planLaunchAllocations,
  STAKING_ALLOC_PCT,
  TOTAL_SUPPLY_CAP,
  VESTING_FLOOR_BANDS,
  VESTING_MAX_DAYS,
  VESTING_MIN_DAYS,
} from '../launch-allocation.js';

const SUPPLY = TOTAL_SUPPLY_CAP;

describe('planLaunchAllocations — the split is a partition', () => {
  it('every allocation set it produces sums to exactly the supply', () => {
    // The property that matters, over the whole space of permitted inputs
    // rather than one example of it.
    for (const tier of ['A', 'B', 'C'] as const) {
      for (let creator = 0n; creator <= CREATOR_ALLOC_MAX_PCT; creator++) {
        for (const staking of [false, true]) {
          const darkVeilPercents = tier === 'A' ? [undefined] : [10n, 15n, DV_ALLOC_MAX_PCT];
          for (const darkVeilPercent of darkVeilPercents) {
            const plan = planLaunchAllocations({
              totalSupply: SUPPLY,
              tier,
              creatorPercent: creator,
              darkVeilPercent,
              stakingEnabled: staking,
            });
            expect(() => assertSupplyConserved(plan)).not.toThrow();
          }
        }
      }
    }
  });

  it('holds on a supply that divides badly, where the four floors round away real tokens', () => {
    // 7 is chosen to make every percentage floor lose something. The curve
    // absorbs the remainder, which is the whole reason it is computed as one.
    const plan = planLaunchAllocations({
      totalSupply: 7n,
      tier: 'C',
      creatorPercent: 10n,
      darkVeilPercent: 20n,
      stakingEnabled: true,
    });
    expect(
      plan.lpReserve + plan.creatorAllocation + plan.dvAllocation + plan.stakingAllocation + plan.curveSupply,
    ).toBe(7n);
    expect(() => assertSupplyConserved(plan)).not.toThrow();
  });

  it('leaves the curve a real share at every allocation simultaneously maxed', () => {
    // CLAUDE.md's own supply-safety claim: 20 + 10 + 20 + 25 = 75%, leaving
    // 25% for the curve. Asserted here so a constant raised later cannot
    // quietly invalidate it.
    const plan = planLaunchAllocations({
      totalSupply: SUPPLY,
      tier: 'C',
      creatorPercent: CREATOR_ALLOC_MAX_PCT,
      darkVeilPercent: DV_ALLOC_MAX_PCT,
      stakingEnabled: true,
    });
    expect(LP_RESERVE_PCT + CREATOR_ALLOC_MAX_PCT + DV_ALLOC_MAX_PCT + STAKING_ALLOC_PCT).toBe(75n);
    expect(plan.curveSupply).toBe((SUPPLY * 25n) / 100n);
  });

  it('gives the curve the staking share back when staking is declined', () => {
    const base = { totalSupply: SUPPLY, tier: 'B' as const, creatorPercent: 5n, darkVeilPercent: 15n };
    const withStaking = planLaunchAllocations({ ...base, stakingEnabled: true });
    const without = planLaunchAllocations({ ...base, stakingEnabled: false });
    expect(withStaking.stakingAllocation).toBe((SUPPLY * STAKING_ALLOC_PCT) / 100n);
    expect(without.stakingAllocation).toBe(0n);
    expect(without.curveSupply - withStaking.curveSupply).toBe(withStaking.stakingAllocation);
  });
});

describe('planLaunchAllocations — refuses what a contract could not', () => {
  it('rejects a creator share above the documented maximum', () => {
    expect(() =>
      planLaunchAllocations({
        totalSupply: SUPPLY,
        tier: 'A',
        creatorPercent: CREATOR_ALLOC_MAX_PCT + 1n,
        stakingEnabled: false,
      }),
    ).toThrow(/Creator allocation must be/);
  });

  it('rejects a DarkVeil share outside its band', () => {
    for (const percent of [9n, DV_ALLOC_MAX_PCT + 1n]) {
      expect(() =>
        planLaunchAllocations({
          totalSupply: SUPPLY,
          tier: 'B',
          creatorPercent: 5n,
          darkVeilPercent: percent,
          stakingEnabled: false,
        }),
      ).toThrow(/DarkVeil allocation must be/);
    }
  });

  it('rejects a DarkVeil allocation on the tier that has no DarkVeil phase', () => {
    expect(() =>
      planLaunchAllocations({
        totalSupply: SUPPLY,
        tier: 'A',
        creatorPercent: 5n,
        darkVeilPercent: 15n,
        stakingEnabled: false,
      }),
    ).toThrow(/the linear curve has no DarkVeil phase/);
  });

  it('rejects a DarkVeil tier that allocates nothing to the phase', () => {
    expect(() =>
      planLaunchAllocations({ totalSupply: SUPPLY, tier: 'C', creatorPercent: 5n, stakingEnabled: false }),
    ).toThrow(/must allocate to it/);
  });

  it('rejects a supply above the platform cap, and a non-positive one', () => {
    const base = { tier: 'A' as const, creatorPercent: 5n, stakingEnabled: false };
    expect(() => planLaunchAllocations({ ...base, totalSupply: TOTAL_SUPPLY_CAP + 1n })).toThrow(
      /exceeds the platform cap/,
    );
    expect(() => planLaunchAllocations({ ...base, totalSupply: 0n })).toThrow(/must be positive/);
  });

  it('always leaves the curve at least the unallocated share, however small the supply', () => {
    // The empty-curve guard in the planner is unreachable under today's
    // constants — the four shares are floored and sum to at most 75%, so
    // the remainder is never below a quarter of the supply. Rather than
    // write a rejection test that cannot fire, assert the property that
    // makes it unreachable, so raising a constant past the point where it
    // stops holding fails here.
    for (const totalSupply of [1n, 3n, 7n, 99n, 100n, 101n, SUPPLY]) {
      const plan = planLaunchAllocations({
        totalSupply,
        tier: 'C',
        creatorPercent: CREATOR_ALLOC_MAX_PCT,
        darkVeilPercent: DV_ALLOC_MAX_PCT,
        stakingEnabled: true,
      });
      expect(plan.curveSupply).toBeGreaterThanOrEqual((totalSupply * 25n) / 100n);
      expect(plan.curveSupply).toBeGreaterThan(0n);
    }
  });
});

describe('assertSupplyConserved — for figures that did not come from the planner', () => {
  const good: LaunchAllocation = planLaunchAllocations({
    totalSupply: SUPPLY,
    tier: 'B',
    creatorPercent: 8n,
    darkVeilPercent: 15n,
    stakingEnabled: false,
  });

  it('accepts a real plan', () => {
    expect(() => assertSupplyConserved(good)).not.toThrow();
  });

  it('rejects a set promising more than the launch has', () => {
    // One contract deployed with a larger allocation than it was planned
    // with — individually plausible, and invisible to every contract.
    expect(() => assertSupplyConserved({ ...good, creatorAllocation: good.creatorAllocation + 1n })).toThrow(
      /more than the launch supply/,
    );
  });

  it('rejects a set that leaves tokens unaccounted for', () => {
    expect(() => assertSupplyConserved({ ...good, curveSupply: good.curveSupply - 1n })).toThrow(
      /less than the launch supply/,
    );
  });

  it('rejects a negative allocation', () => {
    expect(() =>
      assertSupplyConserved({ ...good, stakingAllocation: -1n, curveSupply: good.curveSupply + 1n }),
    ).toThrow(/No allocation may be negative/);
  });

  it('rejects a launch with an empty curve, which could never graduate', () => {
    expect(() =>
      assertSupplyConserved({ ...good, lpReserve: good.lpReserve + good.curveSupply, curveSupply: 0n }),
    ).toThrow(/never graduate/);
  });
});

describe('creatorVestingRequirement — a bigger allocation is paid for in time', () => {
  it('the bands tile every permitted allocation, with no gap and no overlap', () => {
    // The guard that actually matters. Any single boundary can be read two
    // ways by whoever edits it next; this fails the moment one of them moves
    // and leaves a percentage nothing covers, or two bands claiming the same
    // one.
    const seen = new Map<bigint, bigint>();
    for (const band of VESTING_FLOOR_BANDS) {
      expect(band.minPercentInclusive).toBeLessThanOrEqual(band.maxPercentInclusive);
      for (let p = band.minPercentInclusive; p <= band.maxPercentInclusive; p++) {
        expect(seen.has(p)).toBe(false); // no overlap
        seen.set(p, band.floorDays);
      }
    }
    for (let p = 0n; p <= CREATOR_ALLOC_MAX_PCT; p++) {
      expect(seen.has(p)).toBe(true); // no gap
    }
    expect(seen.size).toBe(Number(CREATOR_ALLOC_MAX_PCT) + 1);
  });

  it('puts each boundary percentage in the band the rule names', () => {
    // Written out rather than looped, because these six values ARE the rule:
    // under 5 is 90 days, 5 through 8 is 180, above 8 is 365.
    expect(creatorVestingRequirement(1n).floorDays).toBe(90n);
    expect(creatorVestingRequirement(4n).floorDays).toBe(90n);
    expect(creatorVestingRequirement(5n).floorDays).toBe(180n);
    expect(creatorVestingRequirement(8n).floorDays).toBe(180n);
    expect(creatorVestingRequirement(9n).floorDays).toBe(365n);
    expect(creatorVestingRequirement(10n).floorDays).toBe(365n);
  });

  it('asks nothing of a creator taking no allocation', () => {
    const none = creatorVestingRequirement(0n);
    expect(none.required).toBe(false);
    expect(none.floorDays).toBeUndefined();
  });

  it('leaves the creator a real choice above every floor', () => {
    // A floor narrows the range; it does not fill it in. Principle #6 -- no
    // default, forced active selection -- survives this change, and would not
    // if any band's floor equalled the maximum for an allocation the wizard
    // permits below the top of the scale.
    for (let p = 1n; p < CREATOR_ALLOC_MAX_PCT; p++) {
      const req = creatorVestingRequirement(p);
      expect(req.maxDays).toBe(VESTING_MAX_DAYS);
      expect(req.floorDays).toBeGreaterThanOrEqual(VESTING_MIN_DAYS);
      expect(req.floorDays).toBeLessThanOrEqual(VESTING_MAX_DAYS);
    }
  });

  it('refuses an allocation no band covers rather than falling through to one', () => {
    expect(() => creatorVestingRequirement(11n)).toThrow(/0-10/);
    expect(() => creatorVestingRequirement(-1n)).toThrow(/0-10/);
  });
});
