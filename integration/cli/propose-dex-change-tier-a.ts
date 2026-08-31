// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 5b
// ProposeDexChange (lp_escrow.ak) — multisig-signed, starts the 72h public
// notice clock. See tier-a-dex-change-submitter.ts's header for the full
// design (why backdating `timestamp` here is legitimate, unlike
// ExecuteDexChange).
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { type DexAction, TierADexChangeSubmitter } from '../tier-a-dex-change-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireFieldsAllowZero,
} from './cli-io.js';

declare const __dirname: string;

interface ProposeDexChangeInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  targetDexScriptHashHex: string;
  action: DexAction;
  proposedAtMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ProposeDexChangeInput>(raw);

  requireFieldsAllowZero(input, [
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'governorAddress',
    'governorPrivateKeyExtendedHex',
    'targetDexScriptHashHex',
    'action',
    'proposedAtMs',
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

  const result = await submitter.proposeDexChange(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    input.targetDexScriptHashHex,
    input.action,
    input.proposedAtMs,
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
