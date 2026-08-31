// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 6
// ClaimCreatorFees (bonding_curve.ak) — creator-signed (or community
// wallet, once CTO triggered — not exercised here).
// ============================================================================
// Input: single JSON object on stdin, including the creator's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { usdToMinAdaLovelace } from '../ada-price-oracle.js';
import { BlockfrostClient } from '../blockfrost-client.js';
import { TierAClaimsSubmitter } from '../tier-a-claims-submitter.js';
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

  // bonding_curve.ak now requires a real, on-chain-enforced $1 ADA
  // platform claim fee paid alongside every ClaimCreatorFees. Computed here
  // via the same real Orcfax oracle already built for staking_pool.ak's
  // identical STAKING_CLAIM_FEE_USD — the contract's own on-chain
  // check is only a conservative 0.2 ADA floor (Aiken has no in-circuit
  // oracle access), so this real, live-priced amount comfortably clears it.
  const _blockfrostClient = new BlockfrostClient({
    apiKey: input.blockfrostProjectId,
    network: input.network,
  });
  const { minLovelace: platformClaimFeeLovelace } = await usdToMinAdaLovelace(1);

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
