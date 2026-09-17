// Tests for darkveil-bond-pricing.ts — the deploy-side pricing of the DarkVeil
// bond. The oracle is mocked so these assert this module's own decisions
// (refuse a spot reading, refuse a figure far from the rate, price when asked)
// rather than re-testing the price path, which has its own tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../night-price-oracle.js', () => ({ usdToMinNightAtomic: vi.fn() }));

import {
  assertBondMatchesSpot,
  bondDivergenceBps,
  MIN_TWAP_SAMPLES,
  NIGHT_BOND_USD,
  priceDarkVeilBond,
  resolveDarkVeilBond,
} from '../darkveil-bond-pricing.js';
import { usdToMinNightAtomic } from '../night-price-oracle.js';

/** A quote shaped like the real one. 2_401_346_105 atomic is $50 at the rate measured 2026-09-17. */
function quoteOf(minNightAtomic: bigint, twapSamplesUsed = 8) {
  return {
    minNightAtomic,
    nightUsdApprox: 0.0208216,
    sources: ['coingecko', 'kraken', 'coinbase'],
    twapSamplesUsed,
  };
}

const SPOT_50_USD = 2_401_346_105n;

beforeEach(() => {
  vi.mocked(usdToMinNightAtomic).mockReset();
});

describe('priceDarkVeilBond', () => {
  it('prices the bond at NIGHT_BOND_USD by default and carries the quote that justified it', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(SPOT_50_USD));

    const priced = await priceDarkVeilBond(undefined, 1_700_000_000_000);

    expect(usdToMinNightAtomic).toHaveBeenCalledWith(50);
    expect(NIGHT_BOND_USD).toBe(50);
    expect(priced.bondAmount).toBe(SPOT_50_USD);
    expect(priced.usd).toBe(50);
    expect(priced.twapSamplesUsed).toBe(8);
    expect(priced.quotedAtMs).toBe(1_700_000_000_000);
  });

  // The window exists so the price is an average; accepting a one-sample quote
  // would hand back exactly the spot reading the window was widened to avoid.
  it('refuses a quote drawn from a single sample, however the window is labelled', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(SPOT_50_USD, 1));

    await expect(priceDarkVeilBond()).rejects.toThrow(/1 sample\(s\), below the 2 needed/);
    expect(MIN_TWAP_SAMPLES).toBe(2);
  });

  it('accepts the minimum sample count rather than only the default eight', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(SPOT_50_USD, 2));
    await expect(priceDarkVeilBond()).resolves.toMatchObject({ twapSamplesUsed: 2 });
  });

  it('refuses a zero price rather than sealing a bond nobody pays', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(0n));
    await expect(priceDarkVeilBond()).rejects.toThrow(/zero atomic NIGHT/);
  });

  it('refuses a non-positive USD value', async () => {
    await expect(priceDarkVeilBond(0)).rejects.toThrow(/positive number/);
    await expect(priceDarkVeilBond(Number.NaN)).rejects.toThrow(/positive number/);
  });
});

describe('bondDivergenceBps', () => {
  it('measures divergence in basis points of the spot figure, in both directions', () => {
    expect(bondDivergenceBps(1000n, 1000n)).toBe(0n);
    expect(bondDivergenceBps(1100n, 1000n)).toBe(1000n); // 10% high
    expect(bondDivergenceBps(900n, 1000n)).toBe(1000n); // 10% low
    expect(bondDivergenceBps(1n, 1000n)).toBe(9990n);
  });

  it('refuses to measure against a zero spot', () => {
    expect(() => bondDivergenceBps(1n, 0n)).toThrow(/zero spot bond/);
  });
});

describe('assertBondMatchesSpot', () => {
  const priced = {
    bondAmount: 1000n,
    usd: 50,
    nightUsdApprox: 0.02,
    twapSamplesUsed: 8,
    sources: ['kraken'],
    quotedAtMs: 0,
  };

  it('accepts a figure inside the tolerance, at the boundary included', () => {
    expect(() => assertBondMatchesSpot(1000n, priced)).not.toThrow();
    expect(() => assertBondMatchesSpot(1100n, priced)).not.toThrow(); // exactly 1000 bps
    expect(() => assertBondMatchesSpot(900n, priced)).not.toThrow();
  });

  it('refuses a figure outside the tolerance', () => {
    expect(() => assertBondMatchesSpot(1101n, priced)).toThrow(/bps apart/);
  });

  it('honours a caller-supplied tolerance', () => {
    expect(() => assertBondMatchesSpot(1050n, priced, 100n)).toThrow(/tolerance 100/);
    expect(() => assertBondMatchesSpot(1050n, priced, 600n)).not.toThrow();
  });

  // The case this whole module exists for: the figure actually sealed into the
  // deployed Preprod gate, against the real rate. It must be refused, and the
  // message must say by what multiple — at this scale a bps figure alone reads
  // as noise rather than as two orders of magnitude.
  it('refuses the deployed 10 NIGHT figure and names the multiple', () => {
    const real = { ...priced, bondAmount: SPOT_50_USD };
    expect(() => assertBondMatchesSpot(10_000_000n, real)).toThrow(/240\.1x too low/);
  });

  it('names the multiple in the other direction too', () => {
    expect(() => assertBondMatchesSpot(5000n, priced)).toThrow(/5\.0x too high/);
  });
});

describe('resolveDarkVeilBond', () => {
  it('prices the bond when the caller names none', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(SPOT_50_USD));

    for (const absent of [undefined, null, '']) {
      const r = await resolveDarkVeilBond(absent as undefined);
      expect(r.bondAmount).toBe(SPOT_50_USD);
      expect(r.wasSupplied).toBe(false);
    }
  });

  it('keeps a supplied figure that agrees with the rate, and marks it supplied', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(1000n));

    const r = await resolveDarkVeilBond('1050');
    expect(r.bondAmount).toBe(1050n);
    expect(r.wasSupplied).toBe(true);
    expect(r.quote.bondAmount).toBe(1000n);
  });

  it('refuses a supplied figure that disagrees with the rate', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(SPOT_50_USD));
    await expect(resolveDarkVeilBond(10_000_000n)).rejects.toThrow(/too low/);
  });

  it('refuses a supplied figure that is not an integer, or is not positive', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(1000n));
    await expect(resolveDarkVeilBond('not-a-number')).rejects.toThrow(/integer number of atomic NIGHT/);
    await expect(resolveDarkVeilBond(0n)).rejects.toThrow(/greater than 0/);
  });

  // A supplied figure must not be able to skip the sample-count floor by
  // arriving already-decided — the quote is still fetched and still checked.
  it('still refuses a one-sample quote even when the caller supplied the figure', async () => {
    vi.mocked(usdToMinNightAtomic).mockResolvedValue(quoteOf(1000n, 1));
    await expect(resolveDarkVeilBond(1000n)).rejects.toThrow(/below the 2 needed/);
  });
});
