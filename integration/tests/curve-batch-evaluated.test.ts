// A batch as the batcher sends it, judged by the real validators with no node.
//
// The curve, its reference script and every order are served from memory, the
// transaction is assembled by the same `batchTransactionPlan` the batcher uses
// and built by the same Mesh spender, and Mesh's offline evaluator (Scalus)
// runs the compiled curve and order validators against it. A build that
// returns has been accepted by every script in it.
//
// What it measures is how large a batch the ledger admits, which is what
// MAX_ORDERS_PER_BATCH rests on: the execution memory every script in the
// batch spends together, and the transaction's size.

import { Data, type UTxO } from '@lucid-evolution/lucid';
import type { UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it } from 'vitest';
import { type CandidateOrder, MAX_ORDERS_PER_BATCH, planBatch } from '../batch-planner.js';
import { batchTransactionPlan } from '../batcher-submitter.js';
import { CapAccumulator } from '../cap-accumulator-tree.js';
import {
  type CurveBatchPlan,
  MeshCurveSpender,
  ORDER_BATCH_CHECK_REDEEMER,
  orderRewardAddress,
} from '../mesh-curve-spend.js';
import { MAX_TX_BYTES, scriptHashOf } from '../reference-script.js';
import { buildGenesisDatums } from '../tier-a-genesis-datums.js';
import {
  type BondingCurveTierBDatumData,
  BondingCurveTierBDatumSchema,
  type OrderDatumData,
  OrderDatumSchema,
  threadNftAssetName,
} from '../tier-a-schemas.js';
import {
  at,
  BLUEPRINT,
  COLLATERAL,
  evaluatingProvider,
  FUNDS,
  launchScript,
  payer,
  referenceOutput,
} from './support/takeover-chain.js';

/**
 * The per-transaction execution memory Preprod enforces, from a batch it
 * refused with `ExUnitsTooBigUTxO` (2026-09-25). Mainnet's is measured again
 * before a launch there.
 */
const MAX_TX_MEMORY = 17_500_000;
const MAX_TX_STEPS = 10_000_000_000;

/**
 * Bytes left for the batcher's own wallet: the inputs its coin selection adds
 * and its change. This fixture pays from a single UTXO, which understates
 * them, and a batch that fits only without them is refused on a real tick.
 */
const BATCHER_ROOM_BYTES = 512;

function fits(m: Measured): boolean {
  return m.memory < MAX_TX_MEMORY && m.steps < MAX_TX_STEPS && m.bytes + BATCHER_ROOM_BYTES < MAX_TX_BYTES;
}

const CURVE = launchScript('bonding_curve_tier_b.bonding_curve_tier_b.spend');
const ORDER = launchScript('curve_order.curve_order.spend');
const BATCHER = 'ba'.repeat(28);
const TOKEN_POLICY = '33'.repeat(28);
const THREAD_POLICY = '44'.repeat(28);

const genesis = await buildGenesisDatums({
  blueprint: BLUEPRINT as never,
  network: 'preprod',
  tier: 'B',
  creatorPubKeyHashHex: '11'.repeat(28),
  governorPubKeyHashHex: '22'.repeat(28),
  bondPayoutPubKeyHashHex: '55'.repeat(28),
  tokenPolicyIdHex: TOKEN_POLICY,
  tokenBaseNameHex: Buffer.from('BATCH').toString('hex'),
  tokenName: 'Batch',
  tokenDescription: 'A launch whose curve is traded in batches.',
  threadNftPolicyIdHex: THREAD_POLICY,
  poolNftPolicyIdHex: '66'.repeat(28),
  basePrice: 3,
  maxPrice: 75,
  creatorAllocPct: 5,
  vestDays: 180,
  batcherAllowlistHex: [BATCHER],
});
const TOKEN = TOKEN_POLICY + genesis.tokenAssetNameHex;
const CURVE_THREAD = THREAD_POLICY + threadNftAssetName('bondingCurveTierB', genesis.launchIdHex);

/** The launch's curve, open for trading, as the chain would hold it. */
const CURVE_DATUM: BondingCurveTierBDatumData = {
  ...Data.from<BondingCurveTierBDatumData>(genesis.datums.bondingCurve, BondingCurveTierBDatumSchema),
  curve_state: 'Active',
};
const CURVE_UTXO: UTxO = {
  txHash: 'c1'.repeat(32),
  outputIndex: 0,
  address: at(CURVE),
  assets: {
    lovelace: 5_000_000n,
    [CURVE_THREAD]: 1n,
    [TOKEN]: CURVE_DATUM.curve_supply + CURVE_DATUM.lp_reserve_tokens + CURVE_DATUM.staking_reserve_tokens,
  },
  datum: Data.to<BondingCurveTierBDatumData>(CURVE_DATUM, BondingCurveTierBDatumSchema),
};
const CURVE_REF = referenceOutput(CURVE, 0xc2);

/**
 * Each order is a different wallet's buy, as a busy curve's queue would be,
 * placed from a base address as an ordinary wallet's is: its payout carries the
 * stake credential too, which is what a real batch pays for in bytes.
 */
function order(i: number): { candidate: CandidateOrder; utxo: UTxO } {
  const owner = (0x70 + i).toString(16).repeat(28);
  const txHash = (0xa0 + i).toString(16).repeat(32);
  const amount = 2_000_000n;
  const held = 100_000_000n;
  const datum: OrderDatumData = {
    owner,
    owner_stake: { PubKeyCredential: [(0x50 + i).toString(16).repeat(28)] },
    launch_id: genesis.launchIdHex,
    curve_credential: { ScriptCredential: [scriptHashOf(CURVE)] },
    is_buy: true,
    amount,
    min_received: amount,
    max_spend: 90_000_000n,
    deadline: 9_999_999_999_999n,
    token_policy_id: TOKEN_POLICY,
    token_asset_name: genesis.tokenAssetNameHex,
  };
  return {
    candidate: {
      txHash,
      outputIndex: 0,
      ownerKeyHashHex: owner,
      ownerStake: datum.owner_stake,
      isBuy: true,
      amount,
      minReceived: amount,
      maxSpend: datum.max_spend,
      deadlineMs: datum.deadline,
      heldLovelace: held,
      heldTokens: 0n,
    },
    utxo: {
      txHash,
      outputIndex: 0,
      address: at(ORDER),
      assets: { lovelace: held },
      datum: Data.to<OrderDatumData>(datum, OrderDatumSchema),
    },
  };
}

function mesh(u: UTxO): MeshUTxO {
  return {
    input: { txHash: u.txHash, outputIndex: u.outputIndex },
    output: {
      address: u.address,
      amount: Object.entries(u.assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
      ...(u.datum ? { plutusData: u.datum } : {}),
    },
  };
}

interface Measured {
  txHex: string;
  bytes: number;
  memory: number;
  steps: number;
  redeemers: Array<{ tag: string; memory: number }>;
}

/**
 * Plans, assembles, builds and evaluates a batch of `n` buys. `tamper` edits
 * the transaction plan before it is built, for the batches that must fail.
 */
async function batchOf(n: number, tamper?: (plan: CurveBatchPlan) => void): Promise<Measured> {
  const orders = Array.from({ length: n }, (_, i) => order(i));
  const plan = planBatch({
    shape: 'quadratic',
    curve: CURVE_DATUM,
    capState: new CapAccumulator(),
    orders: orders.map((o) => o.candidate),
    nowMs: 1_000n,
    maxOrders: n,
  });
  expect(plan.fills).toHaveLength(n);

  const { plan: txPlan } = batchTransactionPlan({
    tier: 'B',
    network: 'Preprod',
    curveAddress: at(CURVE),
    orderAddress: at(ORDER),
    orderScriptCbor: ORDER,
    batcherKeyHash: BATCHER,
    params: { curveUtxo: CURVE_UTXO, orderUtxos: orders.map((o) => o.utxo), plan },
  });
  const known = [COLLATERAL, FUNDS, CURVE_REF, mesh(CURVE_UTXO), ...orders.map((o) => mesh(o.utxo))];
  const spender = new MeshCurveSpender({
    network: 'preprod',
    compiledScriptCbor: CURVE,
    referenceScript: { txHash: CURVE_REF.input.txHash, outputIndex: 0, scriptHash: scriptHashOf(CURVE) },
    provider: evaluatingProvider(known) as never,
  });
  tamper?.(txPlan);
  const txHex = await spender.buildBatch(txPlan, payer());

  const redeemers = (deserializeTx(txHex).witnessSet().redeemers()?.toCore() ?? []).map((r) => ({
    tag: String(r.purpose),
    memory: Number(r.executionUnits.memory),
    steps: Number(r.executionUnits.steps),
  }));
  return {
    txHex,
    bytes: txHex.length / 2,
    memory: redeemers.reduce((a, r) => a + r.memory, 0),
    steps: redeemers.reduce((a, r) => a + r.steps, 0),
    redeemers,
  };
}

const sizes = [1, 2, 4, MAX_ORDERS_PER_BATCH, MAX_ORDERS_PER_BATCH + 1];
const measured = new Map<number, Measured>();
for (const n of new Set(sizes)) measured.set(n, await batchOf(n));
const at_ = (n: number) => measured.get(n) as Measured;

describe('a batch the real validators accept', () => {
  it('carries one redeemer per script input and one for the order check', () => {
    // The curve, each order, and the zero withdrawal that runs the check.
    expect(at_(4).redeemers).toHaveLength(1 + 4 + 1);
    for (const r of at_(4).redeemers) expect(r.memory).toBeGreaterThan(0);
  });

  it('withdraws zero from the order validator’s own reward address', () => {
    const withdrawals = deserializeTx(at_(4).txHex).body().withdrawals();
    expect(withdrawals ? [...withdrawals.entries()] : []).toEqual([[orderRewardAddress(ORDER, 'preprod'), 0n]]);
    expect(ORDER_BATCH_CHECK_REDEEMER).toBe('d87980');
  });

  // What makes the rest of this file a measurement of real validators rather
  // than of a builder: the evaluator refuses a batch that only the order check
  // can object to. The curve is paid in full either way; the owner's change is
  // cut below what the order's max_spend leaves them.
  it('is refused when it keeps more of an order than the order may spend', async () => {
    await expect(
      batchOf(2, (plan) => {
        const first = plan.payouts[0];
        if (!first) throw new Error('no payout to tamper with');
        first.assets = { ...first.assets, lovelace: 9_000_000n };
      }),
    ).rejects.toThrow(/Tx evaluation failed/);
  });

  it('carries the order validator once, however many orders it spends', () => {
    expect(deserializeTx(at_(4).txHex).witnessSet().plutusV3Scripts()?.size()).toBe(1);
  });

  // The quantity the change is for. Before it, each order's own spend read
  // the whole batch, so every order made every other dearer and memory grew
  // with the square of the count: 3.1M for one order, 15.59M for four, and
  // five refused. Now what an order adds is its own share and no more.
  it('costs about the same again for each order it adds', () => {
    const perOrder = (at_(4).memory - at_(2).memory) / 2;
    const firstStep = at_(2).memory - at_(1).memory;
    expect(Math.abs(perOrder - firstStep) / firstStep).toBeLessThan(0.1);
  });

  it(`fits ${MAX_ORDERS_PER_BATCH} orders under the ledger’s limits`, () => {
    expect(fits(at_(MAX_ORDERS_PER_BATCH))).toBe(true);
  });

  // The constant is the LARGEST batch that fits, so the planner's first guess
  // is right and no tick spends an attempt on a batch the node refuses. The
  // next one is held back by size, not memory: the order validator travels
  // in every batch, and a batch one order larger leaves the batcher's wallet
  // too little room.
  it(`does not fit ${MAX_ORDERS_PER_BATCH + 1}`, () => {
    const over = at_(MAX_ORDERS_PER_BATCH + 1);
    expect(fits(over)).toBe(false);
    expect(over.memory).toBeLessThan(MAX_TX_MEMORY);
  });
});
