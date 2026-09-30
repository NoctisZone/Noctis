import { describe, expect, it } from 'vitest';
import { cardanoKeyHashFromBallotField, cardanoKeyHashToBallotField } from '../cto-wallet-field.js';

const KEY = 'c2'.repeat(28);

describe('a Cardano payment key hash in a ballot wallet field', () => {
  it('sits in the first 28 bytes, with four zero bytes after it', () => {
    const field = cardanoKeyHashToBallotField(KEY);
    expect(field).toHaveLength(32);
    expect(Buffer.from(field).toString('hex')).toBe(`${KEY}00000000`);
    expect(cardanoKeyHashFromBallotField(field)).toBe(KEY);
  });

  it('refuses anything that is not a 28-byte key hash on the way in', () => {
    expect(() => cardanoKeyHashToBallotField('c2'.repeat(32))).toThrow(/28 bytes, got 32/);
    expect(() => cardanoKeyHashToBallotField('00'.repeat(28))).toThrow(/names no wallet/);
    expect(() => cardanoKeyHashToBallotField('zz'.repeat(28))).toThrow(/expected hex/);
  });

  it('refuses a field it did not write on the way out', () => {
    const tail = cardanoKeyHashToBallotField(KEY);
    tail[31] = 1;
    expect(() => cardanoKeyHashFromBallotField(tail)).toThrow(/last four bytes are not zero/);
    expect(() => cardanoKeyHashFromBallotField(new Uint8Array(32))).toThrow(/is empty/);
    expect(() => cardanoKeyHashFromBallotField(new Uint8Array(28))).toThrow(/32 bytes, got 28/);
  });
});
