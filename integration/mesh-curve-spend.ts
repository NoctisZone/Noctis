// ============================================================================
// Noctis Zone — curve spends against a published reference script
// ============================================================================
// Every Lucid submitter in this codebase EMBEDS the validator it spends:
// `collectFrom` builds its witness with `PlutusScriptWitness.new_script`, and
// there is no code path to `new_ref`. That is fine for a small validator and
// impossible for `bonding_curve_tier_b`, which alone is most of the
// 16,384-byte transaction cap before a single input, output or cap-accumulator
// proof.
//
// This module builds the same spend with the script REFERENCED instead. The
// arithmetic, the datum and the redeemer are all still the submitters' — they
// hand over a finished plan, and nothing about pricing, fees or the cap
// accumulator is duplicated here. What this owns is exactly the part that
// differs between the two libraries: how the script gets into the transaction.
//
// **The plan is library-neutral on purpose.** A submitter that produces one of
// these can be executed either way, so choosing to reference a script is a
// deployment decision rather than a rewrite, and the pricing logic keeps its
// single home and its existing tests.
//
// Three details worth knowing before changing anything here:
//
//   - **Amounts.** Lucid represents a value as `Record<unit, bigint>`; Mesh as
//     a list of `{unit, quantity}` with quantity as a decimal string. `toMesh`
//     is the only place that conversion happens.
//
//   - **Validity.** Lucid's `validFrom`/`validTo` take POSIX milliseconds;
//     Mesh's `invalidBefore`/`invalidHereafter` take SLOTS. A millisecond
//     value passed to Mesh unconverted is a slot roughly fifty thousand years
//     away, which the ledger accepts and the validator then reads as a
//     wide-open range. `resolveSlotNo` does the conversion.
//
//   - **Minimum ada.** Lucid tops up an output that holds only tokens; Mesh
//     does too, in `sanitizeOutputs` during `complete()`, so a token-only
//     delivery does not need one added here. Verified against Mesh's own
//     source rather than assumed, because the failure mode is a transaction
//     the node rejects for a reason that names neither the output nor ada.

import { type Asset, applyCborEncoding, MeshTxBuilder, type UTxO as MeshUTxO, resolveSlotNo } from '@meshsdk/core';
import {
  MESH_NETWORK_ID,
  type ReferenceScriptPointer,
  type ResolvedReferenceScript,
  resolveReferenceScript,
} from './reference-script.js';

/** Networks this codebase names, as Mesh's builder and slot maths take them. */
export type CurveNetwork = 'preview' | 'preprod' | 'mainnet';

/** A value, in the shape Lucid submitters already hold one. */
export type PlanAssets = Record<string, bigint>;

/** The launch's state UTXO, as the plan needs to describe it. */
export interface PlanScriptUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  assets: PlanAssets;
}

/** An output to an ordinary address. */
export interface PlanPayout {
  address: string;
  assets: PlanAssets;
  /**
   * The settlement tag, CBOR hex. Every payout a curve makes carries one —
   * the validator asks for an output naming the spend it settles, so a payout
   * without this is not a payout as far as the contract is concerned.
   */
  datumCbor?: string;
}

/**
 * One curve spend, described without reference to any transaction library.
 *
 * A submitter fills this in after doing all of its own arithmetic; both
 * execution paths take it unchanged.
 */
export interface CurveSpendPlan {
  scriptUtxo: PlanScriptUtxo;
  /** The redeemer, CBOR hex. */
  redeemerCbor: string;
  /** The continuing state output, back to the same script address. */
  continuing: { datumCbor: string; assets: PlanAssets };
  payouts: PlanPayout[];
  /** Payment key hashes the transaction must be signed by. */
  requiredSignerHashes: string[];
  /** POSIX milliseconds, matching what the validator reads. Both or neither. */
  validity?: { fromMs: number; toMs: number };
}

/**
 * A companion contract spent alongside the curve — how graduation moves
 * value into the LP escrow and the staking pool in the same transaction the
 * curve releases it.
 *
 * Each names its own script source. A large, published validator is
 * referenced (with the same staleness guard the curve's own pointer gets); a
 * small one is carried, the same split `CurveBatchPlan` already draws for
 * orders. The companion's continuing output rides in the plan's `payouts` —
 * to its validator it is simply an output at its own address, and the plan
 * does not need a second notion of "continuing" to say so.
 */
export interface CompanionScriptInput {
  utxo: PlanScriptUtxo;
  /** The redeemer, CBOR hex. */
  redeemerCbor: string;
  script:
    | {
        /** The raw compiled CBOR, straight from plutus.json. */
        compiledScriptCbor: string;
        /** Where that exact validator is published. Checked, not trusted. */
        referenceScript: ReferenceScriptPointer;
      }
    | {
        /** The raw compiled CBOR, carried in the witness set. */
        embeddedScriptCbor: string;
      };
}

/**
 * A graduation: the curve spent against its published reference script,
 * alongside the launch's other contracts settling in the same transaction.
 *
 * The plan stays library-neutral like the others — the submitter does all the
 * arithmetic and datum work, and this only decides how each script reaches
 * the transaction.
 */
export interface GraduationSpendPlan extends CurveSpendPlan {
  companionInputs: CompanionScriptInput[];
}

/**
 * A co-signer: something that can add its witness to an already-built
 * transaction. `KeyCurveSpendWallet` satisfies it. Witness sets merge —
 * verified against the serialisation library's own source, which concatenates
 * the existing vkey witnesses with the new ones rather than replacing them —
 * so signatures accumulate across sequential `signTx` calls.
 */
export type TxCoSigner = Pick<CurveSpendWallet, 'signTx'>;

/**
 * A batch: the curve spent alongside N order UTXOs.
 *
 * The curve's validator is REFERENCED and the orders' is EMBEDDED, which is
 * not an arbitrary split. A the linear curve curve is 12 KB and a batch of two orders
 * measured 17,991 bytes against the 16,384 cap with it embedded — referencing
 * it alone leaves over 10 KB spare. `curve_order` is 1.7 KB and carrying it
 * costs little, so it is not worth a second reference UTXO to publish and keep
 * current. Referencing the curve is not an optimisation on Cardano Launch: that
 * validator cannot be embedded at all.
 */
export interface CurveBatchPlan {
  /** The launch's curve UTXO, spent against the published reference script. */
  scriptUtxo: PlanScriptUtxo;
  /** The `BatchTrades` redeemer, CBOR hex. */
  redeemerCbor: string;
  /** The order UTXOs, each spent with the embedded order validator. */
  orderInputs: Array<{ utxo: PlanScriptUtxo; redeemerCbor: string }>;
  /** The order validator, raw compiled CBOR. Wrapped before use. */
  orderScriptCbor: string;
  continuing: { datumCbor: string; assets: PlanAssets };
  payouts: PlanPayout[];
  requiredSignerHashes: string[];
  validity?: { fromMs: number; toMs: number };
}

/**
 * The wallet operations a spend needs.
 *
 * Structurally satisfied by Mesh's own `MeshWallet`, so production passes one
 * of those and a test passes a fake without either knowing about the other.
 */
export interface CurveSpendWallet {
  getChangeAddress(): Promise<string>;
  getUtxos(): Promise<MeshUTxO[]>;
  getCollateral(): Promise<MeshUTxO[]>;
  signTx(unsignedTxHex: string): Promise<string>;
  submitTx(signedTxHex: string): Promise<string>;
}

/** What the builder needs from a chain provider. Mesh's providers satisfy it. */
export interface CurveSpendProvider {
  fetchProtocolParameters?: unknown;
  evaluateTx?: unknown;
}

export interface MeshCurveSpenderConfig {
  network: CurveNetwork;
  /** The curve validator's raw compiled CBOR, straight from plutus.json. */
  compiledScriptCbor: string;
  /** Where that exact validator is published. Checked, not trusted. */
  referenceScript: ReferenceScriptPointer;
  /** Mesh provider used as fetcher, submitter and script evaluator. */
  provider: CurveSpendProvider;
  /**
   * Execution budgets to declare, instead of asking the provider to measure.
   *
   * Left unset — the normal case — the real script is evaluated against the
   * real transaction, which is the only way to pay what a spend actually
   * costs. Set, no evaluation happens at all and these are declared as-is.
   *
   * That is worth having for one reason: a remote evaluator is a third party
   * that can be wrong, and when it is, it says so in a form that names nothing
   * — leaving a spend unsubmittable with no way to tell a broken transaction
   * from a broken evaluator. Pinning a budget known to be sufficient goes
   * around it. Declare too little and the node rejects the spend; too much and
   * the fee is overpaid, so this is a deliberate operator choice, never a
   * default.
   */
  executionUnits?: { mem: number; steps: number };
}

/** Lovelace and assets, in Mesh's shape. */
function toMesh(assets: PlanAssets): Asset[] {
  return Object.entries(assets)
    .filter(([, quantity]) => quantity !== 0n)
    .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

/**
 * The wallet's UTXOs that are safe to spend for fees and change.
 *
 * A published reference script sits in an ordinary UTXO at an ordinary
 * address, and coin selection does not know to leave it alone — Mesh's
 * selector has no exclusion for it. Handing it the whole wallet lets it fund a
 * transaction by spending a reference script, which DESTROYS that script while
 * the transaction succeeds, and every launch pointing at it breaks.
 *
 * The batcher's wallet is exactly where this bites: it publishes the reference
 * scripts, so it is the one wallet holding them, and the more orders a batch
 * carries the more fee input selection reaches for.
 *
 * Same hazard the publisher already guards against, from the other side.
 */
export function spendableForFees(utxos: readonly MeshUTxO[]): MeshUTxO[] {
  return utxos.filter((u) => !u.output.scriptRef && !u.output.scriptHash);
}

/**
 * Builds and submits a curve spend that REFERENCES its validator.
 *
 * The reference pointer is resolved once, at construction, so a pointer left
 * over from an older build of the validator fails immediately with a message
 * saying so — rather than at submission, where the node's complaint is about
 * a missing script and says nothing about which one or why.
 */
export class MeshCurveSpender {
  private readonly ref: ResolvedReferenceScript;

  constructor(private readonly config: MeshCurveSpenderConfig) {
    this.ref = resolveReferenceScript(
      config.compiledScriptCbor,
      config.referenceScript,
      MESH_NETWORK_ID[config.network],
    );
  }

  /**
   * A builder wired to the provider — with an evaluator unless budgets were
   * pinned, since Mesh evaluates whenever one is present.
   */
  private newBuilder(): MeshTxBuilder {
    return new MeshTxBuilder({
      fetcher: this.config.provider as never,
      submitter: this.config.provider as never,
      // Execution units come from evaluating the real script against the real
      // transaction. Guessing them either overpays on every trade or produces
      // a transaction the node refuses.
      ...(this.config.executionUnits ? {} : { evaluator: this.config.provider as never }),
      verbose: false,
    });
  }

  /** Where this tier's launches keep their state. */
  get scriptAddress(): string {
    return this.ref.scriptAddress;
  }

  /** The wrapped script, for callers that need to publish or hash it. */
  get wrappedScriptCbor(): string {
    return applyCborEncoding(this.config.compiledScriptCbor);
  }

  /**
   * Builds the transaction, unsigned.
   *
   * Separate from `submit` so a caller can inspect what it is about to sign,
   * and so the shape can be tested without a wallet or a node.
   */
  async build(plan: CurveSpendPlan, wallet: CurveSpendWallet): Promise<string> {
    if (plan.scriptUtxo.address !== this.ref.scriptAddress) {
      throw new Error(
        `The UTXO being spent sits at ${plan.scriptUtxo.address}, but this spender references a ` +
          `script whose address is ${this.ref.scriptAddress}. Spending it would need the validator ` +
          'that actually locks it.',
      );
    }

    const [changeAddress, walletUtxos, collateral] = await Promise.all([
      wallet.getChangeAddress(),
      wallet.getUtxos(),
      wallet.getCollateral(),
    ]);
    const collateralUtxo = collateral[0];
    if (!collateralUtxo) {
      throw new Error(
        'The wallet has no collateral UTXO. A Plutus spend needs one — a pure-ada UTXO the wallet ' +
          'sets aside, which most wallets create on request.',
      );
    }

    const tx = this.newBuilder();

    tx.spendingPlutusScriptV3()
      // scriptSize 0: this UTXO carries no reference script of its own. The
      // one being referenced is named on the next line.
      .txIn(
        plan.scriptUtxo.txHash,
        plan.scriptUtxo.outputIndex,
        toMesh(plan.scriptUtxo.assets),
        plan.scriptUtxo.address,
        0,
      )
      // The whole point: the validator is named rather than carried.
      .spendingTxInReference(this.ref.txHash, this.ref.outputIndex, String(this.ref.rawSizeBytes), this.ref.scriptHash)
      .txInInlineDatumPresent()
      .txInRedeemerValue(plan.redeemerCbor, 'CBOR', this.config.executionUnits);

    tx.txOut(this.ref.scriptAddress, toMesh(plan.continuing.assets)).txOutInlineDatumValue(
      plan.continuing.datumCbor,
      'CBOR',
    );

    for (const payout of plan.payouts) {
      tx.txOut(payout.address, toMesh(payout.assets));
      if (payout.datumCbor) tx.txOutInlineDatumValue(payout.datumCbor, 'CBOR');
    }

    for (const hash of plan.requiredSignerHashes) tx.requiredSignerHash(hash);

    if (plan.validity) {
      // Slots, not milliseconds — see this module's header.
      tx.invalidBefore(Number(resolveSlotNo(this.config.network, plan.validity.fromMs)));
      tx.invalidHereafter(Number(resolveSlotNo(this.config.network, plan.validity.toMs)));
    }

    tx.txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
      collateralUtxo.output.amount,
      collateralUtxo.output.address,
    )
      .selectUtxosFrom(spendableForFees(walletUtxos))
      .changeAddress(changeAddress)
      .setNetwork(this.config.network);

    return tx.complete();
  }

  /** Builds, signs and submits. Returns the transaction hash. */
  async submit(plan: CurveSpendPlan, wallet: CurveSpendWallet): Promise<string> {
    const unsigned = await this.build(plan, wallet);
    const signed = await wallet.signTx(unsigned);
    return wallet.submitTx(signed);
  }

  /**
   * Builds a batch: the curve against its reference script, and N order UTXOs
   * with the order validator carried.
   *
   * Each input needs its own redeemer, so each is queued separately — Mesh
   * applies `spendingTxInReference` / `txInScript` to whichever input was
   * queued last, which makes the call order load-bearing rather than
   * stylistic.
   */
  async buildBatch(plan: CurveBatchPlan, wallet: CurveSpendWallet): Promise<string> {
    if (plan.scriptUtxo.address !== this.ref.scriptAddress) {
      throw new Error(
        `The curve UTXO sits at ${plan.scriptUtxo.address}, but this spender references a script whose ` +
          `address is ${this.ref.scriptAddress}. Spending it would need the validator that locks it.`,
      );
    }
    if (plan.orderInputs.length === 0) {
      throw new Error('A batch with no orders moves the curve for nothing.');
    }

    const [changeAddress, walletUtxos, collateral] = await Promise.all([
      wallet.getChangeAddress(),
      wallet.getUtxos(),
      wallet.getCollateral(),
    ]);
    const collateralUtxo = collateral[0];
    if (!collateralUtxo) {
      throw new Error(
        'The wallet has no collateral UTXO. A Plutus spend needs one — a pure-ada UTXO the wallet ' +
          'sets aside, which most wallets create on request.',
      );
    }

    const tx = this.newBuilder();

    // The curve: named, not carried. This is what makes the transaction fit —
    // with the validator embedded a two-order batch measured 17,991 bytes
    // against a 16,384 cap, and a spend cannot be split across transactions.
    tx.spendingPlutusScriptV3()
      .txIn(
        plan.scriptUtxo.txHash,
        plan.scriptUtxo.outputIndex,
        toMesh(plan.scriptUtxo.assets),
        plan.scriptUtxo.address,
        0,
      )
      .spendingTxInReference(this.ref.txHash, this.ref.outputIndex, String(this.ref.rawSizeBytes), this.ref.scriptHash)
      .txInInlineDatumPresent()
      .txInRedeemerValue(plan.redeemerCbor, 'CBOR', this.config.executionUnits);

    // The orders: the validator is small enough to carry, and carrying it
    // avoids a second reference UTXO to publish and keep current.
    const orderScript = applyCborEncoding(plan.orderScriptCbor);
    for (const input of plan.orderInputs) {
      tx.spendingPlutusScriptV3()
        .txIn(input.utxo.txHash, input.utxo.outputIndex, toMesh(input.utxo.assets), input.utxo.address, 0)
        .txInScript(orderScript)
        .txInInlineDatumPresent()
        .txInRedeemerValue(input.redeemerCbor, 'CBOR');
    }

    tx.txOut(this.ref.scriptAddress, toMesh(plan.continuing.assets)).txOutInlineDatumValue(
      plan.continuing.datumCbor,
      'CBOR',
    );

    for (const payout of plan.payouts) {
      tx.txOut(payout.address, toMesh(payout.assets));
      if (payout.datumCbor) tx.txOutInlineDatumValue(payout.datumCbor, 'CBOR');
    }

    for (const hash of plan.requiredSignerHashes) tx.requiredSignerHash(hash);

    if (plan.validity) {
      tx.invalidBefore(Number(resolveSlotNo(this.config.network, plan.validity.fromMs)));
      tx.invalidHereafter(Number(resolveSlotNo(this.config.network, plan.validity.toMs)));
    }

    tx.txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
      collateralUtxo.output.amount,
      collateralUtxo.output.address,
    )
      .selectUtxosFrom(spendableForFees(walletUtxos))
      .changeAddress(changeAddress)
      .setNetwork(this.config.network);

    return tx.complete();
  }

  /** Builds, signs and submits a batch. Returns the transaction hash. */
  async submitBatch(plan: CurveBatchPlan, wallet: CurveSpendWallet): Promise<string> {
    const unsigned = await this.buildBatch(plan, wallet);
    const signed = await wallet.signTx(unsigned);
    return wallet.submitTx(signed);
  }

  /**
   * Builds a graduation: the curve against its reference script, plus each
   * companion contract with the script source its plan entry names.
   *
   * Same load-bearing call order as `buildBatch`: Mesh applies
   * `spendingTxInReference` / `txInScript` to whichever input was queued
   * last, so each input's script call must follow its own `txIn` directly.
   */
  async buildGraduation(plan: GraduationSpendPlan, wallet: CurveSpendWallet): Promise<string> {
    if (plan.scriptUtxo.address !== this.ref.scriptAddress) {
      throw new Error(
        `The curve UTXO sits at ${plan.scriptUtxo.address}, but this spender references a script whose ` +
          `address is ${this.ref.scriptAddress}. Spending it would need the validator that locks it.`,
      );
    }
    if (plan.companionInputs.length === 0) {
      throw new Error(
        'A graduation with no companion inputs is just a curve spend — use build() for that, so a ' +
          'missing LP escrow input fails here rather than at the node.',
      );
    }

    const [changeAddress, walletUtxos, collateral] = await Promise.all([
      wallet.getChangeAddress(),
      wallet.getUtxos(),
      wallet.getCollateral(),
    ]);
    const collateralUtxo = collateral[0];
    if (!collateralUtxo) {
      throw new Error(
        'The wallet has no collateral UTXO. A Plutus spend needs one — a pure-ada UTXO the wallet ' +
          'sets aside, which most wallets create on request.',
      );
    }

    const tx = this.newBuilder();

    // The curve: named, not carried — the validator alone is most of the
    // transaction size cap, so a graduation that embeds it cannot fit.
    tx.spendingPlutusScriptV3()
      .txIn(
        plan.scriptUtxo.txHash,
        plan.scriptUtxo.outputIndex,
        toMesh(plan.scriptUtxo.assets),
        plan.scriptUtxo.address,
        0,
      )
      .spendingTxInReference(this.ref.txHash, this.ref.outputIndex, String(this.ref.rawSizeBytes), this.ref.scriptHash)
      .txInInlineDatumPresent()
      .txInRedeemerValue(plan.redeemerCbor, 'CBOR', this.config.executionUnits);

    for (const companion of plan.companionInputs) {
      tx.spendingPlutusScriptV3().txIn(
        companion.utxo.txHash,
        companion.utxo.outputIndex,
        toMesh(companion.utxo.assets),
        companion.utxo.address,
        0,
      );
      if ('referenceScript' in companion.script) {
        // The same staleness guard the curve's pointer gets at construction:
        // a pointer published for an older build of this validator fails here
        // with both hashes named, not at the node.
        const ref = resolveReferenceScript(
          companion.script.compiledScriptCbor,
          companion.script.referenceScript,
          MESH_NETWORK_ID[this.config.network],
        );
        if (companion.utxo.address !== ref.scriptAddress) {
          throw new Error(
            `A companion UTXO sits at ${companion.utxo.address}, but its reference pointer holds a ` +
              `script whose address is ${ref.scriptAddress}. Spending it would need the validator ` +
              'that actually locks it.',
          );
        }
        tx.spendingTxInReference(ref.txHash, ref.outputIndex, String(ref.rawSizeBytes), ref.scriptHash);
      } else {
        tx.txInScript(applyCborEncoding(companion.script.embeddedScriptCbor));
      }
      tx.txInInlineDatumPresent().txInRedeemerValue(companion.redeemerCbor, 'CBOR');
    }

    tx.txOut(this.ref.scriptAddress, toMesh(plan.continuing.assets)).txOutInlineDatumValue(
      plan.continuing.datumCbor,
      'CBOR',
    );

    for (const payout of plan.payouts) {
      tx.txOut(payout.address, toMesh(payout.assets));
      if (payout.datumCbor) tx.txOutInlineDatumValue(payout.datumCbor, 'CBOR');
    }

    for (const hash of plan.requiredSignerHashes) tx.requiredSignerHash(hash);

    if (plan.validity) {
      tx.invalidBefore(Number(resolveSlotNo(this.config.network, plan.validity.fromMs)));
      tx.invalidHereafter(Number(resolveSlotNo(this.config.network, plan.validity.toMs)));
    }

    tx.txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
      collateralUtxo.output.amount,
      collateralUtxo.output.address,
    )
      .selectUtxosFrom(spendableForFees(walletUtxos))
      .changeAddress(changeAddress)
      .setNetwork(this.config.network);

    return tx.complete();
  }

  /**
   * Builds, signs and submits a graduation. Returns the transaction hash.
   *
   * `coSigners` add their witnesses after the funding wallet's — a companion
   * redeemer that names a required signer beyond the fee payer (the staking
   * pool's seeding does) gets its signature this way, and the witness sets
   * merge rather than replace.
   */
  async submitGraduation(
    plan: GraduationSpendPlan,
    wallet: CurveSpendWallet,
    coSigners: readonly TxCoSigner[] = [],
  ): Promise<string> {
    const unsigned = await this.buildGraduation(plan, wallet);
    let signed = await wallet.signTx(unsigned);
    for (const coSigner of coSigners) {
      signed = await coSigner.signTx(signed);
    }
    return wallet.submitTx(signed);
  }
}
