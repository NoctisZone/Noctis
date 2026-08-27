// ============================================================================
// Noctis Zone — plan and submit one batch
// ============================================================================
// Reads a launch's curve and its open orders, decides what can be filled, and
// either reports the plan or submits it.
//
//   plan    what WOULD be filled, and why each of the rest was left out
//   submit  the same, then builds and submits the transaction
//
// `plan` touches no keys and moves nothing, so it is the honest thing to run
// first — a batch is all-or-nothing on chain, and knowing which orders were
// excluded is what turns a rejected batch into a fixable one.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout.
// ============================================================================

import { Blockfrost, Lucid } from '@lucid-evolution/lucid';
import { type CandidateOrder, planBatch } from '../batch-planner.js';
import { BatcherSubmitter } from '../batcher-submitter.js';
import { capAccumulatorFromHex } from '../cap-accumulator-tree.js';
import { selectLaunchUtxo } from '../launch-utxo-lookup.js';
import { OrderSubmitter } from '../order-submitter.js';
import type { BondingCurveDatumData, BondingCurveTierBDatumData } from '../tier-a-schemas.js';
import { BondingCurveDatumSchema, BondingCurveTierBDatumSchema } from '../tier-a-schemas.js';
import {
  CARDANO_NETWORK_MAP,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireField,
  requireFieldsFalsy,
} from './cli-io.js';

declare const __dirname: string;

interface Input {
  action: 'plan' | 'submit';
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  threadNftPolicyId: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  tier: 'A' | 'B';
  /**
   * Where this tier's curve validator is published, from
   * `publish-reference-script`. Required: a batch carries N cap proofs on top
   * of everything else, and with the curve embedded it does not fit.
   */
  curveReferenceScript: { txHash: string; outputIndex: number; scriptHash: string };
  /** Required for `submit` — the key the batch redeemer names as its batcher. */
  batcherMnemonic?: string;
  /** The scheduled batcher's way in: the platform's custody stores an
   *  encrypted extended key per role, never a mnemonic. Both must be given
   *  together; the submitter refuses a key that does not sign for the
   *  address. */
  batcherSkeyExtendedHex?: string;
  batcherAddress?: string;
  /** Lovelace kept from each fill's change. Bounded by that change. */
  batcherFeeLovelace?: string;
  maxOrders?: number;
  /** The launch's per-wallet running totals; omit for a curve never traded. */
  capState?: { keyHashHex: string; total: string }[];
  /** Overridable so a plan is reproducible; defaults to now. */
  nowMs?: number;
}

const CURVE_TITLE: Record<'A' | 'B', string> = {
  A: 'bonding_curve.bonding_curve.spend',
  B: 'bonding_curve_tier_b.bonding_curve_tier_b.spend',
};

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsFalsy(input, [
    'action',
    'network',
    'launchIdHex',
    'threadNftPolicyId',
    'blockfrostProjectId',
    'blockfrostUrl',
    'tier',
  ]);

  const blueprint = loadPlutusBlueprint(__dirname);
  const curveScriptCbor = loadValidatorCbor(blueprint, CURVE_TITLE[input.tier]);
  const orderScriptCbor = loadValidatorCbor(blueprint, 'curve_order.curve_order.spend');
  const network = CARDANO_NETWORK_MAP[input.network];

  const orders = new OrderSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network,
    compiledScriptCbor: orderScriptCbor,
    curveScriptCbor,
  });

  const batcher = new BatcherSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network,
    tier: input.tier,
    curveScriptCbor,
    orderScriptCbor,
    curveReferenceScript: requireField(input, 'curveReferenceScript'),
  });

  // The curve, through the same authenticated lookup every submitter uses:
  // the launch's thread NFT is what makes the UTXO the real one.
  const lucid = await Lucid(new Blockfrost(input.blockfrostUrl, input.blockfrostProjectId), network);
  const schema = input.tier === 'A' ? BondingCurveDatumSchema : BondingCurveTierBDatumSchema;
  const found = selectLaunchUtxo<BondingCurveDatumData | BondingCurveTierBDatumData>(
    await lucid.utxosAt(batcher.curveAddress),
    batcher.curveAddress,
    input.launchIdHex,
    input.tier === 'A' ? 'bondingCurve' : 'bondingCurveTierB',
    schema as never,
    input.threadNftPolicyId,
  );

  const open = await orders.openOrders(input.launchIdHex);
  const tokenUnit = found.datum.token_policy_id + found.datum.token_asset_name;

  const candidates: CandidateOrder[] = open.map(({ utxo, datum }) => ({
    txHash: utxo.txHash,
    outputIndex: utxo.outputIndex,
    ownerKeyHashHex: datum.owner,
    ownerStake: datum.owner_stake,
    isBuy: datum.is_buy,
    amount: datum.amount,
    minReceived: datum.min_received,
    maxSpend: datum.max_spend,
    deadlineMs: datum.deadline,
    heldLovelace: utxo.assets.lovelace ?? 0n,
    heldTokens: utxo.assets[tokenUnit] ?? 0n,
  }));

  const plan = planBatch({
    shape: input.tier === 'A' ? 'linear' : 'quadratic',
    curve: found.datum,
    capState: capAccumulatorFromHex(input.capState ?? []),
    orders: candidates,
    nowMs: BigInt(input.nowMs ?? Date.now()),
    ...(input.maxOrders ? { maxOrders: input.maxOrders } : {}),
  });

  const summary = {
    curveUtxo: `${found.utxo.txHash}#${found.utxo.outputIndex}`,
    openOrders: candidates.length,
    fills: plan.fills.map((f) => ({
      order: `${f.order.txHash}#${f.order.outputIndex}`,
      owner: f.order.ownerKeyHashHex,
      isBuy: f.order.isBuy,
      amount: f.order.amount,
      gross: f.gross,
      received: f.received,
      change: f.change,
    })),
    skipped: plan.skipped.map((s) => ({
      order: `${s.order.txHash}#${s.order.outputIndex}`,
      reason: s.reason,
      detail: s.detail,
    })),
    next: plan.next,
    curveLovelaceDelta: plan.curveLovelaceDelta,
    curveTokensSoldDelta: plan.curveTokensSoldDelta,
  };

  if (input.action === 'plan') {
    process.stdout.write(JSON.stringify(jsonSafe(summary)));
    return;
  }

  const submitParams = {
    curveUtxo: found.utxo,
    orderUtxos: open.map((o) => o.utxo),
    plan,
    ...(input.batcherFeeLovelace ? { batcherFeeLovelace: BigInt(input.batcherFeeLovelace) } : {}),
  };
  // Two ways to sign, one batch. The key pair is how the platform's scheduled
  // batcher runs (custody stores extended keys, not mnemonics); the mnemonic
  // stays for harness and hand-driven use.
  const result =
    input.batcherSkeyExtendedHex || input.batcherAddress
      ? await batcher.submitBatchWithKey(
          requireField(input, 'batcherSkeyExtendedHex', 'submit'),
          requireField(input, 'batcherAddress', 'submit'),
          submitParams,
        )
      : await batcher.submitBatch(requireField(input, 'batcherMnemonic', 'submit'), submitParams);

  process.stdout.write(JSON.stringify(jsonSafe({ ...summary, ...result })));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
