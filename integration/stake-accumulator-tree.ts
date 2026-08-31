// ============================================================================
// Noctis Zone — the staking pool's position tree, off chain
// ============================================================================
// The twin of contracts/cardano/lib/noctis/stake_accumulator.ak. Every proof
// the pool validator will ever accept is built here, so the two must agree
// byte for byte: same tree shape, same slot derivation, same leaf. The shared
// ground truth in STAKE_GROUND_TRUTH is asserted on both sides.
//
// The shape is deliberately the cap accumulator's — same depth, same node
// hash, same empty leaf, same slot bits — and this module imports those rather
// than restating them. Only the leaf differs, because a position carries three
// fields where a cap total carries one:
//
//   amount — tokens staked
//   debt   — `amount * acc_reward_per_token / ACC_SCALE` as of the staker's
//            last interaction. What they are owed now is what that expression
//            comes to at the CURRENT accumulator, minus this.
//   since  — when the position last grew, for the unstake lock.
//
// `debt` is the field that decides a payout, which is why positions are not
// their own UTXOs: paying a UTXO to a script address runs no validator, so a
// datum anyone could author would be an authorization to mint themselves
// rewards. Behind a root, the only writer is the validator's own arithmetic.
// ============================================================================

import { blake2b } from '@noble/hashes/blake2.js';
import {
  bytesToHex,
  CAP_EMPTY_LEAF,
  CAP_TREE_DEPTH,
  type CapProofStep,
  capEmptySubtree,
  capSlotBit,
  hashCapNode,
  hexToBytes,
  recomputeCapRoot,
} from './cap-accumulator-tree.js';

/** 2^64 — what an 8-byte big-endian field holds. */
export const STAKE_FIELD_CEILING = 1n << 64n;

/** One staker's slot. Mirrors noctis/stake_accumulator's Position. */
export interface StakePosition {
  amount: bigint;
  debt: bigint;
  since: bigint;
}

/** The value at a slot nobody has staked through yet. */
export const NO_POSITION: StakePosition = { amount: 0n, debt: 0n, since: 0n };

export interface StakeEntry {
  key: Uint8Array;
  position: StakePosition;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function beBytes8(value: bigint, field: string): Uint8Array {
  if (value < 0n || value >= STAKE_FIELD_CEILING) {
    throw new Error(`A position's ${field} must fit in 8 unsigned bytes; got ${value}.`);
  }
  const out = new Uint8Array(8);
  let rest = value;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * A leaf: whose position it is, then all three fields big-endian over a fixed
 * 8 bytes each. The key is IN the leaf so a proof cannot be replayed for
 * anyone else, and the fixed widths stop two positions hashing alike through
 * length ambiguity.
 */
export function hashStakePosition(key: Uint8Array, pos: StakePosition): Uint8Array {
  return blake2b(
    concat(
      key,
      concat(beBytes8(pos.amount, 'amount'), concat(beBytes8(pos.debt, 'debt'), beBytes8(pos.since, 'since'))),
    ),
    { dkLen: 32 },
  );
}

/**
 * Canonical leaf: an empty position is ALWAYS the empty leaf. One
 * representation per value, so a staker who exits returns their slot to
 * exactly the state it started in and can stake again later.
 */
export function stakeLeafFor(key: Uint8Array, pos: StakePosition): Uint8Array {
  return pos.amount === 0n ? CAP_EMPTY_LEAF : hashStakePosition(key, pos);
}

/**
 * Every field in range, and an empty position genuinely empty.
 *
 * The second half is load-bearing rather than tidiness. `stakeLeafFor`
 * collapses any zero-amount position to the empty leaf, so `{amount: 0, debt:
 * 500}` would prove against a slot nobody has touched — and its payout,
 * `0 * acc / scale - debt`, is negative. The validator refuses it; this
 * refuses to build it.
 */
export function isCanonicalPosition(pos: StakePosition): boolean {
  const inRange = (v: bigint) => v >= 0n && v < STAKE_FIELD_CEILING;
  if (!inRange(pos.amount) || !inRange(pos.debt) || !inRange(pos.since)) return false;
  return pos.amount !== 0n || (pos.debt === 0n && pos.since === 0n);
}

function stakeSubtreeRoot(entries: StakeEntry[], h: number): Uint8Array {
  if (entries.length === 0) return capEmptySubtree(h);
  if (entries.length === 1) {
    const { key, position } = entries[0];
    let acc = stakeLeafFor(key, position);
    for (let level = 1; level <= h; level++) {
      const sibling = capEmptySubtree(level - 1);
      acc = capSlotBit(key, CAP_TREE_DEPTH - level) ? hashCapNode(sibling, acc) : hashCapNode(acc, sibling);
    }
    return acc;
  }
  const bitIndex = CAP_TREE_DEPTH - h;
  const ones = entries.filter((e) => capSlotBit(e.key, bitIndex));
  const zeros = entries.filter((e) => !capSlotBit(e.key, bitIndex));
  return hashCapNode(stakeSubtreeRoot(zeros, h - 1), stakeSubtreeRoot(ones, h - 1));
}

/**
 * Two keys whose slots collide would share one position — each spending the
 * other's stake — so this is a correctness fault, not a space problem. A
 * builder that silently produced such a tree would serve proofs no validator
 * can accept.
 */
function assertNoDuplicateSlots(entries: StakeEntry[]): void {
  const seen = new Map<string, string>();
  for (const e of entries) {
    const slot = bytesToHex(blake2b(e.key, { dkLen: 32 })).slice(0, 8);
    const key = bytesToHex(e.key);
    const prior = seen.get(slot);
    if (prior !== undefined && prior !== key) {
      throw new Error(
        `Stake keys ${prior} and ${key} collide at tree slot ${slot}. They would share one position; ` +
          'this tree cannot be built.',
      );
    }
    seen.set(slot, key);
  }
}

/** The root of a whole tree holding `entries` and nothing else. */
export function stakeRootOf(entries: StakeEntry[]): Uint8Array {
  assertNoDuplicateSlots(entries);
  return stakeSubtreeRoot(entries, CAP_TREE_DEPTH);
}

/**
 * `key`'s proof against `stakeRootOf(entries)`. `key` need not appear in
 * `entries` — an absent key proves its empty slot, which is what a first-time
 * staker does. There is no registration step.
 */
export function stakeProofFor(key: Uint8Array, entries: StakeEntry[]): CapProofStep[] {
  assertNoDuplicateSlots(entries);
  const steps: CapProofStep[] = [];
  let remaining = entries;
  for (let i = 0; i < CAP_TREE_DEPTH; i++) {
    const goesRight = capSlotBit(key, i);
    const ones = remaining.filter((e) => capSlotBit(e.key, i));
    const zeros = remaining.filter((e) => !capSlotBit(e.key, i));
    const [mine, theirs] = goesRight ? [ones, zeros] : [zeros, ones];
    // Built root-first and unshifted, so the list comes out bottom-up — the
    // order the on-chain fold consumes.
    steps.unshift({ sibling: stakeSubtreeRoot(theirs, CAP_TREE_DEPTH - i - 1), goesLeft: goesRight });
    remaining = mine;
  }
  return steps;
}

/** The root every launch's pool opens with: all slots empty, nothing staked. */
export const STAKE_EMPTY_ROOT: Uint8Array = stakeRootOf([]);

/**
 * The whole set of positions for one pool, and the proofs to move any of them.
 *
 * Rebuilt from chain rather than stored: every position that has ever existed
 * is derivable from the pool's own spend history, so this is a cache of public
 * data, not a ledger anyone has to be trusted with.
 */
export class StakeAccumulator {
  private readonly positions = new Map<string, StakePosition>();

  constructor(entries: StakeEntry[] = []) {
    for (const e of entries) this.set(e.key, e.position);
  }

  private entries(): StakeEntry[] {
    return [...this.positions.entries()].map(([hex, position]) => ({ key: hexToBytes(hex), position }));
  }

  get(key: Uint8Array): StakePosition {
    return this.positions.get(bytesToHex(key)) ?? NO_POSITION;
  }

  set(key: Uint8Array, position: StakePosition): void {
    if (!isCanonicalPosition(position)) {
      throw new Error(
        `Refusing to record a non-canonical position for ${bytesToHex(key)}: ` +
          `${JSON.stringify({ amount: `${position.amount}`, debt: `${position.debt}`, since: `${position.since}` })}. ` +
          'A zero amount must carry a zero debt and a zero timestamp.',
      );
    }
    // An emptied slot is REMOVED rather than stored as a zero, so the tree a
    // full exit produces is byte-for-byte the tree before the first stake.
    if (position.amount === 0n) this.positions.delete(bytesToHex(key));
    else this.positions.set(bytesToHex(key), position);
  }

  root(): Uint8Array {
    return stakeRootOf(this.entries());
  }

  proofFor(key: Uint8Array): CapProofStep[] {
    return stakeProofFor(key, this.entries());
  }

  /** Everyone with an open position, for a pool-wide view. */
  all(): Array<{ stakerVkhHex: string; position: StakePosition }> {
    return [...this.positions.entries()].map(([stakerVkhHex, position]) => ({ stakerVkhHex, position }));
  }

  get size(): number {
    return this.positions.size;
  }
}

/**
 * Cross-implementation ground truth, shared with
 * stake_accumulator.ak's own `ground_truth_for_the_offchain_tree_builder`.
 *
 * Every proof this module serves is verified by that validator, so the two
 * must agree byte for byte or no stake, claim or exit verifies. The same
 * literals are pinned on BOTH sides, which is what makes a silent drift
 * between them impossible.
 */
export const STAKE_GROUND_TRUTH = {
  position: { amount: 100n, debt: 5n, since: 1_700_000_000_000n } as StakePosition,
  key: 'aa',
  leaf: 'b4c3f70d252a7638af39026652ad34d10dfe98dd3e3de69928795bf292390916',
  emptyRoot: '441508bfe8c5ba1bf1c2c0f8af3e4243a66cb6a9c76988e76ee62b197ba7369a',
  oneEntryRoot: 'a803d95c5e6d771d5bd32b12af0a829ad67adb45f6c4f00bc82a90fb4b8bae20',
} as const;

export type { CapProofStep as StakeProofStep };
export { recomputeCapRoot as recomputeStakeRoot };
