import { describe, expect, it } from 'vitest';
import {
  buildDvAllocationTree,
  dvLeafOrderKey,
  hashDvLeaf,
  hashDvNode,
  verifyDvMerkleProof,
} from '../dv-allocation-tree.js';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

describe('hashDvLeaf / hashDvNode — ground truth', () => {
  it('matches real values extracted from a live aiken check run against bonding_curve_tier_b.ak', () => {
    // Re-derived 2026-08-05 when the leaf gained its index. Three-way
    // agreement, not two: computed independently in Python, asserted as
    // literals by `hash_dv_leaf_matches_the_offchain_tree_builder` in
    // bonding_curve_tier_b.ak, and asserted here. A drift in any one of the
    // three fails a test rather than silently invalidating every proof.
    const leaf0 = hashDvLeaf(new Uint8Array([0xaa]), 100n, 0, new Uint8Array([0x01]));
    const leaf1 = hashDvLeaf(new Uint8Array([0xbb]), 200n, 1, new Uint8Array([0x02]));
    const node = hashDvNode(leaf0, leaf1);

    expect(hex(leaf0)).toBe('EB01560639A5CD1228C9424A325C02CF30DBDD15256E0012A718AF2B1D4C5578');
    expect(hex(leaf1)).toBe('49A01736C806987B039B2F0B076989C8166A8119ABDF71E8101018D29C6287B6');
    expect(hex(node)).toBe('737DD30DD854D1FD266D50006B5EFC236B827B8A55F521A10FC2811951F0F70D');
  });
});

describe('buildDvAllocationTree', () => {
  const entry = (b: number, amount: bigint, s: number) => ({
    vkh: new Uint8Array([b]),
    dvAmount: amount,
    salt: new Uint8Array([s]),
  });

  it('single entry — root equals the leaf, empty proof', () => {
    const entries = [entry(0xaa, 100n, 0x01)];
    const tree = buildDvAllocationTree(entries);
    const leaf = hashDvLeaf(entries[0].vkh, entries[0].dvAmount, 0, entries[0].salt);
    expect(hex(tree.root)).toBe(hex(leaf));
    expect(tree.getProof(0)).toEqual([]);
    expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(0))).toBe(true);
  });

  it('two entries — the root is the node over its own two leaves, in its own order', () => {
    // The ground-truth root above pins hashDvLeaf/hashDvNode against the
    // Aiken side and is unaffected by any of this. What this checks is the
    // builder agreeing with those primitives — asserted over the order the
    // builder chose, because the order it is handed is no longer the order it
    // uses.
    const tree = buildDvAllocationTree([entry(0xaa, 100n, 0x01), entry(0xbb, 200n, 0x02)]);
    const leaves = tree.entries.map((e, i) => hashDvLeaf(e.vkh, e.dvAmount, i, e.salt));
    expect(hex(tree.root)).toBe(hex(hashDvNode(leaves[0], leaves[1])));
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyDvMerkleProof(tree.root, leaves[i], tree.getProof(i))).toBe(true);
    }
  });

  it('odd entry count (3) — self-pairing round-trips correctly for every leaf', () => {
    const tree = buildDvAllocationTree([entry(0x01, 10n, 0xa1), entry(0x02, 20n, 0xa2), entry(0x03, 30n, 0xa3)]);
    for (let i = 0; i < tree.entries.length; i++) {
      const e = tree.entries[i];
      const leaf = hashDvLeaf(e.vkh, e.dvAmount, i, e.salt);
      expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    }
  });

  it('larger, non-power-of-two count (7) — every leaf round-trips', () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry(0x10 + i, BigInt(100 + i), 0x50 + i));
    const tree = buildDvAllocationTree(entries);
    expect(tree.entries).toHaveLength(7);
    for (let i = 0; i < tree.entries.length; i++) {
      const e = tree.entries[i];
      const leaf = hashDvLeaf(e.vkh, e.dvAmount, i, e.salt);
      expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
      expect(tree.leafIndexOf(e.vkh)).toBe(i);
    }
  });

  it('a proof for one leaf does not verify against a different leaf (no cross-leaf forgery)', () => {
    const tree = buildDvAllocationTree([entry(0x01, 10n, 0xa1), entry(0x02, 20n, 0xa2), entry(0x03, 30n, 0xa3)]);
    const second = tree.entries[1];
    const wrongLeaf = hashDvLeaf(second.vkh, second.dvAmount, 1, second.salt);
    expect(verifyDvMerkleProof(tree.root, wrongLeaf, tree.getProof(0))).toBe(false);
  });

  it('rejects an empty entry list', () => {
    expect(() => buildDvAllocationTree([])).toThrow(/at least one entry is required/);
  });

  it('rejects an out-of-range proof index', () => {
    const tree = buildDvAllocationTree([entry(0xaa, 1n, 0x01)]);
    expect(() => tree.getProof(1)).toThrow(/leafIndex 1 out of range \(0\.\.0\)/);
    expect(() => tree.getProof(-1)).toThrow(/leafIndex -1 out of range \(0\.\.0\)/);
  });
});

/**
 * The sort exists for two reasons and they are tested separately, because
 * only one of them is a privacy property and the other is a correctness one.
 */
describe('buildDvAllocationTree — leaf order', () => {
  const entry = (b: number, amount: bigint, s: number) => ({
    vkh: new Uint8Array([b]),
    dvAmount: amount,
    salt: new Uint8Array([s]),
  });

  it('does not use the order it was handed', () => {
    // The privacy property, stated as a fact rather than an intention: a
    // claimant publishes their leaf index, so if the index were the input
    // position, every claim would publish where its buyer sat in the
    // governor's list. These two entries come back the other way round.
    const first = entry(0xaa, 100n, 0x01);
    const second = entry(0xbb, 200n, 0x02);
    const tree = buildDvAllocationTree([first, second]);
    expect(tree.leafIndexOf(first.vkh)).toBe(1);
    expect(tree.leafIndexOf(second.vkh)).toBe(0);
  });

  it('orders by the salt-derived key, not by key hash or amount', () => {
    const entries = Array.from({ length: 9 }, (_, i) => entry(0x20 + i, BigInt(1000 - i), 0x70 + i));
    const tree = buildDvAllocationTree(entries);
    const keys = tree.entries.map((e) => Buffer.from(dvLeafOrderKey(e.vkh, e.salt)).toString('hex'));
    expect(keys).toEqual([...keys].sort());
  });

  it('gives one root and one index per buyer whatever order the list arrives in', () => {
    // The correctness property, and the reason this is a sort rather than a
    // shuffle. Two CLIs build this tree independently from their own copy of
    // the list: one anchors the root, the other serves proofs against it. If
    // the order of the copy could change the tree, two lists differing only
    // in order would anchor one root and prove another, and every claim would
    // fail with nothing to point at.
    const entries = Array.from({ length: 6 }, (_, i) => entry(0x30 + i, BigInt(50 + i), 0x80 + i));
    const reversed = [...entries].reverse();
    const rotated = [...entries.slice(2), ...entries.slice(0, 2)];

    const a = buildDvAllocationTree(entries);
    const b = buildDvAllocationTree(reversed);
    const c = buildDvAllocationTree(rotated);

    expect(hex(b.root)).toBe(hex(a.root));
    expect(hex(c.root)).toBe(hex(a.root));
    for (const e of entries) {
      const i = a.leafIndexOf(e.vkh);
      expect(b.leafIndexOf(e.vkh)).toBe(i);
      expect(c.leafIndexOf(e.vkh)).toBe(i);
      expect(b.getProof(i)).toEqual(a.getProof(i));
    }
  });

  it('reports -1 for a wallet that did not buy', () => {
    const tree = buildDvAllocationTree([entry(0x01, 10n, 0xa1), entry(0x02, 20n, 0xa2)]);
    expect(tree.leafIndexOf(new Uint8Array([0x99]))).toBe(-1);
  });

  it('refuses two allocations for one key hash', () => {
    // Ambiguous rather than merely odd: leafIndexOf would serve the first and
    // strand the second, and the claim path binds a leaf to a signing key.
    expect(() => buildDvAllocationTree([entry(0x01, 10n, 0xa1), entry(0x01, 20n, 0xa2)])).toThrow(
      /duplicate key hash 01/,
    );
  });
});
