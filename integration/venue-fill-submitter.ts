// ============================================================================
// Noctis Zone — NoctisSwap: building one fill
// ============================================================================
// The transaction this builds is smaller than any other on the platform and
// harder to get right, for one reason: **the order validator resolves its own
// input and the pool's input BY POSITION**, and the transaction builder SORTS
// inputs before it serialises them.
//
//   Fill { pool_in_ix, order_in_ix, successor_ix }
//
// So the numbers in the redeemer are not the order the plan lists things in.
// They are the positions after a sort somebody else's library performs, by a
// rule that is not ours and can change under us. This module predicts that
// sort — inputs order by transaction id, then by output index, which is the
// ledger's own canonical ordering — and then DECODES THE FINISHED TRANSACTION
// to check the prediction held. Getting it wrong is silent: the transaction is
// well-formed, both scripts run, and each checks the wrong input.
//
// The other shape rule is stranger and worth stating: **a fill has exactly two
// inputs and the executor supplies neither.** `swap_order.ak` requires
// `list.length(self.inputs) == 2`, so there is no room for a wallet input to
// pay the fee with. The order carries `ex_fee` lovelace for exactly this, and
// the transaction balances out of it — network fee first, and whatever is left
// becomes the executor's change output if it can stand as one.
//
// Two consequences a batcher operator needs in front of them:
//
//   - An order that under-funds its own execution cannot be filled at all,
//     only cancelled. This builder refuses it here, by name, rather than
//     letting the node refuse it later without one.
//   - The executor's margin has to clear the minimum any output must hold. An
//     `ex_fee` that covers the network fee and no more pays the executor
//     nothing — which is a coherent way to run the venue, since the platform's
//     own slice of every swap accrues in the pool regardless, but it is a
//     decision rather than an accident.
//
// Collateral is not an input in the ledger's sense and does not count toward
// the two, so it comes from the executor's wallet as usual.
// ============================================================================

import { applyCborEncoding, MeshTxBuilder, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import type {
  CurveNetwork,
  CurveSpendProvider,
  CurveSpendWallet,
  PlanAssets,
  PlanScriptUtxo,
} from './mesh-curve-spend.js';
import {
  MESH_NETWORK_ID,
  type ReferenceScriptPointer,
  type ResolvedReferenceScript,
  resolveReferenceScript,
} from './reference-script.js';
import { VENUE_POOL_ACTION, venueFillRedeemer, venuePoolRedeemer } from './venue-swap.js';

/**
 * What one fill really costs to run, measured rather than asked for.
 *
 * Both redeemers are given the larger of the two, so one figure covers a buy,
 * a sell and a partial. `aiken tx simulate` against a real script context put
 * the pool's `Swap` arm at 710,423–713,723 memory units and the order's `Fill`
 * at 583,396–723,359, the partial being the dearest because it decodes and
 * rebuilds the continuation datum.
 *
 * Worth having for the reason `MeshCurveSpenderConfig.executionUnits` gives:
 * a remote evaluator is a third party that can be wrong, and when it is, it
 * fails in a form that names nothing. Pinning a budget known to be sufficient
 * goes around it. Re-measure when either validator changes.
 */
export const VENUE_FILL_EXECUTION_UNITS = { mem: 730_000, steps: 250_000_000 } as const;

/**
 * The least an executor can be paid by one fill, in lovelace.
 *
 * Not a policy figure — it is the smallest change output the protocol's
 * per-byte minimum admits, and an executor has nowhere else to be paid. The
 * builder was bisected against a real fill and refused every payout below
 * **969,750** lovelace to an enterprise address; this rounds up to a whole ADA
 * so a base address, which is bigger and therefore dearer, clears it too.
 *
 * It follows that an order's `ex_fee` has to be at least the fill's network
 * fee plus this, and `venue-fill-submitter.test.ts` pins both halves.
 */
export const VENUE_MIN_EXECUTOR_PAYOUT_LOVELACE = 1_000_000n;

/** How a validator reaches the transaction: named on chain, or carried in it. */
export type VenueScriptSource =
  | { compiledScriptCbor: string; referenceScript: ReferenceScriptPointer }
  | { embeddedScriptCbor: string };

export interface VenueFillerConfig {
  network: CurveNetwork;
  /** The pool validator, applied with its `royalty_withdraw_vh` parameter. */
  poolScript: VenueScriptSource;
  /** The swap-order validator. */
  orderScript: VenueScriptSource;
  provider: CurveSpendProvider;
  /**
   * Budgets to declare instead of measuring — the same deliberate escape the
   * curve spender offers, for the same reason: a remote evaluator that is
   * wrong says so in a form that names nothing.
   */
  executionUnits?: { mem: number; steps: number };
}

/** An output this fill places, in the order it is placed. */
export interface VenueFillOutput {
  address: string;
  assets: PlanAssets;
  /** Inline datum, CBOR hex. A reward output to the placer carries none. */
  datumCbor?: string;
}

/**
 * One fill, described without reference to any transaction library.
 *
 * The two inputs are named separately rather than as a list, because which is
 * which is the whole difficulty: the redeemers carry their positions and the
 * builder has to work out what those positions become.
 */
export interface VenueFillPlan {
  pool: PlanScriptUtxo;
  order: PlanScriptUtxo;
  /** The pool's continuing output. Always placed first. */
  poolOutput: VenueFillOutput;
  /** The placer's reward, or the order continuing. Always placed second. */
  successorOutput: VenueFillOutput;
  /** Key hashes the transaction must declare — an order naming executors needs one. */
  requiredSignerHashes?: string[];
}

/** Lovelace and assets, in Mesh's shape. */
function toMesh(assets: PlanAssets): Array<{ unit: string; quantity: string }> {
  return Object.entries(assets)
    .filter(([, quantity]) => quantity !== 0n)
    .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

/**
 * Where the two inputs land once sorted, by the ledger's canonical ordering.
 *
 * Transaction ids are equal-length lowercase hex, so comparing the strings is
 * comparing the bytes. This is a PREDICTION; `assertInputsWhereClaimed` is
 * what makes it a fact about the transaction that was built.
 */
export function venueInputPositions(
  pool: Pick<PlanScriptUtxo, 'txHash' | 'outputIndex'>,
  order: Pick<PlanScriptUtxo, 'txHash' | 'outputIndex'>,
): { poolInIx: number; orderInIx: number } {
  if (pool.txHash === order.txHash && pool.outputIndex === order.outputIndex) {
    throw new Error(
      `The pool and the order are the same UTXO (${pool.txHash}#${pool.outputIndex}). A fill needs two ` +
        'different inputs, and the validator counts them.',
    );
  }
  const poolFirst =
    pool.txHash < order.txHash || (pool.txHash === order.txHash && pool.outputIndex < order.outputIndex);
  return poolFirst ? { poolInIx: 0, orderInIx: 1 } : { poolInIx: 1, orderInIx: 0 };
}

/**
 * Holds the finished transaction to the input positions the redeemers name.
 *
 * The failure this catches has no other signal. A transaction whose inputs
 * came out in the other order still decodes, still evaluates, and hands the
 * pool's rules the order's UTXO — so it fails at the node with a message about
 * a script exiting early, naming neither input nor reason.
 */
function assertInputsWhereClaimed(
  unsignedTxHex: string,
  claims: ReadonlyArray<{ index: number; txHash: string; outputIndex: number; what: string }>,
): void {
  // `inputs()` is a CBOR set, not an array — `toCore()` is what gives the
  // `{ txId, index }` pairs in the order they were serialised.
  const inputs = deserializeTx(unsignedTxHex).body().inputs().toCore();
  if (inputs.length !== 2) {
    throw new Error(
      `A fill must have exactly two inputs — the pool and the order — and this one has ${inputs.length}. ` +
        'The order validator counts them, so the extra input makes the transaction unfillable. It came ' +
        'from coin selection: the order does not carry enough lovelace to pay for its own execution.',
    );
  }
  for (const claim of claims) {
    const got = inputs[claim.index];
    const gotHash = String(got?.txId ?? '');
    const gotIndex = Number(got?.index ?? -1);
    if (gotHash !== claim.txHash || gotIndex !== claim.outputIndex) {
      throw new Error(
        `The redeemer names input ${claim.index} as the ${claim.what} ` +
          `(${claim.txHash}#${claim.outputIndex}), but the built transaction has ${gotHash}#${gotIndex} ` +
          'there. Inputs were sorted by a rule this builder no longer predicts, so every redeemer ' +
          'position in this transaction is pointing at the wrong input.',
      );
    }
  }
}

/**
 * Builds one fill: the pool spent under `Swap`, the order under `Fill`.
 *
 * Both validators are REFERENCED by default. Carrying them would fit — the two
 * are 7.3 KB against a 16 KB cap — but it costs more: a carried script pays
 * the size fee on every byte, while a referenced one pays the smaller
 * per-byte surcharge, so naming both is roughly a third of the price of
 * carrying them, on every fill forever.
 */
export class VenueFiller {
  private readonly poolRef?: ResolvedReferenceScript;
  private readonly orderRef?: ResolvedReferenceScript;

  constructor(private readonly config: VenueFillerConfig) {
    const networkId = MESH_NETWORK_ID[config.network];
    if ('referenceScript' in config.poolScript) {
      this.poolRef = resolveReferenceScript(
        config.poolScript.compiledScriptCbor,
        config.poolScript.referenceScript,
        networkId,
      );
    }
    if ('referenceScript' in config.orderScript) {
      this.orderRef = resolveReferenceScript(
        config.orderScript.compiledScriptCbor,
        config.orderScript.referenceScript,
        networkId,
      );
    }
  }

  private newBuilder(): MeshTxBuilder {
    return new MeshTxBuilder({
      fetcher: this.config.provider as never,
      submitter: this.config.provider as never,
      // Measured against the real transaction unless an operator pins them.
      ...(this.config.executionUnits ? {} : { evaluator: this.config.provider as never }),
      verbose: false,
    });
  }

  private attachScript(tx: MeshTxBuilder, which: 'pool' | 'order'): void {
    const source = which === 'pool' ? this.config.poolScript : this.config.orderScript;
    const ref = which === 'pool' ? this.poolRef : this.orderRef;
    if (ref) {
      tx.spendingTxInReference(ref.txHash, ref.outputIndex, String(ref.rawSizeBytes), ref.scriptHash);
      return;
    }
    if ('embeddedScriptCbor' in source) {
      tx.txInScript(applyCborEncoding(source.embeddedScriptCbor));
      return;
    }
    /* c8 ignore next 2 -- unreachable: a source is one shape or the other. */
    throw new Error(`No script source for the ${which}.`);
  }

  /**
   * Builds the fill. Returns the unsigned transaction, CBOR hex.
   *
   * The wallet is asked for collateral and a change address and NOTHING else.
   * No UTXO of the executor's is offered to coin selection, because a
   * transaction that needed one would already be invalid — so an order that
   * cannot pay for itself fails here, where the message can say that, rather
   * than building a three-input transaction the pool will reject.
   */
  async build(plan: VenueFillPlan, wallet: CurveSpendWallet): Promise<string> {
    if (this.poolRef && plan.pool.address !== this.poolRef.scriptAddress) {
      throw new Error(
        `The pool UTXO sits at ${plan.pool.address}, but this filler references a pool validator whose ` +
          `address is ${this.poolRef.scriptAddress}. Spending it would need the validator that locks it.`,
      );
    }
    if (this.orderRef && plan.order.address !== this.orderRef.scriptAddress) {
      throw new Error(
        `The order UTXO sits at ${plan.order.address}, but this filler references an order validator whose ` +
          `address is ${this.orderRef.scriptAddress}. Spending it would need the validator that locks it.`,
      );
    }

    const [changeAddress, collateral] = await Promise.all([wallet.getChangeAddress(), wallet.getCollateral()]);
    const collateralUtxo: MeshUTxO | undefined = collateral[0];
    if (!collateralUtxo) {
      throw new Error(
        'The executor wallet has no collateral UTXO. A Plutus spend needs one — a pure-ada UTXO the wallet ' +
          'sets aside, which most wallets create on request.',
      );
    }

    const { poolInIx, orderInIx } = venueInputPositions(plan.pool, plan.order);
    // The successor is the second output this builder places, and outputs are
    // never sorted — change is appended after them.
    const successorIx = 1;

    const tx = this.newBuilder();
    const inputs: Array<'pool' | 'order'> = poolInIx === 0 ? ['pool', 'order'] : ['order', 'pool'];
    for (const which of inputs) {
      const utxo = which === 'pool' ? plan.pool : plan.order;
      const redeemer =
        which === 'pool'
          ? venuePoolRedeemer(VENUE_POOL_ACTION.Swap, poolInIx)
          : venueFillRedeemer(poolInIx, orderInIx, successorIx);
      tx.spendingPlutusScriptV3().txIn(utxo.txHash, utxo.outputIndex, toMesh(utxo.assets), utxo.address, 0);
      this.attachScript(tx, which);
      tx.txInInlineDatumPresent().txInRedeemerValue(redeemer, 'CBOR', this.config.executionUnits);
    }

    for (const output of [plan.poolOutput, plan.successorOutput]) {
      tx.txOut(output.address, toMesh(output.assets));
      if (output.datumCbor) tx.txOutInlineDatumValue(output.datumCbor, 'CBOR');
    }

    for (const hash of plan.requiredSignerHashes ?? []) tx.requiredSignerHash(hash);

    tx.txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
      collateralUtxo.output.amount,
      collateralUtxo.output.address,
    )
      // Deliberately empty: see the doc comment. The order funds its own fill.
      .selectUtxosFrom([])
      .changeAddress(changeAddress)
      .setNetwork(this.config.network);

    const unsigned = await tx.complete();
    assertInputsWhereClaimed(unsigned, [
      { index: poolInIx, txHash: plan.pool.txHash, outputIndex: plan.pool.outputIndex, what: 'pool' },
      { index: orderInIx, txHash: plan.order.txHash, outputIndex: plan.order.outputIndex, what: 'order' },
    ]);
    return unsigned;
  }

  /**
   * Builds a fill that charges what it costs rather than what it may.
   *
   * `ex_fee` is a ceiling the placer authorises, not a price — every rule the
   * order states about it is an inequality, so an executor may take less and
   * leave the difference with the placer. This takes the network fee plus the
   * smallest payout that can legally exist, and returns the rest.
   *
   * **Why an executor cannot simply take the fee and nothing else.** A fill has
   * exactly two inputs and neither is the executor's, so anything it keeps has
   * to be a change output — and an output has to hold at least what the
   * protocol's per-byte minimum requires. There is no third place for a few
   * hundred thousand lovelace to go: the builder will not fold it into the fee,
   * and the pool's and the placer's outputs are both pinned to the lovelace by
   * their own validators. So the floor under an order's `ex_fee` is the fill's
   * fee PLUS that minimum, and `VENUE_MIN_EXECUTOR_PAYOUT_LOVELACE` records
   * what it measured at.
   *
   * It takes two passes because a fee depends on a size that depends on the
   * fee. The first is a PROBE: the same fill with lovelace added to the order
   * and kept by the executor, so a change output certainly exists and the
   * builder has to price a real transaction. The second charges what that
   * came to.
   */
  async buildSettled(
    makePlan: (executorFee: bigint) => VenueFillPlan,
    wallet: CurveSpendWallet,
    opts: { executorPayoutLovelace?: bigint; probePaddingLovelace?: bigint } = {},
  ): Promise<{ txHex: string; executorFee: bigint; networkFee: bigint }> {
    const payout = opts.executorPayoutLovelace ?? VENUE_MIN_EXECUTOR_PAYOUT_LOVELACE;
    const padding = opts.probePaddingLovelace ?? 5_000_000n;
    const probe = makePlan(0n);
    const probeHex = await this.build(
      {
        ...probe,
        order: {
          ...probe.order,
          assets: { ...probe.order.assets, lovelace: (probe.order.assets.lovelace ?? 0n) + padding },
        },
      },
      wallet,
    );
    const networkFee = deserializeTx(probeHex).body().fee();
    const executorFee = networkFee + payout;
    return { txHex: await this.build(makePlan(executorFee), wallet), executorFee, networkFee };
  }

  /** Builds, signs and submits a fill. Returns the transaction hash. */
  async submit(plan: VenueFillPlan, wallet: CurveSpendWallet): Promise<string> {
    const unsigned = await this.build(plan, wallet);
    return wallet.submitTx(await wallet.signTx(unsigned));
  }
}
