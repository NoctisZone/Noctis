// ============================================================================
// Noctis Zone — bonding_curve_tier_b.ak's AnchorDvAllocationRoot
// ============================================================================
// Fixes the Merkle root every DarkVeil claim is later proved against.
// Governor-signed, and accepted only while the curve is still Inactive — so a
// mistaken root can be corrected any number of times before public trading
// opens, and not once after.
//
// The spend itself lives on LucidTierBCurveSubmitter, alongside every other
// way a Cardano Launch curve UTXO can be spent. It was a second implementation here
// until this file became a wrapper: that curve compiles to more than 15 KB, so
// a spend has to NAME the published validator rather than carry it, and a
// second copy of the spending logic is a second place for that to be missed.
// This file keeps its own name and shape because the CLI and the plugin call
// it.
//
// The governor's plaintext key material exists only for the lifetime of one
// Node process — passed via stdin by the PHP caller, which decrypts it the
// same way it does for every other platform-wallet signing operation. Never
// logged, never persisted, never returned.
// ============================================================================

import type { Network as LucidNetwork } from '@lucid-evolution/lucid';
import { CML } from '@lucid-evolution/lucid';
import type { ReferenceScriptPointer } from './reference-script.js';
import type { BondingCurveTierBDatumData } from './tier-a-schemas.js';
import { LucidTierBCurveSubmitter } from './tier-b-curve-submitter.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Same conversion as tier-a-curve-submitter.ts's extendedHexToBech32PrivateKey — see that file's own comment for the full reasoning (WeldPress_CardanoWalletPHP's raw 64-byte kL||kR format -> Lucid's bech32 ed25519e_sk...). */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

export interface CardanoDvAllocationAnchorSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve_tier_b.ak's compiled PlutusV3 script CBOR — plutus.json's `validators[].compiledCode` for `bonding_curve_tier_b.bonding_curve_tier_b.spend`. One shared, unparameterized script address across every Cardano Launch launch. */
  compiledScriptCbor: string;
  launchIdHex: string;
  /** The launch's thread-NFT policy id, hex, from the platform's own record —
   *  what the curve UTXO is authenticated against. See launch-utxo-lookup.ts. */
  threadNftPolicyId: string;
  /**
   * Where this validator is published as a reference script.
   *
   * Not optional in practice on this tier, whatever the type says: the
   * validator alone is most of the transaction cap, so an anchor that carries
   * it cannot be submitted. Omitted only so the embedding path stays available
   * for a smaller build or a test.
   */
  referenceScript?: ReferenceScriptPointer;
  /** Execution budgets to declare instead of measuring — see mesh-curve-spend.ts. */
  executionUnits?: { mem: number; steps: number };
}

export class CardanoDvAllocationAnchorSubmitter {
  private readonly curve: LucidTierBCurveSubmitter;

  constructor(config: CardanoDvAllocationAnchorSubmitterConfig) {
    this.curve = new LucidTierBCurveSubmitter({
      blockfrostProjectId: config.blockfrostProjectId,
      blockfrostUrl: config.blockfrostUrl,
      network: config.network,
      compiledScriptCbor: config.compiledScriptCbor,
      launchIdHex: config.launchIdHex,
      threadNftPolicyId: config.threadNftPolicyId,
      ...(config.referenceScript ? { referenceScript: config.referenceScript } : {}),
      ...(config.executionUnits ? { executionUnits: config.executionUnits } : {}),
    });
  }

  async readCurveDatum(): Promise<BondingCurveTierBDatumData> {
    return this.curve.readCurveDatum();
  }

  async anchorDvAllocationRoot(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    dvAllocationRootHex: string,
  ): Promise<{ txHash: string }> {
    return this.curve.anchorDvAllocationRoot(governorPrivateKeyExtendedHex, governorAddress, dvAllocationRootHex);
  }
}

export { extendedHexToBech32PrivateKey, fromHex };
