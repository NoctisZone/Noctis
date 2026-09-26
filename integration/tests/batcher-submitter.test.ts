// batcher-submitter.test.ts — the batch a plan turns into.
//
// The planner decides the economics and is tested on its own; the referenced
// builder is exercised against real compiled validators in
// mesh-curve-spend.test.ts. What is left to get wrong here is the SHAPE of the
// batch, and every way to get it wrong is silent:
//
//   - A redeemer built at the wrong constructor index does not complain about
//     indices. It decodes as some other redeemer entirely, and the failure is
//     about whatever that one checks. `BatchTrades` sits at a DIFFERENT index
//     on each tier, so this is a live hazard rather than a theoretical one.
//   - A payout missing its settlement tag, or carrying the wrong order's, is
//     an output the curve does not count as a fill.
//   - The curve embedded rather than referenced builds a transaction over the
//     size cap — measured at 17,991 bytes against 16,384, for two orders.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@lucid-evolution/lucid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucid-evolution/lucid')>();
  return {
    ...actual,
    Lucid: vi.fn(),
    Blockfrost: vi.fn(),
    Data: { ...actual.Data, from: vi.fn((d: unknown) => d), to: vi.fn((d: unknown) => d) },
  };
});

// The referenced builder is exercised for real, against real compiled
// validators, in mesh-curve-spend.test.ts. What matters here is the PLAN it is
// handed — which is also what the curve validator will re-derive.
const submitBatchSpy = vi.fn().mockResolvedValue('batch-tx');
vi.mock('../mesh-curve-spend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mesh-curve-spend.js')>();
  return {
    ...actual,
    MeshCurveSpender: class {
      submitBatch = submitBatchSpy;
    },
  };
});

vi.mock('@meshsdk/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meshsdk/core')>();
  return { ...actual, BlockfrostProvider: class {}, MeshWallet: class {} };
});

import { type Constr, credentialToAddress, Lucid } from '@lucid-evolution/lucid';
import { type BatchPlan, planBatch } from '../batch-planner.js';
import { BatcherSubmitter, REDEEMER_APPLY_ORDER, REDEEMER_BATCH_TRADES } from '../batcher-submitter.js';
import { bytesToHex, CAP_EMPTY_ROOT, CapAccumulator, hexToBytes } from '../cap-accumulator-tree.js';
import type { CurveBatchPlan } from '../mesh-curve-spend.js';

const blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
) as { definitions: Record<string, { anyOf?: Array<{ title?: string; index?: number }> }> };

const ALICE = 'aa'.repeat(28);
const BOB = 'bb'.repeat(28);
const BATCHER = 'ba'.repeat(28);
const BATCHER_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: BATCHER });
const TOKEN_POLICY = '33'.repeat(28);
const TOKEN_NAME = '746f6b';
const TOKEN_UNIT = TOKEN_POLICY + TOKEN_NAME;
const CURVE_TX = 'cc'.repeat(32);
const ORDER_TX = 'ee'.repeat(32);
const KEY = '<batcher-key-placeholder>';

function curveUtxo() {
  return {
    txHash: CURVE_TX,
    outputIndex: 0,
    address: 'addr_test1curve',
    datum: {
      launch_id: '01',
      creator_pub_key_hash: '99'.repeat(28),
      base_price: 100n,
      max_price: 1000n,
      curve_supply: 1000n,
      curve_state: 'Active',
      tokens_sold: 0n,
      total_raised: 0n,
      creator_fees_accrued: 0n,
      platform_fees_accrued: 0n,
      wallet_cap: 500n,
      token_policy_id: TOKEN_POLICY,
      token_asset_name: TOKEN_NAME,
      cap_root: bytesToHex(CAP_EMPTY_ROOT),
    },
    assets: { lovelace: 5_000_000n, [TOKEN_UNIT]: 1000n },
  } as never;
}

function orderUtxo(index: number, held = 500_000_000n) {
  return {
    txHash: ORDER_TX,
    outputIndex: index,
    address: 'addr_test1order',
    assets: { lovelace: held },
  } as never;
}

function buildPlan(orders: Array<{ owner: string; index: number; amount: bigint }>): BatchPlan {
  return planBatch({
    shape: 'linear',
    curve: {
      base_price: 100n,
      max_price: 1000n,
      curve_supply: 1000n,
      tokens_sold: 0n,
      total_raised: 0n,
      creator_fees_accrued: 0n,
      platform_fees_accrued: 0n,
      wallet_cap: 500n,
      cap_root: bytesToHex(CAP_EMPTY_ROOT),
      creator_pub_key_hash: '99'.repeat(28),
    },
    capState: new CapAccumulator(),
    orders: orders.map((o) => ({
      txHash: ORDER_TX,
      outputIndex: o.index,
      ownerKeyHashHex: o.owner,
      isBuy: true,
      amount: o.amount,
      minReceived: o.amount,
      maxSpend: 500_000_000n,
      deadlineMs: 9_999_999n,
      heldLovelace: 500_000_000n,
      heldTokens: 0n,
    })),
    nowMs: 1_000n,
  });
}

/** The plan the referenced builder was handed, for the last submitBatch call. */
function lastPlan(): CurveBatchPlan {
  const call = submitBatchSpy.mock.calls.at(-1);
  if (!call) throw new Error('submitBatch was never called');
  return call[0] as CurveBatchPlan;
}

/** `Data.to` is mocked to identity here, so a tag arrives as its decoded object. */
function tagIndexes(plan: CurveBatchPlan): bigint[] {
  return plan.payouts.map((p) => (p.datumCbor as unknown as { output_index: bigint }).output_index);
}

function makeSubmitter(tier: 'A' | 'B' = 'A') {
  vi.mocked(Lucid).mockResolvedValue({
    selectWallet: { fromSeed: vi.fn(), fromAPI: vi.fn(), fromAddress: vi.fn() },
    wallet: () => ({ address: vi.fn().mockResolvedValue(BATCHER_ADDRESS) }),
  } as never);
  return new BatcherSubmitter({
    blockfrostProjectId: 'proj',
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
    tier,
    curveScriptCbor: '590000',
    orderScriptCbor: '590001',
    // Never checked here — the spender is mocked, and the real staleness guard
    // has its own tests in reference-script.test.ts.
    curveReferenceScript: { txHash: 'ab'.repeat(32), outputIndex: 0, scriptHash: 'not-checked-here' },
  });
}

describe('the redeemer index, which fails silently when wrong', () => {
  it('matches what the quadratic curve’s blueprint declares', () => {
    const tierB = blueprint.definitions['bonding_curve_tier_b/BondingCurveTierBRedeemer']?.anyOf?.find(
      (v) => v.title === 'BatchTrades',
    );
    expect(REDEEMER_BATCH_TRADES.B).toBe(tierB?.index);
  });

  it('is genuinely different between the tiers, so one constant would be wrong', () => {
    expect(REDEEMER_BATCH_TRADES.A).not.toBe(REDEEMER_BATCH_TRADES.B);
  });

  it('matches curve_order’s ApplyOrder', () => {
    const apply = blueprint.definitions['curve_order/OrderRedeemer']?.anyOf?.find((v) => v.title === 'ApplyOrder');
    expect(REDEEMER_APPLY_ORDER).toBe(apply?.index);
  });

  for (const tier of ['A', 'B'] as const) {
    it(`builds the batch redeemer at Tier ${tier}’s own index`, async () => {
      await makeSubmitter(tier).submitBatch(KEY, {
        curveUtxo: curveUtxo(),
        orderUtxos: [orderUtxo(1)],
        plan: buildPlan([{ owner: ALICE, index: 1, amount: 100n }]),
      });
      const redeemer = lastPlan().redeemerCbor as unknown as Constr<unknown>;
      expect(redeemer.index).toBe(REDEEMER_BATCH_TRADES[tier]);
    });
  }
});

describe('the batch a plan turns into', () => {
  it('spends the curve and every order the plan names', async () => {
    await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1), orderUtxo(2)],
      plan: buildPlan([
        { owner: ALICE, index: 1, amount: 100n },
        { owner: BOB, index: 2, amount: 100n },
      ]),
    });
    const plan = lastPlan();
    expect(plan.scriptUtxo.txHash).toBe(CURVE_TX);
    expect(plan.orderInputs.map((i) => i.utxo.outputIndex)).toEqual([1, 2]);
  });

  // The curve is REFERENCED and the order validator carried. With the curve
  // embedded a two-order batch measured 17,991 bytes against a 16,384 cap, and
  // a spend cannot be split across transactions.
  it('carries the order validator and leaves the curve to its reference', async () => {
    await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1)],
      plan: buildPlan([{ owner: ALICE, index: 1, amount: 100n }]),
    });
    expect(lastPlan().orderScriptCbor).toBe('590001');
  });

  it('gives every order its own ApplyOrder redeemer', async () => {
    await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1), orderUtxo(2)],
      plan: buildPlan([
        { owner: ALICE, index: 1, amount: 100n },
        { owner: BOB, index: 2, amount: 100n },
      ]),
    });
    for (const input of lastPlan().orderInputs) {
      expect((input.redeemerCbor as unknown as Constr<unknown>).index).toBe(REDEEMER_APPLY_ORDER);
    }
  });

  it('pays each fill with the tag naming its own order', async () => {
    await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1), orderUtxo(2)],
      plan: buildPlan([
        { owner: ALICE, index: 1, amount: 100n },
        { owner: BOB, index: 2, amount: 100n },
      ]),
    });
    // Two fills and two lots of change, each tagged with its own order.
    expect(tagIndexes(lastPlan())).toEqual([1n, 1n, 2n, 2n]);
  });

  it('gives one owner’s two orders two separately tagged fills', async () => {
    await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1), orderUtxo(2)],
      plan: buildPlan([
        { owner: ALICE, index: 1, amount: 100n },
        { owner: ALICE, index: 2, amount: 100n },
      ]),
    });
    // The whole point: same owner, same amount, two distinguishable fills.
    expect(new Set(tagIndexes(lastPlan()))).toEqual(new Set([1n, 2n]));
  });

  it('returns each buyer’s unspent lovelace', async () => {
    const plan = buildPlan([{ owner: ALICE, index: 1, amount: 100n }]);
    await makeSubmitter().submitBatch(KEY, { curveUtxo: curveUtxo(), orderUtxos: [orderUtxo(1)], plan });
    expect(lastPlan().payouts[1]?.assets.lovelace).toBe(plan.fills[0]?.change);
  });

  // curve_order counts only what arrives ABOVE the lovelace the order itself
  // held toward the seller's minimum, so the payout carries that deposit back
  // with the proceeds: the seller receives everything their order held beyond
  // the tokens the curve took, and a sell priced near its bound still clears.
  it('pays a seller the proceeds and the deposit their order held', async () => {
    const deposit = 2_500_000n;
    const state = new CapAccumulator([{ key: hexToBytes(ALICE), total: 500n }]);
    const plan = planBatch({
      shape: 'linear',
      curve: {
        base_price: 100n,
        max_price: 1000n,
        curve_supply: 1000n,
        tokens_sold: 500n,
        total_raised: 0n,
        creator_fees_accrued: 0n,
        platform_fees_accrued: 0n,
        wallet_cap: 500n,
        cap_root: bytesToHex(state.root),
        creator_pub_key_hash: '99'.repeat(28),
      },
      capState: state,
      orders: [
        {
          txHash: ORDER_TX,
          outputIndex: 1,
          ownerKeyHashHex: ALICE,
          isBuy: false,
          amount: 100n,
          minReceived: 0n,
          maxSpend: 100n,
          deadlineMs: 9_999_999n,
          heldLovelace: deposit,
          heldTokens: 100n,
        },
      ],
      nowMs: 1_000n,
      minPayoutLovelace: 1n,
    });
    const net = plan.fills[0]?.received ?? 0n;
    expect(net).toBeGreaterThan(0n);
    await makeSubmitter().submitBatch(KEY, { curveUtxo: curveUtxo(), orderUtxos: [orderUtxo(1, deposit)], plan });
    expect(lastPlan().payouts[0]?.assets.lovelace).toBe(net + deposit);
    // Nothing unsold, so no token change comes back.
    expect(lastPlan().payouts).toHaveLength(1);
  });

  it('moves the curve’s own value by what the plan says', async () => {
    const plan = buildPlan([{ owner: ALICE, index: 1, amount: 100n }]);
    await makeSubmitter().submitBatch(KEY, { curveUtxo: curveUtxo(), orderUtxos: [orderUtxo(1)], plan });
    const assets = lastPlan().continuing.assets;
    expect(assets.lovelace).toBe(5_000_000n + plan.curveLovelaceDelta);
    expect(assets[TOKEN_UNIT]).toBe(1000n - plan.curveTokensSoldDelta);
  });

  it('requires the batcher’s signature, which the redeemer names', async () => {
    await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1)],
      plan: buildPlan([{ owner: ALICE, index: 1, amount: 100n }]),
    });
    const plan = lastPlan();
    expect(plan.requiredSignerHashes).toEqual([BATCHER]);
    const redeemer = plan.redeemerCbor as unknown as Constr<unknown>;
    expect((redeemer.fields as unknown[])[1]).toBe(BATCHER);
  });
});

describe('the batcher’s own fee', () => {
  it('comes out of the change, leaving the rest for the owner', async () => {
    const plan = buildPlan([{ owner: ALICE, index: 1, amount: 100n }]);
    const result = await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1)],
      plan,
      batcherFeeLovelace: 250_000n,
    });
    expect(result.batcherFeeTotal).toBe(250_000n);
    expect(lastPlan().payouts[1]?.assets.lovelace).toBe((plan.fills[0]?.change ?? 0n) - 250_000n);
  });

  it('cannot take more than the change, so a greedy fee is capped not stolen', async () => {
    const plan = buildPlan([{ owner: ALICE, index: 1, amount: 100n }]);
    const result = await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1)],
      plan,
      batcherFeeLovelace: 10_000_000_000n,
    });
    expect(result.batcherFeeTotal).toBe(plan.fills[0]?.change);
    // Nothing left over, so no change output is built at all.
    expect(lastPlan().payouts).toHaveLength(1);
  });

  it('takes nothing when asked for nothing', async () => {
    const plan = buildPlan([{ owner: ALICE, index: 1, amount: 100n }]);
    const result = await makeSubmitter().submitBatch(KEY, {
      curveUtxo: curveUtxo(),
      orderUtxos: [orderUtxo(1)],
      plan,
    });
    expect(result.batcherFeeTotal).toBe(0n);
    expect(lastPlan().payouts[1]?.assets.lovelace).toBe(plan.fills[0]?.change);
  });
});

describe('refusals', () => {
  it('will not build an empty batch', async () => {
    await expect(
      makeSubmitter().submitBatch(KEY, { curveUtxo: curveUtxo(), orderUtxos: [], plan: buildPlan([]) }),
    ).rejects.toThrow(/Nothing to batch/i);
  });

  it('will not build a batch missing one of its own order UTXOs', async () => {
    await expect(
      makeSubmitter().submitBatch(KEY, {
        curveUtxo: curveUtxo(),
        orderUtxos: [orderUtxo(1)],
        plan: buildPlan([
          { owner: ALICE, index: 1, amount: 100n },
          { owner: BOB, index: 2, amount: 100n },
        ]),
      }),
    ).rejects.toThrow(/no UTXO for it was supplied/i);
  });

  it('refuses a network whose slot configuration it cannot know', () => {
    expect(
      () =>
        new BatcherSubmitter({
          blockfrostProjectId: 'proj',
          blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
          network: 'Custom',
          tier: 'A',
          curveScriptCbor: '590000',
          orderScriptCbor: '590001',
          curveReferenceScript: { txHash: 'ab'.repeat(32), outputIndex: 0, scriptHash: 'x' },
        }),
    ).toThrow(/slot configuration/i);
  });
});
