// ============================================================================
// Noctis Zone — Cardano Launch's ClaimDarkVeilTokens
// ============================================================================
// Settles one registrant's private DarkVeil allocation on Cardano: they pay
// the flat DarkVeil price in real ADA and receive their tokens, revealing
// their own allocation and nobody else's. The buyer signs, because the buyer
// pays — the validator asks for exactly the key the leaf was built from.
//
// The spend itself lives on LucidTierBCurveSubmitter, alongside every other
// way a Cardano Launch curve UTXO can be spent, and this file is a wrapper over it.
// That curve compiles to more than 15 KB — more than a transaction can carry
// beside its own inputs and outputs — so a spend has to NAME the published
// script rather than embed it, and a second implementation of how to spend a
// curve is a second place for that to be missed. Same reason the DarkVeil
// allocation anchor moved.
//
// This file keeps its own name and shape because the CLI and the plugin call
// it.
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import type { CapAccumulator } from './cap-accumulator-tree.js';
import { feeSlice } from './curve-pricing.js';
import type { ReferenceScriptPointer } from './reference-script.js';
import { type DarkVeilClaimParams, LucidTierBCurveSubmitter } from './tier-b-curve-submitter.js';

/**
 * Mirrors bonding_curve_tier_b.ak's own `fee_slice` — see ./curve-pricing.ts.
 * The DarkVeil price itself is deliberately FLAT at base_price rather than a
 * point on the curve (that discount is what the phase offers), so this path
 * needs the fee split but not the range formula.
 */
function feeFloor(grossPayment: bigint, bps: bigint): bigint {
  return feeSlice(grossPayment, bps);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export interface LucidDarkVeilClaimSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve_tier_b.ak's compiled PlutusV3 script CBOR. The validator is
   *  unparameterized, so this is one shared script address across every Cardano Launch
   *  launch — launches are told apart by `launch_id` in the datum. */
  compiledScriptCbor: string;
  launchId: Uint8Array;
  /** The launch's thread-NFT policy id, hex, from the platform's own record —
   *  what the curve UTXO is authenticated against. See launch-utxo-lookup.ts. */
  threadNftPolicyId: string;
  /**
   * Where that validator is published as a reference script.
   *
   * Not optional in practice on this tier, whatever the type says: the
   * validator alone is more than a transaction can carry, so a claim that
   * embeds it cannot be submitted.
   */
  referenceScript?: ReferenceScriptPointer;
  /** Execution budgets to declare instead of measuring — see mesh-curve-spend.ts. */
  executionUnits?: { mem: number; steps: number };
}

export class LucidDarkVeilClaimSubmitter {
  private readonly curve: LucidTierBCurveSubmitter;

  constructor(config: LucidDarkVeilClaimSubmitterConfig) {
    this.curve = new LucidTierBCurveSubmitter({
      blockfrostProjectId: config.blockfrostProjectId,
      blockfrostUrl: config.blockfrostUrl,
      network: config.network,
      compiledScriptCbor: config.compiledScriptCbor,
      launchIdHex: toHex(config.launchId),
      threadNftPolicyId: config.threadNftPolicyId,
      ...(config.referenceScript ? { referenceScript: config.referenceScript } : {}),
      ...(config.executionUnits ? { executionUnits: config.executionUnits } : {}),
    });
  }

  /**
   * Buyer-initiated claim, signed in the buyer's own connected wallet. No
   * relayer key is involved: the buyer pays and receives their tokens directly.
   */
  async claimDarkVeilTokens(
    walletApi: WalletApi,
    params: DarkVeilClaimParams,
    capState: CapAccumulator,
  ): Promise<{ txHash: string }> {
    return this.curve.claimDarkVeilTokensWithWallet(walletApi, params, capState);
  }

  /** The curve's script address — see LucidTierBCurveSubmitter.curveAddress. */
  get curveAddress(): string {
    return this.curve.curveAddress;
  }

  /** The launch's current on-chain state, including the `cap_root` a rebuilt
   *  accumulator has to derive. */
  async readCurveDatum() {
    return this.curve.readCurveDatum();
  }

  /** The same claim, signed from a mnemonic — the CLI path. */
  async claimDarkVeilTokensFromMnemonic(
    buyerMnemonic: string,
    params: DarkVeilClaimParams,
    capState: CapAccumulator,
  ): Promise<{ txHash: string }> {
    return this.curve.claimDarkVeilTokens(buyerMnemonic, params, capState);
  }
}

export type { DarkVeilClaimParams };
export { feeFloor, fromHex, toHex };
