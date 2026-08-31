// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 4
// BuyTokens — buyer-signed, mnemonic-based (this session's CLI-driven
// verification path; see tier-a-curve-submitter.ts's header for why this
// isn't the real browser-wallet production path, which is a deferred Launch
// Wizard task).
// ============================================================================
// Input: single JSON object on stdin. Output: single JSON object on stdout
// ({txHash, grossPayment, avgPrice}).
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

interface BuyTierACurveInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  buyerMnemonic: string;
  tokenAmount: string; // stringified bigint over stdin JSON
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /** See tier-a-curve-submitter.ts's buyTokens() docs — deliberate on-chain
   *  cap-rejection verification only, never a real buy flow. */
  skipClientCapCheck?: boolean;
  /** The launch's per-wallet running totals, which the cumulative cap is held
   *  against. Omit only for a curve nothing has been taken from yet — the
   *  submitter refuses to build a transaction unless what it derives matches
   *  the curve datum's own cap_root, so a stale list fails locally. */
  capState?: { keyHashHex: string; total: string }[];
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<BuyTierACurveInput>(raw);

  requireFieldsFalsy(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'buyerMnemonic',
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

  // The cumulative cap's accumulator. `capState` is the launch's per-wallet
  // running totals; omit it only for a curve that has never traded, where the
  // empty tree IS the truth. The submitter refuses to build a transaction if
  // what it is handed does not derive the root the curve datum carries, so a
  // stale state fails locally with a readable reason rather than on chain.
  const capState = capAccumulatorFromHex(input.capState ?? []);

  const result = await submitter.buyTokens(
    input.buyerMnemonic,
    BigInt(input.tokenAmount),
    capState,
    input.skipClientCapCheck ?? false,
  );
  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
