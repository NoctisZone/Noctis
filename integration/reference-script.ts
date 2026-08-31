// ============================================================================
// Noctis Zone — CIP-33 reference scripts for the curve spend paths
// ============================================================================
// A spending transaction can either EMBED the validator in its witness set or
// REFERENCE one already sitting in someone else's UTXO. Embedding charges the
// whole compiled script against Cardano's 16,384-byte transaction cap;
// referencing charges only a pointer.
//
// This matters because `bonding_curve_tier_b` compiles to over 15 KB. A Cardano Launch
// trade that embeds it has no room left for the cap-accumulator proof a buy
// carries, and a batch of orders is further out of reach still. Referencing
// removes the script from the transaction entirely, which is what makes both
// possible.
//
// Two properties of these validators make this cheap:
//
//   - **They are unparameterized.** Every launch of a tier shares one script
//     address, so ONE published reference UTXO serves every launch of that
//     tier forever. Publishing is a one-time deposit, not a per-launch cost,
//     and the ADA stays recoverable because the reference output pays to our
//     own address.
//
//   - **The script bytes are content-addressed.** A reference pointer is only
//     valid for the exact validator it was published from. Changing a
//     validator by one byte changes its hash, its address, and strands every
//     pointer to the old one — see `resolveReferenceScript`, which refuses to
//     build against a stale pointer rather than producing a transaction that
//     cannot be spent.
//
// **Double-CBOR wrapping is required, not cosmetic.** Aiken's blueprint
// records the raw compiled script; a Plutus script on chain is that wrapped in
// a CBOR bytestring. `applyCborEncoding` does the wrapping, and hashing the
// RAW form instead produces a different hash — and therefore a different,
// unspendable address. `scriptHashOf` below always wraps first, and
// `reference-script.test.ts` pins the result against `plutus.json`'s own
// recorded hash for all twelve validators so a wrong answer here cannot be
// silent.
//
// **Sizes: two different numbers, deliberately.** `rawSizeBytes` is the
// unwrapped script length, and it is what the Conway reference-script
// surcharge is charged on — measured exactly against a real Preprod node by
// submitting a deliberately underpaid transaction and reading the minimum the
// node itself stated. `minFeeRefScriptCostPerByte` is 15, against `min_fee_a`
// of 44, so referencing a script is CHEAPER per transaction than embedding it,
// not merely smaller.

import { applyCborEncoding, resolveScriptHash, serializePlutusScript } from '@meshsdk/core';

/** Cardano's transaction size cap. A transaction over this is rejected outright. */
export const MAX_TX_BYTES = 16_384;

/**
 * Lovelace per byte of reference script, per transaction (Conway
 * `minFeeRefScriptCostPerByte`). Measured on Preprod, not quoted from a
 * parameter dump: two otherwise-identical transactions referencing a 98-byte
 * and a 12,398-byte script differed by exactly 15 lovelace per raw script
 * byte once the size fee was subtracted.
 *
 * Used only to report the expected surcharge; the node computes the real fee.
 */
export const REF_SCRIPT_COST_PER_BYTE = 15;

/** Where a published reference script lives, and which script it holds. */
export interface ReferenceScriptPointer {
  /** The transaction that created the reference output. */
  txHash: string;
  /** Which output of that transaction carries the script. */
  outputIndex: number;
  /**
   * The script hash this pointer was published for. Checked against the
   * validator being spent, so a pointer left over from an older build of the
   * validator fails locally instead of on chain.
   */
  scriptHash: string;
}

/** A reference pointer that has been checked against the validator it claims to hold. */
export interface ResolvedReferenceScript extends ReferenceScriptPointer {
  /** Script address the validator lives at — where the state UTXO sits. */
  scriptAddress: string;
  /**
   * Unwrapped compiled size. This is the figure the Conway surcharge is
   * charged on, so it is what the transaction builder is told.
   */
  rawSizeBytes: number;
}

/** Network ids as Mesh's address serializer takes them. */
export type MeshNetworkId = 0 | 1;

/** Maps this codebase's network names onto Mesh's numeric network id. */
export const MESH_NETWORK_ID: Record<'preview' | 'preprod' | 'mainnet', MeshNetworkId> = {
  preview: 0,
  preprod: 0,
  mainnet: 1,
};

/**
 * The on-chain hash of a validator, from its raw compiled CBOR.
 *
 * Wraps before hashing — see this module's header for why hashing the raw
 * form is a silent, expensive mistake rather than a loud one.
 */
export function scriptHashOf(compiledScriptCbor: string): string {
  return resolveScriptHash(applyCborEncoding(compiledScriptCbor), 'V3');
}

/** The script address a validator's UTXOs live at. */
export function scriptAddressOf(compiledScriptCbor: string, networkId: MeshNetworkId): string {
  return serializePlutusScript({ code: applyCborEncoding(compiledScriptCbor), version: 'V3' }, undefined, networkId)
    .address;
}

/** Unwrapped compiled size in bytes — what the reference-script surcharge is charged on. */
export function rawScriptSize(compiledScriptCbor: string): number {
  return compiledScriptCbor.length / 2;
}

/** What referencing this script adds to a transaction's fee, in lovelace. */
export function referenceSurchargeLovelace(compiledScriptCbor: string): number {
  return rawScriptSize(compiledScriptCbor) * REF_SCRIPT_COST_PER_BYTE;
}

/**
 * Checks a reference pointer actually holds the validator about to be spent,
 * and returns it with the script address and size filled in.
 *
 * **This is the guard that makes the whole approach safe to operate.** These
 * validators change; every change moves the hash, the address, and every
 * launch's UTXOs along with it. A pointer published before such a change still
 * exists on chain and still looks fine, but it holds a script the current
 * state UTXOs are not locked by. Building against it produces a transaction
 * the node rejects for reasons that read as anything but "your pointer is
 * out of date".
 *
 * Same discipline the cap-accumulator submitters already apply to their own
 * off-chain state: derive what the on-chain value should be, compare, and
 * refuse to build on a mismatch so the failure is a readable local error.
 */
export function resolveReferenceScript(
  compiledScriptCbor: string,
  pointer: ReferenceScriptPointer,
  networkId: MeshNetworkId,
): ResolvedReferenceScript {
  const actual = scriptHashOf(compiledScriptCbor);
  if (pointer.scriptHash.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(
      `Reference script pointer is stale: ${pointer.txHash}#${pointer.outputIndex} was published ` +
        `for script hash ${pointer.scriptHash}, but the validator being spent hashes to ${actual}. ` +
        'The validator has changed since that script was published — publish a new reference script ' +
        'and update the pointer.',
    );
  }
  return {
    ...pointer,
    scriptAddress: scriptAddressOf(compiledScriptCbor, networkId),
    rawSizeBytes: rawScriptSize(compiledScriptCbor),
  };
}

/**
 * Whether a validator can be PUBLISHED at all.
 *
 * A reference script is created by an ordinary transaction, which is bound by
 * the same 16,384-byte cap as any other — and the script has to serialise
 * whole into the one output carrying it, so this cannot be dodged by splitting
 * the transaction. Measured overhead beyond the script itself is ~232 bytes
 * unsigned and ~332 signed, so the headroom below is deliberately conservative.
 *
 * Cardano Launch has been over this line before. It is worth knowing before spending
 * the deposit, not after.
 */
export const PUBLISH_TX_OVERHEAD_BYTES = 332;

/** Largest raw script that still fits in a publishing transaction. */
export const MAX_PUBLISHABLE_SCRIPT_BYTES = MAX_TX_BYTES - PUBLISH_TX_OVERHEAD_BYTES;

/** Throws unless the script is small enough for a publishing transaction to carry it. */
export function assertPublishable(compiledScriptCbor: string, label: string): void {
  const size = rawScriptSize(compiledScriptCbor);
  if (size > MAX_PUBLISHABLE_SCRIPT_BYTES) {
    throw new Error(
      `${label} is ${size} bytes, over the ${MAX_PUBLISHABLE_SCRIPT_BYTES}-byte limit a publishing ` +
        `transaction can carry (${MAX_TX_BYTES} cap less ~${PUBLISH_TX_OVERHEAD_BYTES} bytes of ` +
        'transaction overhead). The script has to serialise whole into one output, so this cannot be ' +
        'split across transactions — the validator has to get smaller first.',
    );
  }
}
