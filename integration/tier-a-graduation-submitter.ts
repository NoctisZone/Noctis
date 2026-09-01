// ============================================================================
// Noctis Zone — Cardano Preprod milestone, Phase 5
// Real Cardano transaction submitter for graduation: bonding_curve.ak's
// Graduate + lp_escrow.ak's SealLock + vesting.ak's StartVesting.
// ============================================================================
// TWO TRANSACTIONS, and TX1 REFERENCES its validators. The flow was split
// in July 2026 (TX1 = Graduate + SealLock, the two redeemers coupled through
// lp_seeding_output_ok / lp_value_received's shared lp_ada value; TX2 =
// StartVesting, verified fully independent — it checks only the governor
// signature and its own `vesting_state == NotStarted`, never curve or
// escrow state). TX2 is built only after TX1 is confirmed (lucid.awaitTx)
// so its fee/collateral input selection sees TX1's real spent/change UTxOs.
//
// TX1 goes through mesh-curve-spend.ts's reference-script path (2026-08-31):
// the curve and LP escrow validators are NAMED via their published CIP-33
// reference scripts rather than carried in the witness set. Carried, the
// pair alone exceeds Cardano's 16,384-byte transaction cap — referencing
// them charges only a pointer, the same mechanism every referenced trade
// already uses, with the same staleness guard (a pointer published for an
// older build of a validator fails locally with both hashes named).
// staking_pool.ak is small and is carried when it joins the transaction.
//
// A staking-enabled launch's TX1 also seeds the pool: Graduate's
// staking_seeding_output_ok requires an output at the pool's credential
// holding the reserve tokens AND the pool's thread NFT, and that NFT sits
// in the pool's genesis UTXO — so the seeding is a real spend of that UTXO,
// through staking_pool.ak's TopUpPool (its value-increasing path, which is
// creator-signed). The transaction then carries two signatures: the
// governor's (fees/collateral) and the creator's (TopUpPool), merged as
// sequential witness sets.
// ============================================================================
// Graduate and SealLock are both PERMISSIONLESS (no extra_signatories check
// at all — "the correctness of the resulting real value movement is the
// authorization", same idiom as ExpireCurve/ExecuteDexChange). StartVesting
// requires the governor's signature — same
// CML.PrivateKey.from_extended_bytes() + selectWallet.fromAddress() pattern
// tier-a-curve-submitter.ts's activateCurve() already established and
// proved on real Preprod, reused for TX2 rather than re-derived. TopUpPool
// requires the creator's — see above.
//
// Timestamp units — MILLISECONDS throughout, matching Cardano's own validity
// range, and verified against each contract's current redeemer logic:
//   - Graduate takes no timestamp parameter at all (bare variant).
//   - SealLock's `timestamp` and vesting's `start_timestamp` are both bound
//     through interval.contains(self.validity_range, ...), so each builder
//     below sets a range and the value must fall inside it.
//   - They are also stored: `lock_timestamp` is what is_lock_expired adds
//     lock_duration to, and `vest_start_timestamp` is what ClaimVested
//     subtracts from current_timestamp. Both of those comparisons are in ms,
//     so storing seconds here would make a vesting schedule read as complete
//     from its first day.

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
  BONDING_CURVE_REDEEMER,
  LP_ESCROW_REDEEMER,
  STAKING_POOL_REDEEMER,
  VESTING_REDEEMER,
} from './redeemer-indices.js';
import type { ReferenceScriptPointer } from './reference-script.js';
import { advance } from './staking-math.js';
import {
  type BondingCurveDatumData,
  BondingCurveDatumSchema,
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

/** Same conversion tier-a-curve-submitter.ts's activateCurve() already
 *  proved on real Preprod — reused verbatim rather than re-derived. */
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

export interface TierAGraduationConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  bondingCurveScriptCbor: string;
  lpEscrowScriptCbor: string;
  vestingScriptCbor: string;
  stakingPoolScriptCbor: string;
  /**
   * Where the curve and LP escrow validators are published as CIP-33
   * reference scripts. TX1 names both rather than carrying them — carried,
   * the pair alone is over Cardano's 16,384-byte transaction cap, so a
   * graduation only fits by referencing them. Each pointer is checked
   * against the compiled validator before anything is built (see
   * reference-script.ts), so a pointer published for an older build fails
   * locally with both hashes named.
   *
   * Optional at the type level only because `startVesting` (TX2, a single
   * small validator) has no use for them — `graduateAndSealLp` requires
   * both and refuses to build without them.
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

/**
 * The creator's signing identity, needed only when the launch opted into
 * staking: seeding the pool spends its genesis UTXO via staking_pool.ak's
 * `TopUpPool`, the one value-increasing path that validator has, and that
 * redeemer requires the creator's signature. Graduate and SealLock stay
 * permissionless — this is the pool contract's own rule, not the curve's.
 */
export interface CreatorSigner {
  address: string;
  privateKeyExtendedHex: string;
}

export class TierAGraduationSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private bondingCurveValidator: SpendingValidator;
  private lpEscrowValidator: SpendingValidator;
  private vestingValidator: SpendingValidator;
  private stakingPoolValidator: SpendingValidator;
  private bondingCurveAddress: string;
  private lpEscrowAddress: string;
  private vestingAddress: string;
  private stakingPoolAddress: string;

  constructor(private config: TierAGraduationConfig) {
    this.bondingCurveValidator = {
      type: 'PlutusV3',
      script: config.bondingCurveScriptCbor,
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
   * TX1 of the graduation flow — Graduate (bonding_curve) + SealLock
   * (lp_escrow), plus the staking pool's own seeding spend (`TopUpPool`)
   * when the launch opted into staking. See file header for why this is
   * separate from StartVesting. Independently retriable: safe to call again
   * only if the curve is still Graduated/not-yet-lp_seeded (checked below) —
   * if a prior call already landed on-chain, this throws instead of
   * double-spending.
   *
   * Built and submitted through the Mesh reference-script path
   * (mesh-curve-spend.ts): the curve and LP escrow validators are NAMED via
   * their published reference scripts rather than carried, which is what
   * makes the transaction fit Cardano's 16,384-byte cap — together the two
   * validators alone are over it. staking_pool.ak is small enough to carry,
   * the same split the trade batcher draws for orders.
   *
   * Every state UTXO's continuing output keeps its full input value —
   * thread NFT included — with only the graduation's own movements applied:
   * the seeding checks on Graduate require each destination output to carry
   * its role's thread NFT, so an output built from the movement amounts
   * alone would not validate.
   *
   * @param lockSealTimestampMs  MILLISECONDS — becomes lp_escrow's
   *   lock_timestamp (real-day-arithmetic field, see file header —
   *   deliberately NOT the same units as ActivateCurve's ms-scale
   *   current_timestamp).
   * @param creator  Required when the launch opted into staking — the pool's
   *   seeding spend is creator-signed (see CreatorSigner). Ignored otherwise.
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

    const { utxo: curveUtxo, datum: curveDatum } = await this.findUtxo<BondingCurveDatumData>(
      lucid,
      this.bondingCurveAddress,
      'bondingCurve',
      BondingCurveDatumSchema,
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

    // Fix (2026-07-19, full-suite security audit): total_raised can
    // legitimately go negative or zero after heavy SellTokens
    // activity before a curve's final buy pushes it to 100% sold — the
    // fixed contract now requires total_raised > 0 as a hard precondition
    // for Graduate (see that redeemer's own doc comment for why a
    // zero/negative-backed "Graduated" LP would be worse than just
    // blocking graduation). Fail fast here with a clear message rather
    // than building a transaction the contract will reject.
    if (curveDatum.total_raised <= 0n) {
      throw new Error(
        `total_raised (${curveDatum.total_raised}) is not positive — Graduate requires real, positive backing for the LP. This curve likely saw heavy net selling before reaching 100% sold.`,
      );
    }
    const lpAda = curveDatum.total_raised;
    const tokensLeaving = curveDatum.lp_reserve_tokens + curveDatum.staking_reserve_tokens;
    const tokenUnit = curveDatum.token_policy_id + curveDatum.token_asset_name;

    // ---- bonding_curve's own continuing output (Graduate) ----
    // Built from the FULL input value, so the curve's thread NFT continues
    // — graduation moves the raise and the reserves out, nothing else.
    const newCurveAssets = pruneZero({
      ...curveUtxo.assets,
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - lpAda,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) - tokensLeaving,
    });
    const newCurveDatum: BondingCurveDatumData = {
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

    // Two contracts, two redeemers, both named rather than numbered. The
    // comment that stood here recorded Graduate as variant 9 while the code
    // sent 8 — the exact drift `redeemer-indices.ts` exists to end, since a
    // wrong index decodes as a different redeemer rather than failing.
    const graduateRedeemer = new Constr(BONDING_CURVE_REDEEMER.Graduate, []);
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
          // floor — a small top-up keeps the output above it. TopUpPool
          // checks the token movement, not the lovelace, and the extra is
          // funded by the fee wallet like any other output cost.
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
        datumCbor: Data.to<BondingCurveDatumData>(newCurveDatum, BondingCurveDatumSchema),
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
   * The Mesh execution parts for TX1: a spender referencing the curve, the
   * governor's key-backed wallet funding fees and change, and the creator as
   * co-signer when one was passed and is not the governor already.
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
      compiledScriptCbor: this.config.bondingCurveScriptCbor,
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
   * TX2 of the graduation flow — StartVesting (vesting.ak). Fully
   * independent of Graduate/SealLock (verified — see file header), so this
   * can be called any time after mint, and independently retried if it
   * fails without needing to touch the curve/lp_escrow state at all.
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
   * sequence, waiting for TX1 to confirm before building TX2 so TX2's fee/
   * collateral UTXO selection sees real post-TX1 governor state. If TX2
   * fails, TX1's hash is NOT lost — it's included in the thrown error so a
   * caller can tell graduation already landed and only StartVesting needs a
   * retry (via startVesting() directly).
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
