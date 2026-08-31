// ============================================================================
// Noctis Zone — a curve-spend wallet backed by a raw extended key
// ============================================================================
// Every Cardano Launch curve action has to reference its validator rather than embed
// it, and the referenced path builds with Mesh. Mesh's own `MeshWallet` covers
// the trades, which are signed from a mnemonic — but the governor and creator
// actions are not. The platform's wallet custody never persists a mnemonic: it
// stores a 64-byte BIP32-Ed25519 extended private key (kL||kR, no chaincode),
// decrypts it for the lifetime of one process, and signs with that. So a
// referenced Cardano Launch activation, fee claim or expiry needs a wallet of this
// shape, and there was none.
//
// It is deliberately the smallest thing that satisfies `CurveSpendWallet`:
// UTXOs and submission come from a provider, change goes to the one address it
// was given, and signing is the same three steps Mesh performs internally —
// hash the body, sign the hash, attach the witness.
//
// The property that matters is that the body reaching the node is the body the
// builder costed: it carries a script-data hash over the redeemers, and a body
// whose bytes moved under it is rejected without the signature being mentioned
// at all. Adding a witness rather than reconstructing the transaction is the
// direct way to hold that. Measured, not assumed — and measured against the
// alternative too: reconstructing through this serialisation library turns out
// to round-trip the body byte-for-byte as well, so the guarantee here is the
// property, not this particular route to it.
//
// **The key is checked against the address before anything is built.** A
// mismatch otherwise surfaces as a node rejection about a missing signature,
// naming neither the key nor the address, after a full build-and-submit round
// trip.

import { deserializeAddress, type UTxO as MeshUTxO } from '@meshsdk/core';
import {
  addVKeyWitnessSetToTransaction,
  CborSet,
  Crypto,
  Ed25519PrivateKey,
  HexBlob,
  resolveTxHash,
  TransactionWitnessSet,
  VkeyWitness,
} from '@meshsdk/core-cst';
import { type CurveSpendWallet, spendableForFees } from './mesh-curve-spend.js';

/** What this wallet needs from a chain provider. Mesh's providers satisfy it. */
export interface KeyWalletProvider {
  fetchAddressUTxOs(address: string): Promise<MeshUTxO[]>;
  submitTx(txHex: string): Promise<string>;
}

export interface KeyCurveSpendWalletConfig {
  /** The signer's own address: its UTXOs fund the spend and change returns here. */
  address: string;
  /** A 64-byte BIP32-Ed25519 extended private key (kL||kR), hex — 128 characters. */
  privateKeyExtendedHex: string;
  provider: KeyWalletProvider;
}

/**
 * Collateral must be at least this much, and Plutus collateral must be pure
 * ada. Mesh applies the same floor when picking collateral for its own wallets.
 */
const MIN_COLLATERAL_LOVELACE = 5_000_000n;

function lovelaceOf(utxo: MeshUTxO): bigint {
  return BigInt(utxo.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '')?.quantity ?? '0');
}

function isPureAda(utxo: MeshUTxO): boolean {
  return utxo.output.amount.every((a) => a.unit === 'lovelace' || a.unit === '');
}

/**
 * Signs curve spends with a decrypted extended key.
 *
 * Built through {@link forAddress} rather than `new`, because the libsodium
 * backend behind the key primitives has to be initialised before a key can be
 * read at all, and because that is the moment to check the key really does
 * belong to the address.
 */
export class KeyCurveSpendWallet implements CurveSpendWallet {
  private constructor(
    private readonly config: KeyCurveSpendWalletConfig,
    private readonly key: Ed25519PrivateKey,
  ) {}

  /**
   * Reads the key, and refuses it if it does not sign for the address given.
   *
   * The check is not a formality: this wallet's whole job is to satisfy a
   * `requiredSignerHash` the validator insists on, and the wrong key produces a
   * transaction that builds cleanly, costs a full round trip, and is then
   * rejected for a reason that mentions neither the key nor the address.
   */
  static async forAddress(config: KeyCurveSpendWalletConfig): Promise<KeyCurveSpendWallet> {
    if (!/^[0-9a-fA-F]{128}$/.test(config.privateKeyExtendedHex)) {
      throw new Error(
        'Expected a 64-byte extended private key (kL||kR) as 128 hex characters, got ' +
          `${config.privateKeyExtendedHex.length} characters.`,
      );
    }
    await Crypto.ready();
    const key = Ed25519PrivateKey.fromExtendedHex(config.privateKeyExtendedHex);

    const expected = deserializeAddress(config.address).pubKeyHash;
    const actual = key.toPublic().hash().hex();
    if (!expected) {
      throw new Error(
        `${config.address} has no payment key hash — a script address cannot sign, so this key has ` +
          'nothing to sign for.',
      );
    }
    if (expected.toLowerCase() !== actual.toLowerCase()) {
      throw new Error(
        `The key signs for ${actual}, but ${config.address} is controlled by ${expected}. ` +
          'Nothing this key signed would satisfy that address.',
      );
    }
    return new KeyCurveSpendWallet(config, key);
  }

  async getChangeAddress(): Promise<string> {
    return this.config.address;
  }

  async getUtxos(): Promise<MeshUTxO[]> {
    return this.config.provider.fetchAddressUTxOs(this.config.address);
  }

  /**
   * A pure-ada UTXO of at least 5 ada — the smallest that clears the floor, so
   * a large one is not tied up as collateral.
   *
   * Reference scripts are excluded even though they are pure ada and would
   * otherwise qualify. Collateral is only consumed when a script fails, but
   * that is exactly the case worth surviving: losing a reference script to a
   * failed transaction would break every launch pointing at it.
   */
  async getCollateral(): Promise<MeshUTxO[]> {
    const candidates = spendableForFees(await this.getUtxos())
      .filter(isPureAda)
      .filter((u) => lovelaceOf(u) >= MIN_COLLATERAL_LOVELACE)
      .sort((a, b) => Number(lovelaceOf(a) - lovelaceOf(b)));
    const chosen = candidates[0];
    return chosen ? [chosen] : [];
  }

  /**
   * Attaches this key's witness to a transaction someone else built.
   *
   * The body is added to rather than reconstructed, so what the node costs is
   * what the builder costed — see this module's header for what that buys and
   * what it does not.
   */
  async signTx(unsignedTxHex: string): Promise<string> {
    const witness = new VkeyWitness(
      this.key.toPublic().hex(),
      this.key.sign(HexBlob(resolveTxHash(unsignedTxHex))).hex(),
    );
    const witnesses = new TransactionWitnessSet();
    witnesses.setVkeys(CborSet.fromCore([witness.toCore()], VkeyWitness.fromCore));
    return addVKeyWitnessSetToTransaction(unsignedTxHex, witnesses.toCbor());
  }

  async submitTx(signedTxHex: string): Promise<string> {
    return this.config.provider.submitTx(signedTxHex);
  }
}
