// ============================================================================
// Noctis Zone — the transactions a community takeover is carried out with
// ============================================================================
// A passed takeover, a dissolve, and a disposition vote are each applied by
// spending the launch's own contracts, every one of them reading the launch's
// governance record as a reference input. This module is the one builder all
// of them share: a plan names the script inputs and their redeemers, the
// outputs, and any mint or withdraw-zero script, and this turns it into a
// transaction with Mesh.
//
// The plans themselves live beside the contracts they touch:
// `cto-disposition.ts` for vesting, `cto-takeover-effects.ts` for the rest.
// ============================================================================

import { Constr, Data } from '@lucid-evolution/lucid';
import {
  type Asset,
  applyCborEncoding,
  MeshTxBuilder,
  type UTxO as MeshUTxO,
  resolveNativeScriptHash,
  resolveSlotNo,
} from '@meshsdk/core';
import { toNativeScript } from '@meshsdk/core-cst';
import {
  type CurveNetwork,
  type CurveSpendProvider,
  type CurveSpendWallet,
  type PlanAssets,
  type PlanScriptUtxo,
  spendableForFees,
  type TxCoSigner,
} from './mesh-curve-spend.js';
import {
  MESH_NETWORK_ID,
  type ReferenceScriptPointer,
  resolveReferenceScript,
  scriptAddressOf,
  scriptHashOf,
} from './reference-script.js';
import { scriptRewardAddress } from './venue-stake-registration.js';
import { venuePoolRedeemer } from './venue-swap.js';

/** A script UTXO with its decoded inline datum. */
export interface DatumUtxo<D> extends PlanScriptUtxo {
  datum: D;
}

export type TakeoverScriptRole =
  | 'vesting'
  | 'stakingPool'
  | 'lpEscrow'
  | 'venuePool'
  | 'curve'
  | 'tokenMetadata'
  | 'redirect';

/** One script input, and the redeemer it is spent with. */
export interface TakeoverSpend {
  role: TakeoverScriptRole;
  utxo: PlanScriptUtxo;
  /**
   * CBOR hex, or the venue pool's action: its redeemer names the pool's own
   * INPUT position, which only exists once the funding inputs are chosen.
   */
  redeemer: { cbor: string } | { venuePoolAction: number };
}

export interface TakeoverOutput {
  address: string;
  /** Lovelace absent: the builder pays the protocol minimum for this output. */
  assets: PlanAssets;
  datumCbor: string;
}

/** `redirect.ak`'s `RedirectAction`: which way the pool's royalty key moves. */
export const REDIRECT_ACTION = { Takeover: 0, Dissolve: 1 } as const;

/** A transaction on a launch's contracts, described without a transaction library. */
export interface TakeoverTxPlan {
  /** What the transaction does, for the operator reading a result. */
  action: string;
  spends: TakeoverSpend[];
  /** Records read and never spent: the governance record, and the LP escrow on a dissolve's redirect. */
  referenceInputs: PlanScriptUtxo[];
  outputs: TakeoverOutput[];
  /** A new staking pool's thread NFT, under the governor's native policy. */
  mint?: { governorKeyHash: string; assetNameHex: string };
  /**
   * The venue's redirect, run as a withdraw-zero beside the pool spend. Its
   * redeemer names the pool's input position, like the pool's own.
   */
  withdrawal?: { role: 'redirect'; redirectAction: number };
  requiredSignerHashes: string[];
  validity?: { fromMs: number; toMs: number };
  /** Lovelace the paying wallet puts in beyond the fee: the LP disposition's pairing ADA. */
  fundingLovelace: bigint;
}

/** A validator, carried in the transaction or named by a published reference. */
export interface TakeoverScriptSource {
  /** Raw compiled CBOR, from the blueprint (or the applied record for a venue script). */
  compiledScriptCbor: string;
  referenceScript?: ReferenceScriptPointer;
}

export interface TakeoverBuilderConfig {
  network: CurveNetwork;
  /** Fetcher, and the script evaluator unless `executionUnits` is set. */
  provider: CurveSpendProvider;
  scripts: Partial<Record<TakeoverScriptRole, TakeoverScriptSource>>;
  /** Budgets to declare instead of evaluating: an operator's choice, never a default. */
  executionUnits?: { mem: number; steps: number };
}

function toMesh(assets: PlanAssets): Asset[] {
  return Object.entries(assets)
    .filter(([, quantity]) => quantity !== 0n)
    .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

/** Lovelace of fees and change the funding inputs carry beyond what the plan pays in. */
export const TAKEOVER_FEE_HEADROOM_LOVELACE = 5_000_000n;

export const inputKey = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;

/**
 * The paying wallet's inputs, chosen here rather than by the builder.
 *
 * The venue pool's redeemer, and the redirect's, name the pool's own position
 * among the inputs, and a builder that picks the funding inputs itself decides
 * that position after the redeemer was written. Choosing them first makes the
 * position knowable.
 */
export function chooseFundingInputs(utxos: readonly MeshUTxO[], needLovelace: bigint): MeshUTxO[] {
  const lovelaceOf = (u: MeshUTxO) => BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');
  const sorted = [...utxos].sort((a, b) =>
    lovelaceOf(b) > lovelaceOf(a) ? 1 : lovelaceOf(b) < lovelaceOf(a) ? -1 : 0,
  );
  const chosen: MeshUTxO[] = [];
  let total = 0n;
  for (const u of sorted) {
    if (total >= needLovelace) break;
    chosen.push(u);
    total += lovelaceOf(u);
  }
  if (total < needLovelace) {
    throw new Error(
      `The paying wallet holds ${total} lovelace it can spend, and this transaction needs ${needLovelace}.`,
    );
  }
  return chosen;
}

/** Position of `target` among `inputs` once the ledger sorts them. */
function sortedPosition(
  inputs: ReadonlyArray<{ txHash: string; outputIndex: number }>,
  target: { txHash: string; outputIndex: number },
): number {
  const sorted = [...inputs].sort((a, b) =>
    a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1,
  );
  return sorted.findIndex((i) => inputKey(i) === inputKey(target));
}

/**
 * Builds a takeover transaction, unsigned.
 *
 * `excludeInputs` keeps the paying wallet's outputs that an earlier
 * transaction in the same run already spent out of this one's funding, so
 * several can be built back to back before the first is indexed.
 */
export async function buildTakeoverTx(
  plan: TakeoverTxPlan,
  wallet: CurveSpendWallet,
  config: TakeoverBuilderConfig,
  opts: { excludeInputs?: ReadonlySet<string> } = {},
): Promise<{ txHex: string; fundingInputs: string[] }> {
  const networkId = MESH_NETWORK_ID[config.network];
  const [changeAddress, walletUtxos, collateral] = await Promise.all([
    wallet.getChangeAddress(),
    wallet.getUtxos(),
    wallet.getCollateral(),
  ]);
  const collateralUtxo = collateral[0];
  if (!collateralUtxo) {
    throw new Error(
      'The paying wallet has no collateral UTXO. A Plutus spend needs one: a pure-ada UTXO the wallet sets aside.',
    );
  }
  const spendable = spendableForFees(walletUtxos, collateralUtxo).filter(
    (u) => !opts.excludeInputs?.has(inputKey(u.input)),
  );
  const funding = chooseFundingInputs(spendable, plan.fundingLovelace + TAKEOVER_FEE_HEADROOM_LOVELACE);
  const allInputs = [...plan.spends.map((s) => s.utxo), ...funding.map((u) => u.input)];
  const poolSpend = plan.spends.find((s) => s.role === 'venuePool');
  const poolInIx = poolSpend ? sortedPosition(allInputs, poolSpend.utxo) : -1;

  const tx = new MeshTxBuilder({
    fetcher: config.provider as never,
    submitter: config.provider as never,
    ...(config.executionUnits ? {} : { evaluator: config.provider as never }),
    verbose: false,
  });

  for (const spend of plan.spends) {
    const source = config.scripts[spend.role];
    if (!source) throw new Error(`No ${spend.role} validator was given, so its input cannot be spent.`);
    tx.spendingPlutusScriptV3().txIn(
      spend.utxo.txHash,
      spend.utxo.outputIndex,
      toMesh(spend.utxo.assets),
      spend.utxo.address,
      0,
    );
    if (source.referenceScript) {
      const ref = resolveReferenceScript(source.compiledScriptCbor, source.referenceScript, networkId);
      if (spend.utxo.address !== ref.scriptAddress) {
        throw new Error(
          `The ${spend.role} UTXO sits at ${spend.utxo.address}, but its reference pointer holds a script whose ` +
            `address is ${ref.scriptAddress}.`,
        );
      }
      tx.spendingTxInReference(ref.txHash, ref.outputIndex, String(ref.rawSizeBytes), ref.scriptHash);
    } else {
      if (spend.utxo.address !== scriptAddressOf(source.compiledScriptCbor, networkId)) {
        throw new Error(`The ${spend.role} UTXO does not sit at the address of the ${spend.role} validator given.`);
      }
      tx.txInScript(applyCborEncoding(source.compiledScriptCbor));
    }
    const redeemer =
      'cbor' in spend.redeemer ? spend.redeemer.cbor : venuePoolRedeemer(spend.redeemer.venuePoolAction, poolInIx);
    tx.txInInlineDatumPresent().txInRedeemerValue(redeemer, 'CBOR', config.executionUnits);
  }

  for (const u of funding) tx.txIn(u.input.txHash, u.input.outputIndex, u.output.amount, u.output.address);
  for (const ref of plan.referenceInputs) tx.readOnlyTxInReference(ref.txHash, ref.outputIndex);

  if (plan.withdrawal) {
    const source = config.scripts[plan.withdrawal.role];
    if (!source) throw new Error(`No ${plan.withdrawal.role} validator was given, so it cannot run.`);
    if (poolInIx < 0) throw new Error('The redirect names the pool it rewrites, and this plan spends no pool.');
    const hash = scriptHashOf(source.compiledScriptCbor);
    tx.withdrawalPlutusScriptV3().withdrawal(scriptRewardAddress(config.network, hash), '0');
    if (source.referenceScript) {
      const ref = resolveReferenceScript(source.compiledScriptCbor, source.referenceScript, networkId);
      tx.withdrawalTxInReference(ref.txHash, ref.outputIndex, String(ref.rawSizeBytes), ref.scriptHash);
    } else {
      tx.withdrawalScript(applyCborEncoding(source.compiledScriptCbor));
    }
    tx.withdrawalRedeemerValue(
      Data.to(new Constr(plan.withdrawal.redirectAction, [BigInt(poolInIx)])),
      'CBOR',
      config.executionUnits,
    );
  }

  if (plan.mint) {
    const policy = { type: 'sig' as const, keyHash: plan.mint.governorKeyHash };
    tx.mint('1', resolveNativeScriptHash(policy), plan.mint.assetNameHex).mintingScript(
      toNativeScript(policy).toCbor(),
    );
  }

  for (const output of plan.outputs) {
    tx.txOut(output.address, toMesh(output.assets)).txOutInlineDatumValue(output.datumCbor, 'CBOR');
  }
  for (const hash of plan.requiredSignerHashes) tx.requiredSignerHash(hash);
  if (plan.validity) {
    tx.invalidBefore(Number(resolveSlotNo(config.network, plan.validity.fromMs)));
    tx.invalidHereafter(Number(resolveSlotNo(config.network, plan.validity.toMs)));
  }
  tx.txInCollateral(
    collateralUtxo.input.txHash,
    collateralUtxo.input.outputIndex,
    collateralUtxo.output.amount,
    collateralUtxo.output.address,
  )
    .selectUtxosFrom([])
    .changeAddress(changeAddress)
    .setNetwork(config.network);

  return { txHex: await tx.complete(), fundingInputs: funding.map((u) => inputKey(u.input)) };
}

/**
 * Builds, signs and submits. `coSigners` add the signatures the plan declares
 * beyond the paying wallet's own, such as the governor's on a new pool.
 */
export async function submitTakeoverTx(
  plan: TakeoverTxPlan,
  wallet: CurveSpendWallet,
  config: TakeoverBuilderConfig,
  coSigners: readonly TxCoSigner[] = [],
  opts: { excludeInputs?: ReadonlySet<string> } = {},
): Promise<{ txHash: string; fundingInputs: string[] }> {
  const { txHex, fundingInputs } = await buildTakeoverTx(plan, wallet, config, opts);
  let signed = await wallet.signTx(txHex);
  for (const coSigner of coSigners) signed = await coSigner.signTx(signed);
  return { txHash: await wallet.submitTx(signed), fundingInputs };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type BlockfrostUtxo = {
  tx_hash: string;
  output_index: number;
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  inline_datum: string | null;
};

/**
 * The one output at `address` holding `unit`, with its datum decoded; undefined
 * when there is none. `get` is a Blockfrost-shaped reader that throws with the
 * status in its message.
 */
export async function readByUnit<D>(
  get: (path: string) => Promise<unknown>,
  address: string,
  unit: string,
  schema: D,
  what: string,
): Promise<DatumUtxo<D> | undefined> {
  let found: BlockfrostUtxo[];
  try {
    found = (await get(`addresses/${address}/utxos/${unit}`)) as BlockfrostUtxo[];
  } catch (err) {
    if (/\b404\b/.test(String(err))) return undefined;
    throw err;
  }
  if (!Array.isArray(found) || found.length === 0) return undefined;
  if (found.length > 1) throw new Error(`More than one output at the ${what} address holds ${unit}.`);
  const utxo = found[0] as BlockfrostUtxo;
  if (!utxo.inline_datum) throw new Error(`The ${what} output carries no inline datum.`);
  const assets: PlanAssets = {};
  for (const { unit: u, quantity } of utxo.amount) assets[u] = (assets[u] ?? 0n) + BigInt(quantity);
  return {
    txHash: utxo.tx_hash,
    outputIndex: utxo.output_index,
    address: utxo.address,
    assets,
    datum: Data.from(utxo.inline_datum, schema),
  };
}
