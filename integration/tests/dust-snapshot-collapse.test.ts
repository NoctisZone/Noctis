// Guards over dust snapshot compaction.
//
// WHY THIS EXISTS
// Compaction rewrites the one thing a wallet needs to resume, so its failure
// mode has to be "bank the full blob", never "bank a smaller wrong one". The
// ledger is stood in by a fake that records what was collapsed, which is what
// lets each refusal be driven on purpose: a missing own leaf, a root that
// moved, a debug string with nothing to read. The real ledger was exercised
// against a real Preprod snapshot (6.5 MB → 164 KB, roots and balance equal);
// these pin the decisions around it.

import { describe, expect, it } from 'vitest';
import {
  collapseDustSnapshotBlob,
  compactingDustSerializer,
  type DustLedger,
  type DustStateSource,
  foreignRanges,
  parseOwnGeneration,
} from '../dust-snapshot-collapse.js';

const NIGHT_A = 'aa'.repeat(32);
const NIGHT_B = 'bb'.repeat(32);

/** The debug form's two fields, in the shape `DustLocalState.toString(true)` prints them. */
function debugText(firstFree: number, nights: Record<string, number>): string {
  const entries = Object.entries(nights)
    .map(([night, index]) => `InitialNonce(${night}): ${index}`)
    .join(', ');
  return (
    `generating_tree: MerkleTree(root = Some(01)) {0..=3: <collapsed>}, generating_tree_first_free: ${firstFree}, ` +
    `commitment_tree: MerkleTree(root = Some(02)) {}, commitment_tree_first_free: 9, night_indices: {${entries}}, utxos: {}`
  );
}

interface FakeOptions {
  firstFree?: number;
  nights?: Record<string, number>;
  utxoNights?: string[];
  /** Make the restored copy report a different generation root. */
  rootDrifts?: boolean;
  text?: string;
}

/** A stand-in DustLocalState: records every collapse and serializes to a marker. */
function fakeLedger(opts: FakeOptions = {}) {
  const collapsed: [bigint, bigint][] = [];
  const nights = opts.nights ?? { [NIGHT_A]: 2, [NIGHT_B]: 5 };
  const utxos = (opts.utxoNights ?? [NIGHT_A]).map((backingNight) => ({ backingNight }));
  const syncTime = new Date('2026-10-04T00:00:00Z');
  const state = (compacted: boolean, root: string) => ({
    utxos,
    syncTime,
    toString: () => opts.text ?? debugText(opts.firstFree ?? 8, nights),
    collapseGenerationTree(lo: bigint, hi: bigint) {
      collapsed.push([lo, hi]);
      return state(true, root);
    },
    serialize: () => Uint8Array.from(compacted ? [0xc0] : [0xf0, 0xf1, 0xf2]),
    generatingTreeRoot: () => BigInt(root),
    commitmentTreeRoot: () => 77n,
    walletBalance: () => 1_000n,
  });
  const api = {
    DustLocalState: {
      deserialize: (raw: Uint8Array) => state(raw[0] === 0xc0, raw[0] === 0xc0 && opts.rootDrifts ? '999' : '42'),
    },
  } as unknown as DustLedger;
  return { api, collapsed, full: () => state(false, '42') };
}

const blobOf = (stateHex: string) => JSON.stringify({ publicKey: { publicKey: '7' }, state: stateHex, offset: '12' });

describe('parseOwnGeneration', () => {
  it('reads the first free index and every own night index', () => {
    const own = parseOwnGeneration(debugText(404462, { [NIGHT_A]: 393791, [NIGHT_B]: 399639 }));
    expect(own?.firstFree).toBe(404462n);
    expect(own?.nightIndices.get(NIGHT_A)).toBe(393791n);
    expect(own?.nightIndices.get(NIGHT_B)).toBe(399639n);
  });

  it('returns null when the debug form lacks either field', () => {
    expect(parseOwnGeneration('generating_tree_first_free: 5')).toBeNull();
    expect(parseOwnGeneration('night_indices: {}')).toBeNull();
  });
});

describe('foreignRanges', () => {
  it('covers exactly the indices below firstFree that are not kept', () => {
    expect(foreignRanges([2n, 5n], 8n)).toEqual([
      [0n, 1n],
      [3n, 4n],
      [6n, 7n],
    ]);
  });

  it('leaves nothing out at either end, and nothing when everything is kept', () => {
    expect(foreignRanges([0n, 7n], 8n)).toEqual([[1n, 6n]]);
    expect(foreignRanges([0n, 1n, 2n], 3n)).toEqual([]);
    expect(foreignRanges([], 4n)).toEqual([[0n, 3n]]);
  });

  it('ignores indices outside the used part of the tree rather than widening a range', () => {
    expect(foreignRanges([5n, 99n, -1n], 6n)).toEqual([[0n, 4n]]);
  });
});

describe('collapseDustSnapshotBlob', () => {
  it('collapses every foreign range and banks the compacted state, keeping the other fields', () => {
    const { api, collapsed } = fakeLedger();
    const result = collapseDustSnapshotBlob(blobOf('f0f1f2'), api);
    expect(result.collapsed).toBe(true);
    expect(collapsed).toEqual([
      [0n, 1n],
      [3n, 4n],
      [6n, 7n],
    ]);
    const banked = JSON.parse(result.blob);
    expect(banked.state).toBe('c0');
    expect(banked.offset).toBe('12');
    expect(banked.publicKey).toEqual({ publicKey: '7' });
    expect(result).toMatchObject({ fullBytes: 3, bytes: 1, ranges: 3, ownLeaves: 2 });
  });

  it('returns the original blob when an own UTXO is backed by a night the index does not list', () => {
    const { api, collapsed } = fakeLedger({ utxoNights: [NIGHT_A, 'cc'.repeat(32)] });
    const blob = blobOf('f0f1f2');
    const result = collapseDustSnapshotBlob(blob, api);
    expect(result.collapsed).toBe(false);
    expect(result.blob).toBe(blob);
    expect(result.reason).toMatch(/not in night_indices/);
    expect(collapsed).toEqual([]);
  });

  it('returns the original blob when the compacted state does not restore to the same root', () => {
    const { api } = fakeLedger({ rootDrifts: true });
    const blob = blobOf('f0f1f2');
    const result = collapseDustSnapshotBlob(blob, api);
    expect(result.collapsed).toBe(false);
    expect(result.blob).toBe(blob);
    expect(result.reason).toMatch(/same roots, balance and UTXOs/);
  });

  it('returns the original blob when the debug form has nothing to read', () => {
    const { api } = fakeLedger({ text: 'DustLocalState { }' });
    const blob = blobOf('f0f1f2');
    expect(collapseDustSnapshotBlob(blob, api)).toMatchObject({ collapsed: false, blob });
  });

  it('never throws on a blob that is not a dust snapshot', () => {
    const { api } = fakeLedger();
    expect(collapseDustSnapshotBlob('not json', api)).toMatchObject({ collapsed: false, blob: 'not json' });
    expect(collapseDustSnapshotBlob('{"state":"zz"}', api).collapsed).toBe(false);
  });
});

describe('compactingDustSerializer', () => {
  it('compacts from the same emission it serializes, and lets go of the stream', async () => {
    const { api, full } = fakeLedger();
    let unsubscribed = 0;
    const emission = { serialize: () => blobOf('f0f1f2'), state: { state: full() } };
    // Emits during subscribe(), the way a replaying wallet-state stream does.
    const source = {
      state: {
        subscribe(observer: { next(value: unknown): void }) {
          observer.next(emission);
          return { unsubscribe: () => unsubscribed++ };
        },
      },
    } as unknown as DustStateSource;
    const seen: boolean[] = [];
    const blob = await compactingDustSerializer(source, (r) => seen.push(r.collapsed), api).serializeState();
    expect(JSON.parse(blob).state).toBe('c0');
    expect(seen).toEqual([true]);
    expect(unsubscribed).toBe(1);
  });
});
