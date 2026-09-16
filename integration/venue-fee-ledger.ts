// ============================================================================
// Noctis Zone — NoctisSwap: what the venue has earned, and what to collect
// ============================================================================
// The platform's slice of every swap is not paid to the platform. It is
// CREDITED, in the pool's own datum, to a counter that `read_pool_state`
// subtracts back out of the reserves — so the money sits in the pool's UTXO
// while belonging to nobody who trades there. Collecting it is a separate
// transaction, taken when the platform chooses.
//
// Four things follow, and they are what this module is for.
//
// **A withdrawal costs exactly one network fee.** The payout output has to
// hold the protocol's minimum lovelace to exist at all, and a small ADA
// counter cannot fund that on its own — so the platform tops it up from its
// own wallet. That top-up is NOT a cost: it lands in the payout, which is the
// platform's own output. Track the whole transaction and every term cancels
// but one, leaving the platform's lovelace changed by `owedLovelace − fee`.
// Exactly, not approximately.
//
// **The two counters are not the same kind of thing.** The ADA counter pays
// for its own collection; the token counter never does. A pool whose ADA side
// is under the fee is a pool where collecting costs more than it returns,
// however many tokens have piled up beside it — and on a token-to-token pool,
// every withdrawal is ADA-negative by construction.
//
// **One transaction per pool, always.** `treasury.ak` counts the inputs at the
// pool validator and refuses a second, so a withdrawal speaks for one pool and
// no other. Fees are therefore charged per pool per collection, and the only
// lever an operator has is WHEN: waiting does not earn more, but it puts more
// behind the same single fee. Nothing decays and nothing expires.
//
// **Collecting does not move the price.** The counters are already outside the
// reserves, so taking them out changes the pool's balance and not its price —
// the one event in a pool's whole history with that signature, which is how
// `venue-pool-history.ts` tells a withdrawal from a redeem. There is no good
// or bad moment to collect, and no trader is affected by the choice.
//
// **The creator's counters are reported here and never moved.** `royalty_x`
// and `royalty_y` are the launch creator's 1.0%, claimed under a different
// redeemer, with their signature over the pool's nonce. They appear in this
// ledger because a fee ledger that showed only one side of the fee would be
// describing a different pool than the one on chain.
// ============================================================================

import type { HistoryTx, VenuePoolEvent, VenuePoolHistory } from './venue-pool-history.js';
import { venuePoolEventFrom } from './venue-pool-history.js';
import { type VenueAccrued, type VenueMarket, venuePoolMarket } from './venue-quote.js';
import { readVenuePoolState, type VenuePoolUtxo, venueSwapQuote, venueUnitOf } from './venue-swap.js';

/**
 * What one treasury withdrawal costs to run, in lovelace.
 *
 * The whole cost, and the only one: the network fee. Measured against a real
 * built withdrawal rather than asked for — `venue-treasury-withdrawal.test.ts`
 * builds both shapes offline and pins what each came to, so a change to either
 * validator or to the protocol's fee parameters fails a test rather than
 * quietly shifting every decision this module makes. Both validators
 * referenced rather than carried, which is how they are meant to be deployed:
 *
 *     ada pool, both counters       412,895
 *     token-to-token pool           417,691   ← dearer, and the figure below
 *
 * **It rests on the two DECLARED execution budgets, which are reasoned rather
 * than simulated** — a script's budget is part of what a transaction pays for.
 * Measure them against a real script context and re-measure this with them.
 * An operator holding a better figure passes it: every function here takes it
 * as an argument.
 */
export const VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE = 420_000n;

/** One counter, and what it is denominated in. */
export interface VenueFeeAmount {
  unit: string;
  amount: bigint;
}

/**
 * The platform's claim on one pool, split by what can pay for its own
 * collection and what cannot.
 */
export interface VenueTreasuryPosition {
  poolNft: string;
  /** The pool's own two assets, in the datum's order. */
  unitX: string;
  unitY: string;
  /** `treasury_x` and `treasury_y`, verbatim. */
  owedX: bigint;
  owedY: bigint;
  /**
   * The lovelace half of the two above. Zero on a token-to-token pool, where
   * neither counter is ADA and a collection can only cost lovelace.
   */
  owedLovelace: bigint;
  /** Whichever counters are not lovelace, with what they are. Zeroes omitted. */
  owedTokens: VenueFeeAmount[];
  /** The creator's counters. Reported, never moved by this module. */
  creatorOwed: { x: bigint; y: bigint };
}

/** Which side of the pool, if either, is ADA. */
function adaSideOf(pool: VenuePoolUtxo): 'x' | 'y' | null {
  const unitX = venueUnitOf(pool.datum.pool_x);
  const unitY = venueUnitOf(pool.datum.pool_y);
  if (unitX === 'lovelace') return 'x';
  if (unitY === 'lovelace') return 'y';
  return null;
}

/** What the platform may take out of one pool right now. */
export function venueTreasuryPosition(pool: VenuePoolUtxo): VenueTreasuryPosition {
  const cfg = pool.datum;
  const unitX = venueUnitOf(cfg.pool_x);
  const unitY = venueUnitOf(cfg.pool_y);
  const ada = adaSideOf(pool);
  const tokens: VenueFeeAmount[] = [];
  if (ada !== 'x' && cfg.treasury_x > 0n) tokens.push({ unit: unitX, amount: cfg.treasury_x });
  if (ada !== 'y' && cfg.treasury_y > 0n) tokens.push({ unit: unitY, amount: cfg.treasury_y });

  return {
    poolNft: venueUnitOf(cfg.pool_nft),
    unitX,
    unitY,
    owedX: cfg.treasury_x,
    owedY: cfg.treasury_y,
    owedLovelace: ada === 'x' ? cfg.treasury_x : ada === 'y' ? cfg.treasury_y : 0n,
    owedTokens: tokens,
    creatorOwed: { x: cfg.royalty_x, y: cfg.royalty_y },
  };
}

/** Whether a pool is worth a transaction today, and what it would come to. */
export interface VenueCollectionAdvice {
  poolNft: string;
  collect: boolean;
  reason: string;
  /** What the platform's lovelace changes by if it collects now. Exact. */
  netLovelace: bigint;
  position: VenueTreasuryPosition;
  /**
   * What the pool itself would pay for the token side, if it were sold
   * straight back in — an ESTIMATE, and an upper bound on one.
   *
   * Upper because selling it back costs an order of its own: the venue fills
   * through resting orders, so the real proceeds are this less the execution
   * fee, and less again whatever the pool has moved by the time it fills.
   * `null` when the pool has no ADA side to price against, or when nothing is
   * owed on the token side.
   */
  tokenSideLovelace: bigint | null;
}

/**
 * Whether one pool's accrued fees are worth collecting today.
 *
 * The test is on the ADA side alone, and deliberately: it is the only figure
 * here that is exact. The token side comes out in the same transaction for no
 * extra fee, so it is never a reason to wait — but it is not a reason to go
 * either, because a token has to be sold before it pays for anything, and
 * selling it costs another transaction.
 */
export function venueCollectionAdvice(args: {
  pool: VenuePoolUtxo;
  /** What one withdrawal costs. Defaults to the measured figure. */
  costLovelace?: bigint;
}): VenueCollectionAdvice {
  const cost = args.costLovelace ?? VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE;
  const position = venueTreasuryPosition(args.pool);
  const netLovelace = position.owedLovelace - cost;
  const tokenSideLovelace = venueTokenSideLovelace(args.pool);

  if (position.owedX <= 0n && position.owedY <= 0n) {
    return {
      poolNft: position.poolNft,
      collect: false,
      reason: 'nothing has accrued to the platform here yet, so there is nothing to collect.',
      netLovelace,
      position,
      tokenSideLovelace,
    };
  }

  if (netLovelace > 0n) {
    return {
      poolNft: position.poolNft,
      collect: true,
      reason:
        `its ${position.owedLovelace} lovelace clears the ${cost} a withdrawal costs, leaving ` +
        `${netLovelace}${position.owedTokens.length > 0 ? ', and the token side comes out in the same transaction' : ''}.`,
      netLovelace,
      position,
      tokenSideLovelace,
    };
  }

  return {
    poolNft: position.poolNft,
    collect: false,
    reason:
      `its ${position.owedLovelace} lovelace is under the ${cost} a withdrawal costs, so collecting now ` +
      `would leave the platform ${-netLovelace} lovelace worse off. Nothing here decays: one transaction ` +
      'is charged per pool per collection, so waiting puts more behind the same single fee.',
    netLovelace,
    position,
    tokenSideLovelace,
  };
}

/**
 * The token counters valued at what this pool would pay for them.
 *
 * Through the pool's own quote rather than its spot rate, because a sale
 * moves the price against itself and the quote is the only figure that says
 * so. `null` when the pool has no ADA side, or when the token side is empty.
 */
export function venueTokenSideLovelace(pool: VenuePoolUtxo): bigint | null {
  const ada = adaSideOf(pool);
  if (ada === null) return null;
  const cfg = pool.datum;
  const owedTokens = ada === 'x' ? cfg.treasury_y : cfg.treasury_x;
  if (owedTokens <= 0n) return null;

  const state = readVenuePoolState(cfg, pool.assets);
  const reserveIn = ada === 'x' ? state.reservesY : state.reservesX;
  const reserveOut = ada === 'x' ? state.reservesX : state.reservesY;
  if (reserveIn <= 0n || reserveOut <= 0n) return null;

  return venueSwapQuote({
    reserveIn,
    reserveOut,
    tradedIn: owedTokens,
    feeNum: cfg.fee_num,
    treasuryFee: cfg.treasury_fee,
    royaltyFee: cfg.royalty_fee,
  }).output;
}

/** Fees moved over a stretch of a pool's history, both directions. */
export interface VenueFeeReconciliation {
  poolNft: string;
  /** Summed from the counter movements: what the pool took in. */
  earned: VenueAccrued;
  /** Summed the same way, the other direction, reported positive. */
  withdrawn: VenueAccrued;
  /** What the datum says is owed right now. */
  owed: VenueAccrued;
  /** True when the walk reached the transaction that opened the pool. */
  complete: boolean;
  /**
   * `owed` less what this history accounts for.
   *
   * Over a COMPLETE history this must be zero on every counter, and that is a
   * real assertion rather than an arithmetic identity: a pool opens with all
   * four counters at zero — the factory refuses one that does not — so
   * everything owed today was earned and not yet withdrawn, on the record.
   * A positive figure here says the pool is carrying a claim nothing paid for.
   *
   * Over a PARTIAL history it is simply what was owed when the walk began, and
   * `complete` is what tells the two apart. A caller that reads this without
   * reading that is looking at a number with two meanings.
   */
  unexplained: VenueAccrued;
  /** Set when the history describes a different pool, or a different moment. */
  mismatch?: string;
}

const ZERO_ACCRUED: VenueAccrued = { treasuryX: 0n, treasuryY: 0n, royaltyX: 0n, royaltyY: 0n };

function accruedOf(pool: VenuePoolUtxo): VenueAccrued {
  return {
    treasuryX: pool.datum.treasury_x,
    treasuryY: pool.datum.treasury_y,
    royaltyX: pool.datum.royalty_x,
    royaltyY: pool.datum.royalty_y,
  };
}

function subtract(a: VenueAccrued, b: VenueAccrued): VenueAccrued {
  return {
    treasuryX: a.treasuryX - b.treasuryX,
    treasuryY: a.treasuryY - b.treasuryY,
    royaltyX: a.royaltyX - b.royaltyX,
    royaltyY: a.royaltyY - b.royaltyY,
  };
}

/** True when every counter of an accrued figure is zero. */
export function venueAccruedIsZero(a: VenueAccrued): boolean {
  return a.treasuryX === 0n && a.treasuryY === 0n && a.royaltyX === 0n && a.royaltyY === 0n;
}

/**
 * Reconciles what a pool says it owes against what its history says it took.
 *
 * Both halves come from the same counter movements, so `earned - withdrawn` is
 * an identity over the events. What it is checked against is not: the pool's
 * CURRENT datum, which the walk never used, and the zero every pool opens at.
 * Two different failures are visible through that, and neither has any other
 * signal — a history walked for the wrong pool, and a pool that began life
 * already owing somebody money.
 */
export function venueReconcileFees(args: { pool: VenuePoolUtxo; history: VenuePoolHistory }): VenueFeeReconciliation {
  const poolNft = venueUnitOf(args.pool.datum.pool_nft);
  const earned = { ...ZERO_ACCRUED };
  const withdrawn = { ...ZERO_ACCRUED };

  for (const event of args.history.events) {
    for (const key of ['treasuryX', 'treasuryY', 'royaltyX', 'royaltyY'] as const) {
      const moved = event.accrued[key];
      if (moved > 0n) earned[key] += moved;
      else if (moved < 0n) withdrawn[key] -= moved;
    }
  }

  const owed = accruedOf(args.pool);
  const complete = args.history.reachedGenesis;
  const newest: VenuePoolEvent | undefined = args.history.events[0];

  let mismatch: string | undefined;
  if (newest && newest.poolNft !== poolNft) {
    mismatch =
      `this history walks pool ${newest.poolNft}, and the pool given is ${poolNft}. Nothing below ` +
      'describes the pool that was asked about.';
  } else if (newest && newest.txHash !== args.pool.txHash) {
    mismatch =
      `the pool given sits at ${args.pool.txHash}, and the newest event in this history is ` +
      `${newest.txHash}. The history is of an earlier moment, so what is owed now is not what it ` +
      'accounts for.';
  }

  return {
    poolNft,
    earned,
    withdrawn,
    owed,
    complete,
    unexplained: subtract(owed, subtract(earned, withdrawn)),
    ...(mismatch ? { mismatch } : {}),
  };
}

/** The venue's whole fee position, across every pool it was given. */
export interface VenueFeeLedger {
  pools: VenueCollectionAdvice[];
  /** Only those worth a transaction today, most lovelace first. */
  collect: VenueCollectionAdvice[];
  /** The platform's claim across every pool, by unit. */
  owedByUnit: VenueFeeAmount[];
  /** The creator's claim across every pool, by unit. Reported, never moved. */
  creatorOwedByUnit: VenueFeeAmount[];
  /** What collecting everything advised would net the platform, in lovelace. */
  netLovelace: bigint;
  /** What collecting EVERYTHING would net instead, advised or not. */
  netLovelaceIfAll: bigint;
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
 * The book: every pool's position, and which of them to act on.
 *
 * `netLovelaceIfAll` is what makes the advice legible rather than arbitrary —
 * it is what a sweep of every pool would come to, so an operator can see the
 * difference collecting only the worthwhile ones makes, and overrule it.
 */
export function venueFeeLedger(args: { pools: readonly VenuePoolUtxo[]; costLovelace?: bigint }): VenueFeeLedger {
  const cost = args.costLovelace ?? VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE;
  const pools = args.pools.map((pool) => venueCollectionAdvice({ pool, costLovelace: cost }));
  const owed = new Map<string, bigint>();
  const creatorOwed = new Map<string, bigint>();
  let netLovelaceIfAll = 0n;

  for (const advice of pools) {
    const p = advice.position;
    addTo(owed, 'lovelace', p.owedLovelace);
    for (const token of p.owedTokens) addTo(owed, token.unit, token.amount);
    addTo(creatorOwed, p.unitX, p.creatorOwed.x);
    addTo(creatorOwed, p.unitY, p.creatorOwed.y);
    // A pool with nothing accrued is not withdrawable at all — `treasury.ak`
    // requires one side to really move — so it is not part of a sweep and its
    // fee is not part of one either.
    if (p.owedX > 0n || p.owedY > 0n) netLovelaceIfAll += advice.netLovelace;
  }

  const collect = pools.filter((advice) => advice.collect).sort((a, b) => (b.netLovelace > a.netLovelace ? 1 : -1));

  return {
    pools,
    collect,
    owedByUnit: sortedTotals(owed),
    creatorOwedByUnit: sortedTotals(creatorOwed),
    netLovelace: collect.reduce((sum, advice) => sum + advice.netLovelace, 0n),
    netLovelaceIfAll,
  };
}

/** A pool's market state and its fee position, read off one datum. */
export interface VenuePoolFeeReport {
  market: VenueMarket;
  advice: VenueCollectionAdvice;
}

/**
 * The pool's own market state alongside its fee position.
 *
 * For a transparency page, which wants both and would otherwise read the same
 * datum twice through two modules that could disagree about it.
 */
export function venuePoolFeeReport(pool: VenuePoolUtxo, costLovelace?: bigint): VenuePoolFeeReport {
  return {
    market: venuePoolMarket(pool),
    advice: venueCollectionAdvice({ pool, costLovelace }),
  };
}

/** One collection, as an outsider reads it back off the chain. */
export interface VenueCollected {
  poolNft: string;
  /** Positive amounts, one per counter — what left the pool. */
  collected: VenueAccrued;
  /** What those counters are denominated in, so a total can be taken. */
  unitX: string;
  unitY: string;
}

/**
 * Whether a transaction was a fee collection, and for how much — read from the
 * transaction alone, the way somebody checking the platform's own disclosure
 * would have to.
 *
 * The platform publishes its addresses and discloses quarterly, so a
 * collection has to be verifiable by a stranger holding nothing but a
 * transaction hash. This is that check: the same classification the history
 * walk applies, against one transaction, with the counter movement reported
 * as an amount collected rather than as a negative accrual.
 */
export function venueCollectionFrom(args: { tx: HistoryTx; factoryPolicyId: string }): VenueCollected | null {
  const event = venuePoolEventFrom(args);
  if (event?.kind !== 'feeWithdrawal') return null;
  return {
    poolNft: event.poolNft,
    collected: subtract(ZERO_ACCRUED, event.accrued),
    unitX: venueUnitOf(event.after.datum.pool_x),
    unitY: venueUnitOf(event.after.datum.pool_y),
  };
}
