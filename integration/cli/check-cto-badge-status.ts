// ============================================================================
// Noctis Zone — CTO Governance: "Completed Successfully" Badge CLI
// ============================================================================
// PHP<->Node bridge, same convention as check-night-balance.ts and every
// other CLI in this directory: real logic lives in cto-badge.ts (tested
// directly, no simulator or network needed for the pure decision function);
// this script is a thin stdin/stdout wrapper so WordPress can shell out to
// it without a second, divergent implementation of the same logic.
//
// Input: single JSON object on stdin. Output: single JSON object on
// stdout, exit 0 on success (any real CtoCompletionStatus, including
// not_deployed, counts as success — the check itself completed), non-zero
// with {"error": "..."} on any failure the caller couldn't complete.
// ============================================================================

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { checkCtoCompletionStatus } from '../cto-badge.js';
import { claimStdoutForResult, parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface CheckCtoBadgeInput {
  indexerUri: string;
  indexerWsUri: string;
  contractAddressHex: string;
}

async function main() {
  // Stdout carries the result and nothing else; what the SDK logs goes with the rest of the diagnostics.
  claimStdoutForResult();
  const raw = await readStdin();
  const input = parseJsonStdin<CheckCtoBadgeInput>(raw);

  requireFieldsFalsy(input, ['indexerUri', 'indexerWsUri', 'contractAddressHex']);

  const publicDataProvider = indexerPublicDataProvider(input.indexerUri, input.indexerWsUri);
  const result = await checkCtoCompletionStatus(publicDataProvider, input.contractAddressHex);

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
