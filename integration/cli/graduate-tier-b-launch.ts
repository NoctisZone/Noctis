// ============================================================================
// Noctis Zone — Cardano Launch, graduation CLI
// ============================================================================
// Two transactions: the graduation itself (Graduate + SealLock + the venue
// factory's Create + TopUpPool for a staking launch) and then StartVesting.
// tier-b-graduation-submitter.ts's header has the reasoning; this file only
// gathers inputs and prints the result.
//
// The venue factory comes from `contracts/cardano-dex/deployment/applied.json`
// rather than from a blueprint, because a parameterised validator has no
// deployable bytes until its parameters are applied — and the same record
// supplies the parameter VALUES the pool's opening datum has to reproduce.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {graduateSealLockTxHash, startVestingTxHash,
// lpAda, lpReserveTokens, stakingReserveTokens, stakingSeeded, poolAddress,
// poolUtxoRef, poolNftUnit, lqUnit, escrowedLq} on stdout.
// ============================================================================

import { TierBGraduationSubmitter } from '../tier-b-graduation-submitter.js';
import { readVenueFactoryParameters, VENUE_FACTORY_TITLE } from '../venue-pool.js';
import {
  CARDANO_NETWORK_MAP,
  loadAppliedVenueValidator,
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
   * The venue factory's published pointer, and the staking pool's. Optional:
   * without one the script is carried in the witness set instead, which is
   * correct and larger. See tier-b-graduation-submitter.ts's header for what
   * the transaction has room for.
   */
  venueFactoryRef?: ReferencePointerInput;
  stakingPoolRef?: ReferencePointerInput;
  /**
   * The creator's fee-recipient Ed25519 PUBLIC KEY, hex. Not derivable from
   * an address — see the submitter's header. Captured at launch creation.
   */
  creatorRoyaltyPubKeyHex: string;
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
    'creatorRoyaltyPubKeyHex',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);
  // The applied factory, bytes and parameters together — see
  // loadAppliedVenueValidator for why they must not be sourced separately.
  const factory = loadAppliedVenueValidator(__dirname, VENUE_FACTORY_TITLE);

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
    stakingPoolRef: input.stakingPoolRef,
    venue: {
      factoryScriptCbor: factory.compiledCode,
      factoryRef: input.venueFactoryRef,
      parameters: readVenueFactoryParameters(factory),
    },
    creatorRoyaltyPubKeyHex: input.creatorRoyaltyPubKeyHex,
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
      poolAddress: result.poolAddress,
      poolUtxoRef: result.poolUtxoRef,
      poolNftUnit: result.poolNftUnit,
      lqUnit: result.lqUnit,
      escrowedLq: result.escrowedLq.toString(),
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
