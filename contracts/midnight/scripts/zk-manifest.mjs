#!/usr/bin/env node
// ============================================================================
// The manifest of the Compact ZK artifacts this project ships
// ============================================================================
// `compiled_realzk/` holds the real-key build of each Midnight contract the
// platform proves against: the module, the zkir and a prover and verifier key
// per circuit. It is far too large for git, so it is copied to every place
// that proves by hand, and every copy can drift. zk-manifest.json is the
// tracked record of exactly what those copies must hold: the sha256 and size
// of every file, the compiler that produced them and the source they came
// from. Prover keys are hashed in full here, unlike the bundles' runtime
// fingerprint (zk-config-fingerprint.ts), which pairs a bundle with a tree on
// every invocation and so checks prover keys by length only.
//
// Key generation on the pinned toolchain is reproducible: a fresh compile of
// the same source gives the same prover and verifier keys byte for byte, which
// is what lets CI rebuild the artifacts from the public source and hold them
// to this file. The source map is left out because it records the directory
// it was built in.
//
//   node scripts/zk-manifest.mjs write
//       Regenerate zk-manifest.json from compiled_realzk/. Refuses when a
//       real-key module differs from the skip-zk build of the current source
//       in compiled/, i.e. when the real-key tree lags the source.
//   node scripts/zk-manifest.mjs check [--tree <dir>] [--manifest <file>] [--contract <name>]
//       Hold a tree of contract directories (default compiled_realzk/) to the
//       manifest. Needs only node, so it runs on a server against the copy
//       that server proves with.
//   node scripts/zk-manifest.mjs rebuilt --tree <dir> --contract <name>
//       CI: a fresh compile must reproduce the manifest. When the contract's
//       source has moved on since the manifest was written, the shipped keys
//       belong to the deployed contract and not to the newer source, so this
//       warns instead of failing.
//   node scripts/zk-manifest.mjs check-url <base-url> --contract <name> [--manifest <file>]
//       Hold the keys a site serves for in-browser proving to the manifest:
//       every prover key, verifier key and binary zkir under the base URL.
// ============================================================================

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIDNIGHT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = join(MIDNIGHT_DIR, 'zk-manifest.json');
const REALZK_DIR = join(MIDNIGHT_DIR, 'compiled_realzk');
const SKIPZK_DIR = join(MIDNIGHT_DIR, 'compiled');

/** Files a contract directory holds that the manifest does not pin. */
export const isUnpinned = (rel) => rel.endsWith('.map');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestOf = (bytes) => ({ sha256: sha256(bytes), bytes: bytes.length });

/** The source as text with LF line endings, so a Windows checkout hashes as CI does. */
export function sourceDigest(bytes) {
  return digestOf(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

/** The toolchain pin: the last non-comment line of compact-toolchain.txt. */
export function toolchainPin(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.at(-1) ?? '';
}

/** Every file under a contract directory, as forward-slash paths relative to it. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** The pinned files of one compiled contract directory. */
export function digestContractDir(dir) {
  const files = {};
  for (const rel of listFiles(dir)) {
    if (!isUnpinned(rel)) files[rel] = digestOf(readFileSync(join(dir, rel)));
  }
  return files;
}

/**
 * What differs between a contract directory and its manifest entry: a pinned
 * file missing or different, and a file the manifest does not know.
 */
export function contractProblems(dir, entry) {
  if (!existsSync(dir)) return [`${dir} does not exist`];
  const problems = [];
  const present = new Set(listFiles(dir).filter((rel) => !isUnpinned(rel)));
  for (const [rel, want] of Object.entries(entry.files)) {
    if (!present.has(rel)) {
      problems.push(`${rel}: missing`);
      continue;
    }
    present.delete(rel);
    const got = digestOf(readFileSync(join(dir, rel)));
    if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) {
      problems.push(`${rel}: ${got.bytes} bytes, sha256 ${got.sha256.slice(0, 16)}… (manifest ${want.bytes} bytes, ${want.sha256.slice(0, 16)}…)`);
    }
  }
  for (const rel of present) problems.push(`${rel}: not in the manifest`);
  return problems;
}

/**
 * Whether the real-key module matches the skip-zk build of the current source.
 * A real-key compile takes minutes and a skip-zk one seconds, so the real-key
 * tree is the one that falls behind; the module is where it shows.
 */
export function lagProblems(realDir, skipDir) {
  const problems = [];
  for (const rel of ['contract/index.js', 'contract/index.d.ts']) {
    const a = join(realDir, rel);
    const b = join(skipDir, rel);
    if (!existsSync(b)) problems.push(`${relative(MIDNIGHT_DIR, skipDir)}/${rel}: missing — run the skip-zk compile first`);
    else if (!existsSync(a) || sha256(readFileSync(a)) !== sha256(readFileSync(b))) {
      problems.push(`${rel} differs from the skip-zk build of the current source — the real-key tree is behind it`);
    }
  }
  return problems;
}

function readManifest(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest?.version !== 1 || typeof manifest.contracts !== 'object') throw new Error(`${path} is not a version 1 manifest`);
  return manifest;
}

function write() {
  if (!existsSync(REALZK_DIR)) throw new Error(`${REALZK_DIR} does not exist`);
  const contracts = {};
  const problems = [];
  for (const name of readdirSync(REALZK_DIR).sort()) {
    const dir = join(REALZK_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const source = join(MIDNIGHT_DIR, `${name}.compact`);
    if (!existsSync(source)) {
      problems.push(`${name}: no ${name}.compact beside compiled_realzk/`);
      continue;
    }
    for (const p of lagProblems(dir, join(SKIPZK_DIR, name))) problems.push(`${name}: ${p}`);
    contracts[name] = {
      source: { path: `${name}.compact`, ...sourceDigest(readFileSync(source)) },
      files: digestContractDir(dir),
    };
  }
  if (problems.length) {
    console.error('zk-manifest: not written:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const manifest = {
    version: 1,
    toolchain: toolchainPin(readFileSync(join(MIDNIGHT_DIR, 'compact-toolchain.txt'), 'utf8')),
    contracts,
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, c] of Object.entries(contracts)) {
    const keys = Object.keys(c.files).filter((f) => f.endsWith('.prover')).length;
    console.log(`zk-manifest: ${name}: ${Object.keys(c.files).length} files, ${keys} prover keys`);
  }
}

function check(opts) {
  const manifest = readManifest(opts.manifest ?? MANIFEST_PATH);
  const tree = opts.tree ?? REALZK_DIR;
  const names = opts.contract ? [opts.contract] : Object.keys(manifest.contracts);
  let failed = false;
  for (const name of names) {
    const entry = manifest.contracts[name];
    if (!entry) throw new Error(`the manifest has no contract named ${name}`);
    const problems = contractProblems(join(tree, name), entry);
    if (problems.length) {
      failed = true;
      console.error(`zk-manifest: ${name}: ${problems.length} problem(s) in ${join(tree, name)}`);
      for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    } else {
      console.log(`zk-manifest: ${name}: all ${Object.keys(entry.files).length} files match`);
    }
  }
  if (failed) process.exit(1);
}

function rebuilt(opts) {
  if (!opts.tree || !opts.contract) throw new Error('rebuilt needs --tree and --contract');
  const manifest = readManifest(opts.manifest ?? MANIFEST_PATH);
  const entry = manifest.contracts[opts.contract];
  if (!entry) throw new Error(`the manifest has no contract named ${opts.contract}`);
  const source = sourceDigest(readFileSync(join(MIDNIGHT_DIR, entry.source.path)));
  if (source.sha256 !== entry.source.sha256) {
    console.log(
      `::warning title=ZK artifacts behind the source::${opts.contract}: ${entry.source.path} has changed since ` +
        'zk-manifest.json was written. The shipped keys belong to the deployed contract; recompile them and ' +
        'rewrite the manifest when this contract is redeployed.',
    );
    return;
  }
  const problems = contractProblems(join(opts.tree, opts.contract), entry);
  if (problems.length) {
    console.error(`zk-manifest: ${opts.contract}: the fresh compile does not reproduce the manifest:`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`zk-manifest: ${opts.contract}: the fresh compile reproduces all ${Object.keys(entry.files).length} files`);
}

async function checkUrl(base, opts) {
  if (!base || !opts.contract) throw new Error('check-url needs a base URL and --contract');
  const manifest = readManifest(opts.manifest ?? MANIFEST_PATH);
  const entry = manifest.contracts[opts.contract];
  if (!entry) throw new Error(`the manifest has no contract named ${opts.contract}`);
  // What a browser's zk-config provider fetches: keys and the binary zkir.
  const served = Object.keys(entry.files).filter((rel) => /^keys\/.+\.(prover|verifier)$|^zkir\/.+\.bzkir$/.test(rel));
  const problems = [];
  for (const rel of served) {
    const res = await fetch(`${base.replace(/\/+$/, '')}/${rel}`);
    if (!res.ok) {
      problems.push(`${rel}: HTTP ${res.status}`);
      continue;
    }
    const got = digestOf(Buffer.from(await res.arrayBuffer()));
    const want = entry.files[rel];
    if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) problems.push(`${rel}: served ${got.bytes} bytes, sha256 ${got.sha256.slice(0, 16)}…`);
  }
  if (problems.length) {
    console.error(`zk-manifest: ${opts.contract}: ${problems.length} of ${served.length} served files do not match:`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`zk-manifest: ${opts.contract}: all ${served.length} served files match`);
}

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tree' || a === '--manifest' || a === '--contract') opts[a.slice(2)] = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  try {
    if (command === 'write') write();
    else if (command === 'check') check(opts);
    else if (command === 'rebuilt') rebuilt(opts);
    else if (command === 'check-url') await checkUrl(opts.positional[0], opts);
    else {
      console.error('usage: zk-manifest.mjs write | check [--tree d] [--manifest f] [--contract c] | rebuilt --tree d --contract c | check-url <url> --contract c');
      process.exit(2);
    }
  } catch (err) {
    console.error(`zk-manifest: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
