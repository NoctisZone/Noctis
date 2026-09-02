// ============================================================================
// StakingSubmitter — the four builders that spend the pool
// ============================================================================
// WHY THIS FILE EXISTS
//
// Every position-moving action is one spend of one pool UTXO, and the
// validator re-derives the whole continuing datum for itself and compares it
// field by field. So a builder here is not "roughly right or the tx is a bit
// off" — it either reproduces the validator's arithmetic exactly or the spend
// is refused with a message naming nothing.
//
// This module had no test of its builders when four real clock defects were
// found in it on 2026-09-01, all of the same shape: a timestamp taken from the
// wall clock where the validator reads the validity range's lower bound. The
// assertions below are therefore written as RELATIONSHIPS between the datum
// and the plan's own range, never as `field === <the value I passed in>` —
// that form encodes the defect as the expectation and passes either way.
//
// Timestamps here deliberately carry a non-zero millisecond remainder, because
// the bound is floored to a whole second and a fixture on a round second
// cannot tell a floored value from an unfloored one.
//
// The Merkle tree is REAL, not mocked: the pool datum carries the accumulator's
// own root, so `loadPool`'s root check and `buildSpend`'s proof check both run
// for real. Mocking those would remove the only thing making a proof valid.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Lucid: vi.fn(),
    // Identity, so a test can read the datum and redeemer it built rather than
    // their CBOR. Same strategy as the other submitter tests here.
    Data: { ...actual.Data, from: vi.fn((d: unknown) => d), to: vi.fn((d: unknown) => d) },
  };
});

import { CML, Constr, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { bytesToHex, hexToBytes } from '../cap-accumulator-tree.js';
import { STAKING_POOL_REDEEMER } from '../redeemer-indices.js';
import { StakeAccumulator, type StakePosition } from '../stake-accumulator-tree.js';
import { ACC_SCALE, advance, debtAt, owedAt, UNSTAKE_LOCK_MS, validityRangeFor } from '../staking-math.js';
import {
  decodePoolRedeemer,
  extendedHexToBech32PrivateKey,
  keyHashFromAddress,
  StakingSubmitter,
} from '../staking-submitter.js';
import { type StakingPoolDatumData, threadNftAssetName } from '../tier-a-schemas.js';

const NETWORK = 'Preprod' as const;
const LAUNCH_ID = 'ab'.repeat(32);
const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_ASSET_NAME = '42'.repeat(4);
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_ASSET_NAME;
const THREAD_POLICY = 'cc'.repeat(28);
const THREAD_UNIT = THREAD_POLICY + threadNftAssetName('stakingPool', LAUNCH_ID);

const keyHash = (fill: number) => fill.toString(16).padStart(2, '0').repeat(28);
const addrFor = (hash: string) => credentialToAddress(NETWORK, { type: 'Key', hash });

const STAKER_VKH = keyHash(0x3a);
const STAKER_ADDR = addrFor(STAKER_VKH);
const GOVERNOR_VKH = keyHash(0x11);

/**
 * Chosen so the arithmetic lands on round numbers rather than needing the
 * assertions to restate `advance`: at this rate the pool emits exactly one
 * token per millisecond of elapsed time.
 */
const EMISSION_PER_DAY = 86_400_000n;
const LAST_UPDATE_MS = 1_700_000_000_000n;
/** 180s of tip margin plus 5s of real accrual, and NOT on a whole second. */
const NOW_MS = 1_700_000_185_777;
/** What `validityRangeFor` must floor the above to, given the pool's last update. */
const EXPECTED_FROM = 1_700_000_005_000;
const ELAPSED_MS = 5_000n;

function poolDatum(overrides: Partial<StakingPoolDatumData> = {}): StakingPoolDatumData {
  return {
    launch_id: LAUNCH_ID,
    creator_pub_key_hash: keyHash(0x22),
    token_policy_id: TOKEN_POLICY,
    token_asset_name: TOKEN_ASSET_NAME,
    thread_nft_policy: THREAD_POLICY,
    emission_per_day: EMISSION_PER_DAY,
    stake_root: '',
    acc_reward_per_token: 0n,
    total_staked: 0n,
    unallocated: 1_000_000n,
    last_update_ms: LAST_UPDATE_MS,
    exhausted_at: null,
    governor_pub_key_hash: GOVERNOR_VKH,
    ...overrides,
  } as StakingPoolDatumData;
}

/** Records what the builder was told, so a test can read the datum it wrote. */
function fakeTxBuilder() {
  const calls: Record<string, unknown[]> = {};
  const payToContract: unknown[][] = [];
  const payToAddress: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  const ret = () => builder;

  builder.collectFrom = vi.fn((...a: unknown[]) => {
    calls.collectFrom = a;
    return ret();
  });
  builder.attach = { SpendingValidator: vi.fn(ret) };
  builder.pay = {
    ToContract: vi.fn((...a: unknown[]) => {
      payToContract.push(a);
      return ret();
    }),
    ToAddressWithData: vi.fn((...a: unknown[]) => {
      payToAddress.push(a);
      return ret();
    }),
  };
  builder.validFrom = vi.fn((...a: unknown[]) => {
    calls.validFrom = a;
    return ret();
  });
  builder.validTo = vi.fn((...a: unknown[]) => {
    calls.validTo = a;
    return ret();
  });
  builder.addSigner = vi.fn((...a: unknown[]) => {
    calls.addSigner = a;
    return ret();
  });
  builder.complete = vi.fn(() => Promise.resolve({ completed: true }));

  return { builder, calls, payToContract, payToAddress };
}

interface Harness {
  submitter: StakingSubmitter;
  lucid: { newTx: () => unknown; utxosAt: ReturnType<typeof vi.fn> };
  tx: ReturnType<typeof fakeTxBuilder>;
  datum: StakingPoolDatumData;
  positions: StakeAccumulator;
}

/**
 * A submitter over one pool UTXO whose datum carries the REAL root of
 * `positions`, so every proof built against it verifies for real.
 */
function harness(
  opts: { positions?: StakeAccumulator; datum?: Partial<StakingPoolDatumData>; poolTokens?: bigint } = {},
): Harness {
  const positions = opts.positions ?? new StakeAccumulator();
  const datum = poolDatum({ stake_root: bytesToHex(positions.root()), ...opts.datum });
  const tx = fakeTxBuilder();

  const lucid = {
    newTx: () => tx.builder,
    utxosAt: vi.fn().mockResolvedValue([
      {
        txHash: 'ee'.repeat(32),
        outputIndex: 0,
        address: '',
        datum,
        assets: { lovelace: 5_000_000n, [THREAD_UNIT]: 1n, [TOKEN_UNIT]: opts.poolTokens ?? 500_000n },
      },
    ]),
  };
  vi.mocked(Lucid).mockResolvedValue(lucid as never);

  const submitter = new StakingSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: NETWORK,
    stakingPoolScriptCbor: '590004',
    launchIdHex: LAUNCH_ID,
    threadNftPolicyId: THREAD_POLICY,
  });
  // The UTXO must sit at the address the validator hashes to.
  lucid.utxosAt.mockResolvedValue([
    {
      txHash: 'ee'.repeat(32),
      outputIndex: 0,
      address: submitter.poolAddress,
      datum,
      assets: { lovelace: 5_000_000n, [THREAD_UNIT]: 1n, [TOKEN_UNIT]: opts.poolTokens ?? 500_000n },
    },
  ]);
  // The replay has its own test file; these tests are about the builders, so
  // the position set is supplied rather than reconstructed from Blockfrost.
  vi.spyOn(submitter, 'rebuildPositions').mockResolvedValue(positions);

  return { submitter, lucid: lucid as never, tx, datum, positions };
}

/** The datum the builder wrote to the continuing pool output. */
function writtenDatum(h: Harness): StakingPoolDatumData {
  const [, data] = h.tx.payToContract[0] as [string, { value: StakingPoolDatumData }];
  return data.value;
}

/** The redeemer the builder attached to the pool input. */
function writtenRedeemer(h: Harness): Constr<unknown> {
  return (h.tx.calls.collectFrom as [unknown[], Constr<unknown>])[1];
}

const openPosition = (amount: bigint, since: bigint, debt = 0n): StakePosition => ({ amount, debt, since });

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The clock. Every defect found in this module on 2026-09-01 was one of these.
// ---------------------------------------------------------------------------

describe('the validity range is the clock', () => {
  it('stamps the datum with the range lower bound, not the wall clock it was called with', async () => {
    const h = harness();
    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);

    const from = (h.tx.calls.validFrom as [number])[0];
    const written = writtenDatum(h);

    // The relationship, not the literal: the datum's timestamp IS the bound.
    expect(written.last_update_ms).toBe(BigInt(from));
    // And that bound is emphatically not the millisecond it was handed.
    expect(written.last_update_ms).not.toBe(BigInt(NOW_MS));
    expect(from).toBe(EXPECTED_FROM);
  });

  it('opens the range behind the clock and floors it to a whole second', async () => {
    const h = harness();
    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);

    const from = (h.tx.calls.validFrom as [number])[0];
    expect(from % 1000).toBe(0);
    expect(from).toBeLessThan(NOW_MS);
  });

  it('keeps the range inside the width the validator accepts', async () => {
    const h = harness();
    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);

    const from = (h.tx.calls.validFrom as [number])[0];
    const to = (h.tx.calls.validTo as [number])[0];
    expect(to).toBeGreaterThan(from);
    expect(to - from).toBeLessThanOrEqual(600_000);
  });

  it('never opens the range before the pool last moved, so time cannot run backwards', async () => {
    // A second spend moments after the first: the tip margin would otherwise
    // reach back behind the pool's own last update.
    const h = harness({ datum: { last_update_ms: BigInt(NOW_MS) - 1_000n } });
    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);

    const from = (h.tx.calls.validFrom as [number])[0];
    expect(BigInt(from)).toBeGreaterThanOrEqual(writtenDatum(h).last_update_ms);
    expect(from).toBeGreaterThanOrEqual(Number(h.datum.last_update_ms) - 1000);
  });

  it("dates a new position by the range bound too, not by a second look at the clock", async () => {
    const positions = new StakeAccumulator();
    const h = harness({ positions });
    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);

    const from = BigInt((h.tx.calls.validFrom as [number])[0]);
    // The accumulator is mutated in place by the builder, so the leaf it
    // committed to is readable here.
    expect(positions.get(hexToBytes(STAKER_VKH)).since).toBe(from);
    expect(positions.get(hexToBytes(STAKER_VKH)).since).not.toBe(BigInt(NOW_MS));
  });
});

// ---------------------------------------------------------------------------
// Staking
// ---------------------------------------------------------------------------

describe('stakeCore', () => {
  it('refuses a non-positive amount', async () => {
    const h = harness();
    await expect(h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 0n, NOW_MS)).rejects.toThrow(/must be positive/i);
    await expect(h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, -5n, NOW_MS)).rejects.toThrow(
      /must be positive/i,
    );
  });

  it('builds a Stake redeemer carrying the staker, their prior position and the amount', async () => {
    const h = harness();
    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);

    const r = writtenRedeemer(h);
    expect(r.index).toBe(STAKING_POOL_REDEEMER.Stake);
    expect(r.fields[0]).toBe(STAKER_VKH);
    expect(r.fields[3]).toBe(1_000n);
  });

  it('requires the staker to sign', async () => {
    const h = harness();
    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);
    expect(h.tx.calls.addSigner).toEqual([STAKER_ADDR]);
  });

  it('moves the staked tokens into the pool and counts them as staked', async () => {
    const h = harness({ poolTokens: 500_000n });
    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);

    const [, , assets] = h.tx.payToContract[0] as [string, unknown, Record<string, bigint>];
    expect(assets[TOKEN_UNIT]).toBe(501_000n);
    expect(assets[THREAD_UNIT]).toBe(1n);
    expect(writtenDatum(h).total_staked).toBe(1_000n);
  });

  it('compounds what was already owed into the new position rather than paying it out', async () => {
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, LAST_UPDATE_MS));
    const h = harness({ positions, datum: { total_staked: 1_000n } });

    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 500n, NOW_MS);

    // At one token emitted per ms against 1,000 staked, 5,000 ms accrues 5,000.
    const { acc } = advance({ ...h.datum, total_staked: 1_000n }, BigInt(EXPECTED_FROM));
    const owed = owedAt(openPosition(1_000n, LAST_UPDATE_MS), acc);
    expect(owed).toBe(ELAPSED_MS);

    const after = positions.get(hexToBytes(STAKER_VKH));
    expect(after.amount).toBe(1_000n + 500n + owed);
    expect(after.debt).toBe(debtAt(after.amount, acc));
    // Compounded, not paid: only the pool output exists.
    expect(h.tx.payToAddress).toHaveLength(0);
    expect(writtenDatum(h).total_staked).toBe(1_000n + 500n + owed);
  });

  it('advances the accumulator and spends the emission out of the unallocated budget', async () => {
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, LAST_UPDATE_MS));
    const h = harness({ positions, datum: { total_staked: 1_000n } });

    await h.submitter.stakeCore(h.lucid as never, STAKER_ADDR, 1n, NOW_MS);

    const written = writtenDatum(h);
    expect(written.acc_reward_per_token).toBe((ELAPSED_MS * ACC_SCALE) / 1_000n);
    expect(written.unallocated).toBe(1_000_000n - ELAPSED_MS);
  });
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

describe('unstakeCore', () => {
  it('refuses a wallet with no open position', async () => {
    const h = harness();
    await expect(h.submitter.unstakeCore(h.lucid as never, STAKER_ADDR, NOW_MS)).rejects.toThrow(
      /no open staking position/i,
    );
  });

  it('refuses while the position is still locked, and names when it frees', async () => {
    const positions = new StakeAccumulator();
    // Staked a moment ago: the lock has essentially all of its week left.
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, BigInt(NOW_MS)));
    const h = harness({ positions, datum: { total_staked: 1_000n, last_update_ms: BigInt(NOW_MS) } });

    await expect(h.submitter.unstakeCore(h.lucid as never, STAKER_ADDR, NOW_MS)).rejects.toThrow(/locked until/i);
  });

  it('measures the lock against the range bound, not the raw clock', async () => {
    // `since` sits between the clamped bound and the raw clock. Reading the
    // clock would call this unlocked; the validator would then refuse it.
    const since = BigInt(EXPECTED_FROM) + 60_000n - UNSTAKE_LOCK_MS;
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, since));
    const h = harness({ positions, datum: { total_staked: 1_000n } });

    const bound = BigInt(validityRangeFor(NOW_MS, Number(LAST_UPDATE_MS)).from);
    expect(bound).toBeLessThan(since + UNSTAKE_LOCK_MS);
    expect(BigInt(NOW_MS)).toBeGreaterThan(since + UNSTAKE_LOCK_MS);

    await expect(h.submitter.unstakeCore(h.lucid as never, STAKER_ADDR, NOW_MS)).rejects.toThrow(/locked until/i);
  });

  it('pays out the stake and everything owed once the lock has run', async () => {
    const since = LAST_UPDATE_MS - UNSTAKE_LOCK_MS - 1n;
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, since));
    const h = harness({ positions, datum: { total_staked: 1_000n } });

    await h.submitter.unstakeCore(h.lucid as never, STAKER_ADDR, NOW_MS);

    const r = writtenRedeemer(h);
    expect(r.index).toBe(STAKING_POOL_REDEEMER.Unstake);

    const [addr, , assets] = h.tx.payToAddress[0] as [string, unknown, Record<string, bigint>];
    expect(addr).toBe(STAKER_ADDR);
    expect(assets[TOKEN_UNIT]).toBe(1_000n + ELAPSED_MS);

    const written = writtenDatum(h);
    expect(written.total_staked).toBe(0n);
    expect(h.tx.calls.addSigner).toEqual([STAKER_ADDR]);
  });

  it('empties the slot, so a full exit restores the tree a first stake started from', async () => {
    const since = LAST_UPDATE_MS - UNSTAKE_LOCK_MS - 1n;
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, since));
    const h = harness({ positions, datum: { total_staked: 1_000n } });

    await h.submitter.unstakeCore(h.lucid as never, STAKER_ADDR, NOW_MS);

    expect(positions.size).toBe(0);
    expect(bytesToHex(positions.root())).toBe(bytesToHex(new StakeAccumulator().root()));
  });
});

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

describe('claimCore', () => {
  const staked = () => {
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, LAST_UPDATE_MS));
    return positions;
  };

  it("refuses a charge below the contract's own floor", async () => {
    const h = harness({ positions: staked(), datum: { total_staked: 1_000n } });
    await expect(h.submitter.claimCore(h.lucid as never, STAKER_ADDR, 199_999n, NOW_MS)).rejects.toThrow(
      /below the contract/i,
    );
  });

  it('refuses a wallet with no open position', async () => {
    const h = harness();
    await expect(h.submitter.claimCore(h.lucid as never, STAKER_ADDR, 1_000_000n, NOW_MS)).rejects.toThrow(
      /no open staking position/i,
    );
  });

  it('refuses when nothing has accrued yet', async () => {
    // No elapsed time: the bound is clamped to the pool's own last update.
    const h = harness({ positions: staked(), datum: { total_staked: 1_000n, last_update_ms: BigInt(NOW_MS) } });
    await expect(h.submitter.claimCore(h.lucid as never, STAKER_ADDR, 1_000_000n, NOW_MS)).rejects.toThrow(
      /nothing has accrued/i,
    );
  });

  it('pays what is owed and charges the governor, without asking anyone to sign', async () => {
    const h = harness({ positions: staked(), datum: { total_staked: 1_000n } });
    await h.submitter.claimCore(h.lucid as never, STAKER_ADDR, 1_055_950n, NOW_MS);

    expect(writtenRedeemer(h).index).toBe(STAKING_POOL_REDEEMER.ClaimRewards);

    const [stakerAddr, , stakerAssets] = h.tx.payToAddress[0] as [string, unknown, Record<string, bigint>];
    expect(stakerAddr).toBe(STAKER_ADDR);
    expect(stakerAssets[TOKEN_UNIT]).toBe(ELAPSED_MS);

    const [govAddr, , govAssets] = h.tx.payToAddress[1] as [string, unknown, Record<string, bigint>];
    expect(govAddr).toBe(addrFor(GOVERNOR_VKH));
    expect(govAssets.lovelace).toBe(1_055_950n);

    // ClaimRewards takes no signature by design — anyone may build it, and the
    // validator is what makes the charge stick.
    expect(h.tx.calls.addSigner).toBeUndefined();
  });

  it('leaves the position and its lock untouched, so claiming does not restart the week', async () => {
    const positions = staked();
    const h = harness({ positions, datum: { total_staked: 1_000n } });

    await h.submitter.claimCore(h.lucid as never, STAKER_ADDR, 1_055_950n, NOW_MS);

    const after = positions.get(hexToBytes(STAKER_VKH));
    expect(after.amount).toBe(1_000n);
    expect(after.since).toBe(LAST_UPDATE_MS);
    expect(writtenDatum(h).total_staked).toBe(1_000n);
  });
});

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

describe('topUpCore', () => {
  it('refuses a non-positive amount', async () => {
    const h = harness();
    await expect(h.submitter.topUpCore(h.lucid as never, STAKER_ADDR, 0n, NOW_MS)).rejects.toThrow(/must be positive/i);
  });

  it('adds to the budget and brings the tokens with it', async () => {
    const h = harness({ poolTokens: 500_000n });
    await h.submitter.topUpCore(h.lucid as never, STAKER_ADDR, 250n, NOW_MS);

    expect(writtenRedeemer(h).index).toBe(STAKING_POOL_REDEEMER.TopUpPool);
    expect(writtenDatum(h).unallocated).toBe(1_000_000n + 250n);

    const [, , assets] = h.tx.payToContract[0] as [string, unknown, Record<string, bigint>];
    expect(assets[TOKEN_UNIT]).toBe(500_250n);
  });

  it('revives an exhausted pool by clearing the stamp the close cooldown runs from', async () => {
    const h = harness({ datum: { unallocated: 0n, exhausted_at: LAST_UPDATE_MS } });
    await h.submitter.topUpCore(h.lucid as never, STAKER_ADDR, 1_000n, NOW_MS);

    expect(writtenDatum(h).exhausted_at).toBeNull();
    expect(writtenDatum(h).unallocated).toBe(1_000n);
  });

  it('is permissionless — nobody is asked to sign', async () => {
    const h = harness();
    await h.submitter.topUpCore(h.lucid as never, STAKER_ADDR, 1n, NOW_MS);
    expect(h.tx.calls.addSigner).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('loadPool', () => {
  it('refuses a rebuilt tree that does not derive the root the pool carries', async () => {
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, LAST_UPDATE_MS));
    // A pool whose datum was built from a DIFFERENT set than the one rebuilt.
    const h = harness({ positions, datum: { stake_root: 'ff'.repeat(32) } });

    await expect(h.submitter.loadPool()).rejects.toThrow(/does not match the pool/i);
    // The message has to name both roots, or it points at nothing.
    await expect(h.submitter.loadPool()).rejects.toThrow(/ff{8}/);
  });
});

describe('overview and positionOf', () => {
  it('reports the pool and every open position, with what each is owed', async () => {
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, LAST_UPDATE_MS));
    const h = harness({ positions, datum: { total_staked: 1_000n } });

    const o = await h.submitter.overview();
    expect(o.launchIdHex).toBe(LAUNCH_ID);
    expect(o.tokenUnit).toBe(TOKEN_UNIT);
    expect(o.stakerCount).toBe(1);
    expect(o.totalStaked).toBe(1_000n);
    expect(o.poolTokenBalance).toBe(500_000n);
    expect(o.positions[0].stakerVkhHex).toBe(STAKER_VKH);
    expect(o.positions[0].unstakeUnlocksAtMs).toBe(LAST_UPDATE_MS + UNSTAKE_LOCK_MS);
    expect(o.currentAprPercent).not.toBeNull();
  });

  it('leaves the rate and the runway undefined while nothing is staked', async () => {
    const h = harness();
    const o = await h.submitter.overview();
    expect(o.stakerCount).toBe(0);
    expect(o.currentAprPercent).toBeNull();
    expect(o.runwayDaysRemaining).toBeNull();
  });

  it('returns null for a wallet holding no position', async () => {
    const h = harness();
    expect(await h.submitter.positionOf(addrFor(keyHash(0x77)))).toBeNull();
  });

  it("finds a wallet's own position by its payment key hash", async () => {
    const positions = new StakeAccumulator();
    positions.set(hexToBytes(STAKER_VKH), openPosition(1_000n, LAST_UPDATE_MS));
    const h = harness({ positions, datum: { total_staked: 1_000n } });

    const p = await h.submitter.positionOf(STAKER_ADDR);
    expect(p?.stakedAmount).toBe(1_000n);
    expect(p?.sinceMs).toBe(LAST_UPDATE_MS);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('keyHashFromAddress', () => {
  it('reads the payment credential a base address encodes in its own bytes', () => {
    expect(keyHashFromAddress(STAKER_ADDR)).toBe(STAKER_VKH);
  });

  it('refuses an address it cannot derive one from', () => {
    expect(() => keyHashFromAddress('not-an-address')).toThrow();
  });
});

describe('extendedHexToBech32PrivateKey', () => {
  it('accepts a real 64-byte extended key', () => {
    const hex = Buffer.from(CML.PrivateKey.generate_ed25519extended().to_raw_bytes()).toString('hex');
    expect(extendedHexToBech32PrivateKey(hex)).toMatch(/^ed25519e_sk/);
  });

  it('names the length it actually got when handed the wrong one', () => {
    expect(() => extendedHexToBech32PrivateKey('00'.repeat(32))).toThrow(/got 32 bytes/);
  });
});

describe('decodePoolRedeemer', () => {
  const pool = poolDatum();
  const NOW = 1_700_000_000_000n;
  const position = new Constr(0, [1_000n, 5n, 42n]);

  it('reads a Stake, keeping the position it started from', () => {
    const stake = new Constr(STAKING_POOL_REDEEMER.Stake, [STAKER_VKH, position, [], 250n]);
    const e = decodePoolRedeemer(stake as never, pool, NOW);
    expect(e).toMatchObject({ kind: 'stake', stakerVkhHex: STAKER_VKH, amount: 250n, nowMs: NOW });
    expect(e?.kind === 'stake' && e.before).toEqual({ amount: 1_000n, debt: 5n, since: 42n });
  });

  it('tells an Unstake and a ClaimRewards apart, though they carry the same fields', () => {
    const un = new Constr(STAKING_POOL_REDEEMER.Unstake, [STAKER_VKH, position, []]);
    const cl = new Constr(STAKING_POOL_REDEEMER.ClaimRewards, [STAKER_VKH, position, []]);
    const u = decodePoolRedeemer(un as never, pool, NOW);
    const c = decodePoolRedeemer(cl as never, pool, NOW);
    expect(u?.kind).toBe('unstake');
    expect(c?.kind).toBe('claim');
  });

  it('reads a TopUpPool and a ClosePool', () => {
    expect(decodePoolRedeemer(new Constr(STAKING_POOL_REDEEMER.TopUpPool, [900n]) as never, pool, NOW)).toMatchObject({
      kind: 'topUp',
      amount: 900n,
    });
    const close = new Constr(STAKING_POOL_REDEEMER.ClosePool, []);
    expect(decodePoolRedeemer(close as never, pool, NOW)).toMatchObject({ kind: 'close' });
  });

  it('returns null rather than guessing, for anything it cannot read', () => {
    // An index the redeemer does not define.
    expect(decodePoolRedeemer(new Constr(9, []) as never, pool, NOW)).toBeNull();
    // Not a Constr at all.
    expect(decodePoolRedeemer(1234n as never, pool, NOW)).toBeNull();
    // A position of the wrong arity.
    expect(
      decodePoolRedeemer(
        new Constr(STAKING_POOL_REDEEMER.Stake, [STAKER_VKH, new Constr(0, [1n, 2n]), [], 1n]) as never,
        pool,
        NOW,
      ),
    ).toBeNull();
    // A staker key that is not a string.
    const badKey = new Constr(STAKING_POOL_REDEEMER.Unstake, [1n, position, []]);
    expect(decodePoolRedeemer(badKey as never, pool, NOW)).toBeNull();
    // A top-up amount that is not an integer.
    expect(decodePoolRedeemer(new Constr(STAKING_POOL_REDEEMER.TopUpPool, ['900']) as never, pool, NOW)).toBeNull();
  });
});
