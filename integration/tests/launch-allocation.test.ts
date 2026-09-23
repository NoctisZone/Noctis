import { describe, expect, it } from 'vitest';
import {
  assertSupplyConserved,
  CREATOR_ALLOC_MAX_PCT,
  creatorVestingRequirement,
  DV_ALLOC_MAX_PCT,
  type LaunchAllocation,
  netRaiseAtSellThrough,
  POOL_OPEN_PRICE_PCT,
  planLaunchAllocations,
  STAKING_ALLOC_PCT,
  sizeLpReserve,
  TOTAL_SUPPLY_CAP,
  VESTING_FLOOR_BANDS,
  VESTING_MAX_DAYS,
  VESTING_MIN_DAYS,
} from '../launch-allocation.js';

const SUPPLY = TOTAL_SUPPLY_CAP;
// CLAUDE.md: CURVE_BASE_PRICE_LOVELACE / CURVE_MAX_PRICE_LOVELACE.
const PRICES = { basePrice: 3n, maxPrice: 75n };

/** The pool's opening price, in hundredths of a lovelace, from a plan's own figures. */
function openingPriceX100(plan: LaunchAllocation): bigint {
  return (netRaiseAtSellThrough(PRICES, plan.curveSupply, plan.dvAllocation) * 100n) / plan.lpReserve;
}

describe('planLaunchAllocations — the split is a partition', () => {
  it('every allocation set it produces sums to exactly the supply, with the DarkVeil reserve inside the curve', () => {
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
              ...PRICES,
            });
            expect(plan.lpReserve + plan.creatorAllocation + plan.stakingAllocation + plan.curveSupply).toBe(SUPPLY);
            expect(plan.dvAllocation).toBeLessThan(plan.curveSupply);
            expect(() => assertSupplyConserved(plan)).not.toThrow();
          }
        }
      }
    }
  });

  it('holds on a supply that divides badly, where the floors round away real tokens', () => {
    // 7 is chosen to make every percentage floor lose something. The curve
    // absorbs the remainder, which is the whole reason it is computed as one.
    const plan = planLaunchAllocations({
      totalSupply: 7n,
      tier: 'C',
      creatorPercent: 10n,
      darkVeilPercent: 20n,
      stakingEnabled: true,
      ...PRICES,
    });
    expect(plan.lpReserve + plan.creatorAllocation + plan.stakingAllocation + plan.curveSupply).toBe(7n);
    expect(plan).toMatchObject({ lpReserve: 1n, curveSupply: 5n, dvAllocation: 1n, stakingAllocation: 1n });
    expect(() => assertSupplyConserved(plan)).not.toThrow();
  });

  it('gives the curve and the reserve the staking share back when staking is declined', () => {
    const base = { totalSupply: SUPPLY, tier: 'B' as const, creatorPercent: 5n, darkVeilPercent: 15n, ...PRICES };
    const withStaking = planLaunchAllocations({ ...base, stakingEnabled: true });
    const without = planLaunchAllocations({ ...base, stakingEnabled: false });
    expect(withStaking.stakingAllocation).toBe((SUPPLY * STAKING_ALLOC_PCT) / 100n);
    expect(without.stakingAllocation).toBe(0n);
    // The share comes back to BOTH: a longer curve raises more, so the pool
    // that opens at the same price is deeper on both sides.
    expect(without.curveSupply).toBeGreaterThan(withStaking.curveSupply);
    expect(without.lpReserve).toBeGreaterThan(withStaking.lpReserve);
    expect(without.curveSupply + without.lpReserve - withStaking.curveSupply - withStaking.lpReserve).toBe(
      withStaking.stakingAllocation,
    );
  });
});

describe('planLaunchAllocations — the pool opens at the same price whatever the allocations', () => {
  it('opens at POOL_OPEN_PRICE_PCT of the graduation price at every corner of the permitted space', () => {
    const target = (POOL_OPEN_PRICE_PCT * PRICES.maxPrice * 100n) / 100n; // hundredths of a lovelace
    for (const creator of [0n, 5n, CREATOR_ALLOC_MAX_PCT]) {
      for (const darkVeilPercent of [10n, 15n, DV_ALLOC_MAX_PCT]) {
        for (const stakingEnabled of [false, true]) {
          const plan = planLaunchAllocations({
            totalSupply: SUPPLY,
            tier: 'B',
            creatorPercent: creator,
            darkVeilPercent,
            stakingEnabled,
            ...PRICES,
          });
          const opensAt = openingPriceX100(plan);
          // At the target, and never under it...
          expect(opensAt).toBeGreaterThanOrEqual(target);
          // ...by no more than one token's worth of rounding: one more token
          // in the reserve would take the pool under the target.
          const oneMore = { ...plan, lpReserve: plan.lpReserve + 1n, curveSupply: plan.curveSupply - 1n };
          expect(openingPriceX100(oneMore)).toBeLessThan(target);
        }
      }
    }
  });

  it('pins the reserve for the reference configurations', () => {
    // A staking launch with a 5% creator share and a 10% DarkVeil reserve
    // (the configuration a fixed 20% reserve opened BELOW graduation), and
    // the wizard's defaults. Pinned so a change to the arithmetic is seen.
    const staking = planLaunchAllocations({
      totalSupply: SUPPLY,
      tier: 'B',
      creatorPercent: 5n,
      darkVeilPercent: 10n,
      stakingEnabled: true,
      ...PRICES,
    });
    expect(staking.lpReserve).toBe(158_975_400n);
    expect(staking.curveSupply).toBe(541_024_600n);
    expect(netRaiseAtSellThrough(PRICES, staking.curveSupply, staking.dvAllocation)).toBe(14_307_786_016n);
    expect(openingPriceX100(staking)).toBe(9_000n); // 90 lovelace: 1.2 × 75

    const defaults = planLaunchAllocations({
      totalSupply: SUPPLY,
      tier: 'B',
      creatorPercent: 0n,
      darkVeilPercent: 15n,
      stakingEnabled: false,
      ...PRICES,
    });
    expect(defaults.lpReserve).toBe(226_952_198n);
    expect(defaults.curveSupply).toBe(773_047_802n);
    expect(openingPriceX100(defaults)).toBe(9_000n);
  });

  it('holds the target for other curve prices, not only the defaults', () => {
    for (const prices of [
      { basePrice: 1n, maxPrice: 100n },
      { basePrice: 10n, maxPrice: 40n },
      { basePrice: 3n, maxPrice: 750n },
    ]) {
      const sizing = sizeLpReserve(prices, SUPPLY - (SUPPLY * 30n) / 100n, (SUPPLY * 15n) / 100n);
      const opensAtX100 = (sizing.netRaise * 100n) / sizing.lpReserve;
      expect(opensAtX100).toBeGreaterThanOrEqual(POOL_OPEN_PRICE_PCT * prices.maxPrice);
      const oneMore = netRaiseAtSellThrough(prices, sizing.curveSupply - 1n, (SUPPLY * 15n) / 100n);
      expect((oneMore * 100n) / (sizing.lpReserve + 1n)).toBeLessThan(POOL_OPEN_PRICE_PCT * prices.maxPrice);
    }
  });
});

describe('netRaiseAtSellThrough — the floor of what graduation moves into the pool', () => {
  it('prices the DarkVeil reserve flat, the rest on the curve, and takes the running fee off', () => {
    // Five tokens, one reserved. The reserve pays 3; positions 1..4 pay
    // 3 + 72·s²/25, which sums to 98.4; 101.4 gross, 98.5% of it floored.
    expect(netRaiseAtSellThrough(PRICES, 5n, 1n)).toBe(99n);
  });

  it('refuses a reserve the curve cannot hold, and an empty curve', () => {
    expect(() => netRaiseAtSellThrough(PRICES, 5n, 6n)).toThrow(/must fit inside the curve/);
    expect(() => netRaiseAtSellThrough(PRICES, 0n, 0n)).toThrow(/raises nothing/);
  });
});

describe('sizeLpReserve — refuses what cannot open at the target', () => {
  it('refuses a supply too small to carry a curve and a pool', () => {
    expect(() => sizeLpReserve(PRICES, 4n, 0n)).toThrow(/cannot carry a curve/);
    expect(() => sizeLpReserve(PRICES, 2n, 1n)).toThrow(/cannot carry a curve/);
  });

  it('refuses prices that do not rise, and a non-positive target', () => {
    expect(() => sizeLpReserve({ basePrice: 75n, maxPrice: 75n }, SUPPLY, 0n)).toThrow(/must rise/);
    expect(() => sizeLpReserve(PRICES, SUPPLY, 0n, 0n)).toThrow(/positive percentage/);
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
        ...PRICES,
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
          ...PRICES,
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
        ...PRICES,
      }),
    ).toThrow(/the linear curve has no DarkVeil phase/);
  });

  it('rejects a DarkVeil tier that allocates nothing to the phase', () => {
    expect(() =>
      planLaunchAllocations({ totalSupply: SUPPLY, tier: 'C', creatorPercent: 5n, stakingEnabled: false, ...PRICES }),
    ).toThrow(/must allocate to it/);
  });

  it('rejects a supply above the platform cap, and a non-positive one', () => {
    const base = { tier: 'A' as const, creatorPercent: 5n, stakingEnabled: false, ...PRICES };
    expect(() => planLaunchAllocations({ ...base, totalSupply: TOTAL_SUPPLY_CAP + 1n })).toThrow(
      /exceeds the platform cap/,
    );
    expect(() => planLaunchAllocations({ ...base, totalSupply: 0n })).toThrow(/must be positive/);
  });

  it('leaves the curve a real public share at every allocation simultaneously maxed', () => {
    // The largest creator share, the largest DarkVeil reserve and the staking
    // pool together: the curve still runs past its reserve, and the pool
    // still opens at the target.
    const plan = planLaunchAllocations({
      totalSupply: SUPPLY,
      tier: 'C',
      creatorPercent: CREATOR_ALLOC_MAX_PCT,
      darkVeilPercent: DV_ALLOC_MAX_PCT,
      stakingEnabled: true,
      ...PRICES,
    });
    expect(plan.curveSupply - plan.dvAllocation).toBeGreaterThan(SUPPLY / 4n);
    expect(plan.lpReserve).toBe(141_978_393n);
    expect(openingPriceX100(plan)).toBe(9_000n);
  });
});

describe('assertSupplyConserved — for figures that did not come from the planner', () => {
  const good: LaunchAllocation = planLaunchAllocations({
    totalSupply: SUPPLY,
    tier: 'B',
    creatorPercent: 8n,
    darkVeilPercent: 15n,
    stakingEnabled: false,
    ...PRICES,
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

  it('rejects a set that leaves part of the supply unaccounted for', () => {
    expect(() => assertSupplyConserved({ ...good, lpReserve: good.lpReserve - 1n })).toThrow(
      /less than the launch supply/,
    );
  });

  it('rejects a negative allocation', () => {
    expect(() =>
      assertSupplyConserved({
        ...good,
        stakingAllocation: -1n,
        curveSupply: good.curveSupply + 1n,
      }),
    ).toThrow(/negative/);
  });

  it('rejects a launch with an empty curve, which could never graduate', () => {
    expect(() =>
      assertSupplyConserved({ ...good, lpReserve: good.lpReserve + good.curveSupply, curveSupply: 0n }),
    ).toThrow(/never graduate/);
  });

  it('rejects a DarkVeil reserve that swallows the curve, and a pool with no token side', () => {
    expect(() => assertSupplyConserved({ ...good, dvAllocation: good.curveSupply })).toThrow(
      /must leave it tokens to sell publicly/,
    );
    expect(() =>
      assertSupplyConserved({ ...good, lpReserve: 0n, curveSupply: good.curveSupply + good.lpReserve }),
    ).toThrow(/no token side/);
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
