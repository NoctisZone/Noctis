// ============================================================================
// Noctis Zone — Cardano Launch, graduation submitter
// bonding_curve_tier_b.ak's Graduate + lp_escrow.ak's SealLock + the staking
// pool's TopUpPool + NoctisSwap's factory Create, as ONE transaction, then
// vesting.ak's StartVesting as a second.
// ============================================================================
// WHAT A GRADUATION IS NOW. A Cardano Launch does not park its reserves in
// escrow any more: it opens a NoctisSwap pool, and the escrow holds that
// pool's LQ position for the lock. Five things therefore have to be true of
// one transaction, and each is checked by a different validator:
//
//   0  the curve's own continuing output   Graduate: state Graduated, not yet
//                                          seeded, the raise and both reserves
//                                          really leaving, nothing padded
//   1  the LP escrow, sealed               SealLock: the LQ named in the datum
//                                          really arrives, lovelace UNCHANGED,
//                                          the lock stamped inside the range
//   2  the venue pool, opened              the factory: its own `expected`
//                                          datum field for field, four assets,
//                                          the NFT, the LQ remainder
//   3  the staking pool, seeded            TopUpPool, opt-in launches only
//      (the factory's mint)                exactly one pool NFT and the whole
//                                          LQ supply, nothing else
//
// The numbers on the left are literal: the factory's `Create` redeemer names
// the pool and the escrow BY OUTPUT INDEX, so the order above is part of the
// transaction's meaning rather than a matter of style. `expectedOutputs` on
// the plan is what holds the built transaction to it — see mesh-curve-spend.ts.
//
// WHAT MAKES IT PERMISSIONLESS. Graduate, SealLock, TopUpPool and Create are
// all unsigned. The factory's authority is that the curve is spent under
// `Graduate` in the same transaction, and the curve's authority is that it
// really reached 100% sell-through. Nothing here can withhold a pool from a
// launch that earned one, which is the point: a platform signature on
// graduation would be a platform veto on graduation.
//
// WHAT THE SUBMITTER HAS TO BE TOLD, AND WHY IT CANNOT WORK IT OUT. The pool's
// opening datum carries `royalty_pub_key`, the creator's Ed25519 PUBLIC KEY —
// the factory checks `blake2b_224` of it against the key hash the LP escrow
// recorded at genesis, and the withdraw path later verifies real signatures
// against it. A Cardano address carries a key HASH, so the key itself cannot
// be recovered from anything on chain that this submitter reads. It has to be
// captured when the launch is created and handed in here.
// ============================================================================
// SCRIPTS ARE NAMED, NOT CARRIED. The curve alone is most of the 16,384-byte
// transaction cap; the escrow, the staking pool and the factory together are
// most of the rest. Every one of the four is referenced through its published
// CIP-33 pointer, and `mesh-curve-spend.ts` re-derives each script's hash from
// the bytes it was handed before it will use a pointer, so a pointer left over
// from an older build fails at build time with both hashes named.
//
// TWO TRANSACTIONS, NOT ONE. StartVesting is independent of all of the above —
// it touches only `vesting.ak`, reads nothing the graduation writes, and can
// run any time after the mint. It stays a second transaction so the first one
// keeps its headroom, and so a failure in either is retriable on its own.
//
// TIMESTAMPS ARE MILLISECONDS throughout, matching Cardano's own validity
// range. Graduate takes no timestamp at all. SealLock's `timestamp` and
// vesting's `start_timestamp` are each bound by
// `interval.contains(self.validity_range, …)` AND a width bound, so declaring
// one means also declaring a narrow range around it. The staking pool is the
// awkward one: it reads its own `now` off the range's LOWER BOUND and pins its
// `last_update_ms` to exactly that, so the seeding datum is stamped with the
// floor of the range rather than with the seal timestamp. A unit test cannot
// catch that — it builds the range and the datum from the same variable.
// ============================================================================

import type { Assets, LucidEvolution, Network as LucidNetwork, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, credentialToAddress, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
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
import { scriptHashOf } from './reference-script.js';
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
import {
  blake2b224Hex,
  openingPoolDatum,
  VENUE_MAX_LQ_CAP,
  type VenueFactoryParameters,
  VenuePoolConfigSchema,
  venueAssetName,
  venueCreateRedeemer,
  venueMintedAssets,
} from './venue-pool.js';

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

/**
 * NoctisSwap, as a graduation has to know it: the factory that mints the
 * pool, and the nine parameters it was applied with.
 *
 * `parameters` is not a convenience copy — the factory rebuilds the pool's
 * opening datum from exactly these values and requires the submitted datum to
 * equal it, so a graduation built from a different set produces a datum the
 * factory refuses. Read them from `contracts/cardano-dex/deployment/
 * applied.json` with `readVenueFactoryParameters`, which is the same record
 * `factoryScriptCbor` comes from, rather than assembling them by hand.
 */
export interface VenueDeployment {
  /** The APPLIED factory's compiled script, raw CBOR from the record. */
  factoryScriptCbor: string;
  /** Where that factory is published. Referenced, not carried — see header. */
  factoryRef?: ReferenceScriptPointer;
  parameters: VenueFactoryParameters;
}

export interface TierBGraduationConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  bondingCurveTierBScriptCbor: string;
  lpEscrowScriptCbor: string;
  vestingScriptCbor: string;
  stakingPoolScriptCbor: string;
  /** The venue this launch graduates onto. */
  venue: VenueDeployment;
  /**
   * The creator's fee-recipient Ed25519 PUBLIC KEY, hex — not its hash.
   *
   * The pool's datum carries it, the factory checks `blake2b_224` of it
   * against the hash the LP escrow recorded at genesis, and the venue's
   * withdraw path verifies real signatures against it later. It cannot be
   * derived from anything this submitter reads: a Cardano address carries the
   * hash, and hashing is one-way. Captured at launch creation.
   */
  creatorRoyaltyPubKeyHex: string;
  /** Where the staking pool validator is published, for staking launches. */
  stakingPoolRef?: ReferenceScriptPointer;
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
   * TX1 — the graduation itself: Graduate, SealLock, the factory's Create and
   * (for an opt-in launch) TopUpPool, in one transaction. See the file header
   * for the output layout the factory's redeemer depends on, and for why
   * StartVesting is a separate transaction.
   *
   * Independently retriable. If a prior call already landed on chain this
   * throws on one of the state guards below rather than building a second
   * transaction to spend UTXOs that are gone.
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
    poolAddress: string;
    poolUtxoRef: string;
    poolNftUnit: string;
    lqUnit: string;
    escrowedLq: bigint;
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

    // ---- NoctisSwap: the pool this graduation opens ----
    // The factory's policy id is the hash of the APPLIED factory. Everything
    // below is checked against it before a transaction is built, because each
    // of these is a rule some validator enforces with a message that names
    // neither the field nor the reason.
    const { parameters: venue } = this.config.venue;
    const factoryPolicyId = scriptHashOf(this.config.venue.factoryScriptCbor);
    const poolNftUnit = factoryPolicyId + venueAssetName('pool', this.config.launchIdHex);
    const lqUnit = factoryPolicyId + venueAssetName('lq', this.config.launchIdHex);

    if (curveDatum.pool_nft_policy !== factoryPolicyId) {
      throw new Error(
        `This launch was minted against factory ${curveDatum.pool_nft_policy}, and the graduation is ` +
          `being built against ${factoryPolicyId}. The curve looks for a pool output carrying an NFT ` +
          'under the policy in its own datum, so a pool minted by any other factory is invisible to it.',
      );
    }
    if (curveDatum.lp_reserve_tokens <= 0n) {
      throw new Error(
        `lp_reserve_tokens is ${curveDatum.lp_reserve_tokens} — a pool opens with a real reserve of the ` +
          'launch token on one side, and the factory requires a positive quantity of it.',
      );
    }
    // The escrow's position was written at GENESIS and SealLock's equality
    // check never updates it, so these three fields have to have been right
    // before the launch ever traded. Wrong here means a launch that can reach
    // 100% sell-through and then cannot graduate at all.
    if (
      lpDatum.lp_token_policy_id !== factoryPolicyId ||
      lpDatum.lp_token_name !== venueAssetName('lq', this.config.launchIdHex) ||
      lpDatum.lp_token_amount !== venue.initialLq
    ) {
      throw new Error(
        `The LP escrow's genesis names its position as ${lpDatum.lp_token_amount} of ` +
          `${lpDatum.lp_token_policy_id}.${lpDatum.lp_token_name}, but this factory mints ` +
          `${venue.initialLq} of ${factoryPolicyId}.${venueAssetName('lq', this.config.launchIdHex)}. ` +
          'SealLock compares the position it receives with the one its datum names, and that datum was ' +
          'fixed at genesis — this launch cannot graduate onto this factory.',
      );
    }
    if (blake2b224Hex(this.config.creatorRoyaltyPubKeyHex) !== lpDatum.fee_recipient_pub_key_hash) {
      throw new Error(
        'The creator public key supplied does not hash to the fee recipient the LP escrow recorded at ' +
          'genesis. The factory takes blake2b_224 of the key it is given and compares it with that ' +
          'record, so the wrong key is refused on chain with nothing said about which key was wrong.',
      );
    }
    // `lp_own_output_clean` allows the sealed escrow three assets: lovelace,
    // its thread NFT and the LQ position. Anything else already sitting on
    // the escrow makes that four and the seal fails.
    const escrowUnits = Object.keys(pruneZero(lpUtxo.assets));
    if (escrowUnits.length > 2) {
      throw new Error(
        `The LP escrow UTXO holds ${escrowUnits.length} assets (${escrowUnits.join(', ')}). Sealing adds ` +
          'the pool LQ token, and the escrow refuses a sealed output holding more than lovelace, its ' +
          'thread NFT and the position.',
      );
    }

    const poolAddress = credentialToAddress(this.config.network, {
      type: 'Script',
      hash: venue.poolValidatorHash,
    });
    const poolAssets = pruneZero({
      lovelace: lpAda,
      [tokenUnit]: curveDatum.lp_reserve_tokens,
      [poolNftUnit]: 1n,
      // The pool keeps everything the escrow does not: circulating liquidity
      // is `max_lq_cap` minus what the pool still holds, so the escrow's
      // position IS the liquidity and this remainder is the unissued rest.
      [lqUnit]: VENUE_MAX_LQ_CAP - venue.initialLq,
    });
    const poolDatum = openingPoolDatum(venue, {
      launchIdHex: this.config.launchIdHex,
      factoryPolicyId,
      tokenPolicyIdHex: curveDatum.token_policy_id,
      tokenAssetNameHex: curveDatum.token_asset_name,
      royaltyPubKeyHex: this.config.creatorRoyaltyPubKeyHex,
    });

    // ---- lp_escrow's own continuing output (SealLock) ----
    // The escrow's LOVELACE DOES NOT MOVE. `lp_value_received` compares the
    // sealed output's lovelace with the input's plus `seeded_ada`, and the
    // raise went into the pool, so `seeded_ada` is zero and the comparison is
    // an exact equality on a figure genesis already set. Nothing can top this
    // output up: an escrow whose genesis lovelace does not cover a three-asset
    // output is one that cannot be sealed, which is why the check below is
    // here rather than left to the node.
    const newLpAssets = pruneZero({ ...lpUtxo.assets, [lqUnit]: venue.initialLq });
    const newLpDatum: LpEscrowDatumData = {
      ...lpDatum,
      lock_timestamp: BigInt(lockSealTimestampMs),
      lp_state: 'Locked',
    };

    // Named rather than numbered — the comment that stood here recorded
    // Graduate as variant 9 while the code sent 8. `redeemer-indices.ts` is
    // held against the compiled blueprint by a test, so it cannot say that.
    const graduateRedeemer = new Constr(BONDING_CURVE_TIER_B_REDEEMER.Graduate, []);
    // `seeded_ada` is ZERO, and that is not an omission. It is what the seal
    // claims arrived in lovelace, and on this path nothing does — the whole
    // raise went into the pool, and the escrow's position is the LQ token.
    const sealLockRedeemer = new Constr(LP_ESCROW_REDEEMER.SealLock, [BigInt(lockSealTimestampMs), 0n]);

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
    // ORDER IS MEANING HERE. The curve's continuing output is 0; these follow
    // it. The factory's `Create` redeemer names the escrow and the pool by
    // these numbers, so appending to this list ahead of them silently
    // repoints the factory at the wrong outputs. `expectedOutputs` below is
    // what turns that from a silent repointing into a build failure.
    const ESCROW_OUT_IX = 1;
    const POOL_OUT_IX = 2;
    const payouts: GraduationSpendPlan['payouts'] = [
      {
        address: this.lpEscrowAddress,
        assets: newLpAssets,
        datumCbor: Data.to<LpEscrowDatumData>(newLpDatum, LpEscrowDatumSchema),
      },
      {
        address: poolAddress,
        assets: poolAssets,
        datumCbor: Data.to(poolDatum, VenuePoolConfigSchema),
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
        // Referenced when a pointer was published, carried otherwise. This
        // one is the swing vote on whether a staking graduation fits: the
        // curve, the escrow and the factory are all named, and the staking
        // validator carried is the only script left in the witness set.
        script: this.config.stakingPoolRef
          ? {
              compiledScriptCbor: this.config.stakingPoolScriptCbor,
              referenceScript: this.config.stakingPoolRef,
            }
          : { embeddedScriptCbor: this.config.stakingPoolScriptCbor },
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
      mint: {
        policyScriptCbor: this.config.venue.factoryScriptCbor,
        referenceScript: this.config.venue.factoryRef,
        redeemerCbor: Data.to(venueCreateRedeemer(this.config.launchIdHex, POOL_OUT_IX, ESCROW_OUT_IX)),
        assets: venueMintedAssets(this.config.launchIdHex),
      },
      // The two the factory names by number, identified by the asset that can
      // only be at one of them. Both are minted in this same transaction, so
      // neither could have come from anywhere else.
      expectedOutputs: [
        { index: ESCROW_OUT_IX, unit: lqUnit, quantity: venue.initialLq },
        { index: POOL_OUT_IX, unit: poolNftUnit, quantity: 1n },
      ],
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
      // The pool this graduation opened. Its own UTXO is `txHash#POOL_OUT_IX`
      // — reported rather than left to be searched for, because the pool NFT
      // is what every later venue transaction identifies it by.
      poolAddress,
      poolUtxoRef: `${txHash}#${POOL_OUT_IX}`,
      poolNftUnit,
      lqUnit,
      escrowedLq: venue.initialLq,
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
    poolAddress: string;
    poolUtxoRef: string;
    poolNftUnit: string;
    lqUnit: string;
    escrowedLq: bigint;
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
      poolAddress: step1.poolAddress,
      poolUtxoRef: step1.poolUtxoRef,
      poolNftUnit: step1.poolNftUnit,
      lqUnit: step1.lqUnit,
      escrowedLq: step1.escrowedLq,
    };
  }
}

export { loadValidator };
