// ============================================================================
// Noctis Zone — publish a validator as a CIP-33 reference script
// ============================================================================
// A one-time deposit per validator, not per launch: a launch-package validator
// is unparameterized, so one published output serves every launch of that tier
// forever, and the ada stays recoverable because the output pays back to the
// publishing wallet. A venue validator that takes a parameter is one-time per
// deployment instead — its parameters are fixed before any launch is minted
// against it.
//
// TWO WAYS TO NAME THE SCRIPT, and the second exists because of the first's
// limit. `validatorTitle` reads the compiled bytes out of the launch package's
// blueprint, which is right for anything a build produces directly. A
// parameterised validator has no deployable bytes there at all: what deploys is
// the result of applying its parameters, and that is produced by
// `aiken blueprint apply`, not by the compiler. So those bytes are passed in
// directly as `compiledScriptCbor`, alongside the `expectedScriptHash` they are
// supposed to have — and this refuses to publish unless the bytes it was handed
// really do hash to the hash it was told, before any ada moves. Deriving the
// hash from the bytes rather than trusting either is the same rule the whole
// reference-script path runs on: a wrong script here publishes successfully and
// strands the deposit at an address nothing will ever spend from.
//
// Do NOT apply parameters with a general-purpose SDK helper and publish the
// result. Mesh's `applyParamsToScript` and `aiken blueprint apply` produce
// DIFFERENT bytes for the same validator and parameter — different lengths,
// different hashes, and one of them arrives already CBOR-wrapped so a later
// wrap makes a third answer. All are well formed and only one is the script
// the blueprint's own deployment order names. Apply with Aiken, then bring the
// bytes here.
//
// This has to be re-run whenever the validator changes. A validator's hash is
// its identity, so a change moves the address every launch lives at and leaves
// the old published script pointing at nothing spendable. The pointer this
// prints is what a spender must be configured with; a spender handed a stale
// one refuses to build rather than producing a transaction the node rejects
// for reasons that name neither the pointer nor the validator.
//
// Run with `--dry-run` first. It builds and measures the real transaction,
// reports the pointer a real run would produce, and submits nothing.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import { BlockfrostProvider, MeshWallet } from '@meshsdk/core';
import type { CurveNetwork } from '../mesh-curve-spend.js';
import { MESH_NETWORK_ID } from '../reference-script.js';
import { publishReferenceScript } from '../reference-script-publisher.js';
import { jsonSafe, loadPlutusBlueprint, loadValidatorCbor, parseJsonStdin, readStdin, requireField } from './cli-io.js';

declare const __dirname: string;

interface PublishReferenceScriptInput {
  network: CurveNetwork;
  /**
   * The validator's title in plutus.json, e.g. `bonding_curve.bonding_curve.spend`.
   * Omit when passing `compiledScriptCbor`; it is then only a label.
   */
  validatorTitle: string;
  /** Applied bytes for a parameterised validator, from `aiken blueprint apply`. */
  compiledScriptCbor?: string;
  /** The hash those bytes must have. Required with `compiledScriptCbor`. */
  expectedScriptHash?: string;
  /** Publishing wallet's BIP-39 mnemonic. The deposit returns to this wallet. */
  publisherMnemonic: string;
  blockfrostProjectId: string;
  /** Build and measure without submitting. */
  dryRun?: boolean;
}

async function main() {
  const input = parseJsonStdin<PublishReferenceScriptInput>(await readStdin());

  const network = requireField(input, 'network');
  const validatorTitle = requireField(input, 'validatorTitle');
  const publisherMnemonic = requireField(input, 'publisherMnemonic');
  const blockfrostProjectId = requireField(input, 'blockfrostProjectId');

  // Applied bytes arrive with the hash they are supposed to have, and the
  // publisher refuses unless the two agree. Bytes read from the blueprint are
  // already the ones the compiler recorded, so they carry no second opinion to
  // check against.
  const supplied = input.compiledScriptCbor;
  const compiledScriptCbor = supplied ?? loadValidatorCbor(loadPlutusBlueprint(__dirname), validatorTitle);
  const expectedScriptHash = supplied ? requireField(input, 'expectedScriptHash') : undefined;

  const provider = new BlockfrostProvider(blockfrostProjectId);
  const wallet = new MeshWallet({
    networkId: MESH_NETWORK_ID[network],
    fetcher: provider,
    submitter: provider,
    key: { type: 'mnemonic', words: publisherMnemonic.trim().split(/\s+/) },
  });

  const result = await publishReferenceScript({
    network,
    compiledScriptCbor,
    ...(expectedScriptHash ? { expectedScriptHash } : {}),
    label: validatorTitle,
    provider,
    wallet,
    dryRun: input.dryRun ?? false,
  });

  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
