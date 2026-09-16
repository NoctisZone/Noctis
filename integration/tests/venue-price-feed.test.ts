// venue-price-feed.test.ts — does the feed say what the chain said?
//
// Three things this file exists to hold, because each one is silent when wrong:
//
//   ORDER. The walk runs backward off the chain and a chart runs forward. A
//   series that forgot to reverse looks completely normal — it just draws every
//   pool's life in reverse. So the fixture's three trades have strictly rising
//   timestamps and the assertions read them in order.
//
//   EXACTNESS. Prices are rationals because a validator compares integers. Two
//   prices that a float cannot tell apart are still two prices, and on a token
//   worth a small fraction of a lovelace that is most of them. The high/low
//   test below uses two prices that are equal as JS numbers and different as
//   rationals; comparing them as numbers passes every other test in this file
//   and fails that one.
//
//   RESERVES PER TRADE. The feed's whole reason to exist is that each trade
//   carries the reserves it left. They are netted — a swap's fee slices stay in
//   the pool and move to the counters — so the reserve moves by less than the
//   trader put in, and a test asserting the gross amount would be asserting a
//   number the chain never held.

import { describe, expect, it } from 'vitest';
import type { VenuePoolConfigData } from '../venue-pool.js';
import type { VenuePoolEvent, VenuePoolHistory, VenuePoolSnapshot } from '../venue-pool-history.js';
import {
  compareRates,
  type VenueBlockProvider,
  venueFeedIsComplete,
  venueOhlcBars,
  venueTradeSeries,
  venueVolumeByUnit,
} from '../venue-price-feed.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '0102030405060708091011121314151617181920212223242526272829303132'.slice(0, 62);
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN = `${TOKEN_POLICY}746f6b656e`;
const POOL_NFT = `${FACTORY}10${LAUNCH}`;

function datum(): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
    pool_lq: { policy: FACTORY, name: `11${LAUNCH}` },
    fee_num: 99_900n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(57),
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
  };
}

function snapshot(reservesX: bigint, reservesY: bigint): VenuePoolSnapshot {
  return {
    balanceX: reservesX,
    balanceY: reservesY,
    reservesX,
    reservesY,
    liquidity: 1_000_000n,
    datum: datum(),
  };
}

function swapEvent(args: {
  txHash: string;
  inUnit: string;
  outUnit: string;
  tradedIn: bigint;
  paidOut: bigint;
  reservesX: bigint;
  reservesY: bigint;
}): VenuePoolEvent {
  return {
    txHash: args.txHash,
    kind: 'swap',
    poolNft: POOL_NFT,
    after: snapshot(args.reservesX, args.reservesY),
    before: snapshot(0n, 0n),
    swap: {
      inputUnit: args.inUnit,
      outputUnit: args.outUnit,
      tradedIn: args.tradedIn,
      paidOut: args.paidOut,
    },
    accrued: { treasuryX: 0n, treasuryY: 0n, royaltyX: 0n, royaltyY: 0n },
  };
}

/** Newest first, exactly as the walk returns it. */
function history(events: VenuePoolEvent[], over: Partial<VenuePoolHistory> = {}): VenuePoolHistory {
  return { events, reachedGenesis: true, ...over };
}

const BLOCKS: Record<string, { height: number; timeSeconds: number }> = {
  tx1: { height: 100, timeSeconds: 1_000 },
  tx2: { height: 101, timeSeconds: 1_050 },
  tx3: { height: 102, timeSeconds: 5_000 },
};

const blocks: VenueBlockProvider = {
  getTxBlock: async (txHash) => {
    const stamp = BLOCKS[txHash];
    if (!stamp) throw new Error(`no block for ${txHash}`);
    return stamp;
  },
};

/** A buy, a sell, then a later buy. Given newest-first, as the walk gives it. */
function threeTrades(): VenuePoolHistory {
  return history([
    swapEvent({
      txHash: 'tx3',
      inUnit: 'lovelace',
      outUnit: TOKEN,
      tradedIn: 200_000_000n,
      paidOut: 1_800_000n,
      reservesX: 20_300_000_000n,
      reservesY: 196_200_000n,
    }),
    swapEvent({
      txHash: 'tx2',
      inUnit: TOKEN,
      outUnit: 'lovelace',
      tradedIn: 1_000_000n,
      paidOut: 99_000_000n,
      reservesX: 20_100_000_000n,
      reservesY: 198_000_000n,
    }),
    swapEvent({
      txHash: 'tx1',
      inUnit: 'lovelace',
      outUnit: TOKEN,
      tradedIn: 100_000_000n,
      paidOut: 990_000n,
      reservesX: 20_098_900_000n,
      reservesY: 199_010_000n,
    }),
  ]);
}

describe('venueTradeSeries', () => {
  it('returns trades oldest first, whatever order the walk gave them in', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    expect(series.map((t) => t.txHash)).toEqual(['tx1', 'tx2', 'tx3']);
    expect(series.map((t) => t.block.timeSeconds)).toEqual([1_000, 1_050, 5_000]);
  });

  it('names the side from the taker’s point of view', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    expect(series.map((t) => t.side)).toEqual(['buy', 'sell', 'buy']);
  });

  it('quotes every trade ada-over-token, whichever way it went', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    // Buy: 100 ADA for 990,000 tokens. Sell: 1,000,000 tokens for 99 ADA.
    // Both are ada/token, so they are directly comparable.
    expect(series[0].realised).toEqual({ num: 100_000_000n / 10_000n, denom: 990_000n / 10_000n });
    expect(compareRates(series[0].realised, { num: 100_000_000n, denom: 990_000n })).toBe(0);
    expect(compareRates(series[1].realised, { num: 99_000_000n, denom: 1_000_000n })).toBe(0);
  });

  it('carries the NETTED reserves each trade left, not the gross amounts', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    expect(series[0].reservesAfter).toEqual({
      unitX: 'lovelace',
      x: 20_098_900_000n,
      unitY: TOKEN,
      y: 199_010_000n,
    });
    // The trader put in 100 ADA; the reserve rose by 98.9 — the fee slices stayed
    // behind. Asserting 100 here would assert a number the pool never held.
    expect(series[0].reservesAfter.x - 20_000_000_000n).toBe(98_900_000n);
  });

  it('reduces a price to lowest terms so two equal prices compare equal', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    expect(series[0].realised.denom).toBeLessThan(990_000n);
  });
});

describe('compareRates', () => {
  it('separates two prices a float would call identical', () => {
    // Both are 1/3 to every decimal place a double can hold.
    const a = { num: 1n, denom: 3n };
    const b = { num: 1_000_000_000_000_000_001n, denom: 3_000_000_000_000_000_000n };
    expect(Number(a.num) / Number(a.denom)).toBe(Number(b.num) / Number(b.denom));
    expect(compareRates(a, b)).toBe(-1);
  });

  it('orders rationals correctly in both directions', () => {
    expect(compareRates({ num: 1n, denom: 2n }, { num: 1n, denom: 3n })).toBe(1);
    expect(compareRates({ num: 1n, denom: 3n }, { num: 1n, denom: 2n })).toBe(-1);
    expect(compareRates({ num: 2n, denom: 4n }, { num: 1n, denom: 2n })).toBe(0);
  });
});

describe('venueOhlcBars', () => {
  it('buckets by wall time, aligned to the epoch rather than to the first trade', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    const bars = venueOhlcBars(series, 3_600);
    // 1,000s and 1,050s fall in the bucket starting at 0; 5,000s in the one at 3,600.
    expect(bars.map((b) => b.startSeconds)).toEqual([0, 3_600]);
    expect(bars[0].trades).toBe(2);
    expect(bars[1].trades).toBe(1);
  });

  it('leaves an empty bucket out rather than carrying the last price forward', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    const bars = venueOhlcBars(series, 1_000);
    // Trades at 1,000 / 1,050 / 5,000 — buckets 1,000 and 5,000, nothing between.
    expect(bars.map((b) => b.startSeconds)).toEqual([1_000, 5_000]);
  });

  it('takes high and low by comparing rationals, not numbers', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    const bars = venueOhlcBars(series, 3_600);
    const first = bars[0];
    // The buy realised 100/0.99 ADA per token; the sell realised 99/1.
    expect(compareRates(first.high, first.low)).toBe(1);
    expect(compareRates(first.open, series[0].realised)).toBe(0);
    expect(compareRates(first.close, series[1].realised)).toBe(0);
  });

  it('sums volume per side and never adds the two together', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    const bars = venueOhlcBars(series, 3_600);
    expect(bars[0].volumeIn).toBe(100_000_000n + 1_000_000n);
    expect(bars[0].volumeOut).toBe(990_000n + 99_000_000n);
  });

  it('refuses a bucket length that is not positive', () => {
    expect(() => venueOhlcBars([], 0)).toThrow(/positive bucket length/);
  });
});

describe('venueVolumeByUnit', () => {
  it('keeps each asset in its own total', async () => {
    const series = await venueTradeSeries(threeTrades(), blocks);
    const totals = venueVolumeByUnit(series);
    expect(totals.lovelace).toBe(100_000_000n + 99_000_000n + 200_000_000n);
    expect(totals[TOKEN]).toBe(990_000n + 1_000_000n + 1_800_000n);
  });
});

describe('venueFeedIsComplete', () => {
  it('calls a walk that reached the pool opening complete', () => {
    expect(venueFeedIsComplete(history([]))).toEqual({ complete: true });
  });

  it('calls an incremental read complete, because the caller holds the rest', () => {
    const h = history([], { reachedGenesis: false, stoppedBy: 'stopAtTxHash' });
    expect(venueFeedIsComplete(h)).toEqual({ complete: true });
  });

  it('refuses to call a truncated walk complete, and says why', () => {
    const h = history([], { reachedGenesis: false, stoppedBy: 'maxEvents' });
    const result = venueFeedIsComplete(h);
    expect(result.complete).toBe(false);
    expect(result.reason).toMatch(/event limit/);
  });

  it('refuses a broken chain too', () => {
    const h = history([], { reachedGenesis: false, stoppedBy: 'brokenChain' });
    expect(venueFeedIsComplete(h).complete).toBe(false);
  });
});
