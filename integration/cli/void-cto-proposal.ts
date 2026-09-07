// ============================================================================
// Noctis Zone — cto_governance.ak VoidPendingProposal CLI
// Governor-only. Voids a pending anchor found to be fraudulent within the
// 24h challenge window and slashes the relayer's bond, whole, to the one
// address the governance datum names.
// See cardano-cto-void-proposal-submitter.ts's own header for the full
// mechanism.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { CardanoCtoVoidProposalSubmitter } from '../cardano-cto-void-proposal-submitter.js';
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

interface VoidProposalInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  currentTimestampMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<VoidProposalInput>(raw);

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
  const compiledScriptCbor = loadValidatorCbor(blueprint, 'cto_governance.cto_governance.spend');

  const submitter = new CardanoCtoVoidProposalSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    compiledScriptCbor,
    governorPrivateKey: input.governorPrivateKeyExtendedHex,
    launchId: hexToBytes(input.launchIdHex),
    threadNftPolicyId: input.threadNftPolicyId,
  });

  const result = await submitter.voidPendingProposal(
    BigInt(requireTimestampMs(input.currentTimestampMs, 'currentTimestampMs')),
    input.governorAddress,
  );
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  if (process.env.NOCTIS_DEBUG) {
    console.error('FULL ERROR:', err);
    console.error('STACK:', err instanceof Error ? err.stack : null);
  }
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
