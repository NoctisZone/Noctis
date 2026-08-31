// A staking position's datum is written by whoever paid the UTXO to the script
// address, and paying a UTXO to a script address runs no validator. So
// `staked_amount` is a claim, not a fact — and rewards accrue by weight.
//
// These pin the one rule that follows: a position weighs what it actually
// holds. Unstake pays out the output's real value, so a false claim costs its
// author nothing to make, which is what makes believing it expensive.

import { Data } from '@lucid-evolution/lucid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeRewardSnapshot, fetchStakeHistory, type StakeEvent } from '../staking-reward-tree-builder.js';
import { type StakingDatumData, StakingDatumSchema, threadNftAssetName } from '../tier-a-schemas.js';

const LAUNCH = 'a1'.repeat(32);
const TOKEN_POLICY = 'b2'.repeat(28);
const TOKEN_NAME = '746f6b';
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_NAME;
const HONEST = '11'.repeat(28);
const LIAR = '22'.repeat(28);
const POOL_TX = 'aa'.repeat(32);
const STAKE_TX = 'bb'.repeat(32);
const FORGED_POOL_TX = 'cc'.repeat(32);
// The launch's real thread-NFT policy, as the CALLER knows it. Everything the
// genesis read trusts hangs off this being supplied rather than inferred.
const THREAD_POLICY = 'dd'.repeat(28);
const POOL_NFT_UNIT = THREAD_POLICY + threadNftAssetName('stakingPool', LAUNCH);
const FORGER_POLICY = 'ee'.repeat(28);

const CONFIG = { blockfrostUrl: 'https://bf.test', blockfrostProjectId: 'proj' };

function poolDatum(threadNftPolicy = THREAD_POLICY) {
  return Data.to<StakingDatumData>(
    {
      Pool: [
        {
          launch_id: LAUNCH,
          governor_pub_key_hash: '33'.repeat(28),
          creator_pub_key_hash: '44'.repeat(28),
          token_policy_id: TOKEN_POLICY,
          token_asset_name: TOKEN_NAME,
          reward_root: '00'.repeat(32),
          claimed_bits: '0000',
          thread_nft_policy: threadNftPolicy,
        },
      ],
    },
    StakingDatumSchema as never,
  );
}

function positionDatum(stakerVkh: string, claimedAmount: bigint, tsMs: bigint) {
  return Data.to<StakingDatumData>(
    { Position: [{ launch_id: LAUNCH, staker_vkh: stakerVkh, staked_amount: claimedAmount, stake_timestamp: tsMs }] },
    StakingDatumSchema as never,
  );
}

/** Blockfrost responses, keyed by the path suffix each call uses. */
function mockChain(opts: {
  positions: Array<{ vkh: string; claimed: bigint; real: bigint }>;
  /** Strip the pool's thread NFT, to describe an output that never had one. */
  poolWithoutNft?: boolean;
  /**
   * A Pool-shaped output landing BEFORE the genuine seed, holding far more.
   * First-wins is correct for "genesis", which is what makes arriving first
   * worth doing.
   */
  forgedPoolFirst?: { threadNftPolicy?: string; quantity: bigint };
}) {
  const txs = [
    ...(opts.forgedPoolFirst ? [{ tx_hash: FORGED_POOL_TX, block_time: 1_699_000_000 }] : []),
    { tx_hash: POOL_TX, block_time: 1_700_000_000 },
    { tx_hash: STAKE_TX, block_time: 1_700_086_400 },
  ];
  // `inputs` is how the builder closes out a position that was unstaked; none
  // of these scenarios unstakes, so both transactions spend nothing of ours.
  const poolOutputs = {
    inputs: [],
    outputs: [
      {
        output_index: 0,
        inline_datum: poolDatum(),
        amount: [
          { unit: TOKEN_UNIT, quantity: '1000000' },
          ...(opts.poolWithoutNft ? [] : [{ unit: POOL_NFT_UNIT, quantity: '1' }]),
        ],
      },
    ],
  };
  const forgedPoolOutputs = opts.forgedPoolFirst
    ? {
        inputs: [],
        outputs: [
          {
            output_index: 0,
            inline_datum: poolDatum(opts.forgedPoolFirst.threadNftPolicy ?? FORGER_POLICY),
            amount: [
              { unit: TOKEN_UNIT, quantity: String(opts.forgedPoolFirst.quantity) },
              // Minted under the forger's own policy, and named as theirs in
              // their own datum — self-consistent, and not this launch's.
              {
                unit:
                  (opts.forgedPoolFirst.threadNftPolicy ?? FORGER_POLICY) + threadNftAssetName('stakingPool', LAUNCH),
                quantity: '1',
              },
            ],
          },
        ],
      }
    : null;
  const stakeOutputs = {
    inputs: [],
    outputs: opts.positions.map((p, i) => ({
      output_index: i,
      inline_datum: positionDatum(p.vkh, p.claimed, 1_700_086_400_000n),
      amount: p.real > 0n ? [{ unit: TOKEN_UNIT, quantity: String(p.real) }] : [],
    })),
  };

  const byTx: Record<string, unknown> = { [POOL_TX]: poolOutputs, [STAKE_TX]: stakeOutputs };
  if (forgedPoolOutputs) byTx[FORGED_POOL_TX] = forgedPoolOutputs;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      let body: unknown;
      if (url.includes('/transactions')) {
        body = url.includes('page=1') ? txs : [];
      } else {
        const hash = url.split('/txs/')[1]?.split('/')[0] ?? '';
        body = byTx[hash] ?? { inputs: [], outputs: [] };
      }
      return { ok: true, json: async () => body } as never;
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchStakeHistory — a position weighs what it holds', () => {
  it('takes the staked amount from the output, not from the datum', async () => {
    mockChain({ positions: [{ vkh: HONEST, claimed: 500n, real: 500n }] });
    const history = await fetchStakeHistory(
      CONFIG as never,
      'addr_test1pool',
      LAUNCH,
      TOKEN_POLICY,
      TOKEN_NAME,
      THREAD_POLICY,
    );
    expect(history.events).toHaveLength(1);
    expect(history.events[0]?.stakedAmount).toBe(500n);
  });

  // The whole point. A position claiming a billion while holding one token is
  // free to create, and would otherwise take almost the entire pool.
  it('weighs an inflated claim by what the position really holds', async () => {
    mockChain({ positions: [{ vkh: LIAR, claimed: 1_000_000_000n, real: 1n }] });
    const history = await fetchStakeHistory(
      CONFIG as never,
      'addr_test1pool',
      LAUNCH,
      TOKEN_POLICY,
      TOKEN_NAME,
      THREAD_POLICY,
    );
    expect(history.events[0]?.stakedAmount).toBe(1n);
  });

  it('ignores a position holding no tokens at all', async () => {
    mockChain({ positions: [{ vkh: LIAR, claimed: 1_000_000_000n, real: 0n }] });
    const history = await fetchStakeHistory(
      CONFIG as never,
      'addr_test1pool',
      LAUNCH,
      TOKEN_POLICY,
      TOKEN_NAME,
      THREAD_POLICY,
    );
    expect(history.events).toHaveLength(0);
  });

  it('takes the genesis seed from the pool output holding the launch’s thread NFT', async () => {
    mockChain({ positions: [{ vkh: HONEST, claimed: 100n, real: 100n }] });
    const history = await fetchStakeHistory(
      CONFIG as never,
      'addr_test1pool',
      LAUNCH,
      TOKEN_POLICY,
      TOKEN_NAME,
      THREAD_POLICY,
    );
    expect(history.initialSeededAmount).toBe(1_000_000n);
  });

  it('leaves an honest position’s weight untouched alongside a lying one', async () => {
    mockChain({
      positions: [
        { vkh: HONEST, claimed: 100n, real: 100n },
        { vkh: LIAR, claimed: 9_999_999n, real: 2n },
      ],
    });
    const history = await fetchStakeHistory(
      CONFIG as never,
      'addr_test1pool',
      LAUNCH,
      TOKEN_POLICY,
      TOKEN_NAME,
      THREAD_POLICY,
    );
    const byStaker = Object.fromEntries(history.events.map((e) => [e.stakerVkh, e.stakedAmount]));
    expect(byStaker[HONEST]).toBe(100n);
    expect(byStaker[LIAR]).toBe(2n);
  });
});

// `initialSeededAmount` is what `dailyEmission` is derived from, so it decides
// every reward this launch ever mints. The datum fields the genesis read
// matches on are all the depositor's own writing, and first-wins is correct
// for "genesis" — which is precisely what makes arriving earlier worth doing.
describe('fetchStakeHistory — which output is the genesis seed', () => {
  it('refuses to read a genesis seed from a pool output with no thread NFT', async () => {
    mockChain({ positions: [{ vkh: HONEST, claimed: 100n, real: 100n }], poolWithoutNft: true });
    await expect(
      fetchStakeHistory(CONFIG as never, 'addr_test1pool', LAUNCH, TOKEN_POLICY, TOKEN_NAME, THREAD_POLICY),
    ).rejects.toThrow(/never seeded|no Pool/i);
  });

  it('ignores an inflated pool output minted under the forger’s own policy, even arriving first', async () => {
    // The forgery is internally consistent: it names its own policy in its own
    // datum and holds a token minted under it. Reading the policy from the
    // datum would accept it. Reading it from the caller does not.
    mockChain({
      positions: [{ vkh: HONEST, claimed: 100n, real: 100n }],
      forgedPoolFirst: { quantity: 999_000_000n },
    });
    const history = await fetchStakeHistory(
      CONFIG as never,
      'addr_test1pool',
      LAUNCH,
      TOKEN_POLICY,
      TOKEN_NAME,
      THREAD_POLICY,
    );
    expect(history.initialSeededAmount).toBe(1_000_000n);
  });

  it('would have taken the forgery had the policy come from the datum', async () => {
    // The same forged output, this time minted under the launch's REAL policy
    // — which nobody but the launch's genesis mint can do. It is taken, and
    // that is correct: this is the one thing the check actually rests on, so
    // the test says so out loud rather than leaving it implied.
    mockChain({
      positions: [{ vkh: HONEST, claimed: 100n, real: 100n }],
      forgedPoolFirst: { threadNftPolicy: THREAD_POLICY, quantity: 999_000_000n },
    });
    const history = await fetchStakeHistory(
      CONFIG as never,
      'addr_test1pool',
      LAUNCH,
      TOKEN_POLICY,
      TOKEN_NAME,
      THREAD_POLICY,
    );
    expect(history.initialSeededAmount).toBe(999_000_000n);
  });

  it('requires the thread-NFT policy rather than defaulting to something', async () => {
    mockChain({ positions: [{ vkh: HONEST, claimed: 100n, real: 100n }] });
    await expect(
      fetchStakeHistory(CONFIG as never, 'addr_test1pool', LAUNCH, TOKEN_POLICY, TOKEN_NAME, ''),
    ).rejects.toThrow(/threadNftPolicyId is required/);
  });
});

// ---------------------------------------------------------------------------
// Accrual stops when the budget does.
//
// `durationDays` sets the RATE. It never bounded the loop, and elapsed real
// time — which is what does bound it — keeps growing after the tokens run
// out. So a snapshot taken late promised more than the pool had ever held,
// and the pool cannot pay what it does not hold: the shortfall surfaces as
// claims that simply fail to build, first-come-first-served, naming neither
// the pool nor the reason.
//
// The figures below are pinned, not merely bounded. A budget-shaped
// assertion (`<= seed`) passes under any premature stop as well as the right
// one, so it could not tell a correct runway from a truncated one.
// ---------------------------------------------------------------------------
describe('computeRewardSnapshot — the budget is the stopping condition', () => {
  const SEED = 250_000_000n; // STAKING_ALLOC_PCT of a 1B supply
  const DURATION = 1095; // STAKING_DURATION_MIN_DAYS, 3 years
  const BONDING = 7; // STAKING_BONDING_PERIOD_DAYS
  const START = 1_700_000_000_000;
  const DAY = 86_400_000;
  // floor(250_000_000 / 1095). The remainder, 550, is what the final short
  // day pays out.
  const DAILY = 228_310n;

  /** One staker, in from the start and never out. */
  const soloStaker = (amount = 1_000_000n): StakeEvent[] => [
    { stakerVkh: HONEST, stakedAmount: amount, stakeTimestampMs: START, unstakeTimestampMs: null },
  ];

  const accruedAtDay = (day: number, events = soloStaker(), budget = SEED) =>
    computeRewardSnapshot(events, START, START + day * DAY, SEED, DURATION, BONDING, budget).get(HONEST) ?? 0n;

  it('pays a full day at the fixed rate once the staker is seasoned', () => {
    // Days 0-6 are inside the bonding period and pay nothing at all, so at
    // calendar day 8 exactly one day has been distributed.
    expect(accruedAtDay(8)).toBe(DAILY);
  });

  it('has paid out the entire budget, to the token, once the runway is done', () => {
    // 1095 full days from day 7, then one short day paying the 550 that
    // flooring left behind.
    expect(accruedAtDay(1102)).toBe(DAILY * 1095n);
    expect(accruedAtDay(1103)).toBe(SEED);
  });

  it('stops there and does not keep accruing against real time', () => {
    // Day 1200 was the measured failure: 272,373,830 against a pool that had
    // only ever held 250,000,000 — 1193 elapsed days each paying a full
    // DAILY, with nothing to stop them.
    expect(DAILY * 1193n).toBe(272_373_830n);
    expect(accruedAtDay(1200)).toBe(SEED);
    expect(accruedAtDay(3650)).toBe(SEED);
  });

  it('does not spend budget on days when nobody is seasoned', () => {
    // The same staker, arriving 500 days late. The runway is a budget, not a
    // deadline: the quiet stretch pushes the end date out rather than
    // retiring tokens nobody received.
    const late: StakeEvent[] = [
      { stakerVkh: HONEST, stakedAmount: 1_000_000n, stakeTimestampMs: START + 500 * DAY, unstakeTimestampMs: null },
    ];
    expect(accruedAtDay(1103, late)).toBe(DAILY * 596n);
    expect(accruedAtDay(1603, late)).toBe(SEED);
  });

  it('lets a top-up buy more days at the same rate, not a faster one', () => {
    // A top-up doubling the budget. The rate is derived from the genesis seed
    // and must not move; what moves is how long it lasts.
    const topped = SEED * 2n;
    expect(accruedAtDay(8, soloStaker(), topped)).toBe(DAILY);
    expect(accruedAtDay(1103, soloStaker(), topped)).toBe(DAILY * 1096n);
    expect(accruedAtDay(2198, soloStaker(), topped)).toBe(topped);
  });

  it('splits each day pro-rata and still never exceeds the budget', () => {
    const two: StakeEvent[] = [
      { stakerVkh: HONEST, stakedAmount: 750_000n, stakeTimestampMs: START, unstakeTimestampMs: null },
      { stakerVkh: LIAR, stakedAmount: 250_000n, stakeTimestampMs: START, unstakeTimestampMs: null },
    ];
    const totals = computeRewardSnapshot(two, START, START + 3650 * DAY, SEED, DURATION, BONDING, SEED);
    const sum = (totals.get(HONEST) ?? 0n) + (totals.get(LIAR) ?? 0n);
    expect(sum).toBeLessThanOrEqual(SEED);
    // Three quarters of the weight takes three quarters of the emission.
    expect((totals.get(HONEST) ?? 0n) / (totals.get(LIAR) ?? 1n)).toBe(3n);
  });
});
