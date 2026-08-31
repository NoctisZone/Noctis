// ============================================================================
// Noctis Zone — fix: serves ONE buyer's own DarkVeil allocation
// proof, never anyone else's
// ============================================================================
// Closes the gap ("no endpoint serves a Cardano Launch buyer's private DarkVeil
// allocation proof"). The actual HTTP endpoint is a WordPress REST route
// (out of scope for this git repo — WP code stays local, per this
// project's established convention) that:
//   1. Authenticates the caller as the owner of `targetVkhHex` (however
//      this platform already authenticates a connected Cardano wallet for
//      other buyer-facing actions — out of scope here too).
//   2. Loads the FULL governor-held allocation entry list for this launch
//      from wherever it's stored server-side (the governor's own working
//      record from build-dv-allocation-tree.ts, e.g. a WP DB row —
//      NEVER sent to the browser in full).
//   3. Invokes this CLI via proc_open (same calling convention as every
//      other PHP<->Node bridge in this codebase — check-night-balance.ts's
//      own header comment is the canonical reference) with that full list
//      plus the requesting buyer's own vkhHex.
//   4. Returns ONLY this CLI's output (one buyer's own triple) as the HTTP
//      response body.
//
// Input: JSON on stdin — { "entries": [{ "vkhHex", "dvAmount", "saltHex" },
// ...], "targetVkhHex": "<hex>" } — same entries shape as
// build-dv-allocation-tree.ts (the full list must be supplied so the
// Merkle proof's sibling hashes can be computed; the tree itself is
// recomputed deterministically here, not read from a stored artifact, so
// there is no separate "tree file" to keep in sync).
// Output: { "dvAmount": "...", "saltHex": "...", "proof": [{ "siblingHex",
// "goesLeft" }, ...] } — ONLY targetVkhHex's own data; every other
// entry's vkh/dvAmount/salt never appears in this CLI's output at all.
// ============================================================================

import { buildDvAllocationTree, type DvAllocationEntry } from '../dv-allocation-tree.js';
import { parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface InputEntry {
  vkhHex: string;
  dvAmount: string;
  saltHex: string;
}

interface Input {
  entries: InputEntry[];
  targetVkhHex: string;
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new Error('entries must be a non-empty array.');
  }
  requireFieldsFalsy(input, ['targetVkhHex']);

  const targetIndex = input.entries.findIndex((e) => e.vkhHex.toLowerCase() === input.targetVkhHex.toLowerCase());
  if (targetIndex === -1) {
    throw new Error(`No entry found for vkhHex ${input.targetVkhHex} — this wallet did not purchase during DarkVeil.`);
  }

  const entries: DvAllocationEntry[] = input.entries.map((e) => ({
    vkh: fromHex(e.vkhHex),
    dvAmount: BigInt(e.dvAmount),
    salt: fromHex(e.saltHex),
  }));

  const tree = buildDvAllocationTree(entries);
  const targetEntry = input.entries[targetIndex];

  process.stdout.write(
    JSON.stringify({
      dvAmount: targetEntry.dvAmount,
      saltHex: targetEntry.saltHex,
      // See build-dv-allocation-tree.ts — position is the nullifier bit.
      leafIndex: targetIndex,
      proof: tree.getProof(targetIndex).map((step) => ({
        siblingHex: toHex(step.sibling),
        goesLeft: step.goesLeft,
      })),
    }),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
