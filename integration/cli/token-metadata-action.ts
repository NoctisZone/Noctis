// ============================================================================
// Noctis Zone — token_metadata.ak real Cardano actions
// ============================================================================
// One consolidated CLI (action-dispatched), matching this repo's own
// established convention (tier-b-curve-action.ts, staking_action_cli_path).
//
// The reference NFT is minted at genesis by the launch token's own one-shot
// policy, so there is no mint action here — CIP-68 revises metadata by
// SPENDING that UTXO, never by minting again. The build action returns an
// UNSIGNED transaction for a real end-user's own browser wallet to sign
// (never a platform key), and the submit action takes that CBOR back plus the
// wallet's own witness set and finalizes it. This two-step shape mirrors
// create.js's existing tx/build -> weld.signTx -> tx/submit flow exactly.
//
// Input: single JSON object on stdin, `action` selects the operation.
// Output: single JSON object on stdout (bigints stringified) or { error }.
// ============================================================================

import type { Cip68FungibleMetadata } from '../tier-a-schemas.js';
import { metadataWithLogo, TokenMetadataSubmitter } from '../token-metadata-submitter.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireField,
  requireFieldsFalsy,
  requireTimestampMs,
} from './cli-io.js';

declare const __dirname: string;

type Action = 'build-update' | 'submit-update' | 'read';

interface Input {
  action: Action;
  network: 'preview' | 'preprod' | 'mainnet';
  blockfrostProjectId: string;
  blockfrostUrl: string;
  launchIdHex: string;
  bondingCurveScriptHash: string;
  ctoGovernanceScriptHash: string;
  threadNftPolicyIdHex: string;
  tokenPolicyIdHex: string;
  tokenAssetNameHex: string;
  curveAddress: string;

  // build-update. A revision replaces the metadata map wholesale, so every
  // field the launch should keep must be present, not just the changed ones.
  // Or `logoUri` alone: the current map is read from the chain and only its
  // logo replaced, which is what a logo update from a page means.
  callerAddress?: string;
  metadata?: Cip68FungibleMetadata;
  logoUri?: string;
  currentTimestampMs?: number;

  // submit-update
  unsignedTxCbor?: string;
  witnessSetCbor?: string;
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  requireFieldsFalsy(input, [
    'action',
    'network',
    'blockfrostProjectId',
    'blockfrostUrl',
    'launchIdHex',
    'bondingCurveScriptHash',
    'ctoGovernanceScriptHash',
    'threadNftPolicyIdHex',
    'tokenPolicyIdHex',
    'tokenAssetNameHex',
    'curveAddress',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);

  // Lazily constructed, and that ordering is the point: the submitter opens a
  // Blockfrost connection in its constructor and stores the promise, which
  // nothing awaits until a method runs. Built before the per-action field
  // checks below, a request that was never valid still opened a connection —
  // and when that connection then failed, its rejection had no awaiter, so
  // Node printed a stack trace to stderr AFTER the real {"error"} answer had
  // already gone to stdout. The output contract held; a human reading the
  // terminal saw a crash next to a correct message.
  //
  // Each case validates its own fields on their own lines before calling
  // `submitter()`, so an invalid request never reaches the network at all.
  let submitterInstance: TokenMetadataSubmitter | null = null;
  const submitter = (): TokenMetadataSubmitter =>
    (submitterInstance ??= new TokenMetadataSubmitter({
      blockfrostProjectId: input.blockfrostProjectId,
      blockfrostUrl: input.blockfrostUrl,
      network: CARDANO_NETWORK_MAP[input.network],
      spendScriptCbor: loadValidatorCbor(blueprint, 'token_metadata.token_metadata.spend'),
      bondingCurveScriptHash: input.bondingCurveScriptHash,
      ctoGovernanceScriptHash: input.ctoGovernanceScriptHash,
      threadNftPolicyId: input.threadNftPolicyIdHex,
      tokenPolicyId: input.tokenPolicyIdHex,
      tokenAssetNameHex: input.tokenAssetNameHex,
      launchId: hexToBytes(input.launchIdHex),
    }));

  let result: unknown;
  switch (input.action) {
    case 'build-update': {
      const callerAddress = requireField(input, 'callerAddress', input.action);
      const ts = requireTimestampMs(requireField(input, 'currentTimestampMs', input.action), 'currentTimestampMs');
      let metadata = input.metadata;
      if (!metadata) {
        const logoUri = requireField(input, 'logoUri', input.action);
        const current = await submitter().getCurrentMetadata();
        if (!current) throw new Error('This launch has no metadata on chain to update.');
        metadata = metadataWithLogo(current.metadata, logoUri);
      }
      result = await submitter().buildUpdateMetadata({
        callerAddress,
        curveAddress: input.curveAddress,
        newMetadata: metadata,
        currentTimestamp: ts,
      });
      break;
    }
    case 'read': {
      // Wrapped, not returned bare. A launch that has not minted its
      // reference NFT yet is a normal state and reads back as null — but the
      // stdout contract every caller relies on is "one JSON object", and a
      // bare `null` decodes on the PHP side identically to a process that
      // produced nothing at all. Wrapping keeps "no metadata yet"
      // distinguishable from "the CLI failed".
      result = { metadata: await submitter().getCurrentMetadata() };
      break;
    }
    case 'submit-update': {
      const unsignedTxCbor = requireField(input, 'unsignedTxCbor', input.action);
      const witnessSetCbor = requireField(input, 'witnessSetCbor', input.action);
      result = await submitter().finalizeAndSubmit(unsignedTxCbor, witnessSetCbor);
      break;
    }
    default:
      throw new Error(`Unknown action: ${input.action}`);
  }

  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
