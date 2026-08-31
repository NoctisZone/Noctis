// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 5b
// ExecuteDexChange (lp_escrow.ak) — permissionless, applies a pending
// whitelist change once its 72h public notice period has elapsed. See
// tier-a-dex-change-submitter.ts's header (validity-width-bound, real honest
// "now" validity range required).
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller — this redeemer is permissionless on-chain, but this CLI still
// needs a fee-paying/signing wallet, reusing the governor's for
// simplicity). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { TierADexChangeSubmitter } from '../tier-a-dex-change-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsAllowZero,
  requireTimestampMs,
} from './cli-io.js';

declare const __dirname: string;

interface ExecuteDexChangeInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  currentTimestampMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ExecuteDexChangeInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'governorAddress',
    'governorPrivateKeyExtendedHex',
    'currentTimestampMs',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);

  const submitter = new TierADexChangeSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    lpEscrowScriptCbor: loadValidatorCbor(blueprint, 'lp_escrow.lp_escrow.spend'),
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
  });

  const result = await submitter.executeDexChange(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    requireTimestampMs(input.currentTimestampMs, 'currentTimestampMs'),
  );
  process.stdout.write(JSON.stringify({ txHash: result.txHash }));
}

main().catch((err) => {
  if (process.env.NOCTIS_DEBUG) {
    console.error('FULL ERROR:', err);
    console.error('KEYS:', err && typeof err === 'object' ? Object.keys(err) : null);
    console.error('STACK:', err instanceof Error ? err.stack : null);
  }
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
