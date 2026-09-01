/**
 * One copy of each Midnight package, repo-wide.
 *
 * WHY THIS FILE EXISTS
 *
 * Several Midnight packages carry a wasm module, and a wasm module owns the
 * identity of the objects it mints. Install two copies of the same package and
 * each one rejects the other's objects — a `ContractState` built by one is not
 * a `ContractState` to the other. The error says something like "expected
 * instance of ContractMaintenanceAuthority", which names neither package nor
 * version and points at nothing you can grep for.
 *
 * It is easy to reintroduce without touching a line of our own code. The
 * packages pin each other inconsistently: `midnight-js-protocol` pins the
 * ledger and the onchain runtime to EXACT versions while `compact-runtime` and
 * `compact-js` ask for ranges. A range that floats one minor above the exact
 * pin gives npm no single version to satisfy both, so it nests a second copy
 * and reports nothing. A real control install did exactly this — 8.1.1 at the
 * root, 8.1.0 nested — purely because a direct dependency was written `^8.1.0`.
 *
 * So this asserts the property directly rather than trusting the manifests to
 * imply it: walk the installed tree and fail on any Midnight package present
 * at more than one path. That turns a runtime error nobody can read into a
 * named test failure that says which package and which versions.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT_MODULES = join(REPO_ROOT, 'node_modules');

type Copy = { version: string; path: string };

function collectMidnightPackages(): Map<string, Copy[]> {
  const found = new Map<string, Copy[]>();

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      // `node_modules/` descends a level; `@scope/` is not itself a package.
      if (entry.name === 'node_modules') {
        walk(full, depth + 1);
        continue;
      }
      if (entry.name.startsWith('@')) {
        walk(full, depth);
        continue;
      }
      try {
        const pkg = JSON.parse(readFileSync(join(full, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name?.includes('midnight') && pkg.version) {
          const copies = found.get(pkg.name) ?? [];
          copies.push({ version: pkg.version, path: relative(REPO_ROOT, full) });
          found.set(pkg.name, copies);
        }
      } catch {
        // Not a package directory, or unreadable — neither is a duplicate.
      }
      walk(join(full, 'node_modules'), depth + 1);
    }
  };

  walk(ROOT_MODULES, 0);
  return found;
}

describe('Midnight packages are installed exactly once each', () => {
  it('has no package present at more than one path', () => {
    // Nothing to assert about a tree that was never installed; the CI job that
    // runs this always installs first.
    if (!existsSync(ROOT_MODULES)) return;

    const packages = collectMidnightPackages();

    // Guard against the assertion passing because the walk found nothing at
    // all — an empty result would otherwise look identical to a clean tree.
    expect(packages.size).toBeGreaterThan(0);

    const duplicated = [...packages.entries()]
      .filter(([, copies]) => copies.length > 1)
      .map(([name, copies]) => `${name}: ${copies.map((c) => `${c.version} @ ${c.path}`).join(' | ')}`);

    expect(duplicated).toEqual([]);
  });
});
