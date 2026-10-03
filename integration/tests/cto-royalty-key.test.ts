import { describe, expect, it } from 'vitest';
import { keyHashOf, royaltyKeyAmong } from '../cto-royalty-key.js';

// Vectors from Python's hashlib.blake2b(key, digest_size=28), an implementation
// independent of the one under test.
const KEY_A = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const HASH_A = 'd615a37bf76df17bc644b246b8b0408e6ed29b9129df51a98e7cd641';
const KEY_B = 'a5'.repeat(32);
const HASH_B = '08459d188e1ebacc7103fabbbbcf27df0e57d4fa7e043a87535707ba';

describe('keyHashOf', () => {
  it('is blake2b-224 of the key bytes', () => {
    expect(keyHashOf(KEY_A)).toBe(HASH_A);
    expect(keyHashOf(KEY_B)).toBe(HASH_B);
  });
});

describe('royaltyKeyAmong', () => {
  it('picks the candidate whose hash is the expected one, wherever it sits', () => {
    expect(royaltyKeyAmong([KEY_A, KEY_B], HASH_B)).toBe(KEY_B);
    expect(royaltyKeyAmong([KEY_B, KEY_A], HASH_A)).toBe(KEY_A);
  });

  it('chooses nothing when no candidate hashes to the wallet', () => {
    expect(royaltyKeyAmong([KEY_A], HASH_B)).toBeUndefined();
    expect(royaltyKeyAmong([], HASH_A)).toBeUndefined();
  });

  it('reads either case and returns the key lower-cased', () => {
    expect(royaltyKeyAmong([KEY_A.toUpperCase()], HASH_A.toUpperCase())).toBe(KEY_A);
  });

  it('passes over anything that is not a 32-byte key', () => {
    expect(royaltyKeyAmong([KEY_A.slice(2), `${KEY_A}00`, 'zz'.repeat(32), HASH_A], HASH_A)).toBeUndefined();
    expect(royaltyKeyAmong(['zz'.repeat(32), KEY_A], HASH_A)).toBe(KEY_A);
  });
});
