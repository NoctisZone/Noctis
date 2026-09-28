// settlement-datum.test.ts — the tag every payout output carries.
//
// A payout matched on recipient and amount alone is matched by whatever else
// pays that recipient that amount, including another contract's payout. The
// tag is what makes an output name the obligation it discharges, so its
// encoding has to be exactly what the validators read: `Constr 0 [Bytes, Int]`,
// transaction id first. The schema-drift guard checks the shape against the
// blueprint; these check the bytes we actually emit.

import { type Constr, Data } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';

import {
  type OutputReferenceData,
  OutputReferenceSchema,
  SETTLEMENT_TAG_STANDIN_CBOR,
  settlementDatum,
} from '../tier-a-schemas.js';

const TX = 'ab'.repeat(32);

describe('settlementDatum', () => {
  // Used to size an output's minimum ada without the encoder. If the encoding
  // ever changes, a claim's minimum-output check would be sized wrong, and
  // this is where that shows.
  it('encodes the stand-in reference exactly as the hand-written stand-in tag', () => {
    expect(settlementDatum({ txHash: '00'.repeat(32), outputIndex: 0 })).toBe(SETTLEMENT_TAG_STANDIN_CBOR);
    expect(settlementDatum({ txHash: TX, outputIndex: 23 }).length).toBe(SETTLEMENT_TAG_STANDIN_CBOR.length);
  });

  it('encodes as constructor 0 with the transaction id first and the index second', () => {
    const decoded = Data.from(settlementDatum({ txHash: TX, outputIndex: 3 })) as Constr<unknown>;
    expect(decoded.index).toBe(0);
    expect(decoded.fields).toEqual([TX, 3n]);
  });

  it('round-trips through the schema', () => {
    const back = Data.from<OutputReferenceData>(settlementDatum({ txHash: TX, outputIndex: 7 }), OutputReferenceSchema);
    expect(back.transaction_id).toBe(TX);
    expect(back.output_index).toBe(7n);
  });

  it('gives a different tag for every output index of one transaction', () => {
    const zero = settlementDatum({ txHash: TX, outputIndex: 0 });
    const one = settlementDatum({ txHash: TX, outputIndex: 1 });
    expect(zero).not.toBe(one);
  });

  it('gives a different tag for the same index of two transactions', () => {
    const a = settlementDatum({ txHash: TX, outputIndex: 0 });
    const b = settlementDatum({ txHash: 'cd'.repeat(32), outputIndex: 0 });
    expect(a).not.toBe(b);
  });

  // Index 0 is the case a missing field silently becomes, so it has to encode
  // as a real zero rather than as nothing.
  it('encodes index 0 explicitly', () => {
    const decoded = Data.from(settlementDatum({ txHash: TX, outputIndex: 0 })) as Constr<unknown>;
    expect(decoded.fields).toEqual([TX, 0n]);
  });

  // A UTXO reference is not optional. Building a payout from a fixture that
  // never had one would otherwise produce a datum no validator accepts, and
  // the failure would surface only against a real node.
  //
  // These assert the MESSAGE, not merely that something was thrown. A bare
  // assertion here passed for years on `Cannot convert undefined to a BigInt`
  // — a crash, not a refusal — which is why the silently-coerced shapes below
  // went unnoticed: every one of them built a tag naming a different input.
  it('refuses a reference with no output index rather than guessing one', () => {
    expect(() => settlementDatum({ txHash: TX } as never)).toThrow(/outputIndex must be a non-negative integer/);
  });

  // Each of these produced index 0 — the transaction's FIRST output, which is
  // a real output belonging to somebody else's obligation.
  it.each([
    ['false', false],
    ['an empty string', ''],
    ['an empty array', []],
  ])('refuses %s as an index instead of silently reading it as 0', (_label, index) => {
    expect(() => settlementDatum({ txHash: TX, outputIndex: index } as never)).toThrow(
      /outputIndex must be a non-negative integer/,
    );
    // The control: 0 itself is a legitimate index and must still encode.
    expect(() => settlementDatum({ txHash: TX, outputIndex: 0 })).not.toThrow();
  });

  it('refuses a negative index, which BigInt passes through untouched', () => {
    expect(() => settlementDatum({ txHash: TX, outputIndex: -1 })).toThrow(/non-negative integer/);
  });

  it('refuses a non-integer index rather than reporting it as a number problem', () => {
    expect(() => settlementDatum({ txHash: TX, outputIndex: 1.5 })).toThrow(
      /outputIndex must be a non-negative integer/,
    );
  });

  // Data.Bytes() rejects non-hex and odd-length on its own, but accepts the
  // empty string — a tag naming no transaction at all.
  it.each([
    ['an empty transaction id', ''],
    ['a short transaction id', 'abcd'],
    ['a non-hex transaction id', 'zz'.repeat(32)],
  ])('refuses %s', (_label, txHash) => {
    expect(() => settlementDatum({ txHash, outputIndex: 0 })).toThrow(/txHash must be 64 hex characters/);
  });
});
