// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 4 follow-up
// SellTokens — seller-signed, mnemonic-based (same CLI-driven verification
// path as buy-tier-a-curve.ts; see tier-a-curve-submitter.ts's header for
// why this isn't the real browser-wallet production path).
// ============================================================================
// Input: single JSON object on stdin. Output: single JSON object on stdout
// ({txHash, netProceeds, avgPrice}).
// ============================================================================

import { capAccumulatorFromHex } from '../cap-accumulator-tree.js';
import { LucidTierACurveSubmitter } from '../tier-a-curve-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsFalsy,
} from './cli-io.js';

declare const __dirname: string;

interface SellTierACurveInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  sellerMnemonic: string;
  tokenAmount: string; // stringified bigint over stdin JSON
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /** The launch's per-wallet running totals, which the cumulative cap is held
   *  against. Omit only for a curve nothing has been taken from yet — the
   *  submitter refuses to build a transaction unless what it derives matches
   *  the curve datum's own cap_root, so a stale list fails locally. */
  capState?: { keyHashHex: string; total: string }[];
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<SellTierACurveInput>(raw);

  requireFieldsFalsy(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'sellerMnemonic',
    'tokenAmount',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);
  const compiledScriptCbor = loadValidatorCbor(blueprint, 'bonding_curve.bonding_curve.spend');

  const submitter = new LucidTierACurveSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    compiledScriptCbor,
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
  });

  // See buy-tier-a-curve.ts for what capState is and why an omitted one is
  // only correct for a curve that has never traded.
  const capState = capAccumulatorFromHex(input.capState ?? []);

  const result = await submitter.sellTokens(input.sellerMnemonic, BigInt(input.tokenAmount), capState);
  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
