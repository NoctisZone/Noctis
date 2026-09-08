// venue-fill-submitter.test.ts — do the redeemers name the inputs the
// transaction actually ended up with?
//
// That is the whole question here, and it cannot be answered by checking what
// the builder was asked for. `Fill` carries `pool_in_ix` and `order_in_ix`,
// the builder SORTS inputs before serialising them, and a transaction whose
// inputs came out the other way round is still well-formed: both scripts run,
// each against the wrong input, and the node reports a script exiting early
// without naming either.
//
// So these tests build real transactions from the real compiled validators and
// decode the result — the redeemer bytes and the input list, compared against
// each other. Two fixtures differing only in which UTXO sorts first, because a
// prediction that is right in one order and wrong in the other passes half of
// the time and that is worse than being wrong.
//
// Everything is offline. The node is what decides whether a transaction is
// accepted; this decides whether it means what it says.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Constr, credentialToAddress, Data } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import { MAX_TX_BYTES, rawScriptSize, scriptAddressOf, scriptHashOf } from '../reference-script.js';
import {
  VENUE_FILL_EXECUTION_UNITS,
  VENUE_MIN_EXECUTOR_PAYOUT_LOVELACE,
  VenueFiller,
  type VenueFillPlan,
  venueInputPositions,
} from '../venue-fill-submitter.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import {
  planVenueSwapFill,
  VENUE_FILL_FLOOR_LOVELACE,
  VENUE_ORDER_EXECUTION_FEE_LOVELACE,
  VENUE_POOL_ACTION,
  type VenueSwapConfigData,
} from '../venue-swap.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string; hash?: string }>;
}
function load(file: string): Blueprint {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', file), 'utf8'));
}
function pick(blueprint: Blueprint, title: string) {
  const found = blueprint.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from the venue blueprint`);
  return found;
}

// The pool as it is actually deployed — applied with its parameter, so the
// size figures below are the deployed ones rather than a template's.
const POOL = pick(load(join('deployment', 'applied.json')), 'royalty_pool/pool.pool.spend');
const ORDER = pick(load('plutus.json'), 'royalty_pool/swap_order.swap_order.spend');
const POOL_HASH = scriptHashOf(POOL.compiledCode);
const ORDER_HASH = scriptHashOf(ORDER.compiledCode);
const POOL_ADDRESS = scriptAddressOf(POOL.compiledCode, 0);
const ORDER_ADDRESS = scriptAddressOf(ORDER.compiledCode, 0);

const EXECUTOR_KEY = '11'.repeat(28);
const EXECUTOR_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: EXECUTOR_KEY });
const PLACER_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: '0d'.repeat(28) });
const POOL_REF_TX = 'a1'.repeat(32);
const ORDER_REF_TX = 'a2'.repeat(32);

const TOKEN = `${'bb'.repeat(28)}746f6b656e`;
const LQ = `${'cc'.repeat(28)}6c71`;
const NFT = `${'aa'.repeat(28)}6e6674`;
const MAX_LQ = 0x7fffffffffffffffn;

// A pool the size a real graduation opens: 20,000 ADA against 200M tokens.
const POOL_LOVELACE = 20_000_000_000n;
const POOL_TOKENS = 200_000_000n;

function walletUtxo(txHash: string, lovelace: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: { address: EXECUTOR_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
  };
}

function fakeWallet(): CurveSpendWallet {
  return {
    getChangeAddress: vi.fn().mockResolvedValue(EXECUTOR_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue([walletUtxo('11'.repeat(32), '500000000')]),
    getCollateral: vi.fn().mockResolvedValue([walletUtxo('22'.repeat(32), '5000000')]),
    signTx: vi.fn().mockResolvedValue('signed'),
    submitTx: vi.fn().mockResolvedValue('submitted-hash'),
  };
}

function fakeProvider() {
  return {
    fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
    // The budgets `aiken tx simulate` reported for a real fill, so the fees
    // pinned below are the ones a real fill pays rather than a guess's.
    evaluateTx: vi.fn().mockResolvedValue([
      { tag: 'SPEND', index: 0, budget: VENUE_FILL_EXECUTION_UNITS },
      { tag: 'SPEND', index: 1, budget: VENUE_FILL_EXECUTION_UNITS },
    ]),
  };
}

function filler(opts: { carry?: boolean } = {}) {
  return new VenueFiller({
    network: 'preprod',
    poolScript: opts.carry
      ? { embeddedScriptCbor: POOL.compiledCode }
      : {
          compiledScriptCbor: POOL.compiledCode,
          referenceScript: { txHash: POOL_REF_TX, outputIndex: 0, scriptHash: POOL_HASH },
        },
    orderScript: opts.carry
      ? { embeddedScriptCbor: ORDER.compiledCode }
      : {
          compiledScriptCbor: ORDER.compiledCode,
          referenceScript: { txHash: ORDER_REF_TX, outputIndex: 0, scriptHash: ORDER_HASH },
        },
    provider: fakeProvider(),
  });
}

function datum(bytes: number): string {
  return Data.to(new Constr(0, ['aa'.repeat(bytes)]));
}

/**
 * One fill of 100 ADA into a 20,000-ADA pool.
 *
 * `poolTxHash` is the only thing the two fixtures below differ by: one sorts
 * before the order's `02…`, the other after.
 */
function plan(poolTxHash: string, orderLovelace = 103_000_000n, rewardLovelace = 1_500_000n): VenueFillPlan {
  return {
    pool: {
      txHash: poolTxHash,
      outputIndex: 0,
      address: POOL_ADDRESS,
      assets: { lovelace: POOL_LOVELACE, [TOKEN]: POOL_TOKENS, [LQ]: MAX_LQ - 1_000_000_000n, [NFT]: 1n },
    },
    order: {
      txHash: '02'.repeat(32),
      outputIndex: 0,
      address: ORDER_ADDRESS,
      assets: { lovelace: orderLovelace },
    },
    poolOutput: {
      address: POOL_ADDRESS,
      assets: {
        lovelace: POOL_LOVELACE + 100_000_000n,
        [TOKEN]: POOL_TOKENS - 985_222n,
        [LQ]: MAX_LQ - 1_000_000_000n,
        [NFT]: 1n,
      },
      datumCbor: datum(200),
    },
    successorOutput: {
      address: PLACER_ADDRESS,
      assets: { lovelace: rewardLovelace, [TOKEN]: 985_222n },
    },
  };
}

const POOL_SORTS_FIRST = '01'.repeat(32);
const POOL_SORTS_SECOND = '03'.repeat(32);

/**
 * The redeemer bodies, by input position, out of the finished transaction.
 *
 * Read from the serialised CBOR rather than from what the builder was handed,
 * because that is the only copy the node will ever see.
 */
function redeemersOf(txHex: string): Map<number, bigint[]> {
  const redeemers = deserializeTx(txHex).witnessSet().redeemers()?.values() ?? [];
  const out = new Map<number, bigint[]>();
  for (const r of redeemers) {
    const decoded = Data.from(r.data().toCbor()) as Constr<bigint>;
    out.set(Number(r.index()), decoded.fields);
  }
  return out;
}

function inputsOf(txHex: string) {
  return deserializeTx(txHex)
    .body()
    .inputs()
    .toCore()
    .map((i) => `${i.txId}#${i.index}`);
}

// ---------------------------------------------------------------------------

describe('predicting where the inputs land', () => {
  it('puts the smaller transaction id first, as the ledger orders them', () => {
    expect(venueInputPositions({ txHash: '01', outputIndex: 0 }, { txHash: '02', outputIndex: 0 })).toEqual({
      poolInIx: 0,
      orderInIx: 1,
    });
    expect(venueInputPositions({ txHash: '03', outputIndex: 0 }, { txHash: '02', outputIndex: 0 })).toEqual({
      poolInIx: 1,
      orderInIx: 0,
    });
  });

  it('separates two outputs of one transaction by index', () => {
    expect(venueInputPositions({ txHash: '02', outputIndex: 3 }, { txHash: '02', outputIndex: 1 })).toEqual({
      poolInIx: 1,
      orderInIx: 0,
    });
  });

  it('refuses a pool and an order that are the same UTXO', () => {
    expect(() => venueInputPositions({ txHash: '02', outputIndex: 0 }, { txHash: '02', outputIndex: 0 })).toThrow(
      /the same UTXO/,
    );
  });
});

describe('a fill, built', () => {
  it.each([
    ['when the pool sorts first', POOL_SORTS_FIRST, 0, 1],
    ['when the pool sorts second', POOL_SORTS_SECOND, 1, 0],
  ])('names the inputs the transaction really has, %s', async (_label, poolTxHash, poolIx, orderIx) => {
    const built = await filler().build(plan(poolTxHash), fakeWallet());

    // What the transaction ended up with…
    const inputs = inputsOf(built);
    expect(inputs).toHaveLength(2);
    expect(inputs[poolIx]).toBe(`${poolTxHash}#0`);
    expect(inputs[orderIx]).toBe(`${'02'.repeat(32)}#0`);

    // …and what its redeemers say about it. The pool's is
    // `PoolRedeemer { action, self_ix }`; the order's is
    // `Fill { pool_in_ix, order_in_ix, successor_ix }`.
    const redeemers = redeemersOf(built);
    expect(redeemers.get(poolIx)).toEqual([BigInt(VENUE_POOL_ACTION.Swap), BigInt(poolIx)]);
    expect(redeemers.get(orderIx)).toEqual([BigInt(poolIx), BigInt(orderIx), 1n]);
  });

  it('places the pool first and the placer second, and lets change follow', () => {
    // Outputs are never sorted and change is appended after them, which is
    // what makes `successor_ix: 1` a fact rather than a hope.
    return filler()
      .build(plan(POOL_SORTS_FIRST), fakeWallet())
      .then((built) => {
        const outputs = deserializeTx(built).body().outputs();
        expect(outputs.length).toBeGreaterThanOrEqual(2);
        expect(outputs[0]?.toCore().address).toBe(POOL_ADDRESS);
        expect(outputs[1]?.toCore().address).toBe(PLACER_ADDRESS);
      });
  });

  it('carries no script when both are referenced, and names both', async () => {
    const built = await filler().build(plan(POOL_SORTS_FIRST), fakeWallet());
    const tx = deserializeTx(built);
    expect(tx.witnessSet().plutusV3Scripts()?.size() ?? 0).toBe(0);
    const referenced = (tx.body().referenceInputs()?.toCore() ?? []).map((i) => `${i.txId}#${i.index}`);
    expect(referenced).toContain(`${POOL_REF_TX}#0`);
    expect(referenced).toContain(`${ORDER_REF_TX}#0`);
  });

  it('carries both validators when neither is published, and still fits', async () => {
    // Funded for the dearer shape: a carried fill pays the size fee on 7.3 KB
    // of script, and the order is the only thing paying for the fill.
    const funded = plan(POOL_SORTS_FIRST, 104_000_000n);
    const carried = await filler({ carry: true }).build(funded, fakeWallet());
    const referenced = await filler().build(funded, fakeWallet());
    expect(deserializeTx(carried).witnessSet().plutusV3Scripts()?.size()).toBe(2);

    // A fill is the one venue transaction that can carry its scripts — the two
    // together are under half the cap. Referencing is still the right default
    // because a carried script pays the per-byte SIZE fee on every fill, where
    // a referenced one pays the smaller surcharge; this pins the gap.
    const carriedBytes = carried.length / 2;
    const referencedBytes = referenced.length / 2;
    expect(carriedBytes).toBeLessThan(MAX_TX_BYTES);
    expect(carriedBytes - referencedBytes).toBeGreaterThan(
      rawScriptSize(POOL.compiledCode) + rawScriptSize(ORDER.compiledCode) - 100,
    );
  });

  it('stays well inside the size cap with both scripts referenced', async () => {
    const built = await filler().build(plan(POOL_SORTS_FIRST), fakeWallet());
    expect(built.length / 2).toBeLessThan(2_000);
  });
});

describe('what it will not build', () => {
  it('refuses a pool UTXO that does not sit at the referenced validator', async () => {
    const wrong = plan(POOL_SORTS_FIRST);
    wrong.pool.address = ORDER_ADDRESS;
    await expect(filler().build(wrong, fakeWallet())).rejects.toThrow(/references a pool validator whose address/);
  });

  it('refuses an order UTXO that does not sit at the referenced validator', async () => {
    const wrong = plan(POOL_SORTS_FIRST);
    wrong.order.address = POOL_ADDRESS;
    await expect(filler().build(wrong, fakeWallet())).rejects.toThrow(/references an order validator whose address/);
  });

  it('refuses to build without collateral, naming what is missing', async () => {
    const wallet = fakeWallet();
    wallet.getCollateral = vi.fn().mockResolvedValue([]);
    await expect(filler().build(plan(POOL_SORTS_FIRST), wallet)).rejects.toThrow(/no collateral UTXO/);
  });

  it('refuses an order that cannot pay for its own execution', async () => {
    // The same fill with the order's lovelace cut to exactly what it trades,
    // so there is nothing left for the network fee. No wallet UTXO is offered
    // to coin selection, so this cannot quietly become a third input.
    const broke = plan(POOL_SORTS_FIRST);
    broke.order.assets = { lovelace: 100_000_000n };
    broke.successorOutput.assets = { lovelace: 0n, [TOKEN]: 985_222n };
    await expect(filler().build(broke, fakeWallet())).rejects.toThrow();
  });
});

describe('what a fill costs, and who pays it', () => {
  // Every figure below is against Mesh's default protocol parameters, whose
  // fee inputs match the chain's — 44 per byte, 155,381 base, 15 per byte of
  // referenced script, 4,310 per byte of output. Its execution-unit CEILINGS
  // do not match the chain and are not used here.
  const TRADE = 100_000_000n;

  it('costs 428,654 lovelace with both scripts referenced, in 830 bytes', async () => {
    const built = await filler().build(plan(POOL_SORTS_FIRST), fakeWallet());
    expect(built.length / 2).toBe(830);
    expect(deserializeTx(built).body().fee()).toBe(428_654n);
  });

  it('costs a fifth more again when the scripts are carried', async () => {
    const funded = plan(POOL_SORTS_FIRST, 104_000_000n);
    const carried = await filler({ carry: true }).build(funded, fakeWallet());
    expect(deserializeTx(carried).body().fee()).toBe(639_509n);
    // 210,855 lovelace per fill, forever, for not publishing two scripts.
    expect(deserializeTx(carried).body().fee() - 428_654n).toBe(210_855n);
  });

  it('cannot pay the executor less than an output may hold', async () => {
    // 969,750 is where the builder stopped refusing, bisected against a real
    // fill. One lovelace under it and there is nowhere for the executor's
    // change to go: a fill has two inputs and neither is the executor's, so a
    // payout has to be an output and an output has a minimum.
    const feeOnly = 428_654n;
    const justUnder = plan(POOL_SORTS_FIRST, TRADE + 1_500_000n + feeOnly + 969_749n);
    const justOver = plan(POOL_SORTS_FIRST, TRADE + 1_500_000n + feeOnly + 969_750n);
    await expect(filler().build(justUnder, fakeWallet())).rejects.toThrow();
    await expect(filler().build(justOver, fakeWallet())).resolves.toBeTypeOf('string');
    expect(VENUE_MIN_EXECUTOR_PAYOUT_LOVELACE).toBeGreaterThan(969_750n);
  });

  it('charges what the fill costs and leaves the rest with the placer', async () => {
    // An order authorising 3 ADA of execution fee, filled at cost.
    const AUTHORISED = 3_000_000n;
    const orderLovelace = TRADE + 1_500_000n + AUTHORISED;
    const { txHex, executorFee, networkFee } = await filler().buildSettled(
      (fee) => plan(POOL_SORTS_FIRST, orderLovelace, 1_500_000n + (AUTHORISED - fee)),
      fakeWallet(),
    );
    expect(networkFee).toBe(428_654n);
    expect(executorFee).toBe(428_654n + VENUE_MIN_EXECUTOR_PAYOUT_LOVELACE);

    const outputs = deserializeTx(txHex).body().outputs();
    expect(outputs).toHaveLength(3);
    // The placer keeps what the executor did not need: 3 ADA authorised,
    // 1.428654 taken, 1.571346 returned on top of the 1.5 they set aside.
    expect(outputs[1]?.toCore().value.coins).toBe(1_500_000n + AUTHORISED - executorFee);
    expect(outputs[2]?.toCore().address).toBe(EXECUTOR_ADDRESS);
    expect(outputs[2]?.toCore().value.coins).toBe(executorFee - networkFee);
  });

  it('still names the right inputs after settling', async () => {
    const AUTHORISED = 3_000_000n;
    const { txHex } = await filler().buildSettled(
      (fee) => plan(POOL_SORTS_SECOND, TRADE + 1_500_000n + AUTHORISED, 1_500_000n + (AUTHORISED - fee)),
      fakeWallet(),
    );
    expect(redeemersOf(txHex).get(0)).toEqual([1n, 0n, 1n]);
    expect(inputsOf(txHex)[1]).toBe(`${POOL_SORTS_SECOND}#0`);
  });
});

describe('an order funded at the recommended fee', () => {
  // The dearest fill that can be constructed: a token-to-token pool (no ADA
  // side, so the placer's lovelace is its own balance), a placer with a stake
  // key (a bigger reward output), an executor the order names (an extra
  // signature and a required-signer entry) and an executor paying itself at a
  // base address (a bigger change output). Every dimension at once.
  const USDM_UNIT = `${'be'.repeat(28)}5553444d`;
  const EXEC_BASE = credentialToAddress(
    'Preprod',
    { type: 'Key', hash: EXECUTOR_KEY },
    { type: 'Key', hash: '99'.repeat(28) },
  );
  const PLACER_STAKE = '0e'.repeat(28);

  const dearPoolDatum: VenuePoolConfigData = {
    pool_nft: { policy: 'aa'.repeat(28), name: '6e6674' },
    pool_x: { policy: 'be'.repeat(28), name: '5553444d' },
    pool_y: { policy: 'bb'.repeat(28), name: '746f6b656e' },
    pool_lq: { policy: 'cc'.repeat(28), name: '6c71' },
    fee_num: 99_900n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    dao_policy: [
      { StakingHash: [{ ScriptCredential: ['d1'.repeat(28)] }] },
      { StakingHash: [{ ScriptCredential: ['d2'.repeat(28)] }] },
    ],
    treasury_address: 'ee'.repeat(57),
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
  };
  const dearPoolAssets = {
    lovelace: 3_000_000n,
    [USDM_UNIT]: 20_000_000_000n,
    [TOKEN]: 200_000_000n,
    [LQ]: MAX_LQ - 1_000_000_000n,
    [NFT]: 1n,
  };
  const dearSwap: VenueSwapConfigData = {
    pool_nft: { policy: 'aa'.repeat(28), name: '6e6674' },
    input: { policy: 'be'.repeat(28), name: '5553444d' },
    output: { policy: 'bb'.repeat(28), name: '746f6b656e' },
    tradable_input: 100_000_000n,
    base_price: { num: 0n, denom: 1n },
    min_marginal_output: 0n,
    ex_fee: VENUE_ORDER_EXECUTION_FEE_LOVELACE,
    reward_pkh: '0d'.repeat(28),
    stake_pkh: PLACER_STAKE,
    permitted_executors: [EXECUTOR_KEY],
  };

  function dearest(exFee: bigint) {
    const orderAssets = { lovelace: 1_500_000n + exFee, [USDM_UNIT]: 100_000_000n };
    const swap = { ...dearSwap, ex_fee: exFee };
    const fill = planVenueSwapFill({
      pool: {
        txHash: POOL_SORTS_FIRST,
        outputIndex: 0,
        address: POOL_ADDRESS,
        assets: dearPoolAssets,
        datum: dearPoolDatum,
      },
      order: { txHash: '02'.repeat(32), outputIndex: 0, address: ORDER_ADDRESS, assets: orderAssets, datum: swap },
      network: 'Preprod',
      minOutputLovelace: 1_000_000n,
    });
    const wallet = fakeWallet();
    wallet.getChangeAddress = vi.fn().mockResolvedValue(EXEC_BASE);
    return filler().build(
      {
        pool: { txHash: POOL_SORTS_FIRST, outputIndex: 0, address: POOL_ADDRESS, assets: dearPoolAssets },
        order: { txHash: '02'.repeat(32), outputIndex: 0, address: ORDER_ADDRESS, assets: orderAssets },
        poolOutput: {
          address: POOL_ADDRESS,
          assets: fill.poolAssets,
          datumCbor: Data.to(fill.poolDatum, VenuePoolConfigSchema),
        },
        successorOutput: { address: fill.successor.address, assets: fill.successor.assets },
        requiredSignerHashes: [EXECUTOR_KEY],
      },
      wallet,
    );
  }

  it('fills the dearest shape there is, with room to spare', async () => {
    const built = await dearest(VENUE_ORDER_EXECUTION_FEE_LOVELACE);
    expect(built.length / 2).toBeLessThan(1_300);
    expect(deserializeTx(built).body().outputs()).toHaveLength(3);
  });

  it('is the floor the constant records, to the lovelace', async () => {
    // 1,409,140 is where this builder stops refusing the shape. One lovelace
    // under it there is nowhere for the executor's payment to go: a fill has
    // two inputs, neither is the executor's, and an output has a minimum.
    //
    // An operator pinning the budgets instead of asking an evaluator for them
    // measured 1,409,932 — 792 more, because a declared budget prices slightly
    // differently from a measured one. `VENUE_FILL_FLOOR_LOVELACE` rounds up
    // past both, so a validator that grows fails here rather than in
    // production.
    await expect(dearest(1_409_140n)).resolves.toBeTypeOf('string');
    await expect(dearest(1_409_139n)).rejects.toThrow();
    expect(VENUE_FILL_FLOOR_LOVELACE).toBeGreaterThan(1_409_932n);
  });
});
