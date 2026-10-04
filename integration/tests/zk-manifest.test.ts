import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contractProblems,
  digestContractDir,
  lagProblems,
  MANIFEST_PATH,
  type Manifest,
  sourceDigest,
  toolchainPin,
} from '../../contracts/midnight/scripts/zk-manifest.mjs';

let root: string;

function put(rel: string, body: string) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

/** A contract directory shaped like a real-key compile, with stand-in bytes. */
function fakeContract(dir: string) {
  put(`${dir}/compiler/contract-info.json`, '{"circuits":[]}');
  put(`${dir}/contract/index.js`, 'export const x = 1;');
  put(`${dir}/contract/index.d.ts`, 'export declare const x: number;');
  put(`${dir}/contract/index.js.map`, '{"sourceRoot":"build-a"}');
  put(`${dir}/keys/vote.prover`, 'PROVER-KEY-BYTES');
  put(`${dir}/keys/vote.verifier`, 'VERIFIER');
  put(`${dir}/zkir/vote.bzkir`, 'BZKIR');
  put(`${dir}/zkir/vote.zkir`, 'ZKIR');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zk-manifest-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('what the manifest pins', () => {
  it('pins every file of a compiled contract except the source map, which records the build directory', () => {
    fakeContract('c');
    expect(Object.keys(digestContractDir(join(root, 'c')))).toEqual([
      'compiler/contract-info.json',
      'contract/index.d.ts',
      'contract/index.js',
      'keys/vote.prover',
      'keys/vote.verifier',
      'zkir/vote.bzkir',
      'zkir/vote.zkir',
    ]);
  });

  it('records the full sha256 and size of a prover key (a known vector, not just a shape)', () => {
    fakeContract('c');
    expect(digestContractDir(join(root, 'c'))['keys/vote.prover']).toEqual({
      sha256: '25cfc6cd4703c381d12db6327b771985892045e16ea1f00c4393d97a6c9c2a24',
      bytes: 16,
    });
  });

  it('hashes the source with LF line endings, so a Windows checkout and CI agree', () => {
    const lf = sourceDigest(Buffer.from('a\nb\n'));
    expect(lf).toEqual({ sha256: '911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2', bytes: 4 });
    expect(sourceDigest(Buffer.from('a\r\nb\r\n'))).toEqual(lf);
  });

  it('reads the toolchain pin from the last non-comment line', () => {
    expect(toolchainPin('# the pin\n#\n# 0.29.0 was older\n0.31.1\n')).toBe('0.31.1');
    expect(toolchainPin(readFileSync(join(MANIFEST_PATH, '..', 'compact-toolchain.txt'), 'utf8'))).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });
});

describe('holding a tree to its manifest', () => {
  it('passes a tree that matches, whatever its source map says', () => {
    fakeContract('c');
    const entry = { files: digestContractDir(join(root, 'c')) };
    put('c/contract/index.js.map', '{"sourceRoot":"build-b"}');
    expect(contractProblems(join(root, 'c'), entry)).toEqual([]);
  });

  it('catches a prover key that differs in one byte at the same length', () => {
    fakeContract('c');
    const entry = { files: digestContractDir(join(root, 'c')) };
    put('c/keys/vote.prover', 'PROVER-KEY-BYTEZ');
    expect(contractProblems(join(root, 'c'), entry)).toEqual([
      expect.stringMatching(/^keys\/vote\.prover: 16 bytes, sha256 /),
    ]);
  });

  it('names a pinned file that is missing and a file the manifest does not know', () => {
    fakeContract('c');
    const entry = { files: digestContractDir(join(root, 'c')) };
    rmSync(join(root, 'c/zkir/vote.bzkir'));
    put('c/keys/extra.prover', 'STRAY');
    expect(contractProblems(join(root, 'c'), entry).sort()).toEqual([
      'keys/extra.prover: not in the manifest',
      'zkir/vote.bzkir: missing',
    ]);
  });

  it('says so when the directory is not there at all', () => {
    expect(contractProblems(join(root, 'nowhere'), { files: {} })).toEqual([`${join(root, 'nowhere')} does not exist`]);
  });
});

describe('a real-key tree behind its source', () => {
  it('passes when the real-key module equals the skip-zk build of the current source', () => {
    fakeContract('real');
    put('skip/contract/index.js', 'export const x = 1;');
    put('skip/contract/index.d.ts', 'export declare const x: number;');
    expect(lagProblems(join(root, 'real'), join(root, 'skip'))).toEqual([]);
  });

  it('refuses when the source has moved on since the real-key compile', () => {
    fakeContract('real');
    put('skip/contract/index.js', 'export const x = 1; export const y = 2;');
    put('skip/contract/index.d.ts', 'export declare const x: number;');
    expect(lagProblems(join(root, 'real'), join(root, 'skip'))).toEqual([
      expect.stringMatching(/^contract\/index\.js differs from the skip-zk build/),
    ]);
  });
});

describe('the committed manifest', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;

  it('is version 1 and names the pinned toolchain', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.toolchain).toBe(
      toolchainPin(readFileSync(join(MANIFEST_PATH, '..', 'compact-toolchain.txt'), 'utf8')),
    );
  });

  it('gives every circuit a prover key, a verifier key and both zkir forms, each a full digest', () => {
    for (const [name, entry] of Object.entries(manifest.contracts)) {
      const provers = Object.keys(entry.files).filter((f) => f.endsWith('.prover'));
      expect(provers.length, name).toBeGreaterThan(0);
      for (const prover of provers) {
        const circuit = prover.slice('keys/'.length, -'.prover'.length);
        for (const rel of [`keys/${circuit}.verifier`, `zkir/${circuit}.bzkir`, `zkir/${circuit}.zkir`]) {
          expect(entry.files[rel], `${name}: ${rel}`).toBeDefined();
        }
      }
      for (const [rel, d] of Object.entries(entry.files)) {
        expect(d.sha256, `${name}: ${rel}`).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isInteger(d.bytes) && d.bytes > 0, `${name}: ${rel}`).toBe(true);
      }
      expect(entry.source.path).toBe(`${name}.compact`);
    }
  });
});
