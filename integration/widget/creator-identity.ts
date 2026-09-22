// ============================================================================
// Noctis Zone — a creator tells their launch which identity to exclude
// ============================================================================
// The eligibility gate seals a creator identity at deploy and refuses a
// DarkVeil registration that derives to it. That is the on-chain half of "the
// creator does not buy their own launch", and it is worth exactly as much as
// the value in the slot: seal an identity the creator never uses and it
// excludes nobody, while every other check still passes.
//
// WHY THE CREATOR HAS TO SUBMIT IT, rather than the platform reading it. A
// Cardano public key can be recovered from the mint transaction's own witness
// set, which is how the royalty key is collected with no prompt at all. A
// Midnight identity is on no chain: it is derived here, in the creator's
// browser, from their wallet, and kept in the dApp's own encrypted store. The
// only way for anyone else to learn it is to be told.
//
// WHAT THE SIGNATURE IS FOR. Not the identity — nothing can prove a 32-byte
// hash has a secret behind it. It proves the SUBMITTER controls the wallet the
// launch records as its creator, which is the party with both the ability to
// produce the right identity and the reason to. It is bound to this launch AND
// this key, so a signature given for one launch cannot bind a key to another
// and the key cannot be swapped after the creator has signed for it.
//
// ONE LAUNCH, ONE IDENTITY. The key is derived under a launch-scoped domain,
// so a creator running two launches presents a different identity to each and
// neither says anything about the other. That is also why this cannot be done
// before the mint: there is no launch id to scope it to.
// ============================================================================

import { buildBinds, type WalletControlProof } from './wallet-control.js';

/** Must match NP_CREATOR_MIDNIGHT_KEY_ACTION server-side, exactly. */
export const CREATOR_MIDNIGHT_KEY_ACTION = 'creator:midnight-key';

/**
 * The value a nonce must be bound to for this submission to be accepted.
 *
 * Built the same way on both sides — sha256 over the action and its
 * parameters, joined by a pipe. A mismatch is refused by the server as an
 * out-of-scope challenge rather than as a bad signature, so the two have to be
 * kept in step deliberately.
 */
export function creatorMidnightKeyBinds(launchIdHex: string, keyHex: string): string {
  return buildBinds(CREATOR_MIDNIGHT_KEY_ACTION, [launchIdHex.toLowerCase(), keyHex.toLowerCase()]);
}

export interface CreatorIdentitySubmission {
  apiBase: string;
  /** The launch's slug, which is what the route is addressed by. */
  slug: string;
  keyHex: string;
  proof: WalletControlProof;
}

export type CreatorIdentityResult =
  | { ok: true; keyHex: string }
  | { ok: false; status: number; code: string; message: string };

/** Whether a value could identify somebody: 32 bytes, and not an empty buffer. */
export function isIdentityKeyHex(hex: string): boolean {
  const lower = hex.toLowerCase();
  return /^[0-9a-f]{64}$/.test(lower) && lower !== '0'.repeat(64);
}

/**
 * Send the creator's launch-scoped identity to the launch record.
 *
 * Returns rather than throws for a refusal, because every refusal here is
 * something the creator can act on — a stale challenge, the wrong wallet, a
 * launch whose gate is already deployed — and a thrown error would arrive at
 * the UI as "something went wrong".
 */
export async function submitCreatorMidnightKey(input: CreatorIdentitySubmission): Promise<CreatorIdentityResult> {
  if (!isIdentityKeyHex(input.keyHex)) {
    return {
      ok: false,
      status: 0,
      code: 'np_bad_midnight_key',
      message: 'A Midnight identity must be 64 hex characters (32 bytes) and cannot be all zero.',
    };
  }

  const res = await fetch(`${input.apiBase}launches/${encodeURIComponent(input.slug)}/creator-midnight-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The identity travels as `midnight_key`, NOT as `key`. The shared
    // wallet-control verifier already reads `key` as the CIP-8 witness public
    // key, and two meanings for one field is how a signature ends up checked
    // against an identity or an identity stored as a witness.
    body: JSON.stringify({ midnight_key: input.keyHex.toLowerCase(), ...input.proof }),
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* a response with no JSON body still has a status, which is the useful part */
  }
  const parsed = (body ?? {}) as { ok?: boolean; midnight_key?: string; code?: string; message?: string };

  if (res.ok && parsed.midnight_key) {
    return { ok: true, keyHex: parsed.midnight_key };
  }
  return {
    ok: false,
    status: res.status,
    code: parsed.code ?? 'np_unknown',
    message: parsed.message ?? `The launch record refused the identity (HTTP ${res.status}).`,
  };
}
