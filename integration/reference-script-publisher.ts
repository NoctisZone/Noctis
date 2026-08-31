// ============================================================================
// Noctis Zone — publishing a validator as a reference script
// ============================================================================
// Putting a validator on chain once, so every later spend can name it instead
// of carrying it. Three things about this are worth stating plainly, because
// each has already cost time:
//
//   - **It is a deposit, not a spend.** The output pays to our own address, so
//     the ada stays recoverable; what it buys is that the script sits there
//     permanently for anyone to reference. Because every Noctis validator is
//     unparameterized, ONE such output serves every launch of that tier
//     forever rather than one per launch.
//
//   - **The publishing transaction is bound by the same 16,384-byte cap as
//     any other, and the script must serialise whole into one output.** That
//     cannot be split the way a multi-validator spend can. `assertPublishable`
//     refuses before any ada moves rather than after a rejected submission.
//
//   - **Every change to a validator strands its published script.** The hash
//     moves, so the address moves, so the pointer no longer describes anything
//     spendable. Republishing is part of shipping a validator change, not an
//     afterthought — which is why this returns a pointer in exactly the shape
//     `resolveReferenceScript` checks.
//
// Coin selection is done by hand here, deliberately. Mesh's selector balks at
// a 16 KB output, and selection is not what makes this transaction interesting
// — one large input, one reference output, one change output.

import { applyCborEncoding, getUtxoMinLovelace, MeshTxBuilder, type UTxO as MeshUTxO } from '@meshsdk/core';
import type { CurveNetwork, CurveSpendProvider, CurveSpendWallet } from './mesh-curve-spend.js';
import {
  assertPublishable,
  MAX_TX_BYTES,
  type ReferenceScriptPointer,
  rawScriptSize,
  scriptHashOf,
} from './reference-script.js';

/**
 * Headroom above the ledger's own minimum, in basis points.
 *
 * The minimum is a function of the output's size and `coinsPerUtxoByte`, both
 * of which are known exactly — so this is not slack for uncertainty, it is
 * room for a protocol-parameter change to not strand a published script.
 */
const DEPOSIT_HEADROOM_BPS = 500n;

/**
 * What a reference output has to hold, for this script.
 *
 * A UTXO must hold at least the minimum its own size demands, and a script
 * UTXO is a large one: the rule works out at roughly 4,310 lovelace per byte,
 * so a 16 KB Cardano Launch curve needs about 69 ada and a 12 KB the linear curve curve about
 * 53.
 *
 * It is a DEPOSIT rather than a cost — spending the UTXO returns it — and it
 * is paid once per validator rather than once per launch, because none of
 * these validators takes parameters. Against the alternative it is cheap: an
 * embedded script is charged at `min_fee_a`, 44 lovelace per byte on EVERY
 * transaction, where a referenced one is charged 15. The deposit is repaid in
 * about 150 trades, and on Cardano Launch there is no alternative to weigh it against
 * at all.
 *
 * Computed from the script rather than fixed, because a flat figure large
 * enough for the biggest validator over-locks every smaller one — by 22 ada on
 * The linear curve curve and more than 45 on the others.
 */
export function referenceOutputLovelace(compiledScriptCbor: string, coinsPerUtxoSize?: number): bigint {
  const minimum = getUtxoMinLovelace(
    {
      // The address only affects the output's size, and every address this
      // codebase publishes from is a base address of the same shape.
      address: SIZING_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '75000000' }],
      scriptRef: applyCborEncoding(compiledScriptCbor),
    },
    coinsPerUtxoSize,
  );
  return minimum + (minimum * DEPOSIT_HEADROOM_BPS) / 10_000n;
}

/**
 * A representative address, used only to size the output.
 *
 * A base address is longer than an enterprise one, so sizing against a base
 * address never under-estimates for either.
 */
const SIZING_ADDRESS =
  'addr_test1qz7pgfuh7nfjaps7ywqcd2ajjftuygr2h8h8v63pqp089ncqh4ycvc329t9aspu2lcad7kt9mglxs0g6uyy44gvnl9dsk9jc6z';

/** Fee allowed for the publishing transaction. Generous; the surplus is change. */
const PUBLISH_FEE_LOVELACE = 1_500_000n;

/** Below this a chosen input cannot cover the output, the fee and a usable change. */
const MIN_CHANGE_LOVELACE = 1_000_000n;

export interface PublishReferenceScriptParams {
  network: CurveNetwork;
  /** Raw compiled CBOR from plutus.json. */
  compiledScriptCbor: string;
  /** Named in errors, so a failure says which validator it was about. */
  label: string;
  provider: CurveSpendProvider;
  wallet: CurveSpendWallet;
  /** Build and measure without submitting. */
  dryRun?: boolean;
}

export interface PublishReferenceScriptResult {
  /** Absent on a dry run — nothing was submitted. */
  txHash?: string;
  /** Where the script will live. Feed this straight to a spender's config. */
  pointer: ReferenceScriptPointer;
  /** Unsigned transaction size, against the cap. */
  unsignedBytes: number;
  rawScriptBytes: number;
  lockedLovelace: bigint;
}

function lovelaceOf(utxo: MeshUTxO): bigint {
  const entry = utxo.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '');
  return BigInt(entry?.quantity ?? '0');
}

/**
 * Publishes `compiledScriptCbor` as a reference script and returns a pointer
 * to it.
 *
 * The reference output is always output 0, so the pointer is known before the
 * transaction is submitted — which is what lets a dry run report the pointer a
 * real run would produce.
 */
export async function publishReferenceScript(
  params: PublishReferenceScriptParams,
): Promise<PublishReferenceScriptResult> {
  const { compiledScriptCbor, label } = params;
  assertPublishable(compiledScriptCbor, label);

  const wrapped = applyCborEncoding(compiledScriptCbor);
  const scriptHash = scriptHashOf(compiledScriptCbor);

  const [changeAddress, utxos] = await Promise.all([params.wallet.getChangeAddress(), params.wallet.getUtxos()]);

  // A published reference script lives in an ordinary UTXO at the publishing
  // wallet's own address, so it is a perfectly valid input to spend — and
  // spending it DESTROYS the script, silently, while the transaction succeeds.
  // Every launch pointing at it then breaks. So these are excluded from
  // selection entirely rather than merely sorted below the others.
  const spendable = utxos.filter((u) => !u.output.scriptRef && !u.output.scriptHash);

  // Largest first among what is left: this needs one input big enough to cover
  // the whole deposit, and combining several only makes the transaction bigger
  // for no benefit.
  const chosen = [...spendable].sort((a, b) => Number(lovelaceOf(b) - lovelaceOf(a)))[0];
  if (!chosen) {
    const held = utxos.length - spendable.length;
    throw new Error(
      `Cannot publish ${label}: the wallet has no UTXOs that are safe to spend` +
        (held > 0
          ? ` — all ${utxos.length} of them carry a reference script, and spending one would destroy it.`
          : '.'),
    );
  }

  const deposit = referenceOutputLovelace(compiledScriptCbor);
  const available = lovelaceOf(chosen);
  const change = available - deposit - PUBLISH_FEE_LOVELACE;
  if (change < MIN_CHANGE_LOVELACE) {
    throw new Error(
      `Cannot publish ${label}: the wallet's largest UTXO holds ${available} lovelace, which does not ` +
        `cover the ${deposit} deposit plus fee and leave a usable change output. ` +
        'Consolidate the wallet, or fund it.',
    );
  }

  const tx = new MeshTxBuilder({
    fetcher: params.provider as never,
    submitter: params.provider as never,
    verbose: false,
  });

  tx.txIn(chosen.input.txHash, chosen.input.outputIndex, chosen.output.amount, chosen.output.address, 0)
    // Output 0 carries the script. Everything downstream assumes index 0, so
    // this must stay the first output.
    .txOut(changeAddress, [{ unit: 'lovelace', quantity: deposit.toString() }])
    .txOutReferenceScript(wrapped, 'V3')
    .txOut(changeAddress, [{ unit: 'lovelace', quantity: change.toString() }])
    .setFee(PUBLISH_FEE_LOVELACE.toString())
    .changeAddress(changeAddress)
    .setNetwork(params.network);

  // Balanced above by hand, so the unbalanced completion is the whole
  // transaction rather than a stage of one.
  const unsigned = tx.completeUnbalanced();
  const unsignedBytes = unsigned.length / 2;
  if (unsignedBytes > MAX_TX_BYTES) {
    throw new Error(
      `Cannot publish ${label}: the publishing transaction is ${unsignedBytes} bytes, over the ` +
        `${MAX_TX_BYTES} cap. The script has to serialise whole into one output, so this cannot be ` +
        'split across transactions.',
    );
  }

  const base = {
    unsignedBytes,
    rawScriptBytes: rawScriptSize(compiledScriptCbor),
    lockedLovelace: deposit,
  };

  if (params.dryRun) {
    return { ...base, pointer: { txHash: '', outputIndex: 0, scriptHash } };
  }

  const signed = await params.wallet.signTx(unsigned);
  const txHash = await params.wallet.submitTx(signed);
  return { ...base, txHash, pointer: { txHash, outputIndex: 0, scriptHash } };
}
