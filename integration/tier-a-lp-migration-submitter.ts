// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 5b
// Real Cardano transaction submitter: lp_escrow.ak's Migrate redeemer,
// combined in ONE transaction with a real Minswap V2 pool-creation
// (factory-consumption + LP-token mint + pool/factory outputs), replicated
// directly via Lucid Evolution rather than installing @minswap/sdk (built
// on a different Lucid fork, @spacebudz/lucid — not bridged into this
// project; see TIER_A_PREPROD_MILESTONE.md's Phase 5b notes).
// ============================================================================
// Every encoding below is copied directly from Minswap SDK's real GitHub
// source (`minswap/sdk`, `src/dex-v2.ts`'s `createPoolTx()`, `src/types/
// pool.ts`, `src/types/factory.ts`, `src/types/asset.ts`, `src/types/
// pool.internal.ts`, `src/utils/hash.internal.ts`) — not assumed, not
// reconstructed from documentation. Real, live Preprod addresses/refs
// independently re-verified via Blockfrost (see TIER_A_PREPROD_MILESTONE.md
// and internal tracking's Phase 5b notes for the verification trail,
// including one real mistake caught and corrected: the factory address was
// initially misidentified as LbeV2Constant's — a different Minswap product
// — not DexV2Constant's).
//
// `computeLPAssetName` uses real NIST SHA3-256 (confirmed via the `sha3`
// npm package's own source: `SHA3 = createHash({padding: 6, ...})` — the
// real FIPS 202 domain-separator byte, distinct from `Keccak =
// createHash({padding: 1})`, the Ethereum-style variant, which Minswap's
// own `sha3()` helper does NOT use). Node's built-in
// `crypto.createHash('sha3-256')` implements the same real algorithm
// natively — used directly here instead of pulling in the `sha3` package.
//
// What lp_escrow.ak requires of this transaction, re-read against the
// validator rather than carried over — the note that used to sit here
// described neither of the checks below and had gone stale twice:
//
//   - `migration_output_ok` wants the LP tokens AND at least the escrow's own
//     real locked lovelace at `target_dex_credential`. The locked ADA does go
//     into Minswap's pool output, which satisfies this; it is not unconstrained.
//   - `replacement_position_returned` wants the position that comes back to
//     really be in the escrow's own continuing output, in the amount the
//     redeemer declares, with the continuing datum naming it.
//   - `thread_nft_intact` applies to EVERY redeemer and wants that continuing
//     output to carry the launch's thread NFT. This transaction built no
//     continuing output at all until 2026-08-11, so it could not have
//     validated whatever else it got right.
//
// Both Minswap's factory validator (spend) and authen minting policy
// (mint) must be embedded IN FULL here, not referenced — confirmed via the
// same @lucid-evolution/lucid source-reading that produced the earlier finding:
// `collectFrom`/`mintAssets` both require `config.scripts.get(hash)`
// (populated only via `.attach.SpendingValidator()`/`.attach.
// MintingPolicy()`) regardless of any `readFrom`-supplied reference input.
// Real bytecode fetched directly via Blockfrost's `/scripts/{hash}/cbor`
// endpoint, keyed off the real deployed reference-script UTXOs' own
// `reference_script_hash` field (Minswap's own infra uses real reference
// scripts; this project's Lucid Evolution version just can't consume them
// for spend/mint witnesses the way Minswap's own `@spacebudz/lucid`-based
// SDK can).
// ============================================================================

import { createHash } from 'node:crypto';
import type {
  Assets,
  LucidEvolution,
  Network as LucidNetwork,
  MintingPolicy,
  SpendingValidator,
  UTxO,
} from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { selectLaunchUtxo } from './launch-utxo-lookup.js';
import { LP_ESCROW_REDEEMER } from './redeemer-indices.js';
import { type LpEscrowDatumData, LpEscrowDatumSchema, threadNftAssetName } from './tier-a-schemas.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

/** Real NIST SHA3-256 — see file header for why this is NOT crypto.createHash('keccak256'). */
function sha3(hexInput: string): string {
  return createHash('sha3-256').update(Buffer.from(hexInput, 'hex')).digest('hex');
}

/** ADA goes first; else lexicographic on the "policyId+tokenName" unit string.
 *  Mirrors pool.internal.ts's normalizeAssets exactly. */
function normalizeAssetPair(unitA: string, unitB: string): [string, string] {
  if (unitA === 'lovelace') return [unitA, unitB];
  if (unitB === 'lovelace') return [unitB, unitA];
  return unitA < unitB ? [unitA, unitB] : [unitB, unitA];
}

function unitToPolicyAndName(unit: string): {
  policyId: string;
  tokenName: string;
} {
  if (unit === 'lovelace') return { policyId: '', tokenName: '' };
  return { policyId: unit.slice(0, 56), tokenName: unit.slice(56) };
}

/** Mirrors PoolV2.computeLPAssetName exactly (pool.ts). */
function computeLPAssetName(unitA: string, unitB: string): string {
  const [normA, normB] = normalizeAssetPair(unitA, unitB);
  const a = unitToPolicyAndName(normA);
  const b = unitToPolicyAndName(normB);
  const k1 = sha3(a.policyId + a.tokenName);
  const k2 = sha3(b.policyId + b.tokenName);
  return sha3(k1 + k2);
}

/** Mirrors DexV2Calculation.calculateInitialLiquidity exactly (calculate.ts) — ceil(sqrt(amountA*amountB)). */
function calculateInitialLiquidity(amountA: bigint, amountB: bigint): bigint {
  const product = amountA * amountB;
  if (product < 0n) throw new Error('Negative product.');
  if (product < 2n) return product;
  let x = product;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + product / x) / 2n;
  }
  if (x * x < product) x += 1n;
  return x;
}

const MAX_LIQUIDITY = 9_223_372_036_854_775_807n;
const MINIMUM_LIQUIDITY = 10n;
const DEFAULT_POOL_ADA = 4_500_000n;
const TRADING_FEE_NUMERATOR = 30n; // 0.3% — real Minswap convention, within MIN(5)/MAX(2000) bounds.

function assetToPlutusData(policyId: string, tokenName: string): Constr<Data> {
  return new Constr(0, [policyId, tokenName]);
}

const FactoryDatumSchema = Data.Object({
  head: Data.Bytes(),
  tail: Data.Bytes(),
});
type FactoryDatumData = Data.Static<typeof FactoryDatumSchema>;
const FactoryDatumShape = FactoryDatumSchema as unknown as FactoryDatumData;

export interface MinswapV2Config {
  factoryAddress: string;
  factoryScriptHash: string;
  factoryAsset: string; // policyId+tokenName hex
  poolAuthenAsset: string;
  lpPolicyId: string;
  poolCreationAddress: string;
  poolScriptHash: string;
  poolBatchingStakeScriptHash: string; // real script hash of poolBatchingAddress's stake credential
  factoryValidatorCbor: string; // full compiled bytecode, fetched via Blockfrost /scripts/{hash}/cbor
  authenPolicyCbor: string; // full compiled bytecode, same source
}

export interface TierALpMigrationConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  lpEscrowScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
  minswap: MinswapV2Config;
}

export class TierALpMigrationSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private lpEscrowValidator: SpendingValidator;
  private lpEscrowAddress: string;
  private factoryValidator: SpendingValidator;
  private authenPolicy: MintingPolicy;

  constructor(private config: TierALpMigrationConfig) {
    this.lpEscrowValidator = {
      type: 'PlutusV3',
      script: config.lpEscrowScriptCbor,
    };
    this.lpEscrowAddress = validatorToAddress(config.network, this.lpEscrowValidator);
    // Real Minswap V2 Preprod factory/authen scripts are PlutusV2, not V3
    // (confirmed via Blockfrost's /scripts/{hash} endpoint: "type":
    // "plutusV2" for both — verified directly after an initial PlutusV3
    // assumption produced the wrong script hash. Lucid Evolution's
    // attach.SpendingValidator/MintingPolicy apply CIP-... double-CBOR
    // encoding automatically for PlutusV2, matching the real on-chain hash.
    this.factoryValidator = {
      type: 'PlutusV2',
      script: config.minswap.factoryValidatorCbor,
    };
    this.authenPolicy = {
      type: 'PlutusV2',
      script: config.minswap.authenPolicyCbor,
    };
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  private async findLpEscrowUtxo(lucid: LucidEvolution): Promise<{ utxo: UTxO; datum: LpEscrowDatumData }> {
    const utxos = await lucid.utxosAt(this.lpEscrowAddress);
    const found = selectLaunchUtxo<LpEscrowDatumData>(
      utxos,
      this.lpEscrowAddress,
      this.config.launchIdHex,
      'lpEscrow',
      LpEscrowDatumSchema as never,
      this.config.threadNftPolicyId,
    );
    return found;
  }

  /** Mirrors getFactoryV2ByPair exactly: linear scan for the one Factory
   *  UTXO whose (head, tail) slot brackets the new pair's lpAssetName. */
  private async findFactoryUtxo(
    lucid: LucidEvolution,
    lpAssetName: string,
  ): Promise<{ utxo: UTxO; datum: FactoryDatumData }> {
    const utxos = await lucid.utxosAt(this.config.minswap.factoryAddress);
    for (const utxo of utxos) {
      if ((utxo.assets[this.config.minswap.factoryAsset] ?? 0n) !== 1n) continue;
      if (!utxo.datum) continue;
      let datum: FactoryDatumData;
      try {
        datum = Data.from<FactoryDatumData>(utxo.datum, FactoryDatumShape as never);
      } catch {
        continue;
      }
      if (datum.head < lpAssetName && lpAssetName < datum.tail) {
        return { utxo, datum };
      }
    }
    throw new Error(`No Minswap V2 Factory UTXO found bracketing lpAssetName ${lpAssetName} — pool may already exist.`);
  }

  /**
   * @param currentTimestampMs  MILLISECONDS. Migrate's `current_timestamp`
   *   IS bound to real chain time — lp_escrow.ak requires
   *   interval.contains(validity_range, current_timestamp) and a range no
   *   wider than max_validity_range_width — so this builder sets the range
   *   and the value has to be on Cardano's own ms scale. It is also measured
   *   against the position's lock expiry and its migration cooldown, both of
   *   which are counted in ms.
   */
  async migrateToMinswapPool(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    currentTimestampMs: number,
  ): Promise<{
    txHash: string;
    lpAssetNameHex: string;
    initialLiquidity: bigint;
  }> {
    const lucid = await this.lucidPromise;
    const { utxo: lpUtxo, datum: lpDatum } = await this.findLpEscrowUtxo(lucid);

    const tokenUnit = lpDatum.lp_token_policy_id + lpDatum.lp_token_name;
    const amountAda = lpUtxo.assets.lovelace ?? 0n;
    const amountToken = lpUtxo.assets[tokenUnit] ?? 0n;
    if (amountAda <= 0n || amountToken <= 0n) {
      throw new Error(`lp_escrow UTXO holds no real value to migrate (ada=${amountAda}, token=${amountToken}).`);
    }

    // Sort ascending: ADA first (empty-string policyId always sorts first).
    const sortedAssetAUnit = 'lovelace';
    const sortedAssetBUnit = tokenUnit;
    const sortedAmountA = amountAda;
    const sortedAmountB = amountToken;

    const lpAssetNameHex = computeLPAssetName(sortedAssetAUnit, sortedAssetBUnit);
    const lpAssetUnit = this.config.minswap.lpPolicyId + lpAssetNameHex;

    const { utxo: factoryUtxo, datum: factoryDatum } = await this.findFactoryUtxo(lucid, lpAssetNameHex);

    const initialLiquidity = calculateInitialLiquidity(sortedAmountA, sortedAmountB);
    const remainingLiquidity = MAX_LIQUIDITY - (initialLiquidity - MINIMUM_LIQUIDITY);

    // ---- Pool datum (PoolV2.Datum) ----
    const stakeCredData = new Constr(1, [this.config.minswap.poolBatchingStakeScriptHash]); // ScriptCredential
    const wrappedStakeCred = new Constr(0, [stakeCredData]); // inline StakingHash wrapper
    const assetAData = assetToPlutusData('', '');
    const assetBData = assetToPlutusData(lpDatum.lp_token_policy_id, lpDatum.lp_token_name);
    const poolDatum = new Constr(0, [
      wrappedStakeCred,
      assetAData,
      assetBData,
      initialLiquidity,
      sortedAmountA,
      sortedAmountB,
      TRADING_FEE_NUMERATOR,
      TRADING_FEE_NUMERATOR,
      new Constr(1, []), // no fee sharing
      new Constr(0, []), // allowDynamicFee = false
    ]);

    // ---- Pool value: DEFAULT_POOL_ADA baseline (extra ADA from governor's
    // own wallet) + the migrated ADA/token + remainingLiquidity LP + 1
    // freshly-minted poolAuthenAsset. Mirrors createPoolTx()'s exact
    // poolValue construction (lovelace key pre-seeded, then sortedAssetA's
    // amount ADDED since sortedAssetA IS lovelace here). ----
    const poolValue: Assets = {
      lovelace: DEFAULT_POOL_ADA + sortedAmountA,
      [lpAssetUnit]: remainingLiquidity,
      [this.config.minswap.poolAuthenAsset]: 1n,
      [sortedAssetBUnit]: sortedAmountB,
    };

    // ---- Two new Factory outputs, splitting the consumed node's (head,tail)
    // range around lpAssetNameHex. ----
    const newFactoryDatum1 = { head: factoryDatum.head, tail: lpAssetNameHex };
    const newFactoryDatum2 = { head: lpAssetNameHex, tail: factoryDatum.tail };
    const factoryRedeemer = new Constr(0, [assetAData, assetBData]); // FactoryV2.Redeemer{assetA, assetB}
    const authenMintRedeemer = new Constr(1, []); // matches createPoolTx()'s literal Constr(1, [])

    // ---- The replacement position ----
    // Minswap keeps `remainingLiquidity` in the pool and issues the rest to
    // the provider; that share is what comes back here. The escrow declares
    // it in the redeemer and must then really hold it, so this figure and the
    // continuing output below cannot drift apart without the node objecting.
    const escrowLpAmount = initialLiquidity - MINIMUM_LIQUIDITY;

    // ---- lp_escrow's Migrate redeemer ----
    const targetDexCredentialData = new Constr(1, [this.config.minswap.poolScriptHash]); // ScriptCredential
    const migrateRedeemer = new Constr(LP_ESCROW_REDEEMER.Migrate, [
      targetDexCredentialData,
      BigInt(currentTimestampMs),
      this.config.minswap.lpPolicyId,
      lpAssetNameHex,
      escrowLpAmount,
    ]);

    // ---- The escrow's own continuing output ----
    // Required on EVERY spend, not just this one: the validator authenticates
    // its state by the launch's thread NFT and looks for it on an output back
    // at its own address. This transaction previously built no such output at
    // all, so it could not have validated whatever else it got right.
    //
    // The datum records what the escrow now holds. Carrying the old identity
    // forward would leave it naming a position it had just sent away.
    const migratedDatum: LpEscrowDatumData = {
      ...lpDatum,
      lp_token_policy_id: this.config.minswap.lpPolicyId,
      lp_token_name: lpAssetNameHex,
      lp_token_amount: escrowLpAmount,
      last_migration_timestamp: BigInt(currentTimestampMs),
    };
    const threadUnit = this.config.threadNftPolicyId + threadNftAssetName('lpEscrow', this.config.launchIdHex);
    const escrowContinuingValue: Assets = {
      [threadUnit]: 1n,
      [lpAssetUnit]: escrowLpAmount,
    };

    // Capped at max_validity_range_width (600,000ms); 240s each way.
    const validFrom = currentTimestampMs - 240_000;
    const validTo = currentTimestampMs + 240_000;

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const mintAssets: Assets = {
      [lpAssetUnit]: MAX_LIQUIDITY,
      [this.config.minswap.factoryAsset]: 1n,
      [this.config.minswap.poolAuthenAsset]: 1n,
    };

    const tx = await lucid
      .newTx()
      .validFrom(validFrom)
      .validTo(validTo)
      .collectFrom([lpUtxo], Data.to(migrateRedeemer))
      .collectFrom([factoryUtxo], Data.to(factoryRedeemer))
      .attach.SpendingValidator(this.lpEscrowValidator)
      .attach.SpendingValidator(this.factoryValidator)
      .attach.MintingPolicy(this.authenPolicy)
      .mintAssets(mintAssets, Data.to(authenMintRedeemer))
      .pay.ToContract(this.config.minswap.poolCreationAddress, { kind: 'inline', value: Data.to(poolDatum) }, poolValue)
      .pay.ToContract(
        this.config.minswap.factoryAddress,
        {
          kind: 'inline',
          value: Data.to<FactoryDatumData>(newFactoryDatum1, FactoryDatumShape),
        },
        { [this.config.minswap.factoryAsset]: 1n },
      )
      .pay.ToContract(
        this.config.minswap.factoryAddress,
        {
          kind: 'inline',
          value: Data.to<FactoryDatumData>(newFactoryDatum2, FactoryDatumShape),
        },
        { [this.config.minswap.factoryAsset]: 1n },
      )
      .pay.ToContract(
        this.lpEscrowAddress,
        { kind: 'inline', value: Data.to<LpEscrowDatumData>(migratedDatum, LpEscrowDatumSchema) },
        escrowContinuingValue,
      )
      .attachMetadata(674, { msg: ['SDK Minswap: Create Pool'] })
      .addSigner(governorAddress)
      .complete({ localUPLCEval: false });

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();

    return { txHash, lpAssetNameHex, initialLiquidity };
  }
}
