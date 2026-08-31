// ============================================================================
// Noctis Zone — Cardano Trade History CLI
// ============================================================================
// Thin stdin/stdout wrapper around tier-a-trade-history-reader.ts's
// getCurveTradeHistory(), same proc_open calling convention as
// read-tier-a-launch-state.ts (single JSON object on stdin, single JSON
// object on stdout, exit 0 on success even for an empty/not-found result).
//
// Deliberately returns raw decoded TradeEvent[] and lets the PHP bridge
// (trade-history-reader.php) own the incremental-cache boundary and the
// candle-bucketing interpretation — this CLI's only job is "decode what's
// new on chain since stopAtTxHash," not aggregation. Keeps the Node layer a
// pure chain-decoder, matching this project's existing split (chain-state-
// reader.php interprets/caches; the CLI it calls only decodes).
//
// Bundled as CJS (see build.mjs) — __dirname is a native CJS global here,
// same reasoning as read-tier-a-launch-state.ts.
// ============================================================================

import { validatorToAddress } from '@lucid-evolution/lucid';
import { loadValidator } from '../tier-a-schemas.js';
import { TierATradeHistoryReader, type TradeEvent } from '../tier-a-trade-history-reader.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  parseJsonStdin,
  readStdin,
  requireFieldsFalsy,
} from './cli-io.js';

declare const __dirname: string;

interface ReadTradeHistoryInput {
  launchIdHex: string;
  network: 'preview' | 'preprod' | 'mainnet';
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /** Cardano Launch launches resolve to bonding_curve_tier_b.ak's own fixed script
   *  address instead of the linear curve's bonding_curve.ak — everything else about
   *  the walk is identical (Step 8 of the trade-history plan). */
  tier: 'A' | 'B';
  /** Incremental-cache boundary — omit to walk all the way to genesis. */
  stopAtTxHash?: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ReadTradeHistoryInput>(raw);

  requireFieldsFalsy(input, ['launchIdHex', 'network', 'blockfrostProjectId', 'blockfrostUrl', 'tier']);

  // __dirname resolves relative to where the BUNDLED .cjs actually runs
  // from (cli/dist/), same '..'-count as read-tier-a-launch-state.ts.
  const blueprint = loadPlutusBlueprint(__dirname);

  const validatorTitle =
    input.tier === 'B' ? 'bonding_curve_tier_b.bonding_curve_tier_b.spend' : 'bonding_curve.bonding_curve.spend';
  const bondingCurveValidator = loadValidator(blueprint, validatorTitle);

  const network = CARDANO_NETWORK_MAP[input.network];
  const bondingCurveAddress = validatorToAddress(network, bondingCurveValidator);

  const reader = new TierATradeHistoryReader({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    bondingCurveAddress,
    launchIdHex: input.launchIdHex,
    tier: input.tier,
  });

  const events: TradeEvent[] = await reader.getCurveTradeHistory(input.stopAtTxHash);

  process.stdout.write(
    JSON.stringify({
      events: jsonSafe(events),
      newestTxHash: events.length ? events[events.length - 1].txHash : (input.stopAtTxHash ?? null),
    }),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
