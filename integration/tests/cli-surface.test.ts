// ============================================================================
// integration/cli/* — structural coverage over every entry point
// ============================================================================
// WHY THIS FILE EXISTS, AND WHY IT IS NOT 53 BEHAVIOURAL SUITES
//
// These are thin wrappers: read one JSON object from stdin, validate it, call
// a submitter, write JSON to stdout. They carry almost no branching of their
// own — the logic they front is already covered where it lives, in the
// submitter tests. Writing a subprocess suite per file would buy very little
// and cost a slow test run.
//
// What they DO carry is a shared shape, and **21 of them take a plaintext
// signing key on stdin**, decrypted by the PHP caller. The realistic failure
// here is not that one computes something wrong. It is that the next one is
// copied from a neighbour without a guard rail, or ships with a debug line
// that prints the input — and the input is a key.
//
// So this pins the SHAPE every entry point must keep. Each assertion below was
// checked to hold across all 53 before it was written; a rule that only held
// for most of them was dropped rather than weakened (several read-only derive
// commands legitimately take no required fields, so "must call a require*
// guard" is deliberately NOT asserted).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_DIR = fileURLToPath(new URL('../cli/', import.meta.url));

/**
 * `cli-io.ts` is the shared helper the others import, not an entry point: it
 * has no `main()` and must not be held to entry-point rules.
 */
const HELPERS = new Set(['cli-io.ts']);

const entryPoints = readdirSync(CLI_DIR)
  .filter((f) => f.endsWith('.ts') && !HELPERS.has(f))
  .sort();

const sourceOf = (file: string) => readFileSync(join(CLI_DIR, file), 'utf8');

/** Identifiers that hold the caller's raw input, which may be a private key. */
const SECRET_BEARING = /\b(input|raw|stdin|body)\b/;

/** Field names that are the key itself, wherever they appear. */
const SECRET_FIELD = /(privateKey|PrivateKey|skey|Skey|mnemonic|Mnemonic|secret|Secret)/;

/** Every `console.log(...)` / `console.error(...)` call site, as written. */
function consoleCalls(src: string): string[] {
  return src.split('\n').filter((l) => /\bconsole\.(log|error|warn|info|debug)\s*\(/.test(l));
}

describe('CLI entry points', () => {
  it('finds the entry points to check', () => {
    // If a refactor moves or renames the directory this file silently covers
    // nothing, so the count is asserted rather than assumed.
    expect(entryPoints.length).toBeGreaterThanOrEqual(50);
  });

  it.each(entryPoints)('%s handles a rejected main()', (file) => {
    // Without this the process dies on an unhandled rejection, printing a
    // stack to stderr instead of the single JSON object the PHP caller parses
    // — and the caller reads a crash as an unexplained failure.
    expect(sourceOf(file)).toMatch(/main\(\)\.catch/);
  });

  it.each(entryPoints)('%s returns its result on stdout', (file) => {
    expect(sourceOf(file)).toMatch(/process\.stdout\.write/);
  });

  it.each(entryPoints)('%s never logs the object it parsed from stdin', (file) => {
    // The parsed input carries the plaintext key on 21 of these. A debug line
    // that prints it puts a spendable key in a server log.
    const offenders = consoleCalls(sourceOf(file)).filter((l) => SECRET_BEARING.test(l));
    expect(offenders).toEqual([]);
  });

  it.each(entryPoints)('%s never logs a secret-named field', (file) => {
    const offenders = consoleCalls(sourceOf(file)).filter((l) => SECRET_FIELD.test(l));
    expect(offenders).toEqual([]);
  });
});
