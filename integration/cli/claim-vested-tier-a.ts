// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 6
// ClaimVested (vesting.ak) — creator-signed. See
// tier-a-claims-submitter.ts's header for the fix this depends on.
// ============================================================================
// Input: single JSON object on stdin, including the creator's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { TierAClaimsSubmitter } from '../tier-a-claims-submitter.js';
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

interface ClaimVestedInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  creatorAddress: string;
  creatorPrivateKeyExtendedHex: string;
  claimAmount: string;
  currentTimestampMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ClaimVestedInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'creatorAddress',
    'creatorPrivateKeyExtendedHex',
    'claimAmount',
    'currentTimestampMs',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);

  const submitter = new TierAClaimsSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    vestingScriptCbor: loadValidatorCbor(blueprint, 'vesting.vesting.spend'),
    bondingCurveScriptCbor: loadValidatorCbor(blueprint, 'bonding_curve.bonding_curve.spend'),
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
  });

  const result = await submitter.claimVested(
    input.creatorPrivateKeyExtendedHex,
    input.creatorAddress,
    BigInt(input.claimAmount),
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
