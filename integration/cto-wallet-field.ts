// ============================================================================
// Noctis Zone — a Cardano hash in a Midnight ballot's 32-byte field
// ============================================================================
// The Midnight ballot keeps a proposal's wallets in 32-byte fields: the
// community wallet a takeover names (`proposedCommunityWallet`) and a fund
// allocation's recipient (`allocationRecipient`). A Cardano Launch's wallets
// are 28-byte payment key hashes, and the Cardano governance record keeps them
// at that length, since every contract that pays one compares it with a
// transaction's signers and output addresses.
//
// So a key hash sits in the field's first 28 bytes and the last four are zero.
// Proposal creation writes it that way, and the relayer takes it back out,
// refusing any field that was not written that way rather than guessing.
//
// A DEX vote's target (`targetDexAddr`) is carried the same way: a DEX pool on
// Cardano is a script, named by its 28-byte script hash, and that is what the
// governance record keeps as the vote's target credential.
// ============================================================================

export const CARDANO_KEY_HASH_BYTES = 28;
const BALLOT_FIELD_BYTES = 32;

function hexToBytes(hex: string, label: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`${label}: expected hex, got ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** What a 28-byte hash names, for the messages: "payment key" or "script". */
type HashKind = 'payment key' | 'script';

function hashToField(hashHex: string, label: string, kind: HashKind): Uint8Array {
  const hash = hexToBytes(hashHex, label);
  if (hash.length !== CARDANO_KEY_HASH_BYTES) {
    throw new Error(`${label}: a Cardano ${kind} hash is ${CARDANO_KEY_HASH_BYTES} bytes, got ${hash.length}.`);
  }
  if (hash.every((b) => b === 0)) {
    throw new Error(`${label}: an all-zero ${kind} hash names no ${kind === 'script' ? 'script' : 'wallet'}.`);
  }
  const field = new Uint8Array(BALLOT_FIELD_BYTES);
  field.set(hash);
  return field;
}

function hashFromField(field: Uint8Array, label: string, kind: HashKind): string {
  if (field.length !== BALLOT_FIELD_BYTES) {
    throw new Error(`${label}: a ballot field is ${BALLOT_FIELD_BYTES} bytes, got ${field.length}.`);
  }
  if (field.subarray(CARDANO_KEY_HASH_BYTES).some((b) => b !== 0)) {
    throw new Error(`${label} does not hold a Cardano ${kind} hash: its last four bytes are not zero.`);
  }
  const hash = field.subarray(0, CARDANO_KEY_HASH_BYTES);
  if (hash.every((b) => b === 0)) throw new Error(`${label} is empty.`);
  return toHex(hash);
}

/** A 28-byte payment key hash, as the ballot's 32-byte wallet field holds it. */
export function cardanoKeyHashToBallotField(keyHashHex: string, label = 'key hash'): Uint8Array {
  return hashToField(keyHashHex, label, 'payment key');
}

/** The payment key hash a ballot's wallet field holds, as hex. */
export function cardanoKeyHashFromBallotField(field: Uint8Array, label = 'wallet field'): string {
  return hashFromField(field, label, 'payment key');
}

/** A 28-byte script hash (a DEX vote's target), as the ballot's 32-byte field holds it. */
export function cardanoScriptHashToBallotField(scriptHashHex: string, label = 'script hash'): Uint8Array {
  return hashToField(scriptHashHex, label, 'script');
}

/** The script hash a ballot's 32-byte field holds, as hex. */
export function cardanoScriptHashFromBallotField(field: Uint8Array, label = 'target field'): string {
  return hashFromField(field, label, 'script');
}
