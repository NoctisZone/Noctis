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

/** CLAUDE.md: TOTAL_SUPPLY. The hard cap a launch may not exceed. */
export const TOTAL_SUPPLY_CAP = 1_000_000_000n;
/** CLAUDE.md: LP_RESERVE_PCT — platform-fixed, not creator-adjustable. */
export const LP_RESERVE_PCT = 20n;
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
}

export interface LaunchAllocation {
  totalSupply: bigint;
  lpReserve: bigint;
  creatorAllocation: bigint;
  /** Zero on tier A. */
  dvAllocation: bigint;
  /** Zero when staking is not enabled. */
  stakingAllocation: bigint;
  /** Whatever the others leave. This is what makes the split a partition. */
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

  const lpReserve = share(totalSupply, LP_RESERVE_PCT);
  const creatorAllocation = share(totalSupply, creatorPercent);
  const dvAllocation = share(totalSupply, darkVeilPercent);
  const stakingAllocation = share(totalSupply, stakingPercent);

  // The curve is the remainder, so the five always sum to exactly
  // totalSupply — including whatever the four floors above rounded away.
  const curveSupply = totalSupply - lpReserve - creatorAllocation - dvAllocation - stakingAllocation;
  if (curveSupply <= 0n) {
    throw new Error(
      'Allocations leave nothing for the bonding curve: ' +
        `${LP_RESERVE_PCT}% LP + ${creatorPercent}% creator + ${darkVeilPercent}% DarkVeil + ` +
        `${stakingPercent}% staking of ${totalSupply}`,
    );
  }

  return { totalSupply, lpReserve, creatorAllocation, dvAllocation, stakingAllocation, curveSupply };
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
  const parts = [lpReserve, creatorAllocation, dvAllocation, stakingAllocation, curveSupply];
  if (parts.some((part) => part < 0n)) {
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
}
