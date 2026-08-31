// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 4
// ActivateCurve — governor-signed, single-phase (see tier-a-curve-
// submitter.ts's own header for why the original two-phase build/sign(PHP)/
// submit design was abandoned: WeldPress's CBOR parser rejected Lucid's
// indefinite-length encoding, and a canonical-CBOR workaround then hit a
// ScriptIntegrityHashMismatch from reconstructing the tx in a separate
// process. Signing directly here with CML.PrivateKey.from_extended_bytes()
// avoids both.)
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller — same trust boundary it already crosses for the mint flow's
// policy-wallet signing). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { LucidTierACurveSubmitter } from '../tier-a-curve-submitter.js';
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

interface ActivateCurveInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  currentTimestampMs: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<ActivateCurveInput>(raw);

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
  const compiledScriptCbor = loadValidatorCbor(blueprint, 'bonding_curve.bonding_curve.spend');

  const submitter = new LucidTierACurveSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: CARDANO_NETWORK_MAP[input.network],
    compiledScriptCbor,
    launchIdHex: input.launchIdHex,
    threadNftPolicyId: input.threadNftPolicyId,
  });

  const result = await submitter.activateCurve(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    requireTimestampMs(input.currentTimestampMs, 'currentTimestampMs'),
  );
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
