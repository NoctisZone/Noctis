// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 6
// Real Cardano transaction submitter: vesting.ak's ClaimVested and
// bonding_curve.ak's ClaimCreatorFees — the two Stream A/creator-facing
// claims (CLAUDE.md: "Bonding Curve Escrow" fees vs. token vesting, never
// conflated).
// ============================================================================
// Both creator-wallet-signed. ClaimVested REQUIRES this — fix (2026-07-18)
// enforces the identity requirement on ClaimVested (must be
// check at all (any third party could redirect the creator's vested
// tokens to themselves) and NO check that the continuing output at
// vesting's own address retained the still-locked balance (the creator
// themselves could otherwise drain 100% on day one, defeating the whole
// vesting schedule). Both gaps closed by requiring
// list.has(self.extra_signatories, datum.creator_pub_key_hash) plus a new
// vesting_tokens_retained() relative-decrease check, mirroring
// bonding_curve.ak's own graduation_funds_left_curve pattern exactly.
// ClaimCreatorFees already required a real signature
// (active_fee_recipient) — unaffected by that fix.
//
// ClaimVested's current_timestamp IS bound to real chain time: the validator
// requires interval.contains(validity_range, current_timestamp) and a range
// no wider than max_validity_range_width. So the caller cannot choose it
// freely, the value is MILLISECONDS to match Cardano's own validity range,
// and this builder has to set the range itself — a transaction without one
// is refused by the script rather than merely being imprecise.
//
// Two signing shapes per action, same split as tier-a-curve-submitter.ts's
// ActivateCurve/BuyTokens:
//   - claimVested()/claimCreatorFees(): CLI-driven verification path (this
//     session's Phase 6 proof), signs via a decrypted creator extended key
//     (CML.PrivateKey.from_extended_bytes() + sign.withPrivateKey()).
//   - claimVestedWithWallet()/claimCreatorFeesWithWallet(): the real
//     production path (the dashboard widget,
//     integration/widget/tier-a-dashboard-widget-entry.ts), signs via
//     lucid.selectWallet.fromAPI(walletApi) + sign.withWallet() — the same
//     real, installed WalletApi type and fromAPI()/withWallet() pattern
//     tier-a-curve-submitter.ts's buyTokensWithWallet() already proved out.
// ============================================================================

import type {
  Assets,
  LucidEvolution,
  Network as LucidNetwork,
  SpendingValidator,
  TxSignBuilder,
  UTxO,
  WalletApi,
} from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { type LaunchScopedDatum, selectLaunchUtxo } from './launch-utxo-lookup.js';
import { BONDING_CURVE_REDEEMER, VESTING_REDEEMER } from './redeemer-indices.js';
import {
  type BondingCurveDatumData,
  BondingCurveDatumSchema,
  settlementDatum,
  type ThreadNftRole,
  type VestingDatumData,
  VestingDatumSchema,
} from './tier-a-schemas.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Cardano's real ledger has no explicit-zero multi-asset entries — a
 *  computed-to-zero token quantity must be dropped from the assets map
 *  entirely, not passed through as 0 (same convention as
 *  tier-a-graduation-submitter.ts's pruneZero). */
function pruneZero(assets: Assets): Assets {
  const out: Assets = {};
  for (const [unit, qty] of Object.entries(assets)) {
    if ((qty as bigint) !== 0n) out[unit] = qty as bigint;
  }
  return out;
}

function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

export interface TierAClaimsConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  vestingScriptCbor: string;
  bondingCurveScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class TierAClaimsSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private vestingValidator: SpendingValidator;
  private vestingAddress: string;
  private bondingCurveValidator: SpendingValidator;
  private bondingCurveAddress: string;

  constructor(private config: TierAClaimsConfig) {
    this.vestingValidator = {
      type: 'PlutusV3',
      script: config.vestingScriptCbor,
    };
    this.vestingAddress = validatorToAddress(config.network, this.vestingValidator);
    this.bondingCurveValidator = {
      type: 'PlutusV3',
      script: config.bondingCurveScriptCbor,
    };
    this.bondingCurveAddress = validatorToAddress(config.network, this.bondingCurveValidator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  private async findUtxo<T extends LaunchScopedDatum>(
    lucid: LucidEvolution,
    address: string,
    role: ThreadNftRole,
    schema: unknown,
  ): Promise<{ utxo: UTxO; datum: T }> {
    const utxos = await lucid.utxosAt(address);
    return selectLaunchUtxo<T>(utxos, address, this.config.launchIdHex, role, schema, this.config.threadNftPolicyId);
  }

  /** Live on-chain vesting state — dashboard widget calls this directly
   *  (no server round-trip), same "readCurveDatum()" convention as
   *  tier-a-curve-submitter.ts. */
  async readVestingDatum(): Promise<VestingDatumData> {
    const lucid = await this.lucidPromise;
    const { datum } = await this.findUtxo<VestingDatumData>(lucid, this.vestingAddress, 'vesting', VestingDatumSchema);
    return datum;
  }

  /** Live on-chain bonding_curve state (creator_fees_accrued etc.). */
  async readCurveDatum(): Promise<BondingCurveDatumData> {
    const lucid = await this.lucidPromise;
    const { datum } = await this.findUtxo<BondingCurveDatumData>(
      lucid,
      this.bondingCurveAddress,
      'bondingCurve',
      BondingCurveDatumSchema,
    );
    return datum;
  }

  /**
   * @param claimAmount  Token quantity to claim — caller must supply a
   *   value that satisfies the contract's own vested_to_date math
   *   (token_allocation * elapsed_ms / vest_ms), computed off-chain the
   *   same way the validator computes it on-chain.
   * @param currentTimestampMs  MILLISECONDS — see file header. Must fall
   *   inside the transaction's validity range, which this builder sets.
   */
  private async claimVestedCore(
    lucid: LucidEvolution,
    creatorAddress: string,
    claimAmount: bigint,
    currentTimestampMs: number,
  ): Promise<TxSignBuilder> {
    const { utxo: vestingUtxo, datum: vestingDatum } = await this.findUtxo<VestingDatumData>(
      lucid,
      this.vestingAddress,
      'vesting',
      VestingDatumSchema,
    );

    if (vestingDatum.vesting_state !== 'Vesting') {
      throw new Error(`Vesting is not in the Vesting state (state: ${vestingDatum.vesting_state}).`);
    }

    const newTotalClaimed = vestingDatum.claimed_tokens + claimAmount;
    const nextState = newTotalClaimed === vestingDatum.token_allocation ? 'FullyClaimed' : vestingDatum.vesting_state;
    const newVestingDatum: VestingDatumData = {
      ...vestingDatum,
      claimed_tokens: newTotalClaimed,
      vesting_state: nextState,
    };

    const tokenUnit = vestingDatum.token_policy_id + vestingDatum.token_asset_name;
    const newVestingAssets = pruneZero({
      ...vestingUtxo.assets,
      [tokenUnit]: (vestingUtxo.assets[tokenUnit] ?? 0n) - claimAmount,
    });

    // VestingRedeemer: ClaimVested is variant 1 of 8 (ClaimCommunityAllocation/ClaimCancelledAllocation added since this count was first written).
    const claimVestedRedeemer = new Constr(VESTING_REDEEMER.ClaimVested, [claimAmount, BigInt(currentTimestampMs)]);

    // The validator caps the range at max_validity_range_width (600,000ms).
    // A 240s buffer each way leaves room for build/sign/submit latency while
    // staying well inside that cap — the same window tier-a-curve-submitter
    // uses for its own chain-time-bound redeemers.
    const validFrom = currentTimestampMs - 240_000;
    const validTo = currentTimestampMs + 240_000;

    return lucid
      .newTx()
      .validFrom(validFrom)
      .validTo(validTo)
      .collectFrom([vestingUtxo], Data.to(claimVestedRedeemer))
      .attach.SpendingValidator(this.vestingValidator)
      .pay.ToContract(
        this.vestingAddress,
        {
          kind: 'inline',
          value: Data.to<VestingDatumData>(newVestingDatum, VestingDatumSchema),
        },
        newVestingAssets,
      )
      .pay.ToAddressWithData(
        creatorAddress,
        { kind: 'inline', value: settlementDatum(vestingUtxo) },
        { [tokenUnit]: claimAmount },
      )
      .addSigner(creatorAddress)
      .complete();
  }

  /** CLI-driven verification path — see file header. */
  async claimVested(
    creatorPrivateKeyExtendedHex: string,
    creatorAddress: string,
    claimAmount: bigint,
    currentTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(creatorPrivateKeyExtendedHex);
    const creatorUtxos = await lucid.utxosAt(creatorAddress);
    lucid.selectWallet.fromAddress(creatorAddress, creatorUtxos);

    const tx = await this.claimVestedCore(lucid, creatorAddress, claimAmount, currentTimestampMs);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** Real production path — see file header. */
  async claimVestedWithWallet(
    walletApi: WalletApi,
    claimAmount: bigint,
    currentTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const creatorAddress = await lucid.wallet().address();

    const tx = await this.claimVestedCore(lucid, creatorAddress, claimAmount, currentTimestampMs);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /**
   * Fix (2026-07-19): bonding_curve.ak's ClaimCreatorFees previously had
   * NO real value-conservation check at all — this submitter's own
   * pre-fix version mirrored that gap client-side too (it paid `amount` to
   * the creator but never actually shrank the curve's real lovelace
   * balance in `newCurveAssets`, since `curveUtxo.assets.lovelace - amount`
   * was computed but the ORIGINAL code's redeemer only carried `amount` —
   * this rewrite now also collects the real, on-chain-enforced
   * `platformClaimFeeLovelace` (paid INTO the curve, opposite direction),
   * matching the fixed contract's new two-field redeemer exactly.
   *
   * @param platformClaimFeeLovelace  Real $1-equivalent, computed by the
   *   CALLER via ada-price-oracle.ts's usdToMinAdaLovelace() — this class
   *   stays oracle-agnostic, same convention as claimAmount/
   *   currentTimestampMs above being caller-computed for ClaimVested.
   *   Must be >= the contract's own min_platform_claim_fee_lovelace floor
   *   (200,000 lovelace / 0.2 ADA) or the transaction will fail on-chain.
   */
  private async claimCreatorFeesCore(
    lucid: LucidEvolution,
    creatorAddress: string,
    amount: bigint,
    platformClaimFeeLovelace: bigint,
  ): Promise<TxSignBuilder> {
    const { utxo: curveUtxo, datum: curveDatum } = await this.findUtxo<BondingCurveDatumData>(
      lucid,
      this.bondingCurveAddress,
      'bondingCurve',
      BondingCurveDatumSchema,
    );

    if (curveDatum.cto_triggered) {
      throw new Error('CTO has been triggered — creator fees now route to the community wallet, not this flow.');
    }
    if (amount > curveDatum.creator_fees_accrued) {
      throw new Error(
        `Requested amount (${amount}) exceeds accrued creator fees (${curveDatum.creator_fees_accrued}).`,
      );
    }
    const MIN_PLATFORM_CLAIM_FEE_LOVELACE = 200_000n;
    if (platformClaimFeeLovelace < MIN_PLATFORM_CLAIM_FEE_LOVELACE) {
      throw new Error(
        `platformClaimFeeLovelace (${platformClaimFeeLovelace}) is below the contract's own floor (${MIN_PLATFORM_CLAIM_FEE_LOVELACE}) — the transaction would fail on-chain.`,
      );
    }

    // No split: the platform runs one wallet, so the whole claim fee accrues
    // to the single platform line.
    const newCurveDatum: BondingCurveDatumData = {
      ...curveDatum,
      creator_fees_accrued: curveDatum.creator_fees_accrued - amount,
      platform_fees_accrued: curveDatum.platform_fees_accrued + platformClaimFeeLovelace,
    };
    const newCurveAssets = {
      ...curveUtxo.assets,
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - amount + platformClaimFeeLovelace,
    };

    // BondingCurveRedeemer: ClaimCreatorFees is variant 2 of 13 (freshly
    // regenerated plutus.json, 2026-07-19) — now takes two
    // fields (amount, platform_claim_fee), same constructor index as
    // before since SellTokens was added AFTER ClaimOpsFees in the type
    // declaration, not before ClaimCreatorFees.
    const claimFeesRedeemer = new Constr(BONDING_CURVE_REDEEMER.ClaimCreatorFees, [amount, platformClaimFeeLovelace]);

    return lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(claimFeesRedeemer))
      .attach.SpendingValidator(this.bondingCurveValidator)
      .pay.ToContract(
        this.bondingCurveAddress,
        {
          kind: 'inline',
          value: Data.to<BondingCurveDatumData>(newCurveDatum, BondingCurveDatumSchema),
        },
        newCurveAssets,
      )
      .pay.ToAddressWithData(
        creatorAddress,
        { kind: 'inline', value: settlementDatum(curveUtxo) },
        { lovelace: amount },
      )
      .addSigner(creatorAddress)
      .complete();
  }

  /** CLI-driven verification path — see file header. */
  async claimCreatorFees(
    creatorPrivateKeyExtendedHex: string,
    creatorAddress: string,
    amount: bigint,
    platformClaimFeeLovelace: bigint,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(creatorPrivateKeyExtendedHex);
    const creatorUtxos = await lucid.utxosAt(creatorAddress);
    lucid.selectWallet.fromAddress(creatorAddress, creatorUtxos);

    const tx = await this.claimCreatorFeesCore(lucid, creatorAddress, amount, platformClaimFeeLovelace);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** Real production path — see file header. */
  async claimCreatorFeesWithWallet(
    walletApi: WalletApi,
    amount: bigint,
    platformClaimFeeLovelace: bigint,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const creatorAddress = await lucid.wallet().address();

    const tx = await this.claimCreatorFeesCore(lucid, creatorAddress, amount, platformClaimFeeLovelace);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}
