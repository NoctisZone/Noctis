// ============================================================================
// Noctis Zone — NoctisSwap: taking an order back
// ============================================================================
// `swap_order.ak`'s cancel arm is one line:
//
//   Cancel -> list.has(self.extra_signatories, cfg.reward_pkh)
//
// The placer's signature, and nothing else. No deadline, no batcher, no
// counterparty, no conditions — an order is never something its placer has to
// wait to get out of.
//
// **`extra_signatories` is the transaction's REQUIRED SIGNERS, not its
// witnesses.** Signing alone does not satisfy this: the key has to be declared
// in the transaction body as well, or the script sees an empty list and
// refuses. The same trap sits behind `executor_ok` on the fill side, and it
// fails the same way — a transaction that is signed, well formed, and rejected
// for a reason that names nothing.
//
// **Cancels batch, and fills cannot.** The two-input rule lives inside the
// `Fill` arm; the cancel arm has no shape rule at all. So one transaction can
// take back as many of a placer's orders as fit, for one network fee and one
// signature, where each fill needs a transaction of its own. A placer holding
// ten orders that can no longer fill gets out of all ten at once.
//
// **The wallet's own UTXOs ARE offered to coin selection here**, which is the
// opposite of the fill and deliberate. A fill must refuse them — a third input
// breaks the rule the order validator counts on — while a cancel has no such
// rule, and refusing them would mean an order whose lovelace could not cover
// its own network fee had no way out at all.
//
// The funds return to the address the ORDER names — `reward_pkh` with its
// optional stake key — rather than to whatever address the signing wallet
// happens to hand back. A cancel is then verifiable from the order alone: the
// destination was fixed when the order was written, not chosen at the end.
// ============================================================================

import { applyCborEncoding, MeshTxBuilder, type UTxO as MeshUTxO } from '@meshsdk/core';
import type { CurveNetwork, CurveSpendProvider, CurveSpendWallet } from './mesh-curve-spend.js';
import { MESH_NETWORK_ID, type ResolvedReferenceScript, resolveReferenceScript } from './reference-script.js';
import type { VenueScriptSource } from './venue-fill-submitter.js';
import { type VenueSwapOrderUtxo, venueCancelRedeemer, venueRewardAddress } from './venue-swap.js';

/**
 * What a cancel costs to execute, in memory and cpu steps.
 *
 * The cancel arm does one list lookup, so this is nowhere near the fill's
 * budget. Declared for the reason the fill declares its own: a remote
 * evaluator is a third party that can be wrong, and when it is, it fails in a
 * form that names nothing.
 */
export const VENUE_CANCEL_EXECUTION_UNITS = { mem: 120_000, steps: 40_000_000 } as const;

/** The chains Lucid names differently from Mesh. One setting, not two. */
const LUCID_NETWORK = { preview: 'Preview', preprod: 'Preprod', mainnet: 'Mainnet' } as const;

export interface VenueCancellerConfig {
  network: CurveNetwork;
  /** The swap-order validator. */
  orderScript: VenueScriptSource;
  provider: CurveSpendProvider;
  /** Budgets to declare instead of measuring. */
  executionUnits?: { mem: number; steps: number };
}

/**
 * The single address a batch of cancels returns to.
 *
 * Every order in one transaction has to name the same one, and this is why:
 * the funds leave as a single change output, so a batch mixing placers — or
 * even one placer's orders with different stake keys — would send somebody
 * else's money to the wrong address. Two orders differing here are two
 * transactions, which costs a fee and nothing else.
 */
export function venueCancelDestination(orders: readonly VenueSwapOrderUtxo[], network: CurveNetwork): string {
  if (orders.length === 0) {
    throw new Error('A cancel needs at least one order to take back.');
  }
  const addresses = new Set(orders.map((order) => venueRewardAddress(order.datum, LUCID_NETWORK[network])));
  if (addresses.size > 1) {
    throw new Error(
      `These ${orders.length} orders pay out to ${addresses.size} different addresses, and one transaction ` +
        'returns them to one place. Cancel each group of orders that share a reward address on its own — ' +
        `the addresses here are ${[...addresses].join(', ')}.`,
    );
  }
  return [...addresses][0] as string;
}

/** The distinct keys the transaction must declare, one per placer. */
export function venueCancelSigners(orders: readonly VenueSwapOrderUtxo[]): string[] {
  return [...new Set(orders.map((order) => order.datum.reward_pkh))];
}

/** Builds and submits an owner's cancel, for one order or for many. */
export class VenueCanceller {
  private readonly orderRef?: ResolvedReferenceScript;

  constructor(private readonly config: VenueCancellerConfig) {
    if ('referenceScript' in config.orderScript) {
      this.orderRef = resolveReferenceScript(
        config.orderScript.compiledScriptCbor,
        config.orderScript.referenceScript,
        MESH_NETWORK_ID[config.network],
      );
    }
  }

  /**
   * Builds the cancel. Returns the unsigned transaction, CBOR hex.
   *
   * The placer's key is declared as a required signer, which is what the
   * validator actually reads — a signature alone leaves `extra_signatories`
   * empty and the script refuses.
   */
  async build(
    orders: readonly VenueSwapOrderUtxo[],
    wallet: CurveSpendWallet,
    opts: { toAddress?: string } = {},
  ): Promise<string> {
    const destination = opts.toAddress ?? venueCancelDestination(orders, this.config.network);
    const seen = new Set<string>();
    for (const order of orders) {
      const key = `${order.txHash}#${order.outputIndex}`;
      if (seen.has(key)) {
        throw new Error(`This cancel names ${key} twice. A transaction spends each input once.`);
      }
      seen.add(key);
      if (this.orderRef && order.address !== this.orderRef.scriptAddress) {
        throw new Error(
          `Order ${key} sits at ${order.address}, but this canceller references an order validator whose ` +
            `address is ${this.orderRef.scriptAddress}. Spending it would need the validator that locks it.`,
        );
      }
    }

    const [collateral, walletUtxos] = await Promise.all([wallet.getCollateral(), wallet.getUtxos()]);
    const collateralUtxo: MeshUTxO | undefined = collateral[0];
    if (!collateralUtxo) {
      throw new Error(
        'The wallet has no collateral UTXO. A Plutus spend needs one — a pure-ada UTXO the wallet sets ' +
          'aside, which most wallets create on request.',
      );
    }

    const tx = new MeshTxBuilder({
      fetcher: this.config.provider as never,
      submitter: this.config.provider as never,
      ...(this.config.executionUnits ? {} : { evaluator: this.config.provider as never }),
      verbose: false,
    });

    for (const order of orders) {
      tx.spendingPlutusScriptV3().txIn(
        order.txHash,
        order.outputIndex,
        Object.entries(order.assets)
          .filter(([, quantity]) => quantity !== 0n)
          .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
        order.address,
        0,
      );
      if (this.orderRef) {
        tx.spendingTxInReference(
          this.orderRef.txHash,
          this.orderRef.outputIndex,
          String(this.orderRef.rawSizeBytes),
          this.orderRef.scriptHash,
        );
      } else if ('embeddedScriptCbor' in this.config.orderScript) {
        tx.txInScript(applyCborEncoding(this.config.orderScript.embeddedScriptCbor));
      }
      tx.txInInlineDatumPresent().txInRedeemerValue(
        venueCancelRedeemer(),
        'CBOR',
        this.config.executionUnits ?? VENUE_CANCEL_EXECUTION_UNITS,
      );
    }

    for (const hash of venueCancelSigners(orders)) tx.requiredSignerHash(hash);

    tx.txInCollateral(
      collateralUtxo.input.txHash,
      collateralUtxo.input.outputIndex,
      collateralUtxo.output.amount,
      collateralUtxo.output.address,
    )
      // Offered, unlike a fill: nothing here counts inputs, and an order that
      // could not pay its own network fee would otherwise have no way out.
      .selectUtxosFrom(walletUtxos)
      // Everything leaves as one output, to the address the orders name.
      .changeAddress(destination)
      .setNetwork(this.config.network);

    return await tx.complete();
  }

  /** Builds, signs and submits. Returns the transaction hash. */
  async submit(
    orders: readonly VenueSwapOrderUtxo[],
    wallet: CurveSpendWallet,
    opts: { toAddress?: string } = {},
  ): Promise<string> {
    const unsigned = await this.build(orders, wallet, opts);
    return wallet.submitTx(await wallet.signTx(unsigned));
  }
}
