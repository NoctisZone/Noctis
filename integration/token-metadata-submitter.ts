// ============================================================================
// Noctis Zone — Lucid Evolution submitter for token_metadata.ak
// ============================================================================
// Builds real transactions for revising a launch's CIP-68 metadata. The
// reference NFT itself is minted at genesis, by the launch token's own
// one-shot policy (see launch-mint-submitter.ts) — CIP-68 requires the token
// and its reference NFT to share one policy id, which is what makes the
// metadata discoverable from the token. Revisions are spends of that UTXO,
// never mints, so this submitter only ever spends. Structurally
// mirrors cardano-anchor-submitter.ts — same Data-schema-from-compiled-
// blueprint discipline, same real `@lucid-evolution/lucid` (0.5.5, confirmed
// installed) API surface.
//
// Key difference from LucidAnchorSubmitter: that class holds a platform
// relayer's own private key and signs+submits fully server-side, because
// it's a platform-operated relayer action. This submitter must NOT do that —
// per this feature's own design, minting and updating are creator/community-
// wallet actions, signed with THEIR OWN wallet, never a platform key. It
// builds UNSIGNED transactions and returns CBOR for the browser wallet to
// sign, the same two-step shape create.js's own mint flow already uses
// (tx/build -> weld.signTx -> tx/submit).
//
// Verified against the real installed package before writing this (not
// assumed): `lucid.selectWallet.fromAddress(address, utxos) => void` is a
// real method (integration/node_modules/@lucid-evolution/lucid/dist/index.d.ts,
// confirmed present); `TxBuilder.complete() => Promise<TxSignBuilder>`,
// `TxSignBuilder.toCBOR()`, `TxSignBuilder.assemble(witnesses)`,
// `lucid.fromTx(cbor) => TxSignBuilder`, and `TxSigned.submit()` are all real,
// confirmed methods — this is the exact "build unsigned, round-trip through a
// browser wallet, assemble + submit" shape. `applyParamsToScript`,
// `mintingPolicyToId`, `validatorToScriptHash`, `applyDoubleCborEncoding` were
// also confirmed real via a standalone tsc --noEmit type-check against the
// installed package before use, not assumed from prior Lucid Evolution
// experience.
//
// The Data schemas below are hand-mirrored from a real, freshly-compiled
// `contracts/cardano/plutus.json` (token_metadata.ak's own CIP-57 blueprint
// output) — field names, order, and constructor indices copied directly from
// the compiled schema, not the .ak source — same discipline
// cardano-anchor-submitter.ts already documents and this repo's own
// drift history warns is necessary.
// ============================================================================

import type {
  Address,
  LucidEvolution,
  Network as LucidNetwork,
  SpendingValidator,
  TransactionWitnesses,
  UTxO,
} from '@lucid-evolution/lucid';
import {
  applyDoubleCborEncoding,
  Data,
  Lucid,
  validatorToAddress,
  validatorToScriptHash,
} from '@lucid-evolution/lucid';
import { cardanoProvider } from './cardano-provider.js';
import {
  type BondingCurveTierBDatumData,
  BondingCurveTierBDatumSchema,
  buildCip68FungibleMetadata,
  type Cip68FungibleMetadata,
  type Cip68MetadataData,
  Cip68MetadataShape,
  type TokenMetadataDatumData,
  TokenMetadataDatumSchema,
} from './launch-schemas.js';
import { LaunchUtxoNotFoundError, selectCip68MetadataUtxo, selectLaunchUtxo } from './launch-utxo-lookup.js';

/** The six fields Noctis writes into a launch's CIP-68 map, by their hex keys. */
const KNOWN_METADATA_KEYS = ['name', 'description', 'ticker', 'url', 'logo', 'decimals'].map((k) =>
  Buffer.from(k, 'utf8').toString('hex'),
);

/**
 * A launch's metadata as it stands on chain, with only its logo replaced:
 * what a logo update submits, since a revision replaces the whole map.
 *
 * `current` is the raw map `getCurrentMetadata` reads (hex keys, hex or
 * integer values). A key outside the six this platform writes is refused
 * rather than dropped, because the new map would silently lose it. The logo
 * must be an `https://` or `ipfs://` URI: a wallet renders either, and a site
 * without an IPFS pinning service can still point at the image it hosts.
 */
export function metadataWithLogo(current: Record<string, string>, logoUri: string): Cip68FungibleMetadata {
  if (!/^(https|ipfs):\/\/\S+$/.test(logoUri)) {
    throw new Error(`A logo must be an https:// or ipfs:// URI, got ${JSON.stringify(logoUri)}.`);
  }
  const unknown = Object.keys(current).filter((k) => !KNOWN_METADATA_KEYS.includes(k));
  if (unknown.length) {
    const names = unknown.map((k) => Buffer.from(k, 'hex').toString('utf8'));
    throw new Error(`The metadata carries fields this update would drop (${names.join(', ')}); refusing to lose them.`);
  }
  const text = (key: string): string | undefined => {
    const hex = current[Buffer.from(key, 'utf8').toString('hex')];
    return hex === undefined ? undefined : Buffer.from(hex, 'hex').toString('utf8');
  };
  const decimals = current[Buffer.from('decimals', 'utf8').toString('hex')];
  return {
    name: text('name') ?? '',
    description: text('description') ?? '',
    ...(text('ticker') !== undefined ? { ticker: text('ticker') } : {}),
    ...(text('url') !== undefined ? { url: text('url') } : {}),
    ...(decimals !== undefined ? { decimals: Number(decimals) } : {}),
    logo: logoUri,
  };
}

// ============================================================================
// DATA SCHEMAS
// ============================================================================
// TokenMetadataDatum lives in launch-schemas.ts, because the genesis mint
// authors this datum and this submitter revises it — the two drifting apart
// is precisely the failure that module exists to prevent. Its shape mirrors
// the compiled blueprint: constructor 0 over [metadata, version, extra],
// with `metadata` a real Plutus map.

/**
 * token_metadata/TokenMetadataRedeemer — 3 constructors per the compiled
 * blueprint: UpdateMetadata=0, TriggerCTO=1, DissolveCTO=2. This submitter
 * only ever constructs UpdateMetadata (the only redeemer Phase F/G's mint +
 * update flows need) — TriggerCTO/DissolveCTO are built by whatever CTO
 * execution flow already exists (mirrors bonding_curve.ak's own
 * executeCtoProposal wiring, out of scope here).
 */
const UpdateMetadataRedeemerShape = Data.Object({
  new_metadata: Cip68MetadataShape,
  current_timestamp: Data.Integer(),
});
type UpdateMetadataRedeemerData = Data.Static<typeof UpdateMetadataRedeemerShape>;
const UpdateMetadataRedeemerSchema = UpdateMetadataRedeemerShape as unknown as UpdateMetadataRedeemerData;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface TokenMetadataSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** token_metadata.ak's compiled PlutusV3 spend script CBOR —
   *  plutus.json's `validators[].compiledCode` for the
   *  `token_metadata.token_metadata.spend` entry. One fixed address shared
   *  across every launch; `launch_id` in the datum disambiguates. */
  spendScriptCbor: string;
  /** This launch's bonding_curve.ak script credential hash (hex) — read
   *  from the real deployed curve, not invented here. */
  bondingCurveScriptHash: string;
  /** This launch's cto_governance.ak script credential hash (hex) and
   *  thread-NFT policy id (hex) — same values already stored on the
   *  launch's bonding_curve.ak datum. */
  ctoGovernanceScriptHash: string;
  threadNftPolicyId: string;
  /** This launch's own native token identity (hex) — same values already
   *  stored on the launch's bonding_curve.ak datum. live_curve_creator
   *  verifies a real quantity of this exact asset is held by the curve
   *  UTXO it reads. */
  tokenPolicyId: string;
  tokenAssetNameHex: string;
  launchId: Uint8Array;
}

export class TokenMetadataSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private spendValidator: SpendingValidator;
  private spendAddress: string;

  constructor(private config: TokenMetadataSubmitterConfig) {
    this.spendValidator = {
      type: 'PlutusV3',
      script: applyDoubleCborEncoding(config.spendScriptCbor),
    };
    this.spendAddress = validatorToAddress(config.network, this.spendValidator);
    this.lucidPromise = Lucid(cardanoProvider(config), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  /** findMetadataUtxo only ever returns a UTXO it already confirmed has a
   *  datum (it skips undatumed UTXOs while scanning below) — this just
   *  makes that invariant explicit at each call site with a clear error
   *  instead of a silent `!` non-null assertion. */
  private requireDatum(utxo: UTxO): string {
    if (!utxo.datum) {
      throw new Error(
        'Token metadata UTXO has no inline datum (unexpected — findMetadataUtxo should only return UTXOs with one).',
      );
    }
    return utxo.datum;
  }

  /**
   * This launch's token_metadata UTXO, authenticated by its CIP-68 reference
   * NFT.
   *
   * token_metadata.ak is unparameterized, so every launch's metadata sits at
   * one shared address and a datum's `launch_id` is a claim by whoever paid
   * the UTXO there. The reference NFT is what the validator itself checks
   * (`carries_own_reference_nft`), and it can only exist because
   * launch_token_policy minted it in the launch's genesis transaction — a
   * one-shot policy, so exactly one of these exists per launch forever.
   * Matching what the validator matches means this reader cannot accept a
   * UTXO the chain would reject. See launch-utxo-lookup.ts.
   */
  private async findMetadataUtxo(lucid: LucidEvolution): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.spendAddress);
    const launchIdHex = toHex(this.config.launchId);
    const { utxo } = selectCip68MetadataUtxo<TokenMetadataDatumData>(
      utxos,
      this.spendAddress,
      launchIdHex,
      TokenMetadataDatumSchema,
      this.config.tokenPolicyId,
      this.config.tokenAssetNameHex,
    );
    return utxo;
  }

  /**
   * This launch's real bonding_curve.ak UTXO — a reference input for both the
   * mint and every UpdateMetadata call, per token_metadata.ak's own
   * live_curve_creator check.
   *
   * That check requires the curve's thread NFT on the reference input, so it
   * is the same token this lookup selects on. Picking any other UTXO builds a
   * transaction the validator rejects, and the rejection names neither the
   * launch nor the reference input — so failing here, by name, is the whole
   * value of authenticating a reader that only ever feeds a reference input.
   */
  private async findCurveUtxo(lucid: LucidEvolution, curveAddress: Address): Promise<UTxO> {
    const utxos = await lucid.utxosAt(curveAddress);
    // The Cardano Launch curve: role 02 and its own datum. Role 01 and the
    // linear datum belonged to the retired linear curve, which no launch
    // uses, so a lookup under them found no curve for any real launch.
    const { utxo } = selectLaunchUtxo<BondingCurveTierBDatumData>(
      utxos,
      curveAddress,
      toHex(this.config.launchId),
      'bondingCurveTierB',
      BondingCurveTierBDatumSchema,
      this.config.threadNftPolicyId,
    );
    return utxo;
  }

  /**
   * Read-only: the launch's current on-chain metadata state, or null if no
   * token_metadata UTXO exists yet for this launch (pre-mint). Used by the
   * Token Profile page (Phase H) both to display current state and to
   * decide pre-CTO/post-CTO access (community_pub_key_hash/cto_triggered
   * are only meaningful read LIVE from chain, never cached — they change
   * the moment a real TriggerCTO/DissolveCTO redeemer runs).
   */
  async getCurrentMetadata(): Promise<{
    launchId: string;
    communityPubKeyHash: string;
    ctoTriggered: boolean;
    /** CIP-68's own map, hex keys to hex-or-integer values, exactly as a
     *  wallet reads it. Left raw rather than decoded to named fields: the
     *  standard allows additional properties, and dropping them here would
     *  silently lose whatever a creator set. */
    metadata: Record<string, string>;
    /** CIP-68's standard version — not a revision counter. */
    standardVersion: string;
    metadataRevision: string;
    lastUpdatedTs: string;
  } | null> {
    const lucid = await this.lucidPromise;
    let datum: TokenMetadataDatumData;
    try {
      const utxo = await this.findMetadataUtxo(lucid);
      datum = Data.from<TokenMetadataDatumData>(this.requireDatum(utxo), TokenMetadataDatumSchema);
    } catch (err) {
      // Only "there is no metadata UTXO" means null — that is the real
      // pre-mint state this method promises to report. A bare `catch` here
      // also reported null when two UTXOs claimed the launch and when
      // Blockfrost was simply unreachable, so a contested launch and an
      // outage both rendered as "not minted yet" on the Token Profile page.
      if (err instanceof LaunchUtxoNotFoundError) {
        return null;
      }
      throw err;
    }
    const metadata: Record<string, string> = {};
    for (const [key, value] of datum.metadata.entries()) {
      metadata[key] = typeof value === 'bigint' ? value.toString() : String(value);
    }
    return {
      launchId: datum.extra.launch_id,
      communityPubKeyHash: datum.extra.community_pub_key_hash,
      ctoTriggered: datum.extra.cto_triggered,
      metadata,
      standardVersion: datum.version.toString(),
      metadataRevision: datum.extra.metadata_revision.toString(),
      lastUpdatedTs: datum.extra.last_updated_ts.toString(),
    };
  }

  /**
   * Builds an UNSIGNED UpdateMetadata transaction. `callerAddress` is the
   * creator's wallet pre-CTO, or the community wallet's own wallet
   * post-CTO — this submitter doesn't decide which; the caller (Phase H's
   * Token Profile page) already knows, from its own live access check, who
   * is allowed to call this right now.
   */
  async buildUpdateMetadata(params: {
    callerAddress: Address;
    curveAddress: Address;
    /** The complete replacement metadata — a revision replaces the map
     *  wholesale rather than patching keys, so anything omitted is dropped. */
    newMetadata: Cip68FungibleMetadata;
    currentTimestamp: number;
  }): Promise<{ unsignedTxCbor: string }> {
    const lucid = await this.lucidPromise;
    const callerUtxos = await lucid.utxosAt(params.callerAddress);
    if (callerUtxos.length === 0) {
      throw new Error(`No UTXOs found at caller address ${params.callerAddress}.`);
    }
    lucid.selectWallet.fromAddress(params.callerAddress, callerUtxos);

    const metadataUtxo = await this.findMetadataUtxo(lucid);
    const currentDatum = Data.from<TokenMetadataDatumData>(this.requireDatum(metadataUtxo), TokenMetadataDatumSchema);
    const curveUtxo = await this.findCurveUtxo(lucid, params.curveAddress);

    const newMetadata: Cip68MetadataData = buildCip68FungibleMetadata(params.newMetadata);

    const newDatum: TokenMetadataDatumData = {
      ...currentDatum,
      metadata: newMetadata,
      extra: {
        ...currentDatum.extra,
        metadata_revision: currentDatum.extra.metadata_revision + 1n,
        last_updated_ts: BigInt(params.currentTimestamp),
      },
    };

    const redeemer: UpdateMetadataRedeemerData = {
      new_metadata: newMetadata,
      current_timestamp: BigInt(params.currentTimestamp),
    };

    const txSignBuilder = await lucid
      .newTx()
      .collectFrom([metadataUtxo], Data.to<UpdateMetadataRedeemerData>(redeemer, UpdateMetadataRedeemerSchema))
      .readFrom([curveUtxo])
      .attach.SpendingValidator(this.spendValidator)
      .pay.ToContract(
        this.spendAddress,
        {
          kind: 'inline',
          value: Data.to<TokenMetadataDatumData>(newDatum, TokenMetadataDatumSchema),
        },
        metadataUtxo.assets,
      )
      .addSigner(params.callerAddress)
      .complete();

    return { unsignedTxCbor: txSignBuilder.toCBOR() };
  }

  /**
   * Second half of the two-step build/submit flow — takes the unsigned CBOR
   * this class returned plus the witness set the browser wallet produced
   * (weld.signTx's own return shape, same as create.js's existing tx/submit
   * step for the main mint), assembles and submits the real transaction.
   */
  async finalizeAndSubmit(unsignedTxCbor: string, witnessSetCbor: string): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const txSignBuilder = lucid.fromTx(unsignedTxCbor);
    const signed = await txSignBuilder.assemble([witnessSetCbor as unknown as TransactionWitnesses]).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { toHex, validatorToScriptHash };
