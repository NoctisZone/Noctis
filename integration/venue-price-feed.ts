/**
 * The venue's price feed: every trade a pool has seen, with the reserves it
 * left behind, in exact integers.
 *
 * WHY THIS IS ITS OWN MODULE. `venuePoolMarket` already answers "what is this
 * pool worth right now" from a single UTXO. An aggregator wants the other
 * thing: a SERIES — each trade, in order, with the reserves after it — because
 * that is what lets a chart be rebuilt without trusting whoever served it.
 *
 * RESERVES PER TRADE, NOT JUST TRADES. The history walk already records the
 * pool's whole state after every event, which is what makes this possible at
 * all rather than only going forward from today. A feed that stored trades
 * alone could never reconstruct its own past, and that is discovered long after
 * the data which would have fixed it has gone.
 *
 * NO FLOATS ANYWHERE. Every price is a rational in the same shape the order
 * datum states its own floor in. A price that has been through a float no
 * longer agrees with the validator, and a feed whose numbers disagree with the
 * chain is worse than no feed.
 *
 * WHAT IS DELIBERATELY NOT HERE: the wire format. What an aggregator's
 * endpoints are named and what envelope they expect is that aggregator's own
 * convention, and the published third-party adapters each carry their own.
 * Inferring it produces something that looks right until a listing is refused,
 * so the serialisation is left to be written against a confirmed
 * specification — which pairs naturally with applying to be listed. Everything
 * such an adapter needs is in this module's own shapes.
 */

import { type VenuePoolEvent, type VenuePoolHistory, venueSwapsOnly } from './venue-pool-history.js';
import type { VenueRate } from './venue-quote.js';

/** When a transaction landed. One lookup per trade, and they never change. */
export interface VenueBlockStamp {
  height: number;
  /** Unix seconds. */
  timeSeconds: number;
}

export interface VenueBlockProvider {
  getTxBlock(txHash: string): Promise<VenueBlockStamp>;
}

/**
 * One trade against one pool.
 *
 * `side` is stated from the taker's point of view and relative to the pool's
 * ada side: a BUY spends ada and receives the token. A pool with no ada side
 * reports `null` rather than picking one arbitrarily and being wrong half the
 * time on a chart nobody can check.
 */
export interface VenueTrade {
  txHash: string;
  poolNft: string;
  block: VenueBlockStamp;
  side: 'buy' | 'sell' | null;
  /** What the taker gave the pool, and in what. */
  inUnit: string;
  inAmount: bigint;
  /** What the pool paid the taker, and in what. */
  outUnit: string;
  outAmount: bigint;
  /**
   * The price this trade REALISED — what was paid over what was got, fees
   * included, because they were taken out of it. Not the pool's spot price
   * before or after; that is a different question, and `reservesAfter` is what
   * answers it.
   *
   * Always quoted ada-per-token where the pool has an ada side, so every trade
   * in a series reads the same way round whichever direction it went.
   */
  realised: VenueRate;
  /** The pool after this trade. Tradable reserves, net of accrued fees. */
  reservesAfter: { unitX: string; x: bigint; unitY: string; y: bigint };
  /** What this trade added to each counter — the venue's own earnings from it. */
  accrued: VenuePoolEvent['accrued'];
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function reduce(rate: VenueRate): VenueRate {
  const d = gcd(rate.num, rate.denom);
  if (d <= 1n) return rate;
  return { num: rate.num / d, denom: rate.denom / d };
}

/**
 * a/b against c/d, without dividing.
 *
 * Denominators are amounts paid or received, so they are positive and the
 * cross-multiplication keeps its sign. Comparing as numbers instead would make
 * two genuinely different prices equal on any token worth a small fraction of a
 * lovelace, which is most of them early in a pool's life.
 */
export function compareRates(a: VenueRate, b: VenueRate): number {
  const left = a.num * b.denom;
  const right = b.num * a.denom;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const LOVELACE = 'lovelace';

/**
 * The pool's two asset names, taken from the datum the event already carries
 * rather than looked up again. The event and its unit names have to describe
 * the same pool, and reading them from two places is how they come to differ.
 */
function unitOf(asset: { policy: string; name: string }): string {
  return asset.policy === '' ? LOVELACE : `${asset.policy}${asset.name}`;
}

/**
 * Every swap in a history, oldest first, with the block it landed in.
 *
 * The walk returns newest-first because it follows inputs backward; a feed
 * reads forward, so the order is reversed here once rather than by every
 * caller — a caller that forgot would produce a chart running backwards with no
 * error anywhere.
 *
 * One block lookup per trade. Blocks are immutable once confirmed, so a caller
 * reading incrementally (the walk's own `stopAtTxHash`) pays only for what is
 * new.
 */
export async function venueTradeSeries(history: VenuePoolHistory, blocks: VenueBlockProvider): Promise<VenueTrade[]> {
  const swaps = venueSwapsOnly(history).slice().reverse();
  const out: VenueTrade[] = [];

  for (const event of swaps) {
    if (!event.swap) continue;
    const block = await blocks.getTxBlock(event.txHash);
    const { inputUnit, outputUnit, tradedIn, paidOut } = event.swap;

    const side = inputUnit === LOVELACE ? 'buy' : outputUnit === LOVELACE ? 'sell' : null;
    // Ada over token in both directions, so a series is comparable end to end.
    const realised =
      side === 'sell' ? reduce({ num: paidOut, denom: tradedIn }) : reduce({ num: tradedIn, denom: paidOut });

    out.push({
      txHash: event.txHash,
      poolNft: event.poolNft,
      block,
      side,
      inUnit: inputUnit,
      inAmount: tradedIn,
      outUnit: outputUnit,
      outAmount: paidOut,
      realised,
      reservesAfter: {
        unitX: unitOf(event.after.datum.pool_x),
        x: event.after.reservesX,
        unitY: unitOf(event.after.datum.pool_y),
        y: event.after.reservesY,
      },
      accrued: event.accrued,
    });
  }
  return out;
}

/** One time bucket of trading, priced the way the trades in it are. */
export interface VenueBar {
  /** Unix seconds, the bucket's own start. */
  startSeconds: number;
  open: VenueRate;
  high: VenueRate;
  low: VenueRate;
  close: VenueRate;
  /** Volume on each side, in its own unit. Never added together. */
  volumeIn: bigint;
  volumeOut: bigint;
  trades: number;
  /** The reserves the last trade in the bucket left. */
  reservesAfter: VenueTrade['reservesAfter'];
}

/**
 * OHLC bars from a trade series.
 *
 * Buckets align to the epoch rather than to the first trade, so two callers
 * reading different windows of the same pool produce bars that line up.
 *
 * A bucket with no trades is ABSENT rather than carried forward. Inventing a
 * flat bar asserts the market was quiet, when what is true is that this feed
 * has nothing to say about it; only the caller knows which of those its chart
 * should show.
 */
export function venueOhlcBars(trades: readonly VenueTrade[], bucketSeconds: number): VenueBar[] {
  if (bucketSeconds <= 0) throw new Error('A bar needs a positive bucket length.');
  const bars: VenueBar[] = [];
  let current: VenueBar | null = null;

  for (const trade of trades) {
    const start = Math.floor(trade.block.timeSeconds / bucketSeconds) * bucketSeconds;
    if (!current || start !== current.startSeconds) {
      if (current) bars.push(current);
      current = {
        startSeconds: start,
        open: trade.realised,
        high: trade.realised,
        low: trade.realised,
        close: trade.realised,
        volumeIn: trade.inAmount,
        volumeOut: trade.outAmount,
        trades: 1,
        reservesAfter: trade.reservesAfter,
      };
      continue;
    }
    if (compareRates(trade.realised, current.high) > 0) current.high = trade.realised;
    if (compareRates(trade.realised, current.low) < 0) current.low = trade.realised;
    current.close = trade.realised;
    current.volumeIn += trade.inAmount;
    current.volumeOut += trade.outAmount;
    current.trades += 1;
    current.reservesAfter = trade.reservesAfter;
  }
  if (current) bars.push(current);
  return bars;
}

/**
 * Volume over a series, per unit.
 *
 * Per unit rather than summed into one figure: the two sides of a pool are
 * different assets, and adding them produces a number that is not a quantity of
 * anything.
 */
export function venueVolumeByUnit(trades: readonly VenueTrade[]): Record<string, bigint> {
  const totals: Record<string, bigint> = {};
  for (const trade of trades) {
    totals[trade.inUnit] = (totals[trade.inUnit] ?? 0n) + trade.inAmount;
    totals[trade.outUnit] = (totals[trade.outUnit] ?? 0n) + trade.outAmount;
  }
  return totals;
}

/**
 * Whether a series can be served as a complete feed.
 *
 * A truncated history and a complete one look identical in the trades
 * themselves, so this reads the walk's own account of why it stopped rather
 * than the events. An aggregator handed a truncated series silently loses the
 * early life of a pool — which is exactly the part a launch gets judged on.
 */
export function venueFeedIsComplete(history: VenuePoolHistory): { complete: boolean; reason?: string } {
  if (history.reachedGenesis) return { complete: true };
  switch (history.stoppedBy) {
    case 'stopAtTxHash':
      // An incremental read by design: the caller already holds the rest.
      return { complete: true };
    case 'maxEvents':
      return { complete: false, reason: 'The walk hit its event limit before reaching the pool opening.' };
    case 'brokenChain':
      return { complete: false, reason: 'The walk could not follow the pool back any further.' };
    default:
      return { complete: false, reason: 'The walk did not reach the pool opening and gave no reason for stopping.' };
  }
}
