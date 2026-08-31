// A reward leaf carries what THIS root pays, not a running total, because the
// pool records only who has claimed against the current root — one bit each —
// and not how much each has drawn.
//
// That makes the running "already paid" total an off-chain quantity, and
// foldClaimedRoot is how it is maintained: fold each published root against
// the nullifier the chain shows afterwards. These pin the property the whole
// scheme rests on — an unclaimed amount is not lost, it simply reappears,
// because nothing is added for a bit that was never set.

import { describe, expect, it } from 'vitest';

import { computeRewardSnapshot, foldClaimedRoot } from '../staking-reward-tree-builder.js';

const A = 'aa'.repeat(28);
const B = 'bb'.repeat(28);
const C = 'cc'.repeat(28);

const entries = [
  { stakerVkh: A, payoutAmount: 100n },
  { stakerVkh: B, payoutAmount: 250n },
  { stakerVkh: C, payoutAmount: 7n },
];

describe('foldClaimedRoot', () => {
  it('credits only the stakers whose bit is set', () => {
    // Bits 0 and 2 set, bit 1 clear: 1010_0000.
    const paid = foldClaimedRoot(entries, 'a0');
    expect(paid.get(A)).toBe(100n);
    expect(paid.get(C)).toBe(7n);
    expect(paid.has(B)).toBe(false);
  });

  it('credits nobody when nothing was claimed', () => {
    expect(foldClaimedRoot(entries, '00').size).toBe(0);
  });

  it('accumulates across roots rather than replacing', () => {
    const first = foldClaimedRoot(entries, '80'); // only A claimed
    const second = foldClaimedRoot(entries, '80', first); // A claimed again
    expect(second.get(A)).toBe(200n);
  });

  // The property that makes an unclaimed reward safe: it is not written off,
  // it is simply never added, so the next root's delta still includes it.
  it('leaves an unclaimed staker owed exactly as much as before', () => {
    const paid = foldClaimedRoot(entries, '80');
    expect(paid.get(B) ?? 0n).toBe(0n);
  });

  it('does not mutate the map it was given', () => {
    const before = new Map([[A, 5n]]);
    foldClaimedRoot(entries, 'ff', before);
    expect(before.get(A)).toBe(5n);
    expect(before.size).toBe(1);
  });

  // A nullifier that cannot address every entry is not this root's nullifier,
  // and silently treating the missing bits as unclaimed would pay those
  // stakers twice.
  it('refuses a nullifier too small for the entry list', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      stakerVkh: i.toString(16).padStart(2, '0').repeat(28),
      payoutAmount: 1n,
    }));
    expect(() => foldClaimedRoot(many, '00')).toThrow(/does not belong to this entry list/);
  });
});

// ---------------------------------------------------------------------------
// The ledger these folds maintain, end to end.
//
// foldClaimedRoot was fully tested and had no caller anywhere: nothing built
// the already-paid ledger, and nothing passed one in. Every daily root
// therefore paid each staker their FULL accrual to date, all over again — a
// staker who claimed on day 20 was offered the whole 20 days a second time on
// day 21, and again on day 22. The pool drains at a multiple of its emission
// rate and empties long before its runway.
//
// This pins the round trip the cron actually performs: accrue, subtract what
// has been drawn, publish, fold the claims back in, repeat.
// ---------------------------------------------------------------------------
describe('the already-paid ledger across consecutive roots', () => {
  const SEED = 250_000_000n;
  const DURATION = 1095;
  const BONDING = 7;
  const START = 1_700_000_000_000;
  const DAY = 86_400_000;
  const DAILY = 228_310n;
  const STAKER = A;

  const events = [{ stakerVkh: STAKER, stakedAmount: 1_000_000n, stakeTimestampMs: START, unstakeTimestampMs: null }];

  /** Exactly what buildStakingRewardSnapshot derives: accrual minus drawn. */
  const rootFor = (day: number, alreadyPaid: Map<string, bigint>) => {
    const totals = computeRewardSnapshot(events, START, START + day * DAY, SEED, DURATION, BONDING, SEED);
    return [...totals].map(([stakerVkh, cumulative]) => ({
      stakerVkh,
      payoutAmount: cumulative - (alreadyPaid.get(stakerVkh) ?? 0n),
    }));
  };

  it('pays the delta once the previous root has been claimed and folded', () => {
    // Day 20: thirteen distributing days, from day 7.
    const first = rootFor(20, new Map());
    expect(first[0]?.payoutAmount).toBe(DAILY * 13n);

    // The staker claims it — one leaf, bit 0 set.
    const paid = foldClaimedRoot(first, '80');
    expect(paid.get(STAKER)).toBe(DAILY * 13n);

    // Day 21 owes one more day, not fourteen.
    const second = rootFor(21, paid);
    expect(second[0]?.payoutAmount).toBe(DAILY);
  });

  it('over-pays by the whole accrual when the ledger is not maintained', () => {
    // The same day 21, with the ledger never folded — what the cron did.
    const unmaintained = rootFor(21, new Map());
    expect(unmaintained[0]?.payoutAmount).toBe(DAILY * 14n);
    // Claimed on both days, that is 27 days of emission drawn in 21.
    expect(DAILY * 13n + unmaintained[0]!.payoutAmount).toBe(DAILY * 27n);
  });

  it('carries an unclaimed root forward instead of losing or repeating it', () => {
    // Nothing claimed under the first root: the bit stays clear, nothing is
    // added, and day 21's root simply covers all fourteen days.
    const first = rootFor(20, new Map());
    const paid = foldClaimedRoot(first, '00');
    expect(paid.size).toBe(0);
    expect(rootFor(21, paid)[0]?.payoutAmount).toBe(DAILY * 14n);
  });

  it('keeps paying a staker who has unstaked but never claimed', () => {
    // Out on day 30, still owed every day they were in. Their entitlement
    // lives in the ledger and the accrual history, not in a live position.
    const left = [
      { stakerVkh: STAKER, stakedAmount: 1_000_000n, stakeTimestampMs: START, unstakeTimestampMs: START + 30 * DAY },
    ];
    const totals = computeRewardSnapshot(left, START, START + 400 * DAY, SEED, DURATION, BONDING, SEED);
    expect(totals.get(STAKER)).toBe(DAILY * 23n); // days 7..29
  });
});
