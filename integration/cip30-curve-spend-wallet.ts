// ============================================================================
// Noctis — a curve-spend wallet backed by a browser's CIP-30 wallet
// ============================================================================
// A Cardano Launch curve action references its validator rather than embedding
// it, and the referenced path builds with Mesh. `KeyCurveSpendWallet` signs for
// the platform's own keys; this is the same shape for a creator's connected
// browser wallet, so a creator can claim their curve fees from the page rather
// than through a tool.
//
// It reads the wallet's own UTXOs and change address over CIP-30, lets Mesh
// build and cost the transaction, then asks the wallet for a partial signature
// and adds the witnesses to the body it built. Adding rather than reconstructing
// keeps the body the node costs identical to the body the builder costed, as in
// `KeyCurveSpendWallet`.
//
// The builder only selects inputs through `spendableForFees`, and collateral
// here is chosen the same way, so an output carrying a reference script is never
// spent or pledged, even from a wallet that publishes scripts.

import type { UTxO as MeshUTxO } from '@meshsdk/core';
import {
  Address,
  addVKeyWitnessSetToTransaction,
  deserializeTxUnspentOutput,
  fromTxUnspentOutput,
  HexBlob,
} from '@meshsdk/core-cst';
import { type CurveSpendWallet, spendableForFees } from './mesh-curve-spend.js';

/** The part of a CIP-30 wallet API this uses. */
export interface Cip30Api {
  getUtxos(): Promise<string[] | null | undefined>;
  getChangeAddress(): Promise<string>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  submitTx(tx: string): Promise<string>;
}

/** Plutus collateral must be pure ada and clear this floor, as Mesh requires. */
const MIN_COLLATERAL_LOVELACE = 5_000_000n;

function lovelaceOf(utxo: MeshUTxO): bigint {
  return BigInt(utxo.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '')?.quantity ?? '0');
}

function isPureAda(utxo: MeshUTxO): boolean {
  return utxo.output.amount.every((a) => a.unit === 'lovelace' || a.unit === '');
}

/** Signs curve spends with the wallet the creator connected in the browser. */
export class Cip30CurveSpendWallet implements CurveSpendWallet {
  constructor(private readonly api: Cip30Api) {}

  /** CIP-30 hands over raw address bytes; the builder wants bech32. */
  async getChangeAddress(): Promise<string> {
    return Address.fromBytes(HexBlob(await this.api.getChangeAddress())).toBech32();
  }

  async getUtxos(): Promise<MeshUTxO[]> {
    const encoded = (await this.api.getUtxos()) ?? [];
    return encoded.map((cbor) => fromTxUnspentOutput(deserializeTxUnspentOutput(cbor)));
  }

  /**
   * The smallest pure-ada output of at least 5 ada, never one carrying a
   * reference script: collateral is forfeit if a script fails, and a lost
   * reference script would break every launch that points at it.
   */
  async getCollateral(): Promise<MeshUTxO[]> {
    const candidates = spendableForFees(await this.getUtxos())
      .filter(isPureAda)
      .filter((u) => lovelaceOf(u) >= MIN_COLLATERAL_LOVELACE)
      .sort((a, b) => Number(lovelaceOf(a) - lovelaceOf(b)));
    const chosen = candidates[0];
    if (!chosen) {
      throw new Error(
        'This wallet has no plain output of at least 5 ADA to pledge as collateral. ' +
          'Send yourself 5 ADA as a separate output and try again.',
      );
    }
    return [chosen];
  }

  /** The wallet signs only its own part; its witnesses are added to the body as built. */
  async signTx(unsignedTxHex: string): Promise<string> {
    const witnessSet = await this.api.signTx(unsignedTxHex, true);
    return addVKeyWitnessSetToTransaction(unsignedTxHex, witnessSet);
  }

  async submitTx(signedTxHex: string): Promise<string> {
    return this.api.submitTx(signedTxHex);
  }
}
