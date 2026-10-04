// ============================================================================
// Noctis Zone — turning a plan into a batch transaction
// ============================================================================
// One transaction spends the curve once and N order UTXOs alongside it. That
// is the whole reason orders exist: a launch's curve is a single UTXO, so
// direct trades against it serialise at one per block, while any number of
// orders can be created in the same block and filled together afterwards.
//
// The shape, and every part of it is checked on chain:
//
//   inputs    the curve (BatchTrades) + one per order (ApplyOrder)
//   withdraw  zero from the order validator's reward address, which runs its
//             check over every order at once; each order's spend asks for it
//   outputs   the curve's continuing state, then ONE per order: the fill and
//             the change that order did not spend, together, NAMING the order
//             it settles
//   signer    the batcher, whose key the curve datum's redeemer names
//
// **Every payout carries the order's own reference as its datum.** One owner
// may hold several orders in a batch and is owed for each; owner and amount
// are exactly what two of their orders have in common, so an untagged output
// would let one payment answer both. Both validators read that same tag, which
// is what keeps them agreeing about which output is which fill.
//
// **The batcher is paid out of what an order allows itself to spend, and no
// more.** An order names `max_spend`; whatever the curve does not take and the
// batcher does not claim goes back to the owner, and the order validator
// refuses the transaction if it does not. So the fee is a ceiling the owner
// sets rather than a rate the batcher charges — and a batcher that tries to
// take more simply builds a transaction that fails.
//
// **Nothing here decides economics.** `batch-planner.ts` decides what can be
// filled and what each party is owed; this module only builds the transaction
// that says so.

import type { Assets, LucidEvolution, Network as LucidNetwork, UTxO } from '@lucid-evolution/lucid';
import { Constr, Data, getAddressDetails, Lucid, toUnit, validatorToAddress } from '@lucid-evolution/lucid';
import { MeshWallet } from '@meshsdk/core';
import type { BatchPlan, PlannedFill } from './batch-planner.js';
import { cardanoProvider } from './cardano-provider.js';
import { KeyCurveSpendWallet } from './key-curve-spend-wallet.js';
import type { BondingCurveTierBDatumData } from './launch-schemas.js';
import { BondingCurveTierBDatumSchema, batchOrderToPlutus, settlementDatum } from './launch-schemas.js';
import { meshCardanoProvider } from './mesh-cardano-provider.js';
import { type CurveBatchPlan, type CurveNetwork, type CurveSpendWallet, MeshCurveSpender } from './mesh-curve-spend.js';
import { ownerAddressFrom } from './order-submitter.js';
import { BONDING_CURVE_TIER_B_REDEEMER, CURVE_ORDER_REDEEMER } from './redeemer-indices.js';
import { MESH_NETWORK_ID, type ReferenceScriptPointer } from './reference-script.js';

/**
 * `BatchTrades`' constructor index on the Cardano Launch curve.
 *
 * Taken by NAME from `redeemer-indices.ts`, whose table a test holds against
 * the compiled blueprint, never assumed from the order the `.ak` source reads
 * in. A redeemer built at the wrong index does not fail with a message about
 * indices: it decodes as some other redeemer entirely, and the error is about
 * whatever that one checks.
 */
const REDEEMER_BATCH_TRADES: Record<BatchTier, number> = {
  B: BONDING_CURVE_TIER_B_REDEEMER.BatchTrades,
};

/** `ApplyOrder`'s constructor index on `curve_order`. */
const REDEEMER_APPLY_ORDER = CURVE_ORDER_REDEEMER.ApplyOrder;

/** The curve a batch fills: the Cardano Launch curve, the only one there is since the linear path retired. */
export type BatchTier = 'B';

export interface BatcherSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  tier: BatchTier;
  /** The curve validator for this tier. */
  curveScriptCbor: string;
  /** `curve_order.ak`'s compiled script. One address, every launch. */
  orderScriptCbor: string;
  /**
   * Where this tier's curve validator is published.
   *
   * REQUIRED, unlike a single trade's. A batch carries N cap proofs on top of
   * the curve's own datum and the orders' inputs and outputs; with the curve
   * embedded, a two-order the linear curve batch measured 17,991 bytes against a 16,384
   * cap. A spend cannot be split across transactions, so there is no
   * arrangement that fits — the curve has to be named rather than carried.
   */
  curveReferenceScript: ReferenceScriptPointer;
  /**
   * Where `curve_order.ak` is published. Optional, unlike the curve's: without
   * it the order validator is carried in the transaction, which fits one order
   * fewer (MAX_ORDERS_PER_BATCH_CARRIED against MAX_ORDERS_PER_BATCH).
   */
  orderReferenceScript?: ReferenceScriptPointer;
}

export interface SubmitBatchParams {
  /** The launch's curve UTXO, as read by the caller. */
  curveUtxo: UTxO;
  /** The order UTXOs, keyed the way the plan refers to them. */
  orderUtxos: readonly UTxO[];
  plan: BatchPlan;
  /**
   * Lovelace the batcher keeps from each filled order, as its fee.
   *
   * Taken from a buy only, and never more than the curve left of the order's
   * own `max_spend`: the order validator wants everything above `max_spend`
   * back, so that is all the batcher may touch. Zero is valid and means the
   * batcher works for nothing but the curve's throughput.
   */
  batcherFeeLovelace?: bigint;
}

export interface BatchResult {
  txHash: string;
  ordersFilled: number;
  /** What the batcher kept in total, across every fill. */
  batcherFeeTotal: bigint;
}

/**
 * Everything one order is owed, in ONE output: the fill and its change.
 *
 * Both validators add up what the outputs tagged with the order carry to its
 * owner, so one output answers exactly as two did. Two things follow from
 * it being one. The owner's own change pays the output's minimum ada, where a
 * tokens-only output had the batcher add that from its own wallet on every
 * buy. And every fill costs one output fewer, which is memory every validator
 * in the batch spends folding over the outputs.
 *
 * `kept` is what the batcher takes from a buy's change; see submitBatchCore.
 */
function orderPayout(fill: PlannedFill, tokenUnit: string, kept: bigint): Assets {
  if (fill.order.isBuy) {
    // A buy is delivered tokens, with the lovelace it did not spend.
    const back = fill.change - kept;
    return back > 0n ? { [tokenUnit]: fill.received, lovelace: back } : { [tokenUnit]: fill.received };
  }
  // A sell is paid its proceeds and the lovelace its own UTXO held — the
  // deposit that carried the tokens. That deposit is the seller's and is not
  // proceeds: curve_order counts only what arrives above it toward the
  // seller's minimum. With them, any tokens it did not sell.
  const paid = fill.received + fill.order.heldLovelace;
  return fill.change > 0n ? { lovelace: paid, [tokenUnit]: fill.change } : { lovelace: paid };
}

/**
 * Lucid's network names against the lowercase ones Mesh uses. `Custom` has no
 * Mesh equivalent, so it is refused rather than guessed at — a wrong slot
 * configuration silently widens every validity range.
 */
const MESH_NETWORK_FOR_LUCID: Record<string, CurveNetwork> = {
  Preview: 'preview',
  Preprod: 'preprod',
  Mainnet: 'mainnet',
};

export class BatcherSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  readonly curveAddress: string;
  readonly orderAddress: string;
  /** Builds the transaction with the curve referenced rather than carried. */
  private spender: MeshCurveSpender;

  constructor(private config: BatcherSubmitterConfig) {
    this.curveAddress = validatorToAddress(config.network, { type: 'PlutusV3', script: config.curveScriptCbor });
    this.orderAddress = validatorToAddress(config.network, { type: 'PlutusV3', script: config.orderScriptCbor });
    // Reading stays on Lucid: the authenticated launch lookup already lives
    // there and a second answer to "which UTXO is this launch's" is not worth
    // having.
    this.lucidPromise = Lucid(cardanoProvider(config), config.network);
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});

    const network = MESH_NETWORK_FOR_LUCID[config.network];
    if (!network) {
      throw new Error(
        `Cannot batch on network "${config.network}": its slot configuration is not one of the known ` +
          'ones, and guessing it would silently widen every transaction validity range.',
      );
    }
    // Resolved here, so a pointer left over from an earlier build of the
    // validator fails at construction rather than at submission.
    this.spender = new MeshCurveSpender({
      network,
      compiledScriptCbor: config.curveScriptCbor,
      referenceScript: config.curveReferenceScript,
      provider: meshCardanoProvider(config.blockfrostProjectId),
    });
  }

  /**
   * Builds and submits the batch a plan describes.
   *
   * The plan is taken as given — it was produced against the same curve datum
   * this transaction spends, and re-deriving it here would only introduce a
   * second opinion. What this checks is that the plan and the UTXOs handed in
   * actually correspond, because a mismatch there produces a transaction that
   * fails for reasons naming neither.
   */
  async submitBatch(batcherMnemonic: string, params: SubmitBatchParams): Promise<BatchResult> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(batcherMnemonic);
    const batcherAddress = await lucid.wallet().address();
    return this.submitBatchCore(batcherAddress, this.meshWallet(batcherMnemonic), params);
  }

  /**
   * The same batch, signed from an extended private key instead of a mnemonic.
   *
   * The platform's wallet custody never persists a mnemonic — a role stores an
   * encrypted extended key and decrypts it for one process (see
   * key-curve-spend-wallet.ts) — so the scheduled batcher signs this way.
   * forAddress refuses a key that does not sign for the address, which turns a
   * mispaired config into a readable error instead of a rejected transaction.
   */
  async submitBatchWithKey(
    batcherPrivateKeyExtendedHex: string,
    batcherAddress: string,
    params: SubmitBatchParams,
  ): Promise<BatchResult> {
    const wallet = await KeyCurveSpendWallet.forAddress({
      address: batcherAddress,
      privateKeyExtendedHex: batcherPrivateKeyExtendedHex,
      provider: meshCardanoProvider(this.config.blockfrostProjectId),
    });
    return this.submitBatchCore(batcherAddress, wallet, params);
  }

  private async submitBatchCore(
    batcherAddress: string,
    batcherWallet: CurveSpendWallet,
    params: SubmitBatchParams,
  ): Promise<BatchResult> {
    const { plan, batcherFeeTotal } = batchTransactionPlan({
      tier: this.config.tier,
      network: this.config.network,
      curveAddress: this.curveAddress,
      orderAddress: this.orderAddress,
      orderScriptCbor: this.config.orderScriptCbor,
      ...(this.config.orderReferenceScript ? { orderReferenceScript: this.config.orderReferenceScript } : {}),
      batcherKeyHash: keyHashOf(batcherAddress),
      params,
    });
    const txHash = await this.spender.submitBatch(plan, batcherWallet);
    return { txHash, ordersFilled: params.plan.fills.length, batcherFeeTotal };
  }

  /** The batcher's own wallet, in the shape the referenced builder takes. */
  private meshWallet(mnemonic: string): CurveSpendWallet {
    const network = MESH_NETWORK_FOR_LUCID[this.config.network];
    if (!network) {
      throw new Error(
        `Cannot batch on network "${this.config.network}": its slot configuration is not one of the ` +
          'known ones, and guessing it would silently widen every transaction validity range.',
      );
    }
    const provider = meshCardanoProvider(this.config.blockfrostProjectId);
    return new MeshWallet({
      networkId: MESH_NETWORK_ID[network],
      fetcher: provider,
      submitter: provider,
      key: { type: 'mnemonic', words: mnemonic.trim().split(/\s+/) },
    }) as unknown as CurveSpendWallet;
  }
}

/** What a batch transaction is assembled from. */
export interface BatchTransactionInputs {
  tier: BatchTier;
  network: LucidNetwork;
  curveAddress: string;
  orderAddress: string;
  /** `curve_order.ak`'s compiled script, for the spends and the withdrawal. */
  orderScriptCbor: string;
  /** Where that script is published; carried when absent. */
  orderReferenceScript?: ReferenceScriptPointer;
  /** The batcher's payment key hash, which the redeemer names and the curve requires. */
  batcherKeyHash: string;
  params: SubmitBatchParams;
}

/**
 * The transaction a plan describes, decided without touching the chain: which
 * UTXOs it spends under which redeemers, what each owner is paid and how the
 * curve moves. Kept apart from the submitter so a test can hand it to the real
 * validators exactly as a batch would.
 *
 * The plan is taken as given — it was produced against the same curve datum
 * this transaction spends, and re-deriving it here would only introduce a
 * second opinion. What this checks is that the plan and the UTXOs handed in
 * actually correspond, because a mismatch there produces a transaction that
 * fails for reasons naming neither.
 */
export function batchTransactionPlan(inputs: BatchTransactionInputs): {
  plan: CurveBatchPlan;
  batcherFeeTotal: bigint;
} {
  const { tier, network, curveAddress, orderAddress, orderScriptCbor, orderReferenceScript, batcherKeyHash, params } =
    inputs;
  const { plan, curveUtxo } = params;
  const fee = params.batcherFeeLovelace ?? 0n;

  if (plan.fills.length === 0) {
    throw new Error('Nothing to batch: the plan filled no orders. An empty batch moves the curve for nothing.');
  }

  const currentDatum = decodeCurve(curveUtxo);
  const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);

  // Each fill names an order UTXO; that UTXO has to be one of the inputs.
  const byRef = new Map(params.orderUtxos.map((u) => [`${u.txHash}#${u.outputIndex}`, u]));
  const spentOrders: UTxO[] = [];
  for (const f of plan.fills) {
    const key = `${f.order.txHash}#${f.order.outputIndex}`;
    const utxo = byRef.get(key);
    if (!utxo) {
      throw new Error(`The plan fills order ${key}, but no UTXO for it was supplied.`);
    }
    spentOrders.push(utxo);
  }

  // The outputs, decided before anything is built so the fee arithmetic is
  // in one place: per fill, what the owner receives and what comes back.
  const payouts: CurveBatchPlan['payouts'] = [];
  let batcherFeeTotal = 0n;
  for (const f of plan.fills) {
    // The address the order was placed FROM, staking part included — a fill
    // paid to the bare enterprise address is the owner's and unspendable by
    // an ordinary wallet. See ownerAddressFrom.
    const owner = ownerAddressFrom(
      f.order.ownerKeyHashHex,
      network,
      f.order.ownerStake as Parameters<typeof ownerAddressFrom>[2],
    );
    const tag = settlementDatum({ txHash: f.order.txHash, outputIndex: f.order.outputIndex });

    // What the batcher takes, from a buy only, and never more than the part
    // of the order's budget the curve left: `maxSpend` less what the curve
    // charged. The order validator wants everything the order held above
    // `maxSpend` back, so a cut measured against the whole change could
    // reach into that reserve and fail the whole batch.
    const kept = f.order.isBuy ? min(fee, f.order.maxSpend - f.gross) : 0n;
    batcherFeeTotal += kept;

    // The curve looks for exactly this tag paying exactly this owner, and
    // will not accept an output naming a different order.
    payouts.push({ address: owner, assets: orderPayout(f, tokenUnit, kept), datumCbor: tag });
  }

  const batchPlan: CurveBatchPlan = {
    scriptUtxo: {
      txHash: curveUtxo.txHash,
      outputIndex: curveUtxo.outputIndex,
      address: curveAddress,
      assets: curveUtxo.assets,
    },
    redeemerCbor: Data.to(batchRedeemer(tier, plan, batcherKeyHash)),
    orderInputs: spentOrders.map((utxo) => ({
      utxo: {
        txHash: utxo.txHash,
        outputIndex: utxo.outputIndex,
        address: orderAddress,
        assets: utxo.assets,
      },
      redeemerCbor: Data.to(new Constr(REDEEMER_APPLY_ORDER, [])),
    })),
    orderScriptCbor,
    ...(orderReferenceScript ? { orderReferenceScript } : {}),
    continuing: {
      datumCbor: encodeCurve(nextCurveDatum(currentDatum, plan)),
      assets: nextCurveAssets(curveUtxo, plan, tokenUnit),
    },
    payouts,
    requiredSignerHashes: [batcherKeyHash],
  };
  return { plan: batchPlan, batcherFeeTotal };
}

/** `BatchTrades { orders, batcher_key_hash }`, hand-built at its real index. */
function batchRedeemer(tier: BatchTier, plan: BatchPlan, batcherKeyHash: string): Constr<Data> {
  const orders = plan.fills.map((f) =>
    batchOrderToPlutus({
      ownerKeyHashHex: f.order.ownerKeyHashHex,
      orderRef: { txHash: f.order.txHash, outputIndex: f.order.outputIndex },
      isBuy: f.order.isBuy,
      amount: f.order.amount,
      minReceived: f.order.minReceived,
      capCommittedBefore: f.capCommittedBefore,
      capProof: f.capProof,
    }),
  );
  return new Constr(REDEEMER_BATCH_TRADES[tier], [orders as unknown as Data, batcherKeyHash as Data]);
}

/**
 * The curve's continuing value.
 *
 * Built from what the curve actually holds plus the plan's own deltas — the
 * validator compares its output against its input the same way, so deriving
 * this from anything else would be a second opinion that has to agree.
 */
function nextCurveAssets(curveUtxo: UTxO, plan: BatchPlan, tokenUnit: string): Assets {
  const next: Assets = { ...curveUtxo.assets };
  next.lovelace = (next.lovelace ?? 0n) + plan.curveLovelaceDelta;
  next[tokenUnit] = (next[tokenUnit] ?? 0n) - plan.curveTokensSoldDelta;
  return next;
}

function nextCurveDatum(current: BondingCurveTierBDatumData, plan: BatchPlan): BondingCurveTierBDatumData {
  const graduated = plan.next.tokens_sold === current.curve_supply;
  return {
    ...current,
    tokens_sold: plan.next.tokens_sold,
    total_raised: plan.next.total_raised,
    creator_fees_accrued: plan.next.creator_fees_accrued,
    platform_fees_accrued: plan.next.platform_fees_accrued,
    curve_state: graduated ? 'Graduated' : current.curve_state,
    cap_root: plan.next.cap_root,
  };
}

function decodeCurve(utxo: UTxO): BondingCurveTierBDatumData {
  if (!utxo.datum) throw new Error('The curve UTXO carries no inline datum.');
  return Data.from<BondingCurveTierBDatumData>(utxo.datum, BondingCurveTierBDatumSchema);
}

function encodeCurve(datum: BondingCurveTierBDatumData): string {
  return Data.to<BondingCurveTierBDatumData>(datum, BondingCurveTierBDatumSchema);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function keyHashOf(address: string): string {
  const hash = getAddressDetails(address).paymentCredential?.hash;
  if (!hash) throw new Error(`Could not derive a payment key hash from address ${address}.`);
  return hash;
}

export { REDEEMER_APPLY_ORDER, REDEEMER_BATCH_TRADES };
