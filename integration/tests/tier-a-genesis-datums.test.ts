// The genesis datum builder had no test at all. This covers the one field
// this change made load-bearing rather than inert: `phase_started_at`.
//
// It is the clock ExpireCurve measures its stall window from, and ExpireCurve
// now reaches Inactive — so a genesis writing zero here would not be a cosmetic
// default, it would mean every launch is expirable from the moment it is
// minted, by anyone, before the governor has activated it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Data } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { buildGenesisDatums } from '../tier-a-genesis-datums.js';
import { BondingCurveTierBDatumSchema, StakingPoolDatumSchema } from '../tier-a-schemas.js';

const KEYHASH = 'aa'.repeat(28);
const POLICY = 'bb'.repeat(28);

// The builder's own default resolves relative to the bundled CLI, so a test
// has to supply this — see the `blueprint` input's comment.
const blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);

function input(overrides: Record<string, unknown> = {}) {
  return {
    blueprint,
    network: 'preprod' as const,
    creatorPubKeyHashHex: KEYHASH,
    governorPubKeyHashHex: 'cc'.repeat(28),
    bondPayoutPubKeyHashHex: 'dd'.repeat(28),
    tokenPolicyIdHex: POLICY,
    tokenBaseNameHex: Buffer.from('TEST').toString('hex'),
    tokenName: 'Test Token',
    tokenDescription: 'A launch built only to inspect its genesis datum.',
    threadNftPolicyIdHex: 'ff'.repeat(28),
    poolNftPolicyIdHex: 'ee'.repeat(28),
    basePrice: 3,
    maxPrice: 75,
    vestDays: 90,
    ...overrides,
  };
}

describe('tier-a-genesis-datums.ts — the stall clock starts at the mint', () => {
  it('stamps phase_started_at with the genesis time on the linear curve, not zero', async () => {
    const at = 1_785_000_000_000;
    const g = await buildGenesisDatums(input({ genesisTimestampMs: at }));
    const datum = Data.from(g.datums.bondingCurve, BondingCurveTierBDatumSchema);
    expect(datum.phase_started_at).toBe(BigInt(at));
  });

  it('stamps phase_started_at with the genesis time on Cardano Launch too', async () => {
    const at = 1_785_000_000_000;
    const g = await buildGenesisDatums(input({ tier: 'B', genesisTimestampMs: at }));
    const datum = Data.from(g.datums.bondingCurve, BondingCurveTierBDatumSchema);
    expect(datum.phase_started_at).toBe(BigInt(at));
  });

  it('defaults to now rather than zero when no genesis time is given', async () => {
    // The default is the case that actually ships — an explicit timestamp is
    // the test-and-reproducibility path — so leaving it at zero would be the
    // real bug and this is the test that would catch it.
    const before = Date.now();
    const g = await buildGenesisDatums(input());
    const after = Date.now();
    const datum = Data.from(g.datums.bondingCurve, BondingCurveTierBDatumSchema);
    expect(datum.phase_started_at).toBeGreaterThanOrEqual(BigInt(before));
    expect(datum.phase_started_at).toBeLessThanOrEqual(BigInt(after));
  });

  it('opens the curve Inactive, which is the state the stall clock is timing', async () => {
    const g = await buildGenesisDatums(input());
    const datum = Data.from(g.datums.bondingCurve, BondingCurveTierBDatumSchema);
    expect(datum.curve_state).toBe('Inactive');
  });
});

// The pool's token side, which nothing on chain requires to exist.
//
// `lp_reserve_tokens` is only ever READ by the curve: graduation compares the
// pool output's token balance to it. At zero that comparison is satisfied by
// ABSENCE — the raise moves into a pool with no token side at all. The genesis
// datum is authored under platform control, so this is the author's bound to
// keep, and these are the tests that keep it.
//
// Each is the passing fixture plus ONE delta, so a failure can only be the
// delta. The positive case above them is what stops all three passing for the
// wrong reason.
describe('tier-a-genesis-datums.ts — the pool always gets a token side', () => {
  it('builds normally on the platform-fixed reserve, which is the control', async () => {
    const g = await buildGenesisDatums(input({ tier: 'B' }));
    const datum = Data.from(g.datums.bondingCurve, BondingCurveTierBDatumSchema);
    expect(datum.lp_reserve_tokens).toBe(200_000_000n); // 20% of 1B
    expect(g.supplySplit.lpReserveTokens).toBe(200_000_000);
  });

  it('refuses a zero reserve rather than minting a launch that cannot seed a pool', async () => {
    await expect(buildGenesisDatums(input({ tier: 'B', lpReservePct: 0 }))).rejects.toThrow(
      /lpReservePct must be a positive integer/,
    );
  });

  it('refuses a negative or fractional percentage', async () => {
    await expect(buildGenesisDatums(input({ lpReservePct: -20 }))).rejects.toThrow(/positive integer/);
    await expect(buildGenesisDatums(input({ lpReservePct: 20.5 }))).rejects.toThrow(/positive integer/);
  });

  it('refuses more than the whole supply', async () => {
    await expect(buildGenesisDatums(input({ lpReservePct: 101 }))).rejects.toThrow(/positive integer/);
  });

  // The percentage can be perfectly legitimate and still floor to nothing on a
  // small enough supply, which is why the derived figure is checked too and not
  // only the input.
  it('refuses a reserve that floors to zero on a small supply, though the percentage is valid', async () => {
    await expect(buildGenesisDatums(input({ totalSupply: 4, lpReservePct: 20 }))).rejects.toThrow(
      /lp_reserve_tokens <= 0/,
    );
  });
});

describe('tier-a-genesis-datums.ts — the lock on leaving a staking position', () => {
  // A staking-enabled quadratic launch. Every case below is this fixture with
  // exactly one thing changed, so a failure names the one thing.
  const staked = (overrides: Record<string, unknown> = {}) =>
    input({ tier: 'B', stakingEnabled: true, stakingDurationDays: 1095, ...overrides });

  const locks = async (overrides: Record<string, unknown> = {}) => {
    const g = await buildGenesisDatums(staked(overrides));
    if (!g.datums.stakingPool) throw new Error('a staking-enabled launch emitted no pool datum');
    const curve = Data.from(g.datums.bondingCurve, BondingCurveTierBDatumSchema);
    const pool = Data.from(g.datums.stakingPool, StakingPoolDatumSchema);
    return { curve: curve.staking_unstake_lock_ms, pool: pool.unstake_lock_ms };
  };

  it("defaults to the platform's seven days, written to both datums", async () => {
    expect(await locks()).toEqual({ curve: 604_800_000n, pool: 604_800_000n });
  });

  // The seeding check rebuilds the pool's genesis from the curve's own term,
  // so the two must agree or graduation refuses its own pool.
  it('a shorter lock reaches the curve and the pool alike', async () => {
    expect(await locks({ stakingUnstakeLockMs: 86_400_000 })).toEqual({ curve: 86_400_000n, pool: 86_400_000n });
  });

  it('refuses a lock longer than the platform period, which the validator would refuse too', async () => {
    await expect(buildGenesisDatums(staked({ stakingUnstakeLockMs: 604_800_001 }))).rejects.toThrow(/ceiling/);
  });

  it('refuses a negative lock', async () => {
    await expect(buildGenesisDatums(staked({ stakingUnstakeLockMs: -1 }))).rejects.toThrow(/ceiling/);
  });

  // Only a staking launch has a position to lock, so the term is not
  // validated when staking is off — the same shape as the duration check.
  it('ignores the term entirely when staking is declined', async () => {
    const g = await buildGenesisDatums(input({ tier: 'B', stakingUnstakeLockMs: 999_999_999_999 }));
    expect(g.datums.stakingPool).toBeNull();
  });
});

describe('tier-a-genesis-datums.ts — a bigger creator allocation must vest longer', () => {
  // Both figures were already bounded on their own, and every pairing of the
  // two passed: the largest allocation on the shortest schedule built a datum
  // like any other. These are the pairings that must now be refused, and the
  // ones that must still build.

  it('refuses the largest allocation on the shortest schedule', async () => {
    await expect(buildGenesisDatums(input({ creatorAllocPct: 10, vestDays: 90 }))).rejects.toThrow(/at least 365 days/);
  });

  it('refuses a recommended-band allocation on the minimum schedule', async () => {
    await expect(buildGenesisDatums(input({ creatorAllocPct: 5, vestDays: 90 }))).rejects.toThrow(/at least 180 days/);
    await expect(buildGenesisDatums(input({ creatorAllocPct: 8, vestDays: 179 }))).rejects.toThrow(/at least 180 days/);
  });

  it('refuses one day short of a floor, and accepts the floor itself', async () => {
    // The off-by-one is the whole point of a boundary, so it is asserted from
    // both sides rather than from the comfortable one.
    await expect(buildGenesisDatums(input({ creatorAllocPct: 9, vestDays: 364 }))).rejects.toThrow(/at least 365 days/);
    await expect(buildGenesisDatums(input({ creatorAllocPct: 9, vestDays: 365 }))).resolves.toBeDefined();
    await expect(buildGenesisDatums(input({ creatorAllocPct: 5, vestDays: 180 }))).resolves.toBeDefined();
  });

  it('lets a small allocation keep the minimum schedule', async () => {
    await expect(buildGenesisDatums(input({ creatorAllocPct: 4, vestDays: 90 }))).resolves.toBeDefined();
  });

  it('asks nothing of a launch whose creator takes no allocation', async () => {
    // Nothing is allocated, so no floor applies and the datum's vest_days is
    // inert -- no schedule releases a share of nothing.
    await expect(buildGenesisDatums(input({ creatorAllocPct: 0, vestDays: 90 }))).resolves.toBeDefined();
  });

  it('still lets a creator vest for longer than their floor', async () => {
    // A floor, not a value: the creator chooses above it.
    const g = await buildGenesisDatums(input({ creatorAllocPct: 5, vestDays: 300 }));
    expect(g.datums.vesting).toBeDefined();
  });

  it('keeps the standalone bounds it already had', async () => {
    await expect(buildGenesisDatums(input({ creatorAllocPct: 4, vestDays: 89 }))).rejects.toThrow(/90-365/);
    await expect(buildGenesisDatums(input({ creatorAllocPct: 4, vestDays: 366 }))).rejects.toThrow(/90-365/);
    await expect(buildGenesisDatums(input({ creatorAllocPct: 11, vestDays: 365 }))).rejects.toThrow(/0-10/);
  });
});
