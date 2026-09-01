// ============================================================================
// Noctis Zone — Cardano Launch Preprod, graduation submitter
// Real Cardano transaction submitter for a TIER B launch's graduation:
// bonding_curve_tier_b.ak's Graduate + lp_escrow.ak's SealLock +
// vesting.ak's StartVesting.
// ============================================================================
// This is a direct MIRROR of tier-a-graduation-submitter.ts (the proven Tier
// A flow — real Preprod txs a7531f4b… graduate+seal and 09d917d2… Minswap
// pool, TIER_A_PREPROD_MILESTONE.md Phase 5/5b). Everything that made the
// The linear curve version correct applies here unchanged, because:
//   - lp_escrow.ak and vesting.ak are SHARED across both Cardano curves (one
//     validator each, not tier-specific). SealLock and StartVesting are
//     byte-for-byte the same redeemers with the same variant indices.
//   - Cardano Launch's Graduate arm (bonding_curve_tier_b.ak) is structurally
//     identical to the linear curve's — verified directly: same
//     `curve_state == Graduated`, `!lp_seeded`, `!staking_seeded`,
//     `new_datum == expected_datum` (only total_raised→0, lp_seeded→True,
//     staking_seeded→True change), and the same four value-movement helpers
//     (graduation_funds_left_curve / lp_seeding_output_ok /
//     staking_seeding_output_ok / curve_own_output_clean). NO DarkVeil-
//     specific precondition (dv_settled/dv_claimed are untouched, carried
//     through by the contract's own `..datum` spread — mirrored here by our
//     `...curveDatum` spread, which now preserves them because
//     BondingCurveTierBDatumSchema was synced to the real 31-field datum,
//     2026-07-23).
//
// The ONLY differences from the linear curve submitter:
//   - decodes/re-encodes the curve UTXO with BondingCurveTierBDatumSchema
//     (Cardano Launch's genuinely different datum shape — adds dv_allocation_root /
//     dv_claimed / dv_settled).
//   - targets bonding_curve_tier_b.ak's compiled script instead of
//     bonding_curve.ak's.
//
// Graduate's redeemer variant index is 9 on BOTH curves — verified against
// bonding_curve_tier_b.ak's own `pub type BondingCurveTierBRedeemer`
// declaration order (ActivateCurve=0, BuyTokens=1, ClaimDarkVeilTokens=2,
// ClaimCreatorFees=3, ClaimTreasuryFees=4, ClaimOpsFees=5, CancelCurve=6,
// ExpireCurve=7, ClaimBuyback=8, Graduate=9, TriggerCTO=10, DissolveCTO=11,
// AnchorDvAllocationRoot=12), not assumed to match the linear curve.
//
// Timestamp units — MILLISECONDS throughout, matching the linear curve submitter
// and Cardano's own validity range. This file is a mirror, and it inherits
// the units along with everything else:
//   - Graduate takes no timestamp parameter at all (bare variant).
//   - SealLock's `timestamp` and vesting's `start_timestamp` are each bound
//     through interval.contains(self.validity_range, ...) in the SHARED
//     lp_escrow.ak / vesting.ak named above, so both builders below set a
//     range and the value must fall inside it.
//   - Both are also stored: `lock_timestamp` is what is_lock_expired adds
//     lock_duration to, and `vest_start_timestamp` is what ClaimVested
//     subtracts from current_timestamp. Those comparisons are ms against
//     ms-scale constants (min_lock_duration, vest_days*86_400_000).
//
// Graduate and SealLock are PERMISSIONLESS; StartVesting requires the
// governor signature. Two-transaction split (TX1 = Graduate + SealLock,
// TX2 = StartVesting alone, built only after TX1 confirms) — same 16384-byte
// tx-size-cap reasoning and same independence proof as the linear curve. TX1 builds
// through mesh-curve-spend.ts's reference-script path exactly as the linear curve's
// does (2026-08-31): the curve and LP escrow validators are NAMED via their
// published CIP-33 reference scripts, staking_pool.ak is carried when a
// staking-enabled launch's pool seeding (TopUpPool, creator-signed) joins
// the transaction — see tier-a-graduation-submitter.ts's header, which this
// file mirrors.
// ============================================================================

import type { Assets, LucidEvolution, Network as LucidNetwork, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { BlockfrostProvider } from '@meshsdk/core';
import { KeyCurveSpendWallet } from './key-curve-spend-wallet.js';
import { selectLaunchUtxo, selectStakingPoolUtxo } from './launch-utxo-lookup.js';
import {
  type CompanionScriptInput,
  type CurveNetwork,
  type GraduationSpendPlan,
  MeshCurveSpender,
  type TxCoSigner,
} from './mesh-curve-spend.js';
import {
  BONDING_CURVE_TIER_B_REDEEMER,
  LP_ESCROW_REDEEMER,
  STAKING_POOL_REDEEMER,
  VESTING_REDEEMER,
} from './redeemer-indices.js';
import type { ReferenceScriptPointer } from './reference-script.js';
import { advance } from './staking-math.js';
import type { CreatorSigner } from './tier-a-graduation-submitter.js';
import {
  type BondingCurveTierBDatumData,
  BondingCurveTierBDatumSchema,
  type LpEscrowDatumData,
  LpEscrowDatumSchema,
  loadValidator,
  type StakingPoolDatumData,
  StakingPoolDatumSchema,
  type ThreadNftRole,
  type VestingDatumData,
  VestingDatumSchema,
} from './tier-a-schemas.js';

/** Lucid's network names, as Mesh's builder and slot maths take them. */
const CURVE_NETWORK: Partial<Record<LucidNetwork, CurveNetwork>> = {
  Preprod: 'preprod',
  Preview: 'preview',
  Mainnet: 'mainnet',
};

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Same conversion the linear curve submitter proved on real Preprod — the
 *  governor key is a shared, tier-agnostic role, so this is reused verbatim. */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

/** Cardano's real ledger has no explicit-zero multi-asset entries — a
 *  computed-to-zero token quantity must be dropped from the assets map
 *  entirely, not passed through as 0. */
function pruneZero(assets: Assets): Assets {
  const out: Assets = {};
  for (const [unit, qty] of Object.entries(assets)) {
    if ((qty as bigint) !== 0n) out[unit] = qty as bigint;
  }
  return out;
}

export interface TierBGraduationConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  bondingCurveTierBScriptCbor: string;
  lpEscrowScriptCbor: string;
  vestingScriptCbor: string;
  stakingPoolScriptCbor: string;
  /**
   * Where the curve and LP escrow validators are published as CIP-33
   * reference scripts — TX1 names both rather than carrying them, the same
   * mechanism every referenced Cardano Launch trade already uses. Optional at the
   * type level only because `startVesting` (TX2) has no use for them;
   * `graduateAndSealLp` requires both and refuses to build without them.
   */
  bondingCurveRef?: ReferenceScriptPointer;
  lpEscrowRef?: ReferenceScriptPointer;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class TierBGraduationSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private bondingCurveValidator: SpendingValidator;
  private lpEscrowValidator: SpendingValidator;
  private vestingValidator: SpendingValidator;
  private stakingPoolValidator: SpendingValidator;
  private bondingCurveAddress: string;
  private lpEscrowAddress: string;
  private vestingAddress: string;
  private stakingPoolAddress: string;

  constructor(private config: TierBGraduationConfig) {
    this.bondingCurveValidator = {
      type: 'PlutusV3',
      script: config.bondingCurveTierBScriptCbor,
    };
    this.lpEscrowValidator = {
      type: 'PlutusV3',
      script: config.lpEscrowScriptCbor,
    };
    this.vestingValidator = {
      type: 'PlutusV3',
      script: config.vestingScriptCbor,
    };
    this.stakingPoolValidator = {
      type: 'PlutusV3',
      script: config.stakingPoolScriptCbor,
    };
    this.bondingCurveAddress = validatorToAddress(config.network, this.bondingCurveValidator);
    this.lpEscrowAddress = validatorToAddress(config.network, this.lpEscrowValidator);
    this.vestingAddress = validatorToAddress(config.network, this.vestingValidator);
    this.stakingPoolAddress = validatorToAddress(config.network, this.stakingPoolValidator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  /**
   * This launch's own UTXO in one role, authenticated by its thread NFT.
   *
   * All three of these validators are unparameterized, so every launch's
   * curve, escrow and vesting UTXOs sit at three shared addresses. Matching on
   * the datum's `launch_id` alone matched a claim anyone could author, and
   * taking the first match meant a second UTXO answering to the same launch
   * was silently passed over. See launch-utxo-lookup.ts.
   */
  private async findUtxo<T extends { launch_id: string; thread_nft_policy: string }>(
    lucid: LucidEvolution,
    address: string,
    role: ThreadNftRole,
    schema: unknown,
  ): Promise<{ utxo: UTxO; datum: T }> {
    const utxos = await lucid.utxosAt(address);
    return selectLaunchUtxo<T>(utxos, address, this.config.launchIdHex, role, schema, this.config.threadNftPolicyId);
  }

  /**
   * TX1 of the graduation flow — Graduate (bonding_curve_tier_b) + SealLock
   * (lp_escrow). See file header for why this is separate from
   * StartVesting. Independently retriable: if a prior call already landed
   * on-chain, this throws (on the state guards below) instead of
   * double-spending.
   *
   * @param lockSealTimestampMs  MILLISECONDS — becomes lp_escrow's
   *   lock_timestamp, which is_lock_expired adds lock_duration to. See file
   *   header.
   */
  async graduateAndSealLp(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    lockSealTimestampMs: number,
    creator?: CreatorSigner,
  ): Promise<{
    txHash: string;
    lpAda: bigint;
    lpReserveTokens: bigint;
    stakingReserveTokens: bigint;
    stakingSeeded: boolean;
  }> {
    const lucid = await this.lucidPromise;

    const { bondingCurveRef, lpEscrowRef } = this.config;
    if (!bondingCurveRef || !lpEscrowRef) {
      throw new Error(
        'Graduation needs both reference-script pointers (bondingCurveRef, lpEscrowRef) — TX1 names ' +
          'the curve and LP escrow validators on chain rather than carrying them, and carried they do ' +
          'not fit the transaction size cap. Publish them (publish-reference-script) and pass the pointers.',
      );
    }

    const { utxo: curveUtxo, datum: curveDatum } = await this.findUtxo<BondingCurveTierBDatumData>(
      lucid,
      this.bondingCurveAddress,
      'bondingCurveTierB',
      BondingCurveTierBDatumSchema,
    );
    const { utxo: lpUtxo, datum: lpDatum } = await this.findUtxo<LpEscrowDatumData>(
      lucid,
      this.lpEscrowAddress,
      'lpEscrow',
      LpEscrowDatumSchema,
    );

    if (curveDatum.curve_state !== 'Graduated') {
      throw new Error(`Curve is not Graduated (state: ${curveDatum.curve_state}) — cannot call Graduate yet.`);
    }
    if (curveDatum.lp_seeded || curveDatum.staking_seeded) {
      throw new Error('Curve already lp_seeded/staking_seeded — Graduate already ran for this launch.');
    }
    if (lpDatum.lock_timestamp !== 0n) {
      throw new Error('lp_escrow already sealed (lock_timestamp != 0) — SealLock already ran for this launch.');
    }

    // total_raised must be real, positive backing for the LP — same
    // guard as the linear curve submitter (fail fast with a clear message rather
    // than building a tx the contract's value helpers will reject).
    if (curveDatum.total_raised <= 0n) {
      throw new Error(
        `total_raised (${curveDatum.total_raised}) is not positive — Graduate requires real, positive backing for the LP. This curve likely saw heavy net selling before reaching 100% sold.`,
      );
    }
    const lpAda = curveDatum.total_raised;
    const tokensLeaving = curveDatum.lp_reserve_tokens + curveDatum.staking_reserve_tokens;
    const tokenUnit = curveDatum.token_policy_id + curveDatum.token_asset_name;

    // ---- bonding_curve_tier_b's own continuing output (Graduate) ----
    // The spread carries every unchanged field through — crucially including
    // Cardano Launch's DarkVeil fields (dv_allocation_root /
    // dv_claimed / dv_settled) and the cto_governance_* fields, matching the
    // contract's own `..datum` spread. Only these three change. The assets
    // spread likewise: built from the FULL input value so the curve's thread
    // NFT continues, with only the graduation's own movements applied.
    const newCurveAssets = pruneZero({
      ...curveUtxo.assets,
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - lpAda,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) - tokensLeaving,
    });
    const newCurveDatum: BondingCurveTierBDatumData = {
      ...curveDatum,
      total_raised: 0n,
      lp_seeded: true,
      staking_seeded: true,
    };

    // ---- lp_escrow's own continuing output (SealLock) ----
    // Same full-value discipline: the escrow's thread NFT continues, and
    // `lp_seeding_output_ok` requires it to (== 1 in the seeded output).
    const newLpAssets = pruneZero({
      ...lpUtxo.assets,
      lovelace: (lpUtxo.assets.lovelace ?? 0n) + lpAda,
      [tokenUnit]: lpDatum.lp_token_amount,
    });
    const newLpDatum: LpEscrowDatumData = {
      ...lpDatum,
      lock_timestamp: BigInt(lockSealTimestampMs),
      lp_state: 'Locked',
    };

    // Named rather than numbered — the comment that stood here recorded
    // Graduate as variant 9 while the code sent 8. `redeemer-indices.ts` is
    // held against the compiled blueprint by a test, so it cannot say that.
    const graduateRedeemer = new Constr(BONDING_CURVE_TIER_B_REDEEMER.Graduate, []);
    const sealLockRedeemer = new Constr(LP_ESCROW_REDEEMER.SealLock, [BigInt(lockSealTimestampMs), lpAda]);

    const companionInputs: CompanionScriptInput[] = [
      {
        utxo: {
          txHash: lpUtxo.txHash,
          outputIndex: lpUtxo.outputIndex,
          address: lpUtxo.address,
          assets: lpUtxo.assets,
        },
        redeemerCbor: Data.to(sealLockRedeemer),
        script: {
          compiledScriptCbor: this.config.lpEscrowScriptCbor,
          referenceScript: lpEscrowRef,
        },
      },
    ];
    const payouts: GraduationSpendPlan['payouts'] = [
      {
        address: this.lpEscrowAddress,
        assets: newLpAssets,
        datumCbor: Data.to<LpEscrowDatumData>(newLpDatum, LpEscrowDatumSchema),
      },
    ];
    const requiredSignerHashes: string[] = [];

    // The window this whole graduation validates inside. Derived here, above
    // the plan that declares it, because the staking pool reads its `now` off
    // this range rather than off the clock that centres it.
    const graduationHalfWindowMs = 240_000;
    const validityFromMs = lockSealTimestampMs - graduationHalfWindowMs;
    // What the chain reports that lower bound AS. A validity start travels as
    // a slot, so it lands on a whole second; both networks' era start is a
    // whole second too, which makes flooring to the second exact rather than
    // approximate.
    const rangeLowerBoundMs = BigInt(Math.floor(validityFromMs / 1000) * 1000);

    // ---- staking pool's own seeding spend (TopUpPool), staking launches ----
    // Same mechanism as the linear curve submitter — staking_pool.ak is SHARED
    // across both curve validators, so the pool spend is identical.
    //
    // The pool UTXO already exists — its thread NFT is minted once, with the
    // launch — so graduation FUNDS it rather than creating it. TopUpPool is
    // permissionless and needs no signature from anyone: giving a pool tokens
    // is not something to be authorised.
    //
    // The datum this writes has to be exactly what the curve's own
    // `staking_seeding_output_ok` derives, field for field, or graduation is
    // refused. Reaching that is why `Stake` will not touch an unfunded pool:
    // it keeps `total_staked` and `stake_root` at their opening values until
    // this lands.
    if (curveDatum.staking_enabled) {
      const { utxo: poolUtxo, datum: poolDatum } = await this.findStakingPoolUtxo(lucid);
      const { acc, unallocated } = advance(poolDatum, rangeLowerBoundMs);
      const seededDatum: StakingPoolDatumData = {
        ...poolDatum,
        acc_reward_per_token: acc,
        unallocated: unallocated + curveDatum.staking_reserve_tokens,
        // NOT `lockSealTimestampMs`. The pool takes its own `now` from the
        // validity range's LOWER bound, and pins this field to exactly that,
        // so stamping the centre here leaves the two half a window apart and
        // the pool refuses its own seeding. The curve is happy either way —
        // it only asks that the timestamp fall INSIDE the range — which is
        // why the two contracts have to be reconciled here rather than by
        // either one of them. A unit test cannot see this: it builds the
        // range and the datum from the same variable.
        last_update_ms: rangeLowerBoundMs,
        exhausted_at: null,
      };
      companionInputs.push({
        utxo: {
          txHash: poolUtxo.txHash,
          outputIndex: poolUtxo.outputIndex,
          address: poolUtxo.address,
          assets: poolUtxo.assets,
        },
        redeemerCbor: Data.to(new Constr(STAKING_POOL_REDEEMER.TopUpPool, [curveDatum.staking_reserve_tokens])),
        script: { embeddedScriptCbor: this.config.stakingPoolScriptCbor },
      });
      payouts.push({
        address: this.stakingPoolAddress,
        assets: pruneZero({
          ...poolUtxo.assets,
          // The pool gains a second asset, which raises its own minimum-ada
          // floor — a small top-up keeps the output above it.
          lovelace: (poolUtxo.assets.lovelace ?? 0n) + 300_000n,
          [tokenUnit]: (poolUtxo.assets[tokenUnit] ?? 0n) + curveDatum.staking_reserve_tokens,
        }),
        datumCbor: Data.to<StakingPoolDatumData>(seededDatum, StakingPoolDatumSchema),
      });
    }

    const plan: GraduationSpendPlan = {
      scriptUtxo: {
        txHash: curveUtxo.txHash,
        outputIndex: curveUtxo.outputIndex,
        address: curveUtxo.address,
        assets: curveUtxo.assets,
      },
      redeemerCbor: Data.to(graduateRedeemer),
      continuing: {
        datumCbor: Data.to<BondingCurveTierBDatumData>(newCurveDatum, BondingCurveTierBDatumSchema),
        assets: newCurveAssets,
      },
      payouts,
      companionInputs,
      requiredSignerHashes,
      // SealLock binds its timestamp to the range, so the range has to exist.
      validity: { fromMs: validityFromMs, toMs: lockSealTimestampMs + graduationHalfWindowMs },
    };

    const { spender, wallet, coSigners } = await this.meshParts(
      bondingCurveRef,
      governorPrivateKeyExtendedHex,
      governorAddress,
      // Only when the plan actually declares a required signer. A witness the
      // plan does not declare is one the fee was never sized for — Mesh counts
      // the declared signers when it prices the transaction, and a signature
      // appended afterwards makes the transaction bigger than the fee it
      // carries, which the node refuses on submission rather than at build.
      // Tying the two to the same list keeps them in step in both directions.
      plan.requiredSignerHashes.length > 0 ? creator : undefined,
    );
    const txHash = await spender.submitGraduation(plan, wallet, coSigners);

    return {
      txHash,
      lpAda,
      lpReserveTokens: curveDatum.lp_reserve_tokens,
      stakingReserveTokens: curveDatum.staking_reserve_tokens,
      stakingSeeded: curveDatum.staking_enabled,
    };
  }

  /** The launch's staking Pool UTXO — sum-type datum, so its own selector. */
  private async findStakingPoolUtxo(lucid: LucidEvolution) {
    const utxos = await lucid.utxosAt(this.stakingPoolAddress);
    return selectStakingPoolUtxo<StakingPoolDatumData>(
      utxos,
      this.stakingPoolAddress,
      this.config.launchIdHex,
      StakingPoolDatumSchema,
      this.config.threadNftPolicyId,
    );
  }

  /**
   * The Mesh execution parts for TX1 — same shape as the linear curve submitter's:
   * a spender referencing the curve, the governor's key-backed wallet funding
   * fees and change, and the creator as co-signer when one was passed and is
   * not the governor already.
   */
  private async meshParts(
    bondingCurveRef: ReferenceScriptPointer,
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    creator?: CreatorSigner,
  ): Promise<{ spender: MeshCurveSpender; wallet: KeyCurveSpendWallet; coSigners: TxCoSigner[] }> {
    const network = CURVE_NETWORK[this.config.network];
    if (!network) {
      throw new Error(
        `Network ${this.config.network} has no Mesh equivalent — the referenced graduation path ` +
          'supports Preprod, Preview and Mainnet.',
      );
    }
    const provider = new BlockfrostProvider(this.config.blockfrostProjectId);
    const spender = new MeshCurveSpender({
      network,
      compiledScriptCbor: this.config.bondingCurveTierBScriptCbor,
      referenceScript: bondingCurveRef,
      provider,
    });
    const wallet = await KeyCurveSpendWallet.forAddress({
      address: governorAddress,
      privateKeyExtendedHex: governorPrivateKeyExtendedHex,
      provider,
    });
    const coSigners: TxCoSigner[] = [];
    if (creator && creator.address !== governorAddress) {
      coSigners.push(
        await KeyCurveSpendWallet.forAddress({
          address: creator.address,
          privateKeyExtendedHex: creator.privateKeyExtendedHex,
          provider,
        }),
      );
    }
    return { spender, wallet, coSigners };
  }

  /**
   * TX2 of the graduation flow — StartVesting (vesting.ak, the SHARED
   * validator). Fully independent of Graduate/SealLock (verified — see file
   * header), so this can be called any time after mint and independently
   * retried.
   *
   * @param vestStartTimestampMs  MILLISECONDS.
   */
  async startVesting(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    vestStartTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;

    const { utxo: vestingUtxo, datum: vestingDatum } = await this.findUtxo<VestingDatumData>(
      lucid,
      this.vestingAddress,
      'vesting',
      VestingDatumSchema,
    );

    if (vestingDatum.vesting_state !== 'NotStarted') {
      throw new Error(`Vesting is not NotStarted (state: ${vestingDatum.vesting_state}) — StartVesting already ran.`);
    }

    const newVestingDatum: VestingDatumData = {
      ...vestingDatum,
      vesting_state: 'Vesting',
      vest_start_timestamp: BigInt(vestStartTimestampMs),
    };

    const startVestingRedeemer = new Constr(VESTING_REDEEMER.StartVesting, [BigInt(vestStartTimestampMs)]);

    // StartVesting binds start_timestamp to the range the same way.
    const vestValidFrom = vestStartTimestampMs - 240_000;
    const vestValidTo = vestStartTimestampMs + 240_000;

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const tx = await lucid
      .newTx()
      .validFrom(vestValidFrom)
      .validTo(vestValidTo)
      .collectFrom([vestingUtxo], Data.to(startVestingRedeemer))
      .attach.SpendingValidator(this.vestingValidator)
      .pay.ToContract(
        this.vestingAddress,
        {
          kind: 'inline',
          value: Data.to<VestingDatumData>(newVestingDatum, VestingDatumSchema),
        },
        vestingUtxo.assets,
      )
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();

    return { txHash };
  }

  /**
   * Convenience wrapper: runs graduateAndSealLp() then startVesting() in
   * sequence, waiting for TX1 to confirm before building TX2. If TX2 fails,
   * TX1's hash is preserved in the thrown error so a caller can tell
   * graduation already landed and only StartVesting needs a retry.
   *
   * @param lockSealTimestampMs  MILLISECONDS — used for both
   *   lp_escrow's lock_timestamp and vesting's vest_start_timestamp.
   */
  async graduate(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    lockSealTimestampMs: number,
    creator?: CreatorSigner,
  ): Promise<{
    graduateSealLockTxHash: string;
    startVestingTxHash: string;
    lpAda: bigint;
    lpReserveTokens: bigint;
    stakingReserveTokens: bigint;
    stakingSeeded: boolean;
  }> {
    const lucid = await this.lucidPromise;

    const step1 = await this.graduateAndSealLp(
      governorPrivateKeyExtendedHex,
      governorAddress,
      lockSealTimestampMs,
      creator,
    );

    await lucid.awaitTx(step1.txHash);

    let step2TxHash: string;
    try {
      const step2 = await this.startVesting(governorPrivateKeyExtendedHex, governorAddress, lockSealTimestampMs);
      step2TxHash = step2.txHash;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `graduateAndSealLp succeeded (txHash: ${step1.txHash}) but startVesting failed: ${message}. ` +
          'Retry with startVesting() directly — do not re-run graduate().',
      );
    }

    return {
      graduateSealLockTxHash: step1.txHash,
      startVestingTxHash: step2TxHash,
      lpAda: step1.lpAda,
      lpReserveTokens: step1.lpReserveTokens,
      stakingReserveTokens: step1.stakingReserveTokens,
      stakingSeeded: step1.stakingSeeded,
    };
  }
}

export { loadValidator };
