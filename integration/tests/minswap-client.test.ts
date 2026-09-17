// Tests for minswap-client.ts's getNightAdaTwap — a real client-side TWAP
// computed by averaging Minswap's price/timeseries points, since Minswap has
// no native TWAP endpoint. The window is four hours because the feed's own
// resolution is 30 minutes, so anything narrower averages a single point.
// global.fetch is stubbed per-test; production code is untouched.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEED_RESOLUTION_MINUTES, getNightAdaTwap, NIGHT_ADA_POOL_ID, TWAP_WINDOW_MINUTES } from '../minswap-client.js';

function mockFetchJson(points: Array<{ value: number; timestamp: number }>, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(points),
    text: vi.fn().mockResolvedValue('error body'),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getNightAdaTwap', () => {
  it('requests the real NIGHT-ADA pool timeseries endpoint', async () => {
    const fetchMock = mockFetchJson([{ value: 0.5, timestamp: Date.now() }]);
    vi.stubGlobal('fetch', fetchMock);

    await getNightAdaTwap(30, Date.now());

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api-mainnet-prod.minswap.org/v1/pools/${NIGHT_ADA_POOL_ID}/price/timeseries?period=1d`,
    );
  });

  it('averages only the points whose timestamp falls within the window, ending at `now`', async () => {
    const now = 1_000_000_000;
    const windowMinutes = 30;
    const withinCutoff = now - windowMinutes * 60 * 1000;
    const points = [
      { value: 0.1, timestamp: withinCutoff - 1 }, // just outside window — excluded
      { value: 0.5, timestamp: withinCutoff }, // exactly at cutoff — included
      { value: 0.7, timestamp: now - 1000 }, // inside — included
      { value: 999, timestamp: now + 1 }, // in the future — excluded
    ];
    vi.stubGlobal('fetch', mockFetchJson(points));

    const result = await getNightAdaTwap(windowMinutes, now);

    // Average of 0.5 and 0.7 = 0.6, scaled by PRICE_SCALE (10^12)
    expect(result.priceScaled).toBe(600_000_000_000n);
    expect(result.scale).toBe(1_000_000_000_000n);
    expect(result.samplesUsed).toBe(2);
    expect(result.windowMinutes).toBe(30);
  });

  it('defaults windowMinutes to four hours and now to the current time', async () => {
    const fetchMock = mockFetchJson([{ value: 1, timestamp: Date.now() }]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await getNightAdaTwap();
    expect(result.windowMinutes).toBe(240);
    expect(TWAP_WINDOW_MINUTES).toBe(240);
    expect(result.samplesUsed).toBe(1);
  });

  // The window is only defensible in terms of the feed's real spacing, so the
  // relationship is what gets pinned rather than the number on its own. The
  // old 30-minute default admitted exactly one point at this spacing, which is
  // a spot price wearing a TWAP's name; these two cases fail if either the
  // constant or the measured resolution is changed without the other.
  it('admits nine aligned points at the feed resolution, where a 30-minute window admits one', async () => {
    const now = 1_000_000_000;
    const points = Array.from({ length: 48 }, (_, i) => ({
      value: 0.5,
      timestamp: now - i * FEED_RESOLUTION_MINUTES * 60 * 1000,
    }));
    vi.stubGlobal('fetch', mockFetchJson(points));

    // The cutoff is inclusive (see the boundary case above), so with points
    // aligned to `now` a window spanning N intervals touches N+1 endpoints:
    // nine here, and two for a single-interval window. Against the live feed
    // the counts are eight and one, because real points are not aligned to the
    // moment the request is made. Either way the ratio is the point — the wide
    // window averages, and the narrow one cannot.
    const wide = await getNightAdaTwap(TWAP_WINDOW_MINUTES, now);
    expect(wide.samplesUsed).toBe(9);

    vi.stubGlobal('fetch', mockFetchJson(points));
    const narrow = await getNightAdaTwap(FEED_RESOLUTION_MINUTES, now);
    expect(narrow.samplesUsed).toBe(2);
  });

  it('averages across the window rather than returning the newest point', async () => {
    const now = 1_000_000_000;
    // Eight points inside the window, one of them a spike. A single-sample
    // read would return the spike; an average must not.
    const points = [
      { value: 9, timestamp: now - 1 },
      ...Array.from({ length: 7 }, (_, i) => ({
        value: 2,
        timestamp: now - (i + 1) * FEED_RESOLUTION_MINUTES * 60 * 1000,
      })),
    ];
    vi.stubGlobal('fetch', mockFetchJson(points));

    const result = await getNightAdaTwap(TWAP_WINDOW_MINUTES, now);
    expect(result.samplesUsed).toBe(8);
    // (9 + 2*7) / 8 = 2.875 — not 9, and not 2.
    expect(result.priceScaled).toBe(2_875_000_000_000n);
  });

  it('throws when the Minswap request itself fails (non-ok response)', async () => {
    vi.stubGlobal('fetch', mockFetchJson([], false, 503));
    await expect(getNightAdaTwap(30, Date.now())).rejects.toThrow(/Minswap timeseries request failed: 503/);
  });

  it('throws when no points fall inside the window (stale/illiquid pool), rather than returning NaN/0 silently', async () => {
    const now = 1_000_000_000;
    vi.stubGlobal('fetch', mockFetchJson([{ value: 0.5, timestamp: now - 999_999_999 }]));
    await expect(getNightAdaTwap(30, now)).rejects.toThrow(/No Minswap price points found in the last 30 minutes/);
  });

  it('scales each point to a BigInt before summing, avoiding float accumulation error across many points', async () => {
    const now = 1_000_000_000;
    // 100 points all at the same value — average must equal that value exactly, not drift from repeated float addition.
    const points = Array.from({ length: 100 }, () => ({
      value: 0.123456789,
      timestamp: now - 1,
    }));
    vi.stubGlobal('fetch', mockFetchJson(points));

    const result = await getNightAdaTwap(30, now);
    expect(result.priceScaled).toBe(123_456_789_000n); // 0.123456789 * 10^12
    expect(result.samplesUsed).toBe(100);
  });
});
