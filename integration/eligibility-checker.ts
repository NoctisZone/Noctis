// ============================================================================
// Noctis Zone — DarkVeil Registration Eligibility Checker
// ============================================================================
//
// Implements the off-chain half of CLAUDE.md's Registration Eligibility list
// (5 checks total). This module now covers checks #1, #2, #4, and #5.
//
//   #1 Wallet age >= 90 days on Cardano .......... checkWalletAge (below)
//   #2 NIGHT balance >= $50 USD ................... checkNightBalance
//       (below). Built 2026-07-13 on two independently-verified real
//       building blocks: `indexer-client.ts`'s `getUnshieldedNightBalance`
//       (a genuine third-party balance query via the public Midnight
//       indexer, not a wallet self-report) and `night-price-oracle.ts`'s
//       `usdToMinNightAtomic` (Minswap NIGHT/ADA TWAP x the ADA/USD price
//       from ada-usd-price.ts —
//       see CLAUDE.md's ORACLE STRATEGY: no NIGHT/USD feed exists, so
//       NIGHT is priced through ADA.
//       there is no sensible universal default, so `checkDarkVeilEligibility`
//       requires it explicitly rather than silently defaulting to preprod.
//   #3 Registrant != creator wallet ............... enforced ON-CHAIN in
//       eligibility_gate.compact / bonding_curve.compact — not an
//       off-chain check, no code needed here.
//   #4 Registrant stake key != creator stake key ... checkStakeKeyMatch
//       (below). Resolved 2026-07-13 — previously described as blocked on
//       "real cross-chain proof machinery," which was a framing mistake:
//       a Cardano base address encodes its stake credential directly in
//       its own bytes (Blockfrost's `/addresses/{address}` exposes it as
//       `stake_address`, no signature needed to read it). This check needs
//       no more proof of ownership than #1/#5 already assume — the
//       DarkVeil allocation Merkle leaf (`hash_dv_leaf` in
//       bonding_curve_tier_b.ak) binds the registrant's VerificationKeyHash,
//       and `ClaimDarkVeilTokens` requires that exact key to sign, so a
//       registrant self-reporting an address they don't control could
//       never actually claim from it. What this check catches: a creator
//       registering from a second payment address that shares their known
//       wallet's stake key (Cardano derives many receive addresses off one
//       stake key by default) — a cheap, common way to dodge check #3's
//       exact-address match. It does not defend against a genuinely fresh,
//       unrelated wallet — that's #5's job (ADA-flow graph) and the
//       N-hop challenge.
//   #5 No direct ADA flow from creator, 90-day lookback ... checkNoDirectAdaFlow
//
// How this plugs into the rest of the system: the platform's off-chain
// registration flow is expected to run `checkDarkVeilEligibility` for every
// would-be registrant BEFORE building the allowlist Merkle tree (see
// `packages/zk-proofs/src/eligibility-gate.ts`'s `buildAllowlistTree`) —
// only wallets that pass get a leaf. The on-chain `verifyAllowlist` circuit
// then just proves membership in that governor-published tree; it has no
// way to independently re-check #1/#4/#5 itself (no access to Cardano
// history inside a Midnight circuit), so the tree's correctness rests on this
// off-chain computation being run honestly — same trust model already
// accepted for cto_governance.compact's balance-snapshot tree.
// ============================================================================

import type { AddressTransaction, BlockfrostClient } from './blockfrost-client.js';
import { getUnshieldedNightBalance } from './indexer-client.js';
import { usdToMinNightAtomic } from './night-price-oracle.js';

const SECONDS_PER_DAY = 86400;

export interface WalletAgeResult {
  eligible: boolean;
  ageDays: number;
  earliestTxHash: string | null;
}

export interface AdaFlowResult {
  eligible: boolean;
  violatingTxHash: string | null;
}

export interface StakeKeyResult {
  eligible: boolean;
  registrantStakeAddress: string | null;
  creatorStakeAddress: string | null;
}

export interface NightBalanceResult {
  eligible: boolean;
  balanceAtomic: bigint;
  minRequiredAtomic: bigint;
  /** Which ADA/USD sources agreed on the price this threshold was computed from. */
  sources: string[];
}

export interface DarkVeilEligibilityOptions {
  minWalletAgeDays: number;
  adaFlowLookbackDays: number;
  minNightUsd: number;
  indexerWsUrl: string;
}

export interface DarkVeilEligibilityResult {
  eligible: boolean;
  checks: {
    walletAge: WalletAgeResult;
    stakeKeyMatch: StakeKeyResult;
    nightBalance: NightBalanceResult;
    noDirectAdaFlow: AdaFlowResult;
  };
}

/**
 * Check #1 — wallet age. Walks the address's full transaction history
 * (oldest first) and compares the earliest transaction's block time
 * against `currentTime`. An address with zero transactions is never
 * eligible (age is undefined, not infinite).
 */
export async function checkWalletAge(
  client: BlockfrostClient,
  address: string,
  minAgeDays: number,
  currentTime: number = Math.floor(Date.now() / 1000),
): Promise<WalletAgeResult> {
  const txs = await client.getAddressTransactionsAll(address);
  if (txs.length === 0) {
    return { eligible: false, ageDays: 0, earliestTxHash: null };
  }
  // getAddressTransactionsAll requests order=asc, so index 0 is the
  // earliest transaction — no separate sort needed.
  const earliest: AddressTransaction = txs[0];
  const ageDays = Math.floor((currentTime - earliest.block_time) / SECONDS_PER_DAY);
  return {
    eligible: ageDays >= minAgeDays,
    ageDays,
    earliestTxHash: earliest.tx_hash,
  };
}

/**
 * Check #4 — registrant's stake key must not match the creator's. Compares
 * the `stake_address` Blockfrost decodes directly from each base address
 * (no signature needed — it's part of the address bytes, not proof of a
 * private key). An address with no stake credential (enterprise or Byron)
 * fails closed: there's nothing to compare, and a real DarkVeil registrant
 * using a staking-incapable address is unusual enough to treat as
 * ineligible rather than silently pass the check. A creator address with
 * no stake credential is the opposite case — there's no stake key for
 * them to have reused, so it correctly can never collide with anything.
 */
/**
 * One value for "this address has no readable stake credential", whether that
 * arrived as null, as an absent field, or as an empty string. Two addresses
 * that both lack one must never compare equal to each other by accident, and
 * an unreadable one must never compare unequal to a real one.
 */
function normaliseStakeAddress(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function checkStakeKeyMatch(
  client: BlockfrostClient,
  registrantAddress: string,
  creatorAddress: string,
): Promise<StakeKeyResult> {
  const [registrantInfo, creatorInfo] = await Promise.all([
    client.getAddress(registrantAddress),
    client.getAddress(creatorAddress),
  ]);
  // Normalised before comparison. The field is TYPED `string | null`, which
  // is what Blockfrost documents, but a dropped field or a changed response
  // shape produces undefined — and undefined is not null, so a `=== null`
  // test falls through to the inequality below and compares a missing value
  // against a real stake address. That comparison is true, which would admit
  // a registrant on the strength of a field nobody could read.
  const registrantStakeAddress = normaliseStakeAddress(registrantInfo.stake_address);
  const creatorStakeAddress = normaliseStakeAddress(creatorInfo.stake_address);

  if (registrantStakeAddress === null) {
    return {
      eligible: false,
      registrantStakeAddress: null,
      creatorStakeAddress,
    };
  }

  return {
    eligible: registrantStakeAddress !== creatorStakeAddress,
    registrantStakeAddress,
    creatorStakeAddress,
  };
}

/**
 * Check #2 — registrant's real NIGHT balance must be worth at least
 * `minUsd`. `balance` comes from a genuine third-party query against the
 * public Midnight indexer (getUnshieldedNightBalance), not a wallet
 * self-report. `minRequiredAtomic` is computed via a real Minswap TWAP x
 * ADA/USD price (usdToMinNightAtomic) — see that module for the
 * ORACLE STRATEGY correction on why there's no direct NIGHT/USD feed.
 */
export async function checkNightBalance(
  indexerWsUrl: string,
  registrantAddress: string,
  minUsd: number,
): Promise<NightBalanceResult> {
  const [{ balance }, threshold] = await Promise.all([
    getUnshieldedNightBalance(indexerWsUrl, registrantAddress),
    usdToMinNightAtomic(minUsd),
  ]);
  return {
    eligible: balance >= threshold.minNightAtomic,
    balanceAtomic: balance,
    minRequiredAtomic: threshold.minNightAtomic,
    sources: threshold.sources,
  };
}

/**
 * Check #5 — no direct ADA flow from the creator's wallet within the
 * lookback window. Scans the registrant's transactions in the window and
 * fetches each one's real inputs/outputs, checking whether the creator's
 * address appears on either side (a direct payment either way, not just
 * "both were in the same multi-party transaction incidentally" — Blockfrost
 * returns the actual address list per input/output, so this only matches a
 * transaction where the creator's address genuinely sent or received value
 * in the same transaction as the registrant).
 *
 * This makes one Blockfrost call per transaction in the window, which is
 * the honest cost of a real per-transaction check — no shortcut exists
 * that doesn't require inspecting each transaction's real participants.
 */
export async function checkNoDirectAdaFlow(
  client: BlockfrostClient,
  registrantAddress: string,
  creatorAddress: string,
  lookbackDays: number,
  currentTime: number = Math.floor(Date.now() / 1000),
): Promise<AdaFlowResult> {
  const cutoff = currentTime - lookbackDays * SECONDS_PER_DAY;
  const allTxs = await client.getAddressTransactionsAll(registrantAddress);
  const recentTxs = allTxs.filter((tx) => tx.block_time >= cutoff);

  for (const tx of recentTxs) {
    const utxos = await client.getTxUtxos(tx.tx_hash);
    const creatorInvolved =
      utxos.inputs.some((input) => input.address === creatorAddress) ||
      utxos.outputs.some((output) => output.address === creatorAddress);
    if (creatorInvolved) {
      return { eligible: false, violatingTxHash: tx.tx_hash };
    }
  }
  return { eligible: true, violatingTxHash: null };
}

/**
 * Runs checks #1, #2, #4, and #5 together for a single registrant. Check #3
 * (registrant != creator) is enforced on-chain, not here.
 */
export async function checkDarkVeilEligibility(
  client: BlockfrostClient,
  registrantAddress: string,
  creatorAddress: string,
  options: DarkVeilEligibilityOptions,
  currentTime?: number,
): Promise<DarkVeilEligibilityResult> {
  const [walletAge, stakeKeyMatch, nightBalance, noDirectAdaFlow] = await Promise.all([
    checkWalletAge(client, registrantAddress, options.minWalletAgeDays, currentTime),
    checkStakeKeyMatch(client, registrantAddress, creatorAddress),
    checkNightBalance(options.indexerWsUrl, registrantAddress, options.minNightUsd),
    checkNoDirectAdaFlow(client, registrantAddress, creatorAddress, options.adaFlowLookbackDays, currentTime),
  ]);
  return {
    eligible: walletAge.eligible && stakeKeyMatch.eligible && nightBalance.eligible && noDirectAdaFlow.eligible,
    checks: { walletAge, stakeKeyMatch, nightBalance, noDirectAdaFlow },
  };
}
