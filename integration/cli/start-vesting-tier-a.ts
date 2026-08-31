// ============================================================================
// Noctis Zone — Tier A Preprod Milestone, Phase 5
// StartVesting (vesting.ak) — standalone, independently retriable.
// (2026-07-17): split out of graduate-tier-a-launch.ts's single tx once
// embedding all 3 validators in one transaction exceeded Cardano's real
// 16384-byte tx size cap. Verified independent of Graduate/SealLock (no
// cross-contract check in either direction) — see
// tier-a-graduation-submitter.ts's own header for the full trail. Exists as
// its own CLI both for the normal graduate() flow's TX2 and for recovery:
// if TX2 fails after TX1 (Graduate+SealLock) already landed on-chain, this
// can be re-run alone without re-touching curve/lp_escrow state.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { TierAGraduationSubmitter } from '../tier-a-graduation-submitter.js';
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

interface StartVestingInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  vestStartTimestampMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<StartVestingInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'governorAddress',
    'governorPrivateKeyExtendedHex',
    'vestStartTimestampMs',
    'blockfrostProjectId',
    'blockfrostUrl',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);

  const submitter = new TierAGraduationSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    // Graduate/SealLock scripts aren't needed for this call, but the
    // submitter's constructor derives every validator address up front —
    // pass the real compiled code for all of them regardless. The two
    // reference pointers stay unset: startVesting never builds TX1.
    bondingCurveScriptCbor: loadValidatorCbor(blueprint, 'bonding_curve.bonding_curve.spend'),
    lpEscrowScriptCbor: loadValidatorCbor(blueprint, 'lp_escrow.lp_escrow.spend'),
    vestingScriptCbor: loadValidatorCbor(blueprint, 'vesting.vesting.spend'),
    stakingPoolScriptCbor: loadValidatorCbor(blueprint, 'staking_pool.staking_pool.spend'),
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
  });

  const result = await submitter.startVesting(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    requireTimestampMs(input.vestStartTimestampMs, 'vestStartTimestampMs'),
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
