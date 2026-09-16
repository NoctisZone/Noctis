// ============================================================================
// Noctis Zone — NoctisSwap: the collection round, and what it discloses
// ============================================================================
// The ledger says what one pool owes and the withdrawal builder moves it. This
// is the thing between them: WHICH pools, and WHEN.
//
// **Two modes, and they weigh the token side differently on purpose.** That
// looks like an inconsistency and is not — the two modes are asking different
// questions, and the alternative to acting differs between them.
//
//   - **threshold** — "is this pool worth going to today?" The alternative is
//     WAITING, which costs nothing: the money does not decay, nothing expires,
//     and the tokens will still be there next time. So only the ADA counter
//     counts, because only it pays for the transaction. The token side is
//     reported and deliberately not acted on.
//   - **sweep** — "we are going anyway; is this pool worth INCLUDING?" The
//     alternative is now EXCLUDING it, not waiting. So the whole value at
//     stake counts, tokens included at what the pool itself would pay for
//     them — and a pool holding nothing worth the fee in either denomination
//     is still left alone, because paying 0.42 ADA to collect dust is not a
//     tidier record, it is a worse one.
//
// **A sweep exists for disclosure, not for profit.** The platform publishes
// its addresses and discloses quarterly; sweeping first means the disclosure
// covers money the platform HAS rather than money it is owed, which is a much
// easier thing to stand behind. It costs one fee per pool — with a hundred
// pools that is about 42 ADA a quarter — so the price of the tidier record is
// small and known in advance.
//
// **Collections are INDEPENDENT of one another, which fills are not.** Two
// fills against one pool must chain, because the second reads state the first
// moved. Two collections against DIFFERENT pools share nothing on chain at
// all: any order, any block, and a failure ends only itself. What links them
// is off chain — the platform's own wallet, since every collection needs a
// UTXO to pay the fee with, and two collections built against the same wallet
// snapshot would name the same one.
//
// So the round PARTITIONS the wallet rather than serialising the work: each
// collection is given its own funding UTXO and none is given the collateral.
// Two consequences an operator should have in front of them:
//
//   - **A round collects from at most as many pools as the wallet has spare
//     UTXOs.** Anything beyond that is deferred to the next round, by name,
//     rather than built and rejected.
//   - **The count is self-sustaining.** Each collection consumes one funding
//     UTXO and produces one change output, so a wallet that starts a round
//     with N spare UTXOs ends it with N. It is the SHAPE of the float that
//     matters, not its size: one large UTXO collects from one pool a round.
//
// **What a round reports is what it SUBMITTED, and that is not yet what
// happened.** Disclosure is built by reading the transactions back off the
// chain — `venueDisclosureFrom` below — so the published figure rests on the
// ledger's own record rather than on this job's intent, and a stranger holding
// the same hashes derives the same total.
// ============================================================================

import type { UTxO as MeshUTxO } from '@meshsdk/core';
import type { CurveSpendWallet } from './mesh-curve-spend.js';
import { readVenuePools, type SkippedUtxo, type VenueChainProvider } from './venue-chain-reader.js';
import {
  VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE,
  type VenueCollectionAdvice,
  type VenueFeeAmount,
  type VenueFeeLedger,
  venueCollectionAdvice,
  venueCollectionFrom,
  venueFeeLedger,
  venueTokenSideLovelace,
  venueTreasuryPosition,
} from './venue-fee-ledger.js';
import type { VenueHistoryProvider } from './venue-pool-history.js';
import { type VenuePoolUtxo, venueUnitOf } from './venue-swap.js';
import {
  planVenueTreasuryWithdrawal,
  type VenueTreasuryWithdrawalPlan,
  type VenueTreasuryWithdrawer,
} from './venue-treasury-withdrawal.js';

/**
 * The ADA counter at which a pool is worth a transaction of its own.
 *
 * Chosen off the curve rather than picked: a collection costs about 0.42 ADA,
 * so the fee is 4.2% of a 10 ADA collection, 1.7% of 25, **0.84% of 50**,
 * 0.42% of 100 and 0.21% of 200. Each doubling halves the share, so the saving
 * from waiting shrinks as fast as the wait grows — and 50 ADA is where it
 * first falls under one percent. Above that the platform is trading a smaller
 * and smaller saving for a longer and longer wait.
 */
export const VENUE_COLLECTION_THRESHOLD_LOVELACE = 50_000_000n;

export type VenueCollectionMode = 'threshold' | 'sweep';

export interface VenueCollectionPolicy {
  /** Defaults to `threshold`. */
  mode?: VenueCollectionMode;
  /** The ADA counter a pool must reach in `threshold` mode. */
  thresholdLovelace?: bigint;
  /**
   * In `sweep` mode, the least a pool must be worth IN TOTAL to be included —
   * its ADA counter plus what the pool would pay for its token counter.
   * Defaults to what one collection costs, so a sweep never spends more on a
   * pool than the pool holds.
   */
  sweepFloorLovelace?: bigint;
  /** What one collection costs. Defaults to the measured figure. */
  costLovelace?: bigint;
  /** Never build more than this many in one round, whatever the wallet holds. */
  maxPerRound?: number;
}

/** What the policy decided about one pool, and why. */
export interface VenueCollectionDecision {
  pool: VenuePoolUtxo;
  poolNft: string;
  collect: boolean;
  reason: string;
  /** The ledger's own reading, always present. */
  advice: VenueCollectionAdvice;
  /**
   * The whole value at stake: the ADA counter plus the token counter at what
   * this pool would pay for it. What `sweep` weighs, and what `threshold`
   * deliberately does not.
   */
  valueLovelace: bigint;
}

export interface VenueCollectionSchedule {
  decisions: VenueCollectionDecision[];
  /** Only those to act on, most valuable first. */
  collect: VenueCollectionDecision[];
  ledger: VenueFeeLedger;
  mode: VenueCollectionMode;
}

/**
 * Which pools this round should collect from, and why each was left alone.
 *
 * Pure, so the decision can be shown to an operator before anything is built.
 */
export function venueCollectionSchedule(args: {
  pools: readonly VenuePoolUtxo[];
  policy?: VenueCollectionPolicy;
}): VenueCollectionSchedule {
  const policy = args.policy ?? {};
  const mode = policy.mode ?? 'threshold';
  const cost = policy.costLovelace ?? VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE;
  const threshold = policy.thresholdLovelace ?? VENUE_COLLECTION_THRESHOLD_LOVELACE;
  const sweepFloor = policy.sweepFloorLovelace ?? cost;

  const decisions = args.pools.map((pool) => {
    const advice = venueCollectionAdvice({ pool, costLovelace: cost });
    const position = venueTreasuryPosition(pool);
    const valueLovelace = position.owedLovelace + (venueTokenSideLovelace(pool) ?? 0n);
    const poolNft = venueUnitOf(pool.datum.pool_nft);
    const nothing = position.owedX <= 0n && position.owedY <= 0n;

    if (nothing) {
      return {
        pool,
        poolNft,
        collect: false,
        reason: 'nothing has accrued to the platform here, and a withdrawal that moves nothing is refused.',
        advice,
        valueLovelace,
      };
    }

    if (mode === 'sweep') {
      const worth = valueLovelace >= sweepFloor;
      return {
        pool,
        poolNft,
        collect: worth,
        reason: worth
          ? `swept: ${position.owedLovelace} lovelace and a token side worth about ` +
            `${valueLovelace - position.owedLovelace}, against a ${sweepFloor} floor.`
          : `left out of the sweep: everything accrued here is worth about ${valueLovelace} lovelace, under ` +
            `the ${sweepFloor} floor. Paying ${cost} to collect it would make the record worse, not tidier.`,
        advice,
        valueLovelace,
      };
    }

    const worth = position.owedLovelace >= threshold;
    return {
      pool,
      poolNft,
      collect: worth,
      reason: worth
        ? `its ${position.owedLovelace} lovelace has reached the ${threshold} threshold, so the ${cost} fee ` +
          'is a small share of what comes back.'
        : `its ${position.owedLovelace} lovelace is under the ${threshold} threshold. Waiting costs nothing ` +
          'here — nothing decays, and the token side comes out with it whenever it does go.',
      advice,
      valueLovelace,
    };
  });

  const collect = decisions
    .filter((d) => d.collect)
    .sort((a, b) => (b.valueLovelace > a.valueLovelace ? 1 : b.valueLovelace < a.valueLovelace ? -1 : 0))
    .slice(0, policy.maxPerRound ?? decisions.length);

  return { decisions, collect, ledger: venueFeeLedger({ pools: args.pools, costLovelace: cost }), mode };
}

/** What became of one pool in a round. */
export type VenueCollectionOutcome =
  | {
      kind: 'submitted';
      poolNft: string;
      txHash: string;
      /** What this collection should move. Not confirmed — see the file header. */
      expected: { lovelace: bigint; tokens: VenueFeeAmount[] };
      plan: VenueTreasuryWithdrawalPlan;
    }
  | { kind: 'skipped'; poolNft: string; reason: string }
  | { kind: 'deferred'; poolNft: string; reason: string }
  | { kind: 'failed'; poolNft: string; reason: string };

export interface VenueCollectionRound {
  outcomes: VenueCollectionOutcome[];
  submitted: number;
  failed: number;
  deferred: number;
  /** What the submitted collections should net, if they all confirm. */
  expectedNetLovelace: bigint;
  schedule: VenueCollectionSchedule;
  /** UTXOs at the pool address the reader declined, each with its reason. */
  skipped: SkippedUtxo[];
}

export interface VenueFeeCollectorConfig {
  provider: VenueChainProvider;
  /** Only `submit` is used, so a round can be exercised without a chain. */
  withdrawer: Pick<VenueTreasuryWithdrawer, 'submit'>;
  wallet: CurveSpendWallet;
  poolAddress: string;
  factoryPolicyId: string;
  network: 'preview' | 'preprod' | 'mainnet';
  policy?: VenueCollectionPolicy;
  /** The platform's stake key, if collections should pay to a base address. */
  payoutStakePkh?: string;
}

/** The whole collection job: read, decide, fund, submit. */
export class VenueFeeCollector {
  constructor(private readonly config: VenueFeeCollectorConfig) {}

  /**
   * One round. Reads every pool, applies the policy, and submits a
   * transaction per pool it decided on.
   *
   * A failure ends only itself. There is nothing to carry forward between
   * collections — different pools share no state — so unlike a round of fills,
   * one failure says nothing about the next.
   */
  async runRound(): Promise<VenueCollectionRound> {
    const read = await readVenuePools(this.config.provider, {
      poolAddress: this.config.poolAddress,
      factoryPolicyId: this.config.factoryPolicyId,
    });
    const schedule = venueCollectionSchedule({ pools: read.pools, policy: this.config.policy });
    const outcomes: VenueCollectionOutcome[] = [];

    for (const decision of schedule.decisions) {
      if (!decision.collect) {
        outcomes.push({ kind: 'skipped', poolNft: decision.poolNft, reason: decision.reason });
      }
    }

    const [collateral, walletUtxos] = await Promise.all([
      this.config.wallet.getCollateral(),
      this.config.wallet.getUtxos(),
    ]);
    const collateralKey = collateral[0]
      ? `${collateral[0].input.txHash}#${collateral[0].input.outputIndex}`
      : undefined;
    // One UTXO each, largest first, and never the collateral: two collections
    // funded from the same UTXO are one double-spend, and the second is
    // refused at the node for a reason that names neither pool.
    const available = walletUtxos
      .filter((utxo) => `${utxo.input.txHash}#${utxo.input.outputIndex}` !== collateralKey)
      .sort((a, b) => {
        const diff = lovelaceOf(b) - lovelaceOf(a);
        return diff === 0n ? 0 : diff > 0n ? 1 : -1;
      });

    let expectedNetLovelace = 0n;
    const cost = this.config.policy?.costLovelace ?? VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE;

    for (const [index, decision] of schedule.collect.entries()) {
      const funding = available[index];
      if (!funding) {
        outcomes.push({
          kind: 'deferred',
          poolNft: decision.poolNft,
          reason:
            `the platform wallet has ${available.length} spare UTXOs and this round wanted to collect from ` +
            `${schedule.collect.length} pools. Each collection needs its own, so this one waits for the next ` +
            'round — every collection returns a change output, so the count does not fall.',
        });
        continue;
      }

      try {
        const plan = planVenueTreasuryWithdrawal({
          pool: decision.pool,
          network: this.config.network,
          ...(this.config.payoutStakePkh ? { payoutStakePkh: this.config.payoutStakePkh } : {}),
        });
        const txHash = await this.config.withdrawer.submit(plan, this.config.wallet, { fundingUtxos: [funding] });
        const position = venueTreasuryPosition(decision.pool);
        outcomes.push({
          kind: 'submitted',
          poolNft: decision.poolNft,
          txHash,
          expected: { lovelace: position.owedLovelace, tokens: position.owedTokens },
          plan,
        });
        expectedNetLovelace += position.owedLovelace - cost;
      } catch (error) {
        outcomes.push({
          kind: 'failed',
          poolNft: decision.poolNft,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      outcomes,
      submitted: outcomes.filter((o) => o.kind === 'submitted').length,
      failed: outcomes.filter((o) => o.kind === 'failed').length,
      deferred: outcomes.filter((o) => o.kind === 'deferred').length,
      expectedNetLovelace,
      schedule,
      skipped: read.skipped,
    };
  }
}

function lovelaceOf(utxo: MeshUTxO): bigint {
  return BigInt(utxo.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');
}

/** One collection as the chain records it, for a published figure. */
export interface VenueDisclosedCollection {
  txHash: string;
  poolNft: string;
  /** What actually left the pool to the platform, by unit. */
  platform: VenueFeeAmount[];
}

export interface VenueDisclosure {
  collections: VenueDisclosedCollection[];
  /** Everything the platform collected over these transactions, by unit. */
  totalByUnit: VenueFeeAmount[];
  /**
   * Hashes that are not platform collections, with why.
   *
   * A transaction that has not reached the chain yet lands here, and so does
   * one that moved the CREATOR's counters instead. Both are things a
   * disclosure must not silently count, and both look like a collection from
   * the job's own record.
   */
  unaccounted: Array<{ txHash: string; reason: string }>;
}

function addTo(totals: Map<string, bigint>, unit: string, amount: bigint): void {
  if (amount === 0n) return;
  totals.set(unit, (totals.get(unit) ?? 0n) + amount);
}

function sortedTotals(totals: Map<string, bigint>): VenueFeeAmount[] {
  return [...totals]
    .map(([unit, amount]) => ({ unit, amount }))
    .sort((a, b) => (a.unit === 'lovelace' ? -1 : b.unit === 'lovelace' ? 1 : a.unit < b.unit ? -1 : 1));
}

/**
 * What the platform actually collected, read back off the chain.
 *
 * The figure a quarterly disclosure publishes should come from here rather
 * than from a round's own record: a round reports what it SUBMITTED, and a
 * submitted transaction is not a confirmed one. Reading it back means the
 * published number rests on the ledger, and anyone holding the same hashes
 * derives the same total without trusting the job that produced them.
 *
 * The creator's counters are read too and deliberately excluded — a royalty
 * claim moves the same pool the same way and would otherwise be counted as
 * platform income.
 */
export async function venueDisclosureFrom(
  provider: VenueHistoryProvider,
  args: { txHashes: readonly string[]; factoryPolicyId: string },
): Promise<VenueDisclosure> {
  const collections: VenueDisclosedCollection[] = [];
  const unaccounted: Array<{ txHash: string; reason: string }> = [];
  const totals = new Map<string, bigint>();

  for (const txHash of args.txHashes) {
    let collected: ReturnType<typeof venueCollectionFrom> = null;
    try {
      const tx = await provider.getTxUtxos(txHash);
      collected = venueCollectionFrom({ tx, factoryPolicyId: args.factoryPolicyId });
    } catch (error) {
      unaccounted.push({
        txHash,
        reason: `the chain has no such transaction: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!collected) {
      unaccounted.push({ txHash, reason: 'on chain, but it did not take fees out of a pool.' });
      continue;
    }
    if (collected.collected.treasuryX === 0n && collected.collected.treasuryY === 0n) {
      unaccounted.push({
        txHash,
        reason: "a collection, but of the creator's royalty counters rather than the platform's.",
      });
      continue;
    }

    const platform: VenueFeeAmount[] = [];
    if (collected.collected.treasuryX > 0n) {
      platform.push({ unit: collected.unitX, amount: collected.collected.treasuryX });
      addTo(totals, collected.unitX, collected.collected.treasuryX);
    }
    if (collected.collected.treasuryY > 0n) {
      platform.push({ unit: collected.unitY, amount: collected.collected.treasuryY });
      addTo(totals, collected.unitY, collected.collected.treasuryY);
    }
    collections.push({ txHash, poolNft: collected.poolNft, platform });
  }

  return { collections, totalByUnit: sortedTotals(totals), unaccounted };
}
