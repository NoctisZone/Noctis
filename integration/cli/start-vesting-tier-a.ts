// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 5
// StartVesting (vesting.ak) — standalone, independently retriable.
// Independent of graduation (no cross-contract check in either direction —
// see tier-a-graduation-submitter.ts's header), so it runs after a
// graduation as its second transaction, or alone to recover when that
// second transaction failed, without touching curve or escrow state.
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
    // Vesting is the one validator this needs: StartVesting never reads curve
    // or escrow state, and vesting is shared by every Cardano launch.
    vestingScriptCbor: loadValidatorCbor(blueprint, 'vesting.vesting.spend'),
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
