// ============================================================================
// Noctis Zone — NoctisSwap trading panel: browser entry point
// ============================================================================
// webpack browser target (see ../webpack.widgets.config.cjs's
// venue-swap-widget block) — bundled to assets/js/venue-swap-widget.bundle.js
// in the theme, enqueued on a GRADUATED launch page, where it replaces the
// linked-out DEX panel. Same shape as window.NoctisCurveOrder: a plain object
// of async functions the theme's vanilla JS calls from DOM handlers.
//
// **What the browser may do here, and what it structurally cannot.** Placing
// an order is an ordinary payment — creating a UTXO at a script address never
// runs that script — and cancelling is a script spend of the placer's own
// order, which fits in a transaction because `swap_order` is 3.4 KB. Filling
// is neither: it spends the POOL, needs the executor's own budgeting, and is
// built on a transaction library the widget bundles alias away. So a browser
// can price, place, watch and withdraw, and can never move a pool. That is
// the venue's own division, not a limitation of this file.
//
// HONEST SCOPE — read before wiring a template to this:
//
// 1. TWO NUMBERS, AND THE SCREEN MUST NOT CONFLATE THEM. `expectedOut` is an
//    estimate of a pool state that has already passed by the time anyone
//    signs. `guaranteedOut` is the floor the order is bound to: it fills at
//    or above that, or it does not fill. Show the second as the promise and
//    the first as the estimate — never one number labelled "you will get".
//
// 2. THE FEE IS A CEILING, NOT A PRICE. `maxExecutionFee` is the most an
//    executor may take; a settled fill charges what the transaction cost and
//    returns the rest to the placer. Quoting the ceiling as the cost
//    understates every fill.
//
// 3. AN ORDER HAS NO EXPIRY, DELIBERATELY. It is a resting limit order, and
//    resting is what a limit order is for. `myOrders` classifies each one —
//    fillable, waiting, unfundable, orphaned — and `ordersWorthCancelling`
//    is the list a "tidy up" button should offer. Nothing but the placer can
//    ever end an order, at any time, forever.
//
// 4. A DEAD ORDER CANNOT BE PLACED FROM HERE. `quote` refuses a draft whose
//    floor no pool state could meet, so the screen cannot emit an order that
//    would rest forever looking patient.
//
// 5. SWAPS BOTH WAYS. `inputUnit` decides the direction — 'lovelace' to buy
//    the launch token, the token's unit to sell it. Unlike the curve widget,
//    which is buy-only because the curve template renders no sell side, the
//    venue is symmetric and so is this.
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import { VenueBrowserSubmitter } from '../venue-browser-submitter.js';
import { venuePoolMarket, venueRateToDecimal } from '../venue-quote.js';
import { venueUnitOf } from '../venue-swap.js';

export interface VenueSwapWidgetConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** `swap_order.ak`'s compiled CBOR, read server-side and inlined. */
  orderScriptCbor: string;
  /** `pool.ak`'s applied CBOR — read from, never spent from the browser. */
  poolScriptCbor: string;
  /** The factory policy id, which is what makes a pool a pool. */
  factoryPolicyId: string;
  /** The launch's pool NFT unit: policy id followed by asset name, hex. */
  poolNftUnit: string;
}

/** Everything a panel renders for one quote. Strings, so the DOM can hold them. */
export interface VenueSwapQuoteView {
  /** What the trade is expected to return, at the pool as it stands. An estimate. */
  expectedOut: string;
  /** The floor the order is bound to. The only promise. */
  guaranteedOut: string;
  /** Realised rate, output per unit of input, as a decimal string. */
  expectedRate: string;
  /** The pool's rate for an infinitesimal trade, fee included. */
  spotRate: string;
  /** What this trade's own size costs, in basis points. Fee excluded. */
  priceImpactBps: string;
  /** The pool's whole fee, in basis points. */
  feeBps: string;
  /** The most an executor may take. A ceiling — a fill charges less. */
  maxExecutionFee: string;
  /** Lovelace the order UTXO carries in total. */
  carriedLovelace: string;
  /** The least of this order anyone can afford to fill. */
  smallestFundableTrade: string;
  /** True when the order is too small to part-fill and waits for the whole. */
  fillsWholeOrWaits: boolean;
  inputUnit: string;
  outputUnit: string;
}

/** One of the placer's own orders, as a list row. */
export interface VenueOrderView {
  txHash: string;
  outputIndex: number;
  state: string;
  reason: string;
  /** How much of it an executor could fill right now. */
  fillableNow: string;
  /** How far the pool is from its floor, in basis points. Absent with no pool. */
  shortfallBps?: string;
  tradableInput: string;
  inputUnit: string;
  outputUnit: string;
}

let config: VenueSwapWidgetConfig | null = null;
let submitter: VenueBrowserSubmitter | null = null;
/** The draft behind the last quote, so `place` signs what was shown. */
let lastDraft: Awaited<ReturnType<VenueBrowserSubmitter['quote']>>['draft'] | null = null;

function requireConfigured(): { cfg: VenueSwapWidgetConfig; sub: VenueBrowserSubmitter } {
  if (!config || !submitter) {
    throw new Error('NoctisVenueSwap.configure() must be called before any other method.');
  }
  return { cfg: config, sub: submitter };
}

function configure(newConfig: VenueSwapWidgetConfig): void {
  config = newConfig;
  submitter = new VenueBrowserSubmitter({
    blockfrostProjectId: newConfig.blockfrostProjectId,
    blockfrostUrl: newConfig.blockfrostUrl,
    network: newConfig.network,
    orderScriptCbor: newConfig.orderScriptCbor,
    poolScriptCbor: newConfig.poolScriptCbor,
    factoryPolicyId: newConfig.factoryPolicyId,
  });
  lastDraft = null;
}

/** The pool's public state: what a price panel shows before anyone types. */
async function poolState(): Promise<{
  reservesX: string;
  reservesY: string;
  unitX: string;
  unitY: string;
  spotYPerX: string;
  spotXPerY: string;
  feeBps: string;
  tvlLovelace: string | null;
  liquidity: string;
}> {
  const { cfg, sub } = requireConfigured();
  const market = venuePoolMarket(await sub.poolFor(cfg.poolNftUnit));
  return {
    reservesX: market.reservesX.toString(),
    reservesY: market.reservesY.toString(),
    unitX: market.unitX,
    unitY: market.unitY,
    spotYPerX: venueRateToDecimal(market.spotYPerX),
    spotXPerY: venueRateToDecimal(market.spotXPerY),
    feeBps: market.feeBps.toString(),
    tvlLovelace: market.tvlLovelace === null ? null : market.tvlLovelace.toString(),
    liquidity: market.liquidity.toString(),
  };
}

/**
 * Quotes a trade and holds the draft it produced.
 *
 * Read fresh every time — a stale quote would mislead, and the order's own
 * floor is what actually binds either way.
 */
async function quote(params: {
  inputUnit: string;
  tradedIn: string;
  slippageToleranceBps: string;
  walletAddress: string;
  minOutputLovelace?: string;
  exFee?: string;
}): Promise<VenueSwapQuoteView> {
  const { cfg, sub } = requireConfigured();
  const result = await sub.quote({
    poolNftUnit: cfg.poolNftUnit,
    inputUnit: params.inputUnit,
    tradedIn: BigInt(params.tradedIn),
    slippageToleranceBps: BigInt(params.slippageToleranceBps),
    walletAddress: params.walletAddress,
    minOutputLovelace: BigInt(params.minOutputLovelace ?? '1000000'),
    ...(params.exFee !== undefined ? { exFee: BigInt(params.exFee) } : {}),
  });
  lastDraft = result.draft;

  return {
    expectedOut: result.quote.expectedOut.toString(),
    guaranteedOut: result.draft.guaranteedOut.toString(),
    expectedRate: venueRateToDecimal(result.quote.expectedRate),
    spotRate: venueRateToDecimal(result.quote.spotRate),
    priceImpactBps: result.quote.priceImpactBps.toString(),
    feeBps: result.market.feeBps.toString(),
    maxExecutionFee: result.draft.maxExecutionFee.toString(),
    carriedLovelace: result.draft.carriedLovelace.toString(),
    smallestFundableTrade: result.draft.smallestFundableTrade.toString(),
    fillsWholeOrWaits: result.draft.fillsWholeOrWaits,
    inputUnit: result.quote.inputUnit,
    outputUnit: result.quote.outputUnit,
  };
}

/**
 * Places the order the last quote produced.
 *
 * Refuses rather than re-quoting silently: a placement that priced itself
 * would sign something the person never saw.
 */
async function placeSwapOrder(params: { walletApi: WalletApi }): Promise<{ txHash: string }> {
  const { sub } = requireConfigured();
  if (!lastDraft) {
    throw new Error('Nothing to place. Call NoctisVenueSwap.quote() first — an order is signed as it was shown.');
  }
  const result = await sub.placeSwapOrder(params.walletApi, lastDraft);
  lastDraft = null;
  return result;
}

function asView(tracked: Awaited<ReturnType<VenueBrowserSubmitter['myOrders']>>['orders'][number]): VenueOrderView {
  return {
    txHash: tracked.order.txHash,
    outputIndex: tracked.order.outputIndex,
    state: tracked.state,
    reason: tracked.reason,
    fillableNow: tracked.fillableNow.toString(),
    ...(tracked.shortfallBps !== undefined ? { shortfallBps: tracked.shortfallBps.toString() } : {}),
    tradableInput: tracked.order.datum.tradable_input.toString(),
    inputUnit: venueUnitOf(tracked.order.datum.input),
    outputUnit: venueUnitOf(tracked.order.datum.output),
  };
}

/** The connected wallet's own orders at this venue, classified. */
async function myOrders(params: { walletApi: WalletApi }): Promise<VenueOrderView[]> {
  const { sub } = requireConfigured();
  const tracking = await sub.myOrders(params.walletApi);
  return tracking.orders.map(asView);
}

/** The ones a "tidy up" button should offer, worst first. */
async function ordersWorthCancelling(params: { walletApi: WalletApi }): Promise<VenueOrderView[]> {
  const { sub } = requireConfigured();
  return (await sub.ordersWorthCancelling(params.walletApi)).map(asView);
}

/**
 * Takes the named orders back, in one transaction.
 *
 * Named by reference rather than passed whole, so the panel cannot cancel an
 * order the chain no longer holds: the list is read fresh and the references
 * are matched against it.
 */
async function cancelOrders(params: {
  walletApi: WalletApi;
  orders: Array<{ txHash: string; outputIndex: number }>;
}): Promise<{ txHash: string }> {
  const { sub } = requireConfigured();
  const tracking = await sub.myOrders(params.walletApi);
  const found = params.orders.map((ref) => {
    const match = tracking.orders.find((o) => o.order.txHash === ref.txHash && o.order.outputIndex === ref.outputIndex);
    if (!match) {
      throw new Error(
        `No open order ${ref.txHash}#${ref.outputIndex} belongs to this wallet. It may already have been ` +
          'filled or cancelled.',
      );
    }
    return match.order;
  });
  return sub.cancelOrders(params.walletApi, found);
}

const NoctisVenueSwap = {
  configure,
  poolState,
  quote,
  placeSwapOrder,
  myOrders,
  ordersWorthCancelling,
  cancelOrders,
};

declare global {
  interface Window {
    NoctisVenueSwap: typeof NoctisVenueSwap;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisVenueSwap = NoctisVenueSwap;
}

export default NoctisVenueSwap;
