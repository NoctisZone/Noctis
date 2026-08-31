// ============================================================================
// Noctis Zone — Cardano genesis datums, as a standalone CLI
// ============================================================================
// Thin wrapper. The logic lives in ../tier-a-genesis-datums.ts so that
// mint-tier-a-launch.ts can call it in-process: a module that runs `main()` at
// import time cannot be imported, and bundling one that does produces two
// mains racing for the same stdin.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout,
// or { error }.
// ============================================================================

import { type BuildGenesisDatumsInput, buildGenesisDatums } from '../tier-a-genesis-datums.js';
import { parseJsonStdin, readStdin } from './cli-io.js';

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<BuildGenesisDatumsInput>(raw);
  process.stdout.write(JSON.stringify(await buildGenesisDatums(input)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
