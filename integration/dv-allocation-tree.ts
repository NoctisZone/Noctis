// ============================================================================
// Noctis Zone — Cardano Launch DarkVeil Allocation Merkle Tree
// ============================================================================
// Mirrors contracts/cardano/validators/bonding_curve_tier_b.ak's
// hash_dv_leaf/hash_dv_node/verify_dv_merkle_proof EXACTLY — this is the
// tree ClaimDarkVeilTokens verifies a buyer's private allocation against
// (a DIFFERENT tree, different hash, different depth convention from
// packages/zk-proofs/src/eligibility-gate.ts's registration allowlist
// tree, which uses Compact's persistentHash with fixed TREE_DEPTH=20
// padding — this one uses blake2b_256 with no fixed depth, since Aiken's
// verify_dv_merkle_proof walks a variable-length list.foldl proof, not a
// fixed-loop-count ZK circuit).
//
// An earlier pass built the on-chain half (AnchorDvAllocationRoot redeemer +
// dv_settled datum field) — this file is the off-chain half: computing the
// SAME root the governor anchors on-chain, and each buyer's own proof
// against it, so the gap ("no endpoint serves a buyer their own proof")
// can actually be closed. Both halves must produce byte-identical results
// or ClaimDarkVeilTokens's on-chain verify_dv_merkle_proof will never
// accept a real proof this code generates.
//
// VERIFIED, not assumed (2026-07-19): hashDvLeaf/hashDvNode's exact byte
// construction was cross-checked against real ground truth extracted from
// a temporary `trace`-based Aiken test run through the real compiler
// (`hash_dv_leaf(#"aa", 100, #"01")` / `hash_dv_leaf(#"bb", 200, #"02")` /
// `hash_dv_node(leaf0, leaf1)`), not reasoned about from reading the
// source alone — this Node-side computation reproduced the exact same
// 32-byte blake2b_256 outputs, byte-for-byte. See git history for the
// verification commands used (removed from the .ak file after use — it
// was a temporary test, not part of the real suite).
//
// blake2b_256 via @noble/hashes/blake2.js — the same real, already-used
// primitive as zk-cert-relayer.ts (verified there against the installed
// package before use; reused here, not re-verified from scratch, since
// it's the identical import).
// ============================================================================

import { blake2b } from '@noble/hashes/blake2.js';

export interface MerkleProofStep {
  sibling: Uint8Array;
  goesLeft: boolean;
}

export interface DvAllocationEntry {
  /** Buyer's Cardano VerificationKeyHash — must match the `buyer_key_hash` they'll later sign ClaimDarkVeilTokens with. */
  vkh: Uint8Array;
  dvAmount: bigint;
  /** Per-registrant salt, chosen off-chain (same nonce-like role as elsewhere in this codebase) — prevents brute-forcing a leaf from a guessed (vkh, dvAmount) pair alone. */
  salt: Uint8Array;
}

export interface DvAllocationTree {
  /** The 32-byte value to submit as AnchorDvAllocationRoot's dv_allocation_root. */
  root: Uint8Array;
  /** Real proof length varies with tree size — no fixed-depth padding, matching bonding_curve_tier_b.ak's variable-length list.foldl verifier. */
  getProof(index: number): MerkleProofStep[];
}

function toBigEndian16(n: bigint): Uint8Array {
  if (n < 0n || n > 2n ** 128n - 1n) {
    throw new Error(`toBigEndian16: ${n} does not fit in 16 bytes`);
  }
  const out = new Uint8Array(16);
  let v = n;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * bonding_curve_tier_b.ak — `hash_dv_leaf`.
 * `vkh || dv_amount_16be || leaf_index_4be || salt`, blake2b_256.
 *
 * `leafIndex` is the entry's own position in the tree, and is what selects
 * its bit in the curve's `claimed_bits` nullifier. Hashing it INTO the leaf
 * is what stops a claimant pointing a genuine allocation at somebody else's
 * still-clear bit — the index and the allocation stand or fall together.
 */
export function hashDvLeaf(vkh: Uint8Array, dvAmount: bigint, leafIndex: number, salt: Uint8Array): Uint8Array {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > 0xff_ff_ff_ff) {
    throw new Error(`hashDvLeaf: leafIndex must be a uint32, got ${leafIndex}`);
  }
  return blake2b(concatBytes(vkh, toBigEndian16(dvAmount), toBigEndian4(leafIndex), salt), {
    dkLen: 32,
  });
}

/** 4-byte big-endian, matching Aiken's `from_int_big_endian(n, 4)`. */
function toBigEndian4(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

/** bonding_curve_tier_b.ak:274 — `hash_dv_node`. `left || right`, blake2b_256 — NO domain-separation prefix (unlike the Compact allowlist tree's node hash), matched exactly as coded on-chain. */
export function hashDvNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2b(concatBytes(left, right), { dkLen: 32 });
}

/**
 * Builds a plain, variable-depth binary Merkle tree over real DarkVeil
 * allocation leaves — one entry per buyer who actually purchased during
 * DarkVeil (governor computes this list off-chain from
 * eligibility_gate.compact's dvTokensPurchased map, per the
 * documented trust boundary — this function only does the tree math, it
 * does not itself establish the Cardano-wallet<->Midnight-identity
 * binding each entry's `vkh` represents).
 *
 * No fixed-depth padding (unlike buildAllowlistTree) — an odd node at any
 * level is promoted by self-pairing (Bitcoin-style: hashDvNode(node,
 * node)), avoiding the need for an arbitrary "empty leaf" placeholder
 * value. Self-consistent: the same self-pairing convention is used by
 * both tree construction and proof generation below, and
 * bonding_curve_tier_b.ak's on-chain verifier is agnostic to the specific
 * off-chain construction — it only checks that a supplied (leaf, proof)
 * folds to the anchored root.
 */
export function buildDvAllocationTree(entries: DvAllocationEntry[]): DvAllocationTree {
  if (entries.length === 0) {
    throw new Error('buildDvAllocationTree: at least one entry is required');
  }

  // Index is position, so the tree's own ordering IS the bit assignment. The
  // caller must keep this order stable between building the tree and telling
  // each registrant which index to claim with.
  const leaves = entries.map((e, i) => hashDvLeaf(e.vkh, e.dvAmount, i, e.salt));

  const levels: Uint8Array[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashDvNode(current[i], current[i + 1]));
      } else {
        // Odd one out at this level — self-pair rather than pad.
        next.push(hashDvNode(current[i], current[i]));
      }
    }
    levels.push(next);
    current = next;
  }
  const root = current[0];

  function getProof(index: number): MerkleProofStep[] {
    if (index < 0 || index >= entries.length) {
      throw new Error(`getProof: index ${index} out of range (0..${entries.length - 1})`);
    }
    const proof: MerkleProofStep[] = [];
    let idx = index;
    for (let d = 0; d < levels.length - 1; d++) {
      const level = levels[d];
      const isRightChild = idx % 2 === 1;
      const siblingIdx = isRightChild ? idx - 1 : Math.min(idx + 1, level.length - 1);
      proof.push({ sibling: level[siblingIdx], goesLeft: isRightChild });
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return { root, getProof };
}

/**
 * Re-implements bonding_curve_tier_b.ak's `verify_dv_merkle_proof` in TS —
 * used to self-check a built tree/proof before ever anchoring or serving
 * it, catching a construction bug locally instead of discovering it only
 * when a real on-chain claim fails.
 */
export function verifyDvMerkleProof(root: Uint8Array, leaf: Uint8Array, proof: MerkleProofStep[]): boolean {
  let computed = leaf;
  for (const step of proof) {
    computed = step.goesLeft ? hashDvNode(step.sibling, computed) : hashDvNode(computed, step.sibling);
  }
  return computed.length === root.length && computed.every((b, i) => b === root[i]);
}
