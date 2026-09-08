// ============================================================================
// Noctis Zone — NoctisSwap: filling a swap order against a pool
// ============================================================================
// A fill is ONE order meeting ONE pool, and the order validator says so in the
// bluntest way available: `list.length(self.inputs) == 2`. So a NoctisSwap
// "batch" is not one transaction carrying N orders — it is a CHAIN of
// two-input transactions, each spending the pool output the last one made.
//
// That is a deliberate property rather than a limitation. Orders that could
// net against each other inside one transaction would pay the creator and the
// platform on the DIFFERENCE only; here every order meets the pool alone, so
// both fee slices are taken on its whole input. Throughput comes from
// chaining, which does not need confirmation between links: a transaction may
// spend an output the transaction before it created, in the same block.
//
// Two inputs also means the executor supplies no funds. The order carries its
// own `ex_fee` in lovelace, and the transaction balances out of that: the
// network fee comes off it and whatever is left is the executor's. So a
// batcher never funds a fill, and an order that under-funds its own execution
// simply cannot be built — which is where `MIN_*` below comes from.
//
// What this module is: the arithmetic the two validators enforce, mirrored
// exactly, so the batcher can propose values they will accept. Nothing here is
// trusted on chain — but everything here has to AGREE to the unit, or the fill
// is rejected and the order sits.
//
// The three rules worth naming, because each has an obvious wrong version:
//
//   - **Reserves are net of the counters; deltas are not.** `read_pool_state`
//     subtracts `treasury_*` and `royalty_*` from the balance, but the pool
//     validator reads BOTH states under the OLD datum, so a state difference
//     is the raw balance movement. Price against the netted reserve; measure
//     movement against the balance. Using the netted figure for both
//     under-charges every swap after the first fee has accrued.
//
//   - **The fee slices come out of the input, and stay in the pool.** The pool
//     keeps `traded` in full and credits `floor(traded * fee / fee_den)` to
//     each counter, which lowers the reserve the NEXT swap prices against.
//     Nothing leaves for the creator or the platform here; a withdrawal is its
//     own transaction later.
//
//   - **A partial fill's fee is a ceiling, not a share.** The order permits
//     `fee_removed * tradable_input <= traded * ex_fee` — at most pro rata.
//     Taking exactly pro rata is the most an executor may have, and rounding
//     it up is the one arithmetic slip that turns a valid fill invalid.
//
// ============================================================================

import { Constr, credentialToAddress, Data, type Network as LucidNetwork } from '@lucid-evolution/lucid';
import {
  VENUE_FEE_DEN,
  VENUE_MAX_LQ_CAP,
  type VenueAssetData,
  VenueAssetShape,
  type VenuePoolConfigData,
} from './venue-pool.js';

/**
 * `PoolRedeemer.action` — the pool's arms, as INTEGER FIELDS rather than
 * constructor indices.
 *
 * `pool.ak` declares one constructor carrying `{ action, self_ix }`, so these
 * numbers are not positions in a variant list and no blueprint sweep can
 * check them. They are pinned by `venue-swap.test.ts` against the constants
 * the validator declares instead.
 */
export const VENUE_POOL_ACTION = {
  Deposit: 0,
  Redeem: 1,
  Swap: 2,
  DAOAction: 3,
  WithdrawRoyalty: 4,
  RedirectRoyalty: 5,
} as const;

/**
 * The dearest a single fill has been measured to need, in lovelace.
 *
 * Not the network fee alone — it is the whole floor under an order: the fee,
 * plus the smallest change output the protocol's per-byte minimum admits,
 * because a fill has two inputs and neither is the executor's, so its payment
 * has nowhere else to go.
 *
 * Bisected against the real builder, across every dimension that makes a fill
 * bigger, in lovelace:
 *
 *     sell, token in                              1,401,528
 *     buy, ADA in                                 1,403,904
 *     buy, placer named a stake key               1,405,136
 *     full fill, gated executor + stake key       1,406,676
 *     token-to-token, gated + stake key           1,409,932   ← dearest
 *
 * Rounded up from the dearest. Re-measure when either validator changes, or
 * when the protocol's fee or per-byte parameters move.
 */
export const VENUE_FILL_FLOOR_LOVELACE = 1_410_000n;

/**
 * What an order should set aside for its own execution: **1.5 ADA**.
 *
 * A ceiling, not a price — a settled build charges what the transaction
 * actually costs and returns the rest to the placer, so this is the most a
 * fill may take rather than what it will.
 *
 * It clears the dearest measured fill by about 90,000 lovelace, roughly 6%.
 * That margin is what absorbs a validator growing slightly, or a protocol
 * parameter moving, without every order in flight becoming unfillable.
 *
 * **It funds ONE fill.** The order's fee is drawn pro rata, so a fill of part
 * of an order may take only that part of the fee while costing a whole
 * transaction — see `venueMinFundableTrade`, which is what a front end should
 * use to set the placer's own `min_marginal_output` rather than leaving an
 * order quietly unfillable.
 *
 * For scale: batched Cardano venues charge around 2 ADA an order.
 */
export const VENUE_ORDER_EXECUTION_FEE_LOVELACE = 1_500_000n;

/**
 * The smallest part of an order an executor can afford to fill.
 *
 * The order permits `fee_removed * tradable_input <= traded * ex_fee`, so a
 * fill of a fraction of the order may draw at most that fraction of the fee —
 * while paying for a whole transaction either way. Below this, no executor can
 * build the fill at all, whatever it would like to do.
 *
 * At the recommended 1.5 ADA against the dearest measured fill, that is about
 * 94% of the order: at 1.5 ADA an order fills whole or waits, which is a
 * choice worth making visible in the order itself.
 *
 * Returns `tradable_input` when even a full fill cannot be funded — there is
 * no part of such an order that can be filled, and the caller should say so
 * rather than offer a number that will not work either.
 */
export function venueMinFundableTrade(args: {
  tradableInput: bigint;
  exFee: bigint;
  /** What one fill costs; `VENUE_FILL_FLOOR_LOVELACE` unless measured again. */
  fillCostLovelace?: bigint;
}): bigint {
  const cost = args.fillCostLovelace ?? VENUE_FILL_FLOOR_LOVELACE;
  if (args.exFee <= 0n || args.tradableInput <= 0n) return args.tradableInput;
  if (args.exFee < cost) return args.tradableInput;
  // The pro-rata share is a floor, and the cost is a whole number, so
  // `floor(traded * exFee / tradable) >= cost` is exactly
  // `traded >= ceil(cost * tradable / exFee)`.
  const numerator = cost * args.tradableInput;
  const smallest = numerator / args.exFee + (numerator % args.exFee === 0n ? 0n : 1n);
  return smallest > args.tradableInput ? args.tradableInput : smallest;
}

/** `splash/rational/Rational`: a numerator and a denominator, one constructor. */
export const VenueRationalShape = Data.Object({
  num: Data.Integer(),
  denom: Data.Integer(),
});
export type VenueRationalData = Data.Static<typeof VenueRationalShape>;

/** `noctisswap/orders/SwapConfig`, field for field from the venue blueprint. */
export const VenueSwapConfigShape = Data.Object({
  pool_nft: VenueAssetShape,
  input: VenueAssetShape,
  output: VenueAssetShape,
  tradable_input: Data.Integer(),
  base_price: VenueRationalShape,
  min_marginal_output: Data.Integer(),
  ex_fee: Data.Integer(),
  reward_pkh: Data.Bytes(),
  stake_pkh: Data.Nullable(Data.Bytes()),
  permitted_executors: Data.Array(Data.Bytes()),
});
export type VenueSwapConfigData = Data.Static<typeof VenueSwapConfigShape>;
export const VenueSwapConfigSchema = VenueSwapConfigShape as unknown as VenueSwapConfigData;

/** `PoolRedeemer { action, self_ix }` — `self_ix` is an INPUT position. */
export function venuePoolRedeemer(action: number, selfIx: number): string {
  return Data.to(new Constr(0, [BigInt(action), BigInt(selfIx)]));
}

/**
 * `SwapAction.Fill` — three positions the validator resolves by number:
 * two into `self.inputs` and one into `self.outputs`.
 *
 * Inputs are the dangerous pair. The transaction builder SORTS them, so the
 * order a plan lists them in is not the order they end up in; these have to
 * be the positions after sorting, and the builder checks the finished
 * transaction rather than trusting its own prediction.
 */
export function venueFillRedeemer(poolInIx: number, orderInIx: number, successorIx: number): string {
  return Data.to(new Constr(0, [BigInt(poolInIx), BigInt(orderInIx), BigInt(successorIx)]));
}

/** `SwapAction.Cancel` — the placer taking their own order back. */
export function venueCancelRedeemer(): string {
  return Data.to(new Constr(1, []));
}

/** The `unit` key a value holds an `Asset` under: `lovelace`, or policy+name. */
export function venueUnitOf(asset: VenueAssetData): string {
  return asset.policy === '' && asset.name === '' ? 'lovelace' : `${asset.policy}${asset.name}`;
}

function heldOf(assets: Readonly<Record<string, bigint>>, asset: VenueAssetData): bigint {
  return assets[venueUnitOf(asset)] ?? 0n;
}

/** What `read_pool_state` reads out of a pool's own value. */
export interface VenuePoolState {
  /** `pool_x` held, LESS the two counters on that side. */
  reservesX: bigint;
  /** `pool_y` held, LESS the two counters on that side. */
  reservesY: bigint;
  /** `max_lq_cap` less the LQ the pool still holds. */
  liquidity: bigint;
}

/**
 * The pool's reserves, netted the way the validator nets them.
 *
 * The counters are what the creator and the platform have accrued and not yet
 * withdrawn. That value sits in the same UTXO as the reserves and is NOT
 * tradable — pricing against the gross balance would sell liquidity that
 * belongs to somebody else, and would drift further from the truth with every
 * swap until the next withdrawal.
 */
export function readVenuePoolState(cfg: VenuePoolConfigData, assets: Readonly<Record<string, bigint>>): VenuePoolState {
  return {
    reservesX: heldOf(assets, cfg.pool_x) - cfg.treasury_x - cfg.royalty_x,
    reservesY: heldOf(assets, cfg.pool_y) - cfg.treasury_y - cfg.royalty_y,
    liquidity: VENUE_MAX_LQ_CAP - heldOf(assets, cfg.pool_lq),
  };
}

/** `slice_ok`: a counter grows by exactly `floor(input * fee / fee_den)`. */
export function venueFeeSlice(input: bigint, fee: bigint): bigint {
  return (input * fee) / VENUE_FEE_DEN;
}

/** What a swap of `tradedIn` may take out, and what each counter is owed. */
export interface VenueSwapQuote {
  /** The most the pool may give. `swap_ok` permits no more; a fill takes exactly this. */
  output: bigint;
  /** Credited to the platform's counter on the INPUT side. */
  treasurySlice: bigint;
  /** Credited to the creator's counter on the INPUT side. */
  royaltySlice: bigint;
}

/**
 * The pool's own bound, solved for the output rather than tested against one.
 *
 * `swap_ok` states it as `out * (rIn * fee_den + inF) <= rOut * inF`, with
 * `inF = tradedIn * net` and `net = fee_num - treasury_fee - royalty_fee`.
 * The largest integer satisfying that is the floor of the quotient, so this
 * is the same rule rearranged — not an approximation of it, and not a
 * separate formula that happens to agree.
 *
 * Integer division truncates toward zero in both languages and every term
 * here is non-negative, so the two floors are the same floor.
 */
export function venueSwapQuote(args: {
  reserveIn: bigint;
  reserveOut: bigint;
  tradedIn: bigint;
  feeNum: bigint;
  treasuryFee: bigint;
  royaltyFee: bigint;
}): VenueSwapQuote {
  const { reserveIn, reserveOut, tradedIn, feeNum, treasuryFee, royaltyFee } = args;
  const net = feeNum - treasuryFee - royaltyFee;
  if (net <= 0n) {
    throw new Error(
      `This pool's fee schedule leaves nothing after its slices: ${feeNum} - ${treasuryFee} - ${royaltyFee}. ` +
        'The pool validator refuses every swap against it.',
    );
  }
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new Error(
      `A pool with reserves ${reserveIn}/${reserveOut} has no price. Both sides must hold something for the ` +
        'constant-product bound to mean anything, and the validator requires it.',
    );
  }
  if (tradedIn <= 0n) throw new Error(`A swap must trade something; this one trades ${tradedIn}.`);

  const inF = tradedIn * net;
  return {
    output: (reserveOut * inF) / (reserveIn * VENUE_FEE_DEN + inF),
    treasurySlice: venueFeeSlice(tradedIn, treasuryFee),
    royaltySlice: venueFeeSlice(tradedIn, royaltyFee),
  };
}

/** A pool as the batcher holds one: its UTXO, its value and its datum. */
export interface VenuePoolUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Record<string, bigint>;
  datum: VenuePoolConfigData;
}

/** A swap order as the batcher holds one. */
export interface VenueSwapOrderUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: Record<string, bigint>;
  datum: VenueSwapConfigData;
  /** Where the chain accepted it — see `venueFillSequence`. */
  placedAt?: VenueOrderPosition;
}

/** Where an order sits in the chain's own record of what happened first. */
export interface VenueOrderPosition {
  blockHeight: number;
  txIndexInBlock: number;
}

/**
 * The fill order, and the whole of the batcher's discretion over it.
 *
 * A pool fills one order per transaction, so SOMETHING decides which order
 * meets a given price. Left to the executor that is a choice worth money, and
 * an executor that reorders around its own position is the front-running an
 * order-book venue has to answer for.
 *
 * The answer is to have no discretion: **orders fill in the order the chain
 * accepted them** — block height, then the transaction's index within that
 * block, then the order's output index within that transaction. Every one of
 * those is a fact of the chain that anyone can read, so the sequence a batcher
 * is obliged to follow is derivable from public data by anyone, and a run of
 * fills that departs from it is visible as such after the fact.
 *
 * What it governs, stated rather than implied: the EXECUTOR's discretion, which
 * is the part a venue operator is answerable for. What anyone can read from a
 * public mempool is not something an ordering policy reaches, on this chain or
 * any other.
 *
 * An order with no recorded position sorts last, and among themselves such
 * orders keep the order they were given in — a batcher that has not looked up
 * where an order came from does not get to treat it as early.
 */
export function venueFillSequence<T extends VenueSwapOrderUtxo>(orders: readonly T[]): T[] {
  return orders
    .map((order, tieBreak) => ({ order, tieBreak }))
    .sort((a, b) => {
      const pa = a.order.placedAt;
      const pb = b.order.placedAt;
      if (!pa && !pb) return a.tieBreak - b.tieBreak;
      if (!pa) return 1;
      if (!pb) return -1;
      return (
        pa.blockHeight - pb.blockHeight ||
        pa.txIndexInBlock - pb.txIndexInBlock ||
        a.order.outputIndex - b.order.outputIndex ||
        a.tieBreak - b.tieBreak
      );
    })
    .map((entry) => entry.order);
}

/** Everything one fill moves, priced and ready to build a transaction from. */
export interface VenueFill {
  /** How much of the order's input the pool takes. */
  traded: bigint;
  /** The lovelace the executor actually keeps from this fill. */
  exFeeTaken: bigint;
  /** The most it could have kept — pro rata on a partial, the whole fee on a full one. */
  permittedFee: bigint;
  /** What the pool pays out on the other side. */
  poolGave: bigint;
  /** The pool's successor datum: the counters grown, everything else identical. */
  poolDatum: VenuePoolConfigData;
  /** The pool's successor value. */
  poolAssets: Record<string, bigint>;
  /**
   * The order's successor: the placer's reward output when the order is
   * finished, or the order continuing at its own address when it is not.
   */
  successor: {
    address: string;
    assets: Record<string, bigint>;
    /** Present only on a continuation — a reward output carries no datum. */
    datum?: VenueSwapConfigData;
  };
  /** True when the order is fully filled and pays out to the placer. */
  terminated: boolean;
}

function pruneZero(assets: Record<string, bigint>): Record<string, bigint> {
  return Object.fromEntries(Object.entries(assets).filter(([, quantity]) => quantity !== 0n));
}

/** The address `reward_address_ok` accepts: the placer's keys and no other. */
export function venueRewardAddress(cfg: VenueSwapConfigData, network: LucidNetwork): string {
  const payment = { type: 'Key' as const, hash: cfg.reward_pkh };
  if (cfg.stake_pkh === null) return credentialToAddress(network, payment);
  return credentialToAddress(network, payment, { type: 'Key', hash: cfg.stake_pkh });
}

/** What a pool can do for an order right now, and whether anyone can do it. */
export interface VenueFillableAmount {
  /** The most of the order that clears its price floor at this pool state. */
  largest: bigint;
  /** The least anyone can afford to fill — the pro-rata share must cover a fill. */
  smallestFundable: bigint;
  /**
   * True when the two overlap. False means the order cannot be filled at all
   * as things stand: either the pool has moved too far for its floor, or its
   * own size cannot clear the floor it set, or its fee is too small.
   */
  fillable: boolean;
}

/**
 * How much of an order a pool can serve, and whether an executor can afford to.
 *
 * **This is the check a front end owes the placer at placement time**, and the
 * reason the recommended fee can stay at one fill's worth. Two ways an order
 * ends up unfillable, and neither announces itself:
 *
 *   - **A floor its own size cannot clear.** `base_price` is the average over
 *     what is traded, and a trade moves the price against itself, so an order
 *     worth roughly p% of the pool needs a floor about p% below spot. Set from
 *     spot instead of from the quote, on an order any larger than a rounding
 *     error, and no amount of it ever clears — the order is dead on arrival.
 *   - **A fee too small for the part that would fill.** The fee is drawn pro
 *     rata, so an order the pool can only half serve needs twice a fill's cost.
 *
 * Both are answerable before the order is signed, which is where they should
 * be answered. Afterwards they look identical from outside: an order sitting
 * there, doing nothing, for no visible reason.
 *
 * The search is a bisection, which is sound because the average price a
 * constant-product pool gives falls monotonically as the trade grows.
 */
export function venueFillableAmount(args: {
  pool: VenuePoolUtxo;
  order: VenueSwapOrderUtxo;
  /** What one fill costs; `VENUE_FILL_FLOOR_LOVELACE` unless measured again. */
  fillCostLovelace?: bigint;
}): VenueFillableAmount {
  const cfg = args.pool.datum;
  const swap = args.order.datum;
  const smallestFundable = venueMinFundableTrade({
    tradableInput: swap.tradable_input,
    exFee: swap.ex_fee,
    fillCostLovelace: args.fillCostLovelace,
  });
  const state = readVenuePoolState(cfg, args.pool.assets);
  const inputIsX = venueUnitOf(swap.input) === venueUnitOf(cfg.pool_x);
  const reserveIn = inputIsX ? state.reservesX : state.reservesY;
  const reserveOut = inputIsX ? state.reservesY : state.reservesX;

  const clears = (traded: bigint): boolean => {
    if (traded <= 0n || reserveIn <= 0n || reserveOut <= 0n) return false;
    const { output } = venueSwapQuote({
      reserveIn,
      reserveOut,
      tradedIn: traded,
      feeNum: cfg.fee_num,
      treasuryFee: cfg.treasury_fee,
      royaltyFee: cfg.royalty_fee,
    });
    return output * swap.base_price.denom >= traded * swap.base_price.num;
  };

  let largest = 0n;
  if (clears(swap.tradable_input)) {
    largest = swap.tradable_input;
  } else {
    let lo = 0n;
    let hi = swap.tradable_input;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (clears(mid)) lo = mid;
      else hi = mid;
    }
    largest = lo;
  }

  const fundedFully = swap.ex_fee >= (args.fillCostLovelace ?? VENUE_FILL_FLOOR_LOVELACE);
  return { largest, smallestFundable, fillable: fundedFully && largest >= smallestFundable };
}

/**
 * Prices one fill and lays out both sides of it.
 *
 * `tradeAmount` defaults to the whole order. Anything less makes it a partial
 * fill, and the order then continues at its own address — which the placer
 * pays for, so a partial is only worth proposing when the pool cannot serve
 * the whole order at the placer's floor.
 */
export function planVenueSwapFill(args: {
  pool: VenuePoolUtxo;
  order: VenueSwapOrderUtxo;
  network: LucidNetwork;
  /** How much of `tradable_input` to fill. Defaults to all of it. */
  tradeAmount?: bigint;
  /**
   * What the executor actually takes, when that is less than the order allows.
   *
   * `ex_fee` is a CEILING, not a price. Every rule the order states about it
   * is an inequality — `input_removed <= traded + fee_removed` on the way in,
   * `output_added >= pool_gave` on the way out — so an executor may take less
   * and leave the difference with the placer, and both validators accept it.
   *
   * That is worth doing rather than merely allowed. Taking the whole ceiling
   * leaves the executor with change, and a change output has to clear the
   * minimum any UTXO must hold — so an order would have to carry the network
   * fee PLUS that minimum before it could be filled at all. Taking only what
   * the transaction costs removes the change output and roughly halves what an
   * order has to set aside.
   *
   * Defaults to the whole permitted amount.
   */
  executorFee?: bigint;
  /** Least lovelace an output may hold, from the protocol parameters. */
  minOutputLovelace: bigint;
  /**
   * What one fill costs, when the caller wants this refused rather than built.
   *
   * A fill whose pro-rata share of the fee falls short cannot be built by
   * anybody: the executor has no input of its own, so the transaction simply
   * will not balance, and the builder's complaint names nothing. Passing the
   * cost here turns that into a refusal that says which fill, how short, and
   * how much of the order would have to be filled instead.
   */
  fillCostLovelace?: bigint;
}): VenueFill {
  const { pool, order, network, minOutputLovelace } = args;
  const cfg = pool.datum;
  const swap = order.datum;
  const traded = args.tradeAmount ?? swap.tradable_input;

  if (venueUnitOf(swap.pool_nft) !== venueUnitOf(cfg.pool_nft)) {
    throw new Error(
      `This order names pool NFT ${venueUnitOf(swap.pool_nft)} and this pool carries ` +
        `${venueUnitOf(cfg.pool_nft)}. An order can only ever be filled against the pool it named.`,
    );
  }
  if (traded <= 0n || traded > swap.tradable_input) {
    throw new Error(
      `This fill trades ${traded} of an order offering ${swap.tradable_input}. A fill trades some of the ` +
        'order and never more than all of it.',
    );
  }

  const inputIsX = venueUnitOf(swap.input) === venueUnitOf(cfg.pool_x);
  const outputUnit = venueUnitOf(swap.output);
  const expectedOutputUnit = inputIsX ? venueUnitOf(cfg.pool_y) : venueUnitOf(cfg.pool_x);
  if (!inputIsX && venueUnitOf(swap.input) !== venueUnitOf(cfg.pool_y)) {
    throw new Error(
      `This order trades ${venueUnitOf(swap.input)} in, which is neither side of this pool ` +
        `(${venueUnitOf(cfg.pool_x)} / ${venueUnitOf(cfg.pool_y)}).`,
    );
  }
  if (outputUnit !== expectedOutputUnit) {
    throw new Error(
      `This order asks for ${outputUnit} out of a pool whose other side is ${expectedOutputUnit}. ` +
        'A swap moves between the two sides the pool names and nowhere else.',
    );
  }

  const state = readVenuePoolState(cfg, pool.assets);
  const quote = venueSwapQuote({
    reserveIn: inputIsX ? state.reservesX : state.reservesY,
    reserveOut: inputIsX ? state.reservesY : state.reservesX,
    tradedIn: traded,
    feeNum: cfg.fee_num,
    treasuryFee: cfg.treasury_fee,
    royaltyFee: cfg.royalty_fee,
  });
  const poolGave = quote.output;

  // The placer's floor, as the order states it: output per input traded.
  if (poolGave * swap.base_price.denom < traded * swap.base_price.num) {
    throw new Error(
      `This pool pays ${poolGave} for ${traded}, under the ${swap.base_price.num}/${swap.base_price.denom} ` +
        'floor the order set. Leave it unfilled — filling it below the floor builds a transaction the ' +
        'order refuses.',
    );
  }

  const terminated = traded === swap.tradable_input;
  // Pro rata is a CEILING on the executor's fee, and the largest permitted
  // value is the floor of the quotient. A full fill may take the whole fee.
  const permittedFee = terminated ? swap.ex_fee : (traded * swap.ex_fee) / swap.tradable_input;
  const exFeeTaken = args.executorFee ?? permittedFee;
  if (exFeeTaken < 0n || exFeeTaken > permittedFee) {
    throw new Error(
      `This fill takes ${exFeeTaken} lovelace of execution fee where the order permits at most ` +
        `${permittedFee}. The order refuses a fee above what it authorised, and a negative one is the ` +
        'executor paying the placer.',
    );
  }

  if (args.fillCostLovelace !== undefined && permittedFee < args.fillCostLovelace) {
    const smallest = venueMinFundableTrade({
      tradableInput: swap.tradable_input,
      exFee: swap.ex_fee,
      fillCostLovelace: args.fillCostLovelace,
    });
    const enough = smallest < swap.tradable_input || swap.ex_fee >= args.fillCostLovelace;
    throw new Error(
      `Filling ${traded} of this order draws ${permittedFee} lovelace of execution fee and a fill costs ` +
        `${args.fillCostLovelace}. The order's fee is shared out in proportion to what is filled, so a ` +
        `smaller fill funds less of it while still paying for a whole transaction. ${
          enough
            ? `The least of this order anyone can fill is ${smallest}.`
            : `Its whole fee of ${swap.ex_fee} is below what one fill costs, so no part of it can be filled ` +
              'at all — it can only be cancelled.'
        }`,
    );
  }

  if (!terminated && poolGave < swap.min_marginal_output) {
    throw new Error(
      `A partial fill of ${traded} pays ${poolGave}, under the ${swap.min_marginal_output} the order set as ` +
        'the least it will accept in one go. Fill more of it, or leave it.',
    );
  }

  const inputUnit = venueUnitOf(swap.input);

  // The pool's balance moves by the gross amounts; the counters take their
  // slices out of what it now holds, which is what lowers the reserve the next
  // swap prices against.
  const poolAssets = { ...pool.assets };
  poolAssets[inputUnit] = (poolAssets[inputUnit] ?? 0n) + traded;
  poolAssets[outputUnit] = (poolAssets[outputUnit] ?? 0n) - poolGave;

  const poolDatum: VenuePoolConfigData = inputIsX
    ? {
        ...cfg,
        treasury_x: cfg.treasury_x + quote.treasurySlice,
        royalty_x: cfg.royalty_x + quote.royaltySlice,
      }
    : {
        ...cfg,
        treasury_y: cfg.treasury_y + quote.treasurySlice,
        royalty_y: cfg.royalty_y + quote.royaltySlice,
      };

  // The order's side. The executor's fee always leaves in lovelace, so when
  // the placer is being paid IN lovelace the two net against each other in one
  // balance — which is exactly what `lovelace_fee_adjust` exists to undo on
  // the validator's side.
  const successorAssets = { ...order.assets };
  successorAssets[inputUnit] = (successorAssets[inputUnit] ?? 0n) - traded;
  successorAssets[outputUnit] = (successorAssets[outputUnit] ?? 0n) + poolGave;
  successorAssets.lovelace = (successorAssets.lovelace ?? 0n) - exFeeTaken;

  const successorLovelace = successorAssets.lovelace ?? 0n;
  if (successorLovelace < minOutputLovelace) {
    throw new Error(
      `Filling this order leaves ${successorLovelace} lovelace on its ${terminated ? 'reward' : 'continuing'} ` +
        `output, under the ${minOutputLovelace} minimum. The order was placed without enough ADA to carry ` +
        'both its own execution fee and an output that can exist; it can only be cancelled.',
    );
  }

  const successor = terminated
    ? { address: venueRewardAddress(swap, network), assets: pruneZero(successorAssets) }
    : {
        address: order.address,
        assets: pruneZero(successorAssets),
        datum: {
          ...swap,
          tradable_input: swap.tradable_input - traded,
          ex_fee: swap.ex_fee - exFeeTaken,
        },
      };

  return {
    traded,
    exFeeTaken,
    permittedFee,
    poolGave,
    poolDatum,
    poolAssets: pruneZero(poolAssets),
    successor,
    terminated,
  };
}
