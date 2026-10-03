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

/**
 * The Ed25519 public key in a CIP-30 `signData` answer's COSE_Key (label -2),
 * as hex. Read with a small CBOR walk rather than a Cardano library, so the
 * Midnight bundle can take a wallet's key from the signature it already holds.
 */
export function coseKeyPublicKey(coseKeyHex: string): string {
  const b = hexToBytes(coseKeyHex);
  let i = 0;
  const byte = () => {
    if (i >= b.length) throw new Error('The COSE key ends early.');
    return b[i++];
  };
  // The argument of a CBOR head; `null` for an indefinite length.
  const arg = (ai: number): number | null => {
    if (ai < 24) return ai;
    if (ai === 31) return null;
    const width = { 24: 1, 25: 2, 26: 4, 27: 8 }[ai];
    if (width === undefined) throw new Error('The COSE key is not well-formed CBOR.');
    let n = 0;
    for (let k = 0; k < width; k++) n = n * 256 + byte();
    return n;
  };
  const head = () => {
    const h = byte();
    return { major: h >> 5, ai: h & 31 };
  };
  const skip = (): void => {
    const { major, ai } = head();
    const n = arg(ai);
    if (major === 2 || major === 3) {
      if (n === null) throw new Error('An indefinite string in a COSE key is not supported.');
      i += n;
    } else if (major === 4 || major === 5) {
      const items = major === 5 ? 2 : 1;
      if (n === null) {
        while (b[i] !== 0xff) skip();
        i++;
      } else for (let k = 0; k < n * items; k++) skip();
    } else if (major === 6) skip();
  };

  const map = head();
  if (map.major !== 5) throw new Error('The wallet returned a key that is not a COSE_Key map.');
  const entries = arg(map.ai);
  for (let k = 0; entries === null ? b[i] !== 0xff : k < entries; k++) {
    const label = head();
    const n = arg(label.ai);
    if ((label.major === 0 || label.major === 1) && n !== null) {
      if (label.major === 1 && n === 1) {
        const value = head();
        const len = arg(value.ai);
        if (value.major !== 2 || len !== 32) throw new Error('The COSE key holds no 32-byte public key.');
        const key = bytesToHex(b.subarray(i, i + 32));
        if (key.length !== 64) throw new Error('The COSE key ends early.');
        return key;
      }
    } else if (label.major === 3 && n !== null) {
      i += n;
    } else {
      throw new Error('The COSE key has a label of a kind COSE does not use.');
    }
    skip();
  }
  throw new Error('The wallet returned a key with no public key in it.');
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
