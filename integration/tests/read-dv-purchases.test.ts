// Tests for read-dv-purchases.ts — the governor-side read of every real
// DarkVeil purchase out of eligibility_gate.compact's ledger.
//
// WHY THIS MATTERS
// What this returns becomes the allocation Merkle tree, and that root is
// anchored on Cardano under an Inactive-only redeemer. A key encoded one
// character short, or an amount that lost precision on the way through, does
// not surface as an error — it surfaces as a buyer whose proof does not
// verify, after the root can no longer be replaced.
//
// The module's own docstring called extractDvPurchases "trivially testable".
// It was, and it wasn't tested.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../contracts/midnight/compiled/eligibility_gate/contract/index.js', () => ({
  ledger: vi.fn(),
}));

import { ledger } from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import {
  type DecodedEligibilityGateLedger,
  extractDvPurchases,
  extractFairLaunchCert,
  extractSettledPurchases,
  readDvPurchases,
} from '../read-dv-purchases.js';

/** The hex of the key() below, whose first byte is the one given. */
const keyHex = (firstByte: number) => firstByte.toString(16).padStart(2, '0') + '00'.repeat(30) + 'ff';

/** A 32-byte Midnight user public key whose first byte is the one given. */
function key(firstByte: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = firstByte;
  bytes[31] = 0xff;
  return bytes;
}

function decoded(entries: [Uint8Array, bigint][]): DecodedEligibilityGateLedger {
  return { dvTokensPurchased: entries };
}

describe('extractDvPurchases', () => {
  it('returns one entry per real purchase, in ledger order', async () => {
    const result = extractDvPurchases(
      decoded([
        [key(0x01), 100n],
        [key(0x02), 250n],
      ]),
    );
    expect(result.map((p) => p.dvAmount)).toEqual(['100', '250']);
    expect(result[0].userPubKeyHex.startsWith('01')).toBe(true);
    expect(result[1].userPubKeyHex.startsWith('02')).toBe(true);
  });

  it('drops a zero-amount entry', async () => {
    // revealBuyCommit always increments by a positive amount, so a zero is
    // not something the contract writes — it is filtered because a leaf for a
    // buyer who bought nothing would still be a claimable leaf.
    expect(extractDvPurchases(decoded([[key(0x01), 0n]]))).toEqual([]);
  });

  it('drops a negative amount rather than encoding it', async () => {
    expect(extractDvPurchases(decoded([[key(0x01), -5n]]))).toEqual([]);
  });

  it('returns an empty list for an empty ledger', async () => {
    expect(extractDvPurchases(decoded([]))).toEqual([]);
  });

  it('pads a byte below 0x10 to two hex characters', async () => {
    // The failure this guards: without padding, 0x0a renders as "a" and the
    // key is 63 characters instead of 64. It still looks like hex, still
    // round-trips through JSON, and hashes to a leaf nobody can prove.
    const bytes = new Uint8Array(32);
    bytes[0] = 0x0a;
    bytes[1] = 0x00;
    const [purchase] = extractDvPurchases(decoded([[bytes, 1n]]));
    expect(purchase.userPubKeyHex.slice(0, 4)).toBe('0a00');
    expect(purchase.userPubKeyHex).toHaveLength(64);
  });

  it('encodes a high byte in lowercase', async () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0xff;
    bytes[1] = 0xab;
    const [purchase] = extractDvPurchases(decoded([[bytes, 1n]]));
    expect(purchase.userPubKeyHex.slice(0, 4)).toBe('ffab');
  });

  it('keeps an amount larger than Number.MAX_SAFE_INTEGER exact', async () => {
    // This is the whole reason dvAmount is a decimal string rather than a
    // number: a full-supply purchase exceeds 2^53, and going through a float
    // loses the low digits silently.
    const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    const [purchase] = extractDvPurchases(decoded([[key(0x01), huge]]));
    expect(purchase.dvAmount).toBe('9007199254740993');
    expect(BigInt(purchase.dvAmount)).toBe(huge);
  });

  it('keeps two buyers with the same amount as two separate entries', async () => {
    const result = extractDvPurchases(
      decoded([
        [key(0x01), 500n],
        [key(0x02), 500n],
      ]),
    );
    expect(result).toHaveLength(2);
    expect(result[0].userPubKeyHex).not.toBe(result[1].userPubKeyHex);
  });
});

describe('extractSettledPurchases', () => {
  it('keeps a recorded zero, unlike the revealed purchases', () => {
    // There a zero cannot legitimately occur. Here one is a real observation —
    // a buyer the relayer looked at and found had claimed nothing — and it is
    // a different thing from a buyer nobody has looked at yet. The forfeiture
    // sweep treats those two differently, so nothing upstream may flatten
    // them together.
    const out = extractSettledPurchases({
      dvTokensPurchased: [],
      settledDvPurchases: [
        [key(0x01), 0n],
        [key(0x02), 400n],
      ],
    });
    expect(out).toEqual([
      { userPubKeyHex: keyHex(0x01), dvAmount: '0' },
      { userPubKeyHex: keyHex(0x02), dvAmount: '400' },
    ]);
  });

  it('reads an absent map as nothing recorded', () => {
    expect(extractSettledPurchases({ dvTokensPurchased: [] })).toEqual([]);
  });
});

describe('readDvPurchases', () => {
  const mockedLedger = vi.mocked(ledger);

  function provider(state: unknown) {
    return {
      queryContractState: vi.fn(async () => state),
    } as unknown as Parameters<typeof readDvPurchases>[0];
  }

  it('reports not-deployed without attempting to decode', async () => {
    // A contract that is not there yet is a normal state during setup, not an
    // error — but decoding null would be.
    mockedLedger.mockClear();
    const result = await readDvPurchases(provider(null), 'addr_contract');
    // certificate is null rather than absent: a caller checking for one must
    // get the same answer shape whether or not the contract exists.
    expect(result).toEqual({ deployed: false, purchases: [], settled: [], certificate: null });
    expect(mockedLedger).not.toHaveBeenCalled();
  });

  it('reports the live registrant count while the certificate still reads zero', async () => {
    // The bug this pins: a launch page showed "0 wallets registered" through a
    // whole registration phase. The certificate's totalParticipants is stamped
    // by closeDarkVeil, so before the close it is genuinely zero however many
    // wallets have bonded — reading it as the registrant count is reading the
    // wrong field, not reading a stale one.
    mockedLedger.mockReturnValue({
      dvTokensPurchased: [],
      registrationCount: 15n,
      dvAllocation: 150_000_000n,
      dvPrice: 3n,
      baseSlot: 0n,
      fairLaunchCert: {
        launchId: key(0x01),
        totalParticipants: 0n,
        totalTokensAllocated: 0n,
        totalRaised: 0n,
        participationRate: 0n,
        closeTimestamp: 0n,
        certHash: key(0x00),
      },
    } as unknown as ReturnType<typeof ledger>);

    const result = await readDvPurchases(provider({ data: 'opaque-state' }), 'addr_contract');

    expect(result.registrationCount).toBe('15');
    expect(result.certificate?.totalParticipants).toBe('0');
    expect(result.dvAllocation).toBe('150000000');
    expect(result.dvPrice).toBe('3');
  });

  it('reports zero for the running figures a contract has not set yet', async () => {
    mockedLedger.mockReturnValue(decoded([]) as unknown as ReturnType<typeof ledger>);
    const result = await readDvPurchases(provider({ data: 'opaque-state' }), 'addr_contract');
    // Absent and zero mean the same thing here, and a page formatting a number
    // should not have to tell them apart.
    expect(result.registrationCount).toBe('0');
    expect(result.baseSlot).toBe('0');
  });

  it('decodes the queried state and returns its real purchases', async () => {
    mockedLedger.mockReturnValue(decoded([[key(0x07), 42n]]) as unknown as ReturnType<typeof ledger>);
    const result = await readDvPurchases(provider({ data: 'opaque-state' }), 'addr_contract');
    expect(result.deployed).toBe(true);
    expect(result.purchases).toHaveLength(1);
    expect(result.purchases[0].dvAmount).toBe('42');
  });

  it('passes the contract state through to the generated decoder untouched', async () => {
    // The decoder is the compiled contract's own; handing it anything other
    // than the exact `.data` it was given is how a decode silently produces
    // an empty ledger instead of throwing.
    mockedLedger.mockReturnValue(decoded([]) as unknown as ReturnType<typeof ledger>);
    const state = { data: { marker: 'exact-object' } };
    await readDvPurchases(provider(state), 'addr_contract');
    expect(mockedLedger).toHaveBeenCalledWith(state.data);
  });

  it('queries the contract address it was given', async () => {
    mockedLedger.mockReturnValue(decoded([]) as unknown as ReturnType<typeof ledger>);
    const p = provider({ data: {} });
    await readDvPurchases(p, 'addr_specific_contract');
    expect(vi.mocked(p.queryContractState)).toHaveBeenCalledWith('addr_specific_contract');
  });
});

describe('extractFairLaunchCert', () => {
  const cert = (closeTimestamp: bigint) => ({
    dvTokensPurchased: [] as [Uint8Array, bigint][],
    baseSlot: 16_666_666n,
    fairLaunchCert: {
      launchId: new Uint8Array([0xab, 0xcd]),
      totalParticipants: 9n,
      totalTokensAllocated: 94_666_664n,
      totalRaised: 283_999_992n,
      participationRate: 63n,
      closeTimestamp,
      certHash: new Uint8Array([0x01, 0x02]),
    },
  });

  it('returns null when the contract publishes no certificate', () => {
    expect(extractFairLaunchCert({ dvTokensPurchased: [] })).toBeNull();
  });

  // A zero close timestamp is the contract's "DarkVeil has not closed" state.
  // Reporting that as a real certificate would put unfinished figures on a
  // page that presents them as cryptographically settled.
  it('reports a certificate as not closed while closeTimestamp is zero', () => {
    expect(extractFairLaunchCert(cert(0n))?.closed).toBe(false);
  });

  it('reports closed once the contract stamps a close timestamp', () => {
    expect(extractFairLaunchCert(cert(1_786_000_000n))?.closed).toBe(true);
  });

  // Every figure crosses a JSON boundary, where a bigint does not survive.
  it('stringifies every numeric field so none is lost crossing to PHP', () => {
    const out = extractFairLaunchCert(cert(1_786_000_000n));
    expect(out).toMatchObject({
      totalParticipants: '9',
      totalTokensAllocated: '94666664',
      totalRaised: '283999992',
      participationRate: '63',
      closeTimestamp: '1786000000',
      baseSlot: '16666666',
      launchIdHex: 'abcd',
      certHashHex: '0102',
    });
    for (const [key, value] of Object.entries(out ?? {})) {
      if (key !== 'closed') expect(typeof value, key).toBe('string');
    }
  });
});
