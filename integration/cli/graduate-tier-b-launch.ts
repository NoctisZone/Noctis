// ============================================================================
// Noctis Zone — Tier B Preprod, graduation CLI
// Graduate (bonding_curve_tier_b) + SealLock (lp_escrow) + StartVesting
// (vesting). Direct mirror of graduate-tier-a-launch.ts — the ONLY
// difference is the bonding-curve script title
// (bonding_curve_tier_b.bonding_curve_tier_b.spend) and the submitter class.
// lp_escrow / vesting are the same shared validators. Two-transaction split
// and governor-signed StartVesting are unchanged — see
// tier-b-graduation-submitter.ts's own header for the full reasoning.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {graduateSealLockTxHash, startVestingTxHash,
// lpAda, lpReserveTokens, stakingReserveTokens} on stdout.
// ============================================================================

import { TierBGraduationSubmitter } from '../tier-b-graduation-submitter.js';
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

interface ReferencePointerInput {
  txHash: string;
  outputIndex: number;
  scriptHash: string;
}

interface GraduateInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  lockSealTimestampMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /** Published reference scripts TX1 names instead of carrying — required. */
  bondingCurveRef: ReferencePointerInput;
  lpEscrowRef: ReferencePointerInput;
  /**
   * Required when the launch opted into staking: the pool's seeding spend
   * (TopUpPool) is creator-signed. Both PLAINTEXT-decrypted server-side by
   * the PHP caller, same handling as the governor key. Never logged.
   */
  creatorAddress?: string;
  creatorPrivateKeyExtendedHex?: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<GraduateInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'governorAddress',
    'governorPrivateKeyExtendedHex',
    'lockSealTimestampMs',
    'blockfrostProjectId',
    'blockfrostUrl',
    'bondingCurveRef',
    'lpEscrowRef',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);

  const submitter = new TierBGraduationSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    bondingCurveTierBScriptCbor: loadValidatorCbor(blueprint, 'bonding_curve_tier_b.bonding_curve_tier_b.spend'),
    lpEscrowScriptCbor: loadValidatorCbor(blueprint, 'lp_escrow.lp_escrow.spend'),
    vestingScriptCbor: loadValidatorCbor(blueprint, 'vesting.vesting.spend'),
    stakingPoolScriptCbor: loadValidatorCbor(blueprint, 'staking_pool.staking_pool.spend'),
    bondingCurveRef: input.bondingCurveRef,
    lpEscrowRef: input.lpEscrowRef,
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
  });

  const creator =
    input.creatorAddress && input.creatorPrivateKeyExtendedHex
      ? { address: input.creatorAddress, privateKeyExtendedHex: input.creatorPrivateKeyExtendedHex }
      : undefined;

  const result = await submitter.graduate(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    requireTimestampMs(input.lockSealTimestampMs, 'lockSealTimestampMs'),
    creator,
  );
  process.stdout.write(
    JSON.stringify({
      graduateSealLockTxHash: result.graduateSealLockTxHash,
      startVestingTxHash: result.startVestingTxHash,
      lpAda: result.lpAda.toString(),
      lpReserveTokens: result.lpReserveTokens.toString(),
      stakingReserveTokens: result.stakingReserveTokens.toString(),
      stakingSeeded: result.stakingSeeded,
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
