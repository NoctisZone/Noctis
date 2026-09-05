// The compiled-Compact ZK artifact fingerprint, and each drift class it exists
// to catch.
//
// WHY THIS IS PINNED
// The algorithm has a twin in build.mjs, which computes the value at build time
// and injects it into the bundle that proves against these artifacts. Two
// implementations in two languages of the same handful of lines: nothing but a
// pinned fixture stops one drifting from the other, and if they drift the
// deployed CLI either refuses every artifact set or — worse — accepts a stale
// one.
//
// The tests below are written as "change exactly one thing, and the fingerprint
// must move", because a fingerprint that does not move is indistinguishable
// from one that is not being computed at all.
//
// If a value below changes, the algorithm changed. Change build.mjs to match in
// the same commit, or put it back.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkZkConfigAgainst, zkConfigFingerprint, zkConfigLines } from '../zk-config-fingerprint.js';

const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

interface Artifacts {
  info?: unknown;
  verifiers?: Record<string, string>;
  provers?: Record<string, string>;
  extra?: Record<string, string>;
}

/** Build a minimal artifact tree of the shape NodeZkConfigProvider is given. */
function makeTree(a: Artifacts = {}): string {
  const base = mkdtempSync(join(tmpdir(), 'noctis-zk-'));
  made.push(base);
  mkdirSync(join(base, 'compiler'), { recursive: true });
  mkdirSync(join(base, 'keys'), { recursive: true });
  writeFileSync(
    join(base, 'compiler', 'contract-info.json'),
    JSON.stringify(a.info ?? { 'compiler-version': '0.31.1', circuits: [{ name: 'checkCap' }] }),
  );
  for (const [n, body] of Object.entries(a.verifiers ?? { 'checkCap.verifier': 'V' })) {
    writeFileSync(join(base, 'keys', n), body);
  }
  for (const [n, body] of Object.entries(a.provers ?? { 'checkCap.prover': 'PPPP' })) {
    writeFileSync(join(base, 'keys', n), body);
  }
  for (const [n, body] of Object.entries(a.extra ?? {})) {
    writeFileSync(join(base, 'keys', n), body);
  }
  return base;
}

describe('zkConfigFingerprint', () => {
  it('is stable across two identical trees in different directories', () => {
    // The path must not be an input: the same artifacts are read from a repo
    // checkout on one machine and a deploy directory on another.
    expect(zkConfigFingerprint(makeTree())).toBe(zkConfigFingerprint(makeTree()));
  });

  it('ignores formatting and key order in contract-info.json', () => {
    // A re-serialised copy of the same ABI describes the same contract. If
    // formatting moved the hash, every deploy would cry wolf.
    const a = makeTree({ info: { b: 2, a: 1, nested: { y: 'y', x: 'x' } } });
    const b = makeTree({ info: { nested: { x: 'x', y: 'y' }, a: 1, b: 2 } });
    expect(zkConfigFingerprint(a)).toBe(zkConfigFingerprint(b));
  });

  // ---- the drift classes, one changed thing each ------------------------

  it('moves when the contract INTERFACE changes', () => {
    const before = makeTree({ info: { circuits: [{ name: 'checkCap' }] } });
    const after = makeTree({ info: { circuits: [{ name: 'checkCap' }, { name: 'newCircuit' }] } });
    expect(zkConfigFingerprint(after)).not.toBe(zkConfigFingerprint(before));
  });

  it('moves when the compiler version changes, with an identical interface', () => {
    const before = makeTree({ info: { 'compiler-version': '0.31.1', circuits: [] } });
    const after = makeTree({ info: { 'compiler-version': '0.32.0', circuits: [] } });
    expect(zkConfigFingerprint(after)).not.toBe(zkConfigFingerprint(before));
  });

  it("moves when a circuit's BODY changes but its signature does not", () => {
    // This is the case contract-info.json alone cannot see: same ABI, different
    // verifier key. It is why the verifier keys are hashed rather than trusted
    // to be implied by the ABI.
    const before = makeTree({ verifiers: { 'checkCap.verifier': 'V1' } });
    const after = makeTree({ verifiers: { 'checkCap.verifier': 'V2' } });
    expect(zkConfigFingerprint(after)).not.toBe(zkConfigFingerprint(before));
  });

  it('moves when a prover key is truncated', () => {
    // Prover keys are 79 MB in the real tree and are not hashed. Length alone
    // has to carry the "this file is not intact" signal.
    const before = makeTree({ provers: { 'checkCap.prover': 'PPPP' } });
    const after = makeTree({ provers: { 'checkCap.prover': 'PP' } });
    expect(zkConfigFingerprint(after)).not.toBe(zkConfigFingerprint(before));
  });

  it('moves when a circuit is missing entirely', () => {
    const both = makeTree({
      verifiers: { 'a.verifier': 'A', 'b.verifier': 'B' },
      provers: { 'a.prover': 'PA', 'b.prover': 'PB' },
    });
    const one = makeTree({ verifiers: { 'a.verifier': 'A' }, provers: { 'a.prover': 'PA' } });
    expect(zkConfigFingerprint(one)).not.toBe(zkConfigFingerprint(both));
  });

  it('does NOT move for unrecognised litter beside the keys', () => {
    // Editor and OS droppings are not evidence about the circuits. Folding them
    // in would produce failures that teach people to bypass the check.
    const clean = makeTree();
    const littered = makeTree({ extra: { '.DS_Store': 'junk', 'notes.txt': 'hello' } });
    expect(zkConfigFingerprint(littered)).toBe(zkConfigFingerprint(clean));
  });

  // ---- refusal, not silence --------------------------------------------

  it('throws rather than returning a value when the artifacts are absent', () => {
    // The failure this guard exists to prevent IS a missing directory, so
    // "cannot read" must never quietly become "matches".
    expect(() => zkConfigFingerprint(join(tmpdir(), 'noctis-zk-does-not-exist'))).toThrow(/ENOENT/);
  });

  it('throws when contract-info.json is present but not valid JSON', () => {
    const base = makeTree();
    writeFileSync(join(base, 'compiler', 'contract-info.json'), '{ truncated');
    expect(() => zkConfigFingerprint(base)).toThrow();
  });

  // ---- the twin ---------------------------------------------------------

  it('matches the algorithm build.mjs implements', () => {
    // Spelled out longhand rather than imported, so a change to the exported
    // function that build.mjs did not receive shows up here.
    const base = makeTree();
    const lines = zkConfigLines(base);
    const theTwinsAlgorithm = createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
    expect(zkConfigFingerprint(base)).toBe(theTwinsAlgorithm);
  });

  it('emits one sorted line per artifact, in the documented shapes', () => {
    const lines = zkConfigLines(makeTree());
    expect(lines).toEqual([...lines].sort());
    expect(lines.filter((l) => l.startsWith('contract-info:'))).toHaveLength(1);
    expect(lines).toContainEqual(expect.stringMatching(/^keys\/checkCap\.verifier:[0-9a-f]{64}$/));
    expect(lines).toContainEqual('keys/checkCap.prover:len=4');
  });
});

// ---- the guard, per contract ---------------------------------------------
//
// A bundle carries one fingerprint per compiled contract, and a CLI names the
// contract it proves against. The gate's artifacts must not vouch for
// governance's, and a build that carried no artifacts for a contract must say
// so rather than wave that contract through.

describe('checkZkConfigAgainst', () => {
  it('is silent when the build recorded nothing (running from source)', () => {
    expect(() => checkZkConfigAgainst(undefined, makeTree(), 'cto_governance')).not.toThrow();
  });

  it('accepts the tree whose fingerprint the build recorded for that contract', () => {
    const base = makeTree();
    const expected = { cto_governance: zkConfigFingerprint(base) };
    expect(() => checkZkConfigAgainst(expected, base, 'cto_governance')).not.toThrow();
  });

  it("refuses when the build's entry for that contract is a different tree", () => {
    const base = makeTree();
    const other = makeTree({ verifiers: { 'checkCap.verifier': 'W' } });
    const expected = { cto_governance: zkConfigFingerprint(other) };
    expect(() => checkZkConfigAgainst(expected, base, 'cto_governance')).toThrow(
      /different compiled cto_governance artifacts/,
    );
  });

  it('refuses when the build carries a guard for the OTHER contract only', () => {
    const base = makeTree();
    const expected = { eligibility_gate: zkConfigFingerprint(base) };
    expect(() => checkZkConfigAgainst(expected, base, 'cto_governance')).toThrow(
      /no compiled Compact artifacts for cto_governance[\s\S]*guard for: eligibility_gate/,
    );
  });

  it("does not let one contract's fingerprint satisfy the other", () => {
    const base = makeTree();
    const fp = zkConfigFingerprint(base);
    // Identical trees under both names: each name is checked against its own entry.
    const expected = { eligibility_gate: fp, cto_governance: 'not-this' };
    expect(() => checkZkConfigAgainst(expected, base, 'cto_governance')).toThrow(/different compiled cto_governance/);
    expect(() => checkZkConfigAgainst(expected, base, 'eligibility_gate')).not.toThrow();
  });

  it('reports an unreadable path as unreadable, never as a match', () => {
    const expected = { cto_governance: 'anything' };
    expect(() => checkZkConfigAgainst(expected, join(tmpdir(), 'noctis-zk-does-not-exist'), 'cto_governance')).toThrow(
      /could not be read/,
    );
  });
});
