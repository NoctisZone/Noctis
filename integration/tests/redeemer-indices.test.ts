// redeemer-indices.test.ts
//
// The whole point of the table this checks is that a redeemer's on-chain
// identity is a NUMBER assigned by declaration order. Insert a variant in the
// middle of an Aiken redeemer type and every variant after it renumbers, while
// off-chain code carrying the old number keeps compiling, keeps building
// transactions, and starts sending a different redeemer entirely.
//
// That already happened once: `AnchorDvAllocationRoot` was 12, became 11, and
// the transaction failed evaluation with a message naming neither the redeemer
// nor the index. These tests are what stops the next one.
//
// Two directions, and both are needed:
//   - every name we record must have the index the blueprint gives it, and
//   - every constructor the blueprint declares must be recorded here,
// so a variant ADDED to a validator fails this test rather than sitting
// unnoticed until someone needs it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BONDING_CURVE_TIER_B_REDEEMER, REDEEMER_TABLES } from '../redeemer-indices.js';

interface Blueprint {
  definitions: Record<string, { anyOf?: Array<{ title: string; index: number }> }>;
}
function load(pkg: 'cardano' | 'cardano-dex'): Blueprint {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'contracts', pkg, 'plutus.json'), 'utf8'));
}
const blueprint = load('cardano');
// The venue is a separate Aiken package with its own blueprint. A redeemer
// that crosses the boundary — the factory's, which a graduation sends — is
// pinned against the file that actually compiled it, not against the launch
// package's, which does not declare it at all.
const venueBlueprint = load('cardano-dex');

describe.each(REDEEMER_TABLES)('$definition', ({ definition, indices, package: pkg }) => {
  const declared = (pkg === 'venue' ? venueBlueprint : blueprint).definitions[definition]?.anyOf;

  it('exists in the compiled blueprint', () => {
    expect(declared, `${definition} is not in plutus.json — was the validator renamed?`).toBeDefined();
  });

  it('gives every recorded name the index the validator compiled it to', () => {
    const fromBlueprint = Object.fromEntries((declared ?? []).map((c) => [c.title, c.index]));
    // Compared whole rather than per-key: the message then shows the entire
    // shift, which is what a mid-list insertion actually looks like.
    expect(indices).toEqual(fromBlueprint);
  });

  it('records every constructor the validator declares', () => {
    expect(new Set(Object.keys(indices))).toEqual(new Set((declared ?? []).map((c) => c.title)));
  });
});

// A third direction, and the one the two above cannot cover: they only ever
// look at definitions the table already names, so a validator missing from the
// table entirely is checked by nothing. `zk_anchor/ZkAnchorRedeemer` was in
// exactly that position — five real variants, no entry, no test.
describe('the table itself', () => {
  it('names every redeemer type the blueprint declares', () => {
    const inBlueprint = Object.keys(blueprint.definitions).filter((k) => k.endsWith('Redeemer'));
    const inTable = REDEEMER_TABLES.filter((t) => t.package !== 'venue').map((t) => t.definition);
    expect(new Set(inTable)).toEqual(new Set(inBlueprint));
  });

  // The venue names most of its redeemer types after the ACTION rather than
  // after the validator, so the suffix sweep above finds none of them. This is
  // the same sweep widened to both spellings — a list of names checked by hand
  // was what left `zk_anchor` unrecorded, and the venue has seven of these.
  it('names every redeemer type the venue blueprint declares', () => {
    const inBlueprint = Object.keys(venueBlueprint.definitions).filter(
      (k) => k.endsWith('Redeemer') || k.endsWith('Action'),
    );
    const inTable = REDEEMER_TABLES.filter((t) => t.package === 'venue').map((t) => t.definition);
    expect(new Set(inTable)).toEqual(new Set(inBlueprint));
  });
});

// The specific one that was wrong, called out by name so the regression has a
// test of its own rather than only a table entry.
describe('the one that shifted', () => {
  it('anchors the DarkVeil allocation root at 11, not the 12 it used to be', () => {
    expect(BONDING_CURVE_TIER_B_REDEEMER.AnchorDvAllocationRoot).toBe(11);
    // 12 is a different redeemer now, and sending it decodes to nothing.
    expect(BONDING_CURVE_TIER_B_REDEEMER.QueryState).toBe(12);
  });
});
