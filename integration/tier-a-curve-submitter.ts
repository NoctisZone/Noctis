// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 4
// Real Cardano transaction submitter for bonding_curve.ak's ActivateCurve
// and BuyTokens redeemers.
// ============================================================================
// Same class of gap as darkveil-claim-submitter.ts/cardano-anchor-submitter.ts:
// Anvil's REST API only does native-script minting and plain payments (this
// session's own findings reconfirm this — nothing about Anvil's real
// behavior suggests a custom-Plutus-redeemer-spend path exists there either).
// Every action past mint needs Lucid Evolution's collectFrom/
// attach.SpendingValidator.
//
// Two different signing shapes, because bonding_curve.ak's redeemers have two
// different signer types:
//
//   - BuyTokens is buyer-signed. buyTokens() below mirrors
//     darkveil-claim-submitter.ts's buyer-signed pattern exactly — for THIS
//     session's CLI-driven Phase 4 verification it signs via
//     lucid.selectWallet.fromSeed(mnemonic) (the 4 funded test-buyer wallets'
//     mnemonics, recorded locally in .env.tier-a-test-wallets.local exactly
//     for this purpose), not a browser WalletApi — that's the real
//     production path, deferred to the Launch Wizard wallet-connect task per
//     the milestone plan ("isolate tx-logic correctness from UI-wiring
//     correctness").
//
//   - ActivateCurve is governor-signed, but the governor's raw key material
//     (WeldPress_Settings-encrypted, `payment_skey_extended` — a raw 64-byte
//     kL||kR BIP32-Ed25519 extended key, no separate chaincode) is NOT a
//     format Lucid Evolution's fromPrivateKey()/fromSeed() can consume
//     directly as-is (those expect a bech32 ed25519_sk string or a BIP-39
//     mnemonic respectively), and the governor's mnemonic was only ever
//     shown once, off-platform, to the human operator — this codebase
//     never has access to it.
//
//     A two-phase build(Lucid)/sign(PHP via WeldPress)/submit(Lucid) design
//     was tried first (avoiding ever holding the governor's raw key outside
//     PHP) but failed twice in a row against real Preprod: (1) WeldPress's
//     own lightweight CBOR parser doesn't support the indefinite-length
//     arrays Lucid's default toCBOR() produces ("Indefinite lengths not
//     supported"); (2) switching to canonical (definite-length) CBOR fixed
//     that, but reconstructing a TxSignBuilder in a SEPARATE process via
//     lucid.fromTx()+assemble()+complete() then failed on-chain with
//     ScriptIntegrityHashMismatch — something about re-parsing an
//     already-built tx into a fresh Lucid instance changes what gets
//     committed to the script integrity hash, even though the CBOR itself
//     round-trips losslessly.
//
//     Real fix, used by activateCurve() below: CML.PrivateKey.
//     from_extended_bytes() accepts the raw 64-byte kL||kR format directly
//     — no conversion needed beyond the decrypt PHP already does for every
//     other platform-wallet signing operation — converted to bech32 via
//     CML's own to_bech32() so TxSignBuilder.sign.withPrivateKey() (real,
//     same established pattern as cardano-anchor-submitter.ts's relayer
//     signing) can sign directly. Coin selection/build still uses
//     selectWallet.fromAddress(governorAddress, utxos) — fromPrivateKey()
//     alone can only derive an enterprise (payment-only) address, which
//     isn't where the governor's real funds sit (a base address, needing a
//     stake credential fromPrivateKey() has no way to reconstruct from a
//     payment-only key) — confirmed by a real "insufficient funds" failure
//     against a wallet that actually holds 1,000 real Preprod ADA. Combining
//     fromAddress() for building with sign.withPrivateKey() for signing, all
//     in ONE continuous process, avoids every failure mode above at once.
//     This pattern generalizes to every other governor-signed custom-
//     redeemer spend this project will eventually need (ClaimTreasuryFees,
//     ClaimOpsFees, CancelCurve, TriggerCTO, DissolveCTO, Graduate's governor
//     path if ever needed) — built once here, reusable.
//
// Datum schema reused from ./tier-a-schemas.ts (Phase 3) — same shared
// module Phase 2's reader and Phase 3's genesis-datum encoder already use,
// so this file can never drift from either.
// ============================================================================

import type {
  LucidEvolution,
  Network as LucidNetwork,
  SpendingValidator,
  UTxO,
  WalletApi,
} from '@lucid-evolution/lucid';
import {
  Blockfrost,
  CML,
  Constr,
  Data,
  getAddressDetails,
  Lucid,
  toUnit,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import { buildCapTradeFields, type CapAccumulator } from './cap-accumulator-tree.js';
import {
  CREATOR_BPS,
  feeSlice,
  PLATFORM_BPS,
  buyCost as sharedBuyCost,
  sellProceeds as sharedSellProceeds,
  spotPrice,
} from './curve-pricing.js';
import { selectLaunchUtxo } from './launch-utxo-lookup.js';
import { BONDING_CURVE_REDEEMER } from './redeemer-indices.js';
import type { BondingCurveDatumData } from './tier-a-schemas.js';
import { BondingCurveDatumSchema, capProofToPlutus, loadValidator, settlementDatum } from './tier-a-schemas.js';

// Pricing and the fee split are mirrors of bonding_curve.ak's own arithmetic,
// kept in one place for both tiers and the history reader — see
// ./curve-pricing.ts for why that matters and how the formula works.
const SHAPE = 'linear' as const;

/** The spot price at a position — what the next single token costs. */
function curvePriceAt(datum: BondingCurveDatumData, sold: bigint): bigint {
  return spotPrice(SHAPE, datum, sold);
}

/** What a buyer pays for `amount` tokens starting at `fromSold`. */
function buyCost(datum: BondingCurveDatumData, fromSold: bigint, amount: bigint): bigint {
  return sharedBuyCost(SHAPE, datum, fromSold, amount);
}

/** What a seller receives — `fromSold` is the LOW edge of the vacated range. */
function sellProceeds(datum: BondingCurveDatumData, fromSold: bigint, amount: bigint): bigint {
  return sharedSellProceeds(SHAPE, datum, fromSold, amount);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Converts a raw 64-byte BIP32-Ed25519 extended private key (kL||kR, no
 * separate chaincode — WeldPress_CardanoWalletPHP::generateWallet()'s own
 * `payment_skey_extended` format) into the bech32 `ed25519e_sk...` string
 * Lucid Evolution's selectWallet.fromPrivateKey()/sign.withPrivateKey()
 * consume. Uses CML.PrivateKey.from_extended_bytes()/.to_bech32() directly
 * (both real, confirmed against the installed @anastasia-labs/cardano-
 * multiplatform-lib-nodejs package's own .d.ts) — CML is re-exported from
 * @lucid-evolution/lucid itself (`export { CML }`), no separate dependency.
 */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface LucidTierACurveSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve.ak's compiled PlutusV3 script CBOR — plutus.json's
   *  validators[].compiledCode for bonding_curve.bonding_curve.spend. One
   *  shared, unparameterized script address across every linear-curve launch. */
  compiledScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class LucidTierACurveSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: LucidTierACurveSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  /** The curve's own script address, derived from the compiled validator.
   *  Exposed because rebuilding the cap accumulator needs an address to read
   *  the launch's trade history from, and deriving it a second time at the
   *  call site would risk deriving a different one. */
  get curveAddress(): string {
    return this.scriptAddress;
  }

  /** findCurveUtxo only ever returns a UTXO it already confirmed has a
   *  datum (it skips undatumed UTXOs while scanning below) — this just
   *  makes that invariant explicit at each call site with a clear error
   *  instead of a silent `!` non-null assertion. */
  private requireDatum(utxo: UTxO): string {
    if (!utxo.datum) {
      throw new Error(
        'Bonding curve UTXO has no inline datum (unexpected — findCurveUtxo should only return UTXOs with one).',
      );
    }
    return utxo.datum;
  }

  /** Same "match launch_id inside the datum" pattern as every other shared-
   *  address submitter in this codebase (zk_anchor, bonding_curve_tier_b). */
  private async findCurveUtxo(lucid: LucidEvolution): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    const found = selectLaunchUtxo<BondingCurveDatumData>(
      utxos,
      this.scriptAddress,
      this.config.launchIdHex,
      'bondingCurve',
      BondingCurveDatumSchema as never,
      this.config.threadNftPolicyId,
    );
    return found.utxo;
  }

  async readCurveDatum(): Promise<BondingCurveDatumData> {
    const lucid = await this.lucidPromise;
    const utxo = await this.findCurveUtxo(lucid);
    return Data.from<BondingCurveDatumData>(this.requireDatum(utxo), BondingCurveDatumSchema);
  }

  // --------------------------------------------------------------------------
  // ActivateCurve — governor-signed, single-phase (revised 2026-07-17)
  // --------------------------------------------------------------------------
  // The original design here was a two-phase build(Lucid)/sign(PHP via
  // WeldPress)/submit(Lucid) split, avoiding the need for this codebase to
  // ever hold the governor's raw key material outside PHP. Two real,
  // sequential failures killed that design:
  //   1. WeldPress_CardanoTransactionSignerPHP's own lightweight CBOR parser
  //      doesn't support indefinite-length arrays ("Indefinite lengths not
  //      supported") — Lucid's default toCBOR() output uses them. Worked
  //      around once via toCBOR({canonical:true})...
  //   2. ...but reconstructing a TxSignBuilder in a SEPARATE process via
  //      lucid.fromTx(unsignedTxCbor) + assemble() + complete() then failed
  //      on-chain with ScriptIntegrityHashMismatch — something about
  //      re-parsing an already-built tx into a fresh Lucid instance in a
  //      different process changes what gets committed to the script
  //      integrity hash, even though the CBOR bytes round-trip losslessly.
  //      Not worth chasing further given a simpler, equally-safe
  //      alternative exists.
  // Real fix: sign directly with CML.PrivateKey.from_extended_bytes(), which
  // accepts EXACTLY the raw 64-byte (kL+kR) format
  // WeldPress_CardanoWalletPHP::generateWallet() already stores as
  // `payment_skey_extended` — no format conversion needed on the PHP side
  // beyond the decrypt it already does for every other platform-wallet
  // signing operation. Converted to bech32 via CML's own to_bech32() so
  // TxSignBuilder's sign.withPrivateKey() (real, confirmed via cardano-
  // anchor-submitter.ts's own established relayer-signed pattern) can
  // consume it directly for the SIGNING step — one continuous
  // build->sign->submit in a single process, no reconstruction boundary for
  // a hash mismatch to occur across, and WeldPress's CBOR parser never
  // enters the picture at all for this operation.
  //
  // Coin selection/wallet address, separately: selectWallet.fromPrivateKey()
  // was tried first and failed with a real "insufficient funds" error even
  // though the governor wallet holds 1,000 real Preprod ADA — root cause,
  // confirmed by reasoning through WeldPress's own address construction
  // (CardanoWalletPHP.php): fromPrivateKey() only has a PAYMENT key to work
  // with, so Lucid can only derive an enterprise address from it, not the
  // real BASE address (payment+stake) the governor's actual funds sit at —
  // a payment-only key can't reconstruct a stake credential it never had.
  // Fixed by using selectWallet.fromAddress(governorAddress, utxos) for
  // coin selection/build (the real base address, real UTxOs — same pattern
  // already proven in this file's earlier two-phase attempt) while signing
  // separately via tx.sign.withPrivateKey() below — combining the address-
  // correctness half of the first attempt with the single-process-signing
  // half of the second, without either one's failure mode.
  //
  // The governor's plaintext key material exists only for the lifetime of
  // this one Node process (passed via stdin by the PHP caller, which
  // decrypts it the same way it already does for the mint flow's policy-
  // wallet signing) — never logged, never persisted, never returned.

  async activateCurve(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    currentTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(this.requireDatum(curveUtxo), BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Inactive') {
      throw new Error(`Curve is not Inactive (state: ${currentDatum.curve_state}) — cannot activate.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const currentTimestamp = BigInt(currentTimestampMs);
    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      curve_state: 'Active',
      phase_started_at: currentTimestamp,
    };

    // Redeemer: ActivateCurve is constructor index 0 of 12 — a plain
    // Data.Object naturally serializes at index 0 (see darkveil-claim-
    // submitter.ts's own note re: Data.Object's default), so no raw Constr
    // is needed here (unlike BuyTokens at index 1, below).
    const ActivateCurveRedeemerShape = Data.Object({
      current_timestamp: Data.Integer(),
    });
    type ActivateCurveRedeemerData = Data.Static<typeof ActivateCurveRedeemerShape>;
    const ActivateCurveRedeemerSchema = ActivateCurveRedeemerShape as unknown as ActivateCurveRedeemerData;
    const redeemer: ActivateCurveRedeemerData = {
      current_timestamp: currentTimestamp,
    };

    // interval.contains(self.validity_range, current_timestamp) on-chain —
    // the tx's own validity range must actually contain the stamped
    // timestamp, so set both explicitly rather than rely on Lucid defaults.
    // ActivateCurve is governor-signed and NOT validity-width-bound (confirmed
    // directly in bonding_curve.ak — no validity_range_is_narrow call in
    // this clause), so a legitimately backdated currentTimestampMs (Phase 7
    // stall-testing, per this milestone's own approved precedent) is
    // supported here too — but the range must ALSO overlap the REAL
    // current chain time, or Cardano's own ledger (not just the script)
    // rejects the tx as outside its validity interval regardless of what
    // the script allows. Spanning min(claimed, real-now) to
    // max(claimed, real-now) satisfies both interval.contains(range,
    // current_timestamp) and the ledger's real "does this range cover the
    // actual current slot" check, whether currentTimestampMs is honest
    // (the normal case) or deliberately backdated (Phase 7 only).
    const realNowMs = Date.now();
    const validFrom = Math.min(currentTimestampMs, realNowMs) - 60_000;
    const validTo = Math.max(currentTimestampMs, realNowMs) + 60_000;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to<ActivateCurveRedeemerData>(redeemer, ActivateCurveRedeemerSchema))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema),
        },
        curveUtxo.assets,
      )
      .validFrom(validFrom)
      .validTo(validTo)
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // BuyTokens — buyer-signed. Two public entry points sharing one core:
  //   - buyTokens(mnemonic, ...): this session's CLI-driven verification
  //     path (Phase 4), signs via lucid.selectWallet.fromSeed().
  //   - buyTokensWithWallet(walletApi, ...): the real production path (the
  //     The linear curve buy widget, integration/widget/tier-a-buy-widget-entry.ts),
  //     signs via lucid.selectWallet.fromAPI(walletApi) — the same real,
  //     installed WalletApi type and fromAPI() call darkveil-claim-
  //     submitter.ts already proved out for Cardano Launch's buyer-signed claim flow.
  // --------------------------------------------------------------------------

  /**
   * `skipClientCapCheck` (default false): deliberately bypasses the
   * client-side wallet-cap guard below so the REAL on-chain
   * `new_total_purchases <= datum.wallet_cap` check (bonding_curve.ak) can
   * be verified directly, not just this client's own honesty — used once,
   * for real, to produce genuine on-chain evidence of cap enforcement
   * (Cardano Preprod milestone Phase 4's own checkpoint requires a real
   * failed tx/validator error, not "the client also happens to agree").
   * Never pass true from any real buy flow.
   */
  async buyTokens(
    buyerMnemonic: string,
    tokenAmount: bigint,
    capState: CapAccumulator,
    skipClientCapCheck = false,
  ): Promise<{ txHash: string; grossPayment: bigint; avgPrice: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(buyerMnemonic);
    const buyerAddress = await lucid.wallet().address();
    return this.buyTokensCore(lucid, buyerAddress, tokenAmount, capState, skipClientCapCheck);
  }

  /** Real production path — see class-level comment above. */
  async buyTokensWithWallet(
    walletApi: WalletApi,
    tokenAmount: bigint,
    capState: CapAccumulator,
    skipClientCapCheck = false,
  ): Promise<{ txHash: string; grossPayment: bigint; avgPrice: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const buyerAddress = await lucid.wallet().address();
    return this.buyTokensCore(lucid, buyerAddress, tokenAmount, capState, skipClientCapCheck);
  }

  private async buyTokensCore(
    lucid: LucidEvolution,
    buyerAddress: string,
    tokenAmount: bigint,
    capState: CapAccumulator,
    skipClientCapCheck: boolean,
  ): Promise<{ txHash: string; grossPayment: bigint; avgPrice: bigint }> {
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(this.requireDatum(curveUtxo), BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Active') {
      throw new Error(`Curve is not Active (state: ${currentDatum.curve_state}) — cannot buy.`);
    }

    const remaining = currentDatum.curve_supply - currentDatum.tokens_sold;
    if (tokenAmount <= 0n || tokenAmount > remaining) {
      throw new Error(`token_amount out of range (remaining: ${remaining}).`);
    }

    // The range being ADDED starts at the current tokens_sold.
    const grossPayment = buyCost(currentDatum, currentDatum.tokens_sold, tokenAmount);
    const creatorFee = feeSlice(grossPayment, CREATOR_BPS);
    const platformFee = feeSlice(grossPayment, PLATFORM_BPS);
    const feeTotal = creatorFee + platformFee;
    const netPayment = grossPayment - feeTotal;

    const buyerKeyHashHex = buyerKeyHashFromAddress(buyerAddress);

    // The cap is CUMULATIVE: what this wallet has already taken from the curve
    // plus this buy. `cap` carries the proof that makes the prior total real
    // rather than self-reported — the validator re-walks it against
    // `cap_root`. Splitting a buy across transactions no longer buys headroom,
    // which is the whole point of the accumulator.
    const cap = buildCapTradeFields(capState, currentDatum.cap_root, buyerKeyHashHex, tokenAmount);
    if (cap.committedAfter > currentDatum.wallet_cap && !skipClientCapCheck) {
      throw new Error(
        `Cumulative cap exceeded: ${cap.committedBefore} already taken + ${tokenAmount} = ` +
          `${cap.committedAfter} > ${currentDatum.wallet_cap}. Sell some of the position to free headroom.`,
      );
    }

    const newTokensSold = currentDatum.tokens_sold + tokenAmount;
    const nextState: BondingCurveDatumData['curve_state'] =
      newTokensSold === currentDatum.curve_supply ? 'Graduated' : currentDatum.curve_state;

    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      tokens_sold: newTokensSold,
      total_raised: currentDatum.total_raised + netPayment,
      creator_fees_accrued: currentDatum.creator_fees_accrued + creatorFee,
      platform_fees_accrued: currentDatum.platform_fees_accrued + platformFee,
      curve_state: nextState,
      cap_root: cap.nextRootHex,
    };

    // Redeemer: BuyTokens is constructor index 1 of 12 — raw Constr needed
    // since Data.Object always serializes at index 0 (same reasoning as
    // darkveil-claim-submitter.ts's own ClaimDarkVeilTokens construction).
    const redeemer = new Constr(BONDING_CURVE_REDEEMER.BuyTokens, [
      tokenAmount,
      buyerKeyHashHex,
      cap.committedBefore,
      capProofToPlutus(cap.proof),
    ]);

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) + grossPayment;
    continuingAssets[tokenUnit] = (continuingAssets[tokenUnit] ?? 0n) - tokenAmount;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema),
        },
        continuingAssets,
      )
      // The delivery NAMES the spend it settles. `token_delivered` asks for an
      // output carrying this exact tag, so an untagged one is not a delivery
      // as far as the validator is concerned — see settlementDatum.
      .pay.ToAddressWithData(
        buyerAddress,
        { kind: 'inline', value: settlementDatum(curveUtxo) },
        { [tokenUnit]: tokenAmount },
      )
      .addSigner(buyerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    // Average lovelace per token across the batch. Every token in a batch
    // is priced at its own position, so this is not the price of any one
    // of them — it is what the buyer paid, divided by what they got.
    return { txHash, grossPayment, avgPrice: grossPayment / tokenAmount };
  }

  // --------------------------------------------------------------------------
  // SellTokens — the reverse of BuyTokens. Seller-signed, same two-
  // signing-shape pattern (mnemonic for this session's CLI verification,
  // WalletApi for the real production path).
  // --------------------------------------------------------------------------

  /** CLI-driven verification path — see class-level comment above. */
  async sellTokens(
    sellerMnemonic: string,
    tokenAmount: bigint,
    capState: CapAccumulator,
  ): Promise<{ txHash: string; netProceeds: bigint; avgPrice: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(sellerMnemonic);
    const sellerAddress = await lucid.wallet().address();
    return this.sellTokensCore(lucid, sellerAddress, tokenAmount, capState);
  }

  /** Real production path — see class-level comment above. */
  async sellTokensWithWallet(
    walletApi: WalletApi,
    tokenAmount: bigint,
    capState: CapAccumulator,
  ): Promise<{ txHash: string; netProceeds: bigint; avgPrice: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const sellerAddress = await lucid.wallet().address();
    return this.sellTokensCore(lucid, sellerAddress, tokenAmount, capState);
  }

  private async sellTokensCore(
    lucid: LucidEvolution,
    sellerAddress: string,
    tokenAmount: bigint,
    capState: CapAccumulator,
  ): Promise<{ txHash: string; netProceeds: bigint; avgPrice: bigint }> {
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(this.requireDatum(curveUtxo), BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Active') {
      throw new Error(`Curve is not Active (state: ${currentDatum.curve_state}) — cannot sell.`);
    }
    if (tokenAmount <= 0n) {
      throw new Error('token_amount must be positive.');
    }

    const sellerKeyHashHex = buyerKeyHashFromAddress(sellerAddress);
    if (sellerKeyHashHex === currentDatum.creator_pub_key_hash) {
      throw new Error('The creator cannot sell into their own curve.');
    }
    // Entitlement is possession — the tokens are handed back to the curve in
    // this transaction, so nothing is looked up to decide WHETHER they may
    // sell. The per-transaction bound still applies on this side: a cumulative
    // one only ever falls on a sell.
    if (tokenAmount > currentDatum.wallet_cap) {
      throw new Error(
        `Per-transaction cap exceeded: ${tokenAmount} > ${currentDatum.wallet_cap}. Split the sell across transactions.`,
      );
    }
    // A sell RELEASES headroom, so it rewrites the accumulator too — without
    // this a trader who bought their full cap and exited could never re-enter.
    const cap = buildCapTradeFields(capState, currentDatum.cap_root, sellerKeyHashHex, -tokenAmount);

    const newSold = currentDatum.tokens_sold - tokenAmount;
    if (newSold < 0n) {
      throw new Error(`new_sold would go negative (${newSold}) — this shouldn't happen given the prior check.`);
    }

    // Prices the range being REMOVED, whose low edge is the POST-sell
    // tokens_sold — the same range a buy of this size at `newSold` pays for.
    // See bonding_curve.ak's own SellTokens doc comment for the full
    // reasoning.
    const grossProceeds = sellProceeds(currentDatum, newSold, tokenAmount);
    const creatorFee = feeSlice(grossProceeds, CREATOR_BPS);
    const platformFee = feeSlice(grossProceeds, PLATFORM_BPS);
    const feeTotal = creatorFee + platformFee;
    const netProceeds = grossProceeds - feeTotal;

    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      tokens_sold: newSold,
      // Subtract the FULL grossProceeds (not netProceeds) — see
      // bonding_curve.ak's own SellTokens doc comment for the invariant
      // this preserves (total_raised can legitimately go negative on a
      // round-trip sell; that's correct, not a bug).
      total_raised: currentDatum.total_raised - grossProceeds,
      creator_fees_accrued: currentDatum.creator_fees_accrued + creatorFee,
      platform_fees_accrued: currentDatum.platform_fees_accrued + platformFee,
      cap_root: cap.nextRootHex,
    };

    // Redeemer: SellTokens is constructor index 5 of 13 (freshly
    // regenerated plutus.json, 2026-07-19) — raw Constr, same
    // reasoning as BuyTokens above (Data.Object always serializes at
    // index 0).
    const redeemer = new Constr(BONDING_CURVE_REDEEMER.SellTokens, [
      tokenAmount,
      sellerKeyHashHex,
      cap.committedBefore,
      capProofToPlutus(cap.proof),
    ]);

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) - netProceeds;
    continuingAssets[tokenUnit] = (continuingAssets[tokenUnit] ?? 0n) + tokenAmount;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema),
        },
        continuingAssets,
      )
      // Proceeds name the spend they settle — see the buy path above.
      .pay.ToAddressWithData(
        sellerAddress,
        { kind: 'inline', value: settlementDatum(curveUtxo) },
        { lovelace: netProceeds },
      )
      .addSigner(sellerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    // Average lovelace per token across the batch — see buyTokensCore.
    return { txHash, netProceeds, avgPrice: grossProceeds / tokenAmount };
  }

  // --------------------------------------------------------------------------
  // ExpireCurve — permissionless, Phase 7. No extra_signatories
  // check exists on-chain (the deadline check itself is the authorization,
  // same idiom as lp_escrow.ak's ExecuteDexChange) — this session still
  // needs SOME real wallet to pay the tx fee, so it reuses the governor's
  // key for that purpose only, same convention already used for
  // ExecuteDexChange in tier-a-dex-change-submitter.ts. This requires a
  // real, narrow (<=600,000ms), honest-"now" validity range — no
  // backdating here (unlike ActivateCurve, which legitimately backdates
  // `phase_started_at` itself to make this reachable without a real 90-day
  // wait).
  // --------------------------------------------------------------------------

  /**
   * currentTimestampMs is deliberately NOT a caller-supplied parameter —
   * unlike ActivateCurve's legitimately-backdatable timestamp, ExpireCurve
   * MUST be honest (permissionless, validity-width-bound) — computed via
   * Date.now() here, immediately before building the tx, not earlier in
   * the call chain (e.g. PHP, before the child-process spawn + several
   * Blockfrost round trips for UTXO queries), which real-world testing
   * showed can go stale by the time the tx actually reaches a block: a
   * transaction whose declared validity range has already elapsed by
   * submission time gets silently dropped rather than erroring — first
   * real attempt at this session accepted the submission (Blockfrost's
   * `/tx/submit` returned a real txHash, no thrown error) but the tx never
   * landed in a block (confirmed via a real /txs/{hash} 404 and the
   * curve's own UTXO still sitting at its pre-ExpireCurve state).
   */
  async expireCurve(governorPrivateKeyExtendedHex: string, governorAddress: string): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(this.requireDatum(curveUtxo), BondingCurveDatumSchema);

    // Mirrors the validator's own set of expirable states. A curve that was
    // minted and never activated is stalled in the way this redeemer exists
    // for — more so than a trading one, since ActivateCurve is governor-signed
    // — so refusing it here would leave the client answering "no" to a
    // transaction the chain would accept.
    if (currentDatum.curve_state !== 'Active' && currentDatum.curve_state !== 'Inactive') {
      throw new Error(`Curve is ${currentDatum.curve_state} — only an Active or Inactive curve can be expired.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      curve_state: 'Cancelled',
    };

    // Computed as late as possible — right before building — to minimize
    // the gap between "what we claim now is" and "when this actually
    // lands in a block." See method header for why this matters here.
    const currentTimestampMs = Date.now();

    // BondingCurveRedeemer: ExpireCurve is variant 7 of 13 (the
    // SellTokens insertion at index 5 shifted every constructor from
    // CancelCurve onward by one; re-verified directly against the
    // freshly-regenerated plutus.json, not assumed from the old count).
    const redeemer = new Constr(BONDING_CURVE_REDEEMER.ExpireCurve, [BigInt(currentTimestampMs)]);

    // Validity range caps width at 600,000ms — use a generous 240s buffer on each
    // side (480,000ms total, comfortably under the cap) so real-world
    // build/sign/submit latency can't push the tx stale before inclusion.
    const validFrom = currentTimestampMs - 240_000;
    const validTo = currentTimestampMs + 240_000;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema),
        },
        curveUtxo.assets,
      )
      .validFrom(validFrom)
      .validTo(validTo)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // ClaimBuyback — buyer-signed, Phase 7. Same two-entry-point split as
  // BuyTokens above (mnemonic for CLI verification, WalletApi for the real
  // production path — not wired to a widget this phase since the milestone
  // plan doesn't call for buyback UI, only real proven transactions).
  // --------------------------------------------------------------------------

  async claimBuyback(buyerMnemonic: string, tokenAmount: bigint): Promise<{ txHash: string; share: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(buyerMnemonic);
    const buyerAddress = await lucid.wallet().address();
    return this.claimBuybackCore(lucid, buyerAddress, tokenAmount);
  }

  async claimBuybackWithWallet(walletApi: WalletApi, tokenAmount: bigint): Promise<{ txHash: string; share: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const buyerAddress = await lucid.wallet().address();
    return this.claimBuybackCore(lucid, buyerAddress, tokenAmount);
  }

  private async claimBuybackCore(
    lucid: LucidEvolution,
    buyerAddress: string,
    tokenAmount: bigint,
  ): Promise<{ txHash: string; share: bigint }> {
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(this.requireDatum(curveUtxo), BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Cancelled') {
      throw new Error(`Curve is not Cancelled (state: ${currentDatum.curve_state}) — cannot claim buyback.`);
    }
    if (tokenAmount <= 0n || tokenAmount > currentDatum.tokens_sold) {
      throw new Error(`token_amount out of range (tokens_sold: ${currentDatum.tokens_sold}).`);
    }

    const buyerKeyHashHex = buyerKeyHashFromAddress(buyerAddress);
    // Fix (2026-07-19, full-suite security audit): total_raised can
    // legitimately go negative after SellTokens round-trip
    // activity — mirrors bonding_curve.ak's own effective_total_raised
    // floor exactly (see that redeemer's own doc comment for the full
    // reasoning). Left unguarded here, a negative total_raised produced a
    // negative share, which the contract's own fixed checks now reject —
    // this floor keeps the off-chain-computed value consistent with what
    // the fixed contract will actually accept.
    const effectiveTotalRaised = currentDatum.total_raised > 0n ? currentDatum.total_raised : 0n;
    // Mirrors bonding_curve.ak's own real-division share formula exactly —
    // Aiken's Int is arbitrary-precision, no ZK-circuit division
    // restriction, so this is the exact on-chain value, not an
    // approximation.
    const share = (effectiveTotalRaised * tokenAmount) / currentDatum.tokens_sold;

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      tokens_sold: currentDatum.tokens_sold - tokenAmount,
      total_raised: currentDatum.total_raised - share,
    };
    const newCurveAssets = {
      ...curveUtxo.assets,
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - share,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) + tokenAmount,
    };

    // BondingCurveRedeemer: ClaimBuyback is variant 8 of 13 (see
    // ExpireCurve's own comment above for why this shifted).
    const redeemer = new Constr(BONDING_CURVE_REDEEMER.ClaimBuyback, [tokenAmount, buyerKeyHashHex]);

    // Fix (2026-07-22): buyback_share_paid now compares only the
    // payment credential (contract-side fix), so the buyer's own real
    // wallet address works directly — no more deriving/paying to a bare
    // enterprise address as a workaround.
    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema),
        },
        newCurveAssets,
      )
      // The buyback share names the spend it settles — see the buy path above.
      .pay.ToAddressWithData(buyerAddress, { kind: 'inline', value: settlementDatum(curveUtxo) }, { lovelace: share })
      .addSigner(buyerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, share };
  }
}

/**
 * Derive a Cardano base address's payment-credential key hash — the same
 * value Blockfrost's /addresses/{address} endpoint returns as `payment`
 * (already used server-side via np_anvil_parse_address, T-Phase3).
 */
function buyerKeyHashFromAddress(address: string): string {
  const details = getAddressDetails(address);
  const hash = details.paymentCredential?.hash;
  if (!hash) {
    throw new Error(`Could not derive a payment-credential key hash from address ${address}.`);
  }
  return hash;
}

export { buyCost, curvePriceAt, extendedHexToBech32PrivateKey, feeSlice, fromHex, loadValidator, sellProceeds, toHex };
