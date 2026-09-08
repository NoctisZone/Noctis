// ============================================================================
// Noctis Zone — NoctisSwap: what has become of an order
// ============================================================================
// **A venue order has no expiry, and that is deliberate rather than missing.**
// `SwapConfig` carries no deadline field and `swap_order.ak`'s cancel arm is
// one line — the placer's own signature and nothing else. The launch curve's
// order is the other way round: it carries a `deadline` and a permissionless
// `CancelExpiredOrder` beside the owner's own cancel.
//
// The difference is the instrument, not an oversight in one of them. A curve
// order is a QUEUED INSTRUCTION against a curve that will eventually graduate
// and close, so an unfilled one has somewhere it needs to be returned from,
// and a deadline anyone may act on is right. A venue order is a RESTING LIMIT
// ORDER, and resting indefinitely is what a limit order is for. Giving it an
// expiry would make it a worse instrument, and letting a stranger return it
// would hand them the choice of when somebody else's order stops existing.
//
// So expiry here is an OFF-CHAIN, ADVISORY idea: a tracker can say an order
// has been sitting a long while and offer the placer the cancel button. Only
// the placer can act on it, at any time, forever.
//
// What the placer actually needs, then, is not a countdown but an ANSWER: an
// order that is not filling looks identical to one that is patiently waiting,
// and only one of those is worth waiting for. Four states, and the two that
// matter are the last two:
//
//   - **fillable** — an executor can fill it now, and this says how much.
//   - **waiting** — the pool cannot serve it at its floor yet, but could if
//     the price came back. This says how far, in basis points, so the placer
//     can judge whether that is a normal day's move or a fantasy.
//   - **unfundable** — its execution fee is below what one fill costs, so no
//     part of it can ever be filled, at any pool state, at any time. The fee
//     is fixed in the datum, so this is permanent. Cancelling is the only way
//     the funds come back.
//   - **orphaned** — it names a pool that does not exist. One pool NFT is ever
//     minted, so nothing can come along later and make it fillable.
//
// Nothing is ever stranded beyond recovery: every one of these is cancellable
// by the placer, immediately, for as long as it exists.
// ============================================================================

import {
  readVenuePools,
  readVenueSwapOrders,
  type SkippedUtxo,
  type VenueChainProvider,
} from './venue-chain-reader.js';
import { VENUE_BPS } from './venue-quote.js';
import {
  readVenuePoolState,
  VENUE_FILL_FLOOR_LOVELACE,
  type VenueOrderPosition,
  type VenuePoolUtxo,
  type VenueSwapOrderUtxo,
  venueFillableAmount,
  venueFillSequence,
  venueSwapQuote,
  venueUnitOf,
} from './venue-swap.js';

/** What has become of one order. */
export type VenueOrderState = 'fillable' | 'waiting' | 'unfundable' | 'orphaned';

export interface VenueTrackedOrder {
  order: VenueSwapOrderUtxo;
  state: VenueOrderState;
  /** Plain-language reason, always present — including for a fillable one. */
  reason: string;
  /** The pool it names, when that pool exists. */
  pool?: VenuePoolUtxo;
  /** How much of it an executor could fill right now. */
  fillableNow: bigint;
  /** The least of it anyone can afford to fill. */
  smallestFundable: bigint;
  /**
   * How far short of the order's floor the pool is, in basis points, for the
   * whole order. Zero when the pool already clears it; absent when there is no
   * pool to compare against.
   *
   * The number a placer needs to decide whether to keep waiting: 30 is a
   * normal move, 3,000 is a different market.
   */
  shortfallBps?: bigint;
  /** Where the chain accepted it, when the reader looked it up. */
  placedAt?: VenueOrderPosition;
  /**
   * Resting longer than the caller's advisory threshold.
   *
   * Not an on-chain fact and nothing acts on it — the order remains the
   * placer's alone. It exists so a front end can raise the question.
   */
  stale?: boolean;
  /** True when the order names executors, and so is not open to every batcher. */
  gated: boolean;
}

export interface VenueOrderTracking {
  orders: VenueTrackedOrder[];
  /** UTXOs at either address the reader declined, each with its reason. */
  skipped: SkippedUtxo[];
  counts: Record<VenueOrderState, number>;
}

/**
 * How far the pool is from the order's floor, for the whole order.
 *
 * Measured on the whole tradable amount rather than on some fillable part,
 * because that is the question the placer asked: what would it take for THIS
 * order to go through.
 */
function shortfallBpsOf(pool: VenuePoolUtxo, order: VenueSwapOrderUtxo): bigint {
  const cfg = pool.datum;
  const swap = order.datum;
  const state = readVenuePoolState(cfg, pool.assets);
  const inputIsX = venueUnitOf(swap.input) === venueUnitOf(cfg.pool_x);
  const reserveIn = inputIsX ? state.reservesX : state.reservesY;
  const reserveOut = inputIsX ? state.reservesY : state.reservesX;
  // A floor of zero asks for nothing, so nothing is short of it. An empty
  // side is the opposite: no price reaches any floor at all.
  if (swap.base_price.num <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return VENUE_BPS;

  const { output } = venueSwapQuote({
    reserveIn,
    reserveOut,
    tradedIn: swap.tradable_input,
    feeNum: cfg.fee_num,
    treasuryFee: cfg.treasury_fee,
    royaltyFee: cfg.royalty_fee,
  });
  // achieved / floor, in basis points: (out / traded) / (num / denom).
  const achievedOverFloor = (output * swap.base_price.denom * VENUE_BPS) / (swap.tradable_input * swap.base_price.num);
  const short = VENUE_BPS - achievedOverFloor;
  return short < 0n ? 0n : short;
}

/** Classifies one order against the pool it names, or against none. */
export function trackVenueOrder(args: {
  order: VenueSwapOrderUtxo;
  /** The pool the order names, if this round found it. */
  pool?: VenuePoolUtxo;
  fillCostLovelace?: bigint;
}): VenueTrackedOrder {
  const swap = args.order.datum;
  const gated = swap.permitted_executors.length > 0;
  const cost = args.fillCostLovelace ?? VENUE_FILL_FLOOR_LOVELACE;
  const base = { order: args.order, gated, placedAt: args.order.placedAt };

  // Checked before the pool, because it is true whatever the pool is doing.
  if (swap.ex_fee < cost) {
    return {
      ...base,
      state: 'unfundable',
      reason:
        `its execution fee of ${swap.ex_fee} lovelace is under the ${cost} one fill costs, and the fee is ` +
        'fixed when the order is placed — so no part of it can be filled at any price, now or later. ' +
        'Cancelling is how the funds come back.',
      fillableNow: 0n,
      smallestFundable: swap.tradable_input,
    };
  }

  if (!args.pool) {
    return {
      ...base,
      state: 'orphaned',
      reason:
        `it names pool ${venueUnitOf(swap.pool_nft)}, and no pool carrying that token exists. One unit of ` +
        'it is ever minted, so nothing can arrive later to fill this. Cancelling is how the funds come back.',
      fillableNow: 0n,
      smallestFundable: swap.tradable_input,
    };
  }

  const answer = venueFillableAmount({
    pool: args.pool,
    order: args.order,
    fillCostLovelace: args.fillCostLovelace,
  });
  const shortfallBps = shortfallBpsOf(args.pool, args.order);

  if (answer.fillable) {
    return {
      ...base,
      state: 'fillable',
      reason: gated
        ? `the pool can serve ${answer.largest} of it, and it may only be filled by the executors it names`
        : `the pool can serve ${answer.largest} of it`,
      pool: args.pool,
      fillableNow: answer.largest,
      smallestFundable: answer.smallestFundable,
      shortfallBps,
    };
  }

  return {
    ...base,
    state: 'waiting',
    reason:
      answer.largest === 0n
        ? `the pool pays under its price floor — ${shortfallBps} basis points under, across the whole order`
        : `the pool can serve ${answer.largest} of it at its floor, and the fee only funds a fill of ` +
          `${answer.smallestFundable} or more, so it waits for the price rather than filling in part`,
    pool: args.pool,
    fillableNow: answer.largest,
    smallestFundable: answer.smallestFundable,
    shortfallBps,
  };
}

/**
 * Every order at the venue, classified, in the order fills would take them.
 *
 * `owner` narrows it to one placer's orders — the whole point of the tracker
 * for a front end, since a placer wants their own book and not the venue's.
 * The filter is on `reward_pkh`, which is where the proceeds go and therefore
 * who the order is for.
 */
export async function trackVenueOrders(
  provider: VenueChainProvider,
  args: {
    poolAddress: string;
    orderAddress: string;
    factoryPolicyId: string;
    /** A payment key hash. Omitted, every order at the venue is returned. */
    owner?: string;
    fillCostLovelace?: bigint;
    positions?: Map<string, VenueOrderPosition>;
    /**
     * Advisory only. With the chain's current height, an order older than this
     * many blocks is flagged so a front end can raise it with the placer.
     * Nothing on chain acts on it and nobody but the placer ever can.
     */
    staleAfterBlocks?: number;
    currentBlockHeight?: number;
  },
): Promise<VenueOrderTracking> {
  const poolsRead = await readVenuePools(provider, args);
  const byNft = new Map(poolsRead.pools.map((pool) => [venueUnitOf(pool.datum.pool_nft), pool]));

  // Deliberately every order, not only those naming a known pool: an order
  // that names no live pool is exactly the case the placer most needs told.
  const ordersRead = await readVenueSwapOrders(provider, {
    orderAddress: args.orderAddress,
    knownPools: [...byNft.keys()],
    positions: args.positions,
    includeUnknownPools: true,
  });

  const counts: Record<VenueOrderState, number> = {
    fillable: 0,
    waiting: 0,
    unfundable: 0,
    orphaned: 0,
  };
  const orders: VenueTrackedOrder[] = [];

  for (const order of venueFillSequence(ordersRead.orders)) {
    if (args.owner !== undefined && order.datum.reward_pkh !== args.owner) continue;
    const tracked = trackVenueOrder({
      order,
      pool: byNft.get(venueUnitOf(order.datum.pool_nft)),
      fillCostLovelace: args.fillCostLovelace,
    });
    if (args.staleAfterBlocks !== undefined && args.currentBlockHeight !== undefined && order.placedAt !== undefined) {
      tracked.stale = args.currentBlockHeight - order.placedAt.blockHeight >= args.staleAfterBlocks;
    }
    counts[tracked.state] += 1;
    orders.push(tracked);
  }

  return { orders, skipped: [...poolsRead.skipped, ...ordersRead.skipped], counts };
}

/**
 * The orders a placer should be offered a cancel for, worst first.
 *
 * `unfundable` and `orphaned` come first because they are terminal and the
 * placer may not know it; a stale `waiting` order follows, because that is a
 * judgement call rather than a fact. A fillable order is never suggested —
 * it is about to go through.
 */
export function venueOrdersWorthCancelling(tracking: VenueOrderTracking): VenueTrackedOrder[] {
  const rank: Record<VenueOrderState, number> = { unfundable: 0, orphaned: 1, waiting: 2, fillable: 3 };
  return tracking.orders
    .filter((o) => o.state === 'unfundable' || o.state === 'orphaned' || (o.state === 'waiting' && o.stale))
    .sort((a, b) => rank[a.state] - rank[b.state]);
}
