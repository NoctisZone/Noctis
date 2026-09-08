// ============================================================================
// Noctis Zone — NoctisSwap: a pool's whole history, walked off the chain
// ============================================================================
// **A pool is a single-threaded state machine, so its history is a linked
// list and needs no follower, no cursor and no store.** Every action against a
// pool spends the one UTXO carrying its NFT and creates exactly one successor
// carrying it again — `pool.ak` finds its own continuation that way, and
// `swap_order.ak` finds it the same way. So each transaction names its
// predecessor in its own inputs, and the chain of them IS the history.
//
// This is the shape `tier-a-trade-history-reader.ts` already established for
// the launch curve, for the same reason, and it is worth saying what it buys
// here beyond consistency:
//
//   - **Rollbacks need no machinery.** A block-range follower has to store a
//     cursor, notice when the block it recorded is no longer on the chain,
//     and unwind. Walking backward from the pool as it stands now cannot
//     produce a history the chain does not currently have — the walk starts
//     from what is true and follows real inputs. A rolled-back event is
//     simply not on the path any more.
//   - **Requests scale with EVENTS, not with blocks.** A quiet pool costs
//     nothing to be up to date on.
//   - **Nothing has to be stored to be correct.** A caller that keeps events
//     is caching, not bookkeeping, and a cache that is wrong is repairable by
//     walking again.
//
// The cost is that the walk is backward from now, so "the whole history of a
// busy pool" is proportional to that history. Both stopping conditions exist
// for that: `stopAtTxHash` walks back only as far as something the caller has
// already seen, which is the incremental read, and `maxEvents` bounds a feed.
// A result says which of those stopped it, so a caller can tell a complete
// history from a truncated one rather than assuming.
//
// **Every event carries the reserves after it**, which is the thing a price
// feed cannot reconstruct later if it was not recorded at the time — except
// that here it never has to be, because the chain still holds it.
//
// Two traps, both about what an "input" is:
//
//   - **A reference input is never spent.** Blockfrost returns reference and
//     collateral inputs in the same `inputs` array as real ones, flagged. A
//     walk that does not filter them can follow a pool that was merely LOOKED
//     AT into a history that never happened.
//   - **The pool is identified by the factory's policy, not by its address or
//     its datum.** `venuePoolNftOf` is the one rule, shared with the reader,
//     for the reason given there: a datum names the NFT it claims to be.
// ============================================================================

import { Data } from '@lucid-evolution/lucid';
import { venuePoolNftOf } from './venue-chain-reader.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from './venue-pool.js';
import { readVenuePoolState, type VenuePoolUtxo, venueUnitOf } from './venue-swap.js';

/** A transaction's inputs and outputs, as a chain provider reports them. */
export interface HistoryTxUtxo {
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  inline_datum?: string | null;
  /** Present on inputs. Which output this input is spending. */
  tx_hash?: string;
  output_index?: number;
  /** True when this entry is a reference input — looked at, never spent. */
  reference?: boolean;
  /** True when this entry is collateral rather than a real input or output. */
  collateral?: boolean;
}

export interface HistoryTx {
  hash: string;
  inputs: HistoryTxUtxo[];
  outputs: HistoryTxUtxo[];
}

export interface VenueHistoryProvider {
  getTxUtxos(txHash: string): Promise<HistoryTx>;
}

/** What the pool held and what its datum said, at one point in its life. */
export interface VenuePoolSnapshot {
  /** What the UTXO actually holds. */
  balanceX: bigint;
  balanceY: bigint;
  /** What is tradable: the balance less what the creator and platform accrued. */
  reservesX: bigint;
  reservesY: bigint;
  liquidity: bigint;
  datum: VenuePoolConfigData;
}

/**
 * What a transaction did to the pool, worked out from what moved.
 *
 * Derived from the value and the datum rather than from the redeemer, so it
 * needs no second request per event and rests on what actually happened rather
 * than on what was asked for. A movement matching no known shape is reported
 * as `unclassified` with what was seen, never guessed at.
 */
export type VenuePoolEventKind = 'opened' | 'swap' | 'deposit' | 'redeem' | 'feeWithdrawal' | 'unclassified';

/** What a swap moved, in the pool's own units. */
export interface VenueSwapMovement {
  inputUnit: string;
  outputUnit: string;
  /** What the pool took in. */
  tradedIn: bigint;
  /** What the pool paid out. */
  paidOut: bigint;
}

export interface VenuePoolEvent {
  txHash: string;
  kind: VenuePoolEventKind;
  poolNft: string;
  /** The pool after this transaction. Always present — it is why the walk exists. */
  after: VenuePoolSnapshot;
  /** The pool before it. Absent only on the transaction that opened the pool. */
  before?: VenuePoolSnapshot;
  swap?: VenueSwapMovement;
  /** What this event added to each counter. Zero everywhere but a swap. */
  accrued: { treasuryX: bigint; treasuryY: bigint; royaltyX: bigint; royaltyY: bigint };
  /** The transaction that made the pool this one spent — the next link back. */
  previousTxHash?: string;
  /** Present on `unclassified`: what was seen that matched nothing. */
  reason?: string;
}

function assetsOf(utxo: HistoryTxUtxo): Record<string, bigint> {
  const assets: Record<string, bigint> = {};
  for (const entry of utxo.amount) {
    assets[entry.unit] = (assets[entry.unit] ?? 0n) + BigInt(entry.quantity);
  }
  return assets;
}

function snapshotOf(utxo: HistoryTxUtxo, datum: VenuePoolConfigData): VenuePoolSnapshot {
  const assets = assetsOf(utxo);
  const state = readVenuePoolState(datum, assets);
  return {
    balanceX: assets[venueUnitOf(datum.pool_x)] ?? 0n,
    balanceY: assets[venueUnitOf(datum.pool_y)] ?? 0n,
    reservesX: state.reservesX,
    reservesY: state.reservesY,
    liquidity: state.liquidity,
    datum,
  };
}

/**
 * The one entry in a list that is the pool, or none.
 *
 * Reference and collateral entries are dropped first, and this is not a
 * nicety: Blockfrost returns them in the same array as real inputs, so a walk
 * that keeps them can follow a pool somebody merely referenced into a history
 * that never happened. A reference input is never spent.
 */
function poolEntry(
  entries: readonly HistoryTxUtxo[],
  factoryPolicyId: string,
): { utxo: HistoryTxUtxo; nft: string; datum: VenuePoolConfigData } | null {
  for (const utxo of entries) {
    if (utxo.reference === true || utxo.collateral === true) continue;
    const assets = assetsOf(utxo);
    const nft = venuePoolNftOf(assets, factoryPolicyId);
    if (!nft || !utxo.inline_datum) continue;
    let datum: VenuePoolConfigData;
    try {
      datum = Data.from(utxo.inline_datum, VenuePoolConfigSchema);
    } catch {
      continue;
    }
    if (venueUnitOf(datum.pool_nft) !== nft) continue;
    return { utxo, nft, datum };
  }
  return null;
}

/** Classifies one transaction against one pool. Pure. */
export function venuePoolEventFrom(args: { tx: HistoryTx; factoryPolicyId: string }): VenuePoolEvent | null {
  const out = poolEntry(args.tx.outputs, args.factoryPolicyId);
  if (!out) return null;
  const previous = poolEntry(args.tx.inputs, args.factoryPolicyId);
  const after = snapshotOf(out.utxo, out.datum);
  const zero = { treasuryX: 0n, treasuryY: 0n, royaltyX: 0n, royaltyY: 0n };

  if (!previous) {
    return { txHash: args.tx.hash, kind: 'opened', poolNft: out.nft, after, accrued: zero };
  }

  const before = snapshotOf(previous.utxo, previous.datum);
  const accrued = {
    treasuryX: out.datum.treasury_x - previous.datum.treasury_x,
    treasuryY: out.datum.treasury_y - previous.datum.treasury_y,
    royaltyX: out.datum.royalty_x - previous.datum.royalty_x,
    royaltyY: out.datum.royalty_y - previous.datum.royalty_y,
  };
  const base = {
    txHash: args.tx.hash,
    poolNft: out.nft,
    after,
    before,
    accrued,
    previousTxHash: previous.utxo.tx_hash,
  };

  // **Reserves are netted; deltas are not.** The fee slices stay in the pool
  // and move to the counters, so the tradable reserve grows by LESS than the
  // trader put in. What a trade actually executed at is the BALANCE movement —
  // the same reading `pool.ak` takes, since it compares both states under the
  // old datum. Reporting the netted delta as the amount traded would understate
  // every trade by its own fee.
  const dx = after.balanceX - before.balanceX;
  const dy = after.balanceY - before.balanceY;
  // The netted movement is what tells a fee withdrawal from everything else:
  // it is the only event that moves the balance and not the price.
  const dnx = after.reservesX - before.reservesX;
  const dny = after.reservesY - before.reservesY;
  const dLq = after.liquidity - before.liquidity;
  const grewX = accrued.treasuryX > 0n || accrued.royaltyX > 0n;
  const grewY = accrued.treasuryY > 0n || accrued.royaltyY > 0n;
  const fell = accrued.treasuryX < 0n || accrued.treasuryY < 0n || accrued.royaltyX < 0n || accrued.royaltyY < 0n;

  // A swap credits its slices on the INPUT side only, and that side is the one
  // whose reserve grew. Reading the direction off the counters rather than off
  // the sign of the movement is what tells a swap from a lopsided deposit.
  if (!fell && grewX !== grewY && dx > 0n !== dy > 0n) {
    const inputIsX = grewX;
    if ((inputIsX && dx > 0n && dy < 0n) || (!inputIsX && dy > 0n && dx < 0n)) {
      return {
        ...base,
        kind: 'swap',
        swap: {
          inputUnit: venueUnitOf(inputIsX ? out.datum.pool_x : out.datum.pool_y),
          outputUnit: venueUnitOf(inputIsX ? out.datum.pool_y : out.datum.pool_x),
          tradedIn: inputIsX ? dx : dy,
          paidOut: inputIsX ? -dy : -dx,
        },
      };
    }
  }

  // A withdrawal takes accrued fees out. The BALANCE falls and the tradable
  // reserve does not move at all, which is why it never changes the price.
  if (fell && dnx === 0n && dny === 0n) {
    return { ...base, kind: 'feeWithdrawal' };
  }

  if (!grewX && !grewY && !fell) {
    if (dx > 0n && dy > 0n && dLq > 0n) return { ...base, kind: 'deposit' };
    if (dx < 0n && dy < 0n && dLq < 0n) return { ...base, kind: 'redeem' };
  }

  return {
    ...base,
    kind: 'unclassified',
    reason:
      `the balance moved by ${dx} and ${dy}, the tradable reserve by ${dnx} and ${dny}, liquidity by ` +
      `${dLq}, and the counters by ` +
      `${accrued.treasuryX}/${accrued.treasuryY} treasury and ${accrued.royaltyX}/${accrued.royaltyY} ` +
      'royalty — which matches none of the shapes this pool can be moved in.',
  };
}

export interface VenuePoolHistory {
  /** Newest first: the transaction that made the pool as it stands, then back. */
  events: VenuePoolEvent[];
  /** True when the walk reached the transaction that opened the pool. */
  reachedGenesis: boolean;
  /**
   * Why the walk stopped, when it was not genesis.
   *
   * A caller that does not check this cannot tell a complete history from a
   * truncated one, and the two look identical in the events themselves.
   */
  stoppedBy?: 'stopAtTxHash' | 'maxEvents' | 'brokenChain';
}

/**
 * Walks a pool's history backward from where it stands now.
 *
 * `stopAtTxHash` is the incremental read: give the newest transaction already
 * known and only what has happened since comes back. `maxEvents` bounds a
 * feed. Reaching neither means the whole history, back to the pool opening.
 *
 * The walk follows real inputs, so what comes back is always a history the
 * chain currently has — a rolled-back event is simply not on the path.
 */
export async function readVenuePoolHistory(
  provider: VenueHistoryProvider,
  args: {
    /** The pool as it stands. Its `txHash` is where the walk begins. */
    pool: Pick<VenuePoolUtxo, 'txHash'>;
    factoryPolicyId: string;
    /** Stop once this transaction is reached; it is not included. */
    stopAtTxHash?: string;
    /** Stop after this many events. */
    maxEvents?: number;
  },
): Promise<VenuePoolHistory> {
  const events: VenuePoolEvent[] = [];
  let cursor: string | undefined = args.pool.txHash;

  while (cursor) {
    if (cursor === args.stopAtTxHash) {
      return { events, reachedGenesis: false, stoppedBy: 'stopAtTxHash' };
    }
    if (args.maxEvents !== undefined && events.length >= args.maxEvents) {
      return { events, reachedGenesis: false, stoppedBy: 'maxEvents' };
    }

    const tx: HistoryTx = await provider.getTxUtxos(cursor);
    const event = venuePoolEventFrom({ tx, factoryPolicyId: args.factoryPolicyId });
    if (!event) {
      // The predecessor named a transaction with no pool output. Nothing
      // reaches genesis from here, and saying so beats returning a history
      // that quietly begins in the middle.
      return { events, reachedGenesis: false, stoppedBy: 'brokenChain' };
    }
    events.push(event);
    if (event.kind === 'opened') return { events, reachedGenesis: true };
    cursor = event.previousTxHash;
  }

  return { events, reachedGenesis: false, stoppedBy: 'brokenChain' };
}

/** Only the swaps, newest first — what a price feed and a trade list want. */
export function venueSwapsOnly(history: VenuePoolHistory): VenuePoolEvent[] {
  return history.events.filter((event) => event.kind === 'swap');
}

/**
 * What the creator and the platform earned over the events given.
 *
 * Summed from each event's own counter movement rather than read off the
 * latest datum, because a withdrawal resets a counter — the datum says what is
 * owed now, and this says what was earned across the period.
 */
export function venueFeesEarned(history: VenuePoolHistory): {
  treasuryX: bigint;
  treasuryY: bigint;
  royaltyX: bigint;
  royaltyY: bigint;
} {
  const total = { treasuryX: 0n, treasuryY: 0n, royaltyX: 0n, royaltyY: 0n };
  for (const event of history.events) {
    if (event.accrued.treasuryX > 0n) total.treasuryX += event.accrued.treasuryX;
    if (event.accrued.treasuryY > 0n) total.treasuryY += event.accrued.treasuryY;
    if (event.accrued.royaltyX > 0n) total.royaltyX += event.accrued.royaltyX;
    if (event.accrued.royaltyY > 0n) total.royaltyY += event.accrued.royaltyY;
  }
  return total;
}
