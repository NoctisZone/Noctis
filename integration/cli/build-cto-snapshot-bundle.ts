// ============================================================================
// Noctis Zone — build a CTO balance-snapshot bundle
// ============================================================================
// Pure: no chain, no wallet. Reads one JSON object on stdin —
//
//   { "launchIdHex": "...",
//     "entries": [ { "label": "buyer_1", "voterSeedHex": "...",
//                    "balance": "5000000", "heldSinceTimestamp": "1700000000" },
//                  { "label": "addr_test1...", "voterKeyHex": "...", ... } ] }
//
// — and writes the bundle: the root the attestors publish with
// `publish-snapshot`, and one entry per voter carrying exactly what their
// `vote` needs (balance, held-since, leaf index, sibling path). Every entry is
// re-verified against the root before it is written, so a bundle that would
// fail in-circuit never leaves this process.
// ============================================================================

import { buildSnapshotBundle, entryRecomputesRoot, type SnapshotBundleEntryInput } from '../cto-snapshot-bundle.js';
import { describeError } from '../error-detail.js';
import { parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface Input {
  launchIdHex: string;
  entries: SnapshotBundleEntryInput[];
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, ['launchIdHex', 'entries']);

  const bundle = buildSnapshotBundle(input.launchIdHex, input.entries);
  for (const entry of bundle.entries) {
    if (!entryRecomputesRoot(entry, bundle.rootHex)) {
      throw new Error(
        `entry ${entry.leafIndex} (${entry.label || entry.voterKeyHex}) does not recompute the root — refusing to write a bundle a vote would fail on.`,
      );
    }
  }

  process.stdout.write(JSON.stringify({ ok: true, ...bundle }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: describeError(err) }));
  process.exitCode = 1;
});
