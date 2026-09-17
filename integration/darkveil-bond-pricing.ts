// ============================================================================
// Noctis Zone — pricing the DarkVeil bond at deploy
// ============================================================================
//
// `NIGHT_BOND_USD` is $50, and the bond is what a second DarkVeil identity
// costs. The 5% cap binds one wallet key, and nothing on chain can tell two
// keys from two people — what differs is the PRICE of the second key, and the
// bond is most of that price. So the figure sealed into a launch is not a
// display detail; it is the anti-sybil parameter itself, and a bond priced
// from a stale guess is a cap that does not bind.
//
// THE CONVERSION HAPPENS EXACTLY ONCE, AT DEPLOY. This is the part that is
// easy to get wrong in a way that only shows up in production. The bond is
// SEALED at deploy and PAID at registration, and those are up to 48 hours
// apart with NIGHT moving in between. If the deploy prices $50 at spot and the
// registration path ALSO prices $50 at spot, the two figures will differ and
// the contract's own payment enforcement will reject every registration. So
// this module is for the deploy side only. Registration must read the sealed
// amount back and pay that — see `readSealedBondAmount` in the registration
// flow, which is the only supported way to learn it.
//
// A hand-typed bond is still accepted, because a deploy may legitimately want
// to name its own figure, but it is checked against spot and refused if it
// disagrees beyond a stated tolerance. That check is what would have caught
// the deployed Preprod value: 10 NIGHT, which was reasoned as "$50 if NIGHT is
// $5" and is short by more than two orders of magnitude at the real price.
// ============================================================================

import { type NightUsdThresholdResult, usdToMinNightAtomic } from './night-price-oracle.js';

/** CLAUDE.md's `NIGHT_BOND_USD`: the USD value a DarkVeil registration bonds. */
export const NIGHT_BOND_USD = 50;

/**
 * How far a caller-supplied bond may sit from spot before it is refused, in
 * basis points. Ten percent is wide enough that ordinary movement between
 * quoting a figure and submitting the deploy does not trip it, and narrow
 * enough that an order-of-magnitude error cannot pass.
 */
export const BOND_SPOT_TOLERANCE_BPS = 1000n;

/**
 * The fewest price samples this will price a bond from.
 *
 * A single sample is a spot reading whatever window it is labelled with, and
 * the bond is precisely the value an attacker gains by moving the price. The
 * feed's own resolution is 30 minutes, so the default window averages eight
 * points; anything that arrives with fewer than two has degraded to a spot
 * read, and pricing an anti-sybil parameter from one is refused rather than
 * silently accepted.
 */
export const MIN_TWAP_SAMPLES = 2;

export interface PricedBond {
  /** Atomic NIGHT (STAR) units to seal as the launch's `bondAmount`. */
  bondAmount: bigint;
  /** What the quote was worth in USD — echoed so a record can carry both. */
  usd: number;
  nightUsdApprox: number;
  twapSamplesUsed: number;
  sources: string[];
  /** When this was quoted, so a record can show its own age. */
  quotedAtMs: number;
}

/**
 * Price the DarkVeil bond at the current NIGHT/USD rate.
 *
 * Throws rather than returning a degraded figure: the oracle path itself
 * throws if either real source is unavailable, and this refuses a quote drawn
 * from too few samples to be an average.
 */
export async function priceDarkVeilBond(usd: number = NIGHT_BOND_USD, now: number = Date.now()): Promise<PricedBond> {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`DarkVeil bond USD value must be a positive number, got ${JSON.stringify(usd)}`);
  }
  const quote: NightUsdThresholdResult = await usdToMinNightAtomic(usd);
  assertQuoteIsAnAverage(quote);
  if (quote.minNightAtomic <= 0n) {
    throw new Error('Priced the DarkVeil bond at zero atomic NIGHT — refusing to seal a bond nobody pays.');
  }
  return {
    bondAmount: quote.minNightAtomic,
    usd,
    nightUsdApprox: quote.nightUsdApprox,
    twapSamplesUsed: quote.twapSamplesUsed,
    sources: quote.sources,
    quotedAtMs: now,
  };
}

/** Refuses a quote that averaged too few points to be worth the name. */
export function assertQuoteIsAnAverage(quote: Pick<NightUsdThresholdResult, 'twapSamplesUsed'>): void {
  if (quote.twapSamplesUsed < MIN_TWAP_SAMPLES) {
    throw new Error(
      `The NIGHT price came back with ${quote.twapSamplesUsed} sample(s), below the ${MIN_TWAP_SAMPLES} needed ` +
        'for an average. A single sample is a spot price whatever window it is labelled with, and the bond is ' +
        'the cost of a second DarkVeil identity — refusing to price it from one reading.',
    );
  }
}

/** How far apart two bond figures are, in basis points of the spot figure. */
export function bondDivergenceBps(supplied: bigint, spot: bigint): bigint {
  if (spot <= 0n) {
    throw new Error('Cannot measure divergence against a zero spot bond.');
  }
  const diff = supplied > spot ? supplied - spot : spot - supplied;
  return (diff * 10_000n) / spot;
}

/**
 * Holds a caller-supplied bond to the current rate.
 *
 * The message names both figures and the multiple between them, because the
 * failure this exists to catch is an order-of-magnitude one and a percentage
 * alone reads as noise at that scale.
 */
export function assertBondMatchesSpot(
  supplied: bigint,
  priced: PricedBond,
  toleranceBps: bigint = BOND_SPOT_TOLERANCE_BPS,
): void {
  const bps = bondDivergenceBps(supplied, priced.bondAmount);
  if (bps <= toleranceBps) {
    return;
  }
  const asNight = (v: bigint) => (Number(v) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
  const multiple =
    supplied > priced.bondAmount
      ? `${(Number(supplied) / Number(priced.bondAmount)).toFixed(1)}x too high`
      : `${(Number(priced.bondAmount) / Number(supplied)).toFixed(1)}x too low`;
  throw new Error(
    `The supplied bondAmount is ${multiple} against the current rate — ${bps} bps apart, tolerance ${toleranceBps}. ` +
      `Supplied ${supplied} atomic (${asNight(supplied)} NIGHT); $${priced.usd} is ${priced.bondAmount} atomic ` +
      `(${asNight(priced.bondAmount)} NIGHT) at $${priced.nightUsdApprox.toPrecision(4)}/NIGHT, averaged over ` +
      `${priced.twapSamplesUsed} samples. The bond is the cost of a second DarkVeil identity and is sealed for the ` +
      'life of the launch, so a figure this far from the rate is refused at deploy rather than discovered later. ' +
      'Omit bondAmount to seal the priced figure, or pass the figure you mean.',
  );
}

/**
 * The deploy-side entry point: returns the bond to seal, whether or not the
 * caller named one.
 *
 * Omitting `supplied` prices it. Supplying it holds that figure to the rate.
 * Either way the returned `PricedBond` carries the quote that justified it, so
 * the launch record can keep the reasoning alongside the number.
 */
export async function resolveDarkVeilBond(
  supplied?: bigint | string | number | null,
  usd: number = NIGHT_BOND_USD,
  toleranceBps: bigint | string | number = BOND_SPOT_TOLERANCE_BPS,
): Promise<{ bondAmount: bigint; quote: PricedBond; wasSupplied: boolean }> {
  const quote = await priceDarkVeilBond(usd);
  if (supplied === undefined || supplied === null || supplied === '') {
    return { bondAmount: quote.bondAmount, quote, wasSupplied: false };
  }
  let asBigInt: bigint;
  try {
    asBigInt = BigInt(supplied);
  } catch {
    throw new Error(`bondAmount must be an integer number of atomic NIGHT units, got ${JSON.stringify(supplied)}`);
  }
  if (asBigInt <= 0n) {
    throw new Error(`bondAmount must be greater than 0, got ${asBigInt}`);
  }
  let tolerance: bigint;
  try {
    tolerance = BigInt(toleranceBps);
  } catch {
    throw new Error(`bondToleranceBps must be an integer, got ${JSON.stringify(toleranceBps)}`);
  }
  if (tolerance < 0n) {
    throw new Error(`bondToleranceBps must not be negative, got ${tolerance}`);
  }
  assertBondMatchesSpot(asBigInt, quote, tolerance);
  return { bondAmount: asBigInt, quote, wasSupplied: true };
}
