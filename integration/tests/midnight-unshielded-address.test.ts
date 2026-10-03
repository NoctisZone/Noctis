import { describe, expect, it } from 'vitest';
import { decodeBech32m, unshieldedAddressBytes } from '../midnight-unshielded-address.js';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// BIP-350's own test vectors, each also checked against an independent decoder.
const VALID = [
  'A1LQFN3A',
  'a1lqfn3a',
  'an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6',
  'abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx',
  '11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8',
  'split1checkupstagehandshakeupstreamerranterredcaperredlc445v',
  '?1v759aa',
];
const INVALID = [
  'A1G7SGD8', // a bech32 (not bech32m) checksum
  '1xj0phk', // empty human-readable part
  'qyrz8wqd2c9m', // no separator
  'y1p0hxs9', // too short
  'lt1igcx5c0', // invalid data character
  'in1muywd',
  'mm1crxm3i',
  'au1s5cgom',
  'M1VUXWEZ',
  '16plkw9',
  '1p2gdwpf',
  'a1lqfn3A', // mixed case
];

// From the Midnight wallet SDK (PublicKey.address / .addressHex) for one fixed
// test seed: the same 32 bytes under each network's prefix.
const ADDRESS_HEX = '8a27486764300ee8e1a54b1fd65195c0ec2c276bf6ffb65cf173b9a42f077460';
const PREPROD = 'mn_addr_preprod13gn5semyxq8w3cd9fv0av5v4crkzcfmt7mlmvh83wwu6gtc8w3sqx5e6m6';
const MAINNET = 'mn_addr13gn5semyxq8w3cd9fv0av5v4crkzcfmt7mlmvh83wwu6gtc8w3sqaqdgcd';

describe('decodeBech32m', () => {
  it.each(VALID)('accepts %s', (v) => {
    expect(() => decodeBech32m(v)).not.toThrow();
  });
  it.each(INVALID)('refuses %s', (v) => {
    expect(() => decodeBech32m(v)).toThrow();
  });
  it('splits the human-readable part from the data', () => {
    const { hrp, words } = decodeBech32m('abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx');
    expect(hrp).toBe('abcdef');
    expect(words).toEqual(Array.from({ length: 32 }, (_, i) => 31 - i));
  });
});

describe('unshieldedAddressBytes', () => {
  it('is the address the SDK derives, on each network', () => {
    expect(toHex(unshieldedAddressBytes(PREPROD))).toBe(ADDRESS_HEX);
    expect(toHex(unshieldedAddressBytes(MAINNET))).toBe(ADDRESS_HEX);
  });
  it('refuses a corrupted address', () => {
    const flipped = PREPROD.slice(0, -1) + (PREPROD.endsWith('6') ? '7' : '6');
    expect(() => unshieldedAddressBytes(flipped)).toThrow(/checksum/);
  });
  it('refuses an address of another kind', () => {
    expect(() => unshieldedAddressBytes('abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx')).toThrow(/Not a Midnight/);
  });
});
