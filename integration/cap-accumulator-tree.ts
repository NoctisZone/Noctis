// ============================================================================
// Noctis Zone — cumulative wallet-cap accumulator (off-chain half)
// ============================================================================
// Mirrors contracts/cardano/lib/noctis/cap_accumulator.ak EXACTLY. That module
// is shared by BOTH curve validators, so this one file serves the linear curve and
// Cardano Launch alike — which is the whole reason the Aiken side was factored into a
// library rather than copied into each validator.
//
// WHAT THIS IS FOR
// The curve datum carries a single 32-byte root committing to every wallet's
// running total. A trade supplies its own total plus one Merkle proof, and the
// validator walks that path twice: once against the old root to establish the
// total is real, once with the updated leaf to derive the new root. So every
// caller — the buy submitter, the sell submitter, the batcher — needs a proof,
// and this is what produces them.
//
// Nothing here is a permission: the tree is derivable from public chain
// history by anyone, because every trade and its amount are public. Whoever
// serves proofs cannot censor a trade, only decline to save someone the work
// of rebuilding the tree themselves.
//
// A DIFFERENT TREE from dv-allocation-tree.ts. That one is a fixed roster of
// DarkVeil allocations, anchored once at DarkVeil close, with a
// variable-length proof. This one is a running total rewritten by every trade,
// at a FIXED depth of 32, where a wallet's slot is the leading 32 bits of
// blake2b_256(key) rather than a position assigned by the builder. Do not
// share code between them; they only look alike.
//
// VERIFIED, not assumed: the five values in CAP_GROUND_TRUTH below are
// asserted by this module's own tests AND by cap_accumulator.ak's
// `ground_truth_for_the_offchain_tree_builder` test, which the real Aiken
// compiler runs. Both sides are pinned to the same literals, so a change to
// the leaf layout, the node hash or the depth cannot pass on one side alone.
//
// blake2b_256 via @noble/hashes/blake2.js — the same real primitive
// dv-allocation-tree.ts and zk-cert-relayer.ts already use.
// ============================================================================

import { blake2b } from '@noble/hashes/blake2.js';

/** Every proof is exactly this long — see the Aiken module for why it is pinned. */
export const CAP_TREE_DEPTH = 32;

/** The value at a slot no wallet has taken tokens through yet. */
export const CAP_EMPTY_LEAF: Uint8Array = new Uint8Array(32);

/** What an 8-byte big-endian total can hold. */
export const CAP_TOTAL_CEILING = 1n << 64n;

export interface CapProofStep {
  sibling: Uint8Array;
  /** The SIBLING is the left child — i.e. the node being proved is the right one. */
  goesLeft: boolean;
}

export interface CapEntry {
  /** The wallet key the cap is tracked against — the same key that signs the trade. */
  key: Uint8Array;
  /** Tokens this key has taken from the curve so far. */
  total: bigint;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`Expected an even-length hex string, got "${hex}".`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function blake2b256(input: Uint8Array): Uint8Array {
  return blake2b(input, { dkLen: 32 });
}

/** Internal node hash: `blake2b_256(left || right)`. */
export function hashCapNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2b256(concat(left, right));
}

/**
 * A leaf: the wallet key, then its total big-endian over a fixed 8 bytes. The
 * key is IN the leaf so a proof cannot be replayed for anyone else, and the
 * fixed width is what stops two totals hashing alike through length ambiguity.
 */
export function hashCapLeaf(key: Uint8Array, total: bigint): Uint8Array {
  if (total < 0n || total >= CAP_TOTAL_CEILING) {
    throw new Error(`A committed total must fit in 8 unsigned bytes; got ${total}.`);
  }
  const encoded = new Uint8Array(8);
  let rest = total;
  for (let i = 7; i >= 0; i--) {
    encoded[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return blake2b256(concat(key, encoded));
}

/**
 * Canonical leaf for a total: zero is ALWAYS the empty leaf, never
 * `hashCapLeaf(key, 0)`. One representation per value, so a wallet that sells
 * everything back returns its slot to exactly the state it started in.
 */
export function capLeafFor(key: Uint8Array, total: bigint): Uint8Array {
  return total === 0n ? CAP_EMPTY_LEAF : hashCapLeaf(key, total);
}

/** Bit `i` of a key's slot, MSB-first — `i = 0` is the choice made at the root. */
export function capSlotBit(key: Uint8Array, i: number): boolean {
  const slot = blake2b256(key);
  return ((slot[i >> 3] >> (7 - (i & 7))) & 1) === 1;
}

const emptySubtreeCache: Uint8Array[] = [CAP_EMPTY_LEAF];

/** Root of an all-empty subtree of height `h`. */
export function capEmptySubtree(h: number): Uint8Array {
  for (let i = emptySubtreeCache.length; i <= h; i++) {
    emptySubtreeCache[i] = hashCapNode(emptySubtreeCache[i - 1], emptySubtreeCache[i - 1]);
  }
  return emptySubtreeCache[h];
}

/**
 * Root of a subtree of height `h` holding exactly `entries`, where every
 * entry's slot agrees on the `CAP_TREE_DEPTH - h` bits above it.
 */
function capSubtreeRoot(entries: CapEntry[], h: number): Uint8Array {
  if (entries.length === 0) return capEmptySubtree(h);
  if (entries.length === 1) {
    const { key, total } = entries[0];
    let acc = capLeafFor(key, total);
    for (let level = 1; level <= h; level++) {
      const sibling = capEmptySubtree(level - 1);
      acc = capSlotBit(key, CAP_TREE_DEPTH - level) ? hashCapNode(sibling, acc) : hashCapNode(acc, sibling);
    }
    return acc;
  }
  const bitIndex = CAP_TREE_DEPTH - h;
  const ones = entries.filter((e) => capSlotBit(e.key, bitIndex));
  const zeros = entries.filter((e) => !capSlotBit(e.key, bitIndex));
  return hashCapNode(capSubtreeRoot(zeros, h - 1), capSubtreeRoot(ones, h - 1));
}

/** The root of a whole tree holding `entries` and nothing else. */
export function capRootOf(entries: CapEntry[]): Uint8Array {
  assertNoDuplicateSlots(entries);
  return capSubtreeRoot(entries, CAP_TREE_DEPTH);
}

/**
 * `key`'s proof against `capRootOf(entries)`. `key` need not appear in
 * `entries` — an absent key proves its empty slot, which is exactly what a
 * wallet that has never traded does. There is no allowlist and no
 * registration step.
 */
export function capProofFor(key: Uint8Array, entries: CapEntry[]): CapProofStep[] {
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
    steps.unshift({ sibling: capSubtreeRoot(theirs, CAP_TREE_DEPTH - i - 1), goesLeft: goesRight });
    remaining = mine;
  }
  return steps;
}

/** Walks a path bottom-up and returns the root it implies. */
export function recomputeCapRoot(leaf: Uint8Array, proof: CapProofStep[]): Uint8Array {
  let acc = leaf;
  for (const step of proof) {
    acc = step.goesLeft ? hashCapNode(step.sibling, acc) : hashCapNode(acc, step.sibling);
  }
  return acc;
}

/**
 * Two keys whose slots collide share one running total — they would spend each
 * other's headroom — so this is a correctness fault, not a space problem. At
 * depth 32 it is a ~0.01% event across a thousand wallets, but "unlikely" is
 * not "handled", and a builder that silently produced a tree with two entries
 * at one slot would serve proofs that no validator can accept.
 */
function assertNoDuplicateSlots(entries: CapEntry[]): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const slot = bytesToHex(blake2b256(entry.key)).slice(0, CAP_TREE_DEPTH / 4);
    const keyHex = bytesToHex(entry.key);
    const previous = seen.get(slot);
    if (previous !== undefined && previous !== keyHex) {
      throw new Error(
        `Cap accumulator slot collision: keys ${previous} and ${keyHex} both land in slot ${slot}. ` +
          `Their totals cannot be tracked separately at depth ${CAP_TREE_DEPTH}.`,
      );
    }
    if (previous === keyHex) {
      throw new Error(`Cap accumulator has two entries for key ${keyHex}; totals must be summed before building.`);
    }
    seen.set(slot, keyHex);
  }
}

/** The root every launch's genesis datum starts at: all 2^32 slots empty. */
export const CAP_EMPTY_ROOT: Uint8Array = capRootOf([]);

/**
 * A mutable view of the tree, for whoever is serving proofs — the batcher
 * between orders, or a submitter walking chain history forward.
 *
 * Deliberately rebuilds the root on every read rather than caching internal
 * nodes: correctness first, and a launch's participant count is in the
 * hundreds, not the millions. Revisit if that stops being true.
 */
export class CapAccumulator {
  private readonly totals = new Map<string, bigint>();

  constructor(entries: CapEntry[] = []) {
    for (const entry of entries) this.set(entry.key, entry.total);
  }

  /**
   * Every non-zero total, as the constructor takes them.
   *
   * Public so a caller can COPY an accumulator rather than mutate one. The
   * batch planner needs that: it walks a sequence of hypothetical trades to
   * decide which fit, and a plan that is discarded must leave the real state
   * exactly as it found it.
   */
  entries(): CapEntry[] {
    return Array.from(this.totals, ([hex, total]) => ({ key: hexToBytes(hex), total })).filter((e) => e.total > 0n);
  }

  /** What `key` has taken from the curve so far — zero for a wallet that has never traded. */
  totalOf(key: Uint8Array): bigint {
    return this.totals.get(bytesToHex(key)) ?? 0n;
  }

  set(key: Uint8Array, total: bigint): void {
    if (total < 0n || total >= CAP_TOTAL_CEILING) {
      throw new Error(`A committed total must fit in 8 unsigned bytes; got ${total}.`);
    }
    this.totals.set(bytesToHex(key), total);
  }

  /**
   * Applies a trade: `delta` positive for a buy, negative for a sell. A sell
   * FLOORS at zero rather than going negative, because a seller may hold
   * tokens they never bought from this curve. Returns the new total.
   */
  apply(key: Uint8Array, delta: bigint): bigint {
    const before = this.totalOf(key);
    const after = delta < 0n && -delta > before ? 0n : before + delta;
    this.set(key, after);
    return after;
  }

  get root(): Uint8Array {
    return capRootOf(this.entries());
  }

  /** The proof `key` must supply with its next trade, against the CURRENT root. */
  proofFor(key: Uint8Array): CapProofStep[] {
    return capProofFor(key, this.entries());
  }
}

/**
 * The values both implementations are pinned to. Asserted here and, as the
 * same literals, by cap_accumulator.ak's own compiler-run test.
 */
export const CAP_GROUND_TRUTH = {
  leafAa100: 'd918ee9e60a917366d5fcb9a51106951125e21198515649a6c68bcab7ec275b7',
  leafBb200: '15a32591eeb6865ef0b14a0679458e06912d856974fdc9655b124138f4446bba',
  emptyRoot: '441508bfe8c5ba1bf1c2c0f8af3e4243a66cb6a9c76988e76ee62b197ba7369a',
  rootAa100: 'e8f1be97fed35a91795869599ceea6dbd72d6ded7017eaf396cb8084fc6ac29e',
  rootAa100Bb200: 'fc22d119891d02ced6418691c2c3d2b0511cb1df57c56cef4065a2c18f56182f',
} as const;

/**
 * Everything a trade has to put in its redeemer, plus the root its continuing
 * datum must carry. Derived in one place because all five call sites — both
 * tiers' buys, both tiers' sells, and the DarkVeil claim — need exactly this
 * and would otherwise each re-derive it slightly differently.
 *
 * Throws if `capState` does not derive the root the curve datum currently
 * carries. That is not a formality: a stale tree produces a proof the
 * validator rejects, and catching it here gives a readable reason instead of
 * an opaque script failure.
 *
 * `delta` is positive for a buy or a DarkVeil claim, negative for a sell.
 */
export function buildCapTradeFields(
  capState: CapAccumulator,
  datumCapRootHex: string,
  keyHashHex: string,
  delta: bigint,
): { committedBefore: bigint; proof: CapProofStep[]; nextRootHex: string; committedAfter: bigint } {
  const derived = bytesToHex(capState.root);
  if (derived !== datumCapRootHex) {
    throw new Error(
      `Cap accumulator is stale: it derives ${derived} but the curve datum carries ${datumCapRootHex}. ` +
        `Rebuild it from the launch's on-chain trade history before submitting.`,
    );
  }
  const key = hexToBytes(keyHashHex);
  const committedBefore = capState.totalOf(key);
  const proof = capState.proofFor(key);
  // Floors at zero on a sell: a seller may hold tokens they never bought here.
  const committedAfter = delta < 0n && -delta > committedBefore ? 0n : committedBefore + delta;
  return {
    committedBefore,
    proof,
    committedAfter,
    // The same second walk the validator performs: one path, updated leaf.
    nextRootHex: bytesToHex(recomputeCapRoot(capLeafFor(key, committedAfter), proof)),
  };
}

/**
 * Rebuilds an accumulator from a caller-supplied list of `{ keyHashHex,
 * total }` — the shape a CLI or service passes around as JSON.
 *
 * There is deliberately no "read it off chain for me" convenience here. The
 * tree is derivable from public history, but doing that correctly means
 * decoding every trade redeemer a launch has ever had, and a rebuild that is
 * subtly wrong would produce proofs that fail with nothing to point at. The
 * guard is `buildCapTradeFields`, which refuses to build a transaction unless
 * the accumulator it is handed derives the root the curve datum actually
 * carries — so a wrong or stale state is a clear local error, never a bad
 * transaction.
 */
export function capAccumulatorFromHex(
  entries: readonly { keyHashHex: string; total: bigint | string }[],
): CapAccumulator {
  return new CapAccumulator(entries.map((e) => ({ key: hexToBytes(e.keyHashHex), total: BigInt(e.total) })));
}
