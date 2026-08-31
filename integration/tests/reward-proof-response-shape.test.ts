// The reward-proof route's response shape, pinned against the names its
// consumers actually read.
//
// This exists because nothing did. The staking page read `cumulativeAmount`
// from a response that has never contained it, and a missing key in
// JavaScript is `undefined` rather than an error — so every wallet's rewards
// column read a confident zero, and a wallet that had unstaked without
// claiming dropped out of its own portfolio, because the listing rule is
// "positions OR rewards" and the rewards half was always false.
//
// Two consumers read this route and they must agree on the same names:
//   - integration/widget/staking-widget-entry.ts's claimRewards (the panel
//     that actually builds the claim)
//   - themes/noctis/assets/js/staking-page.js's fetchClaimable (/staking/)
// The theme lives in its own repository, so this half pins what the producer
// emits; the PHP route validates the same key set before returning it, so a
// drift surfaces as an error on the boundary rather than as a zero.

import { describe, expect, it } from 'vitest';
import { getRewardProof } from '../staking-reward-tree-builder.js';

const A = '11'.repeat(28);
const B = '22'.repeat(28);
const ENTRIES = [
  { stakerVkh: A, payoutAmount: 500n },
  { stakerVkh: B, payoutAmount: 250n },
];

describe('the reward-proof response shape', () => {
  it('names the payout `payoutAmount`, and carries no cumulative field', () => {
    const proof = getRewardProof(ENTRIES, A);
    expect(proof).not.toBeNull();
    // Pinned by value, not by shape: asserting "has some amount field" would
    // have passed against the broken reader too.
    expect(proof?.payoutAmount).toBe(500n);
    expect(Object.keys(proof ?? {}).sort()).toEqual(['leafIndex', 'payoutAmount', 'proof']);
    expect('cumulativeAmount' in (proof ?? {})).toBe(false);
  });

  it('gives each staker the leaf index that is their own bit in the nullifier', () => {
    // The index IS the claim's bit, so a wrong one aims a valid proof at
    // somebody else's bit and the claim is refused on chain.
    expect(getRewardProof(ENTRIES, A)?.leafIndex).toBe(0);
    expect(getRewardProof(ENTRIES, B)?.leafIndex).toBe(1);
  });

  it('pays what THIS root pays, not a running total', () => {
    // A second root paying the same staker again returns that root's own
    // amount. A consumer that treated the figure as cumulative would show a
    // shrinking balance every time a staker claimed and the next root paid
    // them less than the last.
    const second = getRewardProof([{ stakerVkh: A, payoutAmount: 12n }], A);
    expect(second?.payoutAmount).toBe(12n);
  });

  it('returns null for a wallet with no entry, rather than a zero-value leaf', () => {
    // The contract requires a positive payout, so a zero leaf would be
    // unclaimable and would still consume a bit. Null is what the route turns
    // into its 404.
    expect(getRewardProof(ENTRIES, '33'.repeat(28))).toBeNull();
  });
});
