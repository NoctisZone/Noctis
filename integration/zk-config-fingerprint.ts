// ============================================================================
// Noctis Zone — are these the ZK artifacts this bundle was built for?
// ============================================================================
// WHY THIS EXISTS
// `contracts/midnight/compiled_realzk/` holds the compiled Compact artifacts a
// governor operation proves against: the circuit ABI, a prover key and a
// verifier key per circuit. It is NOT git-tracked (79 MB of prover keys), so a
// push updates it nowhere, and it has to be copied to a server by hand
// alongside the code that reads it — the same shape as `integration/cli/dist`,
// and the same failure.
//
// That failure is not hypothetical. A deployment repointed
// `midnight_zk_config_base_path` at a new directory while the transfer that
// created that directory had never copied this tree, so the setting named a
// path that did not exist. Nothing refused: the Cardano blueprint's own
// fingerprint guard covers plutus.json and the CLI bundles, and this tree is
// in neither relationship. It surfaced hours later, from a checker looking for
// something else.
//
// WHAT IS FINGERPRINTED, AND WHY EACH PART
//   contract-info.json  the compiler's own description of the contract —
//                       circuit names with argument and result types, witness
//                       list, ledger shape, and the compiler/language/runtime
//                       versions. Derived from the source rather than from key
//                       generation, so it moves when the contract's INTERFACE
//                       moves. Re-serialised with sorted keys before hashing so
//                       formatting and key order cannot move it.
//   *.verifier          the small (~2 KB) half of each circuit's key pair, and
//                       the half that decides what is ACCEPTED. It moves when a
//                       circuit's BODY changes even if its signature does not,
//                       which is precisely the drift contract-info.json cannot
//                       see. Hashed in full.
//   *.prover            name and byte length only. Hashing 79 MB on every
//                       invocation buys little: a wrong or truncated prover key
//                       fails loudly at proving time and cannot produce a proof
//                       that verifies against the wrong circuit, whereas a
//                       wrong verifier key is the dangerous one. Length still
//                       catches a truncated or absent file.
//
// Determinism of key generation is deliberately NOT assumed. The value is
// computed at build time over the artifacts that then ship, so recompiling
// forces a rebuild — which is the correct discipline regardless of whether the
// compiler is byte-reproducible.
//
// THE TWIN: build.mjs computes this same value at build time and injects it.
// The two implementations are deliberately small and each points at the other;
// zk-config-fingerprint.test.ts pins the algorithm against a fixture so neither
// can drift silently. Change one and you must change the other.
// ============================================================================

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Recursively sort object keys so serialisation order cannot move the hash. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalise((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The lines that make up the fingerprint, in sorted order.
 *
 * Exported for the test and for build.mjs's error reporting: when two
 * fingerprints disagree, the useful question is always WHICH line differs, and
 * a bare hash cannot answer it.
 *
 * @param basePath directory holding `compiler/`, `keys/`, `zkir/` — i.e. the
 *                 same path handed to NodeZkConfigProvider.
 */
export function zkConfigLines(basePath: string): string[] {
  const lines: string[] = [];

  const infoPath = join(basePath, 'compiler', 'contract-info.json');
  const info = JSON.parse(readFileSync(infoPath, 'utf8'));
  const canonical = JSON.stringify(canonicalise(info));
  lines.push(`contract-info:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`);

  const keysDir = join(basePath, 'keys');
  for (const name of readdirSync(keysDir).sort()) {
    const full = join(keysDir, name);
    if (!statSync(full).isFile()) {
      continue;
    }
    if (name.endsWith('.verifier')) {
      lines.push(`keys/${name}:${sha256File(full)}`);
    } else if (name.endsWith('.prover')) {
      lines.push(`keys/${name}:len=${statSync(full).size}`);
    }
    // Anything else under keys/ is deliberately ignored rather than hashed:
    // an unrecognised file is not evidence about the circuits, and folding it
    // in would make the fingerprint sensitive to editor and OS litter.
  }

  return lines.sort();
}

/**
 * A stable identifier for a compiled Compact contract's ZK artifact set.
 *
 * Throws if the artifacts are absent or unreadable. That is intentional: the
 * failure this exists to prevent IS a missing directory, so "cannot read" must
 * never quietly become "matches".
 */
export function zkConfigFingerprint(basePath: string): string {
  return createHash('sha256').update(zkConfigLines(basePath).join('\n'), 'utf8').digest('hex');
}

/**
 * Injected by build.mjs: one fingerprint per compiled contract, keyed by the
 * artifact directory's name under `compiled_realzk/`. Absent when running from
 * source (tsx, vitest), and absent from a bundle built on a checkout that
 * carried no artifacts at all.
 */
declare const __ZK_CONFIG_FINGERPRINTS__: Record<string, string> | undefined;

/** The compiled-artifact directories a bundle can carry a guard for. */
export type ZkConfigContract = 'eligibility_gate' | 'cto_governance';

/**
 * The comparison itself, separated from the injected value so it can be
 * tested: given what the build recorded, does the tree at `basePath` hold the
 * artifacts this code was built against for `contract`?
 *
 * Silent when `expected` is undefined — there is no build to disagree with.
 * Throws when the build recorded fingerprints but none for this contract: that
 * bundle was built on a checkout missing these artifacts, and a guard covering
 * the other contract is no guard for this one.
 */
export function checkZkConfigAgainst(
  expected: Record<string, string> | undefined,
  basePath: string,
  contract: ZkConfigContract,
): void {
  if (!expected) {
    return;
  }

  const want = expected[contract];
  if (typeof want !== 'string') {
    const guarded = Object.keys(expected).sort().join(', ') || '(none)';
    throw new Error(
      `This CLI was built on a checkout with no compiled Compact artifacts for ${contract}, so it cannot vouch for the ones it just read.\n` +
        `  path: ${basePath}\n` +
        `  contracts this build carries a guard for: ${guarded}\n` +
        `Rebuild the CLI bundles on a checkout that holds contracts/midnight/compiled_realzk/${contract} and ship both together.`,
    );
  }

  let actual: string;
  try {
    actual = zkConfigFingerprint(basePath);
  } catch (err) {
    throw new Error(
      'The compiled Compact ZK artifacts this operation proves against could not be read.\n' +
        `  path: ${basePath}\n` +
        `  cause: ${err instanceof Error ? err.message : String(err)}\n` +
        'This directory is not git-tracked, so a push does not deliver it and it has to be copied ' +
        'across with the bundles. A setting naming a path that does not exist is the usual cause.',
    );
  }

  if (actual === want) {
    return;
  }

  throw new Error(
    `This CLI was built against different compiled ${contract} artifacts than the ones it just read.\n` +
      `  path: ${basePath}\n` +
      `  expected fingerprint: ${want}\n` +
      `  actual fingerprint:   ${actual}\n` +
      'Proving against artifacts that do not match the contract this code expects produces a proof ' +
      'for the wrong circuit. Copy the compiled_realzk tree and the CLI bundles across together — ' +
      'they are a pair, and neither is git-tracked.',
  );
}

/**
 * Throws if the ZK artifacts on disk are not the ones this bundle was built
 * for. `contract` names which compiled contract the path is expected to hold.
 *
 * Silent when running from source — there is no build step to disagree with,
 * and the directory being read IS the one the code was written against.
 */
export function assertZkConfigMatchesBuild(basePath: string, contract: ZkConfigContract): void {
  const expected =
    typeof __ZK_CONFIG_FINGERPRINTS__ === 'object' && __ZK_CONFIG_FINGERPRINTS__ !== null
      ? __ZK_CONFIG_FINGERPRINTS__
      : undefined;
  checkZkConfigAgainst(expected, basePath, contract);
}
