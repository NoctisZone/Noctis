// ============================================================================
// Noctis Zone — deciding what goes in a batch
// ============================================================================
// The batcher's whole job is to propose a set of orders and the outputs that
// fill them. The curve validator then re-derives all of it and refuses
// anything that does not match, so nothing here is trusted — but everything
// here has to AGREE, to the lovelace, or the batch is simply rejected and the
// orders sit unfilled.
//
// So this module is a mirror of the validator's own fold, and the properties
// it has to reproduce are the ones a naive implementation gets wrong:
//
//   - **Each order prices at its own position.** Order k pays for the range
//     starting where order k-1 finished, not where the batch started. Pricing
//     every order from the opening position is the obvious mistake and it
//     under-charges every order after the first.
//
//   - **The cap accumulator threads too.** Each order proves its committed
//     total against the root the PRECEDING order left, not the batch's
//     starting root. This is what stops one wallet splitting a purchase across
//     several orders that are each individually under the cap.
//
//   - **An order that cannot be filled must be left out, not squeezed in.**
//     A batch is all-or-nothing on chain: one order over the cap, or short of
//     its slippage bound, fails the whole transaction. Rejecting it here and
//     filling the rest is the difference between one unfillable order and a
//     batch that never lands.
//
// **Nothing in this module is async and nothing here touches a wallet.** It is
// the piece worth testing hardest, so it takes plain values and returns plain
// values.

import { bytesToHex, CapAccumulator, capLeafFor, hexToBytes, recomputeCapRoot } from './cap-accumulator-tree.js';
import { buyCost, CREATOR_BPS, type CurveShape, feeSlice, PLATFORM_BPS, sellProceeds } from './curve-pricing.js';

/**
 * Least lovelace a settlement-tagged payout can hold, with headroom.
 *
 * Not a guess: a real Preprod node rejected a 997,805-lovelace sell payout and
 * named 1,055,950 as the minimum for that exact output. The tag is what pushes
 * it up — an untagged output of the same value would need less.
 */
export const DEFAULT_MIN_PAYOUT_LOVELACE = 1_200_000n;

/** The curve state a plan is built against — either tier's datum satisfies it. */
export interface PlannerCurve {
  base_price: bigint;
  max_price: bigint;
  curve_supply: bigint;
  tokens_sold: bigint;
  total_raised: bigint;
  creator_fees_accrued: bigint;
  platform_fees_accrued: bigint;
  wallet_cap: bigint;
  cap_root: string;
  creator_pub_key_hash: string;
}

/** One candidate, as read from its own UTXO. */
export interface CandidateOrder {
  /** The order UTXO. Its reference is what the fill will be tagged with. */
  txHash: string;
  outputIndex: number;
  ownerKeyHashHex: string;
  /** The staking part of the address the order was placed from, if any. */
  ownerStake?: unknown;
  isBuy: boolean;
  amount: bigint;
  minReceived: bigint;
  maxSpend: bigint;
  deadlineMs: bigint;
  /** Lovelace the order holds — a buy's change is computed against it. */
  heldLovelace: bigint;
  /** Tokens the order holds. Zero for a buy. */
  heldTokens: bigint;
}

/** Why an order was left out. Reported rather than silently dropped. */
export type SkipReason =
  | 'expired'
  | 'creator'
  | 'non-positive-amount'
  | 'exceeds-remaining-supply'
  | 'exceeds-wallet-cap'
  | 'below-min-received'
  | 'exceeds-max-spend'
  | 'oversells-curve'
  | 'proceeds-below-min-ada'
  | 'batch-full';

export interface SkippedOrder {
  order: CandidateOrder;
  reason: SkipReason;
  /** Filled in where a number makes the reason concrete. */
  detail?: string;
}

/** An order that made it in, with everything the transaction needs. */
export interface PlannedFill {
  order: CandidateOrder;
  /** Gross lovelace the curve charges (buy) or pays before fees (sell). */
  gross: bigint;
  /** What the owner receives: tokens on a buy, net lovelace on a sell. */
  received: bigint;
  /** What returns to the owner unspent: lovelace on a buy, tokens on a sell. */
  change: bigint;
  creatorFee: bigint;
  platformFee: bigint;
  /** The redeemer fields, in the order `BatchOrder` declares them. */
  capCommittedBefore: bigint;
  capProof: ReturnType<CapAccumulator['proofFor']>;
}

export interface BatchPlan {
  fills: PlannedFill[];
  skipped: SkippedOrder[];
  /** The curve datum this batch must write. */
  next: {
    tokens_sold: bigint;
    total_raised: bigint;
    creator_fees_accrued: bigint;
    platform_fees_accrued: bigint;
    cap_root: string;
  };
  /** The curve's own value movement, which the validator checks directly. */
  curveLovelaceDelta: bigint;
  curveTokensSoldDelta: bigint;
}

/**
 * Most orders one batch can carry.
 *
 * The binding limit is EXECUTION UNITS, not transaction size — which is not
 * what you would guess from a validator this large. Measured on Preprod: eight
 * The linear curve buys were refused with `ExUnitsTooBigUTxO`, having used 17,711,813
 * memory against a 17,500,000 cap, while spending only 6.66 billion of the ten
 * billion steps allowed. Seven of the same orders were accepted. Size was never
 * close on either.
 *
 * Memory is what runs out, so this is a count rather than a computed budget:
 * per-order cost varies with the cap proof each one carries, and a count that
 * is safe for the most expensive order is safe for all of them. A batch that
 * exceeds the cap is rejected whole, taking every order in it down together,
 * so the default errs low.
 *
 * Re-measure if the curve validator changes.
 */
export const MAX_ORDERS_PER_BATCH = 7;

export interface PlanBatchOptions {
  shape: CurveShape;
  curve: PlannerCurve;
  /** The launch's per-wallet running totals. Must derive `curve.cap_root`. */
  capState: CapAccumulator;
  orders: readonly CandidateOrder[];
  /** Posix ms — an order past its deadline is swept, never filled. */
  nowMs: bigint;
  /**
   * Most orders to include. Defaults to {@link MAX_ORDERS_PER_BATCH}.
   *
   * Raising it past that default is measured, not cautious — see the constant.
   */
  maxOrders?: number;
  /**
   * Least lovelace an output carrying a settlement tag can hold.
   *
   * A seller is paid in one output, and that output has to satisfy the
   * ledger's minimum like any other — the settlement datum makes it larger,
   * and therefore its minimum higher. A sell whose whole net proceeds fall
   * below this cannot be paid at all, and proposing it builds a batch the node
   * rejects outright, taking every other order in that batch down with it.
   *
   * Default measured from a real Preprod rejection: the node asked for
   * 1,055,950 against a tagged payout, so this rounds up for headroom rather
   * than sitting on the exact figure.
   */
  minPayoutLovelace?: bigint;
}

/**
 * Chooses which orders can be filled together, and what each one is owed.
 *
 * Orders are considered in the sequence given, because position on the curve
 * depends on that sequence and so does the price each one pays. A caller that
 * wants a different fairness rule — oldest first, say — sorts before calling.
 *
 * Throws only if the accumulator does not derive the curve's own root, which
 * means the state being planned against is stale and every proof it produces
 * would fail on chain. Everything else is reported as a skip.
 */
export function planBatch(options: PlanBatchOptions): BatchPlan {
  const derivedRoot = bytesToHex(options.capState.root);
  if (derivedRoot !== options.curve.cap_root) {
    throw new Error(
      `Cap accumulator is stale: it derives ${derivedRoot} but the curve datum carries ${options.curve.cap_root}. ` +
        'Rebuild it from the launch’s trade history before planning a batch.',
    );
  }

  // UNIFORM PRICING MAKES ADMISSION CIRCULAR, so this converges rather than
  // deciding in one pass.
  //
  // Every order on a side pays that side's batch average, so an order's price
  // depends on which other orders are in the batch — while whether it can be
  // admitted at all depends on its price, through max_spend and min_received.
  // Removing one order therefore reprices the rest.
  //
  // Start optimistic (price as if everything fills), then re-price over
  // whatever actually filled, until the two agree. It converges because the
  // fill set can only shrink: an order that fitted at one price still fits
  // once others are removed, since dropping a buy shortens the range above the
  // starting position and lowers what every remaining buyer pays, and dropping
  // a sell shortens the range below it and raises what every remaining seller
  // receives. At most N passes, and normally one.
  const identify = (o: CandidateOrder): string => `${o.txHash}#${o.outputIndex}`;
  let pricingSet: readonly CandidateOrder[] = options.orders;
  for (let pass = 0; ; pass++) {
    const plan = planOnce(options, pricingSet);
    const filled = plan.fills.map((f) => f.order);
    const same =
      filled.length === pricingSet.length &&
      filled.every((o, i) => identify(o) === identify(pricingSet[i] as CandidateOrder));
    // The guard is belt and braces: the shrinking argument above already bounds
    // this, and a pass that somehow neither settled nor shrank would spin.
    if (same || filled.length === 0 || pass >= options.orders.length) return plan;
    pricingSet = filled;
  }
}

/**
 * One admission pass. Every order is considered and reported on, while prices
 * come from `pricingSet` — the orders this pass assumes will fill.
 */
function planOnce(options: PlanBatchOptions, pricingSet: readonly CandidateOrder[]): BatchPlan {
  const { shape, curve, capState, orders, nowMs } = options;
  const maxOrders = options.maxOrders ?? MAX_ORDERS_PER_BATCH;
  const minPayout = options.minPayoutLovelace ?? DEFAULT_MIN_PAYOUT_LOVELACE;

  // Both sides price from the position the curve held BEFORE the batch, so
  // neither depends on the order the batch happens to be listed in. This
  // mirrors the validator exactly; if the two ever disagree the batch simply
  // fails on chain, which is why the arithmetic is written the same way here.
  const batchBuyAmount = pricingSet.filter((o) => o.isBuy).reduce((a, o) => a + o.amount, 0n);
  const batchSellAmount = pricingSet.filter((o) => !o.isBuy).reduce((a, o) => a + o.amount, 0n);
  const batchBuyGross = batchBuyAmount > 0n ? buyCost(shape, curve, curve.tokens_sold, batchBuyAmount) : 0n;
  const batchSellGross =
    batchSellAmount > 0n && batchSellAmount <= curve.tokens_sold
      ? sellProceeds(shape, curve, curve.tokens_sold - batchSellAmount, batchSellAmount)
      : 0n;
  /** This order's slice of its side's single range, rounded as the validator rounds it. */
  const shareOf = (order: CandidateOrder): bigint =>
    order.isBuy
      ? batchBuyAmount > 0n
        ? (batchBuyGross * order.amount + batchBuyAmount - 1n) / batchBuyAmount
        : 0n
      : batchSellAmount > 0n
        ? (batchSellGross * order.amount) / batchSellAmount
        : 0n;

  const fills: PlannedFill[] = [];
  const skipped: SkippedOrder[] = [];

  // Threaded through the batch, exactly as the validator threads them.
  let sold = curve.tokens_sold;
  let root = capState.root;
  let adaIn = 0n;
  let adaOut = 0n;
  let creatorTotal = 0n;
  let platformTotal = 0n;
  // A copy, because planning walks hypothetical trades: a plan that is
  // discarded, or whose transaction is never submitted, has to leave the
  // caller's accumulator exactly as it found it.
  const working = workingCopy(capState, new Map());

  for (const order of orders) {
    const skip = (reason: SkipReason, detail?: string): void => {
      skipped.push({ order, reason, ...(detail ? { detail } : {}) });
    };

    if (fills.length >= maxOrders) {
      skip('batch-full', `already holding ${fills.length}`);
      continue;
    }
    if (order.deadlineMs < nowMs) {
      skip('expired', `deadline ${order.deadlineMs}, now ${nowMs}`);
      continue;
    }
    if (order.amount <= 0n) {
      skip('non-positive-amount');
      continue;
    }
    // The creator is barred from trading their own curve on every path, so an
    // order of theirs would fail the whole batch rather than just itself.
    if (order.ownerKeyHashHex === curve.creator_pub_key_hash) {
      skip('creator');
      continue;
    }

    const ownerKey = hexToBytes(order.ownerKeyHashHex);
    const before = working.totalOf(ownerKey);
    // Against the root the PRECEDING order left, which is what the validator
    // will walk it against.
    const proof = working.proofFor(ownerKey);

    if (order.isBuy) {
      const remaining = curve.curve_supply - sold;
      if (order.amount > remaining) {
        skip('exceeds-remaining-supply', `${order.amount} wanted, ${remaining} left`);
        continue;
      }
      const after = before + order.amount;
      if (after > curve.wallet_cap) {
        skip('exceeds-wallet-cap', `${before} + ${order.amount} = ${after} > ${curve.wallet_cap}`);
        continue;
      }
      if (order.amount < order.minReceived) {
        skip('below-min-received', `${order.amount} < ${order.minReceived}`);
        continue;
      }
      const gross = shareOf(order);
      if (gross > order.maxSpend) {
        skip('exceeds-max-spend', `costs ${gross} at the batch average, allowed ${order.maxSpend}`);
        continue;
      }
      const creatorFee = feeSlice(gross, CREATOR_BPS);
      const platformFee = feeSlice(gross, PLATFORM_BPS);

      fills.push({
        order,
        gross,
        received: order.amount,
        // Everything the order held that the curve did not take. The batcher's
        // own fee comes out of this, and the validator requires the remainder
        // to reach the owner.
        change: order.heldLovelace - gross,
        creatorFee,
        platformFee,
        capCommittedBefore: before,
        capProof: proof,
      });

      sold += order.amount;
      adaIn += gross;
      creatorTotal += creatorFee;
      platformTotal += platformFee;
      working.set(ownerKey, after);
      // The same second walk the validator performs: one path, updated leaf.
      root = recomputeCapRoot(capLeafFor(ownerKey, after), proof);
    } else {
      const newSold = sold - order.amount;
      if (newSold < 0n) {
        skip('oversells-curve', `${order.amount} sold against ${sold} outstanding`);
        continue;
      }
      if (order.amount > curve.wallet_cap) {
        skip('exceeds-wallet-cap', `${order.amount} > ${curve.wallet_cap} in one order`);
        continue;
      }
      if (order.amount > order.maxSpend) {
        skip('exceeds-max-spend', `selling ${order.amount}, allowed ${order.maxSpend}`);
        continue;
      }
      const gross = shareOf(order);
      const creatorFee = feeSlice(gross, CREATOR_BPS);
      const platformFee = feeSlice(gross, PLATFORM_BPS);
      const net = gross - creatorFee - platformFee;
      if (net < order.minReceived) {
        skip('below-min-received', `${net} at the batch average < ${order.minReceived}`);
        continue;
      }
      // The seller is paid in one output and that output must itself satisfy
      // the ledger's minimum. Proposing a smaller one does not shortchange the
      // seller — it builds a batch the node refuses entire, taking every other
      // order down with it.
      if (net < minPayout) {
        skip('proceeds-below-min-ada', `${net} < ${minPayout} the output would need`);
        continue;
      }

      // A sell RELEASES headroom, floored at zero: a seller may hold tokens
      // they never bought from this curve.
      const after = order.amount > before ? 0n : before - order.amount;

      fills.push({
        order,
        gross,
        received: net,
        change: order.heldTokens - order.amount,
        creatorFee,
        platformFee,
        capCommittedBefore: before,
        capProof: proof,
      });

      sold = newSold;
      adaOut += net;
      creatorTotal += creatorFee;
      platformTotal += platformFee;
      working.set(ownerKey, after);
      root = recomputeCapRoot(capLeafFor(ownerKey, after), proof);
    }
  }

  return {
    fills,
    skipped,
    next: {
      tokens_sold: sold,
      total_raised: curve.total_raised + adaIn - creatorTotal - platformTotal - adaOut,
      creator_fees_accrued: curve.creator_fees_accrued + creatorTotal,
      platform_fees_accrued: curve.platform_fees_accrued + platformTotal,
      cap_root: bytesToHex(root),
    },
    // Fees stay in the curve until claimed, so what it keeps is everything
    // taken in less everything paid out — the figure the validator checks its
    // own UTXO against.
    curveLovelaceDelta: adaIn - adaOut,
    curveTokensSoldDelta: sold - curve.tokens_sold,
  };
}

/**
 * A copy of `base` with the batch's assignments so far laid over it.
 *
 * Copied rather than mutated on purpose: a plan that is discarded — or one
 * whose transaction is never submitted — must leave the real accumulator
 * exactly as it found it, or the next plan built from it would be wrong in a
 * way nothing local would catch.
 */
function workingCopy(base: CapAccumulator, applied: ReadonlyMap<string, bigint>): CapAccumulator {
  const clone = new CapAccumulator(base.entries());
  for (const [hex, total] of applied) clone.set(hexToBytes(hex), total);
  return clone;
}
