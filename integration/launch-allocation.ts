// One launch's supply, divided once.
//
// WHY THIS EXISTS
// A launch's supply is split across separately-deployed contracts — the
// bonding curve, the DarkVeil pool, creator vesting, the staking pool, the
// LP reserve — and each one only ever sees its own number. None can call
// another (Compact has no cross-contract calls, and the Cardano validators
// are separate scripts), so no contract is in a position to notice that the
// parts add up to more than the whole. Four constructor arguments, each
// individually plausible, can describe a launch that promises 140% of its
// own supply, and every contract involved would accept its share.
//
// The answer is not another check. It is to divide the supply in ONE place
// and hand out the pieces: every allocation below is computed from the same
// `totalSupply`, and the curve gets what is left rather than a number of its
// own. Conservation then holds because there is no expression in which it
// could fail — the pieces are a partition, not five independent figures that
// happen to agree.
//
// Percentages come from CLAUDE.md's platform constants. They are enforced
// here rather than assumed: a caller cannot ask for a creator share above
// the documented maximum, or a DarkVeil share outside its band, or a
// DarkVeil phase on a tier that has none.

import { BPS_DENOMINATOR, CREATOR_BPS, grossRangeQuadratic, PLATFORM_BPS } from './curve-pricing.js';

/** CLAUDE.md: TOTAL_SUPPLY. The hard cap a launch may not exceed. */
export const TOTAL_SUPPLY_CAP = 1_000_000_000n;
/**
 * CLAUDE.md: POOL_OPEN_PRICE_PCT. The pool a graduation opens is priced at
 * this percentage of the curve's final price, whatever the allocations.
 *
 * WHY THE LP RESERVE IS SIZED RATHER THAN FIXED
 * The pool opens with the whole net raise against the LP reserve, so its
 * opening price is raise ÷ reserve. The raise scales with the curve — a
 * curve always runs from its base price to its max price, so it raises
 * about the same average price per token however long it is — while a
 * reserve fixed as a share of TOTAL supply does not scale with anything.
 * Every allocation that shortens the curve (a creator share, the staking
 * pool) then lowers the opening price, and a large enough combination
 * takes it below the graduation price, where the last curve buyers hold
 * tokens the pool values under what they paid. Sizing the reserve from
 * the curve's own raise removes that dependence: the opening price is one
 * chosen figure, and the reserve is whatever share of supply produces it.
 */
export const POOL_OPEN_PRICE_PCT = 120n;
/** CLAUDE.md: CREATOR_ALLOC_MAX. */
export const CREATOR_ALLOC_MAX_PCT = 10n;
/** CLAUDE.md: DV_ALLOC_MIN / DV_ALLOC_MAX. */
export const DV_ALLOC_MIN_PCT = 10n;
export const DV_ALLOC_MAX_PCT = 20n;
/** CLAUDE.md: STAKING_ALLOC_PCT — fixed if enabled, absent if not. */
export const STAKING_ALLOC_PCT = 25n;

/** CLAUDE.md: VESTING_MIN_DAYS / VESTING_MAX_DAYS. */
export const VESTING_MIN_DAYS = 90n;
export const VESTING_MAX_DAYS = 365n;

/**
 * CLAUDE.md: VESTING_FLOOR_BANDS. The shortest vesting a creator allocation of
 * a given size may commit to.
 *
 * WHY A TABLE OF LITERALS
 * The rule in words is "under 5% vests 90 days, 5 to 8 vests 180, above that
 * 365" -- and every boundary in that sentence is ambiguous to the next reader.
 * Is 5% the first band or the second? Is 8%? Every bound below is written out,
 * inclusive on both ends, so there is nothing left to re-derive. A test
 * asserts the bands tile 0..CREATOR_ALLOC_MAX_PCT with no gap and no overlap,
 * which is what actually stops someone editing one number and leaving a hole.
 *
 * WHY A FLOOR AND NOT A VALUE
 * It narrows the range the creator chooses from; it does not choose for them.
 * CLAUDE.md's "no default, forced active selection" still holds -- a creator
 * at 6% picks somewhere in 180..365, actively. What the floor removes is the
 * ability to take a large allocation and vest it briefly, which is the only
 * thing it was ever meant to remove.
 */
export const VESTING_FLOOR_BANDS = [
  { minPercentInclusive: 0n, maxPercentInclusive: 4n, floorDays: 90n },
  { minPercentInclusive: 5n, maxPercentInclusive: 8n, floorDays: 180n },
  { minPercentInclusive: 9n, maxPercentInclusive: 10n, floorDays: 365n },
] as const;

export interface VestingRequirement {
  /**
   * False only at 0%. Nothing is allocated, so nothing vests and the wizard
   * has nothing to ask. A datum still carries a vest_days -- it has a field to
   * fill -- but with token_allocation at zero the value is inert: no schedule
   * can release a share of nothing.
   */
  readonly required: boolean;
  /** The shortest commitment this allocation may make. Absent when not required. */
  readonly floorDays?: bigint;
  /** VESTING_MAX_DAYS whenever vesting is required. The floor narrows, never fixes. */
  readonly maxDays?: bigint;
}

/**
 * What vesting a creator allocation of this size must commit to.
 *
 * Throws on a percentage outside 0..CREATOR_ALLOC_MAX_PCT rather than falling
 * through to the last band -- a share nobody has a rule for is a share nobody
 * should be able to mint.
 */
export function creatorVestingRequirement(creatorPercent: bigint): VestingRequirement {
  if (creatorPercent < 0n || creatorPercent > CREATOR_ALLOC_MAX_PCT) {
    throw new Error(`Creator allocation must be 0-${CREATOR_ALLOC_MAX_PCT}%, got ${creatorPercent}%`);
  }
  if (creatorPercent === 0n) {
    return { required: false };
  }
  const band = VESTING_FLOOR_BANDS.find(
    (b) => creatorPercent >= b.minPercentInclusive && creatorPercent <= b.maxPercentInclusive,
  );
  if (!band) {
    throw new Error(`No vesting band covers a creator allocation of ${creatorPercent}%`);
  }
  return { required: true, floorDays: band.floorDays, maxDays: VESTING_MAX_DAYS };
}

export type Tier = 'A' | 'B' | 'C';

export interface LaunchAllocationRequest {
  totalSupply: bigint;
  tier: Tier;
  /** Whole percent, 0 to CREATOR_ALLOC_MAX_PCT. */
  creatorPercent: bigint;
  /** Whole percent within the DarkVeil band. Must be absent on tier A, which has no DarkVeil phase. */
  darkVeilPercent?: bigint;
  /** The staking pool is per-launch optional; enabling it carves out a fixed share. */
  stakingEnabled: boolean;
  /** Lovelace per token at the start of the curve (CLAUDE.md: CURVE_BASE_PRICE_LOVELACE). */
  basePrice: bigint;
  /** Lovelace per token at full sell-through, the graduation price (CLAUDE.md: CURVE_MAX_PRICE_LOVELACE). */
  maxPrice: bigint;
}

export interface LaunchAllocation {
  totalSupply: bigint;
  /** Sized so the pool opens at POOL_OPEN_PRICE_PCT of the graduation price — see sizeLpReserve. */
  lpReserve: bigint;
  creatorAllocation: bigint;
  /**
   * The DarkVeil reserve. A share OF curveSupply rather than a pocket beside
   * it: a claim advances the curve's tokens_sold the way a buy does, and
   * whatever goes unclaimed sells on the curve. Zero on tier A.
   */
  dvAllocation: bigint;
  /** Zero when staking is not enabled. */
  stakingAllocation: bigint;
  /** What the creator, staking and LP shares leave. This is what makes the split a partition. */
  curveSupply: bigint;
}

function share(totalSupply: bigint, percent: bigint): bigint {
  return (totalSupply * percent) / 100n;
}

/**
 * Divides a launch's supply into the allocations its contracts are deployed
 * with. Throws rather than returning a plan that cannot hold.
 *
 * Take every constructor argument from the result. Computing one of them
 * separately — even correctly — reintroduces exactly the drift this exists
 * to make impossible.
 */
export function planLaunchAllocations(request: LaunchAllocationRequest): LaunchAllocation {
  const { totalSupply, tier, creatorPercent, stakingEnabled } = request;

  if (totalSupply <= 0n) {
    throw new Error('Launch supply must be positive');
  }
  if (totalSupply > TOTAL_SUPPLY_CAP) {
    throw new Error(`Launch supply ${totalSupply} exceeds the platform cap of ${TOTAL_SUPPLY_CAP}`);
  }
  if (creatorPercent < 0n || creatorPercent > CREATOR_ALLOC_MAX_PCT) {
    throw new Error(`Creator allocation must be 0-${CREATOR_ALLOC_MAX_PCT}%, got ${creatorPercent}%`);
  }

  const darkVeilPercent = resolveDarkVeilPercent(tier, request.darkVeilPercent);
  const stakingPercent = stakingEnabled ? STAKING_ALLOC_PCT : 0n;

  const creatorAllocation = share(totalSupply, creatorPercent);
  const dvAllocation = share(totalSupply, darkVeilPercent);
  const stakingAllocation = share(totalSupply, stakingPercent);

  // What the creator and the staking pool leave is divided between the curve
  // and the LP reserve, and the reserve is sized last, from the raise the
  // curve it leaves will produce — so the four parts sum to exactly
  // totalSupply, including whatever the floors above rounded away, and the
  // pool opens at the same price whatever the other shares were.
  const { lpReserve, curveSupply } = sizeLpReserve(
    { basePrice: request.basePrice, maxPrice: request.maxPrice },
    totalSupply - creatorAllocation - stakingAllocation,
    dvAllocation,
  );

  return { totalSupply, lpReserve, creatorAllocation, dvAllocation, stakingAllocation, curveSupply };
}

export interface CurvePrices {
  /** Lovelace per token at the start of the curve. */
  basePrice: bigint;
  /** Lovelace per token at full sell-through: the graduation price. */
  maxPrice: bigint;
}

/**
 * The ADA a curve holds at full sell-through, net of the running fee, when
 * its DarkVeil reserve settles at the flat base price and every other token
 * sells on the curve. This is the floor of what graduation moves into the
 * pool: a DarkVeil token that goes unclaimed sells on the curve instead, at
 * no less than the base price, and a sell during the phase gives back what
 * its buy took, less the fee both legs pay. Each trade floors its two fee
 * slices on its own, which moves the real figure by lovelace, never more.
 */
export function netRaiseAtSellThrough(prices: CurvePrices, curveSupply: bigint, dvReserve: bigint): bigint {
  if (curveSupply <= 0n) {
    throw new Error('A curve with no tokens raises nothing');
  }
  if (dvReserve < 0n || dvReserve > curveSupply) {
    throw new Error(`The DarkVeil reserve (${dvReserve}) must fit inside the curve (${curveSupply})`);
  }
  const datum = { base_price: prices.basePrice, max_price: prices.maxPrice, curve_supply: curveSupply };
  const [numerator, denominator] = grossRangeQuadratic(datum, dvReserve, curveSupply - dvReserve);
  const grossNumerator = dvReserve * prices.basePrice * denominator + numerator;
  const netBps = BPS_DENOMINATOR - CREATOR_BPS - PLATFORM_BPS;
  return (grossNumerator * netBps) / (denominator * BPS_DENOMINATOR);
}

export interface LpReserveSizing {
  lpReserve: bigint;
  curveSupply: bigint;
  /** The floor of the ADA the pool opens with, in lovelace. */
  netRaise: bigint;
}

/**
 * Divides `poolAndCurve` tokens — the supply left once the creator and
 * staking shares are taken — between the curve and the LP reserve so that
 * the pool opens at `openPricePct` of the graduation price. Returns the
 * LARGEST reserve that does: more tokens against the same raise is a deeper
 * pool, and the target is a floor the opening price never goes under.
 *
 * The opening price falls as the reserve grows (the curve shortens, so the
 * raise falls, while the divisor rises), so the largest passing reserve is
 * found by bisection over the exact discrete raise rather than from a
 * formula that would be off by rounding a datum cannot carry.
 */
export function sizeLpReserve(
  prices: CurvePrices,
  poolAndCurve: bigint,
  dvReserve: bigint,
  openPricePct: bigint = POOL_OPEN_PRICE_PCT,
): LpReserveSizing {
  if (prices.basePrice < 0n || prices.maxPrice <= prices.basePrice) {
    throw new Error(`Curve prices must rise: base ${prices.basePrice}, max ${prices.maxPrice}`);
  }
  if (openPricePct <= 0n) {
    throw new Error(
      `The pool's opening price must be a positive percentage of the graduation price, got ${openPricePct}`,
    );
  }
  if (dvReserve < 0n) {
    throw new Error(`The DarkVeil reserve cannot be negative, got ${dvReserve}`);
  }
  const opensAtTarget = (lpReserve: bigint): boolean =>
    netRaiseAtSellThrough(prices, poolAndCurve - lpReserve, dvReserve) * 100n >=
    openPricePct * prices.maxPrice * lpReserve;

  // The curve must run past its DarkVeil reserve, and the reserve must exist.
  const largestReserve = poolAndCurve - dvReserve - 1n;
  if (largestReserve < 1n || !opensAtTarget(1n)) {
    throw new Error(
      `${poolAndCurve} tokens cannot carry a curve past a DarkVeil reserve of ${dvReserve} ` +
        `and a pool that opens at ${openPricePct}% of the graduation price`,
    );
  }
  let passing = 1n;
  let candidate = largestReserve;
  while (passing < candidate) {
    const middle = (passing + candidate + 1n) / 2n;
    if (opensAtTarget(middle)) {
      passing = middle;
    } else {
      candidate = middle - 1n;
    }
  }
  const curveSupply = poolAndCurve - passing;
  return { lpReserve: passing, curveSupply, netRaise: netRaiseAtSellThrough(prices, curveSupply, dvReserve) };
}

function resolveDarkVeilPercent(tier: Tier, requested: bigint | undefined): bigint {
  if (tier === 'A') {
    if (requested !== undefined && requested !== 0n) {
      throw new Error(`the linear curve has no DarkVeil phase, so it cannot allocate ${requested}% to one`);
    }
    return 0n;
  }
  if (requested === undefined) {
    throw new Error(`Tier ${tier} has a DarkVeil phase and must allocate to it`);
  }
  if (requested < DV_ALLOC_MIN_PCT || requested > DV_ALLOC_MAX_PCT) {
    throw new Error(`DarkVeil allocation must be ${DV_ALLOC_MIN_PCT}-${DV_ALLOC_MAX_PCT}%, got ${requested}%`);
  }
  return requested;
}

/**
 * Checks an allocation set that was built somewhere else — a launch already
 * deployed, or figures read back off-chain — against the same invariant.
 *
 * `planLaunchAllocations` cannot produce a failing set, so this is for
 * numbers that did not come from it.
 */
export function assertSupplyConserved(allocation: LaunchAllocation): void {
  const { totalSupply, lpReserve, creatorAllocation, dvAllocation, stakingAllocation, curveSupply } = allocation;
  // The DarkVeil reserve is counted inside the curve, so it is not a part.
  const parts = [lpReserve, creatorAllocation, stakingAllocation, curveSupply];
  if (parts.some((part) => part < 0n) || dvAllocation < 0n) {
    throw new Error('No allocation may be negative');
  }
  const sum = parts.reduce((a, b) => a + b, 0n);
  if (sum !== totalSupply) {
    throw new Error(
      `Allocations sum to ${sum}, which is ${sum > totalSupply ? 'more' : 'less'} than the launch supply of ${totalSupply}`,
    );
  }
  if (curveSupply <= 0n) {
    throw new Error('A launch with nothing on its bonding curve can never graduate');
  }
  if (dvAllocation >= curveSupply) {
    throw new Error('The DarkVeil reserve is a share of the curve and must leave it tokens to sell publicly');
  }
  if (lpReserve <= 0n) {
    throw new Error('A pool with no token side cannot open');
  }
}
