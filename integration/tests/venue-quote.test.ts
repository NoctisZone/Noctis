// venue-quote.test.ts — is the quote a bound, and is the floor reachable?
//
// Two defects are worth more than everything else in this file, because both
// are silent and both produce an order that looks perfectly normal:
//
//   - A FLOOR SET FROM SPOT. A trade moves the price against itself, so an
//     order worth p% of the pool realises about p% below spot. A floor at spot
//     less a small tolerance is unreachable at any size and at any fee, and
//     from outside it looks like an order waiting for a better price. The
//     drafting test does it both ways round on the same numbers.
//
//   - PRICE IMPACT THAT DOUBLE-COUNTS THE FEE. Measured from the fee-free mid
//     price, a 1 ADA trade into a 20,000 ADA pool reports about 121 basis
//     points of "impact" when the honest figure is 2 — the pool's own 120
//     basis point fee, counted once in the fee and again in the impact.
//
// The pool below holds 20,000 ADA against 200,000,000 tokens. Its mid price is
// 1/100 and its spot, fee included, is 247/25,000 = 0.00988. Every figure
// pinned here was computed from the validators' own arithmetic.

import { describe, expect, it } from 'vitest';
import { VENUE_FEE_DEN, type VenuePoolConfigData } from '../venue-pool.js';
import { draftVenueSwapOrder, VENUE_BPS, venuePoolMarket, venueQuoteSwap, venueRateToDecimal } from '../venue-quote.js';
import {
  planVenueSwapFill,
  VENUE_ORDER_EXECUTION_FEE_LOVELACE,
  type VenuePoolUtxo,
  venueFillableAmount,
} from '../venue-swap.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN_NAME = '746f6b656e';
const TOKEN = `${TOKEN_POLICY}${TOKEN_NAME}`;
const USDM_POLICY = 'cc'.repeat(28);
const USDM = `${USDM_POLICY}55534444`;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const ORDER_ADDRESS = 'addr_test1wq11111111111111111111111111111111111111111111111111gdvxvz';
const MAX_LQ = 0x7fffffffffffffffn;
const PLACER = '0d'.repeat(28);

function poolDatum(over: Partial<VenuePoolConfigData> = {}): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: TOKEN_POLICY, name: TOKEN_NAME },
    pool_lq: { policy: FACTORY, name: `11${LAUNCH}` },
    fee_num: 99_900n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(57),
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
    ...over,
  };
}

function pool(over: Partial<VenuePoolUtxo> = {}): VenuePoolUtxo {
  return {
    txHash: '01'.repeat(32),
    outputIndex: 0,
    address: POOL_ADDRESS,
    assets: {
      lovelace: 20_000_000_000n,
      [TOKEN]: 200_000_000n,
      [`${FACTORY}11${LAUNCH}`]: MAX_LQ - 1_000_000_000n,
      [`${FACTORY}10${LAUNCH}`]: 1n,
    },
    datum: poolDatum(),
    ...over,
  };
}

const MIN_OUT = 1_000_000n;

// ---------------------------------------------------------------------------

describe('the pool as a price feed sees it', () => {
  it('prices against the reserves the validator would price against', () => {
    // 11,000,000 lovelace accrued to the creator and the platform sits in the
    // same UTXO and is not tradable. Pricing the gross balance sells it.
    const withAccrued = pool({
      datum: poolDatum({ treasury_x: 1_000_000n, royalty_x: 10_000_000n }),
    });
    expect(venuePoolMarket(withAccrued).reservesX).toBe(19_989_000_000n);
    expect(venuePoolMarket(pool()).reservesX).toBe(20_000_000_000n);
  });

  it('states the fee once, at 120 basis points', () => {
    expect(venuePoolMarket(pool()).feeBps).toBe(120n);
  });

  it('separates the mid price from what a trade would actually get', () => {
    const market = venuePoolMarket(pool());
    expect(market.midYPerX).toEqual({ num: 1n, denom: 100n });
    expect(market.spotYPerX).toEqual({ num: 247n, denom: 25_000n });
    // Spot is the mid less exactly the fee, and nothing else.
    const net = 99_900n - 100n - 1_000n;
    expect(market.spotYPerX.num * market.midYPerX.denom * VENUE_FEE_DEN).toBe(
      market.midYPerX.num * market.spotYPerX.denom * net,
    );
  });

  it('values an ada pool at exactly twice its ada side', () => {
    // Not a convention: the token side at the pool's own mid price is the ada
    // side again.
    expect(venuePoolMarket(pool()).tvlLovelace).toBe(40_000_000_000n);
  });

  it('finds the ada side whichever way round the pool names it', () => {
    // Nothing forces ada to be the first side, so the valuation looks for it
    // rather than assuming where it sits.
    const flipped = pool({
      assets: {
        [TOKEN]: 200_000_000n,
        lovelace: 20_000_000_000n,
        [`${FACTORY}10${LAUNCH}`]: 1n,
      },
      datum: poolDatum({
        pool_x: { policy: TOKEN_POLICY, name: TOKEN_NAME },
        pool_y: { policy: '', name: '' },
      }),
    });
    expect(venuePoolMarket(flipped).tvlLovelace).toBe(40_000_000_000n);
  });

  it('declines to value a pool with no ada side', () => {
    const tokenPair = pool({
      assets: {
        [USDM]: 20_000_000_000n,
        [TOKEN]: 200_000_000n,
        [`${FACTORY}10${LAUNCH}`]: 1n,
      },
      datum: poolDatum({ pool_x: { policy: USDM_POLICY, name: '55534444' } }),
    });
    expect(venuePoolMarket(tokenPair).tvlLovelace).toBeNull();
  });
});

describe('quoting a trade', () => {
  it('pays what the validator would pay, to the unit', () => {
    const quote = venueQuoteSwap({ pool: pool(), inputUnit: 'lovelace', tradedIn: 1_000_000_000n });
    expect(quote.expectedOut).toBe(9_414_903n);
    expect(quote.outputUnit).toBe(TOKEN);
    expect(quote.fee.treasury).toBe(1_000_000n);
    expect(quote.fee.royalty).toBe(10_000_000n);
  });

  it('measures impact as size alone, not size plus the fee', () => {
    // 1 ADA into a 20,000 ADA pool barely moves it. Measured from the fee-free
    // mid price this would read about 121 basis points — the 120 the pool
    // charges, reported a second time as if the trade had caused it.
    const quote = venueQuoteSwap({ pool: pool(), inputUnit: 'lovelace', tradedIn: 1_000_000n });
    expect(quote.priceImpactBps).toBe(2n);
    expect(venuePoolMarket(pool()).feeBps).toBe(120n);
  });

  it('grows the impact with the size of the trade', () => {
    const impact = (traded: bigint) =>
      venueQuoteSwap({ pool: pool(), inputUnit: 'lovelace', tradedIn: traded }).priceImpactBps;
    expect(impact(100_000_000n)).toBe(50n);
    expect(impact(1_000_000_000n)).toBe(471n);
    expect(impact(2_000_000_000n)).toBe(900n);
  });

  it('prices a sell the same way it prices a buy', () => {
    const sell = venueQuoteSwap({ pool: pool(), inputUnit: TOKEN, tradedIn: 1_000_000n });
    expect(sell.expectedOut).toBe(98_314_327n);
    expect(sell.outputUnit).toBe('lovelace');
    // The same fraction of the pool moves it the same distance either way.
    expect(sell.priceImpactBps).toBe(
      venueQuoteSwap({ pool: pool(), inputUnit: 'lovelace', tradedIn: 100_000_000n }).priceImpactBps,
    );
  });

  it('refuses a unit that is not a side of this pool', () => {
    expect(() => venueQuoteSwap({ pool: pool(), inputUnit: USDM, tradedIn: 1n })).toThrow(/neither of them/);
  });

  it('refuses a trade of nothing', () => {
    expect(() => venueQuoteSwap({ pool: pool(), inputUnit: 'lovelace', tradedIn: 0n })).toThrow(
      /needs something to trade/,
    );
  });

  it('refuses a pool with nothing on one side', () => {
    const drained = pool({ assets: { lovelace: 20_000_000_000n, [`${FACTORY}10${LAUNCH}`]: 1n } });
    expect(() => venueQuoteSwap({ pool: drained, inputUnit: 'lovelace', tradedIn: 1_000n })).toThrow(
      /cannot price a trade/,
    );
  });
});

describe('drafting the order', () => {
  const draft = (over: Partial<Parameters<typeof draftVenueSwapOrder>[0]> = {}) =>
    draftVenueSwapOrder({
      pool: pool(),
      inputUnit: 'lovelace',
      tradedIn: 1_000_000_000n,
      slippageToleranceBps: 100n,
      rewardPkh: PLACER,
      minOutputLovelace: MIN_OUT,
      ...over,
    });

  it('sets the floor from the quote, so an order for 5% of the pool can fill', () => {
    const order = draft({ slippageToleranceBps: 0n });
    const answer = venueFillableAmount({
      pool: pool(),
      order: { txHash: '', outputIndex: 0, address: ORDER_ADDRESS, assets: order.assets, datum: order.datum },
    });
    expect(answer.fillable).toBe(true);
    expect(answer.largest).toBe(1_000_000_000n);
  });

  it('is dead on arrival if the floor is set from spot instead', () => {
    // The same order, the same pool, the same generous 1% tolerance — with the
    // floor taken from spot rather than from the rate this trade realises.
    const spot = venuePoolMarket(pool()).spotYPerX;
    const fromSpot = {
      ...draft().datum,
      base_price: { num: spot.num * (VENUE_BPS - 100n), denom: spot.denom * VENUE_BPS },
    };
    const answer = venueFillableAmount({
      pool: pool(),
      order: { txHash: '', outputIndex: 0, address: ORDER_ADDRESS, assets: draft().assets, datum: fromSpot },
    });
    expect(answer.fillable).toBe(false);
    // And the drafted one, on the same numbers, is fine.
    expect(
      venueFillableAmount({
        pool: pool(),
        order: {
          txHash: '',
          outputIndex: 0,
          address: ORDER_ADDRESS,
          assets: draft().assets,
          datum: draft().datum,
        },
      }).fillable,
    ).toBe(true);
  });

  it('promises the floor, not the quote', () => {
    const exact = draft({ slippageToleranceBps: 0n });
    expect(exact.guaranteedOut).toBe(exact.quote.expectedOut);

    const tolerant = draft({ slippageToleranceBps: 100n });
    expect(tolerant.guaranteedOut).toBeLessThan(tolerant.quote.expectedOut);
    // 1% of tolerance gives up 1% of the quote, and no more.
    expect(tolerant.guaranteedOut).toBeGreaterThanOrEqual((exact.guaranteedOut * 99n) / 100n - 1n);
  });

  it('produces an order the fill planner accepts, end to end', () => {
    const order = draft();
    const fill = planVenueSwapFill({
      pool: pool(),
      order: {
        txHash: '02'.repeat(32),
        outputIndex: 0,
        address: ORDER_ADDRESS,
        assets: order.assets,
        datum: order.datum,
      },
      network: 'Preprod',
      minOutputLovelace: MIN_OUT,
      fillCostLovelace: 1_410_000n,
    });
    expect(fill.terminated).toBe(true);
    expect(fill.traded).toBe(1_000_000_000n);
    expect(fill.poolGave).toBe(order.quote.expectedOut);
    expect(fill.poolGave).toBeGreaterThanOrEqual(order.guaranteedOut);
  });

  it('carries the trade, the fee and the ada its reward output needs', () => {
    const buy = draft();
    expect(buy.assets).toEqual({ lovelace: 1_000_000_000n + VENUE_ORDER_EXECUTION_FEE_LOVELACE + MIN_OUT });
    expect(buy.carriedLovelace).toBe(MIN_OUT);

    const sell = draft({ inputUnit: TOKEN, tradedIn: 1_000_000n });
    expect(sell.assets).toEqual({
      lovelace: VENUE_ORDER_EXECUTION_FEE_LOVELACE + MIN_OUT,
      [TOKEN]: 1_000_000n,
    });
  });

  it('names the sides the way the pool names them', () => {
    expect(draft().datum.input).toEqual({ policy: '', name: '' });
    expect(draft().datum.output).toEqual({ policy: TOKEN_POLICY, name: TOKEN_NAME });
    const sell = draft({ inputUnit: TOKEN, tradedIn: 1_000_000n });
    expect(sell.datum.input).toEqual({ policy: TOKEN_POLICY, name: TOKEN_NAME });
    expect(sell.datum.output).toEqual({ policy: '', name: '' });
  });

  it('says plainly that the fee makes the order all-or-nothing', () => {
    const order = draft();
    expect(order.fillsWholeOrWaits).toBe(false);
    expect(order.smallestFundableTrade).toBe(940_000_000n);

    // Doubling the fee is what buys a partial, and it buys about half of one.
    const richer = draft({ exFee: 3_000_000n });
    expect(richer.smallestFundableTrade).toBe(470_000_000n);
  });

  it('refuses to draft an order no executor could fill', () => {
    expect(() => draft({ exFee: 100_000n })).toThrow(/leave an order nobody can act on/);
  });

  it('refuses a tolerance that is not one', () => {
    expect(() => draft({ slippageToleranceBps: -1n })).toThrow(/is not a tolerance/);
    expect(() => draft({ slippageToleranceBps: VENUE_BPS })).toThrow(/is not a tolerance/);
  });

  it('carries the placer through to the reward, stake key and all', () => {
    const staked = draft({ stakePkh: '0e'.repeat(28), permittedExecutors: ['11'.repeat(28)] });
    expect(staked.datum.reward_pkh).toBe(PLACER);
    expect(staked.datum.stake_pkh).toBe('0e'.repeat(28));
    expect(staked.datum.permitted_executors).toEqual(['11'.repeat(28)]);
    expect(draft().datum.stake_pkh).toBeNull();
    expect(draft().datum.permitted_executors).toEqual([]);
  });
});

describe('showing a rate', () => {
  it('rounds down and pads, in integers throughout', () => {
    expect(venueRateToDecimal({ num: 247n, denom: 25_000n })).toBe('0.009880');
    expect(venueRateToDecimal({ num: 1n, denom: 3n }, 4)).toBe('0.3333');
    expect(venueRateToDecimal({ num: 2n, denom: 3n }, 4)).toBe('0.6666');
    expect(venueRateToDecimal({ num: 7n, denom: 2n }, 0)).toBe('3');
  });

  it('refuses a rate with no denominator', () => {
    expect(() => venueRateToDecimal({ num: 1n, denom: 0n })).toThrow(/not a rate/);
  });
});
