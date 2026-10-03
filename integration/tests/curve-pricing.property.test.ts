// Properties of the curve and fee arithmetic, held over many generated inputs
// rather than a few chosen ones. The generator is seeded, so every run checks
// the same cases and a failure names the case that broke.
//
// Each property is one the validators rely on, stated as the guarantee the
// arithmetic makes: a range costs the same however it is split; rounding
// always resolves in the curve's favour; a round trip never profits; the fee
// slices and the raise's share never add up to more than the value they
// divide.

import { describe, expect, it } from 'vitest';
import {
  buyCost,
  CREATOR_BPS,
  type CurveParams,
  feeSlices,
  grossRangeQuadratic,
  PLATFORM_BPS,
  raiseShare,
  sellNet,
  sellProceeds,
  spotPrice,
} from '../curve-pricing.js';

const RUNS = 400;

/** A small seeded generator (mulberry32), so the cases are the same on every run. */
function generator(seed: number) {
  let a = seed >>> 0;
  const next32 = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  /** A bigint in [lo, hi], inclusive. */
  const between = (lo: bigint, hi: bigint): bigint => {
    const span = hi - lo + 1n;
    const raw = (BigInt(next32()) << 32n) | BigInt(next32());
    return lo + (raw % span);
  };
  return { between };
}

/** A curve within the platform's own bounds: base 1..10, max up to 100x it, supply up to 1B tokens. */
function curve(g: ReturnType<typeof generator>): CurveParams {
  const base_price = g.between(1n, 10n);
  return {
    base_price,
    max_price: g.between(base_price + 1n, base_price * 100n),
    curve_supply: g.between(1_000n, 1_000_000_000n),
  };
}

/** A start and a length that stay on the curve. */
function range(g: ReturnType<typeof generator>, c: CurveParams) {
  const fromSold = g.between(0n, c.curve_supply - 1n);
  const amount = g.between(1n, c.curve_supply - fromSold);
  return { fromSold, amount };
}

describe('the quadratic curve, over generated curves and ranges', () => {
  it('prices a range the same however it is split: the exact sums add', () => {
    const g = generator(1);
    for (let i = 0; i < RUNS; i++) {
      const c = curve(g);
      const { fromSold, amount } = range(g, c);
      if (amount < 2n) continue;
      const first = g.between(1n, amount - 1n);
      const [whole, d] = grossRangeQuadratic(c, fromSold, amount);
      const [left, d1] = grossRangeQuadratic(c, fromSold, first);
      const [right, d2] = grossRangeQuadratic(c, fromSold + first, amount - first);
      expect(d1).toBe(d);
      expect(d2).toBe(d);
      expect(left + right, `case ${i}`).toBe(whole);
    }
  });

  it('rounds a buy up and a sell down, never more than one lovelace apart', () => {
    const g = generator(2);
    for (let i = 0; i < RUNS; i++) {
      const c = curve(g);
      const { fromSold, amount } = range(g, c);
      const [n, d] = grossRangeQuadratic(c, fromSold, amount);
      const buy = buyCost('quadratic', c, fromSold, amount);
      const sell = sellProceeds('quadratic', c, fromSold, amount);
      expect(buy * d >= n, `case ${i}: a buyer pays at least the exact sum`).toBe(true);
      expect(sell * d <= n, `case ${i}: a seller receives at most the exact sum`).toBe(true);
      expect(buy - sell >= 0n && buy - sell <= 1n, `case ${i}`).toBe(true);
    }
  });

  it('charges a buy split in two at least the whole, and pays a split sell at most the whole', () => {
    const g = generator(3);
    for (let i = 0; i < RUNS; i++) {
      const c = curve(g);
      const { fromSold, amount } = range(g, c);
      if (amount < 2n) continue;
      const first = g.between(1n, amount - 1n);
      const split = (f: typeof buyCost) =>
        f('quadratic', c, fromSold, first) + f('quadratic', c, fromSold + first, amount - first);
      expect(split(buyCost) >= buyCost('quadratic', c, fromSold, amount), `case ${i}`).toBe(true);
      expect(split(sellProceeds) <= sellProceeds('quadratic', c, fromSold, amount), `case ${i}`).toBe(true);
    }
  });

  it('never lowers the price as the curve sells, and keeps it between the base and the maximum', () => {
    const g = generator(4);
    for (let i = 0; i < RUNS; i++) {
      const c = curve(g);
      const sold = g.between(0n, c.curve_supply - 2n);
      const here = spotPrice('quadratic', c, sold);
      expect(spotPrice('quadratic', c, sold + 1n) >= here, `case ${i}`).toBe(true);
      expect(here >= c.base_price && here <= c.max_price, `case ${i}`).toBe(true);
    }
  });

  it('never lets a round trip profit: a sell of a range returns less than a buy of it cost', () => {
    const g = generator(5);
    for (let i = 0; i < RUNS; i++) {
      const c = curve(g);
      const { fromSold, amount } = range(g, c);
      const paid = buyCost('quadratic', c, fromSold, amount);
      const back = sellNet(sellProceeds('quadratic', c, fromSold, amount));
      expect(back <= paid, `case ${i}`).toBe(true);
      // And the raise gives back no more than the buy banked.
      expect(raiseShare(sellProceeds('quadratic', c, fromSold, amount)) <= raiseShare(paid), `case ${i}`).toBe(true);
    }
  });
});

describe('the fee and raise split, over generated amounts', () => {
  it('takes each fee slice floored, so together they never exceed 1.5% and fall short by under two lovelace', () => {
    const g = generator(6);
    for (let i = 0; i < RUNS; i++) {
      const gross = g.between(0n, 10n ** 15n);
      const { creatorFee, platformFee, feeTotal } = feeSlices(gross);
      expect(creatorFee + platformFee).toBe(feeTotal);
      const exact = gross * (CREATOR_BPS + PLATFORM_BPS);
      expect(feeTotal * 10_000n <= exact, `case ${i}`).toBe(true);
      expect(exact - feeTotal * 10_000n < 2n * 10_000n, `case ${i}`).toBe(true);
    }
  });

  it('never divides a range value into more than it is: the raise share and both fees fit inside it', () => {
    const g = generator(7);
    for (let i = 0; i < RUNS; i++) {
      const gross = g.between(0n, 10n ** 15n);
      const { feeTotal } = feeSlices(gross);
      const share = raiseShare(gross);
      expect(share + feeTotal <= gross, `case ${i}`).toBe(true);
      // What rounding leaves over is dust, three lovelace at most.
      expect(gross - share - feeTotal < 3n, `case ${i}`).toBe(true);
      // A seller's net is the share less the sell's own fees, and never negative.
      expect(sellNet(gross)).toBe(share - feeTotal);
      expect(sellNet(gross) >= 0n, `case ${i}`).toBe(true);
    }
  });
});
