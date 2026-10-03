// ============================================================================
// Noctis Zone — placing and cancelling a curve order
// ============================================================================
// A launch's curve is ONE UTXO, so trades against it serialise at one per
// block. An order is its own UTXO holding the funds to be spent, which any
// number of users can create in the same block; a batcher then touches the
// curve once and fills many of them together.
//
// Three operations, and only the first is not a script spend:
//
//   place   a payment to the order address. Creating a UTXO at a script
//           address never runs its validator, so this is an ordinary payment
//           and needs no redeemer, no collateral and no reference script.
//   cancel  the owner signs and takes their funds back, at any time and
//           without anyone's cooperation.
//   sweep   once the deadline has passed, ANYONE may return the funds — to
//           the owner, never to the caller.
//
// The last two are what make this non-custodial. A batcher that stalls,
// censors or turns hostile costs an owner time and never funds, because both
// exits are available without it. Nothing here needs the batcher's agreement.
//
// **Both refunds carry a settlement tag.** An owner may hold several orders,
// and cancelling two together is two refunds — an output identified by
// recipient and amount alone cannot tell them apart, and one payment would
// stand for both. The tag is the order's own reference, which is unique by
// construction.
//
// **An order names two bounds, and both are the owner's protection.**
// `minReceived` is the least that may arrive; `maxSpend` is the most of the
// order's own funds that may leave. The validator cannot compute a price —
// the curve does that — so without the second bound a fill could pay the
// curve correctly and keep the difference. `maxSpend` is also where a batcher
// is paid from, which is why that fee is a ceiling rather than a rate:
// whatever the batcher does not take goes back to the owner.

import type { Assets, LucidEvolution, Network as LucidNetwork, UTxO, WalletApi } from '@lucid-evolution/lucid';
import {
  Blockfrost,
  Constr,
  credentialToAddress,
  Data,
  getAddressDetails,
  Lucid,
  toUnit,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import type { OrderDatumData } from './launch-schemas.js';
import { OrderDatumSchema, settlementDatum } from './launch-schemas.js';
import { CURVE_ORDER_REDEEMER } from './redeemer-indices.js';

/**
 * `curve_order.ak`'s `OrderRedeemer`, by name.
 *
 * Re-exported under these names because callers already import them; the
 * numbers themselves come from `redeemer-indices.ts`, whose table a test holds
 * against the compiled blueprint.
 */
const REDEEMER_APPLY_ORDER = CURVE_ORDER_REDEEMER.ApplyOrder;
const REDEEMER_CANCEL_BY_OWNER = CURVE_ORDER_REDEEMER.CancelOrderByOwner;
const REDEEMER_CANCEL_EXPIRED = CURVE_ORDER_REDEEMER.CancelExpiredOrder;

/**
 * Half-width of the validity range a sweep declares, in ms.
 *
 * The validator binds `current_timestamp` inside the range AND caps the range's
 * width, so a caller cannot widen it far enough to invent a time past a
 * deadline that has not arrived. Well inside `max_validity_range_width`.
 */
const SWEEP_VALIDITY_SLACK_MS = 150_000;

export interface OrderSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** `curve_order.ak`'s compiled PlutusV3 script CBOR. One address, every launch. */
  compiledScriptCbor: string;
  /** The curve validator this launch's orders may be applied against. */
  curveScriptCbor: string;
}

/** What an owner decides when placing an order. */
export interface PlaceOrderParams {
  /** Filled in from the owner's own address; callers do not supply it. */
  ownerStake?: OwnerStake;
  launchIdHex: string;
  /** True buys tokens with lovelace; false sells tokens for lovelace. */
  isBuy: boolean;
  /** Tokens to buy, or tokens to sell. */
  amount: bigint;
  /** Least that may arrive: tokens for a buy, lovelace for a sell. */
  minReceived: bigint;
  /**
   * Most of the order's own funds that may leave it: lovelace for a buy,
   * tokens for a sell. Must not exceed what the order is funded with.
   */
  maxSpend: bigint;
  /** Posix ms. After this anyone may sweep the order back to the owner. */
  deadlineMs: bigint;
  tokenPolicyId: string;
  tokenAssetName: string;
  /**
   * Lovelace the order holds. A buy funds its purchase from this, so it must
   * cover `maxSpend` and the minimum ada an output needs. A sell still needs
   * enough for its own minimum ada.
   */
  lovelace: bigint;
}

export interface PlacedOrder {
  txHash: string;
  /** Where the order will live once the transaction is confirmed. */
  orderAddress: string;
  datumCbor: string;
}

function keyHashOf(address: string): string {
  const hash = getAddressDetails(address).paymentCredential?.hash;
  if (!hash) throw new Error(`Could not derive a payment key hash from address ${address}.`);
  return hash;
}

/** A Plutus `Option<Credential>` for whatever staking part an address has. */
export type OwnerStake = { PubKeyCredential: [string] } | { ScriptCredential: [string] } | null;

/**
 * The staking part of the address an order was placed from.
 *
 * Recorded so a payout can be sent back to that same address. Without it the
 * only address derivable from the datum is the bare enterprise one, which an
 * ordinary seed-phrase wallet never derives and therefore never sees — the
 * tokens arrive, belong to the owner, and no normal wallet can spend them.
 */
export function stakeOf(address: string): OwnerStake {
  const cred = getAddressDetails(address).stakeCredential;
  if (!cred) return null;
  return cred.type === 'Key' ? { PubKeyCredential: [cred.hash] } : { ScriptCredential: [cred.hash] };
}

export class OrderSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: { type: 'PlutusV3'; script: string };
  /** One shared address for every launch's orders — this validator takes no parameters. */
  readonly orderAddress: string;
  /** The curve address orders on this tier may be applied against. */
  readonly curveAddress: string;
  /** That curve's script hash, which is what the order datum records. */
  readonly curveScriptHash: string;

  constructor(private config: OrderSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.orderAddress = validatorToAddress(config.network, this.validator);
    this.curveAddress = validatorToAddress(config.network, { type: 'PlutusV3', script: config.curveScriptCbor });
    const curveHash = getAddressDetails(this.curveAddress).paymentCredential?.hash;
    if (!curveHash) throw new Error('Could not derive the curve script hash from its address.');
    this.curveScriptHash = curveHash;
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
  }

  /** The datum an order carries, given who owns it. */
  buildDatum(params: PlaceOrderParams, ownerKeyHashHex: string): OrderDatumData {
    if (params.amount <= 0n) throw new Error('An order must be for a positive amount.');
    if (params.minReceived < 0n) throw new Error('minReceived cannot be negative.');
    if (params.maxSpend < 0n) throw new Error('maxSpend cannot be negative.');
    if (params.isBuy && params.maxSpend > params.lovelace) {
      throw new Error(
        `A buy order may spend at most what it holds: maxSpend ${params.maxSpend} exceeds the ` +
          `${params.lovelace} lovelace being locked. Fund the order with more, or lower maxSpend.`,
      );
    }
    if (!params.isBuy && params.maxSpend > params.amount) {
      throw new Error(
        `A sell order holds ${params.amount} tokens, so it cannot be allowed to spend ${params.maxSpend}.`,
      );
    }
    return {
      owner: ownerKeyHashHex,
      owner_stake: params.ownerStake ?? null,
      launch_id: params.launchIdHex,
      // The curve is a script, so this is its script hash. `ApplyOrder`
      // matches it against a real input's credential, which is what forces the
      // curve validator to run — and therefore price the fill — in the same
      // transaction.
      curve_credential: { ScriptCredential: [this.curveScriptHash] },
      is_buy: params.isBuy,
      amount: params.amount,
      min_received: params.minReceived,
      max_spend: params.maxSpend,
      deadline: params.deadlineMs,
      token_policy_id: params.tokenPolicyId,
      token_asset_name: params.tokenAssetName,
    };
  }

  /** What the order UTXO must hold: lovelace for a buy, the tokens for a sell. */
  private fundsFor(params: PlaceOrderParams): Assets {
    const assets: Assets = { lovelace: params.lovelace };
    if (!params.isBuy) {
      assets[toUnit(params.tokenPolicyId, params.tokenAssetName)] = params.amount;
    }
    return assets;
  }

  /**
   * Creates the order.
   *
   * Paying to a script address never runs that script, so this is an ordinary
   * payment — which is exactly why orders do not contend: any number can be
   * created in one block.
   */
  async placeOrder(ownerMnemonic: string, params: PlaceOrderParams): Promise<PlacedOrder> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(ownerMnemonic);
    return this.placeOrderCore(lucid, params);
  }

  async placeOrderWithWallet(walletApi: WalletApi, params: PlaceOrderParams): Promise<PlacedOrder> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    return this.placeOrderCore(lucid, params);
  }

  private async placeOrderCore(lucid: LucidEvolution, params: PlaceOrderParams): Promise<PlacedOrder> {
    const ownerAddress = await lucid.wallet().address();
    const datum = this.buildDatum({ ...params, ownerStake: stakeOf(ownerAddress) }, keyHashOf(ownerAddress));
    const datumCbor = Data.to<OrderDatumData>(datum, OrderDatumSchema);

    const tx = await lucid
      .newTx()
      .pay.ToContract(this.orderAddress, { kind: 'inline', value: datumCbor }, this.fundsFor(params))
      .complete();

    const signed = await tx.sign.withWallet().complete();
    return { txHash: await signed.submit(), orderAddress: this.orderAddress, datumCbor };
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  /** Every order at the shared address belonging to one launch. */
  async openOrders(launchIdHex: string): Promise<Array<{ utxo: UTxO; datum: OrderDatumData }>> {
    const lucid = await this.lucidPromise;
    const utxos = await lucid.utxosAt(this.orderAddress);
    const found: Array<{ utxo: UTxO; datum: OrderDatumData }> = [];
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let datum: OrderDatumData;
      try {
        datum = Data.from<OrderDatumData>(utxo.datum, OrderDatumSchema);
      } catch {
        continue; // someone else's UTXO at a shared address
      }
      if (datum.launch_id !== launchIdHex) continue;
      found.push({ utxo, datum });
    }
    return found;
  }

  // --------------------------------------------------------------------------
  // Cancelling
  // --------------------------------------------------------------------------

  /**
   * What a cancel must return, read from the UTXO rather than its datum.
   *
   * The validator does the same: a datum that understated what the order held
   * would otherwise shrink the refund it is checked against.
   */
  private refundFor(utxo: UTxO): Assets {
    return { ...utxo.assets };
  }

  /** The owner takes their funds back. No deadline, nobody else's cooperation. */
  async cancelOrder(ownerMnemonic: string, orderUtxo: UTxO): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(ownerMnemonic);
    return this.cancelCore(lucid, orderUtxo);
  }

  async cancelOrderWithWallet(walletApi: WalletApi, orderUtxo: UTxO): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    return this.cancelCore(lucid, orderUtxo);
  }

  private async cancelCore(lucid: LucidEvolution, orderUtxo: UTxO): Promise<{ txHash: string }> {
    const ownerAddress = await lucid.wallet().address();
    const datum = this.decodeOrder(orderUtxo);
    if (datum.owner !== keyHashOf(ownerAddress)) {
      throw new Error(
        `This order belongs to ${datum.owner}, not to the connected wallet. Only its owner may cancel ` +
          'it early; anyone may sweep it once its deadline has passed.',
      );
    }

    const tx = await lucid
      .newTx()
      .collectFrom([orderUtxo], Data.to(new Constr(REDEEMER_CANCEL_BY_OWNER, [])))
      .attach.SpendingValidator(this.validator)
      // The refund NAMES the order it settles. Two of one owner's orders
      // cancelled together are two refunds, and an untagged output would let
      // one stand for both.
      .pay.ToAddressWithData(
        ownerAddress,
        { kind: 'inline', value: settlementDatum(orderUtxo) },
        this.refundFor(orderUtxo),
      )
      .addSigner(ownerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    return { txHash: await signed.submit() };
  }

  /**
   * Returns an expired order's funds TO ITS OWNER. Permissionless.
   *
   * The caller gains nothing by doing it — the funds go to the owner either
   * way — which is what makes it safe to leave open to anyone, and what turns
   * a stalled batcher into a delay rather than a loss.
   */
  async sweepExpiredOrder(
    callerMnemonic: string,
    orderUtxo: UTxO,
    nowMs: number = Date.now(),
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(callerMnemonic);
    const datum = this.decodeOrder(orderUtxo);

    if (BigInt(nowMs) <= datum.deadline) {
      throw new Error(
        `This order does not expire until ${datum.deadline}; it is ${nowMs}. Until then only its owner ` +
          'may take the funds back.',
      );
    }

    const ownerAddress = ownerAddressFrom(datum.owner, this.config.network, datum.owner_stake);

    const tx = await lucid
      .newTx()
      .collectFrom([orderUtxo], Data.to(new Constr(REDEEMER_CANCEL_EXPIRED, [BigInt(nowMs)])))
      .attach.SpendingValidator(this.validator)
      .pay.ToAddressWithData(
        ownerAddress,
        { kind: 'inline', value: settlementDatum(orderUtxo) },
        this.refundFor(orderUtxo),
      )
      // The validator binds `current_timestamp` inside this range and caps its
      // width, so a caller cannot widen it to reach a deadline that has not
      // arrived. Built from a real clock, never from a caller-supplied figure.
      .validFrom(nowMs - SWEEP_VALIDITY_SLACK_MS)
      .validTo(nowMs + SWEEP_VALIDITY_SLACK_MS)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    return { txHash: await signed.submit() };
  }

  private decodeOrder(utxo: UTxO): OrderDatumData {
    if (!utxo.datum) {
      throw new Error(`Order UTXO ${utxo.txHash}#${utxo.outputIndex} carries no inline datum.`);
    }
    return Data.from<OrderDatumData>(utxo.datum, OrderDatumSchema);
  }
}

/**
 * The owner's address, from the key hash their order records.
 *
 * The address the order was placed from, rebuilt from what the datum records.
 *
 * Both parts matter. A key hash alone yields the bare ENTERPRISE address, and
 * an ordinary wallet derived from a seed phrase uses its BASE address — so a
 * payout sent to the enterprise one belongs to the owner and cannot be spent
 * by their wallet. The validator now requires the exact address, which also
 * stops a batcher attaching a staking credential of its own and collecting
 * the delegation on funds it is passing through.
 */
export function ownerAddressFrom(ownerKeyHashHex: string, network: LucidNetwork, ownerStake?: OwnerStake): string {
  const payment = { type: 'Key' as const, hash: ownerKeyHashHex };
  if (!ownerStake) return credentialToAddress(network, payment);
  const [hash] = 'PubKeyCredential' in ownerStake ? ownerStake.PubKeyCredential : ownerStake.ScriptCredential;
  return credentialToAddress(network, payment, {
    type: 'PubKeyCredential' in ownerStake ? 'Key' : 'Script',
    hash,
  });
}

export { REDEEMER_APPLY_ORDER, REDEEMER_CANCEL_BY_OWNER, REDEEMER_CANCEL_EXPIRED, SWEEP_VALIDITY_SLACK_MS };
