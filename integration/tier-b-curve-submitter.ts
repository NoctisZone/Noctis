// ============================================================================
// Noctis Zone — Cardano Launch public bonding curve, real Lucid submitter
// ============================================================================
// bonding_curve_tier_b.ak's BuyTokens (and every other post-mint redeemer)
// is a custom-Plutus-redeemer spend — Anvil's REST API can't do this (this
// session's own finding, confirmed against the earlier Anvil research). Same category of
// gap as darkveil-claim-submitter.ts and tier-a-curve-submitter.ts
// (the linear curve's own Phase 4), both already fixed via Lucid Evolution. This is
// the identical treatment for Cardano Launch's public curve.
//
// Real differences from the linear curve's curve, verified directly against
// bonding_curve_tier_b.ak's real source before writing this (not assumed
// from the linear curve's shape):
//   - QUADRATIC pricing (P = P0 + k*x^2), not linear. Both tiers charge the
//     SUM of the prices of the tokens a trade moves through, so the shape of
//     the curve is the only difference: see gross_range in each validator,
//     and grossRangeQuadratic below, which must agree with it to the
//     lovelace.
//   - SellTokens is declared near the END of the redeemer type rather than
//     next to BuyTokens where it reads most naturally, so that adding it did
//     not renumber the variants already deployed above it.
//   - ClaimCreatorFees takes a SECOND `platform_claim_fee` arg — same real
//     value-conservation discipline as the linear curve's identical redeemer.
//
// **Redeemer indices are named, never written as numbers here.** They come
// from ./redeemer-indices.ts, which a test pins against the compiled
// blueprint. A comment recording an index is worth nothing: this file used to
// carry several, and they were wrong — a variant inserted mid-list renumbers
// everything after it while the off-chain code keeps compiling and starts
// sending a different redeemer entirely.
//
// **Every spend here goes through `executeSpend`.** This validator is over
// 15 KB, more than a transaction can carry alongside its own inputs and
// outputs, so a Cardano Launch curve spend has to NAME the published script rather
// than embed it. Routing every action through one place is what stops an
// action being added that quietly does not.
//
// Two signing shapes: the governor's actions and the creator's fee claim sign
// with a decrypted extended key, because the platform's wallet custody never
// stores a mnemonic; trades sign from a mnemonic (CLI) or a browser wallet.
// ============================================================================

import type {
  Assets,
  LucidEvolution,
  Network as LucidNetwork,
  SpendingValidator,
  UTxO,
  WalletApi,
} from '@lucid-evolution/lucid';
import { Blockfrost, Constr, Data, getAddressDetails, Lucid, toUnit, validatorToAddress } from '@lucid-evolution/lucid';
// Mesh, and the two modules below that build on it, belong to referenced
// mode: signing with a mnemonic or a stored private key, which is a
// server-side path by definition — refuseBrowserWalletWhenReferenced() turns
// a browser wallet away from it explicitly, and referencedParts() returns
// early unless a `referenceScript` pointer is configured, which no browser
// caller sets.
//
// The browser widget reaches this file through the DarkVeil claim flow, so
// the widget build resolves these three specifiers to an empty module rather
// than pulling Mesh's own node:crypto and node:stream into a bundle that
// cannot have them. See webpack.widgets.config.cjs's darkveil-widget alias
// block. Keep any new server-only dependency in that block too, or the
// widget build stops resolving.
import { BlockfrostProvider, MeshWallet } from '@meshsdk/core';
import { buildCapTradeFields, type CapAccumulator } from './cap-accumulator-tree.js';
import { setBit, testBit } from './claim-bitmap.js';
import {
  CREATOR_BPS,
  feeSlice,
  PLATFORM_BPS,
  buyCost as sharedBuyCost,
  sellProceeds as sharedSellProceeds,
  spotPrice,
} from './curve-pricing.js';
import { KeyCurveSpendWallet } from './key-curve-spend-wallet.js';
import { selectLaunchUtxo } from './launch-utxo-lookup.js';
import { type CurveNetwork, type CurveSpendWallet, MeshCurveSpender } from './mesh-curve-spend.js';
import { BONDING_CURVE_TIER_B_REDEEMER } from './redeemer-indices.js';
import { MESH_NETWORK_ID, type ReferenceScriptPointer } from './reference-script.js';
import { extendedHexToBech32PrivateKey, loadValidator } from './tier-a-curve-submitter.js';
import type { BondingCurveTierBDatumData } from './tier-a-schemas.js';
import { BondingCurveTierBDatumSchema, capProofToPlutus, settlementDatum } from './tier-a-schemas.js';

// Fix (2026-07-21): platform_claim_fee split — mirrors bonding_curve_tier_b.ak's
// platform_fee_ops_bps/platform_fee_treasury_bps/min_platform_claim_fee_lovelace
// exactly (ported from the linear curve's fix for parity).
const MIN_PLATFORM_CLAIM_FEE_LOVELACE = 200_000n;

// Pricing and the fee split are mirrors of bonding_curve_tier_b.ak's own
// arithmetic, kept in one place for both tiers and the history reader — see
// ./curve-pricing.ts for why that matters and how the formula works.
const SHAPE = 'quadratic' as const;

/** One fee slice of `gross`, floored. */
function floorFeeSlice(gross: bigint, bps: bigint): bigint {
  return feeSlice(gross, bps);
}

/** The spot price at a position — what the next single token costs. */
function curvePriceAtQuadratic(datum: BondingCurveTierBDatumData, sold: bigint): bigint {
  return spotPrice(SHAPE, datum, sold);
}

/** What a buyer pays for `amount` tokens starting at `fromSold`. */
function buyCostQuadratic(datum: BondingCurveTierBDatumData, fromSold: bigint, amount: bigint): bigint {
  return sharedBuyCost(SHAPE, datum, fromSold, amount);
}

/** What a seller receives — `fromSold` is the LOW edge of the vacated range. */
function sellProceedsQuadratic(datum: BondingCurveTierBDatumData, fromSold: bigint, amount: bigint): bigint {
  return sharedSellProceeds(SHAPE, datum, fromSold, amount);
}

function buyerKeyHashFromAddress(address: string): string {
  const details = getAddressDetails(address);
  const hash = details.paymentCredential?.hash;
  if (!hash) {
    throw new Error(`Could not derive a payment-credential key hash from address ${address}.`);
  }
  return hash;
}

/**
 * The DarkVeil claim window and the dead window after it are the LAUNCH's,
 * carried in its own datum as `dv_claim_window`/`dv_settlement_window`.
 *
 * These were constants here, mirroring constants in the validator. A mirror is
 * only correct until one side moves, and the client answering for the chain is
 * the failure that hides: the node's refusal names neither number. Reading the
 * datum removes the second copy rather than keeping it honest — there is now
 * one place a window is written and one place it is read.
 *
 * Public trading still cannot open until BOTH have elapsed, so DarkVeil
 * settlement is final before the first public trade rather than merely likely
 * to be; the validator bounds both values when OpenDvClaim starts the clock.
 */

/**
 * Half-width of a DarkVeil claim's validity range.
 *
 * The validator caps the range at 600,000 ms and binds the stamped time to it,
 * so a claim cannot widen its way into a window it missed. This leaves generous
 * room for clock skew well inside that cap.
 */
const DV_CLAIM_VALIDITY_SLACK_MS = 150_000;

/** One registrant's own private DarkVeil allocation, and the proof of it. */
export interface DarkVeilClaimParams {
  /** The buyer's allocation, from the governor's published tree. Revealed to
   *  nobody but the buyer until this claim is submitted. */
  dvAmount: bigint;
  salt: Uint8Array;
  /** Inclusion proof for this buyer's leaf under the anchored allocation root. */
  merkleProof: Array<{ sibling: Uint8Array; goesLeft: boolean }>;
  /** The buyer's payment key hash — hashed into their leaf, and required to sign. */
  buyerKeyHash: Uint8Array;
  /** This registrant's index in the allocation tree. It selects their bit in
   *  `claimed_bits` and is hashed into their leaf, so it cannot be aimed at
   *  anyone else's. */
  leafIndex: number;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Bytes needed to give every registrant their own bit in `claimed_bits`,
 * rounded up to a whole byte. The validator addresses bits by index, so the
 * map must cover the highest index the allocation tree can hand out.
 */
export function claimedBitsBytes(registrantCount: number): number {
  return Math.ceil(registrantCount / 8);
}

// ============================================================================
// SUBMITTER
// ============================================================================

/**
 * Lucid's network names against the lowercase ones Mesh's builder and slot
 * maths use. `Custom` has no Mesh equivalent — its slot configuration is
 * whatever the operator says it is — so it is refused rather than guessed at,
 * since a wrong slot config silently widens every validity range.
 */
const MESH_NETWORK_FOR_LUCID: Record<string, CurveNetwork> = {
  Preview: 'preview',
  Preprod: 'preprod',
  Mainnet: 'mainnet',
};

export interface LucidTierBCurveSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve_tier_b.ak's compiled PlutusV3 script CBOR — one shared,
   *  unparameterized script address across every Cardano Launch launch. */
  compiledScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
  /**
   * Where this validator is published as a reference script, if it is.
   *
   * Supplied, a trade NAMES the validator instead of carrying it. This curve
   * compiles to over 15 KB, so an embedded spend has almost none of the
   * 16,384-byte transaction cap left for the inputs, outputs and cap proof a
   * trade needs — and none at all for a batch. Omitted, everything behaves
   * exactly as before.
   *
   * The pointer is checked against the validator being spent, so one left
   * over from an earlier build fails here rather than at the node.
   */
  referenceScript?: ReferenceScriptPointer;
  /**
   * Execution budgets to declare instead of measuring — see
   * mesh-curve-spend.ts's own field for when that is the right call and what
   * it costs. Referenced mode only.
   */
  executionUnits?: { mem: number; steps: number };
}

/** Reading stays on Lucid; only the transaction is built the other way. */
interface ReferencedMode {
  spender: MeshCurveSpender;
  wallet: CurveSpendWallet;
}

/**
 * One curve spend, described once and executed either way.
 *
 * Deliberately not library-shaped: it is the arithmetic's own output — a
 * redeemer, the state that replaces the one being spent, and who gets paid.
 */
interface CurveSpendDescription {
  /** The redeemer, CBOR hex. */
  redeemerCbor: string;
  /** The continuing state, CBOR hex. */
  newDatumCbor: string;
  continuingAssets: Assets;
  /** Ordinary-address payouts. The settlement tag is added for all of them. */
  payouts: Array<{ address: string; assets: Assets }>;
  /** Whose signature the validator requires, if any. Omitted when permissionless. */
  signerAddress?: string;
  /** POSIX milliseconds. Both or neither. */
  validity?: { fromMs: number; toMs: number };
}

export class LucidTierBCurveSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;
  /** Set once a wallet is selected, and only when a reference script is configured. */
  private referenced?: ReferencedMode;

  constructor(private config: LucidTierBCurveSubmitterConfig) {
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

  /**
   * Whether trades will reference the published validator rather than embed it.
   *
   * Reading the launch's state stays on Lucid either way — the authenticated
   * lookup already lives there, and duplicating it would be a second place for
   * "which UTXO is this launch's" to be answered.
   */
  get referencesScript(): boolean {
    return this.config.referenceScript !== undefined;
  }

  /** The curve's own script address, derived from the compiled validator.
   *  Exposed because rebuilding the cap accumulator needs an address to read
   *  the launch's trade history from, and deriving it a second time at the
   *  call site would risk deriving a different one. */
  get curveAddress(): string {
    return this.scriptAddress;
  }

  /**
   * Refuses a signer the curve will not accept, before anything is built.
   *
   * The launch records which key each governor-only redeemer must be signed
   * by, and the validator checks its own datum rather than any address the
   * caller supplies. A mismatch therefore produces a script failure with no
   * useful detail — evaluation reports that the spend failed and names neither
   * the key it wanted nor the one it got. Reading the datum here costs nothing
   * and turns that into a sentence.
   */
  private requireSigner(expectedKeyHash: string, signerAddress: string, role: string): void {
    const actual = buyerKeyHashFromAddress(signerAddress);
    if (actual.toLowerCase() === expectedKeyHash.toLowerCase()) return;
    throw new Error(
      `This launch names ${expectedKeyHash} as its ${role}, but ${signerAddress} is ${actual}. ` +
        'The curve checks its own datum, so no signature from this address can satisfy it.',
    );
  }

  /**
   * Refuses a browser-wallet action while a reference pointer is configured.
   *
   * A CIP-30 wallet reaches this codebase as an object Mesh's builder is not
   * connected to — wiring that is the Launch Wizard's own task. Falling back to
   * the embedding path instead would be worse than refusing: on this tier the
   * validator alone is most of the transaction cap, so what it produces is not
   * a slower transaction but one that cannot be submitted at all.
   */
  private refuseBrowserWalletWhenReferenced(action: string): void {
    if (!this.referencesScript) return;
    throw new Error(
      `A browser-wallet ${action} cannot reference the published script yet — that connection is the ` +
        'Launch Wizard wallet task. Use the key or mnemonic path, or construct this submitter without ' +
        'a reference script to embed the validator instead.',
    );
  }

  /**
   * The spender and provider referenced mode needs, or nothing if this
   * submitter was built without a reference pointer.
   */
  private referencedParts(): { spender: MeshCurveSpender; provider: BlockfrostProvider; network: CurveNetwork } | null {
    const pointer = this.config.referenceScript;
    if (!pointer) return null;
    const network = MESH_NETWORK_FOR_LUCID[this.config.network];
    if (!network) {
      throw new Error(
        `Cannot reference a script on network "${this.config.network}": its slot configuration is not ` +
          'one of the known ones, and guessing it would silently widen every transaction validity range.',
      );
    }
    const provider = new BlockfrostProvider(this.config.blockfrostProjectId);
    return {
      network,
      provider,
      spender: new MeshCurveSpender({
        network,
        compiledScriptCbor: this.config.compiledScriptCbor,
        referenceScript: pointer,
        provider,
        ...(this.config.executionUnits ? { executionUnits: this.config.executionUnits } : {}),
      }),
    };
  }

  /**
   * Prepares referenced mode for a mnemonic-signed action — the trades.
   *
   * A browser wallet reaches this codebase as a CIP-30 object, and connecting
   * one to Mesh's builder is the Launch Wizard's own task rather than something
   * to approximate here, so that path stays on Lucid and is refused when a
   * reference pointer is configured.
   */
  private prepareReferencedFromMnemonic(mnemonic: string): void {
    const parts = this.referencedParts();
    if (!parts) return;
    this.referenced = {
      spender: parts.spender,
      wallet: new MeshWallet({
        networkId: MESH_NETWORK_ID[parts.network],
        fetcher: parts.provider,
        submitter: parts.provider,
        key: { type: 'mnemonic', words: mnemonic.trim().split(/\s+/) },
      }) as unknown as CurveSpendWallet,
    };
  }

  /**
   * Prepares referenced mode for a key-signed action — the governor's, and the
   * creator's fee claim.
   *
   * These never have a mnemonic to offer: the platform's wallet custody stores
   * an extended private key and decrypts it for one process. See
   * key-curve-spend-wallet.ts.
   */
  private async prepareReferencedFromKey(address: string, privateKeyExtendedHex: string): Promise<void> {
    const parts = this.referencedParts();
    if (!parts) return;
    this.referenced = {
      spender: parts.spender,
      wallet: await KeyCurveSpendWallet.forAddress({
        address,
        privateKeyExtendedHex,
        provider: parts.provider,
      }),
    };
  }

  /**
   * Executes one curve spend, either way.
   *
   * Both paths take the same description, which is the point: the pricing, the
   * fee split, the cap proof and the continuing datum are all settled before
   * this is called, so whether the validator is referenced or carried changes
   * nothing about what the transaction says.
   *
   * **Every payout is tagged here, not at the call sites.** The validator asks
   * for an output naming the spend it settles, so an untagged payout is not a
   * payout as far as the contract is concerned — making that structural means a
   * new redeemer cannot forget it.
   */
  private async executeSpend(
    lucid: LucidEvolution,
    curveUtxo: UTxO,
    spend: CurveSpendDescription,
    signing: { kind: 'wallet' } | { kind: 'key'; bech32: string },
  ): Promise<string> {
    const tag = settlementDatum(curveUtxo);

    if (this.referenced) {
      return this.referenced.spender.submit(
        {
          scriptUtxo: {
            txHash: curveUtxo.txHash,
            outputIndex: curveUtxo.outputIndex,
            address: this.scriptAddress,
            assets: curveUtxo.assets,
          },
          redeemerCbor: spend.redeemerCbor,
          continuing: { datumCbor: spend.newDatumCbor, assets: spend.continuingAssets },
          payouts: spend.payouts.map((p) => ({ address: p.address, assets: p.assets, datumCbor: tag })),
          requiredSignerHashes: spend.signerAddress ? [buyerKeyHashFromAddress(spend.signerAddress)] : [],
          ...(spend.validity ? { validity: spend.validity } : {}),
        },
        this.referenced.wallet,
      );
    }

    let builder = lucid
      .newTx()
      .collectFrom([curveUtxo], spend.redeemerCbor)
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(this.scriptAddress, { kind: 'inline', value: spend.newDatumCbor }, spend.continuingAssets);

    for (const payout of spend.payouts) {
      builder = builder.pay.ToAddressWithData(payout.address, { kind: 'inline', value: tag }, payout.assets);
    }
    if (spend.validity) {
      builder = builder.validFrom(spend.validity.fromMs).validTo(spend.validity.toMs);
    }
    if (spend.signerAddress) {
      builder = builder.addSigner(spend.signerAddress);
    }

    const tx = await builder.complete();
    const signed =
      signing.kind === 'key'
        ? await tx.sign.withPrivateKey(signing.bech32).complete()
        : await tx.sign.withWallet().complete();
    return signed.submit();
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

  /** Every Cardano Launch launch shares one script address, so a datum's `launch_id`
   *  is a claim rather than evidence — the launch's own thread NFT is what
   *  makes the UTXO the real one, and a second UTXO claiming the same launch
   *  has to stop the caller rather than be silently ignored. Both rules live
   *  in selectLaunchUtxo, which every other launch-scoped submitter reads
   *  its state through. */
  private async findCurveUtxo(lucid: LucidEvolution): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    const found = selectLaunchUtxo<BondingCurveTierBDatumData>(
      utxos,
      this.scriptAddress,
      this.config.launchIdHex,
      'bondingCurveTierB',
      BondingCurveTierBDatumSchema as never,
      this.config.threadNftPolicyId,
    );
    return found.utxo;
  }

  async readCurveDatum(): Promise<BondingCurveTierBDatumData> {
    const lucid = await this.lucidPromise;
    const utxo = await this.findCurveUtxo(lucid);
    return Data.from<BondingCurveTierBDatumData>(this.requireDatum(utxo), BondingCurveTierBDatumSchema);
  }

  // --------------------------------------------------------------------------
  // ActivateCurve — governor-signed. Same design as tier-a-curve-submitter.ts's
  // activateCurve() (see that file's class-level comment for the full
  // key-format/coin-selection reasoning) — constructor index 0, identical
  // between tiers.
  // --------------------------------------------------------------------------

  async activateCurve(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    currentTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(
      this.requireDatum(curveUtxo),
      BondingCurveTierBDatumSchema,
    );

    // A launch WITH a DarkVeil allocation opens Inactive -> DvClaim -> Active
    // and may not go public until the claim window and the dead window after
    // it have both elapsed. A launch WITHOUT one opens straight from Inactive.
    // Both shapes are enforced on chain; refusing here turns a rejection that
    // would arrive as an opaque script failure into a readable one.
    const hasDarkveil = currentDatum.dv_reserve_tokens > 0n;
    if (hasDarkveil) {
      if (currentDatum.curve_state !== 'DvClaim') {
        throw new Error(
          `A DarkVeil launch activates out of the claim window, not from ${currentDatum.curve_state}. ` +
            'Open the window with openDvClaim() first.',
        );
      }
      const opensAt =
        Number(currentDatum.dv_claim_opened_at) +
        Number(currentDatum.dv_claim_window) +
        Number(currentDatum.dv_settlement_window);
      if (currentTimestampMs < opensAt) {
        throw new Error(
          `The DarkVeil claim window has not finished settling: public trading opens at ${opensAt}, ` +
            `and it is ${currentTimestampMs}.`,
        );
      }
    } else if (currentDatum.curve_state !== 'Inactive') {
      throw new Error(`Curve is not Inactive (state: ${currentDatum.curve_state}) — cannot activate.`);
    }
    if (!currentDatum.dv_settled && hasDarkveil) {
      throw new Error('The DarkVeil allocation root has not been anchored — cannot open public trading.');
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);
    await this.prepareReferencedFromKey(governorAddress, governorPrivateKeyExtendedHex);

    const currentTimestamp = BigInt(currentTimestampMs);
    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      curve_state: 'Active',
      phase_started_at: currentTimestamp,
      // No claim can execute once Active, so the nullifier has served its
      // whole purpose. The validator requires it emptied here, which keeps the
      // datum every public trade carries free of claim state entirely.
      claimed_bits: '',
    };

    const realNowMs = Date.now();
    const txHash = await this.executeSpend(
      lucid,
      curveUtxo,
      {
        redeemerCbor: Data.to(new Constr(BONDING_CURVE_TIER_B_REDEEMER.ActivateCurve, [currentTimestamp])),
        newDatumCbor: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema),
        continuingAssets: curveUtxo.assets,
        payouts: [],
        signerAddress: governorAddress,
        validity: {
          fromMs: Math.min(currentTimestampMs, realNowMs) - 60_000,
          toMs: Math.max(currentTimestampMs, realNowMs) + 60_000,
        },
      },
      { kind: 'key', bech32: bech32Key },
    );
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // OpenDvClaim — governor-signed. Inactive -> DvClaim.
  //
  // Starts the 24-hour window in which DarkVeil registrants, and only they, can
  // settle their allocations. Public trading cannot begin until it and the dead
  // window after it have both elapsed, which is what keeps claims and trades
  // from competing for the curve at all.
  // --------------------------------------------------------------------------

  /**
   * @param registrantCount how many registrants the allocation tree holds. It
   *   sizes `claimed_bits`, so it must cover the highest `leaf_index` that tree
   *   can hand out — a map too small makes those registrants unable to claim.
   */
  async openDvClaim(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    registrantCount: number,
    currentTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(
      this.requireDatum(curveUtxo),
      BondingCurveTierBDatumSchema,
    );

    if (currentDatum.curve_state !== 'Inactive') {
      throw new Error(`The claim window opens out of Inactive, not ${currentDatum.curve_state}.`);
    }
    if (currentDatum.dv_reserve_tokens <= 0n) {
      throw new Error('This launch has no DarkVeil allocation, so there is nothing to claim.');
    }
    if (!currentDatum.dv_settled) {
      throw new Error(
        'The DarkVeil allocation root is not final yet. Anchor it before opening the window — ' +
          'it is what every claim proves against, and it cannot be changed afterwards.',
      );
    }
    if (!Number.isInteger(registrantCount) || registrantCount <= 0) {
      throw new Error(`registrantCount must be a positive whole number, got ${registrantCount}.`);
    }
    this.requireSigner(currentDatum.governor_pub_key_hash, governorAddress, 'governor');

    // Every bit clear. The validator checks this too: a window opened with a
    // bit already set would burn that registrant's claim before they made it.
    const claimedBits = '00'.repeat(claimedBitsBytes(registrantCount));

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);
    await this.prepareReferencedFromKey(governorAddress, governorPrivateKeyExtendedHex);

    const currentTimestamp = BigInt(currentTimestampMs);
    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      curve_state: 'DvClaim',
      dv_claim_opened_at: currentTimestamp,
      claimed_bits: claimedBits,
    };

    const realNowMs = Date.now();
    const txHash = await this.executeSpend(
      lucid,
      curveUtxo,
      {
        redeemerCbor: Data.to(new Constr(BONDING_CURVE_TIER_B_REDEEMER.OpenDvClaim, [claimedBits, currentTimestamp])),
        newDatumCbor: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema),
        continuingAssets: curveUtxo.assets,
        payouts: [],
        signerAddress: governorAddress,
        validity: {
          fromMs: Math.min(currentTimestampMs, realNowMs) - 60_000,
          toMs: Math.max(currentTimestampMs, realNowMs) + 60_000,
        },
      },
      { kind: 'key', bech32: bech32Key },
    );
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // AnchorDvAllocationRoot — governor-signed.
  // --------------------------------------------------------------------------

  /**
   * Fixes the root every DarkVeil claim will be proved against.
   *
   * Freely re-callable while the curve is still Inactive — the redeemer's own
   * gate — so a mistaken root can be corrected any number of times before
   * public trading opens, and not once after.
   */
  async anchorDvAllocationRoot(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    dvAllocationRootHex: string,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(
      this.requireDatum(curveUtxo),
      BondingCurveTierBDatumSchema,
    );

    if (currentDatum.curve_state !== 'Inactive') {
      throw new Error(
        `Curve is not Inactive (state: ${currentDatum.curve_state}) — cannot anchor dv_allocation_root anymore.`,
      );
    }
    this.requireSigner(currentDatum.governor_pub_key_hash, governorAddress, 'governor');

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);
    await this.prepareReferencedFromKey(governorAddress, governorPrivateKeyExtendedHex);

    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      dv_allocation_root: dvAllocationRootHex,
      dv_settled: true,
    };

    const txHash = await this.executeSpend(
      lucid,
      curveUtxo,
      {
        redeemerCbor: Data.to(new Constr(BONDING_CURVE_TIER_B_REDEEMER.AnchorDvAllocationRoot, [dvAllocationRootHex])),
        newDatumCbor: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema),
        continuingAssets: curveUtxo.assets,
        payouts: [],
        signerAddress: governorAddress,
      },
      { kind: 'key', bech32: bech32Key },
    );
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // ClaimDarkVeilTokens — buyer-signed. Settles one registrant's private
  // DarkVeil allocation: they pay the flat DarkVeil price in real ADA and
  // receive their tokens, revealing their own allocation and nobody else's.
  // --------------------------------------------------------------------------

  /** CLI path. A browser wallet uses {@link claimDarkVeilTokensWithWallet}. */
  async claimDarkVeilTokens(
    buyerMnemonic: string,
    params: DarkVeilClaimParams,
    capState: CapAccumulator,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(buyerMnemonic);
    const buyerAddress = await lucid.wallet().address();
    this.prepareReferencedFromMnemonic(buyerMnemonic);
    return this.claimDarkVeilTokensCore(lucid, buyerAddress, params, capState);
  }

  /** The buyer signs in their own wallet — they are paying, so they must. */
  async claimDarkVeilTokensWithWallet(
    walletApi: WalletApi,
    params: DarkVeilClaimParams,
    capState: CapAccumulator,
  ): Promise<{ txHash: string }> {
    this.refuseBrowserWalletWhenReferenced('DarkVeil claim');
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const buyerAddress = await lucid.wallet().address();
    return this.claimDarkVeilTokensCore(lucid, buyerAddress, params, capState);
  }

  private async claimDarkVeilTokensCore(
    lucid: LucidEvolution,
    buyerAddress: string,
    params: DarkVeilClaimParams,
    capState: CapAccumulator,
  ): Promise<{ txHash: string }> {
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(
      this.requireDatum(curveUtxo),
      BondingCurveTierBDatumSchema,
    );

    const buyerKeyHashHex = toHex(params.buyerKeyHash);
    const saltHex = toHex(params.salt);

    // Claims belong to the DarkVeil window and nowhere else. Before it, the
    // allocation root may still change; after it, the public curve is open and
    // the allocation has lapsed.
    if (currentDatum.curve_state !== 'DvClaim') {
      throw new Error(`Curve is not in the DarkVeil claim window (state: ${currentDatum.curve_state}) — cannot claim.`);
    }
    const claimDeadline = currentDatum.dv_claim_opened_at + currentDatum.dv_claim_window;
    if (BigInt(Date.now()) > claimDeadline) {
      throw new Error(`The DarkVeil claim window closed at ${new Date(Number(claimDeadline)).toISOString()}.`);
    }
    const bitCount = (currentDatum.claimed_bits.length / 2) * 8;
    if (!Number.isInteger(params.leafIndex) || params.leafIndex < 0 || params.leafIndex >= bitCount) {
      throw new Error(`leafIndex ${params.leafIndex} is out of range (0-${bitCount - 1}).`);
    }
    if (testBit(currentDatum.claimed_bits, params.leafIndex)) {
      throw new Error('This wallet has already claimed its DarkVeil allocation.');
    }
    if (buyerKeyHashHex === currentDatum.creator_pub_key_hash) {
      throw new Error('The creator cannot claim from their own launch.');
    }
    // The claim is signed by the buyer, and the validator asks for exactly the
    // key the leaf was built from — so an address that cannot produce it will
    // never satisfy the spend however it is signed.
    this.requireSigner(buyerKeyHashHex, buyerAddress, 'DarkVeil claimant');

    const remaining = currentDatum.curve_supply - currentDatum.tokens_sold;
    if (params.dvAmount <= 0n || params.dvAmount > remaining) {
      throw new Error(`dvAmount out of range (remaining: ${remaining}).`);
    }

    // Flat DarkVeil price (base_price) — NOT the quadratic public-phase
    // formula. That discount is what the phase offers.
    const grossPayment = params.dvAmount * currentDatum.base_price;
    const creatorFee = floorFeeSlice(grossPayment, CREATOR_BPS);
    const platformFee = floorFeeSlice(grossPayment, PLATFORM_BPS);
    const netPayment = grossPayment - creatorFee - platformFee;

    // The SAME accumulator the public curve uses, which is what makes "5%
    // across DarkVeil and the public phase combined" true rather than a
    // slogan: a claim spends the headroom a later public buy would have had.
    const cap = buildCapTradeFields(capState, currentDatum.cap_root, buyerKeyHashHex, params.dvAmount);
    if (cap.committedAfter > currentDatum.wallet_cap) {
      throw new Error(
        `Cumulative cap exceeded: ${cap.committedBefore} already taken + ${params.dvAmount} = ` +
          `${cap.committedAfter} > ${currentDatum.wallet_cap}.`,
      );
    }
    if (params.dvAmount > currentDatum.wallet_cap) {
      throw new Error(`Per-transaction cap exceeded: ${params.dvAmount} > ${currentDatum.wallet_cap}.`);
    }

    const newTokensSold = currentDatum.tokens_sold + params.dvAmount;
    // The phase cannot settle more than its own share of supply, whatever the
    // allocation root says.
    if (newTokensSold > currentDatum.dv_reserve_tokens) {
      throw new Error(
        `Claim would exceed the DarkVeil allocation (${newTokensSold} > ${currentDatum.dv_reserve_tokens}).`,
      );
    }

    // No Graduated transition here: graduation is the public curve's business,
    // and a claim is bounded by dv_reserve_tokens, which is strictly less than
    // curve_supply.
    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      tokens_sold: newTokensSold,
      total_raised: currentDatum.total_raised + netPayment,
      creator_fees_accrued: currentDatum.creator_fees_accrued + creatorFee,
      platform_fees_accrued: currentDatum.platform_fees_accrued + platformFee,
      claimed_bits: setBit(currentDatum.claimed_bits, params.leafIndex),
      cap_root: cap.nextRootHex,
    };

    // Field order matches ClaimDarkVeilTokens exactly. The TWO proofs prove
    // different things against different roots — `merkle_proof` the allocation
    // under dv_allocation_root, `cap_proof` the running total under cap_root.
    const nowMs = Date.now();
    const merkleProofConstr = params.merkleProof.map(
      (step) => new Constr(0, [toHex(step.sibling), new Constr(step.goesLeft ? 1 : 0, [])]),
    );
    const redeemer = new Constr(BONDING_CURVE_TIER_B_REDEEMER.ClaimDarkVeilTokens, [
      params.dvAmount,
      saltHex,
      merkleProofConstr,
      buyerKeyHashHex,
      BigInt(params.leafIndex),
      BigInt(nowMs),
      cap.committedBefore,
      capProofToPlutus(cap.proof),
    ]);

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) + grossPayment;
    continuingAssets[tokenUnit] = (continuingAssets[tokenUnit] ?? 0n) - params.dvAmount;

    const txHash = await this.executeSpend(
      lucid,
      curveUtxo,
      {
        redeemerCbor: Data.to(redeemer),
        newDatumCbor: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema),
        continuingAssets,
        payouts: [{ address: buyerAddress, assets: { [tokenUnit]: params.dvAmount } }],
        signerAddress: buyerAddress,
        // The validator binds the stamped time to this range and requires the
        // range itself to be narrow, so it cannot be widened to fake a time
        // inside the window.
        validity: { fromMs: nowMs - DV_CLAIM_VALIDITY_SLACK_MS, toMs: nowMs + DV_CLAIM_VALIDITY_SLACK_MS },
      },
      { kind: 'wallet' },
    );
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // Direct public trades.
  //
  // The curve does not settle one. A public trade reaches it as an ORDER,
  // applied against it in a batch by an allowlisted batcher, so both builders
  // below refuse rather than build.
  //
  // They refuse HERE rather than leaving it to the chain, because a
  // transaction that builds and then fails validation reports only "failed
  // script execution" — which names neither the cause nor what to do instead.
  //
  // The pricing, fee and datum construction that used to fill these methods
  // went with the validator arms they fed. Keeping any of it behind the throw
  // would have left a hundred lines reading as the live path when they were
  // not; the batch path computes those figures now.
  //
  // The methods are kept, rather than deleted, so a caller still finds the
  // name it was reaching for and is told where the path went.
  // --------------------------------------------------------------------------

  private static readonly DIRECT_TRADE_REFUSAL =
    'This curve does not settle direct public trades. Place an order with placeOrder() in ' +
    'order-submitter.ts; the batcher applies it against the curve. ClaimDarkVeilTokens and ' +
    'ClaimBuyback are separate paths and are unaffected.';

  async buyTokens(): Promise<never> {
    throw new Error(LucidTierBCurveSubmitter.DIRECT_TRADE_REFUSAL);
  }

  async buyTokensWithWallet(): Promise<never> {
    throw new Error(LucidTierBCurveSubmitter.DIRECT_TRADE_REFUSAL);
  }

  async sellTokens(): Promise<never> {
    throw new Error(LucidTierBCurveSubmitter.DIRECT_TRADE_REFUSAL);
  }

  async sellTokensWithWallet(): Promise<never> {
    throw new Error(LucidTierBCurveSubmitter.DIRECT_TRADE_REFUSAL);
  }

  // --------------------------------------------------------------------------
  // ClaimCreatorFees — creator-or-community-wallet-signed, constructor
  // index 3. Fix (2026-07-21): now takes a real platform_claim_fee paid
  // INTO the curve alongside `amount` paid out — see that redeemer's own
  // .ak comment for the full two-directional value-conservation check this
  // must satisfy.
  // --------------------------------------------------------------------------

  /**
   * CLI-driven verification path — signs with a decrypted extended key
   * (CML.PrivateKey.from_extended_bytes() + sign.withPrivateKey()), the
   * SAME pattern the linear curve's claimCreatorFees() (tier-a-claims-submitter.ts)
   * uses for its own policy-wallet-as-creator-stand-in — the platform
   * wallet custody scheme (anvil-client.php) only ever persists an
   * extended skey, never a mnemonic, so this is the only signing shape
   * that actually works against a real provisioned wallet, not a design
   * choice made for this file alone.
   *
   * `signerAddress` must be whichever address bonding_curve_tier_b.ak's
   * active_fee_recipient currently resolves to (creator_pub_key_hash, or
   * community_pub_key_hash once cto_triggered) — the contract itself
   * checks this via extra_signatories, this submitter doesn't re-derive it.
   */
  async claimCreatorFees(
    signerPrivateKeyExtendedHex: string,
    signerAddress: string,
    amount: bigint,
    platformClaimFeeLovelace: bigint = MIN_PLATFORM_CLAIM_FEE_LOVELACE,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(signerPrivateKeyExtendedHex);
    const signerUtxos = await lucid.utxosAt(signerAddress);
    lucid.selectWallet.fromAddress(signerAddress, signerUtxos);
    await this.prepareReferencedFromKey(signerAddress, signerPrivateKeyExtendedHex);

    const { curveUtxo, spend } = await this.claimCreatorFeesCore(
      lucid,
      signerAddress,
      amount,
      platformClaimFeeLovelace,
    );
    const txHash = await this.executeSpend(lucid, curveUtxo, spend, { kind: 'key', bech32: bech32Key });
    return { txHash };
  }

  /** Real production path — creator's own connected browser wallet. */
  async claimCreatorFeesWithWallet(
    walletApi: WalletApi,
    amount: bigint,
    platformClaimFeeLovelace: bigint = MIN_PLATFORM_CLAIM_FEE_LOVELACE,
  ): Promise<{ txHash: string }> {
    this.refuseBrowserWalletWhenReferenced('fee claim');
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const signerAddress = await lucid.wallet().address();

    const { curveUtxo, spend } = await this.claimCreatorFeesCore(
      lucid,
      signerAddress,
      amount,
      platformClaimFeeLovelace,
    );
    const txHash = await this.executeSpend(lucid, curveUtxo, spend, { kind: 'wallet' });
    return { txHash };
  }

  private async claimCreatorFeesCore(
    lucid: LucidEvolution,
    signerAddress: string,
    amount: bigint,
    platformClaimFeeLovelace: bigint,
  ): Promise<{ curveUtxo: UTxO; spend: CurveSpendDescription }> {
    if (platformClaimFeeLovelace < MIN_PLATFORM_CLAIM_FEE_LOVELACE) {
      throw new Error(
        `platform_claim_fee ${platformClaimFeeLovelace} is below the on-chain floor ${MIN_PLATFORM_CLAIM_FEE_LOVELACE}.`,
      );
    }

    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(
      this.requireDatum(curveUtxo),
      BondingCurveTierBDatumSchema,
    );

    if (amount > currentDatum.creator_fees_accrued) {
      throw new Error(`amount ${amount} exceeds creator_fees_accrued ${currentDatum.creator_fees_accrued}.`);
    }

    // No split: the platform runs one wallet, so the whole claim fee accrues
    // to the single platform line.
    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      creator_fees_accrued: currentDatum.creator_fees_accrued - amount,
      platform_fees_accrued: currentDatum.platform_fees_accrued + platformClaimFeeLovelace,
    };

    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) - amount + platformClaimFeeLovelace;

    return {
      curveUtxo,
      spend: {
        redeemerCbor: Data.to(
          new Constr(BONDING_CURVE_TIER_B_REDEEMER.ClaimCreatorFees, [amount, platformClaimFeeLovelace]),
        ),
        newDatumCbor: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema),
        continuingAssets,
        payouts: [{ address: signerAddress, assets: { lovelace: amount } }],
        signerAddress,
      },
    };
  }

  // --------------------------------------------------------------------------
  // ClaimTreasuryFees / ClaimOpsFees — governor-signed, indices 4/5. Fix
  // (2026-07-21): now require a real payout, same lovelace_paid_from_curve
  // check both use — this submitter builds it directly (single-direction,
  // simpler than ClaimCreatorFees' two-way check).
  // --------------------------------------------------------------------------

  private async claimGovernorFees(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    amount: bigint,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(
      this.requireDatum(curveUtxo),
      BondingCurveTierBDatumSchema,
    );

    if (amount > currentDatum.platform_fees_accrued) {
      throw new Error(`amount ${amount} exceeds platform_fees_accrued ${currentDatum.platform_fees_accrued}.`);
    }
    this.requireSigner(currentDatum.governor_pub_key_hash, governorAddress, 'governor');

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);
    await this.prepareReferencedFromKey(governorAddress, governorPrivateKeyExtendedHex);

    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      platform_fees_accrued: currentDatum.platform_fees_accrued - amount,
    };

    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) - amount;

    const txHash = await this.executeSpend(
      lucid,
      curveUtxo,
      {
        redeemerCbor: Data.to(new Constr(BONDING_CURVE_TIER_B_REDEEMER.ClaimPlatformFees, [amount])),
        newDatumCbor: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema),
        continuingAssets,
        payouts: [{ address: governorAddress, assets: { lovelace: amount } }],
        signerAddress: governorAddress,
      },
      { kind: 'key', bech32: bech32Key },
    );
    return { txHash };
  }

  /** One wallet, so one claim. Replaces the old treasury/ops pair. */
  async claimPlatformFees(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    amount: bigint,
  ): Promise<{ txHash: string }> {
    return this.claimGovernorFees(governorPrivateKeyExtendedHex, governorAddress, amount);
  }

  // --------------------------------------------------------------------------
  // ExpireCurve — permissionless, constructor index 7. Same
  // honest-"now" discipline as the linear curve's (see tier-a-curve-submitter.ts's
  // own method header for the full timing-bug lesson this avoids).
  // --------------------------------------------------------------------------

  async expireCurve(governorPrivateKeyExtendedHex: string, governorAddress: string): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(
      this.requireDatum(curveUtxo),
      BondingCurveTierBDatumSchema,
    );

    // Mirrors the validator's own set of expirable states — see the linear curve
    // submitter's expireCurve for the reasoning. DvClaim is deliberately not
    // among them on either side: ActivateCurve out of it is permissionless
    // once the windows pass, so it is not stranded and cancelling it would
    // take allocations registrants have already paid for.
    if (currentDatum.curve_state !== 'Active' && currentDatum.curve_state !== 'Inactive') {
      throw new Error(`Curve is ${currentDatum.curve_state} — only an Active or Inactive curve can be expired.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);
    await this.prepareReferencedFromKey(governorAddress, governorPrivateKeyExtendedHex);

    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      curve_state: 'Cancelled',
    };

    const currentTimestampMs = Date.now();
    const txHash = await this.executeSpend(
      lucid,
      curveUtxo,
      {
        redeemerCbor: Data.to(new Constr(BONDING_CURVE_TIER_B_REDEEMER.ExpireCurve, [BigInt(currentTimestampMs)])),
        newDatumCbor: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema),
        continuingAssets: curveUtxo.assets,
        payouts: [],
        // Permissionless: the elapsed deadline is the authorization, so no
        // signature is required of anyone.
        validity: { fromMs: currentTimestampMs - 240_000, toMs: currentTimestampMs + 240_000 },
      },
      { kind: 'key', bech32: bech32Key },
    );
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // ClaimBuyback — buyer-signed. Fix
  // (2026-07-22): buyback_share_paid now compares only the payment
  // credential, not the full address (contract-side fix) — pays the
  // buyer's own real wallet address directly below, same as every other
  // payout in this file.
  // --------------------------------------------------------------------------

  async claimBuyback(buyerMnemonic: string, tokenAmount: bigint): Promise<{ txHash: string; share: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(buyerMnemonic);
    const buyerAddress = await lucid.wallet().address();
    this.prepareReferencedFromMnemonic(buyerMnemonic);
    return this.claimBuybackCore(lucid, buyerAddress, tokenAmount);
  }

  async claimBuybackWithWallet(walletApi: WalletApi, tokenAmount: bigint): Promise<{ txHash: string; share: bigint }> {
    this.refuseBrowserWalletWhenReferenced('buyback claim');
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
    const currentDatum = Data.from<BondingCurveTierBDatumData>(
      this.requireDatum(curveUtxo),
      BondingCurveTierBDatumSchema,
    );

    if (currentDatum.curve_state !== 'Cancelled') {
      throw new Error(`Curve is not Cancelled (state: ${currentDatum.curve_state}) — cannot claim buyback.`);
    }
    if (tokenAmount <= 0n || tokenAmount > currentDatum.tokens_sold) {
      throw new Error(`token_amount out of range (tokens_sold: ${currentDatum.tokens_sold}).`);
    }

    const buyerKeyHashHex = buyerKeyHashFromAddress(buyerAddress);
    const effectiveTotalRaised = currentDatum.total_raised > 0n ? currentDatum.total_raised : 0n;
    const share = (effectiveTotalRaised * tokenAmount) / currentDatum.tokens_sold;

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      tokens_sold: currentDatum.tokens_sold - tokenAmount,
      total_raised: currentDatum.total_raised - share,
    };
    const newCurveAssets = {
      ...curveUtxo.assets,
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - share,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) + tokenAmount,
    };

    // Fix (2026-07-22): buyback_share_paid now compares only the
    // payment credential (contract-side fix), so the buyer's own real
    // wallet address works directly — no more deriving/paying to a bare
    // enterprise address as a workaround.
    const txHash = await this.executeSpend(
      lucid,
      curveUtxo,
      {
        redeemerCbor: Data.to(new Constr(BONDING_CURVE_TIER_B_REDEEMER.ClaimBuyback, [tokenAmount, buyerKeyHashHex])),
        newDatumCbor: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema),
        continuingAssets: newCurveAssets,
        payouts: [{ address: buyerAddress, assets: { lovelace: share } }],
        signerAddress: buyerAddress,
      },
      { kind: 'wallet' },
    );
    return { txHash, share };
  }
}

export { buyCostQuadratic, curvePriceAtQuadratic, floorFeeSlice, loadValidator, sellProceedsQuadratic };
