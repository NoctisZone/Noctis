// Types for zk-manifest.mjs, which stays plain JavaScript so a server can run it with
// nothing but node.

export interface Digest {
  sha256: string;
  bytes: number;
}

export interface ManifestEntry {
  source: Digest & { path: string };
  files: Record<string, Digest>;
}

export interface Manifest {
  version: 1;
  toolchain: string;
  contracts: Record<string, ManifestEntry>;
}

export const MANIFEST_PATH: string;
export function isUnpinned(rel: string): boolean;
export function sourceDigest(bytes: Uint8Array): Digest;
export function toolchainPin(text: string): string;
export function listFiles(dir: string): string[];
export function digestContractDir(dir: string): Record<string, Digest>;
export function contractProblems(dir: string, entry: Pick<ManifestEntry, 'files'>): string[];
export function lagProblems(realDir: string, skipDir: string): string[];
