// ============================================================================
// Noctis Zone — Cardano Launch: read-dv-purchases CLI
// ============================================================================
// PHP<->Node bridge, same convention as check-cto-badge-status.ts and every
// other CLI in this directory: real logic lives in read-dv-purchases.ts;
// this script is a thin stdin/stdout wrapper.
//
// Input: single JSON object on stdin. Output: single JSON object on
// stdout, exit 0 on success (a not-yet-deployed contract, `deployed:
// false`, counts as success — the query itself completed), non-zero with
// {"error": "..."} on any failure the caller couldn't complete.
// ============================================================================

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { readDvPurchases } from '../read-dv-purchases.js';
import { parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface ReadDvPurchasesInput {
  indexerUri: string;
  indexerWsUri: string;
  contractAddressHex: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ReadDvPurchasesInput>(raw);

  requireFieldsFalsy(input, ['indexerUri', 'indexerWsUri', 'contractAddressHex']);

  const publicDataProvider = indexerPublicDataProvider(input.indexerUri, input.indexerWsUri);
  const result = await readDvPurchases(publicDataProvider, input.contractAddressHex);

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
