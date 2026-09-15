// Structural guard over the CLI boundary's timestamp units.
//
// WHY THIS EXISTS
// This codebase talks to two chains that measure time differently, and it is
// not a matter of preference on either side:
//
//   - Cardano's transaction validity range is milliseconds, and every Aiken
//     validator that stores or compares a timestamp compares it against a
//     value that arrived on that range. The constants are sized to match
//     (min_lock_duration, migration_cooldown, dex_change_notice_period).
//   - Midnight's ledger hands a circuit `secondsSinceEpoch`, so the Compact
//     contracts are seconds throughout, correctly.
//
// The CLI is where a PHP-supplied number crosses into the Cardano half, and
// it is the only place a single check can cover every such crossing. The
// units once disagreed across that boundary for five entry points at once —
// the field said seconds, the submitter parameter said milliseconds, and
// nothing compared the two, because a name is not a type.
//
// So this file checks the source itself rather than any one call: every CLI
// input field naming a timestamp must be milliseconds and must be run
// through the guard. A newly added entry point is caught the day it lands,
// which is the only time the fix is cheap.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli');

const cliFiles = readdirSync(CLI_DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'cli-io.ts')
  .map((f) => ({ name: f, source: readFileSync(join(CLI_DIR, f), 'utf8') }));

/** Input-interface fields whose name marks them as a timestamp. */
function timestampFields(source: string): string[] {
  return [...source.matchAll(/^\s{2}([A-Za-z]*[Tt]imestamp[A-Za-z]*)\??:\s*number;/gm)].map((m) => m[1]);
}

describe('CLI timestamp fields are milliseconds, and say so', () => {
  it('finds timestamp fields at all (guards against the regex silently matching nothing)', () => {
    // Without this, every assertion below would pass vacuously the moment
    // the interface style changed — the failure mode that makes a source
    // scanner worse than no test.
    const total = cliFiles.reduce((n, f) => n + timestampFields(f.source).length, 0);
    // Lowered from 10 with the linear curve's CLI retirement; the point is
    // that the scan still finds fields, not that it finds a fixed number.
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it.each(cliFiles.map((f) => f.name))('%s declares no seconds-denominated timestamp field', (name) => {
    const file = cliFiles.find((f) => f.name === name);
    const seconds = timestampFields(file?.source ?? '').filter((field) => /seconds$/i.test(field));
    expect(seconds).toEqual([]);
  });

  it.each(cliFiles.map((f) => f.name))('%s runs every timestamp field through requireTimestampMs', (name) => {
    const file = cliFiles.find((f) => f.name === name);
    const source = file?.source ?? '';
    for (const field of timestampFields(source)) {
      expect(source, `${name}: ${field} is never passed to requireTimestampMs`).toMatch(
        new RegExp(`requireTimestampMs\\([\\s\\S]{0,200}?'${field}'\\)`),
      );
    }
  });
});
