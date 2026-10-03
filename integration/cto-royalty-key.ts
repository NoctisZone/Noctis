/**
 * Choosing the public key a takeover, or a dissolve, installs as a pool's
 * royalty key.
 *
 * The venue's redirect accepts a key only when its blake2b-224 is the wallet
 * the vote named, so the key has to be found, not derived. The site keeps the
 * keys it knows for a launch: the creator's, recovered from the mint, and a
 * community wallet's, carried in its proposal's description. The hash decides
 * which one is right, so a wrong or stale candidate is simply never chosen.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** blake2b-224 of a 32-byte public key, as hex: the key hash a Cardano wallet signs under. */
export function keyHashOf(pubKeyHex: string): string {
  return bytesToHex(blake2b(hexToBytes(pubKeyHex), { dkLen: 28 }));
}

/** The key among `candidates` whose blake2b-224 is `expectedHash`, if any. */
export function royaltyKeyAmong(candidates: readonly string[], expectedHash: string): string | undefined {
  const want = expectedHash.toLowerCase();
  for (const raw of candidates) {
    const key = raw.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) continue;
    if (keyHashOf(key) === want) return key;
  }
  return undefined;
}
