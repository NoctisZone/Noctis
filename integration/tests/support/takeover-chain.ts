// A chain for takeover transactions to be judged against, with no node.
//
// Every UTXO a transaction touches is served from memory, and Mesh's offline
// evaluator (Scalus) runs the compiled validators — the blueprint's and the
// venue's applied record's — against what the builder produced. A build that
// returns has been accepted by every script in it; `buildEvaluated` also holds
// it to having carried a measured budget for each, so a transaction whose
// scripts never ran cannot pass for one that did.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialToAddress } from '@lucid-evolution/lucid';
import { applyCborEncoding, DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx, OfflineEvaluatorScalus, toScriptRef } from '@meshsdk/core-cst';
import { expect } from 'vitest';
import {
  buildTakeoverTx,
  type DatumUtxo,
  type TakeoverScriptRole,
  type TakeoverScriptSource,
  type TakeoverTxPlan,
} from '../../cto-takeover-tx.js';
import type { CurveSpendWallet } from '../../mesh-curve-spend.js';
import { scriptAddressOf, scriptHashOf } from '../../reference-script.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
type Blueprint = { validators: Array<{ title: string; compiledCode: string }> };
export const BLUEPRINT = JSON.parse(
  readFileSync(join(ROOT, 'contracts', 'cardano', 'plutus.json'), 'utf8'),
) as Blueprint;
const APPLIED = JSON.parse(
  readFileSync(join(ROOT, 'contracts', 'cardano-dex', 'deployment', 'applied.json'), 'utf8'),
) as Blueprint;

/** A launch-package validator's compiled code, by title. */
export function launchScript(title: string): string {
  const v = BLUEPRINT.validators.find((x) => x.title === title);
  if (!v) throw new Error(`${title} is not in the launch blueprint`);
  return v.compiledCode;
}

/** A venue validator's applied code, by title. */
export function venueScript(title: string): string {
  const v = APPLIED.validators.find((x) => x.title === title);
  if (!v) throw new Error(`${title} is not in the venue's applied record`);
  return v.compiledCode;
}

export const at = (script: string) => scriptAddressOf(script, 0);

export const PAYER = '99'.repeat(28);
export const PAYER_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: PAYER });

export const COLLATERAL: MeshUTxO = {
  input: { txHash: 'c0'.repeat(32), outputIndex: 0 },
  output: { address: PAYER_ADDRESS, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
};
export const FUNDS: MeshUTxO = {
  input: { txHash: 'f0'.repeat(32), outputIndex: 1 },
  output: { address: PAYER_ADDRESS, amount: [{ unit: 'lovelace', quantity: '12000000000' }] },
};

/** A wallet that pays and never signs: evaluation needs no signature. */
export function payer(utxos: MeshUTxO[] = [COLLATERAL, FUNDS]): CurveSpendWallet {
  return {
    getChangeAddress: async () => PAYER_ADDRESS,
    getUtxos: async () => utxos,
    getCollateral: async () => [COLLATERAL],
    signTx: async (tx) => tx,
    submitTx: async () => 'submitted',
  };
}

/** An output publishing `script`, as a site holds its reference scripts. */
export function referenceOutput(script: string, tag: number): MeshUTxO {
  return {
    input: { txHash: tag.toString(16).padStart(2, '0').repeat(32), outputIndex: 0 },
    output: {
      address: PAYER_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '60000000' }],
      scriptRef: toScriptRef({ code: applyCborEncoding(script), version: 'V3' }).toCbor(),
    },
  };
}

/** A script named by its published reference. */
export function referenced(script: string, output: MeshUTxO): TakeoverScriptSource {
  return {
    compiledScriptCbor: script,
    referenceScript: {
      txHash: output.input.txHash,
      outputIndex: output.input.outputIndex,
      scriptHash: scriptHashOf(script),
    },
  };
}

/** A state UTXO as the evaluator reads it, datum inline. */
export function onChain(u: DatumUtxo<unknown>, datumCbor: string): MeshUTxO {
  return {
    input: { txHash: u.txHash, outputIndex: u.outputIndex },
    output: {
      address: u.address,
      amount: Object.entries(u.assets).map(([unit, q]) => ({ unit, quantity: q.toString() })),
      plutusData: datumCbor,
    },
  };
}

/** A provider serving `known` and evaluating with Scalus. */
export function evaluatingProvider(known: MeshUTxO[]) {
  const fetcher = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchUTxOs: async (hash: string, index?: number) =>
      known.filter((u) => u.input.txHash === hash && (index === undefined || u.input.outputIndex === index)),
  };
  const evaluator = new OfflineEvaluatorScalus(fetcher as never, 'preprod');
  return {
    ...fetcher,
    evaluateTx: (tx: string, utxos?: MeshUTxO[], txs?: string[]) => evaluator.evaluateTx(tx, utxos, txs),
  };
}

/**
 * Builds against the in-memory chain and holds the result to having been
 * evaluated: one redeemer per script input and per withdraw-zero script, each
 * with a measured budget.
 */
export async function buildEvaluated(
  plan: TakeoverTxPlan,
  known: MeshUTxO[],
  scripts: Partial<Record<TakeoverScriptRole, TakeoverScriptSource>>,
): Promise<string> {
  const { txHex } = await buildTakeoverTx(plan, payer(), {
    network: 'preprod',
    provider: evaluatingProvider([COLLATERAL, FUNDS, ...known]),
    scripts,
  });
  const redeemers = deserializeTx(txHex).witnessSet().redeemers()?.toCore() ?? [];
  expect(redeemers).toHaveLength(plan.spends.length + (plan.withdrawal ? 1 : 0));
  for (const r of redeemers) expect(r.executionUnits.memory).toBeGreaterThan(0);
  return txHex;
}

/** The inline datum of a built transaction's output, CBOR hex. */
export function datumCborAt(txHex: string, index: number): string {
  return deserializeTx(txHex).body().outputs()[index]?.datum()?.asInlineData()?.toCbor() ?? '';
}

/** How much of `unit` output `index` carries. */
export function quantityIn(txHex: string, index: number, unit: string): bigint {
  return (
    deserializeTx(txHex)
      .body()
      .outputs()
      [index]?.amount()
      .toCore()
      .assets?.get(unit as never) ?? 0n
  );
}
