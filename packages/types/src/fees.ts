/**
 * The 1.5% total trade fee split, in basis points of {@link FEE_DENOMINATOR_BPS}.
 * Matches `bonding_curve.compact`'s `FeeConfig` literal (`creatorBps: 50`,
 * `platformBps: 100`) and both Cardano curves' `creator_bps`/`platform_bps`
 * constants. Identical across every launch type — only the currency differs
 * (ADA for a Cardano Launch, NIGHT for a Midnight Launch, see
 * {@link TradeCurrency}).
 *
 * The platform runs ONE wallet, so the platform share is one slice. There is
 * no treasury slice and no ops slice to divide it between.
 */
export const FEE_SPLIT_BPS = {
  creator: 50,
  platform: 100,
  total: 150,
} as const;

/**
 * `bonding_curve.compact`'s `verifyFeeSlice` checks
 * `claimedFee * FEE_DENOMINATOR_BPS == grossAmount * bps` — any caller
 * constructing a `claimedCreatorFee`/`claimedPlatformFee` argument for
 * `buyTokens` must use this exact denominator.
 */
export const FEE_DENOMINATOR_BPS = 10_000;

/** Cardano trade currency is ADA; Midnight Launch is NIGHT. Mirrors bonding_curve.compact's `Currency` enum. */
export type TradeCurrency = 'Ada' | 'Night';
