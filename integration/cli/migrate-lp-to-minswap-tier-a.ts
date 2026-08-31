// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 5b
// Real Migrate (lp_escrow.ak) + Minswap V2 pool-creation, combined in one
// transaction. See tier-a-lp-migration-submitter.ts's header for the full
// design and verification trail.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash, lpAssetNameHex, initialLiquidity}
// on stdout.
// ============================================================================

import { TierALpMigrationSubmitter } from '../tier-a-lp-migration-submitter.js';
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

interface MigrateInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  currentTimestampMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  minswap: {
    factoryAddress: string;
    factoryScriptHash: string;
    factoryAsset: string;
    poolAuthenAsset: string;
    lpPolicyId: string;
    poolCreationAddress: string;
    poolScriptHash: string;
    poolBatchingStakeScriptHash: string;
    factoryValidatorCbor: string;
    authenPolicyCbor: string;
  };
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<MigrateInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'governorAddress',
    'governorPrivateKeyExtendedHex',
    'currentTimestampMs',
    'blockfrostProjectId',
    'blockfrostUrl',
    'minswap',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);

  const submitter = new TierALpMigrationSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    lpEscrowScriptCbor: loadValidatorCbor(blueprint, 'lp_escrow.lp_escrow.spend'),
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
    minswap: input.minswap,
  });

  const result = await submitter.migrateToMinswapPool(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    requireTimestampMs(input.currentTimestampMs, 'currentTimestampMs'),
  );
  process.stdout.write(
    JSON.stringify({
      txHash: result.txHash,
      lpAssetNameHex: result.lpAssetNameHex,
      initialLiquidity: result.initialLiquidity.toString(),
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
