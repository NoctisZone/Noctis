// ============================================================================
// Noctis Zone — Cardano genesis datums, as a standalone CLI
// ============================================================================
// Thin wrapper. The logic lives in ../genesis-datums.ts so that
// mint-tier-a-launch.ts can call it in-process: a module that runs `main()` at
// import time cannot be imported, and bundling one that does produces two
// mains racing for the same stdin.
//
// Input: single JSON object on stdin; `genesisTimestampMs` defaults to this
// process's clock, read once. Output: single JSON object on stdout, or
// { error }.
// ============================================================================

import { type BuildGenesisDatumsInput, buildGenesisDatums } from '../genesis-datums.js';
import { parseJsonStdin, readStdin, requireTimestampMs } from './cli-io.js';

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Omit<BuildGenesisDatumsInput, 'genesisTimestampMs'> & { genesisTimestampMs?: number }>(
    raw,
  );
  const genesis = await buildGenesisDatums({
    ...input,
    genesisTimestampMs:
      input.genesisTimestampMs === undefined
        ? Date.now()
        : requireTimestampMs(input.genesisTimestampMs, 'genesisTimestampMs'),
  });
  process.stdout.write(JSON.stringify(genesis));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
