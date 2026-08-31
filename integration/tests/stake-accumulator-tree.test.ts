// The off-chain half of the staking pool's position tree. Every proof the
// validator will ever accept is built here, so these pin the agreement between
// the two implementations, and the behaviour the pool's arithmetic depends on.

import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, recomputeCapRoot } from '../cap-accumulator-tree.js';
import {
  STAKE_GROUND_TRUTH as GT,
  hashStakePosition,
  isCanonicalPosition,
  NO_POSITION,
  STAKE_EMPTY_ROOT,
  StakeAccumulator,
  type StakePosition,
  stakeLeafFor,
  stakeProofFor,
  stakeRootOf,
} from '../stake-accumulator-tree.js';

const alice = hexToBytes('de');
const bob = hexToBytes('df');
const pos = (amount: bigint, debt: bigint, since: bigint): StakePosition => ({ amount, debt, since });

describe('agreement with the validator', () => {
  it('produces the leaf and roots stake_accumulator.ak pins', () => {
    // The same three literals are asserted in the .ak module's own
    // ground_truth test. Either side drifting fails on both.
    expect(bytesToHex(hashStakePosition(hexToBytes(GT.key), GT.position))).toBe(GT.leaf);
    expect(bytesToHex(STAKE_EMPTY_ROOT)).toBe(GT.emptyRoot);
    expect(bytesToHex(stakeRootOf([{ key: hexToBytes(GT.key), position: GT.position }]))).toBe(GT.oneEntryRoot);
  });

  it('builds proofs that reach the root they were built against', () => {
    const entries = [
      { key: alice, position: pos(100n, 5n, 7n) },
      { key: bob, position: pos(250n, 9n, 11n) },
    ];
    const root = stakeRootOf(entries);
    for (const { key, position } of entries) {
      expect(bytesToHex(recomputeCapRoot(stakeLeafFor(key, position), stakeProofFor(key, entries)))).toBe(
        bytesToHex(root),
      );
    }
  });

  it('lets a staker who has never staked prove an empty slot', () => {
    // What makes the pool open to anyone with no registration step.
    const entries = [{ key: alice, position: pos(100n, 5n, 7n) }];
    expect(bytesToHex(recomputeCapRoot(stakeLeafFor(bob, NO_POSITION), stakeProofFor(bob, entries)))).toBe(
      bytesToHex(stakeRootOf(entries)),
    );
  });
});

describe('the leaf', () => {
  it('separates every field, and every holder', () => {
    const base = pos(100n, 5n, 7n);
    const leaf = (k: Uint8Array, p: StakePosition) => bytesToHex(stakeLeafFor(k, p));
    expect(leaf(alice, base)).not.toBe(leaf(alice, pos(101n, 5n, 7n)));
    expect(leaf(alice, base)).not.toBe(leaf(alice, pos(100n, 6n, 7n)));
    expect(leaf(alice, base)).not.toBe(leaf(alice, pos(100n, 5n, 8n)));
    expect(leaf(alice, base)).not.toBe(leaf(bob, base));
  });

  it('gives an empty position one representation, whoever holds it', () => {
    expect(bytesToHex(stakeLeafFor(alice, NO_POSITION))).toBe(bytesToHex(stakeLeafFor(bob, NO_POSITION)));
  });
});

describe('canonicality', () => {
  // A zero-amount position carrying a debt hashes to the empty leaf, so it
  // proves against a slot nobody has touched — and its payout,
  // `0 * acc / scale - debt`, is negative.
  it('refuses a zero amount that carries a debt or a timestamp', () => {
    expect(isCanonicalPosition(pos(0n, 500n, 0n))).toBe(false);
    expect(isCanonicalPosition(pos(0n, 0n, 1_700_000_000_000n))).toBe(false);
    expect(isCanonicalPosition(NO_POSITION)).toBe(true);
  });

  it('refuses negative fields before they can abort an encoding', () => {
    expect(isCanonicalPosition(pos(-1n, 0n, 0n))).toBe(false);
    expect(isCanonicalPosition(pos(100n, -1n, 0n))).toBe(false);
    expect(isCanonicalPosition(pos(100n, 0n, -1n))).toBe(false);
  });

  it('is enforced when recording, not merely reported', () => {
    const acc = new StakeAccumulator();
    expect(() => acc.set(alice, pos(0n, 500n, 0n))).toThrow(/non-canonical/);
  });
});

describe('StakeAccumulator', () => {
  it('returns an empty position for a key it has never seen', () => {
    expect(new StakeAccumulator().get(alice)).toEqual(NO_POSITION);
  });

  it('returns a slot to its original state when a staker exits', () => {
    // The property that lets a staker re-enter later: a full exit is
    // byte-for-byte the tree before the first stake, not a zero entry.
    const acc = new StakeAccumulator();
    const before = bytesToHex(acc.root());
    acc.set(alice, pos(100n, 0n, 7n));
    expect(bytesToHex(acc.root())).not.toBe(before);
    acc.set(alice, NO_POSITION);
    expect(bytesToHex(acc.root())).toBe(before);
    expect(acc.size).toBe(0);
  });

  it('keeps two stakers independent under one root', () => {
    const acc = new StakeAccumulator();
    acc.set(alice, pos(100n, 0n, 7n));
    acc.set(bob, pos(250n, 0n, 9n));
    expect(acc.get(alice)).toEqual(pos(100n, 0n, 7n));
    // Alice's proof still verifies after Bob moved.
    expect(bytesToHex(recomputeCapRoot(stakeLeafFor(alice, acc.get(alice)), acc.proofFor(alice)))).toBe(
      bytesToHex(acc.root()),
    );
  });

  it('lists every open position, for a pool-wide view', () => {
    const acc = new StakeAccumulator();
    acc.set(alice, pos(100n, 0n, 7n));
    acc.set(bob, pos(250n, 0n, 9n));
    const all = acc.all();
    expect(all).toHaveLength(2);
    expect(all.reduce((sum, e) => sum + e.position.amount, 0n)).toBe(350n);
  });
});
