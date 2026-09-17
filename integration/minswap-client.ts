// ============================================================================
// Noctis Zone — Minswap NIGHT/ADA TWAP Client (eligibility check #2 / Oracle Strategy)
// ============================================================================
//
// Minswap has a real, live NIGHT-ADA pool (confirmed 2026-07-13, ~$3.1M
// liquidity per GeckoTerminal/Minswap — well above CLAUDE.md's 5,000 ADA
// floor), but no native TWAP endpoint (checked docs.minswap.org/developer/
// minswap-apis — only price/candlestick and price/timeseries, both spot/
// historical snapshots). This computes a real TWAP client-side by averaging
// price points from the real `price/timeseries` endpoint.
//
// THE WINDOW IS FOUR HOURS BECAUSE OF THE FEED'S RESOLUTION, NOT BY TASTE.
// Measured against the live pool on 2026-09-17: `period=1d` returns 49
// points spanning 24 hours — 30-minute spacing — and it is the FINEST series
// on offer. `period=1h` and `period=6h` are rejected outright with HTTP 400
// (`FST_ERR_VALIDATION`); the only other accepted periods are `1w` (4-hour
// spacing) and `1M` (12-hour), both coarser. So a 30-minute averaging window
// holds ONE live point, and the default used to be 30 minutes: the result
// carried the name TWAP while being a single candle reading, which is exactly
// what a TWAP exists not to be. Four hours is the first window that averages a
// useful number of real points — eight against the live feed.
//
// (The window bound is inclusive, so a window spanning N intervals touches N+1
// points when they happen to align with the request time: nine rather than
// eight. Live points do not align, hence eight. Neither figure is load-bearing
// — what matters is that it averages at all.)
//
// What the window buys is the thing both callers actually need. The NIGHT
// price sets the DarkVeil bond, and the bond is the cost of a second DarkVeil
// identity; briefly pushing NIGHT up makes that identity cheaper. Averaging
// the window means the push has to be sustained for four hours rather than
// for one candle. Neither caller is a trading decision — the bond is priced
// once at deploy, and the eligibility check is a threshold — so the lag a
// longer window introduces costs them nothing.
//
// `samplesUsed` is returned for this reason: a caller that gets 1 back is
// being handed a spot price, whatever the window says, and should treat the
// figure with the suspicion that deserves.
//
// Price is scaled to a fixed-point BigInt immediately on receipt (rather
// than carrying JS floats through further arithmetic) — Minswap's own API
// only returns floats, so this can't eliminate float imprecision at the
// source, but it stops it from compounding through this module's own math.
// ============================================================================

const MINSWAP_API_BASE = 'https://api-mainnet-prod.minswap.org';

// NIGHT-ADA pool LP asset ID — confirmed live via GeckoTerminal/Minswap
// 2026-07-13 (https://minswap.org/pools/f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ce74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169).
export const NIGHT_ADA_POOL_ID =
  'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ce74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169';

// Fixed-point scale for the returned price: 10^12, matching the precision
// Minswap's floats already carry (their timeseries values commonly show
// ~14-17 significant digits) without pretending to more precision than the
// upstream float actually has.
const PRICE_SCALE = 1_000_000_000_000n;

/**
 * Default averaging window, in minutes. Four hours is eight points at the
 * feed's own 30-minute resolution; see the header for why a shorter window
 * cannot average more than one point however it is named.
 */
export const TWAP_WINDOW_MINUTES = 240;

/** The finest spacing the upstream feed offers, measured rather than assumed. */
export const FEED_RESOLUTION_MINUTES = 30;

interface TimeseriesPoint {
  value: number;
  timestamp: number;
}

export interface NightAdaTwapResult {
  /** NIGHT/ADA price, scaled by PRICE_SCALE (i.e. divide by PRICE_SCALE for the real ratio). */
  priceScaled: bigint;
  scale: bigint;
  /** How many real data points fell inside the TWAP window and were averaged. */
  samplesUsed: number;
  windowMinutes: number;
}

/**
 * Compute a real TWAP for the NIGHT-ADA pool by averaging every real
 * timeseries point whose timestamp falls within the window, ending at `now`.
 *
 * The default window is four hours, which is eight points at the feed's real
 * 30-minute resolution — see this module's header for why anything shorter
 * cannot average more than one. Callers may narrow it, and get `samplesUsed`
 * back so they can tell an average from a single reading.
 */
export async function getNightAdaTwap(
  windowMinutes = TWAP_WINDOW_MINUTES,
  now: number = Date.now(),
): Promise<NightAdaTwapResult> {
  const response = await fetch(`${MINSWAP_API_BASE}/v1/pools/${NIGHT_ADA_POOL_ID}/price/timeseries?period=1d`);
  if (!response.ok) {
    throw new Error(`Minswap timeseries request failed: ${response.status} ${await response.text()}`);
  }
  const points = (await response.json()) as TimeseriesPoint[];

  const cutoff = now - windowMinutes * 60 * 1000;
  const inWindow = points.filter((p) => p.timestamp >= cutoff && p.timestamp <= now);

  if (inWindow.length === 0) {
    throw new Error(
      `No Minswap price points found in the last ${windowMinutes} minutes — pool may be stale or illiquid`,
    );
  }

  // Scale each point to a BigInt before averaging so the summation itself
  // doesn't accumulate additional float error beyond what each point already carries.
  const scaledSum = inWindow.reduce((sum, p) => sum + BigInt(Math.round(p.value * Number(PRICE_SCALE))), 0n);
  const priceScaled = scaledSum / BigInt(inWindow.length);

  return {
    priceScaled,
    scale: PRICE_SCALE,
    samplesUsed: inWindow.length,
    windowMinutes,
  };
}
