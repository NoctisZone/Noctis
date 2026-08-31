// ============================================================================
// Noctis Zone — Staking Rewards Pool Widget: browser entry point
// ============================================================================
// Webpack browser target (see ../webpack.widgets.config.cjs) — bundled to
// assets/js/staking-widget.bundle.js in the theme, enqueued on any launch page
// where staking_enabled is true, same pattern inc/enqueue.php already uses for
// tier-a-buy-widget.bundle.js/darkveil-widget.bundle.js. On Webpack (not
// esbuild) for the same reason those two are — this bundle pulls in
// @lucid-evolution/lucid's CML/WASM dependency, which needs webpack's real
// native WASM-as-ESM support.
//
// Exposes window.NoctisStaking, the same "plain object of async functions the
// theme's vanilla JS calls directly" shape as window.NoctisTierABuy.
//
// EVERYTHING HERE IS CLIENT-SIDE, AND NOW GENUINELY SO
// Stake, unstake and claim are browser-wallet-signed, and the figures behind
// them are read from the pool's own state rather than served by the platform.
// There is no reward-proof route to call any more, no snapshot to be published
// and nothing this widget has to be told: the pool computes what it owes, so
// the browser can compute the same thing from the same public state and check
// its work against the chain.
//
// The one call that used to reach the server — getMyRewardProof — is gone with
// the mechanism behind it.
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import { type PoolOverview, type StakingConfig, StakingSubmitter } from '../staking-submitter.js';

export interface StakingWidgetConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** staking_pool.ak's compiled PlutusV3 script CBOR — read server-side (PHP), inlined here same as tier-a-buy-widget-entry.ts's compiledScriptCbor. */
  compiledScriptCbor: string;
  launchIdHex: string;
  /** The launch's thread-NFT policy id, hex, as rendered by the platform for
   *  this launch. The pool UTXO is authenticated against it. */
  threadNftPolicyId: string;
}

/** Everything a page needs about the pool, with bigints stringified for JS. */
export interface StakingPoolSummary {
  tokenUnit: string;
  /** Tokens staked across everyone. */
  totalStaked: string;
  /** Reward tokens not yet credited to anyone. */
  unallocated: string;
  emissionPerDay: string;
  stakerCount: number;
  /** Staked tokens plus the reward budget — the pool's whole balance. */
  poolTokenBalance: string;
  /**
   * What one token staked earns per year at the CURRENT participation. Null
   * while nothing is staked: the rate is undefined then, not infinite, because
   * the first staker's return depends on who joins them.
   */
  currentAprPercent: number | null;
  /** Days of budget left at the current participation. Null while nothing is staked. */
  runwayDaysRemaining: number | null;
  exhaustedAtMs: string | null;
  /** When an exhausted pool may be retired. A top-up before then revives it. */
  closesAfterMs: string | null;
  positions: StakingPositionSummary[];
}

export interface StakingPositionSummary {
  stakerVkhHex: string;
  stakedAmount: string;
  /** Claimable right now. */
  owed: string;
  /** When the position last grew. */
  sinceMs: string;
  /** Real ms since epoch this position may be closed — adding to a stake restarts it, claiming does not. */
  unstakeUnlocksAtMs: string;
}

let config: StakingWidgetConfig | null = null;
let submitter: StakingSubmitter | null = null;

function requireSubmitter(): StakingSubmitter {
  if (!config || !submitter) {
    throw new Error('NoctisStaking.configure() must be called before any other method.');
  }
  return submitter;
}

function configure(newConfig: StakingWidgetConfig): void {
  config = newConfig;
  const submitterConfig: StakingConfig = {
    blockfrostProjectId: newConfig.blockfrostProjectId,
    blockfrostUrl: newConfig.blockfrostUrl,
    network: newConfig.network,
    stakingPoolScriptCbor: newConfig.compiledScriptCbor,
    launchIdHex: newConfig.launchIdHex,
    threadNftPolicyId: newConfig.threadNftPolicyId,
  };
  submitter = new StakingSubmitter(submitterConfig);
}

function summarise(overview: PoolOverview): StakingPoolSummary {
  return {
    tokenUnit: overview.tokenUnit,
    totalStaked: overview.totalStaked.toString(),
    unallocated: overview.unallocated.toString(),
    emissionPerDay: overview.emissionPerDay.toString(),
    stakerCount: overview.stakerCount,
    poolTokenBalance: overview.poolTokenBalance.toString(),
    currentAprPercent: overview.currentAprPercent,
    runwayDaysRemaining: overview.runwayDaysRemaining,
    exhaustedAtMs: overview.exhaustedAtMs === null ? null : overview.exhaustedAtMs.toString(),
    closesAfterMs: overview.closesAfterMs === null ? null : overview.closesAfterMs.toString(),
    positions: overview.positions.map((p) => ({
      stakerVkhHex: p.stakerVkhHex,
      stakedAmount: p.stakedAmount.toString(),
      owed: p.owed.toString(),
      sinceMs: p.sinceMs.toString(),
      unstakeUnlocksAtMs: p.unstakeUnlocksAtMs.toString(),
    })),
  };
}

/**
 * The whole pool: budget, rate, every open position and what each is owed.
 *
 * One read serves both the pool-wide view and any one wallet's own row, so a
 * page does not need a second call to show a connected wallet its position.
 */
async function getPoolState(): Promise<StakingPoolSummary> {
  return summarise(await requireSubmitter().overview());
}

/** One wallet's own position, or null when it has none open. */
async function getMyPosition(stakerAddress: string): Promise<StakingPositionSummary | null> {
  const overview = await requireSubmitter().overview();
  const { getAddressDetails } = await import('@lucid-evolution/lucid');
  const vkh = getAddressDetails(stakerAddress).paymentCredential?.hash;
  if (!vkh) throw new Error('Could not derive a payment-credential key hash from the connected wallet.');
  return summarise(overview).positions.find((p) => p.stakerVkhHex === vkh) ?? null;
}

/**
 * Open or add to a position.
 *
 * Anything already owed is compounded into the stake rather than paid out —
 * those tokens are already in the pool, so nothing has to move for it. Adding
 * restarts the seven-day unstake lock; claiming does not.
 */
async function stake(params: { amount: string; walletApi: WalletApi }): Promise<{ txHash: string }> {
  return requireSubmitter().stakeWithWallet(params.walletApi, BigInt(params.amount));
}

/**
 * Close the connected wallet's position: the stake and everything owed on it.
 *
 * No position reference is needed any more. A wallet has at most one position
 * per pool — they are entries under one root now, not separate UTXOs — so
 * there is nothing to choose between.
 */
async function unstake(params: { walletApi: WalletApi }): Promise<{ txHash: string }> {
  return requireSubmitter().unstakeWithWallet(params.walletApi);
}

/** Take what is owed and leave the position open. */
async function claimRewards(params: { walletApi: WalletApi }): Promise<{ txHash: string }> {
  return requireSubmitter().claimRewardsWithWallet(params.walletApi);
}

/**
 * Add to the pool's reward budget.
 *
 * Exposed to the browser because it is genuinely permissionless: anyone may
 * give a pool tokens, and doing so extends its runway at the same rate rather
 * than accelerating payouts. The creator is the expected caller; nothing
 * requires it to be them.
 */
async function topUp(params: { amount: string; walletApi: WalletApi }): Promise<{ txHash: string }> {
  return requireSubmitter().topUpWithWallet(params.walletApi, BigInt(params.amount));
}

const NoctisStaking = {
  configure,
  getPoolState,
  getMyPosition,
  stake,
  unstake,
  claimRewards,
  topUp,
};

declare global {
  interface Window {
    NoctisStaking: typeof NoctisStaking;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisStaking = NoctisStaking;
}

export default NoctisStaking;
