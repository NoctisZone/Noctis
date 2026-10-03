// ============================================================================
// Noctis Zone — NoctisSwap: the batcher service
// ============================================================================
// The reader finds the work and the filler builds one transaction. This is the
// loop between them, and almost all of its difficulty is a single consequence
// of the two-input rule: **a pool fills one order per transaction, so a round
// of work against one pool is a CHAIN, not a set.**
//
// Everything below follows from that.
//
//   **The state a round was read at is only correct for the first fill.** Each
//   fill spends the pool output the last one made, so the second order in a
//   pool's queue meets a pool that has already moved — a worse price, and a
//   floor it may no longer clear. So the runner carries each successor forward
//   and RE-ASKS whether the next order is still fillable against it, rather
//   than trusting what the reader computed before any of this ran. Skipping
//   that re-check is the defect this module exists to avoid: the fills would
//   be built against a state that no longer exists, and every one of them
//   would be refused by the order's own price floor at the node, for a reason
//   the failure does not state.
//
//   **A failure ends that pool's chain for the round, and nothing else.** After
//   a fill fails there are two possibilities — the transaction never reached
//   the chain, or it reached it and the reply did not come back — and the
//   runner cannot tell them apart. Every later fill in that chain is built on
//   whichever answer is true. So the chain stops and the next round re-reads
//   the chain, which is the only authority on the question. Other pools are
//   untouched: their chains never shared an input with this one.
//
//   **Chain depth is exposure.** A chained transaction is invalid if its parent
//   never lands, so a run of ten fills against one pool is one transaction's
//   fate shared by ten. `maxFillsPerPool` bounds it.
//
// **What the executor's float actually has to be.** A fill has two inputs and
// neither is the executor's — the order pays for its own execution — so the
// batcher never funds a fill and never needs working capital to run one. Its
// only ada at risk is COLLATERAL, which a Plutus spend must name and which is
// taken only if the transaction is accepted and then a script fails. That is a
// materially smaller custody question than a batcher that fronts trades, and
// it is worth stating plainly before the hosting and key-custody decisions get
// made around a larger one.
//
// **Four outcomes, because they mean four different things to whoever is
// watching.** `filled` is work done. `unfillable` is the normal resting state
// of an order waiting for a price — quiet, not a fault. `declined` is this
// batcher choosing not to, under a rule stated here. `failed` is the only one
// that is ever an alarm. A monitor that cannot tell an idle market from a
// broken one will page for the first and stay silent through the second.
//
// Every order the reader returns comes back in exactly one of the four. The
// reader's own discipline — nothing declined without a reason — continues
// here, because a batcher that reports two fills out of five while saying
// nothing about the other three is indistinguishable from one that is broken.
// ============================================================================

import { Data, getAddressDetails, type Network as LucidNetwork } from '@lucid-evolution/lucid';
import { deserializeTx } from '@meshsdk/core-cst';
import type { CurveNetwork, CurveSpendWallet } from './mesh-curve-spend.js';
import {
  readVenueFillRound,
  type SkippedUtxo,
  type VenueChainProvider,
  type VenueFillCandidate,
  type VenueLiquidityCandidate,
  type VenueWithdrawCandidate,
} from './venue-chain-reader.js';
import type { VenueFiller, VenueFillPlan } from './venue-fill-submitter.js';
import { planVenueLiquidityFill, type VenueLiquidityOrderUtxo, venueLiquidityFillable } from './venue-liquidity.js';
import { VenuePoolConfigSchema } from './venue-pool.js';
import type { VenueWithdrawOrderUtxo } from './venue-royalty-shapes.js';
import { planVenueRoyaltyWithdrawFill } from './venue-royalty-withdraw.js';
import {
  planVenueSwapFill,
  type VenueOrderPosition,
  type VenuePoolUtxo,
  type VenueSwapConfigData,
  VenueSwapConfigSchema,
  type VenueSwapOrderUtxo,
  venueFillableAmount,
  venueFillSequence,
  venueUnitOf,
} from './venue-swap.js';

/**
 * The two libraries name the same chains differently, and an operator should
 * set one value rather than two that can disagree.
 */
const LUCID_NETWORK: Record<CurveNetwork, LucidNetwork> = {
  preview: 'Preview',
  preprod: 'Preprod',
  mainnet: 'Mainnet',
};

/**
 * How many fills the runner will chain against ONE pool in a single round.
 *
 * Not a throughput limit — it is how much of one transaction's fate the runner
 * is willing to share. Each chained fill spends the output the one before it
 * made, so a dropped parent invalidates the whole tail. Ten fills against a
 * single pool inside one round is already a busy market, and the round after
 * this one is seconds away.
 */
export const VENUE_MAX_FILLS_PER_POOL = 10;

/**
 * How long an output a fill spent is assumed to linger in the index.
 *
 * Blockfrost lists a spent output for seconds to a minute after the block that
 * spent it, and a round read in that window sees an order that is already
 * filled and a pool output that no longer exists. Building on them is refused
 * at evaluation, which costs a failed fill and ends that pool's chain for the
 * round. Five minutes is generous: if a fill never landed, its order waits
 * that long and is then filled as normal.
 */
export const VENUE_SPENT_MEMORY_MS = 5 * 60_000;

export interface VenueBatcherConfig {
  provider: VenueChainProvider;
  filler: VenueFiller;
  /**
   * The executor's wallet. Custody of this key is an operations decision the
   * service deliberately does not make: it is asked for a change address, a
   * collateral UTXO and a signature, and never for a secret.
   */
  wallet: CurveSpendWallet;
  network: CurveNetwork;
  poolAddress: string;
  orderAddress: string;
  /**
   * The deposit and redeem request addresses. Unset, the batcher fills swaps
   * only; set, it fills requests to add and remove liquidity too, in the same
   * chain order as everything else.
   */
  depositAddress?: string;
  redeemAddress?: string;
  /**
   * The royalty-withdraw request address. Set, the batcher fills creators'
   * requests to take their pool royalty, in the same chain order as everything
   * else. The filler then needs the withdraw scripts too.
   */
  withdrawAddress?: string;
  /** The factory's minting policy — what makes a pool a pool. Required. */
  factoryPolicyId: string;
  /** The protocol's minimum for an output, from the protocol parameters. */
  minOutputLovelace: bigint;
  /** What one fill costs; `VENUE_FILL_FLOOR_LOVELACE` unless measured again. */
  fillCostLovelace?: bigint;
  /** What the executor keeps beyond the network fee. See `buildSettled`. */
  executorPayoutLovelace?: bigint;
  /**
   * Where the executor's payment goes. The platform wallet on a live site, so
   * that revenue lands at the one address every fee does and the executor's
   * own wallet is not split into an output per fill. Its own address if unset.
   */
  executorPayoutAddress?: string;
  /** Chained fills against one pool. Defaults to `VENUE_MAX_FILLS_PER_POOL`. */
  maxFillsPerPool?: number;
  /**
   * A ceiling on the whole round, for an operator who wants one.
   *
   * A wall-clock guard rather than a derived figure — unset, a round does all
   * the work it finds.
   */
  maxFillsPerRound?: number;
  /**
   * Order and pool outputs an earlier round spent, as `txHash#index`, which
   * the index may still list. Orders among them, and orders whose pool output
   * is among them, are declined rather than built against spent inputs. A
   * `run` loop carries its own rounds' forward; a caller that runs one round a
   * process passes what the last round reported in `spent`.
   */
  recentlySpent?: readonly string[];
}

/** A fill that reached the chain. */
export interface VenueFilledOrder {
  status: 'filled';
  order: VenueSwapOrderUtxo;
  txHash: string;
  traded: bigint;
  /** What the executor kept: the network fee plus the smallest legal payout. */
  exFeeTaken: bigint;
  networkFee: bigint;
}

/** An order nobody can fill as things stand. The normal state of a resting order. */
export interface VenueUnfillableOutcome {
  status: 'unfillable';
  order: VenueSwapOrderUtxo;
  reason: string;
}

/** An order this batcher will not fill, under a rule of its own. */
export interface VenueDeclinedOutcome {
  status: 'declined';
  order: VenueSwapOrderUtxo;
  reason: string;
}

/** A fill that was attempted and did not happen. The only alarming outcome. */
export interface VenueFailedOutcome {
  status: 'failed';
  order: VenueSwapOrderUtxo;
  reason: string;
}

export type VenueFillOutcome = VenueFilledOrder | VenueUnfillableOutcome | VenueDeclinedOutcome | VenueFailedOutcome;

/**
 * What happened to one deposit or redeem request. The same four outcomes as a
 * swap, and they mean the same things, except that a request has no price to
 * wait for: `unfillable` here means it never will be, and says why.
 */
export type VenueLiquidityOutcome =
  | {
      status: 'filled';
      order: VenueLiquidityOrderUtxo;
      txHash: string;
      /** LQ the pool released (a deposit) or took back (a redeem). */
      lq: bigint;
      exFeeTaken: bigint;
      networkFee: bigint;
    }
  | { status: 'unfillable' | 'declined' | 'failed'; order: VenueLiquidityOrderUtxo; reason: string };

/**
 * What happened to one royalty-withdraw request. `unfillable` means no
 * executor can fill it as the pool stands, most often because it was signed
 * before another withdrawal moved the pool's nonce; its placer can refund it.
 */
export type VenueWithdrawOutcome =
  | {
      status: 'filled';
      order: VenueWithdrawOrderUtxo;
      txHash: string;
      /** The request's fee, all of which the executor keeps; the network fee is paid out of it. */
      exFeeTaken: bigint;
      networkFee: bigint;
    }
  | { status: 'unfillable' | 'declined' | 'failed'; order: VenueWithdrawOrderUtxo; reason: string };

export interface VenueBatcherRound {
  /** One per order read, in the order fills are obliged to follow. */
  outcomes: VenueFillOutcome[];
  /** One per deposit or redeem request read, in the same chain order. */
  liquidityOutcomes: VenueLiquidityOutcome[];
  /** One per royalty-withdraw request read, in the same chain order. */
  withdrawOutcomes: VenueWithdrawOutcome[];
  /** UTXOs at either address the reader declined, each with a reason. */
  skipped: SkippedUtxo[];
  filled: number;
  failed: number;
  /**
   * Every order and pool output this round's fills spent, as `txHash#index`:
   * what the next round should skip while the index catches up.
   */
  spent: string[];
}

function keyHashOf(address: string): string {
  const hash = getAddressDetails(address).paymentCredential?.hash;
  if (!hash) {
    throw new Error(
      `Could not derive a payment key hash from the executor's change address ${address}. An order that ` +
        'names permitted executors needs one to know whether this batcher is among them.',
    );
  }
  return hash;
}

function orderKey(order: { txHash: string; outputIndex: number }): string {
  return `${order.txHash}#${order.outputIndex}`;
}

/** One piece of the round's work, whichever kind of order it is. */
type RoundWork =
  | { kind: 'swap'; candidate: VenueFillCandidate; outputIndex: number; placedAt?: VenueOrderPosition }
  | { kind: 'liquidity'; candidate: VenueLiquidityCandidate; outputIndex: number; placedAt?: VenueOrderPosition }
  | { kind: 'withdraw'; candidate: VenueWithdrawCandidate; outputIndex: number; placedAt?: VenueOrderPosition };

/**
 * Runs rounds of fills against the venue.
 *
 * `runRound` is the unit and holds all of the behaviour; `run` is a loop
 * around it that survives a provider outage rather than exiting on one.
 */
/**
 * A failed fill's reason, whatever was thrown: an Error's message, or its
 * name when the message is empty; a string as itself; anything else
 * serialised, so a refusal from a builder or a provider never reaches the
 * operator as an empty string.
 */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
    return `${error.message || error.name}${cause}`;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error).slice(0, 600);
  } catch {
    return String(error);
  }
}

export class VenueBatcher {
  /**
   * Where each transaction sits in the chain, kept between rounds.
   *
   * An order's placement is what the fill sequence rests on, and it takes a
   * request per transaction to learn. Without this the cost of a round grows
   * with the size of the resting book and is paid again every few seconds for
   * facts that do not change.
   *
   * **Bounded, and one caveat.** It is pruned each round to the transactions
   * that still hold resting orders, so it tracks the open book rather than
   * history. The caveat is that a rollback can genuinely move a transaction to
   * a different block, and a cached placement would keep the old answer — so
   * `forgetPlacements` exists, and an operator who has seen a rollback should
   * call it. Within a round the reader looks up nothing twice regardless.
   */
  private placements = new Map<string, VenueOrderPosition>();

  /** Outputs spent by recent fills, and until when to keep skipping them. */
  private spentUntil = new Map<string, number>();

  constructor(private readonly config: VenueBatcherConfig) {
    const until = Date.now() + VENUE_SPENT_MEMORY_MS;
    for (const ref of config.recentlySpent ?? []) this.spentUntil.set(ref, until);
  }

  /** Drops every cached placement, so the next round re-reads them all. */
  forgetPlacements(): void {
    this.placements = new Map();
  }

  /**
   * Reads the chain once and works down what it finds.
   *
   * The sequence is the reader's, unaltered — fills follow the order the chain
   * accepted the orders in, and this makes no choice about which order meets a
   * price. What it does decide is when to STOP: an order gated to other
   * executors, a pool whose chain has already failed this round, and a pool
   * that has been filled as deep as the round allows.
   */
  async runRound(): Promise<VenueBatcherRound> {
    const round = await readVenueFillRound(this.config.provider, {
      poolAddress: this.config.poolAddress,
      orderAddress: this.config.orderAddress,
      factoryPolicyId: this.config.factoryPolicyId,
      fillCostLovelace: this.config.fillCostLovelace,
      positions: this.placements,
      ...(this.config.depositAddress ? { depositAddress: this.config.depositAddress } : {}),
      ...(this.config.redeemAddress ? { redeemAddress: this.config.redeemAddress } : {}),
      ...(this.config.withdrawAddress ? { withdrawAddress: this.config.withdrawAddress } : {}),
      network: LUCID_NETWORK[this.config.network],
      minOutputLovelace: this.config.minOutputLovelace,
    });

    const outcomes = new Map<string, VenueFillOutcome>();
    const liquidityOutcomes = new Map<string, VenueLiquidityOutcome>();
    const withdrawOutcomes = new Map<string, VenueWithdrawOutcome>();
    for (const entry of round.liquidityUnfillable) {
      liquidityOutcomes.set(orderKey(entry.order), { status: 'unfillable', order: entry.order, reason: entry.reason });
    }
    for (const entry of round.unfillable) {
      outcomes.set(orderKey(entry.order), {
        status: 'unfillable',
        order: entry.order,
        reason: entry.reason,
      });
    }

    const executorKeyHash = keyHashOf(await this.config.wallet.getChangeAddress());
    const now = Date.now();
    for (const [ref, until] of this.spentUntil) if (until <= now) this.spentUntil.delete(ref);
    const stale = new Set(this.spentUntil.keys());
    const spent: string[] = [];
    const remember = (...refs: string[]) => {
      for (const ref of refs) {
        spent.push(ref);
        this.spentUntil.set(ref, now + VENUE_SPENT_MEMORY_MS);
      }
    };
    const maxPerPool = this.config.maxFillsPerPool ?? VENUE_MAX_FILLS_PER_POOL;
    const maxPerRound = this.config.maxFillsPerRound;

    // The pool as it stands NOW, which is the pool as read only until the
    // first fill against it lands.
    const poolNow = new Map<string, VenuePoolUtxo>();
    const depth = new Map<string, number>();
    const abandoned = new Set<string>();
    let filled = 0;
    let failed = 0;

    // Swaps and liquidity requests meet a pool in ONE sequence — the order the
    // chain accepted them — so a deposit placed before a swap fills before it,
    // and neither kind can be moved ahead of the other by the executor.
    const work: RoundWork[] = venueFillSequence([
      ...round.candidates.map(
        (candidate): RoundWork => ({
          kind: 'swap',
          candidate,
          outputIndex: candidate.order.outputIndex,
          ...(candidate.order.placedAt ? { placedAt: candidate.order.placedAt } : {}),
        }),
      ),
      ...round.liquidity.map(
        (candidate): RoundWork => ({
          kind: 'liquidity',
          candidate,
          outputIndex: candidate.order.outputIndex,
          ...(candidate.order.placedAt ? { placedAt: candidate.order.placedAt } : {}),
        }),
      ),
      ...round.withdrawals.map(
        (candidate): RoundWork => ({
          kind: 'withdraw',
          candidate,
          outputIndex: candidate.order.outputIndex,
          ...(candidate.order.placedAt ? { placedAt: candidate.order.placedAt } : {}),
        }),
      ),
    ]);

    for (const item of work) {
      if (item.kind === 'withdraw') {
        const { order } = item.candidate;
        const key = orderKey(order);
        const nft = venueUnitOf(order.datum.withdraw_data.pool_nft);
        const declined = this.declineReason({
          candidate: null,
          executorKeyHash,
          staleOrder: stale.has(key),
          stalePool: !poolNow.has(nft) && stale.has(orderKey(item.candidate.pool)),
          abandoned: abandoned.has(nft),
          poolDepth: depth.get(nft) ?? 0,
          maxPerPool,
          roundDepth: filled,
          maxPerRound,
        });
        if (declined) {
          withdrawOutcomes.set(key, { status: 'declined', order, reason: declined });
          continue;
        }
        const pool = poolNow.get(nft) ?? item.candidate.pool;
        let plan: VenueFillPlan;
        let nextPool: VenuePoolUtxo;
        try {
          const fill = await planVenueRoyaltyWithdrawFill({
            pool,
            request: order,
            network: LUCID_NETWORK[this.config.network],
            minOutputLovelace: this.config.minOutputLovelace,
          });
          plan = {
            kind: 'withdraw',
            pool: { txHash: pool.txHash, outputIndex: pool.outputIndex, address: pool.address, assets: pool.assets },
            order: {
              txHash: order.txHash,
              outputIndex: order.outputIndex,
              address: order.address,
              assets: order.assets,
            },
            poolOutput: { address: pool.address, assets: fill.poolAssets, datumCbor: fill.nextDatumCbor },
            successorOutput: { address: fill.reward.address, assets: fill.reward.assets },
            royaltySignatureHashed: fill.hashed,
          };
          nextPool = { ...pool, assets: fill.poolAssets, datum: fill.nextDatum };
        } catch (error) {
          withdrawOutcomes.set(key, { status: 'unfillable', order, reason: describeThrown(error) });
          continue;
        }
        try {
          const txHex = await this.config.filler.build(plan, this.config.wallet, this.config.executorPayoutAddress);
          const txHash = await this.config.wallet.submitTx(await this.config.wallet.signTx(txHex));
          remember(key, orderKey(pool));
          poolNow.set(nft, { ...nextPool, txHash, outputIndex: 0 });
          depth.set(nft, (depth.get(nft) ?? 0) + 1);
          filled += 1;
          withdrawOutcomes.set(key, {
            status: 'filled',
            order,
            txHash,
            exFeeTaken: order.datum.withdraw_data.ex_fee,
            networkFee: deserializeTx(txHex).body().fee(),
          });
        } catch (error) {
          abandoned.add(nft);
          failed += 1;
          withdrawOutcomes.set(key, { status: 'failed', order, reason: describeThrown(error) });
        }
        continue;
      }

      if (item.kind === 'liquidity') {
        const { order } = item.candidate;
        const key = orderKey(order);
        const nft = venueUnitOf(order.datum.pool_nft);
        const declined = this.declineReason({
          candidate: null,
          executorKeyHash,
          staleOrder: stale.has(key),
          stalePool: !poolNow.has(nft) && stale.has(orderKey(item.candidate.pool)),
          abandoned: abandoned.has(nft),
          poolDepth: depth.get(nft) ?? 0,
          maxPerPool,
          roundDepth: filled,
          maxPerRound,
        });
        if (declined) {
          liquidityOutcomes.set(key, { status: 'declined', order, reason: declined });
          continue;
        }
        const pool = poolNow.get(nft) ?? item.candidate.pool;
        const answer = venueLiquidityFillable({
          pool,
          order,
          network: LUCID_NETWORK[this.config.network],
          minOutputLovelace: this.config.minOutputLovelace,
          ...(this.config.fillCostLovelace !== undefined ? { fillCostLovelace: this.config.fillCostLovelace } : {}),
        });
        if (!answer.fillable) {
          liquidityOutcomes.set(key, { status: 'unfillable', order, reason: answer.reason });
          continue;
        }
        try {
          const result = await this.fillLiquidity(pool, order);
          remember(key, orderKey(pool));
          poolNow.set(nft, result.nextPool);
          depth.set(nft, (depth.get(nft) ?? 0) + 1);
          filled += 1;
          liquidityOutcomes.set(key, {
            status: 'filled',
            order,
            txHash: result.txHash,
            lq: result.lq,
            exFeeTaken: result.exFeeTaken,
            networkFee: result.networkFee,
          });
        } catch (error) {
          abandoned.add(nft);
          failed += 1;
          liquidityOutcomes.set(key, { status: 'failed', order, reason: describeThrown(error) });
        }
        continue;
      }

      const { candidate } = item;
      const key = orderKey(candidate.order);
      const nft = venueUnitOf(candidate.order.datum.pool_nft);
      const declined = this.declineReason({
        candidate,
        executorKeyHash,
        staleOrder: stale.has(key),
        stalePool: !poolNow.has(nft) && stale.has(orderKey(candidate.pool)),
        abandoned: abandoned.has(nft),
        poolDepth: depth.get(nft) ?? 0,
        maxPerPool,
        roundDepth: filled,
        maxPerRound,
      });
      if (declined) {
        outcomes.set(key, { status: 'declined', order: candidate.order, reason: declined });
        continue;
      }

      // The pool the reader saw, or the successor of the last fill against it.
      const pool = poolNow.get(nft) ?? candidate.pool;
      const moved = pool !== candidate.pool;
      const answer = venueFillableAmount({
        pool,
        order: candidate.order,
        fillCostLovelace: this.config.fillCostLovelace,
      });
      if (!answer.fillable) {
        outcomes.set(key, {
          status: 'unfillable',
          order: candidate.order,
          reason: moved
            ? 'fillable when this round was read, and no longer: earlier fills moved the pool past its ' +
              `price floor. The pool can serve ${answer.largest} of it now.`
            : `the pool can serve ${answer.largest} of it and the fee only funds a fill of ` +
              `${answer.smallestFundable} or more`,
        });
        continue;
      }

      try {
        const result = await this.fillOne(pool, candidate.order, answer.largest, executorKeyHash);
        remember(key, orderKey(pool));
        poolNow.set(nft, result.nextPool);
        depth.set(nft, (depth.get(nft) ?? 0) + 1);
        filled += 1;
        outcomes.set(key, {
          status: 'filled',
          order: candidate.order,
          txHash: result.txHash,
          traded: answer.largest,
          exFeeTaken: result.exFeeTaken,
          networkFee: result.networkFee,
        });
      } catch (error) {
        abandoned.add(nft);
        failed += 1;
        outcomes.set(key, {
          status: 'failed',
          order: candidate.order,
          reason: describeThrown(error),
        });
      }
    }

    const everyOrder = venueFillSequence([
      ...round.candidates.map((candidate) => candidate.order),
      ...round.unfillable.map((entry) => entry.order),
    ]);
    const everyRequest = venueFillSequence([
      ...round.liquidity.map((candidate) => candidate.order),
      ...round.liquidityUnfillable.map((entry) => entry.order),
    ]);
    const everyWithdraw = venueFillSequence(round.withdrawals.map((candidate) => candidate.order));
    // Only the transactions still holding orders or requests are worth remembering.
    const resting = new Set([...everyOrder, ...everyRequest, ...everyWithdraw].map((order) => order.txHash));
    this.placements = new Map([...this.placements].filter(([txHash]) => resting.has(txHash)));

    return {
      outcomes: everyOrder.map((order) => {
        const outcome = outcomes.get(orderKey(order));
        /* c8 ignore next 4 -- every order was read into exactly one bucket above. */
        if (!outcome) {
          throw new Error(`Order ${orderKey(order)} was read this round and reported in none of the four outcomes.`);
        }
        return outcome;
      }),
      liquidityOutcomes: everyRequest.map((request) => {
        const outcome = liquidityOutcomes.get(orderKey(request));
        /* c8 ignore next 5 -- every request was read into exactly one bucket above. */
        if (!outcome) {
          throw new Error(
            `Request ${orderKey(request)} was read this round and reported in none of the four outcomes.`,
          );
        }
        return outcome;
      }),
      withdrawOutcomes: everyWithdraw.map((request) => {
        const outcome = withdrawOutcomes.get(orderKey(request));
        /* c8 ignore next 5 -- every withdraw request was read into exactly one bucket above. */
        if (!outcome) {
          throw new Error(
            `Withdraw request ${orderKey(request)} was read this round and reported in none of the four outcomes.`,
          );
        }
        return outcome;
      }),
      skipped: round.skipped,
      filled,
      failed,
      spent,
    };
  }

  /** Why this batcher will not take a candidate on, or null if it will. */
  private declineReason(args: {
    /** A swap candidate, or null for a liquidity request, which names no executors. */
    candidate: VenueFillCandidate | null;
    executorKeyHash: string;
    /** An earlier round spent this order; the index has not caught up. */
    staleOrder: boolean;
    /** An earlier round spent the pool output this order was read against. */
    stalePool: boolean;
    abandoned: boolean;
    poolDepth: number;
    maxPerPool: number;
    roundDepth: number;
    maxPerRound?: number;
  }): string | null {
    if (args.candidate && !mayExecute(args.candidate.order.datum, args.executorKeyHash)) {
      return 'the order names permitted executors and this batcher is not one of them';
    }
    if (args.staleOrder) {
      return 'an earlier round filled this order, and the index has not caught up with it yet';
    }
    if (args.stalePool) {
      return (
        'an earlier round spent the pool output this order was read against, so the pool is filled ' +
        'again once the index shows the output that replaced it'
      );
    }
    if (args.abandoned) {
      return (
        'an earlier fill against this pool failed, so the state every later fill in the chain would ' +
        'be built on is unknown until the chain is read again'
      );
    }
    if (args.poolDepth >= args.maxPerPool) {
      return (
        `this pool has been filled ${args.poolDepth} times this round, which is as deep as the chain ` +
        'is allowed to go'
      );
    }
    if (args.maxPerRound !== undefined && args.roundDepth >= args.maxPerRound) {
      return `this round has filled ${args.roundDepth} orders, which is its limit`;
    }
    return null;
  }

  /**
   * Builds, signs and submits one fill, and works out what the pool becomes.
   *
   * The successor is derived from the fill's own arithmetic rather than read
   * back from the chain, because waiting for confirmation would make a chain
   * of fills take a block each. Its position is the one thing not derived:
   * the pool's output is the first this builder places, and the order's `Fill`
   * redeemer already names the successor as the second — so a transaction in
   * which the pool is not first is one the order itself would refuse.
   */
  private async fillOne(
    pool: VenuePoolUtxo,
    order: VenueSwapOrderUtxo,
    traded: bigint,
    executorKeyHash: string,
  ): Promise<{ txHash: string; exFeeTaken: bigint; networkFee: bigint; nextPool: VenuePoolUtxo }> {
    const gated = order.datum.permitted_executors.length > 0;
    let poolAssets: Record<string, bigint> | undefined;
    let poolDatum: VenuePoolUtxo['datum'] | undefined;

    const makePlan = (executorFee: bigint): VenueFillPlan => {
      const fill = planVenueSwapFill({
        pool,
        order,
        network: LUCID_NETWORK[this.config.network],
        tradeAmount: traded,
        executorFee,
        minOutputLovelace: this.config.minOutputLovelace,
        fillCostLovelace: this.config.fillCostLovelace,
      });
      poolAssets = fill.poolAssets;
      poolDatum = fill.poolDatum;
      return {
        pool: { txHash: pool.txHash, outputIndex: pool.outputIndex, address: pool.address, assets: pool.assets },
        order: {
          txHash: order.txHash,
          outputIndex: order.outputIndex,
          address: order.address,
          assets: order.assets,
        },
        poolOutput: {
          address: pool.address,
          assets: fill.poolAssets,
          datumCbor: Data.to(fill.poolDatum, VenuePoolConfigSchema),
        },
        successorOutput: {
          address: fill.successor.address,
          assets: fill.successor.assets,
          ...(fill.successor.datum ? { datumCbor: Data.to(fill.successor.datum, VenueSwapConfigSchema) } : {}),
        },
        ...(gated ? { requiredSignerHashes: [executorKeyHash] } : {}),
      };
    };

    const { txHex, executorFee, networkFee } = await this.config.filler.buildSettled(makePlan, this.config.wallet, {
      ...(this.config.executorPayoutLovelace === undefined
        ? {}
        : { executorPayoutLovelace: this.config.executorPayoutLovelace }),
      ...(this.config.executorPayoutAddress ? { payoutAddress: this.config.executorPayoutAddress } : {}),
    });
    const txHash = await this.config.wallet.submitTx(await this.config.wallet.signTx(txHex));

    /* c8 ignore next 3 -- makePlan has run twice by here; both set these. */
    if (!poolAssets || !poolDatum) {
      throw new Error('The fill was built without planning the pool successor. This should be unreachable.');
    }
    return {
      txHash,
      exFeeTaken: executorFee,
      networkFee,
      nextPool: {
        txHash,
        outputIndex: 0,
        address: pool.address,
        assets: poolAssets,
        datum: poolDatum,
      },
    };
  }

  /**
   * Builds, signs and submits one deposit or redeem, and works out what the
   * pool becomes. The pool's datum does not change under either arm, so the
   * successor carries the one it had.
   */
  private async fillLiquidity(
    pool: VenuePoolUtxo,
    order: VenueLiquidityOrderUtxo,
  ): Promise<{ txHash: string; lq: bigint; exFeeTaken: bigint; networkFee: bigint; nextPool: VenuePoolUtxo }> {
    let poolAssets: Record<string, bigint> | undefined;
    let lq = 0n;
    const makePlan = (executorFee: bigint): VenueFillPlan => {
      const fill = planVenueLiquidityFill({
        pool,
        order,
        network: LUCID_NETWORK[this.config.network],
        executorFee,
        minOutputLovelace: this.config.minOutputLovelace,
        ...(this.config.fillCostLovelace !== undefined ? { fillCostLovelace: this.config.fillCostLovelace } : {}),
      });
      poolAssets = fill.poolAssets;
      lq = fill.lq;
      return {
        kind: order.kind,
        pool: { txHash: pool.txHash, outputIndex: pool.outputIndex, address: pool.address, assets: pool.assets },
        order: { txHash: order.txHash, outputIndex: order.outputIndex, address: order.address, assets: order.assets },
        poolOutput: {
          address: pool.address,
          assets: fill.poolAssets,
          datumCbor: Data.to(pool.datum, VenuePoolConfigSchema),
        },
        successorOutput: { address: fill.reward.address, assets: fill.reward.assets },
      };
    };

    const { txHex, executorFee, networkFee } = await this.config.filler.buildSettled(makePlan, this.config.wallet, {
      ...(this.config.executorPayoutLovelace === undefined
        ? {}
        : { executorPayoutLovelace: this.config.executorPayoutLovelace }),
      ...(this.config.executorPayoutAddress ? { payoutAddress: this.config.executorPayoutAddress } : {}),
    });
    const txHash = await this.config.wallet.submitTx(await this.config.wallet.signTx(txHex));

    /* c8 ignore next 3 -- makePlan has run twice by here; both set it. */
    if (!poolAssets) {
      throw new Error('The fill was built without planning the pool successor. This should be unreachable.');
    }
    return {
      txHash,
      lq,
      exFeeTaken: executorFee,
      networkFee,
      nextPool: { txHash, outputIndex: 0, address: pool.address, assets: poolAssets, datum: pool.datum },
    };
  }

  /**
   * Runs rounds until stopped.
   *
   * A round that throws — a provider outage, most likely — is reported and
   * waited out rather than allowed to end the service. A batcher that exits on
   * the first failed request stops the venue's market for as long as nobody is
   * watching it.
   */
  async run(opts: {
    intervalMs: number;
    signal?: AbortSignal;
    onRound?: (round: VenueBatcherRound) => void | Promise<void>;
    onError?: (error: unknown) => void | Promise<void>;
    /** Injectable so a test does not wait in real time. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }): Promise<void> {
    const sleep = opts.sleep ?? defaultSleep;
    while (!opts.signal?.aborted) {
      try {
        const round = await this.runRound();
        await opts.onRound?.(round);
      } catch (error) {
        await opts.onError?.(error);
      }
      if (opts.signal?.aborted) return;
      await sleep(opts.intervalMs, opts.signal);
    }
  }
}

/** Whether an order lets this executor fill it. An empty list lets anyone. */
export function mayExecute(swap: VenueSwapConfigData, executorKeyHash: string): boolean {
  return swap.permitted_executors.length === 0 || swap.permitted_executors.includes(executorKeyHash);
}

/* c8 ignore start -- a real timer; every test injects its own. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}
/* c8 ignore stop */
