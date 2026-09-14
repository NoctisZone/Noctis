// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 6
// ClaimCreatorFees (bonding_curve.ak) — creator-signed (or community
// wallet, once CTO triggered — not exercised here).
// ============================================================================
// Input: single JSON object on stdin, including the creator's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { PLATFORM_CHARGE_LOVELACE, TierAClaimsSubmitter } from '../tier-a-claims-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsAllowZero,
} from './cli-io.js';

declare const __dirname: string;

interface ClaimCreatorFeesInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  creatorAddress: string;
  creatorPrivateKeyExtendedHex: string;
  amount: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ClaimCreatorFeesInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'creatorAddress',
    'creatorPrivateKeyExtendedHex',
    'amount',
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

  // bonding_curve.ak enforces the platform's charge on every
  // ClaimCreatorFees, and names the amount outright in ada. Quote that figure
  // rather than pricing one here: no oracle is in the path on either side, so
  // the CLI and the chain cannot disagree about what a claim costs.
  const platformClaimFeeLovelace = PLATFORM_CHARGE_LOVELACE;

  const result = await submitter.claimCreatorFees(
    input.creatorPrivateKeyExtendedHex,
    input.creatorAddress,
    BigInt(input.amount),
    platformClaimFeeLovelace,
  );
  process.stdout.write(
    JSON.stringify({
      txHash: result.txHash,
      platformClaimFeeLovelace: platformClaimFeeLovelace.toString(),
    }),
  );
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
