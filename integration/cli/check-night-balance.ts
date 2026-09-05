// ============================================================================
// Noctis Zone — one-shot CLI wrapper around checkNightBalance
// ============================================================================
// DarkVeil eligibility check #2 (NIGHT balance >= $50 USD) is the one check
// PHP genuinely cannot perform itself: Blockfrost's Midnight Indexer only
// exposes an address's unshielded balance via a GraphQL SUBSCRIPTION
// (`unshieldedTransactions`) — confirmed against the real, current
// docs.blockfrost.io/midnight reference (fetched 2026-07-15): there is no
// plain HTTP query form (checked the full Queries operation list; no
// `unshieldedUtxos`/`walletBalance`/similar exists). `dustGenerationStatus`
// looked like a shortcut at first glance but is the wrong data — it reports
// NIGHT backing a CARDANO reward address's DUST *generation registration*,
// not a Midnight unshielded address's own token balance, which is what this
// check actually needs. A GraphQL-over-WebSocket subscription has no native
// PHP client; Node already has one, real and tested (indexer-client.ts).
// Rather than reimplement that (and Orcfax's CBOR-datum parsing, and
// Minswap's TWAP averaging) a second time in PHP, this script is a thin CLI
// wrapper that PHP invokes per-request via proc_open (see
// noctis-platform's darkveil-eligibility.php) — no persistent Node service,
// just the existing checkNightBalance call reused as-is.
//
// Input: a single JSON object on stdin (never argv — avoids any shell
// command-injection surface for untrusted wallet addresses; PHP writes
// straight to this process's stdin pipe via proc_open).
// Output: a single JSON object on stdout. Exit code 0 on a successful check
// (regardless of eligible true/false), non-zero with {"error": "..."} on
// stdout for any failure (network, bad input, etc.) — PHP treats non-zero
// exit as "check could not be completed," not "ineligible."
//
// Blockfrost's Midnight Indexer WS endpoint takes its `project_id` as either
// an HTTP header or a `?project_id=` query parameter (both documented).
// indexer-client.ts's getUnshieldedNightBalance takes a bare `indexerWsUrl`
// string with no header-injection point, so this script appends
// `?project_id=` to the URL — the query-param form. NOT yet verified against
// a live Blockfrost Midnight endpoint (no credentials in this dev
// environment) — flag this honestly, same as every other "not tested
// end-to-end" note in this codebase this session.
// ============================================================================

import { checkNightBalance } from '../eligibility-checker.js';
import { parseJsonStdin, readStdin, requireFieldsStrict } from './cli-io.js';

interface CheckNightBalanceInput {
  registrantAddress: string;
  minUsd: number;
  /** Blockfrost Midnight Indexer WS base URL, e.g.
   *  wss://midnight-preprod.blockfrost.io/api/v0/ws — no query string. */
  midnightIndexerWsUrl: string;
  /** Optional. Supply only when using Blockfrost's Midnight indexer (appended
   *  as ?project_id=). Blank = hit the free public Midnight indexer directly. */
  midnightBlockfrostProjectId?: string;
  // No Cardano fields: the balance comes from the Midnight indexer and the
  // USD threshold from the public ADA/USD median plus Minswap's NIGHT/ADA
  // pool. Neither needs Blockfrost. The caller may still send
  // `cardanoBlockfrostApiKey`/`cardanoNetwork` from an older configuration;
  // they are ignored.
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<CheckNightBalanceInput>(raw);

  requireFieldsStrict(input, ['registrantAddress', 'minUsd', 'midnightIndexerWsUrl']);

  // The underlying getUnshieldedNightBalance connects to a BARE public
  // Midnight indexer WS URL with no auth. Blockfrost's Midnight indexer,
  // if used, additionally needs a `?project_id=` query param — so append it
  // ONLY when a project id is actually supplied. Left blank (the confirmed
  // 2026-07-23 default), we hit the free public indexer directly.
  const indexerWsUrl = input.midnightBlockfrostProjectId
    ? `${input.midnightIndexerWsUrl}?project_id=${encodeURIComponent(input.midnightBlockfrostProjectId)}`
    : input.midnightIndexerWsUrl;

  const result = await checkNightBalance(indexerWsUrl, input.registrantAddress, input.minUsd);

  process.stdout.write(
    JSON.stringify({
      eligible: result.eligible,
      balanceAtomic: result.balanceAtomic.toString(),
      minRequiredAtomic: result.minRequiredAtomic.toString(),
      sources: result.sources,
    }),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  // Not process.exit(1): a forced immediate exit can race the WS
  // subscription's own libuv handle teardown (getUnshieldedNightBalance's
  // Effect.scoped cleanup) when the OTHER half of checkNightBalance's
  // Promise.all rejects first — found the hard way, a real crash
  // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") after the
  // correct error JSON had already been written. Setting exitCode and
  // letting the event loop drain naturally gives that cleanup time to
  // finish before the process actually exits.
  process.exitCode = 1;
});
