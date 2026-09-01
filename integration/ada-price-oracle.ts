// ============================================================================
// Noctis Zone — ADA/USD -> Lovelace Conversion
// ============================================================================
//
// Converts a USD amount into minimum lovelace, using Orcfax's real ADA/USD
// datum directly -- no Minswap triangulation needed (unlike
// night-price-oracle.ts's NIGHT/USD path, which has no direct feed and must
// triangulate through ADA). Used for Cardano's ADA-denominated STAKING_CLAIM_FEE_USD
// ($1 flat claim fee, CLAUDE.md's STAKING REWARDS section) -- Midnight Launch's
// equivalent fee is NIGHT-denominated and already covered by
// night-price-oracle.ts's usdToMinNightAtomic.
// ============================================================================

import { type AdaUsdPrice, getAdaUsdPrice } from './ada-usd-price.js';

export const LOVELACE_PER_ADA = 1_000_000n;

// Internal working precision for the USD -> lovelace conversion, kept as an
// integer scale throughout (no intermediate float division) except for the
// final display-only `adaUsdApprox` figure -- same discipline as
// night-price-oracle.ts's usdToMinNightAtomic.
const WORK_SCALE = 1_000_000_000_000_000_000n; // 10^18

export interface AdaUsdThresholdResult {
  /** Minimum lovelace needed to reach the USD amount. */
  minLovelace: bigint;
  /** Display-only approximate ADA/USD price (float, not used in the conversion itself). */
  adaUsdApprox: number;
  /** Orcfax datum's own validity timestamp -- compare against ORACLE_STALENESS_MIN (10 min). */
  /** Which price sources agreed on this figure. */
  sources: string[];
}

/**
 * Computes the minimum lovelace needed to be worth `usdAmount` USD, using a
 * real ADA/USD price. Throws rather than fabricating a value if the
 * real source is unavailable -- staleness itself is the caller's call
 * (ORACLE_STALENESS_MIN), this function surfaces `sources` for
 * that decision, same convention as usdToMinNightAtomic.
 */
export async function usdToMinAdaLovelace(usdAmount: number, price?: AdaUsdPrice): Promise<AdaUsdThresholdResult> {
  const adaUsd = price ?? (await getAdaUsdPrice());

  if (adaUsd.priceScaled === 0n) {
    throw new Error('ADA/USD price is zero — refusing to proceed with a divide-by-zero result');
  }

  // ADA_USD = adaUsd.priceScaled / adaUsd.scale
  // minAdaWhole = usdAmount / ADA_USD = usdAmount * adaUsd.scale / adaUsd.priceScaled
  const usdScaled = BigInt(Math.round(usdAmount * Number(WORK_SCALE)));
  const numerator = usdScaled * adaUsd.scale;
  const denominator = adaUsd.priceScaled;

  // Result is still scaled by WORK_SCALE and denominated in whole ADA;
  // convert to lovelace before removing the scale, so the final integer
  // division rounds at lovelace precision rather than whole-ADA precision.
  const minLovelaceScaled = (numerator * LOVELACE_PER_ADA) / denominator;
  const minLovelace = minLovelaceScaled / WORK_SCALE;

  return {
    minLovelace,
    adaUsdApprox: Number(adaUsd.priceScaled) / Number(adaUsd.scale),
    sources: adaUsd.sources,
  };
}
