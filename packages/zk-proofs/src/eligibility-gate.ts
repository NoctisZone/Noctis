// Mirrors the `pure circuit` helpers in contracts/midnight/eligibility_gate.compact.
// Note the domain strings differ from darkveil.ts's — each PSM uses its own
// domain separation, deliberately, so a key derived for one PSM never
// collides with another.

import {
  bytes32Type,
  hashDomainKey,
  hashDomainKeyScoped,
  pad32,
  persistentHash,
  structType,
  uintType,
} from './compact-types.js';

/** eligibility_gate.compact:127 — `deriveUserPublicKey`. */
export function deriveUserPublicKey(secretKeyBytes: Uint8Array, launchId: Uint8Array): Uint8Array {
  return hashDomainKeyScoped('noctis:user:pk:v1', secretKeyBytes, launchId);
}

/** eligibility_gate.compact:137 — `deriveGovernorKey`. */
export function deriveGovernorKey(secretKeyBytes: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:governor:pk:v1', secretKeyBytes);
}

/**
 * Design requirement: `verifyAllowlist`'s leaf is no longer a free
 * witness — it's derived in-circuit as
 * `persistentHash<Vector<2,Bytes<32>>>([pad(32,"noctis:allowlist:leaf:v1"),
 * caller])`, binding allowlist membership to the caller's own identity. The
 * off-chain tree MUST be built with each leaf as `hashAllowlistLeaf(pubKey)`
 * for that registrant's real derived public key — an arbitrary opaque leaf
 * value (the pre-fix convention) will never match what the circuit
 * recomputes. Same shape as `hashDomainKey`, reused directly since the
 * on-chain formula is identical.
 */
export function hashAllowlistLeaf(callerPubKey: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:allowlist:leaf:v1', callerPubKey);
}

/** eligibility_gate.compact:147 — `isKeyZero`. A key is "zero" iff every byte is 0x00. */
export function isKeyZero(keyBytes: Uint8Array): boolean {
  return keyBytes.every((b) => b === 0);
}

interface RegistrationCommitInput {
  userKey: Uint8Array;
  launchId: Uint8Array;
  bondAmount: bigint;
}

const REGISTRATION_COMMIT_DOMAIN = 'noctis:dv:reg:commit:v1';

/**
 * Field order and domain match `computeRegistrationCommit` in BOTH
 * eligibility_gate.compact (Cardano Launch) and bonding_curve.compact (Midnight Launch),
 * which carry identical copies.
 *
 * There is deliberately no `nonce`: a prover-chosen one made the commitment
 * non-deterministic per registrant, and this value IS the double-registration
 * nullifier, so it has to be the same 32 bytes every time a given identity
 * registers for a given launch at a given bond.
 */
const registrationCommitInputType = structType<RegistrationCommitInput & { domain: Uint8Array }>([
  ['domain', bytes32Type],
  ['userKey', bytes32Type],
  ['launchId', bytes32Type],
  ['bondAmount', uintType(128)],
]);

/** `computeRegistrationCommit` — the value inserted into `registrationNullifiers`. */
export function computeRegistrationCommit(input: RegistrationCommitInput): Uint8Array {
  return persistentHash(registrationCommitInputType, {
    domain: pad32(REGISTRATION_COMMIT_DOMAIN),
    ...input,
  });
}

export interface BuyCommitInput {
  buyerKey: Uint8Array;
  launchId: Uint8Array;
  tokenAmount: bigint;
  pricePerToken: bigint;
  nonce: Uint8Array;
}

const BUY_COMMIT_DOMAIN = 'noctis:dv:buy:commit:v1';

/**
 * Field order and domain match `computeBuyCommit` in BOTH
 * eligibility_gate.compact (Cardano Launch) and bonding_curve.compact (Midnight Launch).
 *
 * Unlike the registration commit above this one DOES carry a nonce, and must:
 * the whole point of the commit/reveal pair is that the committed amount stays
 * private until reveal, and every input other than the nonce is either public
 * or guessable from a small range.
 */
const buyCommitInputType = structType<BuyCommitInput & { domain: Uint8Array }>([
  ['domain', bytes32Type],
  ['buyerKey', bytes32Type],
  ['launchId', bytes32Type],
  ['tokenAmount', uintType(128)],
  ['pricePerToken', uintType(128)],
  ['nonce', bytes32Type],
]);

/**
 * `computeBuyCommit` — the value `submitBuyCommit` stores and
 * `revealBuyCommit` recomputes from the caller's own identity and nonce.
 *
 * `submitBuyCommit` accepts whatever it is handed; it is the REVEAL that binds
 * the commitment to its owner. So a commitment built from the wrong identity,
 * launch, amount, price or nonce submits perfectly happily and then fails at
 * reveal with "Not the commitment owner" — after the buying window has closed,
 * with the bond already locked. Build it with this function and the same values
 * the reveal will use.
 */
export function computeBuyCommit(input: BuyCommitInput): Uint8Array {
  return persistentHash(buyCommitInputType, {
    domain: pad32(BUY_COMMIT_DOMAIN),
    ...input,
  });
}

// ============================================================================
// Allowlist Merkle tree (2026-07-09)
// ============================================================================
//
// Mirrors eligibility_gate.compact's `verifyAllowlist` circuit exactly —
// see that circuit's comment for the full design rationale. Two padding
// conventions, both must match the on-chain side byte-for-byte:
//
//  1. LEAF padding: the real leaf array is padded up to the next power of
//     two with EMPTY_LEAF, so a normal balanced binary tree can be built
//     over it (real allowlist sizes won't be exact powers of two).
//  2. DEPTH padding: `verifyAllowlist`'s `fold` always walks exactly
//     TREE_DEPTH levels — there's no early exit in a ZK circuit. So after
//     building the real tree (to whatever depth actually fits the entry
//     count), (TREE_DEPTH - realDepth) more levels are appended on top,
//     each hashing the running root against a fixed PAD_SIBLING with
//     goesLeft=true. Every proof this module returns is always exactly
//     TREE_DEPTH entries.
//
// Depth reduced 32 -> 20 (2026-07-12): every proof pays for
// TREE_DEPTH hash operations regardless of real registrant count, so depth
// is a direct proving-cost lever, not just a capacity ceiling. 2^20
// (1,048,576) registrants is far beyond any realistic DarkVeil round (bond
// + wallet-age gated), for 37.5% fewer hash operations per proof than the
// original 32. Must match eligibility_gate.compact/bonding_curve.compact's
// `Vector<20, MerkleProofEntry>` witness type exactly.

const TREE_DEPTH = 20;
/** What a depth-20 tree holds. Past this, no valid proof can be built. */
const MAX_LEAVES = 2 ** TREE_DEPTH;
const PAD_SIBLING = pad32('noctis:allowlist:pad:v1');
const EMPTY_LEAF = pad32('noctis:allowlist:empty-leaf:v1');
const ALLOWLIST_NODE_DOMAIN = pad32('noctis:allowlist:node:v1');

interface AllowlistNodeInput {
  domain: Uint8Array;
  left: Uint8Array;
  right: Uint8Array;
}

const allowlistNodeInputType = structType<AllowlistNodeInput>([
  ['domain', bytes32Type],
  ['left', bytes32Type],
  ['right', bytes32Type],
]);

/** eligibility_gate.compact's `verifyAllowlist` fold body — one Merkle tree node hash. */
export function hashAllowlistNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return persistentHash(allowlistNodeInputType, { domain: ALLOWLIST_NODE_DOMAIN, left, right });
}

export interface MerkleProofEntry {
  sibling: Uint8Array;
  goesLeft: boolean;
}

export interface AllowlistTree {
  /** The 32-byte value to pass as `allowlistRoot_` at deploy time. */
  root: Uint8Array;
  /** Always returns exactly TREE_DEPTH (20) entries, matching the circuit's fixed-depth witness. */
  getProof(leafIndex: number): MerkleProofEntry[];
}

/** Builds an allowlist tree from real leaves (e.g. per-registrant commitments computed off-chain). */
export function buildAllowlistTree(leaves: Uint8Array[]): AllowlistTree {
  if (leaves.length === 0) {
    throw new Error('buildAllowlistTree: at least one leaf is required');
  }

  // A tree deeper than the circuit's fixed proof vector cannot be proven
  // against: the depth padding below runs a negative number of times, so
  // `getProof` returns MORE entries than the circuit reads, and the
  // documented "always exactly TREE_DEPTH entries" quietly stops holding.
  // Refused here rather than left to produce a proof that cannot verify —
  // whoever is building the tree can still see everyone they left out.
  if (leaves.length > MAX_LEAVES) {
    throw new Error(
      `buildAllowlistTree: ${leaves.length} leaves exceeds the ${MAX_LEAVES} a depth-${TREE_DEPTH} tree can prove`,
    );
  }

  let size = 1;
  while (size < leaves.length) size *= 2;
  const paddedLeaves = leaves.slice();
  while (paddedLeaves.length < size) paddedLeaves.push(EMPTY_LEAF);

  const realDepth = Math.log2(size);

  const levels: Uint8Array[][] = [paddedLeaves];
  let current = paddedLeaves;
  for (let d = 0; d < realDepth; d++) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashAllowlistNode(current[i], current[i + 1]));
    }
    levels.push(next);
    current = next;
  }
  const realRoot = current[0];

  let root = realRoot;
  for (let i = 0; i < TREE_DEPTH - realDepth; i++) {
    root = hashAllowlistNode(root, PAD_SIBLING);
  }

  function getProof(leafIndex: number): MerkleProofEntry[] {
    if (leafIndex < 0 || leafIndex >= leaves.length) {
      throw new Error(`getProof: leafIndex ${leafIndex} out of range (0..${leaves.length - 1})`);
    }
    const entries: MerkleProofEntry[] = [];
    let idx = leafIndex;
    for (let d = 0; d < realDepth; d++) {
      const levelNodes = levels[d];
      const isLeft = idx % 2 === 0;
      const siblingIdx = isLeft ? idx + 1 : idx - 1;
      entries.push({ sibling: levelNodes[siblingIdx], goesLeft: isLeft });
      idx = Math.floor(idx / 2);
    }
    for (let i = 0; i < TREE_DEPTH - realDepth; i++) {
      entries.push({ sibling: PAD_SIBLING, goesLeft: true });
    }
    return entries;
  }

  return { root, getProof };
}

// ============================================================================
// Registrant Merkle tree (fix, 2026-07-30)
// ============================================================================
//
// Mirrors eligibility_gate.compact's `verifyRegistrant` circuit exactly —
// see that circuit's comment, and registrantRoot's own ledger comment, for
// the full design rationale (replaces a publicly-precomputable nullifier
// check that let an observer de-anonymize which registrant was submitting
// a DarkVeil buy commitment). Structurally identical to buildAllowlistTree
// above — same padding/depth conventions — but with its own domain
// constants so a registrant-tree leaf/node/pad value can never collide
// with an allowlist-tree one, matching this file's "each PSM/tree uses its
// own domain separation, deliberately" convention.
//
// The tree is built by the governor off-chain from the real, already-
// public registrant set (readable from the chain's lockedBonds/
// registrationNullifiers entries after DarkVeil registration freezes) and
// published as one root via startBuying — the same off-chain-computed,
// governor-published-root trust model already used for the allowlist tree
// and every other Merkle root on this platform (CTO balance-snapshot,
// staking-snapshot).

const REGISTRANT_PAD_SIBLING = pad32('noctis:registrant:pad:v1');
const REGISTRANT_EMPTY_LEAF = pad32('noctis:registrant:empty-leaf:v1');
const REGISTRANT_NODE_DOMAIN = pad32('noctis:registrant:node:v1');

interface RegistrantNodeInput {
  domain: Uint8Array;
  left: Uint8Array;
  right: Uint8Array;
}

const registrantNodeInputType = structType<RegistrantNodeInput>([
  ['domain', bytes32Type],
  ['left', bytes32Type],
  ['right', bytes32Type],
]);

/**
 * Design requirement: `verifyRegistrant`'s leaf is derived in-circuit as
 * `persistentHash<Vector<2,Bytes<32>>>([pad(32,"noctis:registrant:leaf:v1"),
 * caller])`, binding registrant-tree membership to the caller's own
 * identity. The off-chain tree MUST be built with each leaf as
 * `hashRegistrantLeaf(pubKey)` for that registrant's real derived public
 * key (the same `caller.bytes` value already public via lockedBonds).
 */
export function hashRegistrantLeaf(callerPubKey: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:registrant:leaf:v1', callerPubKey);
}

/** eligibility_gate.compact's `verifyRegistrant` fold body — one Merkle tree node hash. */
export function hashRegistrantNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return persistentHash(registrantNodeInputType, { domain: REGISTRANT_NODE_DOMAIN, left, right });
}

export interface RegistrantTree {
  /** The 32-byte value to pass as `registrantRoot_` to startBuying. */
  root: Uint8Array;
  /** Always returns exactly TREE_DEPTH (20) entries, matching the circuit's fixed-depth witness. */
  getProof(leafIndex: number): MerkleProofEntry[];
}

/** Builds a registrant tree from the real, already-public post-freeze registrant set. */
export function buildRegistrantTree(leaves: Uint8Array[]): RegistrantTree {
  if (leaves.length === 0) {
    throw new Error('buildRegistrantTree: at least one leaf is required');
  }

  // A tree deeper than the circuit's fixed proof vector cannot be proven
  // against: the depth padding below runs a negative number of times, so
  // `getProof` returns MORE entries than the circuit reads, and the
  // documented "always exactly TREE_DEPTH entries" quietly stops holding.
  // Refused here rather than left to produce a proof that cannot verify —
  // whoever is building the tree can still see everyone they left out.
  if (leaves.length > MAX_LEAVES) {
    throw new Error(
      `buildRegistrantTree: ${leaves.length} leaves exceeds the ${MAX_LEAVES} a depth-${TREE_DEPTH} tree can prove`,
    );
  }

  let size = 1;
  while (size < leaves.length) size *= 2;
  const paddedLeaves = leaves.slice();
  while (paddedLeaves.length < size) paddedLeaves.push(REGISTRANT_EMPTY_LEAF);

  const realDepth = Math.log2(size);

  const levels: Uint8Array[][] = [paddedLeaves];
  let current = paddedLeaves;
  for (let d = 0; d < realDepth; d++) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashRegistrantNode(current[i], current[i + 1]));
    }
    levels.push(next);
    current = next;
  }
  const realRoot = current[0];

  let root = realRoot;
  for (let i = 0; i < TREE_DEPTH - realDepth; i++) {
    root = hashRegistrantNode(root, REGISTRANT_PAD_SIBLING);
  }

  function getProof(leafIndex: number): MerkleProofEntry[] {
    if (leafIndex < 0 || leafIndex >= leaves.length) {
      throw new Error(`getProof: leafIndex ${leafIndex} out of range (0..${leaves.length - 1})`);
    }
    const entries: MerkleProofEntry[] = [];
    let idx = leafIndex;
    for (let d = 0; d < realDepth; d++) {
      const levelNodes = levels[d];
      const isLeft = idx % 2 === 0;
      const siblingIdx = isLeft ? idx + 1 : idx - 1;
      entries.push({ sibling: levelNodes[siblingIdx], goesLeft: isLeft });
      idx = Math.floor(idx / 2);
    }
    for (let i = 0; i < TREE_DEPTH - realDepth; i++) {
      entries.push({ sibling: REGISTRANT_PAD_SIBLING, goesLeft: true });
    }
    return entries;
  }

  return { root, getProof };
}
