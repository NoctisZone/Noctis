// ============================================================================
// Noctis Zone — Staking Rewards Pool governor reward accountant
// ============================================================================
// The off-chain half staking_pool.ak's whole reward model depends on (see
// that file's own header): computes each staker's cumulative accrued
// reward from real, publicly observable stake/unstake events, builds the
// Merkle tree ClaimRewards verifies against, for PublishRewardRoot to
// anchor. Independently re-derivable by anyone from public chain data —
// not a hidden computation, same auditability property every other
// governor-published root in this codebase already has (e.g.
// hasClaimableBalance, the DarkVeil allowlist tree, cto_governance's
// balance-snapshot tree).
//
// Reward formula, verbatim from CLAUDE.md's STAKING REWARDS section:
//   - daily_emission = pool_balance / duration_days — computed ONCE from
//     the pool's INITIAL seeded amount (at Graduate) and the creator's
//     chosen duration, then held FIXED. A later TopUpPool call adds to the
//     pool's balance WITHOUT changing this rate — it extends the runway
//     further into the future rather than accelerating payouts (this file
//     never recomputes dailyEmission from a later, larger balance).
//   - Each day's emission splits pro-rata among positions that are past
//     their 7-day bonding period as of that day, weighted by staked_amount.
//   - The on-chain contract's only real invariant is that cumulative
//     claims never exceed the pool's real token balance. This file is what
//     has to keep that true, and it does so with two explicit limits, NOT
//     by construction — see computeRewardSnapshot's own comment on both.
//
// A day on which nobody is seasoned distributes nothing, and does not
// count against the runway. So a pool's real end date is always later than
// poolStart + durationDays by however many quiet days it saw: the runway
// is a budget of distributing days, not a calendar deadline.
//
// durationDays has NO on-chain representation at all (staking_pool.ak's
// own header: "no stored duration, end-timestamp, or emission-rate field
// on-chain") — it must be supplied by the caller, sourced from the launch
// CPT's own staking_duration_days meta (the creator's 3/4/5-year runway
// choice at launch creation, per create-wizard.php).
//
// KNOWN LIMITATION, flagged honestly rather than silently glossed over:
// this reconstructs the FULL real stake/unstake history for a launch's
// staking_pool address (not just currently-live positions) by scanning
// every transaction at that address — necessary because a staker's
// entitlement to rewards earned during a PAST position doesn't disappear
// once they unstake (ClaimRewards is keyed by staker_vkh against the
// Pool's own claimed_so_far, not tied to any specific Position UTXO still
// existing). This is a real, bounded-size per-launch scan (not a full-
// chain index), same class of full-history walk eligibility-checker.ts/
// cto-balance-snapshot-builder.ts already do for other purposes.
// ============================================================================

import { Data } from '@lucid-evolution/lucid';
import {
  buildRewardTree,
  clearedNullifierHex,
  hashRewardLeaf,
  type RewardTree,
  verifyRewardMerkleProof,
} from './staking-reward-tree.js';
import { type StakingDatumData, StakingDatumSchema, threadNftAssetName } from './tier-a-schemas.js';

interface BlockfrostConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function bf<T>(config: BlockfrostConfig, path: string): Promise<T> {
  const res = await fetch(`${config.blockfrostUrl}${path}`, {
    headers: { project_id: config.blockfrostProjectId },
  });
  if (!res.ok) {
    throw new Error(`Blockfrost ${path} returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface BfAddressTx {
  tx_hash: string;
  block_time: number;
}

interface BfTxUtxos {
  inputs: Array<{ tx_hash: string; output_index: number }>;
  outputs: Array<{
    output_index: number;
    inline_datum: string | null;
    /** Blockfrost returns every output's full value here, so the quantities
     *  below need no second request per output. */
    amount?: Array<{ unit: string; quantity: string }>;
  }>;
}

function quantityOf(output: BfTxUtxos['outputs'][number], unit: string): bigint {
  const entry = output.amount?.find((a) => a.unit === unit);
  return entry ? BigInt(entry.quantity) : 0n;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface StakeEvent {
  stakerVkh: string;
  stakedAmount: bigint;
  stakeTimestampMs: number;
  /** null = still staked as of the scan. */
  unstakeTimestampMs: number | null;
}

export interface StakeHistory {
  events: StakeEvent[];
  /** The Pool UTXO's real token balance immediately after the genesis Graduate seed — the base dailyEmission is derived from THIS, never a later balance. */
  initialSeededAmount: bigint;
  /**
   * Every reward token the pool has ever held: the genesis seed plus every
   * later top-up, each read as a real INCREASE in the authenticated Pool
   * UTXO's own balance rather than taken from a redeemer.
   *
   * This is the ceiling on everything the pool can ever owe. A top-up raises
   * it without touching `dailyEmission`, which is what makes a top-up extend
   * the runway rather than accelerate payouts.
   */
  totalBudget: bigint;
  /** Real block time of the first transaction touching this address for this launch (the Graduate seed) — dailyEmission accrual starts counting from here. */
  poolStartTimestampMs: number;
}

/**
 * Scans the full real transaction history of staking_pool.ak's shared
 * address for one launch, reconstructing every stake (Position output
 * created) and unstake (that same Position input later spent) event, plus
 * the pool's real initial seeded balance.
 */
export async function fetchStakeHistory(
  config: BlockfrostConfig,
  stakingPoolAddress: string,
  launchIdHex: string,
  tokenPolicyId: string,
  tokenAssetName: string,
  threadNftPolicyId: string,
): Promise<StakeHistory> {
  if (!threadNftPolicyId) {
    throw new Error(
      'threadNftPolicyId is required: the genesis pool output is identified by the launch thread NFT, ' +
        "and that policy must come from the caller's own record of the launch. Reading it from the datum " +
        'under inspection would let a forged output nominate its own policy and pass.',
    );
  }
  const txs = await (async () => {
    let all: BfAddressTx[] = [];
    let page = 1;
    while (true) {
      const batch = await bf<BfAddressTx[]>(
        config,
        `/addresses/${stakingPoolAddress}/transactions?page=${page}&order=asc&count=100`,
      );
      all = all.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    return all;
  })();

  if (txs.length === 0) {
    throw new Error(`No transactions found at staking_pool address ${stakingPoolAddress} — pool was never seeded.`);
  }

  // outputRef (txHash:outputIndex) -> index into events[], for matching a
  // later spend back to the stake event it closes out.
  const openPositions = new Map<string, number>();
  const events: StakeEvent[] = [];
  let initialSeededAmount: bigint | null = null;
  // The authenticated Pool UTXO's balance as of the last transaction that
  // produced one, and the running sum of every increase since genesis.
  let poolBalance = 0n;
  let totalToppedUp = 0n;
  const poolStartTimestampMs = txs[0].block_time * 1000;
  const tokenUnit = tokenPolicyId + tokenAssetName;
  const poolThreadNftUnit = threadNftPolicyId + threadNftAssetName('stakingPool', launchIdHex);

  for (const tx of txs) {
    const utxos = await bf<BfTxUtxos>(config, `/txs/${tx.tx_hash}/utxos`);

    // Close out any positions this transaction spent.
    for (const input of utxos.inputs) {
      const key = `${input.tx_hash}:${input.output_index}`;
      const idx = openPositions.get(key);
      if (idx !== undefined) {
        events[idx].unstakeTimestampMs = tx.block_time * 1000;
        openPositions.delete(key);
      }
    }

    // Record any Pool/Position outputs this transaction created.
    for (const output of utxos.outputs) {
      if (!output.inline_datum) continue;
      let decoded: StakingDatumData;
      try {
        decoded = Data.from<StakingDatumData>(output.inline_datum, StakingDatumSchema);
      } catch {
        continue;
      }
      if ('Pool' in decoded && decoded.Pool[0].launch_id === launchIdHex) {
        // A GENUINE Pool output for this launch. The first one is the genesis
        // seed; every later one carries the balance forward, and any INCREASE
        // in it is a real top-up.
        //
        // Genuine is the load-bearing word. Everything above is the datum's
        // own claim, and paying an output to a script address runs no
        // validator, so anyone can write `Pool` and this launch_id. This
        // figure becomes `dailyEmission`, which decides every reward the
        // launch ever mints — so an inflated forgery landing in an EARLIER
        // transaction than the real seed would be taken as genesis and
        // overpay for the pool's whole life. First-wins is correct for
        // "genesis"; it is what makes ordering worth attacking.
        //
        // The pool's thread NFT is what settles it, under the policy the
        // CALLER supplies from its own record of the launch — never the one
        // this datum nominates, which a forger would simply set to their own.
        // Same pair `pool_thread_nft_intact` checks on-chain.
        if (quantityOf(output, poolThreadNftUnit) !== 1n) continue;
        // Its real token balance isn't in the datum itself (only the
        // nullifier is), so this reads the real UTXO value.
        const balance = quantityOf(output, tokenUnit);
        if (initialSeededAmount === null) {
          initialSeededAmount = balance;
        } else if (balance > poolBalance) {
          // The pool only ever gains reward tokens through TopUpPool, and
          // that redeemer's own `amount` is checked on-chain against exactly
          // this difference. Reading the difference rather than the redeemer
          // keeps this derived from value, like every other figure here.
          totalToppedUp += balance - poolBalance;
        }
        poolBalance = balance;
      } else if ('Position' in decoded && decoded.Position[0].launch_id === launchIdHex) {
        const pos = decoded.Position[0];
        // The REAL token quantity, exactly as the Pool branch above does it
        // and for the same reason. Paying a UTXO to a script address runs no
        // validator, so a position's datum is a claim by whoever created it —
        // `staked_amount` can say anything at all while the output holds
        // nothing. Rewards accrue by weight, so believing that claim would
        // hand out a share of the pool to a staker who never staked, and
        // Unstake would not even notice: it pays out the output's real value,
        // so the claim costs its author nothing to make.
        const realStaked = quantityOf(output, tokenUnit);
        if (realStaked === 0n) continue; // holds no stake; not a position
        events.push({
          stakerVkh: pos.staker_vkh,
          stakedAmount: realStaked,
          stakeTimestampMs: Number(pos.stake_timestamp),
          unstakeTimestampMs: null,
        });
        openPositions.set(`${tx.tx_hash}:${output.output_index}`, events.length - 1);
      }
    }
  }

  if (initialSeededAmount === null) {
    throw new Error(`No Pool genesis output found for launch_id ${launchIdHex} at ${stakingPoolAddress}.`);
  }

  return {
    events,
    initialSeededAmount,
    totalBudget: initialSeededAmount + totalToppedUp,
    poolStartTimestampMs,
  };
}

const MS_PER_DAY = 86_400_000;

/**
 * Day-by-day pro-rata accrual — see file header for the formula. Pure
 * function, no I/O, independently re-derivable by anyone with the same
 * real chain-observed events.
 */
export function computeRewardSnapshot(
  events: StakeEvent[],
  poolStartTimestampMs: number,
  nowMs: number,
  initialSeededAmount: bigint,
  durationDays: number,
  bondingPeriodDays: number,
  /**
   * Every reward token the pool has ever held — genesis seed plus top-ups,
   * from `fetchStakeHistory`. Defaults to the seed alone so a caller that
   * knows of no top-up still gets a budget rather than none.
   */
  totalBudget: bigint = initialSeededAmount,
): Map<string, bigint> {
  const dailyEmission = initialSeededAmount / BigInt(durationDays);
  const totals = new Map<string, bigint>();
  if (dailyEmission <= 0n) return totals;

  const totalDays = Math.floor((nowMs - poolStartTimestampMs) / MS_PER_DAY);

  // The limit the pool's on-chain balance invariant rests on, and it is NOT
  // implied by the loop bound: `totalDays` is elapsed real time, which keeps
  // growing long after the tokens run out.
  //
  // The budget is the only stopping condition. `durationDays` sets the RATE
  // and nothing else, which is what gives the two documented behaviours for
  // free: a day with no seasoned staker pays nobody and retires no budget, so
  // quiet stretches push the end date out rather than burning tokens; and a
  // top-up raises the budget without touching the rate, so it buys more days
  // at the same emission instead of accelerating payouts. A day-count cap
  // would defeat both.
  let unallocated = totalBudget;

  for (let day = 0; day < totalDays && unallocated > 0n; day++) {
    const dayStartMs = poolStartTimestampMs + day * MS_PER_DAY;

    const eligible = events.filter((e) => {
      const seasonedByMs = e.stakeTimestampMs + bondingPeriodDays * MS_PER_DAY;
      const stillStakedAtDayStart = e.unstakeTimestampMs === null || e.unstakeTimestampMs > dayStartMs;
      return seasonedByMs <= dayStartMs && stillStakedAtDayStart;
    });
    if (eligible.length === 0) continue;

    const totalWeight = eligible.reduce((sum, e) => sum + e.stakedAmount, 0n);
    if (totalWeight <= 0n) continue;

    // The last day of a runway has less left than a whole day's emission.
    // Paying the remainder is right; paying a full day out of a budget that
    // cannot cover it is what makes a published root promise more than the
    // pool holds.
    const budgetToday = dailyEmission < unallocated ? dailyEmission : unallocated;

    let distributedToday = 0n;
    for (const e of eligible) {
      const share = (budgetToday * e.stakedAmount) / totalWeight;
      if (share <= 0n) continue;
      totals.set(e.stakerVkh, (totals.get(e.stakerVkh) ?? 0n) + share);
      distributedToday += share;
    }

    // Shares are floored, so the day's rounding dust stays unallocated and is
    // carried into later days rather than silently written off.
    unallocated -= distributedToday;
  }

  return totals;
}

export interface StakingRewardSnapshotConfig {
  stakingPoolAddress: string;
  launchIdHex: string;
  tokenPolicyId: string;
  tokenAssetName: string;
  /**
   * The launch's thread-NFT policy id, from the caller's OWN record of the
   * launch — `np_launch_meta_thread_nft_policy_id` on the WordPress side.
   *
   * Deliberately not read from the datum being inspected: that is what a
   * forged pool output would nominate for itself. This is the one field that
   * makes the genesis read evidence rather than a claim.
   */
  threadNftPolicyId: string;
  /** Creator's chosen runway (STAKING_DURATION_MIN_DAYS..MAX_DAYS, 1095-1825) — sourced from the launch CPT, no on-chain representation exists. */
  durationDays: number;
  /** STAKING_BONDING_PERIOD_DAYS, 7. */
  bondingPeriodDays?: number;
  /**
   * What each staker has ALREADY been paid, by key hash, across every root
   * published so far.
   *
   * A leaf carries what this root pays, not a running total, because the pool
   * records only WHO has claimed against the current root — one bit each —
   * and not how much each has drawn. So the delta has to be computed here.
   *
   * Maintain it with `foldClaimedRoot`: after a root's window, fold that
   * root's entries against the nullifier the chain shows, and whatever was
   * claimed is added. Anything unclaimed is simply not added, so it reappears
   * in the next root by itself. Omit for a pool that has never published.
   */
  alreadyPaid?: Map<string, bigint>;
}

export interface StakingRewardSnapshotResult {
  tree: RewardTree;
  /** This root's leaves, in index order — position IS the staker's bit. */
  entries: Array<{ stakerVkh: string; payoutAmount: bigint }>;
  /** The cleared nullifier this root must be published with. */
  claimedBitsHex: string;
  initialSeededAmount: bigint;
  /** Genesis seed plus every top-up — the ceiling on everything the pool can owe. */
  totalBudget: bigint;
  dailyEmission: bigint;
}

/** Real I/O wrapper — fetches real history, computes the real formula, builds the real tree. */
export async function buildStakingRewardSnapshot(
  config: BlockfrostConfig,
  snapshotConfig: StakingRewardSnapshotConfig,
): Promise<StakingRewardSnapshotResult> {
  const { events, initialSeededAmount, totalBudget, poolStartTimestampMs } = await fetchStakeHistory(
    config,
    snapshotConfig.stakingPoolAddress,
    snapshotConfig.launchIdHex,
    snapshotConfig.tokenPolicyId,
    snapshotConfig.tokenAssetName,
    snapshotConfig.threadNftPolicyId,
  );

  const totals = computeRewardSnapshot(
    events,
    poolStartTimestampMs,
    Date.now(),
    initialSeededAmount,
    snapshotConfig.durationDays,
    snapshotConfig.bondingPeriodDays ?? 7,
    totalBudget,
  );

  if (totals.size === 0) {
    throw new Error('No stakers have accrued any reward yet — nothing to publish.');
  }

  // Accrued-to-date minus what has already been paid. A staker with nothing
  // owed this round gets no leaf at all rather than a zero one: the contract
  // requires a positive payout, so a zero leaf would be unclaimable and would
  // only consume a bit.
  const alreadyPaid = snapshotConfig.alreadyPaid ?? new Map<string, bigint>();
  const entries = Array.from(totals.entries())
    .map(([stakerVkh, cumulativeAmount]) => ({
      stakerVkh,
      payoutAmount: cumulativeAmount - (alreadyPaid.get(stakerVkh) ?? 0n),
    }))
    .filter((e) => e.payoutAmount > 0n);

  if (entries.length === 0) {
    throw new Error('Every staker is already paid up to date — nothing to publish.');
  }

  const tree = buildRewardTree(
    entries.map((e) => ({
      stakerVkh: hexToBytes(e.stakerVkh),
      payoutAmount: e.payoutAmount,
    })),
  );

  // Self-check every entry's own proof before ever publishing — catches a
  // construction bug locally instead of discovering it only when a real
  // on-chain claim fails, same discipline dv-allocation-tree.ts's own
  // verifyDvMerkleProof exists for.
  entries.forEach((e, i) => {
    const leaf = hashRewardLeaf(hexToBytes(e.stakerVkh), e.payoutAmount, i);
    if (!verifyRewardMerkleProof(tree.root, leaf, tree.getProof(i))) {
      throw new Error(`Internal error: reward tree self-check failed for staker ${e.stakerVkh} at index ${i}.`);
    }
  });

  return {
    tree,
    entries,
    claimedBitsHex: clearedNullifierHex(entries.length),
    initialSeededAmount,
    totalBudget,
    dailyEmission: initialSeededAmount / BigInt(snapshotConfig.durationDays),
  };
}

/** Builds one specific staker's proof from an already-built entry list — for a claim REST route to hand a holder their own proof without recomputing the whole tree per request. */
export function getRewardProof(
  entries: Array<{ stakerVkh: string; payoutAmount: bigint }>,
  stakerVkhHex: string,
): {
  proof: Array<{ sibling: string; goesLeft: boolean }>;
  payoutAmount: bigint;
  /** The staker's bit in the pool's nullifier. The claim must carry it. */
  leafIndex: number;
} | null {
  const idx = entries.findIndex((e) => e.stakerVkh === stakerVkhHex);
  if (idx === -1) return null;
  const tree = buildRewardTree(
    entries.map((e) => ({
      stakerVkh: hexToBytes(e.stakerVkh),
      payoutAmount: e.payoutAmount,
    })),
  );
  const proof = tree.getProof(idx).map((step) => ({
    sibling: Buffer.from(step.sibling).toString('hex'),
    goesLeft: step.goesLeft,
  }));
  const entry = entries[idx];
  if (!entry) return null;
  return { proof, payoutAmount: entry.payoutAmount, leafIndex: idx };
}

/**
 * Fold a published root's outcome into the running already-paid totals.
 *
 * `claimedBitsHex` is the pool's nullifier as the chain shows it after that
 * root's claims. A set bit means that leaf was paid; a clear one means it was
 * not, and that amount will simply reappear in the next root because nothing
 * is added for it here.
 *
 * Pure, and derived only from public data — the entry list the governor
 * published and the pool datum anyone can read — so the running total is
 * independently reproducible rather than a private ledger.
 */
export function foldClaimedRoot(
  entries: Array<{ stakerVkh: string; payoutAmount: bigint }>,
  claimedBitsHex: string,
  runningPaid: Map<string, bigint> = new Map(),
): Map<string, bigint> {
  const bits = hexToBytes(claimedBitsHex);
  const out = new Map(runningPaid);
  entries.forEach((e, i) => {
    const byte = bits[i >> 3];
    if (byte === undefined) {
      throw new Error(
        `foldClaimedRoot: nullifier is ${bits.length} byte(s) but entry ${i} needs bit ${i} — ` +
          'it does not belong to this entry list.',
      );
    }
    const claimed = (byte & (0x80 >> (i % 8))) !== 0;
    if (claimed) {
      out.set(e.stakerVkh, (out.get(e.stakerVkh) ?? 0n) + e.payoutAmount);
    }
  });
  return out;
}
