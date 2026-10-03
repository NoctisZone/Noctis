// ============================================================================
// Noctis Zone — the 32 bytes inside a Midnight unshielded address
// ============================================================================
// A circuit that pays NIGHT back to a wallet (a proposal bond's return, a
// DarkVeil bond refund) takes the wallet's unshielded address as Bytes<32>.
// The wallet hands the browser that address as bech32m text
// (`mn_addr_preprod1…`, `mn_addr1…` on mainnet), and the 32 bytes are its
// payload: checked against the SDK's own `addressHex` on every network.
//
// Decoded here rather than through a library so the browser bundles carry no
// dependency for it: bech32m as BIP-350 defines it, checksum verified.
// ============================================================================

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk = (chk ^ GENERATOR[i]) >>> 0;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** A bech32m string's human-readable part and its data words, checksum verified. */
export function decodeBech32m(text: string): { hrp: string; words: number[] } {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) throw new Error('bech32m: mixed case.');
  const s = text.toLowerCase();
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (code < 33 || code > 126) throw new Error('bech32m: a character outside the printable range.');
  }
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) throw new Error('bech32m: no separator, or too short.');
  const hrp = s.slice(0, sep);
  const words: number[] = [];
  for (const c of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error(`bech32m: "${c}" is not a bech32 character.`);
    words.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== BECH32M_CONST)
    throw new Error('bech32m: the checksum does not match.');
  return { hrp, words: words.slice(0, -6) };
}

/** 5-bit words to bytes, refusing leftover bits that are not zero padding. */
function wordsToBytes(words: readonly number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) throw new Error('bech32m: the payload does not end on a byte.');
  return Uint8Array.from(out);
}

/** The 32 bytes a circuit takes as a wallet's unshielded address. */
export function unshieldedAddressBytes(address: string): Uint8Array {
  const { hrp, words } = decodeBech32m(address.trim());
  if (hrp !== 'mn_addr' && !hrp.startsWith('mn_addr_')) {
    throw new Error(`Not a Midnight unshielded address: it starts "${hrp}".`);
  }
  const bytes = wordsToBytes(words);
  if (bytes.length !== 32) throw new Error(`A Midnight unshielded address holds 32 bytes, this one ${bytes.length}.`);
  return bytes;
}
