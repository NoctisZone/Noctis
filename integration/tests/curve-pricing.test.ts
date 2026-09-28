// Tests for curve-pricing.ts — the TypeScript mirror of what the two Cardano
// curve validators charge.
//
// Every expected value below is asserted by the validators' OWN Aiken tests
// against the same parameters (base=100, max=1000, curve_supply=1000). That is
// deliberate and it is the point of this file: the submitters build a
// transaction whose cost the contract then recomputes for itself, so the two
// implementations agreeing to the lovelace is what makes a transaction valid
// rather than rejected. A figure that drifts here is a launch that cannot
// trade, so these are cross-implementation checks, not arithmetic checks.

import { describe, expect, it } from 'vitest';
import {
  buyCost,
  CREATOR_BPS,
  type CurveParams,
  type CurveShape,
  feeSlice,
  feeSlices,
  PLATFORM_BPS,
  raiseShare,
  sellNet,
  sellProceeds,
  spotPrice,
} from '../curve-pricing.js';

const CURVE: CurveParams = { base_price: 100n, max_price: 1000n, curve_supply: 1000n };
/** Price range and supply share no common factor — the awkward case. */
const COPRIME: CurveParams = { base_price: 1n, max_price: 8n, curve_supply: 1000n };

/** Total proceeds from leaving a position in pieces, newest chunk first. */
function chunkedExit(shape: CurveShape, datum: CurveParams, start: bigint, chunks: bigint[]): bigint {
  let sold = start;
  let total = 0n;
  for (const n of chunks) {
    sold -= n;
    total += sellProceeds(shape, datum, sold, n);
  }
  return total;
}

describe('linear curve (the linear curve) — matches bonding_curve.ak to the lovelace', () => {
  const shape: CurveShape = 'linear';

  it('charges one token the price at its own position', () => {
    expect(buyCost(shape, CURVE, 0n, 1n)).toBe(100n);
    expect(buyCost(shape, CURVE, 500n, 1n)).toBe(550n);
    expect(spotPrice(shape, CURVE, 500n)).toBe(550n);
  });

  it('charges a whole curve the sum of every token price', () => {
    expect(buyCost(shape, CURVE, 0n, 1000n)).toBe(549_550n);
    expect(buyCost(shape, CURVE, 500n, 500n)).toBe(387_275n);
  });

  it('is additive over adjacent ranges', () => {
    expect(buyCost(shape, CURVE, 0n, 500n) + buyCost(shape, CURVE, 500n, 500n)).toBe(buyCost(shape, CURVE, 0n, 1000n));
  });

  it('rounds a fractional price up for a buyer and down for a seller', () => {
    // P(999) = 999.1
    expect(buyCost(shape, CURVE, 999n, 1n)).toBe(1000n);
    expect(sellProceeds(shape, CURVE, 999n, 1n)).toBe(999n);
  });

  it('prices partial trades on a curve whose range and supply share no factor', () => {
    expect(buyCost(shape, COPRIME, 0n, 1n)).toBe(1n);
    expect(buyCost(shape, COPRIME, 1n, 1n)).toBe(2n);
    expect(buyCost(shape, COPRIME, 0n, 1000n)).toBe(4_497n);
  });
});

describe('quadratic curve (Cardano Launch) — matches bonding_curve_tier_b.ak to the lovelace', () => {
  const shape: CurveShape = 'quadratic';

  it('charges one token the price at its own position', () => {
    expect(buyCost(shape, CURVE, 0n, 1n)).toBe(100n);
    expect(buyCost(shape, CURVE, 100n, 1n)).toBe(109n);
    expect(buyCost(shape, CURVE, 500n, 1n)).toBe(325n);
    expect(buyCost(shape, CURVE, 900n, 1n)).toBe(829n);
  });

  it('climbs slowly early and steeply late, unlike the linear curve', () => {
    expect(buyCost(shape, CURVE, 900n, 100n)).toBeGreaterThan(8n * buyCost(shape, CURVE, 0n, 100n));
    // and sits well below the linear curve at the same point
    expect(buyCost(shape, CURVE, 500n, 1n)).toBeLessThan(buyCost('linear', CURVE, 500n, 1n));
  });

  it('charges a whole curve the sum of every token price', () => {
    expect(buyCost(shape, CURVE, 0n, 1000n)).toBe(399_551n);
    expect(buyCost(shape, CURVE, 500n, 500n)).toBe(312_163n);
  });

  it('is additive over adjacent ranges', () => {
    expect(buyCost(shape, CURVE, 0n, 500n) + buyCost(shape, CURVE, 500n, 500n)).toBe(buyCost(shape, CURVE, 0n, 1000n));
  });

  it('rounds a fractional price up for a buyer and down for a seller', () => {
    // P(999) = 998.2009
    expect(buyCost(shape, CURVE, 999n, 1n)).toBe(999n);
    expect(sellProceeds(shape, CURVE, 999n, 1n)).toBe(998n);
  });

  it('prices partial trades on a curve whose range and supply share no factor', () => {
    expect(buyCost(shape, COPRIME, 0n, 1n)).toBe(1n);
    expect(buyCost(shape, COPRIME, 1n, 1n)).toBe(2n);
  });
});

describe('the property the economics rest on', () => {
  for (const shape of ['linear', 'quadratic'] as const) {
    it(`${shape}: leaving a position in pieces never beats leaving it in one lot`, () => {
      const single = sellProceeds(shape, CURVE, 0n, 1000n);
      for (const chunks of [
        [500n, 500n],
        [334n, 333n, 333n],
        [250n, 250n, 250n, 250n],
        [1n, 999n],
        [999n, 1n],
        [100n, 200n, 300n, 400n],
        Array.from({ length: 10 }, () => 100n),
      ]) {
        expect(chunkedExit(shape, CURVE, 1000n, chunks)).toBeLessThanOrEqual(single);
      }
    });

    it(`${shape}: a round trip never returns more than it cost`, () => {
      for (const [at, size] of [
        [0n, 1n],
        [400n, 100n],
        [999n, 1n],
        [0n, 1000n],
      ] as const) {
        expect(buyCost(shape, CURVE, at, size)).toBeGreaterThanOrEqual(sellProceeds(shape, CURVE, at, size));
      }
    });
  }
});

describe('fee slices', () => {
  it('take 1.5% between them on an amount that divides cleanly', () => {
    expect(feeSlice(100_000n, CREATOR_BPS)).toBe(500n);
    expect(feeSlice(100_000n, PLATFORM_BPS)).toBe(1_000n);
    expect(feeSlices(100_000n).feeTotal).toBe(1_500n);
  });

  it('floor independently, leaving the remainder with the curve', () => {
    const { creatorFee, platformFee, feeTotal } = feeSlices(999n);
    // The same figures bonding_curve.ak's own fee_slice test asserts.
    expect([creatorFee, platformFee]).toEqual([4n, 9n]);
    expect(feeTotal).toBe(13n); // against 14.985 at an exact 1.5%
  });

  it('take nothing from a trade too small to slice, rather than rounding up', () => {
    expect(feeSlices(31n).feeTotal).toBe(0n);
  });
});

describe('a sell pays its own fee', () => {
  // The figures bonding_curve_tier_b.ak's own sell tests pin: the raise gives
  // back 98.5% of a range's curve value, rounded down, and the seller keeps
  // that less the sell's 1.5%.
  it('gives the seller about 97% of the curve value', () => {
    expect(raiseShare(100_000n)).toBe(98_500n);
    expect(sellNet(100_000n)).toBe(97_000n);
  });

  it('matches the validator on the shares of its two-seller batch', () => {
    expect([raiseShare(68_605n), sellNet(68_605n)]).toEqual([67_575n, 66_546n]);
    expect([raiseShare(45_736n), sellNet(45_736n)]).toEqual([45_049n, 44_364n]);
  });

  it('never gives back more than a buy of the same value banked', () => {
    for (const gross of [1n, 67n, 99n, 199n, 200n, 201n, 999n, 68_605n, 114_342n]) {
      expect(raiseShare(gross)).toBeLessThanOrEqual(gross - feeSlices(gross).feeTotal);
    }
    // Where both fee slices floor to zero, a buy banks all of it and a sell
    // still gives back only 98.5% of it.
    expect(feeSlices(99n).feeTotal).toBe(0n);
    expect(raiseShare(99n)).toBe(97n);
    expect(sellNet(1n)).toBe(0n);
  });

  it('takes out no more when a sell is split than when it is whole', () => {
    expect(raiseShare(99n) + raiseShare(101n)).toBeLessThanOrEqual(raiseShare(200n));
    expect(raiseShare(67n) * 2n + raiseShare(66n)).toBeLessThanOrEqual(raiseShare(200n));
  });
});
