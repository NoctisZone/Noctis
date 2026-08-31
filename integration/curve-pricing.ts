// ============================================================================
// Noctis Zone — bonding curve pricing
// ============================================================================
// The single TypeScript copy of what the two Cardano curve validators charge.
// `bonding_curve.ak` (the linear curve, linear) and `bonding_curve_tier_b.ak` (Cardano Launch,
// quadratic) each compute the price themselves from their own datum; nothing
// off-chain can propose a figure and have it accepted. So everything here is
// a MIRROR, and it has to agree with the validator to the lovelace — a
// mismatch is not a rounding nuisance, it is a transaction that fails.
//
// That is also why this module exists at all rather than the formula living
// in each submitter: the buy path, the sell path, the DarkVeil claim path and
// the trade-history reader all need the same arithmetic, and three copies of
// a formula that must match a fourth is how drift starts.
//
// THE MODEL
// A bonding curve sells DISCRETE tokens. Token `i` costs `P(i)`, so a batch
// costs the SUM of its members' prices — not one price applied across the
// batch. Summing is what makes cost additive over adjacent ranges:
//
//   sum[a,c) == sum[a,b) + sum[b,c)
//
// so the same tokens cost the same however a trade is split up. Price depends
// on position along the curve alone, and a buy and a sell of the same size at
// the same position quote the same range.
//
// ROUNDING
// Each range cost is returned as an unreduced (numerator, denominator) pair so
// the caller picks the direction: a buyer pays the ceiling, a seller receives
// the floor. Any integer remainder therefore resolves in the curve's favour,
// and a round trip is very slightly negative for the trader even before the
// 1.5% fee. All BigInt — no float ever touches a lovelace figure.
// ============================================================================

/** Mirrors both validators' `bps_denominator`. */
export const BPS_DENOMINATOR = 10_000n;

/** Mirrors both validators' creator_bps / platform_bps (1.5% total). The
 *  platform runs ONE wallet, so there is no treasury/ops pair here either. */
export const CREATOR_BPS = 50n;
export const PLATFORM_BPS = 100n;

/** The curve parameters both formulas need. Structurally satisfied by either
 *  tier's full datum type, so callers pass their datum directly. */
export interface CurveParams {
  base_price: bigint;
  max_price: bigint;
  curve_supply: bigint;
}

/** An unreduced range cost: `numerator / denominator` lovelace. */
export type RangeCost = readonly [numerator: bigint, denominator: bigint];

/**
 * One fee slice of `gross`, floored — mirrors both validators' `fee_slice`.
 * Flooring each independently means the two together take slightly less
 * than 1.5% of an amount that does not divide cleanly; the remainder stays
 * with the curve rather than being paid out twice.
 */
export function feeSlice(gross: bigint, bps: bigint): bigint {
  return (gross * bps) / BPS_DENOMINATOR;
}

/** Both slices and their total, in one call. */
export function feeSlices(gross: bigint): {
  creatorFee: bigint;
  platformFee: bigint;
  feeTotal: bigint;
} {
  const creatorFee = feeSlice(gross, CREATOR_BPS);
  const platformFee = feeSlice(gross, PLATFORM_BPS);
  return { creatorFee, platformFee, feeTotal: creatorFee + platformFee };
}

// ----------------------------------------------------------------------------
// The linear curve — linear, P(x) = base + (max - base) * x / supply
// ----------------------------------------------------------------------------

/**
 * Mirrors `bonding_curve.ak`'s `gross_range`. With `r = max - base` and
 * `S = supply`:
 *
 *   sum(s, n) = n*base + r*n*(2s + n - 1) / (2S)
 */
export function grossRangeLinear(datum: CurveParams, fromSold: bigint, amount: bigint): RangeCost {
  const priceRange = datum.max_price - datum.base_price;
  const numerator =
    2n * datum.curve_supply * amount * datum.base_price + priceRange * amount * (2n * fromSold + amount - 1n);
  return [numerator, 2n * datum.curve_supply];
}

// ----------------------------------------------------------------------------
// Cardano Launch — quadratic, P(x) = base + (max - base) * x^2 / supply^2
// ----------------------------------------------------------------------------

/** `m(m+1)(2m+1)`, six times the sum of squares up to m. `g(-1) === 0`, which
 *  is what lets a range starting at position 0 need no special case. */
function sumSquaresX6(m: bigint): bigint {
  return m * (m + 1n) * (2n * m + 1n);
}

/**
 * Mirrors `bonding_curve_tier_b.ak`'s `gross_range`. With `r = max - base`,
 * `S = supply` and `g(m) = m(m+1)(2m+1)`:
 *
 *   sum(s, n) = n*base + r * ( g(s+n-1) - g(s-1) ) / (6 * S^2)
 */
export function grossRangeQuadratic(datum: CurveParams, fromSold: bigint, amount: bigint): RangeCost {
  const priceRange = datum.max_price - datum.base_price;
  const supplySquared = datum.curve_supply * datum.curve_supply;
  const squareSum = sumSquaresX6(fromSold + amount - 1n) - sumSquaresX6(fromSold - 1n);
  const numerator = 6n * supplySquared * amount * datum.base_price + priceRange * squareSum;
  return [numerator, 6n * supplySquared];
}

// ----------------------------------------------------------------------------
// Rounding — the direction is named here, never chosen inside a range formula
// ----------------------------------------------------------------------------

/** Which curve shape a launch uses. */
export type CurveShape = 'linear' | 'quadratic';

export function grossRange(shape: CurveShape, datum: CurveParams, fromSold: bigint, amount: bigint): RangeCost {
  return shape === 'linear' ? grossRangeLinear(datum, fromSold, amount) : grossRangeQuadratic(datum, fromSold, amount);
}

/** What a buyer pays for `amount` tokens starting at `fromSold` — rounded UP,
 *  so a buyer never pays below the true sum. */
export function buyCost(shape: CurveShape, datum: CurveParams, fromSold: bigint, amount: bigint): bigint {
  const [numerator, denominator] = grossRange(shape, datum, fromSold, amount);
  return (numerator + denominator - 1n) / denominator;
}

/**
 * What a seller receives for `amount` tokens — rounded DOWN, so the curve
 * never pays out above the true sum. `fromSold` is the LOW edge of the range
 * being vacated (`tokens_sold - amount`), not the seller's current position.
 */
export function sellProceeds(shape: CurveShape, datum: CurveParams, fromSold: bigint, amount: bigint): bigint {
  const [numerator, denominator] = grossRange(shape, datum, fromSold, amount);
  return numerator / denominator;
}

/**
 * The spot price at a position — what the next single token costs, which is
 * what a price display should show. Distinct from `buyCost` for a batch:
 * every token in a batch is priced at its own position, so a batch is not
 * this number times the count.
 */
export function spotPrice(shape: CurveShape, datum: CurveParams, sold: bigint): bigint {
  return buyCost(shape, datum, sold, 1n);
}
