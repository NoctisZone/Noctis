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
import { type BatchPlan, type CandidateOrder, isScriptRefusal, planBatch, shrinkBatchAfter } from '../batch-planner.js';
import { BatcherSubmitter } from '../batcher-submitter.js';
import { capAccumulatorFromHex } from '../cap-accumulator-tree.js';
import { selectLaunchUtxo } from '../launch-utxo-lookup.js';
import { OrderSubmitter } from '../order-submitter.js';
import type { BondingCurveTierBDatumData } from '../tier-a-schemas.js';
import { BondingCurveTierBDatumSchema } from '../tier-a-schemas.js';
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
  tier: 'B';
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

const CURVE_TITLE = 'bonding_curve_tier_b.bonding_curve_tier_b.spend';

/**
 * Most builds one tick may try. Every attempt is a round of reads and an
 * evaluation, and the tick runs under a time limit; what does not fit in this
 * waits for the next tick rather than overrunning this one.
 */
const MAX_SUBMIT_ATTEMPTS = 6;

// The linear-curve path is retired, so the only tier this resolves is the
// quadratic one. Checked at runtime rather than left to the type: input
// arrives as JSON, and a retired tier silently resolving to a different
// validator would run this command against a contract nobody named.
function requireLiveTier(tier: string): void {
  if (tier !== 'B') {
    throw new Error(`tier must be "B" - the linear-curve path is retired (got "${tier}")`);
  }
}

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
  requireLiveTier(input.tier);

  const blueprint = loadPlutusBlueprint(__dirname);
  const curveScriptCbor = loadValidatorCbor(blueprint, CURVE_TITLE);
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
  const schema = BondingCurveTierBDatumSchema;
  const found = selectLaunchUtxo<BondingCurveTierBDatumData>(
    await lucid.utxosAt(batcher.curveAddress),
    batcher.curveAddress,
    input.launchIdHex,
    'bondingCurveTierB',
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

  // Orders a validator refused on their own this tick, by reference.
  const excluded = new Map<string, string>();
  const refOf = (o: { txHash: string; outputIndex: number }) => `${o.txHash}#${o.outputIndex}`;
  const planWith = (maxOrders?: number) =>
    planBatch({
      shape: 'quadratic',
      curve: found.datum,
      capState: capAccumulatorFromHex(input.capState ?? []),
      orders: candidates.filter((c) => !excluded.has(refOf(c))),
      nowMs: BigInt(input.nowMs ?? Date.now()),
      ...(maxOrders ? { maxOrders } : {}),
    });
  const summarise = (plan: BatchPlan) => ({
    curveUtxo: `${found.utxo.txHash}#${found.utxo.outputIndex}`,
    // Where this launch's orders wait. A scheduled tick reads that address's
    // newest transaction to tell whether anything arrived since it last found
    // nothing to fill: one read in place of a full plan.
    orderAddress: orders.orderAddress,
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
  });
  let plan = planWith(input.maxOrders);
  if (input.action === 'plan') {
    process.stdout.write(JSON.stringify(jsonSafe(summarise(plan))));
    return;
  }
  const submitPlan = (p: BatchPlan) => {
    const submitParams = {
      curveUtxo: found.utxo,
      orderUtxos: open.map((o) => o.utxo),
      plan: p,
      ...(input.batcherFeeLovelace ? { batcherFeeLovelace: BigInt(input.batcherFeeLovelace) } : {}),
    };
    return input.batcherSkeyExtendedHex || input.batcherAddress
      ? batcher.submitBatchWithKey(
          requireField(input, 'batcherSkeyExtendedHex', 'submit'),
          requireField(input, 'batcherAddress', 'submit'),
          submitParams,
        )
      : batcher.submitBatch(requireField(input, 'batcherMnemonic', 'submit'), submitParams);
  };
  // A batch refused whole is re-planned at half the size and tried again, down
  // to a single order (shrinkBatchAfter); a single order a validator still
  // refuses is left out of this tick and the rest are planned again
  // (isScriptRefusal). So a tick fills what fits, and no one order can keep
  // the others from filling.
  const shrunkFrom: number[] = [];
  let result: Awaited<ReturnType<typeof submitPlan>>;
  for (let attempt = 1; ; attempt++) {
    try {
      result = await submitPlan(plan);
      break;
    } catch (err) {
      if (attempt >= MAX_SUBMIT_ATTEMPTS) throw err;
      const smaller = shrinkBatchAfter(err, plan.fills.length);
      const only = plan.fills.length === 1 ? plan.fills[0] : undefined;
      if (smaller !== null) {
        shrunkFrom.push(plan.fills.length);
        plan = planWith(smaller);
      } else if (only && isScriptRefusal(err)) {
        excluded.set(refOf(only.order), err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200));
        plan = planWith(input.maxOrders);
      } else {
        throw err;
      }
      if (plan.fills.length === 0) throw err;
    }
  }

  // Said on stderr as well, which the scheduled tick writes to its log: a batch
  // that shrank or an order left out is worth seeing without a debugger.
  if (shrunkFrom.length || excluded.size) {
    process.stderr.write(
      `batch: filled ${plan.fills.length}` +
        (shrunkFrom.length ? `, shrunk from ${shrunkFrom.join(' → ')}` : '') +
        (excluded.size ? `, left out ${[...excluded.keys()].join(', ')}` : '') +
        '\n',
    );
  }
  process.stdout.write(
    JSON.stringify(
      jsonSafe({
        ...summarise(plan),
        ...result,
        ...(shrunkFrom.length ? { shrunkFrom } : {}),
        ...(excluded.size ? { excluded: [...excluded].map(([order, reason]) => ({ order, reason })) } : {}),
      }),
    ),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
