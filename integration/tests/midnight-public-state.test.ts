// Tests for midnight-public-state.ts — reading a launch's published ledger
// off the indexer, with no wallet, proof server, or transaction involved.
//
// The decoding itself is verified against the real deployed Cardano Launch gate on
// Preprod rather than here (a decoder faithful to a hand-built fixture would
// prove nothing about a real chain state). What these cover is the part a
// fixture CAN speak to: that a missing contract is reported as a missing
// contract, and that the summary carries every field through unchanged.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EligibilityGateLedger } from '../midnight-public-state.js';
import { readDarkVeilSnapshot, readEligibilityGateLedger, summarizeDarkVeil } from '../midnight-public-state.js';

vi.mock('../../contracts/midnight/compiled/eligibility_gate/contract/index.js', () => ({
  ledger: vi.fn(),
}));

const { ledger: mockLedger } = await import('../../contracts/midnight/compiled/eligibility_gate/contract/index.js');

const ADDRESS = 'a'.repeat(64);

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

/** Only the fields the snapshot reads — the rest of a real ledger is untouched. */
function fakeLedger(overrides: Partial<EligibilityGateLedger> = {}): EligibilityGateLedger {
  return {
    phase: 1,
    dvState: 2,
    dvFailed: false,
    dvPrice: 3n,
    dvAllocation: 150_000_000n,
    baseSlot: 10_000_000n,
    registrationCount: 15n,
    totalTokensCommitted: 42n,
    totalRaisedCommitted: 126n,
    allowlistRoot: bytes(0xab),
    registrantRoot: bytes(0xcd),
    settlementFinalized: false,
    fairLaunchCert: {
      launchId: bytes(0x01),
      totalParticipants: 15n,
      totalTokensAllocated: 150_000_000n,
      totalRaised: 450_000_000n,
      participationRate: 78n,
      closeTimestamp: 1_753_000_000n,
      certHash: bytes(0x02),
    },
    ...overrides,
  } as EligibilityGateLedger;
}

function fakeProvider(contractState: unknown) {
  return {
    queryContractState: vi.fn().mockResolvedValue(contractState),
  } as never;
}

beforeEach(() => {
  vi.mocked(mockLedger).mockReset();
});

describe('readEligibilityGateLedger', () => {
  it('decodes the contract state the provider returns', async () => {
    const decoded = fakeLedger();
    vi.mocked(mockLedger).mockReturnValue(decoded);
    const provider = fakeProvider({ data: 'charged-state' });

    const result = await readEligibilityGateLedger(provider, ADDRESS);

    expect(result).toBe(decoded);
    expect(mockLedger).toHaveBeenCalledWith('charged-state');
  });

  it('queries the address it was given', async () => {
    vi.mocked(mockLedger).mockReturnValue(fakeLedger());
    const provider = fakeProvider({ data: 'charged-state' });

    await readEligibilityGateLedger(provider, ADDRESS);

    expect(
      (provider as unknown as { queryContractState: ReturnType<typeof vi.fn> }).queryContractState,
    ).toHaveBeenCalledWith(ADDRESS);
  });

  it('reports a missing contract as a missing contract, naming the address', async () => {
    // The provider documents null for "nothing deployed here", which is a
    // different situation from a decode failure and deserves to say so.
    const provider = fakeProvider(null);

    await expect(readEligibilityGateLedger(provider, ADDRESS)).rejects.toThrow(/No contract found at a{64}/);
    expect(mockLedger).not.toHaveBeenCalled();
  });
});

describe('summarizeDarkVeil', () => {
  it('carries every headline figure through unchanged', () => {
    const snapshot = summarizeDarkVeil(fakeLedger());

    expect(snapshot.phase).toBe(1);
    expect(snapshot.dvState).toBe(2);
    expect(snapshot.dvFailed).toBe(false);
    expect(snapshot.dvPrice).toBe(3n);
    expect(snapshot.dvAllocation).toBe(150_000_000n);
    expect(snapshot.baseSlot).toBe(10_000_000n);
    expect(snapshot.registrationCount).toBe(15n);
    expect(snapshot.totalTokensCommitted).toBe(42n);
    expect(snapshot.totalRaisedCommitted).toBe(126n);
    expect(snapshot.settlementFinalized).toBe(false);
    expect(snapshot.fairLaunchCert.participationRate).toBe(78n);
  });

  it('hex-encodes the roots so the snapshot survives JSON', () => {
    const snapshot = summarizeDarkVeil(fakeLedger());

    expect(snapshot.allowlistRootHex).toBe('ab'.repeat(32));
    expect(snapshot.registrantRootHex).toBe('cd'.repeat(32));
    // Byte arrays serialise as objects keyed by index, which is unreadable and
    // not what a caller comparing roots against the chain would ever want.
    expect(JSON.parse(JSON.stringify({ root: snapshot.allowlistRootHex })).root).toBe('ab'.repeat(32));
  });

  it('does not carry the live map handles, which are methods rather than data', () => {
    const snapshot = summarizeDarkVeil(fakeLedger()) as unknown as Record<string, unknown>;

    expect(snapshot.lockedBonds).toBeUndefined();
    expect(snapshot.cumulativePurchases).toBeUndefined();
  });
});

describe('readDarkVeilSnapshot', () => {
  it('reads and summarises in one call', async () => {
    vi.mocked(mockLedger).mockReturnValue(fakeLedger({ registrationCount: 9n }));

    const snapshot = await readDarkVeilSnapshot(fakeProvider({ data: 'charged-state' }), ADDRESS);

    expect(snapshot.registrationCount).toBe(9n);
    expect(snapshot.dvPrice).toBe(3n);
  });
});
