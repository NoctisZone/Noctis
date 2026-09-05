// ============================================================================
// Noctis Zone — the balance-snapshot bundle a voter proves against
// ============================================================================
// A CTO ballot weighs each vote by a leaf in a Merkle tree the attestors
// publish (`updateBalanceSnapshot`). A voter needs three things from that
// tree to cast a vote: their leaf's balance, its held-since timestamp, and the
// sibling path to the root. This module builds the tree once and hands out
// one self-describing bundle per voter, the same shape the allowlist and
// registrant bundles already take on the DarkVeil side, so the harness and
// the platform read all three the same way.
//
// Entries name their voter either by the CTO-domain public key (what the
// contract derives: deriveUserPublicKey(sk, launchId) under
// 'noctis:cto:user:pk:v1') or, for a harness wallet, by the seed the key is
// derived from — the same seed → user-secret derivation DarkVeil registrants
// use, so the same test wallets can register, buy and vote.
// ============================================================================

import {
  buildBalanceSnapshotTree,
  deriveUserPublicKey,
  hashBalanceLeaf,
  hashBalanceNode,
  type MerkleProofEntry,
} from '../packages/zk-proofs/src/cto-governance.js';
import { fromHex32 } from './eligibility-gate-deploy-args.js';
import { deriveUserSecretFromSeed } from './midnight-user-identity.js';

export interface SnapshotBundleEntryInput {
  /** Free label (a harness role, a Cardano address) carried through untouched. */
  label?: string;
  /** The voter's CTO-domain public key for this launch, 32 bytes hex. */
  voterKeyHex?: string;
  /** Alternatively a harness wallet seed; the key is derived from it. */
  voterSeedHex?: string;
  /** Whole tokens held at the snapshot. */
  balance: string | number;
  /** POSIX seconds the balance has been held since. Must predate a proposal by 30 days to count. */
  heldSinceTimestamp: string | number;
}

export interface SnapshotBundleEntry {
  label: string;
  voterKeyHex: string;
  balance: string;
  heldSinceTimestamp: string;
  leafIndex: number;
  proof: Array<{ siblingHex: string; goesLeft: boolean }>;
}

export interface SnapshotBundle {
  format: 'noctis-cto-snapshot-v1';
  launchIdHex: string;
  rootHex: string;
  entries: SnapshotBundleEntry[];
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function toBigInt(value: string | number, label: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label}: expected a number or a numeric string, got ${JSON.stringify(value)}`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label}: not an integer, got ${JSON.stringify(value)}`);
  }
  if (parsed < 0n) throw new Error(`${label}: must not be negative, got ${parsed}`);
  return parsed;
}

/** The voter key an entry names, derived when a seed was given instead. */
export function voterKeyFor(entry: SnapshotBundleEntryInput, launchId: Uint8Array, index: number): Uint8Array {
  if (entry.voterKeyHex && entry.voterSeedHex) {
    throw new Error(`entries[${index}]: give voterKeyHex or voterSeedHex, not both.`);
  }
  if (entry.voterKeyHex) return fromHex32(entry.voterKeyHex, `entries[${index}].voterKeyHex`);
  if (entry.voterSeedHex) {
    const secret = deriveUserSecretFromSeed(fromHex32(entry.voterSeedHex, `entries[${index}].voterSeedHex`));
    return deriveUserPublicKey(secret, launchId);
  }
  throw new Error(`entries[${index}]: needs voterKeyHex or voterSeedHex.`);
}

export function buildSnapshotBundle(launchIdHex: string, inputs: SnapshotBundleEntryInput[]): SnapshotBundle {
  const launchId = fromHex32(launchIdHex, 'launchIdHex');
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('entries must be a non-empty array.');
  }

  const keyed = inputs.map((entry, index) => {
    const balance = toBigInt(entry.balance, `entries[${index}].balance`);
    if (balance === 0n) {
      throw new Error(`entries[${index}]: balance must be positive — the contract refuses a zero-balance vote.`);
    }
    return {
      label: entry.label ?? '',
      voterKey: voterKeyFor(entry, launchId, index),
      balance,
      heldSinceTimestamp: toBigInt(entry.heldSinceTimestamp, `entries[${index}].heldSinceTimestamp`),
    };
  });

  const seen = new Map<string, number>();
  keyed.forEach((entry, index) => {
    const key = toHex(entry.voterKey);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(`entries[${index}] repeats the voter key of entries[${first}]; one leaf per voter.`);
    }
    seen.set(key, index);
  });

  const tree = buildBalanceSnapshotTree(
    keyed.map(({ voterKey, balance, heldSinceTimestamp }) => ({ voterKey, balance, heldSinceTimestamp })),
  );

  return {
    format: 'noctis-cto-snapshot-v1',
    launchIdHex: launchIdHex.toLowerCase(),
    rootHex: toHex(tree.root),
    entries: keyed.map((entry, index) => ({
      label: entry.label,
      voterKeyHex: toHex(entry.voterKey),
      balance: entry.balance.toString(),
      heldSinceTimestamp: entry.heldSinceTimestamp.toString(),
      leafIndex: index,
      proof: tree.getProof(index).map((step) => ({ siblingHex: toHex(step.sibling), goesLeft: step.goesLeft })),
    })),
  };
}

/** Recomputes the root from one entry's leaf and path — what castVote does in-circuit. */
export function entryRecomputesRoot(entry: SnapshotBundleEntry, rootHex: string): boolean {
  let acc = hashBalanceLeaf(
    fromHex32(entry.voterKeyHex, 'voterKeyHex'),
    BigInt(entry.balance),
    BigInt(entry.heldSinceTimestamp),
  );
  for (const step of entry.proof) {
    const sibling = fromHex32(step.siblingHex, 'siblingHex');
    acc = step.goesLeft ? hashBalanceNode(acc, sibling) : hashBalanceNode(sibling, acc);
  }
  return toHex(acc) === rootHex.toLowerCase();
}

/** The proof entries in the shape the contract witness wants. */
export function proofEntriesFrom(entry: SnapshotBundleEntry): MerkleProofEntry[] {
  return entry.proof.map((step, i) => ({
    sibling: fromHex32(step.siblingHex, `proof[${i}].siblingHex`),
    goesLeft: step.goesLeft,
  }));
}
