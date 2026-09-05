// ============================================================================
// Noctis Zone — CTO Governance: the holder's side, from a browser
// ============================================================================
// Three things a token holder does, in order, and what each one trusts:
//
//   1. register   — binds the wallet to its launch-scoped voting identity so
//                   the governor can put a leaf for it in the balance snapshot.
//                   The server verifies the CIP-8 signature and re-derives the
//                   identity itself; this side then checks that the key the
//                   server derived is the one it holds, and refuses otherwise.
//   2. my leaf    — fetches this wallet's own snapshot entry (balance, held-
//                   since, sibling path) behind a wallet-control proof, and
//                   re-verifies it against the published root before anything
//                   is done with it. A leaf that does not recompute the root is
//                   a vote that fails in-circuit, and better found here.
//   3. vote       — connects to the governance contract with that leaf as the
//                   witness and calls castVote. Weight and creator status are
//                   derived on-chain from the leaf; nothing is claimed.
//
// hasVoted reads the public nullifier set with a nullifier only the voter can
// compute, so a page can say "you already voted" without a transaction.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import type { MerkleProofEntry } from '../../contracts/midnight/witnesses.js';
import { computeVoteNullifier, hashBalanceLeaf, hashBalanceNode } from '../../packages/zk-proofs/src/cto-governance.js';
import type { SnapshotBundleEntry } from '../cto-snapshot-bundle.js';
import { NoctisLaunchManager, NoctisMidnightClient } from '../midnight-client.js';
import {
  type CtoGovernanceSnapshot,
  readCtoGovernanceLedger,
  summarizeCtoGovernance,
} from '../midnight-public-state.js';
import { signCardanoData } from '../wallet-connection.js';
import type { CtoSession } from './cto-session.js';
import { buildBinds, proveWalletControlFrom, withProofQuery } from './wallet-control.js';

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('Expected an even-length hex string.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok || json === null) {
    throw new Error(json?.message ?? `Request to ${url} failed with ${res.status}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// 1. Register
// ---------------------------------------------------------------------------

export interface RegisterVoterResult {
  voterKeyHex: string;
  registeredAt: number;
}

/**
 * Binds the connected wallet to its voting identity for one launch.
 *
 * The signature sent is the SAME master signature the identity derives from,
 * so the server can re-derive the identity and this side can confirm the
 * server arrived at the key it holds. A mismatch means the server is not
 * running the derivation this code expects, and the registration must not be
 * trusted — it would put a leaf under a key this wallet cannot vote with.
 */
export async function registerVoter(
  apiBase: string,
  session: CtoSession,
  launchId: string,
  launchIdHex: string,
): Promise<RegisterVoterResult> {
  const launchIdBytes = hexToBytes(launchIdHex);
  const localKeyHex = bytesToHex((await session.getIdentityPublicKey(launchIdBytes)).bytes);
  const material = await session.getMasterSignatureMaterial();

  const res = await postJson<{ ok: boolean; voter_key_hex: string; registered_at: number }>(
    `${apiBase.replace(/\/$/, '')}/cto/register`,
    {
      launch_id: launchId,
      cardano_address: session.cardano.address,
      cip8_signature_hex: material.signature,
      cip8_key_hex: material.key,
    },
  );

  if (typeof res.voter_key_hex !== 'string' || res.voter_key_hex.toLowerCase() !== localKeyHex) {
    throw new Error(
      'The server derived a different voting identity from your signature than this wallet holds. ' +
        'Registration was not accepted on this side; nothing to do until the platform is checked.',
    );
  }
  return { voterKeyHex: localKeyHex, registeredAt: Number(res.registered_at ?? 0) };
}

// ---------------------------------------------------------------------------
// 2. My leaf
// ---------------------------------------------------------------------------

export interface MyLeaf {
  format: 'noctis-cto-leaf-v1';
  launchIdHex: string;
  rootHex: string;
  entry: SnapshotBundleEntry;
}

export interface NotInSnapshot {
  included: false;
  /** Why, in words the page can show: not registered, or registered after the snapshot. */
  reason: string;
}

/**
 * Walks an entry's sibling path to the root, the way castVote does in-circuit.
 * The same walk cto-snapshot-bundle.ts makes server-side; kept here in the
 * browser-safe module because that one carries Node-only seed derivation.
 */
export function entryReachesRoot(entry: SnapshotBundleEntry, rootHex: string): boolean {
  let node = hashBalanceLeaf(hexToBytes(entry.voterKeyHex), BigInt(entry.balance), BigInt(entry.heldSinceTimestamp));
  for (const step of entry.proof) {
    const sibling = hexToBytes(step.siblingHex);
    node = step.goesLeft ? hashBalanceNode(node, sibling) : hashBalanceNode(sibling, node);
  }
  return bytesToHex(node) === rootHex.toLowerCase();
}

/** Pure: everything a fetched leaf must satisfy before it is used. */
export function verifyMyLeaf(
  leaf: MyLeaf,
  myVoterKeyHex: string,
  launchIdHex: string,
): { ok: boolean; reason?: string } {
  if (leaf.format !== 'noctis-cto-leaf-v1') {
    return { ok: false, reason: `unrecognised format ${String(leaf.format)}` };
  }
  if (leaf.launchIdHex.toLowerCase() !== launchIdHex.toLowerCase()) {
    return { ok: false, reason: 'the leaf belongs to a different launch' };
  }
  if (leaf.entry.voterKeyHex.toLowerCase() !== myVoterKeyHex.toLowerCase()) {
    return { ok: false, reason: 'the leaf is for a different voting identity than this wallet holds' };
  }
  if (!/^[0-9a-f]{64}$/i.test(leaf.rootHex)) {
    return { ok: false, reason: 'the root is not 32 bytes of hex' };
  }
  let recomputes = false;
  try {
    recomputes = entryReachesRoot(leaf.entry, leaf.rootHex);
  } catch (err) {
    return { ok: false, reason: `the proof could not be walked: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!recomputes) {
    return { ok: false, reason: 'the proof does not reach the root the server states' };
  }
  return { ok: true };
}

export async function fetchMyLeaf(
  apiBase: string,
  session: CtoSession,
  launchId: string,
  launchIdHex: string,
): Promise<MyLeaf | NotInSnapshot> {
  const base = apiBase.replace(/\/$/, '');
  const address = session.cardano.address;
  const proof = await proveWalletControlFrom(
    base,
    session.cardano,
    signCardanoData,
    // Pinned into the signed bytes: a signature over one launch and address
    // cannot fetch a leaf for another.
    buildBinds('cto:leaf', [launchId, address]),
  );
  const url = withProofQuery(
    `${base}/cto/leaf?launch_id=${encodeURIComponent(launchId)}&cardano_address=${encodeURIComponent(address)}`,
    proof,
  );
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || body === null) {
    throw new Error((body?.message as string | undefined) ?? `Could not fetch your snapshot leaf: ${res.status}`);
  }
  if (body.included === false) {
    return { included: false, reason: String(body.reason ?? 'this wallet has no leaf in the current snapshot') };
  }
  const leaf: MyLeaf = {
    format: body.format as MyLeaf['format'],
    launchIdHex: String(body.launch_id_hex ?? ''),
    rootHex: String(body.root_hex ?? ''),
    entry: body.entry as SnapshotBundleEntry,
  };
  const myKeyHex = bytesToHex((await session.getIdentityPublicKey(hexToBytes(launchIdHex))).bytes);
  const verdict = verifyMyLeaf(leaf, myKeyHex, launchIdHex);
  if (!verdict.ok) {
    throw new Error(`The snapshot leaf the server returned does not verify: ${verdict.reason}`);
  }
  return leaf;
}

// ---------------------------------------------------------------------------
// 3. Vote
// ---------------------------------------------------------------------------

/** The witness shape connectCtoGovernance takes, from a bundle entry's sibling path. */
export function witnessProofFrom(entry: SnapshotBundleEntry): MerkleProofEntry[] {
  return entry.proof.map((step) => ({ sibling: hexToBytes(step.siblingHex), goesLeft: step.goesLeft }));
}

/** POSIX seconds now — the contract holds block time within an hour after it. */
export function currentTimestampSeconds(now = Date.now()): bigint {
  return BigInt(Math.floor(now / 1000));
}

export interface CastVoteParams {
  providers: ContractProviders;
  contractAddress: string;
  proposalIdHex: string;
  support: boolean;
  leaf: MyLeaf;
}

export interface CastVoteResult {
  txId: string;
  txHash: string;
}

export async function castVoteFromBrowser(session: CtoSession, params: CastVoteParams): Promise<CastVoteResult> {
  const identity = await session.getIdentity();
  const client = new NoctisMidnightClient(identity.userSecretKey);
  await client.connectCtoGovernance(
    params.providers,
    params.contractAddress,
    BigInt(params.leaf.entry.balance),
    witnessProofFrom(params.leaf.entry),
    BigInt(params.leaf.entry.heldSinceTimestamp),
  );
  const manager = new NoctisLaunchManager(client);
  const result = (await manager.castVote(
    hexToBytes(params.proposalIdHex),
    params.support,
    currentTimestampSeconds(),
  )) as { public?: { txId?: unknown; txHash?: unknown } };
  return {
    txId: String(result.public?.txId ?? ''),
    txHash: String(result.public?.txHash ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readGovernance(
  publicDataProvider: ContractProviders['publicDataProvider'],
  contractAddress: string,
): Promise<CtoGovernanceSnapshot> {
  return summarizeCtoGovernance(await readCtoGovernanceLedger(publicDataProvider, contractAddress));
}

/** The nullifier this identity's vote on this proposal would leave on the ledger. */
export function myVoteNullifier(voterSecret: Uint8Array, launchIdHex: string, proposalIdHex: string): Uint8Array {
  return computeVoteNullifier({
    voterSecret,
    launchId: hexToBytes(launchIdHex),
    proposalId: hexToBytes(proposalIdHex),
  });
}

/** The one thing hasVoted needs from a ledger: is this nullifier in the set? */
export interface VoteNullifierSet {
  voteNullifiers: { member(nullifier: Uint8Array): boolean };
}

export async function hasVoted(
  publicDataProvider: ContractProviders['publicDataProvider'],
  contractAddress: string,
  session: CtoSession,
  launchIdHex: string,
  proposalIdHex: string,
  readLedger: (
    p: ContractProviders['publicDataProvider'],
    a: string,
  ) => Promise<VoteNullifierSet> = readCtoGovernanceLedger,
): Promise<boolean> {
  const identity = await session.getIdentity();
  const ledger = await readLedger(publicDataProvider, contractAddress);
  return ledger.voteNullifiers.member(myVoteNullifier(identity.userSecretKey.bytes, launchIdHex, proposalIdHex));
}
