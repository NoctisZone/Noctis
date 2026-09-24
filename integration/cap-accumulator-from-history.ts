// ============================================================================
// Noctis Zone — rebuilding the cap accumulator from a launch's history
// ============================================================================
// The cumulative wallet cap keeps per-wallet totals OFF chain, behind a single
// 32-byte root in the curve datum. That is what lets the datum stay one size
// however many wallets trade — but it means every trade has to arrive already
// knowing its own committed total and a proof of it, and something has to know
// all of them.
//
// Nothing did. `capAccumulatorFromHex` takes a caller-supplied list and
// deliberately offers no "read it from chain for me", because getting it wrong
// produces proofs that fail with nothing to point at. So the totals were
// state with an owner named nowhere, and every caller that did not already
// have them — the WordPress trade wrappers, in particular — could not trade a
// launch that had ever traded.
//
// This is that owner. It replays what the curve itself did, from the same
// public history anyone can read, and hands back an accumulator.
//
// **It is checked, not trusted.** `buildCapTradeFields` refuses to build a
// transaction unless the accumulator it is given derives the root the curve
// datum actually carries, so a rebuild that is subtly wrong fails locally and
// loudly rather than producing a bad transaction. `rebuildCapAccumulator`
// makes that check itself, up front, for the same reason.
//
// Only three actions move a wallet's total, and the fold has to agree with the
// validator on all three:
//
//   - **BuyTokens** and a Cardano Launch **ClaimDarkVeilTokens** add to the buyer.
//   - **SellTokens** subtracts, floored at zero — a seller may hold tokens
//     they never bought here.
//   - **BatchTrades** applies its orders IN SEQUENCE, each against the root the
//     one before it left. Its orders are a list inside the redeemer, so a
//     display-flattened view of the fields cannot see them at all; this reads
//     the raw redeemer.
//
// `ClaimBuyback` deliberately does not appear: it returns tokens to a
// cancelled curve and the validator leaves `cap_root` untouched, so adding it
// here would put the rebuild permanently out of step with the chain.

import { Constr } from '@lucid-evolution/lucid';
import { bytesToHex, CapAccumulator, capAccumulatorFromHex, hexToBytes } from './cap-accumulator-tree.js';
import type { TradeEvent } from './tier-a-trade-history-reader.js';

/** Where in a `BatchOrder` each field sits — see the type in either curve. */
const BATCH_ORDER_OWNER = 0;
const BATCH_ORDER_IS_BUY = 2;
const BATCH_ORDER_AMOUNT = 3;

/** One wallet's movement, as the fold applies it. */
export interface CapDelta {
  keyHashHex: string;
  /** Positive for a buy or a DarkVeil claim, negative for a sell. */
  delta: bigint;
}

function asBigInt(value: unknown): bigint | null {
  return typeof value === 'bigint' ? value : null;
}

function asHex(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A batch's orders, in the order the validator applied them.
 *
 * Sequence matters: the fold is a running total, so applying a batch's orders
 * in any other order can only give the same answer by luck.
 */
function batchDeltas(raw: Constr<unknown>): CapDelta[] {
  const [orders] = raw.fields;
  if (!Array.isArray(orders)) return [];
  const out: CapDelta[] = [];
  for (const order of orders) {
    if (!(order instanceof Constr)) continue;
    const keyHashHex = asHex(order.fields[BATCH_ORDER_OWNER]);
    const amount = asBigInt(order.fields[BATCH_ORDER_AMOUNT]);
    const isBuyFlag = order.fields[BATCH_ORDER_IS_BUY];
    if (keyHashHex === null || amount === null) continue;
    // Aiken's Bool is a constructor: index 1 is True.
    const isBuy = isBuyFlag instanceof Constr ? isBuyFlag.index === 1 : Boolean(isBuyFlag);
    out.push({ keyHashHex, delta: isBuy ? amount : -amount });
  }
  return out;
}

/**
 * Every movement one event made, in order.
 *
 * An action that does not move a total returns nothing, which is the whole
 * reason this is a list rather than a single optional delta — one batch moves
 * many wallets, and one fee claim moves none.
 */
export function deltasOf(event: TradeEvent): CapDelta[] {
  switch (event.action) {
    case 'BuyTokens':
    case 'ClaimDarkVeilTokens': {
      const keyHashHex = event.fields.buyer_key_hash;
      const amount = event.fields.token_amount;
      return keyHashHex && amount ? [{ keyHashHex, delta: BigInt(amount) }] : [];
    }
    case 'SellTokens': {
      const keyHashHex = event.fields.seller_key_hash;
      const amount = event.fields.token_amount;
      return keyHashHex && amount ? [{ keyHashHex, delta: -BigInt(amount) }] : [];
    }
    case 'BatchTrades':
      return event.raw ? batchDeltas(event.raw) : [];
    default:
      return [];
  }
}

/**
 * The accumulator a launch's history implies.
 *
 * Events must be in the order they happened; a sell floors at zero, so a
 * shuffled history can produce a different — and wrong — answer.
 */
export function capAccumulatorFromHistory(events: readonly TradeEvent[]): CapAccumulator {
  const acc = new CapAccumulator();
  for (const event of events) {
    for (const { keyHashHex, delta } of deltasOf(event)) {
      acc.apply(hexToBytes(keyHashHex), delta);
    }
  }
  return acc;
}

/**
 * What a reader has to provide. `TierATradeHistoryReader` satisfies it.
 *
 * `stopAtTxHash` returns only what happened after that curve transaction,
 * oldest first; without it, the whole history.
 */
export interface CurveHistorySource {
  getCurveTradeHistory(stopAtTxHash?: string): Promise<TradeEvent[]>;
}

/**
 * Where an earlier rebuild stood: the curve transaction it had reached, and
 * every wallet's total at that point.
 */
export interface CapCheckpoint {
  headTxHash: string;
  capState: readonly { keyHashHex: string; total: bigint | string }[];
}

export interface CapRebuild {
  acc: CapAccumulator;
  /** True when the checkpoint was used; false for a replay from the start. */
  incremental: boolean;
  /** Events replayed to get here. */
  replayed: number;
}

/**
 * Rebuilds the accumulator and checks it against the curve's own root.
 *
 * The check is the point. A rebuild is a claim about history, and the curve
 * datum carries the only authority on whether that claim is right — so this
 * refuses to hand back an accumulator that does not derive it, rather than
 * letting the mismatch surface later as a proof that fails against a validator
 * with nothing useful to say.
 *
 * WITH A CHECKPOINT, only the transactions after it are read and folded onto
 * its totals. The fold is sequential and the checkpoint is the fold of
 * everything before it, so the result is the same accumulator a replay from
 * the start would give, for the cost of the new transactions alone. It is held
 * to the same root check, and a checkpoint that does not reach the datum's
 * root (stale, or taken on a chain that has since moved) costs one full
 * replay, never a wrong answer.
 */
export async function rebuildCapAccumulatorFrom(
  source: CurveHistorySource,
  expectedCapRootHex: string,
  checkpoint?: CapCheckpoint,
): Promise<CapRebuild> {
  if (checkpoint) {
    const events = await source.getCurveTradeHistory(checkpoint.headTxHash);
    const acc = capAccumulatorFromHex(checkpoint.capState);
    for (const event of events) {
      for (const { keyHashHex, delta } of deltasOf(event)) acc.apply(hexToBytes(keyHashHex), delta);
    }
    if (bytesToHex(acc.root) === expectedCapRootHex) return { acc, incremental: true, replayed: events.length };
  }
  const events = await source.getCurveTradeHistory();
  const acc = capAccumulatorFromHistory(events);
  const derived = bytesToHex(acc.root);
  if (derived !== expectedCapRootHex) {
    throw new Error(
      `Rebuilt cap accumulator derives ${derived} but the curve datum carries ${expectedCapRootHex}. ` +
        `Replayed ${events.length} events. The history read here does not account for everything that ` +
        'moved the root — do not trade against this until it does.',
    );
  }
  return { acc, incremental: false, replayed: events.length };
}

/** A replay from the start — see {@link rebuildCapAccumulatorFrom}. */
export async function rebuildCapAccumulator(
  source: CurveHistorySource,
  expectedCapRootHex: string,
): Promise<CapAccumulator> {
  return (await rebuildCapAccumulatorFrom(source, expectedCapRootHex)).acc;
}
