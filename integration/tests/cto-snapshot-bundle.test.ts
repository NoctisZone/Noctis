import { describe, expect, it } from 'vitest';
import { buildBalanceSnapshotTree, deriveUserPublicKey } from '../../packages/zk-proofs/src/cto-governance.js';
import { buildSnapshotBundle, entryRecomputesRoot, proofEntriesFrom } from '../cto-snapshot-bundle.js';
import { deriveUserSecretFromSeed } from '../midnight-user-identity.js';

const hex = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32);
const LAUNCH = hex(0x09);

describe('buildSnapshotBundle', () => {
  it('derives a seed-named voter key exactly as the contract derives it, and the root matches the tree builder', () => {
    const bundle = buildSnapshotBundle(LAUNCH, [
      { label: 'buyer_1', voterSeedHex: hex(0x11), balance: '5000000', heldSinceTimestamp: '1700000000' },
      { label: 'buyer_2', voterKeyHex: hex(0x22), balance: 7_000_000, heldSinceTimestamp: 1_700_000_001 },
    ]);

    const expectedKey = deriveUserPublicKey(
      deriveUserSecretFromSeed(Uint8Array.from(Buffer.from(hex(0x11), 'hex'))),
      Uint8Array.from(Buffer.from(LAUNCH, 'hex')),
    );
    expect(bundle.entries[0].voterKeyHex).toBe(Buffer.from(expectedKey).toString('hex'));
    expect(bundle.entries[1].voterKeyHex).toBe(hex(0x22));

    const tree = buildBalanceSnapshotTree([
      { voterKey: expectedKey, balance: 5_000_000n, heldSinceTimestamp: 1_700_000_000n },
      {
        voterKey: Uint8Array.from(Buffer.from(hex(0x22), 'hex')),
        balance: 7_000_000n,
        heldSinceTimestamp: 1_700_000_001n,
      },
    ]);
    expect(bundle.rootHex).toBe(Buffer.from(tree.root).toString('hex'));
    expect(bundle.entries.map((e) => e.leafIndex)).toEqual([0, 1]);
    expect(bundle.entries[0].proof).toHaveLength(20);
  });

  it('every entry recomputes the root from its own leaf and path, and a tampered balance does not', () => {
    const bundle = buildSnapshotBundle(LAUNCH, [
      { voterKeyHex: hex(0x31), balance: '1', heldSinceTimestamp: '0' },
      { voterKeyHex: hex(0x32), balance: '2', heldSinceTimestamp: '0' },
      { voterKeyHex: hex(0x33), balance: '3', heldSinceTimestamp: '0' },
    ]);
    for (const entry of bundle.entries) {
      expect(entryRecomputesRoot(entry, bundle.rootHex)).toBe(true);
    }
    expect(entryRecomputesRoot({ ...bundle.entries[1], balance: '20' }, bundle.rootHex)).toBe(false);
    expect(entryRecomputesRoot({ ...bundle.entries[1], heldSinceTimestamp: '1' }, bundle.rootHex)).toBe(false);
  });

  it('is deterministic — the same entries give the same root', () => {
    const a = buildSnapshotBundle(LAUNCH, [{ voterKeyHex: hex(0x41), balance: '10', heldSinceTimestamp: '5' }]);
    const b = buildSnapshotBundle(LAUNCH, [{ voterKeyHex: hex(0x41), balance: '10', heldSinceTimestamp: '5' }]);
    expect(a.rootHex).toBe(b.rootHex);
    // Pinned against the tree builder the contract's parity tests drive, so
    // a change to the leaf or node hash cannot pass silently.
    const tree = buildBalanceSnapshotTree([
      { voterKey: Uint8Array.from(Buffer.from(hex(0x41), 'hex')), balance: 10n, heldSinceTimestamp: 5n },
    ]);
    expect(a.rootHex).toBe(Buffer.from(tree.root).toString('hex'));
  });

  it('turns a bundle entry back into the witness shape', () => {
    const bundle = buildSnapshotBundle(LAUNCH, [{ voterKeyHex: hex(0x51), balance: '1', heldSinceTimestamp: '0' }]);
    const proof = proofEntriesFrom(bundle.entries[0]);
    expect(proof).toHaveLength(20);
    expect(proof[0].sibling).toHaveLength(32);
    expect(typeof proof[0].goesLeft).toBe('boolean');
  });

  it('refuses a zero balance, a repeated voter, both key and seed, and neither', () => {
    expect(() =>
      buildSnapshotBundle(LAUNCH, [{ voterKeyHex: hex(0x61), balance: '0', heldSinceTimestamp: '0' }]),
    ).toThrow(/balance must be positive/);
    expect(() =>
      buildSnapshotBundle(LAUNCH, [
        { voterKeyHex: hex(0x61), balance: '1', heldSinceTimestamp: '0' },
        { voterKeyHex: hex(0x61), balance: '2', heldSinceTimestamp: '0' },
      ]),
    ).toThrow(/repeats the voter key/);
    expect(() =>
      buildSnapshotBundle(LAUNCH, [
        { voterKeyHex: hex(0x61), voterSeedHex: hex(0x62), balance: '1', heldSinceTimestamp: '0' },
      ]),
    ).toThrow(/not both/);
    expect(() => buildSnapshotBundle(LAUNCH, [{ balance: '1', heldSinceTimestamp: '0' }])).toThrow(
      /needs voterKeyHex or voterSeedHex/,
    );
    expect(() => buildSnapshotBundle(LAUNCH, [])).toThrow(/non-empty/);
  });
});
