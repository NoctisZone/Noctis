// Node's `crypto`, for the creator-fee widget's browser build.
//
// Mesh reaches `crypto` for two things. Random bytes: a bundled copy of nanoid
// fills its pool with randomFillSync, and an offline fetcher the claim never
// uses draws randomBytes for placeholder block hashes. Both are served here
// from the browser's own CSPRNG, so the bundle carries no crypto polyfill.
//
// And pbkdf2Sync, which Mesh uses only to turn a recovery phrase into a key.
// A browser claim is signed by the connected wallet, so this bundle has no
// business deriving one: it refuses. Anything else a future Mesh version asks
// of this module is undefined, and fails where it is called rather than
// quietly.

const MAX_PER_CALL = 65536; // getRandomValues refuses more than this at once

export function randomFillSync(target, offset = 0, size) {
  const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  const end = size === undefined ? bytes.length : offset + size;
  for (let at = offset; at < end; at += MAX_PER_CALL) {
    globalThis.crypto.getRandomValues(bytes.subarray(at, Math.min(end, at + MAX_PER_CALL)));
  }
  return target;
}

export function randomBytes(size) {
  return randomFillSync(Buffer.alloc(size));
}

export function pbkdf2Sync() {
  throw new Error('This page signs with your connected wallet and never derives a key from a recovery phrase.');
}

export default { randomFillSync, randomBytes, pbkdf2Sync };
