/**
 * The 2.0% total trade fee split, in basis points of {@link FEE_DENOMINATOR_BPS}.
 * Matches bonding_curve.compact's `FeeConfig` literal (creatorBps: 100,
 * treasuryBps: 60, opsBps: 40, totalBps: 200) and CLAUDE.md's "FEE SPLIT"
 * table. Identical across all three tiers — only the currency differs
 * (ADA for A/B, NIGHT for C, see {@link TradeCurrency}).
 */
export const FEE_SPLIT_BPS = {
  creator: 100,
  treasury: 60,
  ops: 40,
  total: 200,
} as const;

/**
 * `bonding_curve.compact`'s `verifyFeeSlice` checks
 * `claimedFee * FEE_DENOMINATOR_BPS == grossAmount * bps` — any caller
 * constructing a `claimedCreatorFee`/`claimedTreasuryFee`/`claimedOpsFee`
 * argument for `buyTokens` must use this exact denominator.
 */
export const FEE_DENOMINATOR_BPS = 10_000;

/** Cardano trade currency is ADA; Midnight Launch is NIGHT. Mirrors bonding_curve.compact's `Currency` enum. */
export type TradeCurrency = 'Ada' | 'Night';
