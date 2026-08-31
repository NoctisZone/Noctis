// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 7
// ClaimBuyback — buyer-signed, mnemonic-based (this session's CLI-driven
// verification path, same convention as buy-tier-a-curve.ts).
// ============================================================================
// Input: single JSON object on stdin. Output: single JSON object on stdout
// ({txHash, share}).
// ============================================================================

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

interface ClaimBuybackInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  buyerMnemonic: string;
  tokenAmount: string; // stringified bigint over stdin JSON
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ClaimBuybackInput>(raw);

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

  const result = await submitter.claimBuyback(input.buyerMnemonic, BigInt(input.tokenAmount));
  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  if (process.env.NOCTIS_DEBUG) {
    console.error('FULL ERROR:', err);
    console.error('STACK:', err instanceof Error ? err.stack : null);
  }
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
