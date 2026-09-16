// venue-swap.test.ts
//
// The batcher proposes numbers two validators then re-derive. Nothing here is
// trusted on chain, but everything here has to AGREE to the unit or the fill
// is simply rejected — so these tests are not about whether the arithmetic is
// reasonable, they are about whether it is the SAME arithmetic.
//
// Three kinds of check, and the second is the one that carries the weight:
//
//   - Against the validator's own worked figures. `swap_order.ak`'s tests are
//     written around a pool of 100M/100M at 99,700/100/1,000 where a 1,000,000
//     lovelace buy is worth 976,372 tokens. That number is derived from the
//     code this module mirrors, so reproducing it is evidence; a round number
//     invented here would not be.
//
//   - Against the validator's rule, restated literally, at the boundary. The
//     quote solves `swap_ok` for the output instead of testing a candidate
//     against it. Those are only the same thing if the quote is the LARGEST
//     value that satisfies the original inequality — so the original is
//     written out here in full, and the quote is checked to pass while the
//     quote plus one fails.
//
//   - Against the shape of a refusal. Every planner rejection is built from a
//     passing fill by a single change, so a fixture that fails for two reasons
//     cannot pass for one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VENUE_FEE_DEN, type VenuePoolConfigData } from '../venue-pool.js';
import {
  planVenueSwapFill,
  readVenuePoolState,
  VENUE_FILL_FLOOR_LOVELACE,
  VENUE_ORDER_EXECUTION_FEE_LOVELACE,
  VENUE_POOL_ACTION,
  type VenueSwapConfigData,
  type VenueSwapOrderUtxo,
  venueFeeSlice,
  venueFillableAmount,
  venueFillSequence,
  venueMinFundableTrade,
  venueRewardAddress,
  venueSwapQuote,
  venueUnitOf,
} from '../venue-swap.js';

const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN_NAME = '746f6b656e';
const TOKEN = `${TOKEN_POLICY}${TOKEN_NAME}`;
const LQ_POLICY = 'cc'.repeat(28);
const LQ = `${LQ_POLICY}6c71`;
const NFT_POLICY = 'aa'.repeat(28);
const NFT = `${NFT_POLICY}6e6674`;
const PLACER = '0d'.repeat(28);
const MAX_LQ = 0x7fffffffffffffffn;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const ORDER_ADDRESS = 'addr_test1wq11111111111111111111111111111111111111111111111111gdvxvz';

/** The schedule `swap_order.ak`'s own tests are written around. */
function poolDatum(over: Partial<VenuePoolConfigData> = {}): VenuePoolConfigData {
  return {
    pool_nft: { policy: NFT_POLICY, name: '6e6674' },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: TOKEN_POLICY, name: TOKEN_NAME },
    pool_lq: { policy: LQ_POLICY, name: '6c71' },
    fee_num: 99_700n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    dao_policy: [],
    treasury_address: 'ee',
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 3n,
    ...over,
  };
}

function poolAssets(lovelace: bigint, tokens: bigint): Record<string, bigint> {
  return { lovelace, [TOKEN]: tokens, [LQ]: MAX_LQ - 1_000_000n, [NFT]: 1n };
}

function pool(over: Partial<VenuePoolConfigData> = {}, lovelace = 100_000_000n, tokens = 100_000_000n) {
  return {
    txHash: '01'.repeat(32),
    outputIndex: 0,
    address: POOL_ADDRESS,
    assets: poolAssets(lovelace, tokens),
    datum: poolDatum(over),
  };
}

/** The buy `swap_order.ak` tests with: 1,000,000 traded, 1,000,000 of fee. */
function buy(over: Partial<VenueSwapConfigData> = {}): VenueSwapConfigData {
  return {
    pool_nft: { policy: NFT_POLICY, name: '6e6674' },
    input: { policy: '', name: '' },
    output: { policy: TOKEN_POLICY, name: TOKEN_NAME },
    tradable_input: 1_000_000n,
    base_price: { num: 9n, denom: 10n },
    min_marginal_output: 100_000n,
    ex_fee: 1_000_000n,
    reward_pkh: PLACER,
    stake_pkh: null,
    permitted_executors: [],
    ...over,
  };
}

function buyOrder(over: Partial<VenueSwapConfigData> = {}, lovelace = 3_000_000n): VenueSwapOrderUtxo {
  return {
    txHash: '02'.repeat(32),
    outputIndex: 0,
    address: ORDER_ADDRESS,
    assets: { lovelace },
    datum: buy(over),
  };
}

function sellOrder(over: Partial<VenueSwapConfigData> = {}): VenueSwapOrderUtxo {
  return {
    txHash: '02'.repeat(32),
    outputIndex: 0,
    address: ORDER_ADDRESS,
    assets: { lovelace: 2_000_000n, [TOKEN]: 1_000_000n },
    datum: buy({ input: { policy: TOKEN_POLICY, name: TOKEN_NAME }, output: { policy: '', name: '' }, ...over }),
  };
}

const MIN_OUTPUT = 1_000_000n;

function fill(args: Parameters<typeof planVenueSwapFill>[0]) {
  return planVenueSwapFill(args);
}

// ---------------------------------------------------------------------------

describe("the pool's own price", () => {
  it("reproduces the figure the validator's tests are written around", () => {
    // 100M/100M at 99,700/100/1,000; a 1,000,000 lovelace buy. This exact
    // number appears in `swap_order.ak` as `full_buy(976_372, …)`.
    const quote = venueSwapQuote({
      reserveIn: 100_000_000n,
      reserveOut: 100_000_000n,
      tradedIn: 1_000_000n,
      feeNum: 99_700n,
      treasuryFee: 100n,
      royaltyFee: 1_000n,
    });
    expect(quote.output).toBe(976_372n);
  });

  it('gives the decided schedule its own figure, which is not the same one', () => {
    // fee_num 99,900 rather than 99,700: the LP's own slice is 0.1%, not 0.3%.
    const quote = venueSwapQuote({
      reserveIn: 100_000_000n,
      reserveOut: 100_000_000n,
      tradedIn: 1_000_000n,
      feeNum: 99_900n,
      treasuryFee: 100n,
      royaltyFee: 1_000n,
    });
    expect(quote.output).toBe(978_334n);
    // A shallower fee leaves more for the placer, which is the whole reason
    // the schedule moved.
    expect(quote.output).toBeGreaterThan(976_372n);
  });

  // `swap_ok`, written out as the validator has it, so the boundary below is
  // a comparison against the rule rather than against this module again.
  function swapOkAsValidator(args: {
    rx0: bigint;
    ry0: bigint;
    dx: bigint;
    dy: bigint;
    feeNum: bigint;
    treasuryFee: bigint;
    royaltyFee: bigint;
  }): boolean {
    const net = args.feeNum - args.treasuryFee - args.royaltyFee;
    if (!(net > 0n && args.rx0 > 0n && args.ry0 > 0n)) return false;
    if (args.dx > 0n) {
      const dxf = args.dx * net;
      return args.dy <= 0n && -args.dy * (args.rx0 * VENUE_FEE_DEN + dxf) <= args.ry0 * dxf;
    }
    if (args.dy > 0n) {
      const dyf = args.dy * net;
      return -args.dx * (args.ry0 * VENUE_FEE_DEN + dyf) <= args.rx0 * dyf;
    }
    return false;
  }

  it.each([
    { rx0: 100_000_000n, ry0: 100_000_000n, dx: 1_000_000n },
    { rx0: 3_000_000n, ry0: 7n, dx: 1n },
    { rx0: 987_654_321n, ry0: 123_456_789n, dx: 4_242_424n },
    { rx0: 1n, ry0: 1n, dx: 1_000_000_000n },
  ])('is the largest output the validator accepts ($rx0 / $ry0, in $dx)', ({ rx0, ry0, dx }) => {
    const schedule = { feeNum: 99_900n, treasuryFee: 100n, royaltyFee: 1_000n };
    const { output } = venueSwapQuote({ reserveIn: rx0, reserveOut: ry0, tradedIn: dx, ...schedule });
    expect(swapOkAsValidator({ rx0, ry0, dx, dy: -output, ...schedule })).toBe(true);
    // One more, and the pool refuses. This is what makes the rearrangement the
    // same rule rather than a formula that merely agrees on easy cases.
    expect(swapOkAsValidator({ rx0, ry0, dx, dy: -(output + 1n), ...schedule })).toBe(false);
  });

  it('refuses to price a pool whose schedule leaves nothing', () => {
    expect(() =>
      venueSwapQuote({
        reserveIn: 1_000n,
        reserveOut: 1_000n,
        tradedIn: 1n,
        feeNum: 1_100n,
        treasuryFee: 100n,
        royaltyFee: 1_000n,
      }),
    ).toThrow(/leaves nothing after its slices/);
  });

  it('refuses to price a side with no reserve', () => {
    expect(() =>
      venueSwapQuote({
        reserveIn: 1_000n,
        reserveOut: 0n,
        tradedIn: 1n,
        feeNum: 99_900n,
        treasuryFee: 100n,
        royaltyFee: 1_000n,
      }),
    ).toThrow(/has no price/);
  });
});

describe('the fee slices', () => {
  // `slice_ok(delta, input, fee)` is `fee_den * delta <= input*fee < fee_den * (delta+1)`,
  // which is exactly "delta is the floor". Checked as the inequality, not as
  // the division, so the two definitions are compared rather than restated.
  it.each([1n, 7n, 999n, 1_000_000n, 33_333_333n])('credits exactly the floor for %s in', (input) => {
    for (const fee of [100n, 1_000n]) {
      const delta = venueFeeSlice(input, fee);
      const owed = input * fee;
      expect(VENUE_FEE_DEN * delta <= owed).toBe(true);
      expect(owed < VENUE_FEE_DEN * (delta + 1n)).toBe(true);
    }
  });
});

describe("reading a pool's state", () => {
  it('nets the accrued counters out of the reserves', () => {
    const state = readVenuePoolState(
      poolDatum({ treasury_x: 1_000n, royalty_x: 10_000n, royalty_y: 5n }),
      poolAssets(100_000_000n, 100_000_000n),
    );
    expect(state.reservesX).toBe(100_000_000n - 11_000n);
    expect(state.reservesY).toBe(100_000_000n - 5n);
    expect(state.liquidity).toBe(1_000_000n);
  });

  it('will not sell what the counters have already earned', () => {
    // The same pool and the same buy, with 11,000 tokens accrued to the
    // creator and the platform on the side being bought FROM. Those are not
    // reserves, so the pool has less to sell and pays out less for the same
    // input. Pricing off the raw balance would pay out somebody else's fees.
    const gross = fill({ pool: pool(), order: buyOrder(), network: 'Preprod', minOutputLovelace: MIN_OUTPUT });
    const withAccrued = fill({
      pool: pool({ treasury_y: 1_000n, royalty_y: 10_000n }),
      order: buyOrder(),
      network: 'Preprod',
      minOutputLovelace: MIN_OUTPUT,
    });
    expect(withAccrued.poolGave).toBeLessThan(gross.poolGave);
    // And the gap is real rather than rounding: pricing off the raw balance
    // gives back exactly the figure that ignores them.
    expect(
      venueSwapQuote({
        reserveIn: 100_000_000n,
        reserveOut: 100_000_000n,
        tradedIn: 1_000_000n,
        feeNum: 99_700n,
        treasuryFee: 100n,
        royaltyFee: 1_000n,
      }).output,
    ).toBe(gross.poolGave);
  });
});

describe('a fill that finishes the order', () => {
  it("pays the placer the pool's whole output and the lovelace they kept back", () => {
    const plan = fill({ pool: pool(), order: buyOrder(), network: 'Preprod', minOutputLovelace: MIN_OUTPUT });
    expect(plan.terminated).toBe(true);
    expect(plan.traded).toBe(1_000_000n);
    expect(plan.poolGave).toBe(976_372n);
    // 3,000,000 held, less 1,000,000 traded and 1,000,000 of executor fee.
    expect(plan.successor.assets).toEqual({ lovelace: 1_000_000n, [TOKEN]: 976_372n });
    expect(plan.successor.datum).toBeUndefined();
    expect(plan.successor.address).toBe(venueRewardAddress(buy(), 'Preprod'));
  });

  it('moves the pool by the gross amounts and credits both counters', () => {
    const plan = fill({ pool: pool(), order: buyOrder(), network: 'Preprod', minOutputLovelace: MIN_OUTPUT });
    expect(plan.poolAssets.lovelace).toBe(101_000_000n);
    expect(plan.poolAssets[TOKEN]).toBe(100_000_000n - 976_372n);
    expect(plan.poolAssets[LQ]).toBe(MAX_LQ - 1_000_000n);
    expect(plan.poolAssets[NFT]).toBe(1n);
    // 0.1% and 1.0% of the 1,000,000 traded, on the INPUT side only.
    expect(plan.poolDatum.treasury_x).toBe(1_000n);
    expect(plan.poolDatum.royalty_x).toBe(10_000n);
    expect(plan.poolDatum.treasury_y).toBe(0n);
    expect(plan.poolDatum.royalty_y).toBe(0n);
  });

  it('changes nothing else in the pool datum', () => {
    const plan = fill({ pool: pool(), order: buyOrder(), network: 'Preprod', minOutputLovelace: MIN_OUTPUT });
    const { treasury_x, royalty_x, ...rest } = plan.poolDatum;
    const { treasury_x: _tx, royalty_x: _rx, ...before } = poolDatum();
    expect(rest).toEqual(before);
    expect(treasury_x + royalty_x).toBe(11_000n);
  });

  it("nets the executor's fee against a payout in lovelace on a sell", () => {
    const plan = fill({ pool: pool(), order: sellOrder(), network: 'Preprod', minOutputLovelace: MIN_OUTPUT });
    // 2,000,000 held + 976,372 from the pool - 1,000,000 of fee, and the
    // tokens all gone. `swap_order.ak` tests exactly this figure.
    expect(plan.successor.assets).toEqual({ lovelace: 1_976_372n });
    expect(plan.poolDatum.treasury_y).toBe(1_000n);
    expect(plan.poolDatum.royalty_y).toBe(10_000n);
    expect(plan.poolDatum.treasury_x).toBe(0n);
  });

  it('gives the placer a base address when their order named a stake key', () => {
    const staked = buy({ stake_pkh: '0e'.repeat(28) });
    const plan = fill({
      pool: pool(),
      order: buyOrder({ stake_pkh: '0e'.repeat(28) }),
      network: 'Preprod',
      minOutputLovelace: MIN_OUTPUT,
    });
    expect(plan.successor.address).toBe(venueRewardAddress(staked, 'Preprod'));
    expect(plan.successor.address).not.toBe(venueRewardAddress(buy(), 'Preprod'));
  });
});

describe('a fill that leaves the order running', () => {
  it("continues at the order's own address with the rest to trade", () => {
    const plan = fill({
      pool: pool(),
      order: buyOrder(),
      tradeAmount: 400_000n,
      network: 'Preprod',
      minOutputLovelace: MIN_OUTPUT,
    });
    expect(plan.terminated).toBe(false);
    expect(plan.successor.address).toBe(ORDER_ADDRESS);
    expect(plan.successor.datum?.tradable_input).toBe(600_000n);
    expect(plan.successor.datum?.ex_fee).toBe(600_000n);
    // 3,000,000 less 400,000 traded and 400,000 of fee.
    expect(plan.successor.assets.lovelace).toBe(2_200_000n);
  });

  it('leaves every other field of the order alone', () => {
    const plan = fill({
      pool: pool(),
      order: buyOrder(),
      tradeAmount: 400_000n,
      network: 'Preprod',
      minOutputLovelace: MIN_OUTPUT,
    });
    expect(plan.successor.datum).toEqual({ ...buy(), tradable_input: 600_000n, ex_fee: 600_000n });
  });

  it('takes the floor of the pro-rata fee, never a lovelace more', () => {
    // 333,333 of 1,000,000 at a 1,000,000 fee is 333,333.0 — but 7 of 999 at a
    // fee of 100 is 0.7007…, and the order permits only the floor:
    // `fee_removed * tradable_input <= traded * ex_fee`.
    const plan = fill({
      pool: pool(),
      order: buyOrder(
        { tradable_input: 999n, ex_fee: 100n, min_marginal_output: 0n, base_price: { num: 0n, denom: 1n } },
        3_000_000n,
      ),
      tradeAmount: 7n,
      network: 'Preprod',
      minOutputLovelace: MIN_OUTPUT,
    });
    expect(plan.exFeeTaken).toBe(0n);
    expect(plan.exFeeTaken * 999n).toBeLessThanOrEqual(7n * 100n);
    expect((plan.exFeeTaken + 1n) * 999n).toBeGreaterThan(7n * 100n);
  });

  it('refuses a partial that pays less than the order accepts in one go', () => {
    // The same fill that passes above, with the floor raised past what it pays.
    expect(() =>
      fill({
        pool: pool(),
        order: buyOrder({ min_marginal_output: 394_001n }),
        tradeAmount: 400_000n,
        network: 'Preprod',
        minOutputLovelace: MIN_OUTPUT,
      }),
    ).toThrow(/the least it will accept in one go/);
  });
});

describe('what the planner will not build', () => {
  const base = { network: 'Preprod' as const, minOutputLovelace: MIN_OUTPUT };

  it('refuses an order naming another pool', () => {
    expect(() =>
      fill({ ...base, pool: pool(), order: buyOrder({ pool_nft: { policy: NFT_POLICY, name: '6f74686572' } }) }),
    ).toThrow(/can only ever be filled against the pool it named/);
  });

  it('refuses an order asking for an asset the pool does not hold', () => {
    expect(() =>
      fill({ ...base, pool: pool(), order: buyOrder({ output: { policy: 'bd'.repeat(28), name: '6f74686572' } }) }),
    ).toThrow(/whose other side is/);
  });

  it('refuses an order offering an asset that is neither side', () => {
    expect(() =>
      fill({ ...base, pool: pool(), order: buyOrder({ input: { policy: 'bd'.repeat(28), name: '6f74686572' } }) }),
    ).toThrow(/neither side of this pool/);
  });

  it("refuses a fill under the placer's price floor", () => {
    // The pool pays 976,372 for 1,000,000, which is 0.976. A floor of 0.98
    // is above it and nothing else about the fill changes.
    expect(() => fill({ ...base, pool: pool(), order: buyOrder({ base_price: { num: 98n, denom: 100n } }) })).toThrow(
      /under the 98\/100 floor/,
    );
  });

  it('accepts the same fill at a floor the pool exactly meets', () => {
    const plan = fill({ ...base, pool: pool(), order: buyOrder({ base_price: { num: 976_372n, denom: 1_000_000n } }) });
    expect(plan.poolGave).toBe(976_372n);
  });

  it('refuses to trade more than the order offers', () => {
    expect(() => fill({ ...base, pool: pool(), order: buyOrder(), tradeAmount: 1_000_001n })).toThrow(
      /never more than all of it/,
    );
  });

  it('refuses to trade nothing', () => {
    expect(() => fill({ ...base, pool: pool(), order: buyOrder(), tradeAmount: 0n })).toThrow(
      /never more than all of it/,
    );
  });

  it('refuses an order that cannot leave a payable output behind', () => {
    // 2,000,001 lovelace against 1,000,000 traded and 1,000,000 of fee leaves
    // 1 lovelace for the reward output. Every other figure is the passing case.
    expect(() => fill({ ...base, pool: pool(), order: buyOrder({}, 2_000_001n) })).toThrow(/under the 1000000 minimum/);
  });

  it('builds the same order when it carries enough for the output', () => {
    const plan = fill({ ...base, pool: pool(), order: buyOrder({}, 3_000_000n) });
    expect(plan.successor.assets.lovelace).toBe(1_000_000n);
  });
});

describe('the order fills follow', () => {
  function placed(id: string, blockHeight: number, txIndexInBlock: number, outputIndex = 0): VenueSwapOrderUtxo {
    return { ...buyOrder(), txHash: id.repeat(32), outputIndex, placedAt: { blockHeight, txIndexInBlock } };
  }

  it('is the order the chain accepted them, not the order they were handed over', () => {
    const later = placed('aa', 100, 5);
    const earlier = placed('bb', 100, 2);
    const earliest = placed('cc', 99, 40);
    expect(venueFillSequence([later, earlier, earliest]).map((o) => o.txHash)).toEqual([
      earliest.txHash,
      earlier.txHash,
      later.txHash,
    ]);
  });

  it('separates two orders placed in the same transaction by their output index', () => {
    const second = placed('aa', 100, 5, 3);
    const first = placed('aa', 100, 5, 1);
    expect(venueFillSequence([second, first]).map((o) => o.outputIndex)).toEqual([1, 3]);
  });

  it('puts an order whose position nobody looked up last, not first', () => {
    const unplaced = { ...buyOrder(), txHash: 'dd'.repeat(32) };
    const known = placed('aa', 1_000_000, 0);
    expect(venueFillSequence([unplaced, known]).map((o) => o.txHash)).toEqual([known.txHash, unplaced.txHash]);
  });

  it('leaves orders it cannot separate in the order it was given them', () => {
    const a = { ...buyOrder(), txHash: 'a1'.repeat(32) };
    const b = { ...buyOrder(), txHash: 'b1'.repeat(32) };
    expect(venueFillSequence([b, a]).map((o) => o.txHash)).toEqual([b.txHash, a.txHash]);
  });
});

describe("the pool's action numbers", () => {
  // These are INTEGER FIELDS of a one-constructor redeemer, so no blueprint
  // records them and the redeemer-index sweep cannot reach them. Read out of
  // the validator's own constants instead, which is the only other place they
  // are written down.
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', 'validators', 'royalty_pool', 'pool.ak'),
    'utf8',
  );
  const declared = Object.fromEntries(
    [...source.matchAll(/pub const action_(\w+): Int = (\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );

  it('reads the validator, so a source with no constants fails rather than passes', () => {
    expect(Object.keys(declared).length).toBe(6);
  });

  it.each([
    ['deposit', VENUE_POOL_ACTION.Deposit],
    ['redeem', VENUE_POOL_ACTION.Redeem],
    ['swap', VENUE_POOL_ACTION.Swap],
    ['dao', VENUE_POOL_ACTION.DAOAction],
    ['withdraw_royalty', VENUE_POOL_ACTION.WithdrawRoyalty],
    ['redirect_royalty', VENUE_POOL_ACTION.RedirectRoyalty],
  ])('gives action_%s the number the validator compiled', (name, recorded) => {
    expect(declared[name]).toBe(recorded);
  });
});

describe('naming an asset the way a value keys it', () => {
  it('spells ADA as lovelace and a token as policy then name', () => {
    expect(venueUnitOf({ policy: '', name: '' })).toBe('lovelace');
    expect(venueUnitOf({ policy: TOKEN_POLICY, name: TOKEN_NAME })).toBe(TOKEN);
  });
});

describe('what one fill costs, and what that leaves fillable', () => {
  // 1.5 ADA is what an order sets aside. It clears the dearest fill measured
  // against the real builder — a token-to-token pool, a gated executor and a
  // placer with a stake key, all at once — by about 6%.
  it('leaves headroom over the dearest fill measured', () => {
    expect(VENUE_ORDER_EXECUTION_FEE_LOVELACE).toBeGreaterThan(VENUE_FILL_FLOOR_LOVELACE);
    expect(VENUE_ORDER_EXECUTION_FEE_LOVELACE - VENUE_FILL_FLOOR_LOVELACE).toBe(90_000n);
    expect(VENUE_FILL_FLOOR_LOVELACE).toBeGreaterThanOrEqual(1_409_932n);
  });

  it('funds one whole fill and about 94% of an order, not less', () => {
    const smallest = venueMinFundableTrade({
      tradableInput: 100_000_000n,
      exFee: VENUE_ORDER_EXECUTION_FEE_LOVELACE,
    });
    expect(smallest).toBe(94_000_000n);
    // And that really is the boundary the order enforces: at `smallest` the
    // pro-rata share covers a fill, one unit under it does not.
    const share = (n: bigint) => (n * VENUE_ORDER_EXECUTION_FEE_LOVELACE) / 100_000_000n;
    expect(share(smallest)).toBeGreaterThanOrEqual(VENUE_FILL_FLOOR_LOVELACE);
    expect(share(smallest - 1n)).toBeLessThan(VENUE_FILL_FLOOR_LOVELACE);
  });

  it('says the whole order when its fee cannot fund even one fill', () => {
    expect(venueMinFundableTrade({ tradableInput: 100n, exFee: 500_000n })).toBe(100n);
    expect(venueMinFundableTrade({ tradableInput: 100n, exFee: 0n })).toBe(100n);
  });

  it('refuses a fill the fee cannot pay for, and names what would work', () => {
    expect(() =>
      fill({
        pool: pool(),
        order: buyOrder(
          { ex_fee: VENUE_ORDER_EXECUTION_FEE_LOVELACE, base_price: { num: 0n, denom: 1n } },
          110_000_000n,
        ),
        tradeAmount: 400_000n,
        network: 'Preprod',
        minOutputLovelace: MIN_OUTPUT,
        fillCostLovelace: VENUE_FILL_FLOOR_LOVELACE,
      }),
    ).toThrow(/The least of this order anyone can fill is 940000/);
  });

  it('refuses outright when no part of the order can be filled', () => {
    expect(() =>
      fill({
        pool: pool(),
        order: buyOrder({ ex_fee: 500_000n, base_price: { num: 0n, denom: 1n } }, 110_000_000n),
        network: 'Preprod',
        minOutputLovelace: MIN_OUTPUT,
        fillCostLovelace: VENUE_FILL_FLOOR_LOVELACE,
      }),
    ).toThrow(/no part of it can be filled at all/);
  });

  it('builds the same fill once it is funded', () => {
    const plan = fill({
      pool: pool(),
      order: buyOrder({ ex_fee: VENUE_ORDER_EXECUTION_FEE_LOVELACE, base_price: { num: 0n, denom: 1n } }, 110_000_000n),
      network: 'Preprod',
      minOutputLovelace: MIN_OUTPUT,
      fillCostLovelace: VENUE_FILL_FLOOR_LOVELACE,
    });
    expect(plan.terminated).toBe(true);
    expect(plan.permittedFee).toBe(VENUE_ORDER_EXECUTION_FEE_LOVELACE);
  });
});

describe('whether an order can be filled at all', () => {
  // The pool the fixtures use is 100 ADA / 100M tokens, so an order of
  // 1,000,000 lovelace is 1% of it and moves the price about 1% against
  // itself. That ratio is what every case below turns on.
  const cost = VENUE_FILL_FLOOR_LOVELACE;

  it('serves the whole order when its floor leaves room for its own impact', () => {
    const answer = venueFillableAmount({
      pool: pool(),
      order: buyOrder({ ex_fee: VENUE_ORDER_EXECUTION_FEE_LOVELACE, base_price: { num: 97n, denom: 100n } }),
      fillCostLovelace: cost,
    });
    expect(answer.largest).toBe(1_000_000n);
    expect(answer.fillable).toBe(true);
  });

  it('serves only part of it when the floor is tighter than its own impact', () => {
    // 0.9885 of spot. The order's own 1% of the pool cannot clear that, so the
    // pool can serve some of it and not all.
    const answer = venueFillableAmount({
      pool: pool(),
      order: buyOrder({ ex_fee: VENUE_ORDER_EXECUTION_FEE_LOVELACE, base_price: { num: 9_845n, denom: 10_000n } }),
      fillCostLovelace: cost,
    });
    expect(answer.largest).toBeGreaterThan(0n);
    expect(answer.largest).toBeLessThan(1_000_000n);
    // …and at one fill's worth of fee, that part is too small to pay for.
    expect(answer.largest).toBeLessThan(answer.smallestFundable);
    expect(answer.fillable).toBe(false);
  });

  it('is fillable again once the order funds the part that would fill', () => {
    // The same order with a fee sized for the fraction it can actually serve.
    // That pool can only take about 15% of this order at this floor, so the
    // fee has to be about seven fills' worth — which is what makes a partial
    // expensive, and why the front end should size the FLOOR instead.
    const order = buyOrder({ ex_fee: 10_000_000n, base_price: { num: 9_845n, denom: 10_000n } });
    const answer = venueFillableAmount({ pool: pool(), order, fillCostLovelace: cost });
    expect(answer.smallestFundable).toBeLessThanOrEqual(answer.largest);
    expect(answer.fillable).toBe(true);
  });

  it('says nothing clears a floor above spot, whatever the fee', () => {
    // 1.02 of spot is above the price before any slippage at all.
    const answer = venueFillableAmount({
      pool: pool(),
      order: buyOrder({ ex_fee: 50_000_000n, base_price: { num: 102n, denom: 100n } }),
      fillCostLovelace: cost,
    });
    expect(answer.largest).toBe(0n);
    expect(answer.fillable).toBe(false);
  });

  it('refuses an order whose fee cannot fund even a whole fill', () => {
    const answer = venueFillableAmount({
      pool: pool(),
      order: buyOrder({ ex_fee: 500_000n, base_price: { num: 0n, denom: 1n } }),
      fillCostLovelace: cost,
    });
    expect(answer.largest).toBe(1_000_000n);
    expect(answer.fillable).toBe(false);
  });

  it('agrees with the planner about the largest fill that works', () => {
    // The strongest form: what this says is fillable, the planner builds; one
    // unit more, and the order's own floor rejects it.
    const order = buyOrder({ ex_fee: 4_000_000n, base_price: { num: 9_845n, denom: 10_000n } });
    const { largest } = venueFillableAmount({ pool: pool(), order, fillCostLovelace: cost });
    expect(() =>
      fill({ pool: pool(), order, tradeAmount: largest, network: 'Preprod', minOutputLovelace: MIN_OUTPUT }),
    ).not.toThrow();
    expect(() =>
      fill({ pool: pool(), order, tradeAmount: largest + 1n, network: 'Preprod', minOutputLovelace: MIN_OUTPUT }),
    ).toThrow(/floor the order set/);
  });
});
