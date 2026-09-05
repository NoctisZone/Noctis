// ============================================================================
// Noctis Zone — a DarkVeil buyer's own claim bundle, fetched and saveable
// ============================================================================
//
// WHY A BUYER SHOULD HOLD A COPY
// Everything needed to claim a DarkVeil purchase — the amount, the commitment
// salt, the leaf index and the Merkle proof — is served by the platform and
// stored by the platform. The root is anchored once, by a redeemer that only
// works while the curve is Inactive, so after that the allocation record
// cannot be replaced, only reproduced. A buyer holding their own copy can
// claim from a cold archive with the platform gone, which is the only version
// of this that does not end with someone asking us to be trustworthy.
//
// The bundle is verifiable on its own: it carries the launch it belongs to and
// the root it was issued against, so a saved file can be checked against the
// chain before anyone relies on it. `verifyClaimBundle` below does exactly
// that computation, using the same leaf and node hashes the validator uses.
//
// This module is deliberately UI-free. It fetches, verifies and serialises;
// where a save prompt appears is the claim front-end's decision.

import { hashDvLeaf, hashDvNode } from '../dv-allocation-tree.js';
import { type WalletControlProof, withProofQuery } from './wallet-control.js';

export interface ClaimBundleProofStep {
  siblingHex: string;
  goesLeft: boolean;
}

/** Exactly what `/np/v1/darkveil/allocation-proof` returns for one buyer. */
export interface ClaimBundle {
  format: 'noctis-dv-claim-v1';
  launch_id: string;
  address: string;
  vkh_hex: string;
  root: string;
  dv_amount: string;
  salt_hex: string;
  leaf_index: number;
  proof: ClaimBundleProofStep[];
  updated_at: number;
}

export interface NotIncluded {
  included: false;
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Recompute the leaf and walk the proof. A bundle that does not reach its own
 * stated root is not a bundle — it is a file that will fail at claim time,
 * and it is far better to learn that while the buyer is looking at it.
 *
 * This does NOT prove the root is the one on-chain; nothing off-chain can.
 * Compare `bundle.root` against the curve's `dv_allocation_root` for that.
 */
export function verifyClaimBundle(bundle: ClaimBundle): { ok: boolean; reason?: string } {
  if (bundle.format !== 'noctis-dv-claim-v1') {
    return { ok: false, reason: `unrecognised format ${String(bundle.format)}` };
  }
  if (!Number.isInteger(bundle.leaf_index) || bundle.leaf_index < 0) {
    return { ok: false, reason: 'leaf_index is not a whole number' };
  }

  let computed: Uint8Array;
  try {
    computed = hashDvLeaf(
      fromHex(bundle.vkh_hex),
      BigInt(bundle.dv_amount),
      bundle.leaf_index,
      fromHex(bundle.salt_hex),
    );
  } catch (err) {
    return { ok: false, reason: `leaf could not be computed: ${err instanceof Error ? err.message : String(err)}` };
  }

  for (const step of bundle.proof) {
    const sibling = fromHex(step.siblingHex);
    if (sibling.length !== 32) {
      return { ok: false, reason: 'a proof step is not a 32-byte sibling' };
    }
    computed = step.goesLeft ? hashDvNode(sibling, computed) : hashDvNode(computed, sibling);
  }

  if (toHex(computed).toLowerCase() !== bundle.root.toLowerCase()) {
    return { ok: false, reason: 'the proof does not reach the root this bundle states' };
  }
  return { ok: true };
}

/**
 * Fetch this wallet's own bundle. Returns `{ included: false }` for a wallet
 * that did not buy during DarkVeil — a normal answer, not an error.
 *
 * Verifies before returning, so a caller never hands a buyer something to save
 * that would not have worked.
 */
export async function fetchClaimBundle(
  restBase: string,
  launchId: string,
  cardanoAddress: string,
  /** Proof the caller controls the address — the server refuses the lookup without it (the record is private). */
  proof?: WalletControlProof,
): Promise<ClaimBundle | NotIncluded> {
  const bare = `${restBase.replace(/\/$/, '')}/darkveil/allocation-proof?launch_id=${encodeURIComponent(
    launchId,
  )}&cardano_address=${encodeURIComponent(cardanoAddress)}`;
  const url = proof ? withProofQuery(bare, proof) : bare;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Could not fetch the claim bundle: ${res.status} ${await res.text()}`);
  }
  // Typed as unknown on the way in on purpose: this is a network response, and
  // the only reason to believe anything about its shape is the check below.
  const body = (await res.json()) as Record<string, unknown>;
  if (body.included === false) {
    return { included: false };
  }

  const bundle = body as unknown as ClaimBundle;
  const verdict = verifyClaimBundle(bundle);
  if (!verdict.ok) {
    throw new Error(`The claim bundle the server returned does not verify: ${verdict.reason}`);
  }
  return bundle;
}

/** A stable, human-recognisable filename — the launch and the wallet, both visible. */
export function claimBundleFilename(bundle: ClaimBundle): string {
  const shortVkh = bundle.vkh_hex.slice(0, 8);
  return `noctis-darkveil-claim-${bundle.launch_id}-${shortVkh}.json`;
}

/**
 * The bundle as a file the buyer keeps, with a plain-language note in it.
 *
 * The note is inside the document on purpose: this file will be found in a
 * downloads folder months later by someone who does not remember what it is,
 * and at that point a filename is not enough.
 */
export function serialiseClaimBundle(bundle: ClaimBundle): string {
  return JSON.stringify(
    {
      _read_me:
        'This is your private DarkVeil claim record for a Noctis launch. It is what lets you claim ' +
        'the tokens you bought, and it cannot be regenerated from the blockchain alone. Keep it. ' +
        'It reveals how much you bought, so keep it private too.',
      ...bundle,
    },
    null,
    2,
  );
}

/**
 * Hand the bundle to the browser as a download.
 *
 * Separate from `fetchClaimBundle` so a caller can show the buyer what they
 * are about to save first — a download that happens without being asked for
 * is a download nobody notices they have.
 */
export function downloadClaimBundle(bundle: ClaimBundle): void {
  const blob = new Blob([serialiseClaimBundle(bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = claimBundleFilename(bundle);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Revoked on the next tick rather than immediately: some browsers have not
    // finished reading the blob when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Read a bundle a buyer saved earlier, refusing anything that does not verify. */
export function parseSavedClaimBundle(text: string): ClaimBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const bundle = parsed as ClaimBundle;
  const verdict = verifyClaimBundle(bundle);
  if (!verdict.ok) {
    throw new Error(`That file is not a usable claim record: ${verdict.reason}`);
  }
  return bundle;
}
