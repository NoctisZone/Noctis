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
import type { CurveNetwork, CurveSpendWallet } from './mesh-curve-spend.js';
import {
  readVenueFillRound,
  type SkippedUtxo,
  type VenueChainProvider,
  type VenueFillCandidate,
} from './venue-chain-reader.js';
import type { VenueFiller, VenueFillPlan } from './venue-fill-submitter.js';
import { VenuePoolConfigSchema } from './venue-pool.js';
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
  /** The factory's minting policy — what makes a pool a pool. Required. */
  factoryPolicyId: string;
  /** The protocol's minimum for an output, from the protocol parameters. */
  minOutputLovelace: bigint;
  /** What one fill costs; `VENUE_FILL_FLOOR_LOVELACE` unless measured again. */
  fillCostLovelace?: bigint;
  /** What the executor keeps beyond the network fee. See `buildSettled`. */
  executorPayoutLovelace?: bigint;
  /** Chained fills against one pool. Defaults to `VENUE_MAX_FILLS_PER_POOL`. */
  maxFillsPerPool?: number;
  /**
   * A ceiling on the whole round, for an operator who wants one.
   *
   * A wall-clock guard rather than a derived figure — unset, a round does all
   * the work it finds.
   */
  maxFillsPerRound?: number;
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

export interface VenueBatcherRound {
  /** One per order read, in the order fills are obliged to follow. */
  outcomes: VenueFillOutcome[];
  /** UTXOs at either address the reader declined, each with a reason. */
  skipped: SkippedUtxo[];
  filled: number;
  failed: number;
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

function orderKey(order: VenueSwapOrderUtxo): string {
  return `${order.txHash}#${order.outputIndex}`;
}

/**
 * Runs rounds of fills against the venue.
 *
 * `runRound` is the unit and holds all of the behaviour; `run` is a loop
 * around it that survives a provider outage rather than exiting on one.
 */
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

  constructor(private readonly config: VenueBatcherConfig) {}

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
    });

    const outcomes = new Map<string, VenueFillOutcome>();
    for (const entry of round.unfillable) {
      outcomes.set(orderKey(entry.order), {
        status: 'unfillable',
        order: entry.order,
        reason: entry.reason,
      });
    }

    const executorKeyHash = keyHashOf(await this.config.wallet.getChangeAddress());
    const maxPerPool = this.config.maxFillsPerPool ?? VENUE_MAX_FILLS_PER_POOL;
    const maxPerRound = this.config.maxFillsPerRound;

    // The pool as it stands NOW, which is the pool as read only until the
    // first fill against it lands.
    const poolNow = new Map<string, VenuePoolUtxo>();
    const depth = new Map<string, number>();
    const abandoned = new Set<string>();
    let filled = 0;
    let failed = 0;

    for (const candidate of round.candidates) {
      const key = orderKey(candidate.order);
      const nft = venueUnitOf(candidate.order.datum.pool_nft);
      const declined = this.declineReason({
        candidate,
        executorKeyHash,
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
          reason: (error as Error).message,
        });
      }
    }

    const everyOrder = venueFillSequence([
      ...round.candidates.map((candidate) => candidate.order),
      ...round.unfillable.map((entry) => entry.order),
    ]);
    // Only the transactions still holding orders are worth remembering.
    this.placements = new Map(
      everyOrder
        .filter((order) => this.placements.has(order.txHash))
        .map((order) => [order.txHash, this.placements.get(order.txHash) as VenueOrderPosition]),
    );

    return {
      outcomes: everyOrder.map((order) => {
        const outcome = outcomes.get(orderKey(order));
        /* c8 ignore next 4 -- every order was read into exactly one bucket above. */
        if (!outcome) {
          throw new Error(`Order ${orderKey(order)} was read this round and reported in none of the four outcomes.`);
        }
        return outcome;
      }),
      skipped: round.skipped,
      filled,
      failed,
    };
  }

  /** Why this batcher will not take a candidate on, or null if it will. */
  private declineReason(args: {
    candidate: VenueFillCandidate;
    executorKeyHash: string;
    abandoned: boolean;
    poolDepth: number;
    maxPerPool: number;
    roundDepth: number;
    maxPerRound?: number;
  }): string | null {
    const swap = args.candidate.order.datum;
    if (!mayExecute(swap, args.executorKeyHash)) {
      return 'the order names permitted executors and this batcher is not one of them';
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

    const { txHex, executorFee, networkFee } = await this.config.filler.buildSettled(
      makePlan,
      this.config.wallet,
      this.config.executorPayoutLovelace === undefined
        ? {}
        : { executorPayoutLovelace: this.config.executorPayoutLovelace },
    );
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
