// ============================================================================
// Noctis Zone — Staking Rewards Pool Widget: browser entry point
// ============================================================================
// Webpack browser target (see ../webpack.widgets.config.cjs) — bundled to
// assets/js/staking-widget.bundle.js in the theme, enqueued on any launch
// page where staking_enabled is true, same pattern inc/enqueue.php already
// uses for tier-a-buy-widget.bundle.js/darkveil-widget.bundle.js. On
// Webpack (not esbuild) for the same reason those two are — this bundle
// pulls in @lucid-evolution/lucid's CML/WASM dependency, which needs
// webpack's real native WASM-as-ESM support.
//
// Exposes window.NoctisStaking, same "plain object of async functions the
// theme's vanilla JS calls directly" shape as window.NoctisTierABuy.
//
// Stake/Unstake/ClaimRewards are all real browser-wallet-signed
// (staking-submitter.ts's *WithWallet methods) — nothing here ever touches
// a governor/creator key. TopUpPool and PublishRewardRoot are NOT exposed
// here at all (server-signed only, via staking-actions.php's REST routes/
// WP-Cron) — a holder-facing widget has no business holding either key.
//
// getMyRewardProof() is the one method that DOESN'T run entirely client-
// side — it calls the plugin's own REST route (np/v1/staking/reward-proof/
// {launch}/{staker}), since the proof is built from the governor's
// server-cached last-published snapshot (staking-reward-tree-builder.ts's
// full on-chain history scan is too slow to re-run per page load — see
// staking-actions.php's own header for why).
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import { type StakingConfig, type StakingPosition, StakingSubmitter } from '../staking-submitter.js';

export interface StakingWidgetConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** staking_pool.ak's compiled PlutusV3 script CBOR — read server-side (PHP), inlined here same as tier-a-buy-widget-entry.ts's compiledScriptCbor. */
  compiledScriptCbor: string;
  launchIdHex: string;
  /** The launch's thread-NFT policy id, hex, as rendered by the platform for
   *  this launch. Its state UTXOs are authenticated against it. */
  threadNftPolicyId: string;
  /** Same-origin REST base for getMyRewardProof(), e.g. `${site}/wp-json/np/v1/`. */
  restBaseUrl: string;
}

export interface StakingPoolStateSummary {
  rewardRootHex: string;
  tokenPolicyId: string;
  tokenAssetName: string;
}

export interface StakingPositionSummary {
  txHash: string;
  outputIndex: number;
  stakedAmount: string;
  stakeTimestampMs: string;
  /** Real ms since epoch this position clears the 7-day bonding period (STAKING_BONDING_PERIOD_DAYS) — for the panel's countdown display. */
  bondingEndsAtMs: string;
}

let config: StakingWidgetConfig | null = null;
let submitter: StakingSubmitter | null = null;
const BONDING_PERIOD_DAYS = 7;
const MS_PER_DAY = 86_400_000;

function requireSubmitter(): StakingSubmitter {
  if (!config || !submitter) {
    throw new Error('NoctisStaking.configure() must be called before any other method.');
  }
  return submitter;
}

/** Same guarantee as requireSubmitter(), for call sites that need the raw config object. */
function requireConfig(): StakingWidgetConfig {
  if (!config) {
    throw new Error('NoctisStaking.configure() must be called before any other method.');
  }
  return config;
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

async function getPoolState(): Promise<StakingPoolStateSummary> {
  const s = requireSubmitter();
  const pool = await s.readPoolDatum();
  return {
    rewardRootHex: pool.reward_root,
    tokenPolicyId: pool.token_policy_id,
    tokenAssetName: pool.token_asset_name,
  };
}

async function getMyPositions(stakerAddress: string): Promise<StakingPositionSummary[]> {
  const s = requireSubmitter();
  const positions = await s.findPositions(stakerAddress);
  return positions.map((p) => ({
    txHash: p.utxo.txHash,
    outputIndex: p.utxo.outputIndex,
    stakedAmount: p.datum.staked_amount.toString(),
    stakeTimestampMs: p.datum.stake_timestamp.toString(),
    bondingEndsAtMs: (Number(p.datum.stake_timestamp) + BONDING_PERIOD_DAYS * MS_PER_DAY).toString(),
  }));
}

async function stake(params: { amount: string; walletApi: WalletApi }): Promise<{ txHash: string }> {
  const s = requireSubmitter();
  return s.stakeWithWallet(params.walletApi, BigInt(params.amount));
}

/** `positionRef` identifies which of the connected wallet's positions to close — from a prior getMyPositions() call. */
async function unstake(params: {
  positionTxHash: string;
  positionOutputIndex: number;
  walletApi: WalletApi;
}): Promise<{ txHash: string }> {
  const s = requireSubmitter();
  const cfg = requireConfig();
  const stakerAddress = await (async () => {
    const { Lucid, Blockfrost } = await import('@lucid-evolution/lucid');
    const lucid = await Lucid(new Blockfrost(cfg.blockfrostUrl, cfg.blockfrostProjectId), cfg.network);
    lucid.selectWallet.fromAPI(params.walletApi);
    return lucid.wallet().address();
  })();
  const positions = await s.findPositions(stakerAddress);
  const position = positions.find(
    (p) => p.utxo.txHash === params.positionTxHash && p.utxo.outputIndex === params.positionOutputIndex,
  );
  if (!position) throw new Error('Position not found for the connected wallet.');
  return s.unstakeWithWallet(params.walletApi, position as StakingPosition);
}

/** Fetches this staker's proof from the plugin's own REST route, then submits ClaimRewards with it. */
async function claimRewards(params: {
  walletApi: WalletApi;
  stakerAddress: string;
}): Promise<{ txHash: string; payout: string }> {
  const s = requireSubmitter();
  const { getAddressDetails } = await import('@lucid-evolution/lucid');
  const stakerVkhHex = getAddressDetails(params.stakerAddress).paymentCredential?.hash;
  if (!stakerVkhHex) throw new Error('Could not derive a payment-credential key hash from the connected wallet.');

  const cfg = requireConfig();
  const res = await fetch(
    `${cfg.restBaseUrl}staking/reward-proof/${cfg.launchIdHex}/${stakerVkhHex}?network=${encodeURIComponent(cfg.network.toLowerCase())}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || `No claimable reward found (HTTP ${res.status}).`);
  }
  // What the CURRENT root pays, plus this staker's bit in the pool's
  // nullifier. The bit is hashed into their leaf, so the proof only verifies
  // when presented against that one bit.
  const { proof, payoutAmount, leafIndex, alreadyClaimed } = (await res.json()) as {
    proof: Array<{ sibling: string; goesLeft: boolean }>;
    payoutAmount: string;
    leafIndex: number;
    alreadyClaimed: boolean;
  };
  // The snapshot still lists a leaf after it has been drawn — only the pool's
  // nullifier records that. Building the claim anyway would spend fees on a
  // transaction the validator refuses, and report it as a wallet failure.
  if (alreadyClaimed) {
    throw new Error('You have already claimed this reward. The next snapshot will include anything earned since.');
  }

  const result = await s.claimRewardsWithWallet(params.walletApi, BigInt(payoutAmount), leafIndex, proof);
  return { txHash: result.txHash, payout: result.payout.toString() };
}

const NoctisStaking = {
  configure,
  getPoolState,
  getMyPositions,
  stake,
  unstake,
  claimRewards,
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
