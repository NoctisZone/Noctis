// ============================================================================
// Noctis Zone — the linear curve Creator Dashboard Widget: browser entry point
// ============================================================================
// Webpack browser target (integration/webpack.widgets.config.cjs) — bundled
// to assets/js/tier-a-dashboard-widget.bundle.js in the theme, enqueued only
// on a creator's own dashboard page for a linear-curve launch, following the exact
// pattern inc/enqueue.php already uses for tier-a-buy-widget.bundle.js on
// lp-chart-buy.php.
//
// Exposes window.NoctisTierADashboard, a plain object of async functions the
// theme's vanilla JS calls directly from DOM event handlers — same shape as
// window.NoctisTierABuy (tier-a-buy-widget-entry.ts).
//
// WHY THIS IS A SEPARATE BUNDLE: ClaimVested (vesting.ak) and
// ClaimCreatorFees (bonding_curve.ak) are both custom-Plutus-redeemer
// spends — the same Anvil-can't-do-this gap tier-a-buy-widget-entry.ts's
// own header already documents for BuyTokens. This widget needs Lucid
// Evolution running IN THE BROWSER, signing via the connected wallet's real
// CIP-30 API, via tier-a-claims-submitter.ts's claimVestedWithWallet()/
// claimCreatorFeesWithWallet().
//
// HONEST SCOPE — read before wiring a template to this:
//
// 1. Same Blockfrost-key-in-page-source limitation as tier-a-buy-widget-
//    entry.ts's own scope note — not solved here either.
//
// 2. This widget only ever calls the *WithWallet() variants (creator-
//    signed via their own connected wallet). The private-key-based
//    claimVested()/claimCreatorFees() (this session's CLI verification
//    path) are deliberately NOT exposed here — same reasoning as the buy
//    widget never exposing ActivateCurve or the mnemonic-based buyTokens().
//
// 3. getVestingState() computes `vestedToDate`/`claimable` CLIENT-SIDE using
//    the browser's real current wall-clock time (Date.now()), mirroring
//    vesting.ak's own exact formula (token_allocation * elapsed_ms /
//    vest_ms, floor division) — this is the real, honest "how much can
//    I claim right now" figure for an actual creator, not a backdated test
//    value. It reads live on-chain state on every call (no caching), same
//    "stale price could get a tx rejected" reasoning as the buy widget's
//    getCurveState().
//
// 4. Every timestamp here is MILLISECONDS, because that is the unit the
//    chain supplies and the validator compares in: `vest_start_timestamp`
//    is stored from a value bound to the transaction's validity range, and
//    vesting.ak measures the schedule as vest_days * 86_400_000. Mixing
//    seconds into either the display arithmetic or the claim call does not
//    shift the answer slightly — it puts the two operands a thousandfold
//    apart, so the subtraction below would go negative and the widget would
//    report nothing as claimable no matter how much had actually vested.
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import { getAddressDetails } from '@lucid-evolution/lucid';
import { usdToMinAdaLovelace } from '../ada-price-oracle.js';
import { type TierAClaimsConfig, TierAClaimsSubmitter } from '../tier-a-claims-submitter.js';

/** The platform's flat claim fee, in USD — same figure cli/claim-creator-fees-tier-a.ts pays. */
const PLATFORM_CLAIM_FEE_USD = 1;

export interface TierADashboardWidgetConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** vesting.ak's compiled PlutusV3 script CBOR — plutus.json's
   *  validators[].compiledCode for vesting.vesting.spend. */
  vestingScriptCbor: string;
  /** bonding_curve.ak's compiled PlutusV3 script CBOR — plutus.json's
   *  validators[].compiledCode for bonding_curve.bonding_curve.spend. */
  bondingCurveScriptCbor: string;
  launchIdHex: string;
  /** The launch's thread-NFT policy id, hex, as rendered by the platform for
   *  this launch. Its state UTXOs are authenticated against it. */
  threadNftPolicyId: string;
}

export interface VestingStateSummary {
  vestingState: string;
  tokenAllocation: string;
  claimedTokens: string;
  vestDays: string;
  vestStartTimestamp: string;
  /** Computed client-side against real current time — floor(token_allocation * elapsedMs / (vestDays*86_400_000)). */
  vestedToDate: string;
  /** vestedToDate - claimedTokens, floored at 0. */
  claimable: string;
}

export interface CreatorFeesStateSummary {
  creatorFeesAccrued: string;
  ctoTriggered: boolean;
}

let config: TierADashboardWidgetConfig | null = null;
let submitter: TierAClaimsSubmitter | null = null;

function requireSubmitter(): TierAClaimsSubmitter {
  if (!config || !submitter) {
    throw new Error('NoctisTierADashboard.configure() must be called before any other method.');
  }
  return submitter;
}

function configure(newConfig: TierADashboardWidgetConfig): void {
  config = newConfig;
  const submitterConfig: TierAClaimsConfig = {
    blockfrostProjectId: newConfig.blockfrostProjectId,
    blockfrostUrl: newConfig.blockfrostUrl,
    network: newConfig.network,
    vestingScriptCbor: newConfig.vestingScriptCbor,
    bondingCurveScriptCbor: newConfig.bondingCurveScriptCbor,
    launchIdHex: newConfig.launchIdHex,
    threadNftPolicyId: newConfig.threadNftPolicyId,
  };
  submitter = new TierAClaimsSubmitter(submitterConfig);
}

/** The subset of vesting.ak's datum the schedule arithmetic below needs. */
export interface VestingScheduleFields {
  vesting_state: string;
  vest_start_timestamp: bigint;
  vest_days: bigint;
  token_allocation: bigint;
}

/**
 * vesting.ak's own ClaimVested formula, evaluated client-side so the
 * dashboard can show a live "claimable now" figure.
 *
 * MILLISECONDS on both sides. `vest_start_timestamp` was stored from a value
 * bound to a transaction's validity range, and the validator measures the
 * schedule as `vest_days * 86_400_000`. Feeding this a seconds-scale `nowMs`
 * does not shift the answer a little — it makes `elapsedMs` negative by
 * roughly the epoch itself, so the guard below holds vestedToDate at zero
 * and the creator is shown nothing claimable however much has vested.
 *
 * Exported so the arithmetic is testable on its own; the browser entry point
 * supplies Date.now().
 */
export function computeVestedToDate(datum: VestingScheduleFields, nowMs: bigint): bigint {
  if (datum.vesting_state !== 'Vesting' && datum.vesting_state !== 'FullyClaimed') return 0n;
  const elapsedMs = nowMs - datum.vest_start_timestamp;
  const vestMs = datum.vest_days * 86_400_000n;
  if (elapsedMs <= 0n || vestMs <= 0n) return 0n;
  // Floor division, matching the validator exactly — a UI that rounded up
  // would offer a claim the contract then refuses.
  const vested = (datum.token_allocation * elapsedMs) / vestMs;
  return vested > datum.token_allocation ? datum.token_allocation : vested;
}

async function getVestingState(): Promise<VestingStateSummary> {
  const s = requireSubmitter();
  const datum = await s.readVestingDatum();

  const vestedToDate = computeVestedToDate(datum, BigInt(Date.now()));
  const claimableRaw = vestedToDate - datum.claimed_tokens;
  const claimable = claimableRaw > 0n ? claimableRaw : 0n;

  return {
    vestingState: datum.vesting_state,
    tokenAllocation: datum.token_allocation.toString(),
    claimedTokens: datum.claimed_tokens.toString(),
    vestDays: datum.vest_days.toString(),
    vestStartTimestamp: datum.vest_start_timestamp.toString(),
    vestedToDate: vestedToDate.toString(),
    claimable: claimable.toString(),
  };
}

async function getCreatorFeesState(): Promise<CreatorFeesStateSummary> {
  const s = requireSubmitter();
  const datum = await s.readCurveDatum();
  return {
    creatorFeesAccrued: datum.creator_fees_accrued.toString(),
    ctoTriggered: datum.cto_triggered,
  };
}

/**
 * Real claim. `claimAmount` must be a whole number of tokens (as a string,
 * to survive JSON/DOM round-tripping without float precision loss) — the
 * caller (theme JS) is responsible for not exceeding getVestingState()'s
 * live `claimable` figure, not a stale server-rendered value.
 */
async function claimVested(params: { claimAmount: string; walletApi: WalletApi }): Promise<{ txHash: string }> {
  const s = requireSubmitter();
  const currentTimestampMs = Date.now();
  const result = await s.claimVestedWithWallet(params.walletApi, BigInt(params.claimAmount), currentTimestampMs);
  return { txHash: result.txHash };
}

/**
 * Claiming accrued creator fees also pays the platform's flat $1 claim fee,
 * which the contract enforces a floor on. The submitter stays oracle-agnostic
 * by design, so the live ADA/USD conversion happens here — the same place and
 * the same way cli/claim-creator-fees-tier-a.ts does it, so a creator pays the
 * same real figure whether they claim from the dashboard or the CLI.
 *
 * `usdToMinAdaLovelace` throws rather than guessing if the price sources
 * disagree or are unreachable, which surfaces to the caller as a failed claim
 * instead of a transaction the chain rejects for underpaying.
 */
async function claimCreatorFees(params: { amount: string; walletApi: WalletApi }): Promise<{ txHash: string }> {
  const s = requireSubmitter();
  const { minLovelace: platformClaimFeeLovelace } = await usdToMinAdaLovelace(PLATFORM_CLAIM_FEE_USD);
  const result = await s.claimCreatorFeesWithWallet(params.walletApi, BigInt(params.amount), platformClaimFeeLovelace);
  return { txHash: result.txHash };
}

/**
 * Derives a connected wallet's payment-credential key hash from its bech32
 * address — WeldPress's own wallet state doesn't expose this directly
 * (only the bech32 address itself), so the theme's glue JS calls this to
 * compare against the launch's real on-chain creator_pub_key_hash before
 * showing the claim panels. Same derivation
 * tier-a-curve-submitter.ts's buyerKeyHashFromAddress() already uses
 * server/CLI-side, exposed here for the browser.
 */
function getPaymentKeyHash(address: string): string | null {
  return getAddressDetails(address).paymentCredential?.hash ?? null;
}

const NoctisTierADashboard = {
  configure,
  getVestingState,
  getCreatorFeesState,
  claimVested,
  claimCreatorFees,
  getPaymentKeyHash,
};

declare global {
  interface Window {
    NoctisTierADashboard: typeof NoctisTierADashboard;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisTierADashboard = NoctisTierADashboard;
}

export default NoctisTierADashboard;
