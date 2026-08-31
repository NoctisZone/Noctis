// ============================================================================
// Noctis Zone — Curve Order Widget: browser entry point (Cardano Launch public curve)
// ============================================================================
// webpack browser target (see ../webpack.widgets.config.cjs's
// curve-order-widget block) — bundled to assets/js/curve-order-widget.bundle.js
// in the theme, enqueued only on Cardano Launch curve_live launch pages
// (lp-chart-buy-tier-b.php), following the exact enqueue pattern the linear curve
// buy widget already uses.
//
// Exposes window.NoctisCurveOrder, a plain object of async functions the
// theme's vanilla JS calls directly from DOM event handlers — same shape as
// window.NoctisTierABuy (tier-a-buy-widget-entry.ts).
//
// WHY THIS IS AN ORDER WIDGET AND NOT A DIRECT-SPEND WIDGET: the linear curve
// widget spends the curve UTXO itself, which works because Lucid Evolution
// always EMBEDS the validator it spends (tests/script-size-budget.test.ts
// records why readFrom cannot change that) and the linear curve script leaves room
// for it. The Cardano Launch validator is 14,226 B of the 16,384-byte transaction
// cap before a single input, output or cap proof — a browser cannot spend it
// The linear curve way, and the referenced path is server-side by construction
// (Mesh signs with keys a browser must never hold). Placing an ORDER needs
// none of that: creating a UTXO at a script address never runs its
// validator, so placement is an ordinary payment. The batcher touches the
// curve; the browser only ever touches the buyer's own order.
//
// This is also the architecturally decided shape, not a fallback — the
// order-batcher design removed direct public trades in favour of orders,
// because a direct spend destroys the batch being built and being first was
// measurably worth 28.3% on a fresh curve.
//
// HONEST SCOPE — read before wiring a template to this:
//
// 1. BUY ONLY, plus my-orders and cancel. The Cardano Launch template renders no
//    sell form today, and the linear curve widget is buy-only for the same
//    reason. placeSellOrder is a straightforward extension when the
//    template grows a sell side (the submitter underneath already supports
//    it) — deliberately not shipped unexercised.
//
// 2. THE QUOTE IS A FLOOR, NOT A PRICE. A batched fill prices at the curve
//    position earlier orders in the batch left (the validator's own
//    BatchTrades comment: "order k prices at the position order k-1 left"),
//    which this widget cannot know at placement. The order's own bounds are
//    the real protection: it receives exactly `amount` tokens or does not
//    fill, and at most `maxSpend` of its lovelace leaves it. The quote adds
//    SLIPPAGE_BPS of headroom so a batch that moves the price a little
//    still fills; a batch that moves it more than that skips the order,
//    which then stays open for the next batch or is cancelled — never
//    silently overpays.
//
// 3. NO CAP PROOF HERE. The batcher rebuilds the cap accumulator and
//    supplies every order's proof; the validator enforces the 5% cumulative
//    per-wallet-key cap on-chain. The widget caps a single order at the
//    absolute wallet_cap as a UX courtesy, but a wallet near its cumulative
//    cap will see its order skipped by the planner rather than refused
//    here — rebuilding the full accumulator in the browser for a nicer
//    early error is deliberate future work, not an oversight.
//
// 4. CANCELLATION IS THE OWNER'S EXIT AND NEEDS NO ONE. cancelOrder is a
//    real script spend of the order UTXO (1,775 B validator — fits
//    embedded), signed by the owner's own wallet. After the deadline anyone
//    may sweep the funds back to the owner. A dead batcher is an outage,
//    never a loss.
//
// 5. Token identity comes off the AUTHENTICATED curve datum (thread-NFT
//    checked via selectLaunchUtxo), not from config — two fewer values that
//    could drift from the chain.
// ============================================================================

import type { Network as LucidNetwork, UTxO, WalletApi } from '@lucid-evolution/lucid';
import { Blockfrost, getAddressDetails, Lucid, type LucidEvolution } from '@lucid-evolution/lucid';
import { buyCost, spotPrice } from '../curve-pricing.js';
import { selectLaunchUtxo } from '../launch-utxo-lookup.js';
import { OrderSubmitter } from '../order-submitter.js';
import type { BondingCurveTierBDatumData, OrderDatumData } from '../tier-a-schemas.js';
import { BondingCurveTierBDatumSchema } from '../tier-a-schemas.js';

export interface CurveOrderWidgetConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** curve_order.ak's compiled PlutusV3 script CBOR — plutus.json's
   *  validators[].compiledCode for curve_order.curve_order.spend. Read
   *  server-side (PHP) and inlined, since a browser bundle can't read the
   *  repo's plutus.json itself. */
  orderScriptCbor: string;
  /** bonding_curve_tier_b.ak's compiled CBOR — same source. Used to derive
   *  the curve address for reads and the curve_credential the order datum
   *  records. Never spent from the browser. */
  curveScriptCbor: string;
  launchIdHex: string;
  /** The launch's thread-NFT policy id, from the platform's own record of
   *  the launch — required so the curve read authenticates the UTXO instead
   *  of trusting whichever datum claims the launch id. */
  threadNftPolicyId: string;
}

/** The order UTXO's own minimum-ada allowance, returned to the owner on fill
 *  or cancel — the order-batcher design's "min-ADA deducted from the
 *  trade" decision. */
const MIN_ADA_RESERVE = 2_000_000n;

/** The most a batcher may keep from an order's change — the fee is a ceiling,
 *  not a rate: whatever the batcher does not take returns to the owner. */
const BATCHER_FEE_CEILING = 1_000_000n;

/** Headroom the quote leaves for the curve moving between placement and the
 *  batch — see HONEST SCOPE note 2. Basis points of the quoted gross. */
const SLIPPAGE_BPS = 200n;

/** A low floor so a tiny order is not mostly overhead. */
const MIN_ORDER_LOVELACE = 10_000_000n;

/** Orders anyone may sweep back to the owner after this long, if unfilled. */
const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000;

export interface OrderQuote {
  /** Whole tokens the order will buy — exactly this many, or it does not fill. */
  tokenAmount: string;
  /** Most lovelace that can leave the order: curve cost + batcher ceiling + slippage headroom. */
  maxSpendLovelace: string;
  /** Lovelace the order UTXO is funded with (the user's one committed number). */
  fundedLovelace: string;
  /** Returned to the owner on fill or cancel. */
  minAdaReserveLovelace: string;
  batcherFeeCeilingLovelace: string;
  /** The curve's spot price at the current position — display only. */
  spotPriceLovelace: string;
  curveState: string;
  tokensSold: string;
  curveSupply: string;
  remaining: string;
}

let config: CurveOrderWidgetConfig | null = null;
let submitter: OrderSubmitter | null = null;
let lucidPromise: Promise<LucidEvolution> | null = null;

function requireConfigured(): { cfg: CurveOrderWidgetConfig; sub: OrderSubmitter } {
  if (!config || !submitter) {
    throw new Error('NoctisCurveOrder.configure() must be called before any other method.');
  }
  return { cfg: config, sub: submitter };
}

function configure(newConfig: CurveOrderWidgetConfig): void {
  config = newConfig;
  submitter = new OrderSubmitter({
    blockfrostProjectId: newConfig.blockfrostProjectId,
    blockfrostUrl: newConfig.blockfrostUrl,
    network: newConfig.network,
    compiledScriptCbor: newConfig.orderScriptCbor,
    curveScriptCbor: newConfig.curveScriptCbor,
  });
  lucidPromise = Lucid(new Blockfrost(newConfig.blockfrostUrl, newConfig.blockfrostProjectId), newConfig.network);
  // Same unhandled-rejection note as OrderSubmitter's own constructor: nothing
  // awaits this until a method runs; a later await still sees the rejection.
  lucidPromise.catch(() => {});
}

/** The launch's authenticated curve state — thread NFT checked, never the
 *  first datum that happens to claim the launch id. */
async function readCurve(): Promise<BondingCurveTierBDatumData> {
  const { cfg, sub } = requireConfigured();
  const lucid = await (lucidPromise as Promise<LucidEvolution>);
  const utxos = await lucid.utxosAt(sub.curveAddress);
  const found = selectLaunchUtxo<BondingCurveTierBDatumData>(
    utxos,
    sub.curveAddress,
    cfg.launchIdHex,
    'bondingCurveTierB',
    BondingCurveTierBDatumSchema as never,
    cfg.threadNftPolicyId,
  );
  return found.datum;
}

/** Largest n in [0, hi] with cost(n) <= budget. cost is monotonic in n. */
function largestAffordable(hi: bigint, budget: bigint, cost: (n: bigint) => bigint): bigint {
  let lo = 0n;
  let high = hi;
  while (lo < high) {
    const mid = (lo + high + 1n) / 2n;
    if (cost(mid) <= budget) {
      lo = mid;
    } else {
      high = mid - 1n;
    }
  }
  return lo;
}

/**
 * What `payAdaLovelace` buys right now, and the bounds the order would carry.
 * Read fresh on every call — a stale quote would mislead, and the contract
 * prices the real fill itself either way.
 */
async function getQuote(payAdaLovelace: string): Promise<OrderQuote> {
  const pay = BigInt(payAdaLovelace);
  if (pay < MIN_ORDER_LOVELACE) {
    throw new Error(
      `An order needs at least ${Number(MIN_ORDER_LOVELACE) / 1_000_000} ADA — below that it is mostly ` +
        'minimum-ada overhead.',
    );
  }

  const datum = await readCurve();
  if (datum.curve_state !== 'Active') {
    throw new Error(`Curve is not open for public trading right now (state: ${datum.curve_state}).`);
  }

  const maxSpend = pay - MIN_ADA_RESERVE;
  // The curve-cost budget leaves room for the batcher's ceiling and the
  // slippage headroom inside maxSpend, so a fill at the quoted size cannot
  // breach the order's own bound even after both.
  const budget = ((maxSpend - BATCHER_FEE_CEILING) * 10_000n) / (10_000n + SLIPPAGE_BPS);
  if (budget <= 0n) {
    throw new Error('Amount too small once the order reserve and batcher ceiling are set aside.');
  }

  const remaining = datum.curve_supply - datum.tokens_sold;
  const ceiling = remaining < datum.wallet_cap ? remaining : datum.wallet_cap;
  const tokens = largestAffordable(ceiling, budget, (n) =>
    n === 0n ? 0n : buyCost('quadratic', datum, datum.tokens_sold, n),
  );
  if (tokens <= 0n) {
    throw new Error('Amount too small to buy a single token at the current price.');
  }

  return {
    tokenAmount: tokens.toString(),
    maxSpendLovelace: maxSpend.toString(),
    fundedLovelace: pay.toString(),
    minAdaReserveLovelace: MIN_ADA_RESERVE.toString(),
    batcherFeeCeilingLovelace: BATCHER_FEE_CEILING.toString(),
    spotPriceLovelace: spotPrice('quadratic', datum, datum.tokens_sold).toString(),
    curveState: datum.curve_state,
    tokensSold: datum.tokens_sold.toString(),
    curveSupply: datum.curve_supply.toString(),
    remaining: remaining.toString(),
  };
}

/**
 * Places a real buy order, funded with `payAdaLovelace` from the connected
 * wallet. Ordinary payment — no collateral, no validator run. The quote is
 * recomputed here rather than trusted from an earlier call, so the amount
 * reflects the curve as it is at signing time.
 */
async function placeBuyOrder(params: {
  payAdaLovelace: string;
  walletApi: WalletApi;
  deadlineMs?: string;
}): Promise<{ txHash: string; orderAddress: string; tokenAmount: string; maxSpendLovelace: string }> {
  const { cfg, sub } = requireConfigured();
  const quote = await getQuote(params.payAdaLovelace);
  const datum = await readCurve();
  const deadline = params.deadlineMs ? BigInt(params.deadlineMs) : BigInt(Date.now() + DEFAULT_DEADLINE_MS);

  const placed = await sub.placeOrderWithWallet(params.walletApi, {
    launchIdHex: cfg.launchIdHex,
    isBuy: true,
    amount: BigInt(quote.tokenAmount),
    // Fills are all-or-nothing at `amount`, so the tightest honest bound is
    // the amount itself: the order receives exactly this many or stays open.
    minReceived: BigInt(quote.tokenAmount),
    maxSpend: BigInt(quote.maxSpendLovelace),
    deadlineMs: deadline,
    tokenPolicyId: datum.token_policy_id,
    tokenAssetName: datum.token_asset_name,
    lovelace: BigInt(quote.fundedLovelace),
  });

  return {
    txHash: placed.txHash,
    orderAddress: placed.orderAddress,
    tokenAmount: quote.tokenAmount,
    maxSpendLovelace: quote.maxSpendLovelace,
  };
}

export interface MyOrderSummary {
  txHash: string;
  outputIndex: number;
  isBuy: boolean;
  amount: string;
  maxSpend: string;
  deadlineMs: string;
  /** Lovelace the order currently holds. */
  heldLovelace: string;
}

/** The connected wallet's own open orders on this launch. */
async function myOrders(walletAddress: string): Promise<MyOrderSummary[]> {
  const { cfg, sub } = requireConfigured();
  const ownKeyHash = getAddressDetails(walletAddress).paymentCredential?.hash;
  if (!ownKeyHash) {
    throw new Error(`Could not derive a payment key hash from address ${walletAddress}.`);
  }
  const open = await sub.openOrders(cfg.launchIdHex);
  return open
    .filter(({ datum }) => datum.owner === ownKeyHash)
    .map(({ utxo, datum }) => ({
      txHash: utxo.txHash,
      outputIndex: utxo.outputIndex,
      isBuy: datum.is_buy,
      amount: datum.amount.toString(),
      maxSpend: datum.max_spend.toString(),
      deadlineMs: datum.deadline.toString(),
      heldLovelace: (utxo.assets['lovelace'] ?? 0n).toString(),
    }));
}

/**
 * Cancels one of the connected wallet's own orders and returns its funds.
 * A real script spend of the order UTXO, signed by the owner — the
 * non-custodial exit that needs nobody's cooperation.
 */
async function cancelOrder(params: {
  txHash: string;
  outputIndex: number;
  walletApi: WalletApi;
}): Promise<{ txHash: string }> {
  const { cfg, sub } = requireConfigured();
  const open = await sub.openOrders(cfg.launchIdHex);
  const found = open.find(({ utxo }) => utxo.txHash === params.txHash && utxo.outputIndex === params.outputIndex);
  if (!found) {
    throw new Error(
      `No open order ${params.txHash}#${params.outputIndex} on this launch. It may already have been ` +
        'filled, cancelled, or swept.',
    );
  }
  return sub.cancelOrderWithWallet(params.walletApi, found.utxo as UTxO);
}

const NoctisCurveOrder = {
  configure,
  getQuote,
  placeBuyOrder,
  myOrders,
  cancelOrder,
};

declare global {
  interface Window {
    NoctisCurveOrder: typeof NoctisCurveOrder;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisCurveOrder = NoctisCurveOrder;
}

export default NoctisCurveOrder;

// Type-only re-export so the entry's own declared surface names the datum it
// summarises — keeps tsc watching the submitter/widget seam (see the
// type-check-the-widgets lesson recorded with the widget builds).
export type { OrderDatumData };
