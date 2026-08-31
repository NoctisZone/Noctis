// ============================================================================
// Noctis Zone — the linear curve Buy Widget: browser entry point
// ============================================================================
// esbuild browser target (see ../build.mjs's tierABuyWidgetConfig) — bundled
// to assets/js/tier-a-buy-widget.bundle.js in the theme, enqueued only on
// The linear curve curve_live launch pages (lp-chart-buy.php), following the exact
// pattern inc/enqueue.php already uses for darkveil-widget.bundle.js on
// DarkVeil-phase pages and create.js on /create/.
//
// Exposes window.NoctisTierABuy, a plain object of async functions the
// theme's vanilla JS calls directly from DOM event handlers — same shape as
// window.NoctisDarkVeil (darkveil-widget-entry.ts) and window.WeldPress
// (weldpress's own main.js).
//
// WHY THIS IS A SEPARATE BUNDLE FROM THE MINT FLOW (create.js): BuyTokens is
// a custom-Plutus-redeemer spend on bonding_curve.ak — confirmed (Phase 4
// this session) that Anvil's REST API cannot build these at all, unlike a
// mint (a native-script build Anvil CAN do, which is why create.js's PAY
// button could just call noctis-platform's existing np/v1/tx/build+submit
// REST routes). This widget needs Lucid Evolution running IN THE BROWSER,
// signing via the connected wallet's real CIP-30 API — the exact same
// pattern darkveil-claim-submitter.ts already proved out for Cardano Launch's
// buyer-signed ClaimDarkVeilTokens, reused here via
// integration/tier-a-curve-submitter.ts's buyTokensWithWallet().
//
// HONEST SCOPE — read before wiring a template to this:
//
// 1. configure() needs a real Blockfrost project ID + URL to run Lucid
//    Evolution client-side. Passing them directly (as this module does,
//    at face value) embeds the Blockfrost key in page source — the SAME
//    known, already-flagged limitation darkveil-widget-entry.ts's own
//    claimTierB already ships with (see that file's scope note 3). Not
//    solved here either; a same-origin WordPress proxy route is the real
//    fix, tracked but not yet built for either widget.
//
// 2. This widget only ever calls buyTokensWithWallet() (buyer-signed).
//    ActivateCurve (governor-signed) and the mnemonic-based buyTokens()
//    (this session's CLI verification path) are deliberately NOT exposed
//    here — a buy widget has no business holding a governor key or a raw
//    mnemonic, and neither should ever reach a browser bundle.
//
// 3. getCurveState() reads live on-chain state on every call (no caching) —
//    correct for "what can I actually buy right now," but means a slow
//    network makes the pre-buy preview slow too. Deliberate: a stale cached
//    price would let a user believe they are buying at a price that is no
//    longer current. The contract computes the real charge itself, so a
//    stale preview misleads rather than mis-prices — which is why the
//    preview is read fresh rather than cached.
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import { rebuildCapAccumulator } from '../cap-accumulator-from-history.js';
import type { CapAccumulator } from '../cap-accumulator-tree.js';
import {
  curvePriceAt,
  LucidTierACurveSubmitter,
  type LucidTierACurveSubmitterConfig,
} from '../tier-a-curve-submitter.js';
import { TierATradeHistoryReader } from '../tier-a-trade-history-reader.js';

export interface TierABuyWidgetConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve.ak's compiled PlutusV3 script CBOR — plutus.json's
   *  validators[].compiledCode for bonding_curve.bonding_curve.spend.
   *  Read server-side (PHP) and inlined here since a browser bundle can't
   *  read the repo's plutus.json file directly. */
  compiledScriptCbor: string;
  launchIdHex: string;
  /** The launch's thread-NFT policy id, hex, as rendered by the platform for
   *  this launch. Its state UTXOs are authenticated against it. */
  threadNftPolicyId: string;
}

export interface CurveStateSummary {
  curveState: string;
  tokensSold: string;
  curveSupply: string;
  remaining: string;
  currentPriceLovelace: string;
  basePrice: string;
  maxPrice: string;
  /** The per-wallet lifetime cap. The curve commits to every wallet's running
   *  total in its `cap_root`, so a buy is checked against everything that
   *  wallet already holds, not against this one transaction's size. */
  walletCapTokens: string;
}

let config: TierABuyWidgetConfig | null = null;
let submitter: LucidTierACurveSubmitter | null = null;

function requireSubmitter(): LucidTierACurveSubmitter {
  if (!config || !submitter) {
    throw new Error('NoctisTierABuy.configure() must be called before any other method.');
  }
  return submitter;
}

function configure(newConfig: TierABuyWidgetConfig): void {
  config = newConfig;
  const submitterConfig: LucidTierACurveSubmitterConfig = {
    blockfrostProjectId: newConfig.blockfrostProjectId,
    blockfrostUrl: newConfig.blockfrostUrl,
    network: newConfig.network,
    compiledScriptCbor: newConfig.compiledScriptCbor,
    launchIdHex: newConfig.launchIdHex,
    threadNftPolicyId: newConfig.threadNftPolicyId,
  };
  submitter = new LucidTierACurveSubmitter(submitterConfig);
}

/**
 * Live on-chain curve state, for a pre-buy preview (current price, how many
 * tokens a given ADA amount actually buys, remaining headroom under the 5%
 * cap). Pass `buyerAddress` (the connected wallet's own address) to also get
 * that buyer's own prior-purchase total.
 */
async function getCurveState(_buyerAddress?: string): Promise<CurveStateSummary> {
  const s = requireSubmitter();
  const datum = await s.readCurveDatum();
  const remaining = datum.curve_supply - datum.tokens_sold;
  const currentPrice = datum.curve_state === 'Active' ? curvePriceAt(datum, datum.tokens_sold) : 0n;

  return {
    curveState: datum.curve_state,
    tokensSold: datum.tokens_sold.toString(),
    curveSupply: datum.curve_supply.toString(),
    remaining: remaining.toString(),
    currentPriceLovelace: currentPrice.toString(),
    basePrice: datum.base_price.toString(),
    maxPrice: datum.max_price.toString(),
    walletCapTokens: datum.wallet_cap.toString(),
  };
}

/**
 * The launch's cap accumulator, rebuilt from its own public trade history and
 * checked against the `cap_root` the curve datum carries.
 *
 * Read fresh on every buy rather than cached, for the same reason
 * getCurveState() is: another wallet's trade moves the root, and a stale
 * accumulator derives a proof the validator rejects. `rebuildCapAccumulator`
 * refuses to return one that doesn't derive the on-chain root, so a partial
 * history read fails here rather than at signing time.
 */
async function loadCapState(): Promise<CapAccumulator> {
  const s = requireSubmitter();
  const cfg = config as TierABuyWidgetConfig;
  const datum = await s.readCurveDatum();
  const reader = new TierATradeHistoryReader({
    blockfrostProjectId: cfg.blockfrostProjectId,
    blockfrostUrl: cfg.blockfrostUrl,
    bondingCurveAddress: s.curveAddress,
    launchIdHex: cfg.launchIdHex,
    tier: 'A',
  });
  return rebuildCapAccumulator(reader, datum.cap_root);
}

/**
 * Real buy. `tokenAmount` must be a whole number of tokens (as a string, to
 * survive JSON/DOM round-tripping without float precision loss) — the
 * caller (theme JS) is responsible for converting a user's ADA input into a
 * token amount using getCurveState()'s live currentPriceLovelace, not a
 * stale server-rendered price.
 */
async function buy(params: { tokenAmount: string; walletApi: WalletApi }): Promise<{
  txHash: string;
  grossPayment: string;
  avgPrice: string;
}> {
  const s = requireSubmitter();
  const capState = await loadCapState();
  const result = await s.buyTokensWithWallet(params.walletApi, BigInt(params.tokenAmount), capState);
  return {
    txHash: result.txHash,
    grossPayment: result.grossPayment.toString(),
    avgPrice: result.avgPrice.toString(),
  };
}

const NoctisTierABuy = {
  configure,
  getCurveState,
  buy,
};

declare global {
  interface Window {
    NoctisTierABuy: typeof NoctisTierABuy;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisTierABuy = NoctisTierABuy;
}

export default NoctisTierABuy;
