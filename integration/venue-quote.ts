// ============================================================================
// Noctis Zone — NoctisSwap: quoting a swap, and drafting the order for it
// ============================================================================
// **A quote is a bound, not a price.** An order is not filled when it is
// signed; it rests until an executor meets it, and the pool it meets is not
// the pool it was quoted against. So a quote that reads as a promise is
// lying, and the number that is actually a promise is a different one.
//
// The two ways a fill differs from its quote point in OPPOSITE directions,
// which is why one figure cannot carry both:
//
//   - **The pool may move first.** Other fills land between signing and
//     filling, and the placer then gets less than the quote said. What stops
//     it getting arbitrarily worse is the order's own price floor, and that
//     floor is the only number here anybody is bound to: an order either fills
//     at or above it, or does not fill. `guaranteedOut` is that figure.
//     `expectedOut` is an estimate of a moment that has already passed.
//
//   - **The executor may charge less than the fee allows.** `ex_fee` is a
//     ceiling; a settled fill takes what the transaction cost and returns the
//     rest. So the lovelace side of a fill usually comes back slightly better
//     than quoted. Quoting the ceiling as the price understates every fill.
//
// **The floor must come from the QUOTE, never from spot.** This is the mistake
// the whole module exists to prevent, and it is silent: a trade moves the
// price against itself, so an order worth roughly p% of the pool realises
// about p% below spot. A floor set at spot minus a small tolerance is
// therefore unreachable at any size, at any fee, forever — and from outside it
// looks exactly like an order patiently waiting for a better price.
// `venueFillableAmount` refuses to hand back a draft with that defect.
//
// **Price impact is measured against the fee-INCLUSIVE spot.** The pool's fee
// is reported on its own, so measuring impact from the fee-free mid price
// would count the fee twice — every quote would look worse than it is by
// exactly the fee, and a comparison against another venue's impact figure
// would be meaningless. Impact here is the effect of the trade's SIZE alone.
//
// Everything is exact integer arithmetic. Rates are rationals, in the shape
// the order datum itself uses, because a rate that has been through a float
// is a rate that no longer agrees with the validator.
// ============================================================================

import { VENUE_FEE_DEN, type VenuePoolConfigData } from './venue-pool.js';
import {
  readVenuePoolState,
  VENUE_ORDER_EXECUTION_FEE_LOVELACE,
  type VenuePoolUtxo,
  type VenueSwapConfigData,
  venueFillableAmount,
  venueMinFundableTrade,
  venueSwapQuote,
  venueUnitOf,
} from './venue-swap.js';

/** Basis points. Every proportion a placer is shown is in these. */
export const VENUE_BPS = 10_000n;

/** A rate, exactly. The same shape the order datum states its floor in. */
export interface VenueRate {
  num: bigint;
  denom: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** In lowest terms, so a datum carries the fewest bytes it can. */
function reduce(rate: VenueRate): VenueRate {
  const divisor = gcd(rate.num, rate.denom);
  if (divisor <= 1n) return rate;
  return { num: rate.num / divisor, denom: rate.denom / divisor };
}

/**
 * A rate as a decimal string, rounded down, for display only.
 *
 * Done in integers on purpose. Every rate here ends up compared against an
 * integer by a validator, so nothing in this module may pass through a float —
 * and a UI that formats one itself is the obvious place for that to happen.
 */
export function venueRateToDecimal(rate: VenueRate, places = 6): string {
  if (rate.denom === 0n) throw new Error('A rate with a zero denominator is not a rate.');
  const scale = 10n ** BigInt(places);
  const scaled = (rate.num * scale) / rate.denom;
  const whole = scaled / scale;
  const fraction = scaled % scale;
  if (places === 0) return whole.toString();
  return `${whole}.${fraction.toString().padStart(places, '0')}`;
}

/** What the creator and the platform have accrued and not yet withdrawn. */
export interface VenueAccrued {
  treasuryX: bigint;
  treasuryY: bigint;
  royaltyX: bigint;
  royaltyY: bigint;
}

/** A pool's public state: what a price feed and a pool page both want. */
export interface VenueMarket {
  unitX: string;
  unitY: string;
  /** Netted the way the validator nets them — accrued fees are not tradable. */
  reservesX: bigint;
  reservesY: bigint;
  /** The pool's mid price, fee-free: what the reserves alone say. */
  midYPerX: VenueRate;
  midXPerY: VenueRate;
  /** What an infinitesimal trade would actually realise, fee included. */
  spotYPerX: VenueRate;
  spotXPerY: VenueRate;
  /** The pool's whole fee, in basis points. */
  feeBps: bigint;
  accrued: VenueAccrued;
  /** LP in issue. */
  liquidity: bigint;
  /**
   * Both sides valued in lovelace, when one side is ada.
   *
   * Exactly twice the ada reserve, and not by convention: the token side
   * valued at the pool's own mid price is `tokenReserve × adaReserve /
   * tokenReserve`, which is the ada reserve again. `null` for a pool with no
   * ada side, where a value needs a price this module does not have.
   */
  tvlLovelace: bigint | null;
}

function feeBpsOf(cfg: VenuePoolConfigData): bigint {
  // `fee_num` is what the pool keeps of `fee_den`; the rest is the fee, and
  // the two counters are carved out of the kept part.
  const taken = VENUE_FEE_DEN - cfg.fee_num + cfg.treasury_fee + cfg.royalty_fee;
  return (taken * VENUE_BPS) / VENUE_FEE_DEN;
}

/** The pool as a price feed sees it. Pure — no chain access, no oracle. */
export function venuePoolMarket(pool: VenuePoolUtxo): VenueMarket {
  const cfg = pool.datum;
  const state = readVenuePoolState(cfg, pool.assets);
  const unitX = venueUnitOf(cfg.pool_x);
  const unitY = venueUnitOf(cfg.pool_y);
  const net = cfg.fee_num - cfg.treasury_fee - cfg.royalty_fee;

  const adaSide = unitX === 'lovelace' ? state.reservesX : unitY === 'lovelace' ? state.reservesY : null;

  return {
    unitX,
    unitY,
    reservesX: state.reservesX,
    reservesY: state.reservesY,
    midYPerX: reduce({ num: state.reservesY, denom: state.reservesX }),
    midXPerY: reduce({ num: state.reservesX, denom: state.reservesY }),
    spotYPerX: reduce({ num: state.reservesY * net, denom: state.reservesX * VENUE_FEE_DEN }),
    spotXPerY: reduce({ num: state.reservesX * net, denom: state.reservesY * VENUE_FEE_DEN }),
    feeBps: feeBpsOf(cfg),
    accrued: {
      treasuryX: cfg.treasury_x,
      treasuryY: cfg.treasury_y,
      royaltyX: cfg.royalty_x,
      royaltyY: cfg.royalty_y,
    },
    liquidity: state.liquidity,
    tvlLovelace: adaSide === null ? null : adaSide * 2n,
  };
}

/** What the pool's fee takes from one trade, on the input side. */
export interface VenueQuoteFee {
  treasury: bigint;
  royalty: bigint;
  /** Both slices. The pool keeps the rest of the fee as depth for holders. */
  total: bigint;
}

export interface VenueQuote {
  inputUnit: string;
  outputUnit: string;
  tradedIn: bigint;
  /**
   * What the pool pays at the state quoted.
   *
   * An ESTIMATE. The pool moves between signing and filling; `guaranteedOut`
   * on the draft is the figure anybody is bound to.
   */
  expectedOut: bigint;
  /** `expectedOut / tradedIn`, exactly. */
  expectedRate: VenueRate;
  /** What an infinitesimal trade would have realised, fee included. */
  spotRate: VenueRate;
  /** How far the trade moves the price against itself. Size only, not fee. */
  priceImpactBps: bigint;
  fee: VenueQuoteFee;
}

/** Prices one trade against one pool. Pure, and exact. */
export function venueQuoteSwap(args: { pool: VenuePoolUtxo; inputUnit: string; tradedIn: bigint }): VenueQuote {
  const cfg = args.pool.datum;
  const unitX = venueUnitOf(cfg.pool_x);
  const unitY = venueUnitOf(cfg.pool_y);
  if (args.inputUnit !== unitX && args.inputUnit !== unitY) {
    throw new Error(
      `This pool trades ${unitX} against ${unitY}, and ${args.inputUnit} is neither of them. A swap moves ` +
        'between the two sides the pool names and nowhere else.',
    );
  }
  if (args.tradedIn <= 0n) {
    throw new Error(`A quote needs something to trade, and this one trades ${args.tradedIn}.`);
  }

  const state = readVenuePoolState(cfg, args.pool.assets);
  const inputIsX = args.inputUnit === unitX;
  const reserveIn = inputIsX ? state.reservesX : state.reservesY;
  const reserveOut = inputIsX ? state.reservesY : state.reservesX;
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new Error(
      `This pool holds ${reserveIn} on the side being sold and ${reserveOut} on the side being bought, net ` +
        'of what the creator and the platform have accrued. It cannot price a trade.',
    );
  }

  const quote = venueSwapQuote({
    reserveIn,
    reserveOut,
    tradedIn: args.tradedIn,
    feeNum: cfg.fee_num,
    treasuryFee: cfg.treasury_fee,
    royaltyFee: cfg.royalty_fee,
  });

  const net = cfg.fee_num - cfg.treasury_fee - cfg.royalty_fee;
  // Impact is 1 - realised/spot, and spot INCLUDES the fee so the fee is not
  // counted here as well as in `fee` below.
  const spotNum = reserveOut * net;
  const spotDenom = reserveIn * VENUE_FEE_DEN;
  const realisedOverSpotBps = (quote.output * spotDenom * VENUE_BPS) / (args.tradedIn * spotNum);
  const impact = VENUE_BPS - realisedOverSpotBps;

  return {
    inputUnit: args.inputUnit,
    outputUnit: inputIsX ? unitY : unitX,
    tradedIn: args.tradedIn,
    expectedOut: quote.output,
    expectedRate: reduce({ num: quote.output, denom: args.tradedIn }),
    spotRate: reduce({ num: spotNum, denom: spotDenom }),
    priceImpactBps: impact < 0n ? 0n : impact,
    fee: {
      treasury: quote.treasurySlice,
      royalty: quote.royaltySlice,
      total: quote.treasurySlice + quote.royaltySlice,
    },
  };
}

export interface VenueOrderDraft {
  /** The order's terms, ready to encode with `VenueSwapConfigSchema`. */
  datum: VenueSwapConfigData;
  /** What the order UTXO must hold for the fill to balance. */
  assets: Record<string, bigint>;
  /** The state it was priced at. Everything in it is an estimate. */
  quote: VenueQuote;
  /**
   * The least the placer receives if this fills at all.
   *
   * The one number here that is a promise rather than an estimate: the order's
   * floor, applied to the whole tradable amount. A fill pays at or above it,
   * or the validator refuses the fill.
   */
  guaranteedOut: bigint;
  /** The most an executor may take. It takes what the fill cost, and returns the rest. */
  maxExecutionFee: bigint;
  /** The least of this order anyone can afford to fill. */
  smallestFundableTrade: bigint;
  /** True when the fee makes the order an all-or-nothing one. */
  fillsWholeOrWaits: boolean;
  /**
   * Ada the order carries so its reward output can exist, over and above the
   * trade and the fee. Not a cost — it comes back in the reward output.
   */
  carriedLovelace: bigint;
}

/**
 * Turns a quote into an order somebody can sign.
 *
 * The floor is set from the QUOTE and widened by the tolerance, never from
 * spot — see the module header for why the other way round produces an order
 * that cannot fill and does not look like it.
 *
 * The draft is checked against the pool before it is returned, so this cannot
 * hand back an order that no executor could fill at the state it was quoted
 * at. What it cannot check is the future: an order is refused a fill once the
 * pool moves past its floor, which is the floor doing its job.
 */
export function draftVenueSwapOrder(args: {
  pool: VenuePoolUtxo;
  inputUnit: string;
  tradedIn: bigint;
  /**
   * How far the price may move against the placer before this stops filling.
   *
   * Zero is exact and almost never fills — the first trade to land ahead of it
   * puts the pool out of reach. It is the placer's whole protection against
   * the pool moving, so it is required rather than defaulted.
   */
  slippageToleranceBps: bigint;
  /** Where the proceeds go. */
  rewardPkh: string;
  stakePkh?: string | null;
  /** Empty, the default, lets anyone fill it. */
  permittedExecutors?: string[];
  /**
   * The protocol minimum for an output holding the asset being bought.
   *
   * Carried by the order and returned in the reward output, so erring high
   * costs the placer nothing.
   */
  minOutputLovelace: bigint;
  /** The execution fee ceiling. `VENUE_ORDER_EXECUTION_FEE_LOVELACE` by default. */
  exFee?: bigint;
  /** What one fill costs; `VENUE_FILL_FLOOR_LOVELACE` unless measured again. */
  fillCostLovelace?: bigint;
}): VenueOrderDraft {
  if (args.slippageToleranceBps < 0n || args.slippageToleranceBps >= VENUE_BPS) {
    throw new Error(
      `A tolerance of ${args.slippageToleranceBps} basis points is not a tolerance. It runs from 0, which ` +
        'accepts only the quoted rate, to just under 10,000, which accepts anything.',
    );
  }

  const cfg = args.pool.datum;
  const quote = venueQuoteSwap({ pool: args.pool, inputUnit: args.inputUnit, tradedIn: args.tradedIn });
  const exFee = args.exFee ?? VENUE_ORDER_EXECUTION_FEE_LOVELACE;

  // The floor: the rate just quoted, less the tolerance. Both sides are
  // multiplied out so nothing rounds before the fraction is reduced.
  const basePrice = reduce({
    num: quote.expectedOut * (VENUE_BPS - args.slippageToleranceBps),
    denom: args.tradedIn * VENUE_BPS,
  });
  const guaranteedOut = (args.tradedIn * basePrice.num) / basePrice.denom;

  const smallestFundableTrade = venueMinFundableTrade({
    tradableInput: args.tradedIn,
    exFee,
    fillCostLovelace: args.fillCostLovelace,
  });
  // What the floor demands of the smallest fill anyone could fund. A partial
  // below this is refused — though at the recommended fee the FEE is what
  // binds, not this, and the order is all-or-nothing either way.
  const minMarginalOutput = (smallestFundableTrade * basePrice.num + basePrice.denom - 1n) / basePrice.denom;

  const inputIsLovelace = args.inputUnit === 'lovelace';
  const assets: Record<string, bigint> = inputIsLovelace
    ? { lovelace: args.tradedIn + exFee + args.minOutputLovelace }
    : { lovelace: exFee + args.minOutputLovelace, [args.inputUnit]: args.tradedIn };

  const inputIsX = args.inputUnit === venueUnitOf(cfg.pool_x);
  const datum: VenueSwapConfigData = {
    pool_nft: cfg.pool_nft,
    input: inputIsX ? cfg.pool_x : cfg.pool_y,
    output: inputIsX ? cfg.pool_y : cfg.pool_x,
    tradable_input: args.tradedIn,
    base_price: basePrice,
    min_marginal_output: minMarginalOutput,
    ex_fee: exFee,
    reward_pkh: args.rewardPkh,
    stake_pkh: args.stakePkh ?? null,
    permitted_executors: args.permittedExecutors ?? [],
  };

  const answer = venueFillableAmount({
    pool: args.pool,
    order: { txHash: '', outputIndex: 0, address: '', assets, datum },
    fillCostLovelace: args.fillCostLovelace,
  });
  if (!answer.fillable) {
    throw new Error(
      'This order could not be filled at the state it was quoted against: the pool can serve ' +
        `${answer.largest} of ${args.tradedIn}, and the ${exFee} lovelace execution fee funds a fill of ` +
        `${answer.smallestFundable} or more. Raising the fee, or trading less, is what closes that gap — ` +
        'placing it as it stands would leave an order nobody can act on.',
    );
  }

  return {
    datum,
    assets,
    quote,
    guaranteedOut,
    maxExecutionFee: exFee,
    smallestFundableTrade,
    fillsWholeOrWaits: smallestFundableTrade === args.tradedIn,
    carriedLovelace: args.minOutputLovelace,
  };
}
