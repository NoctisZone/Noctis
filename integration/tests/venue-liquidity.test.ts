// venue-liquidity.test.ts — does a deposit or a redeem pay out exactly what
// the two validators will accept?
//
// The figures in the first two groups are not this file's own. They are the
// passing cases in `deposit_order.ak` and `redeem_order.ak`'s Aiken tests —
// the same pool, the same requests — and each planner is held to the reward
// those tests pass with, to the unit. The validators' failing cases sit one
// unit below those rewards, so a planner that paid one unit less would be
// building transactions the chain refuses, and one that paid more would be
// giving away the executor's or the pool's value. The pool's own rule is
// checked beside it, in the form `pool.ak` states it.
//
// After that: the request drafts a front end signs, the refusals, the reader
// and the batcher, and real transactions built offline from the compiled
// validators with their redeemers read back out of the CBOR.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Constr, credentialToAddress, Data } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import { scriptAddressOf, scriptHashOf } from '../reference-script.js';
import { VenueBatcher } from '../venue-batcher.js';
import { type ProviderUtxo, readVenueLiquidityOrders, type VenueChainProvider } from '../venue-chain-reader.js';
import { VENUE_FILL_EXECUTION_UNITS, VenueFiller, type VenueFillPlan } from '../venue-fill-submitter.js';
import {
  draftVenueDepositOrder,
  draftVenueRedeemOrder,
  planVenueDepositFill,
  planVenueRedeemFill,
  VENUE_DEPOSIT_ORDER_TITLE,
  VENUE_REDEEM_ORDER_TITLE,
  type VenueDepositConfigData,
  VenueDepositConfigSchema,
  type VenueDepositOrderUtxo,
  type VenueRedeemConfigData,
  VenueRedeemConfigSchema,
  type VenueRedeemOrderUtxo,
  venueApplyRedeemer,
  venueDepositPair,
  venueDepositSplit,
  venueKeyAddress,
  venueLiquidityFillable,
  venueRefundRedeemer,
} from '../venue-liquidity.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import {
  VENUE_POOL_ACTION,
  type VenuePoolUtxo,
  type VenueSwapConfigData,
  VenueSwapConfigSchema,
  venueUnitOf,
} from '../venue-swap.js';

const MAX_LQ = 0x7fffffffffffffffn;

// ---------------------------------------------------------------------------
// The validators' own fixture: 100M ADA / 100M Y net of the counters, and
// 1,000,000 LQ in circulation. Policies are one byte, exactly as the Aiken
// tests write them — the arithmetic does not care, and the point is to be the
// same pool.
// ---------------------------------------------------------------------------

const ADA = { policy: '', name: '' };
const TOK = { policy: 'bb', name: '746f6b656e' };
const LQA = { policy: 'cc', name: '6c71' };
const NFTA = { policy: 'aa', name: '6e6674' };
const TOK_UNIT = venueUnitOf(TOK);
const LQ_UNIT = venueUnitOf(LQA);
const NFT_UNIT = venueUnitOf(NFTA);
const PLACER = '0d'.repeat(28);
const STAKE = '0e'.repeat(28);

function aikenPoolDatum(): VenuePoolConfigData {
  return {
    pool_nft: NFTA,
    pool_x: ADA,
    pool_y: TOK,
    pool_lq: LQA,
    fee_num: 99_700n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 500_000n,
    treasury_y: 0n,
    royalty_x: 500_000n,
    royalty_y: 250_000n,
    dao_policy: [],
    treasury_address: 'ee',
    royalty_pub_key: 'ff',
    nonce: 3n,
  };
}

function aikenPool(): VenuePoolUtxo {
  return {
    txHash: '01'.repeat(32),
    outputIndex: 0,
    address: 'addr_test1_pool',
    assets: { lovelace: 101_000_000n, [TOK_UNIT]: 100_250_000n, [LQ_UNIT]: MAX_LQ - 1_000_000n, [NFT_UNIT]: 1n },
    datum: aikenPoolDatum(),
  };
}

function aikenDeposit(yAmount: bigint, lovelace = 13_000_000n): VenueDepositOrderUtxo {
  return {
    kind: 'deposit',
    txHash: '02'.repeat(32),
    outputIndex: 0,
    address: 'addr_test1_deposit',
    assets: { lovelace, [TOK_UNIT]: yAmount },
    datum: {
      pool_nft: NFTA,
      x: ADA,
      y: TOK,
      lq: LQA,
      ex_fee: 1_000_000n,
      reward_pkh: PLACER,
      stake_pkh: STAKE,
      collateral_ada: 2_000_000n,
    },
  };
}

function aikenRedeem(): VenueRedeemOrderUtxo {
  return {
    kind: 'redeem',
    txHash: '02'.repeat(32),
    outputIndex: 0,
    address: 'addr_test1_redeem',
    assets: { lovelace: 3_000_000n, [LQ_UNIT]: 100_000n },
    datum: { pool_nft: NFTA, x: ADA, y: TOK, lq: LQA, ex_fee: 1_000_000n, reward_pkh: PLACER, stake_pkh: null },
  };
}

/** `pool.ak`'s `deposit_redeem_ok`, as it is written there. */
function poolAccepts(dx: bigint, dy: bigint, dlq: bigint): boolean {
  const rx0 = 100_000_000n;
  const ry0 = 100_000_000n;
  const lq0 = 1_000_000n;
  return lq0 > 0n && dlq * rx0 <= dx * lq0 && dlq * ry0 <= dy * lq0;
}

// The executor takes the whole fee in the validators' tests, so the planners
// are held to them at that fee.
const WHOLE_FEE = 1_000_000n;

describe('a deposit pays what deposit_order.ak accepts', () => {
  it('balanced: 10 ADA and 10M Y buy 100,000 LQ, and the 2 ADA collateral comes back', () => {
    const fill = planVenueDepositFill({
      pool: aikenPool(),
      order: aikenDeposit(10_000_000n),
      network: 'Preprod',
      executorFee: WHOLE_FEE,
      minOutputLovelace: 1_000_000n,
    });
    // `balanced_deposit_passes`
    expect(fill.reward.assets).toEqual({ lovelace: 2_000_000n, [LQ_UNIT]: 100_000n });
    expect(fill.lq).toBe(100_000n);
    expect(poolAccepts(fill.xDelta, fill.yDelta, fill.lq)).toBe(true);
  });

  it('token side larger: the 2,000,000 Y surplus comes back', () => {
    const fill = planVenueDepositFill({
      pool: aikenPool(),
      order: aikenDeposit(12_000_000n),
      network: 'Preprod',
      executorFee: WHOLE_FEE,
      minOutputLovelace: 1_000_000n,
    });
    // `lopsided_deposit_returns_the_surplus` passes with exactly this, and
    // `lopsided_deposit_keeping_the_surplus_fails` one token below it.
    expect(fill.reward.assets).toEqual({ lovelace: 2_000_000n, [LQ_UNIT]: 100_000n, [TOK_UNIT]: 2_000_000n });
    expect(fill.yDelta).toBe(10_000_000n);
    expect(poolAccepts(fill.xDelta, fill.yDelta, fill.lq)).toBe(true);
  });

  it('ADA side larger: 5 ADA of change and the 2 ADA collateral come back together', () => {
    const fill = planVenueDepositFill({
      pool: aikenPool(),
      order: aikenDeposit(5_000_000n),
      network: 'Preprod',
      executorFee: WHOLE_FEE,
      minOutputLovelace: 1_000_000n,
    });
    // `ada_surplus_deposit_returns_the_change_and_the_collateral` passes at
    // 7,000,000; `…one_lovelace_short_fails` at 6,999,999.
    expect(fill.reward.assets).toEqual({ lovelace: 7_000_000n, [LQ_UNIT]: 50_000n });
    expect(fill.xDelta).toBe(5_000_000n);
    expect(poolAccepts(fill.xDelta, fill.yDelta, fill.lq)).toBe(true);
  });

  it('pays one more LQ than the pool allows, and the pool refuses it', () => {
    const fill = planVenueDepositFill({
      pool: aikenPool(),
      order: aikenDeposit(10_000_000n),
      network: 'Preprod',
      executorFee: WHOLE_FEE,
      minOutputLovelace: 1_000_000n,
    });
    // The planned figure is the pool's ceiling, not a figure under it.
    expect(poolAccepts(fill.xDelta, fill.yDelta, fill.lq + 1n)).toBe(false);
  });

  it('returns the part of the fee a settled fill does not use', () => {
    const fill = planVenueDepositFill({
      pool: aikenPool(),
      order: aikenDeposit(10_000_000n),
      network: 'Preprod',
      executorFee: 400_000n,
      minOutputLovelace: 1_000_000n,
    });
    expect(fill.exFeeTaken).toBe(400_000n);
    expect(fill.reward.assets.lovelace).toBe(2_600_000n);
  });

  it('pays the reward to the placer’s payment and stake keys', () => {
    const fill = planVenueDepositFill({
      pool: aikenPool(),
      order: aikenDeposit(10_000_000n),
      network: 'Preprod',
      executorFee: WHOLE_FEE,
      minOutputLovelace: 1_000_000n,
    });
    expect(fill.reward.address).toBe(
      credentialToAddress('Preprod', { type: 'Key', hash: PLACER }, { type: 'Key', hash: STAKE }),
    );
  });

  it('moves the pool by the gross amounts and leaves its counters where they were', () => {
    const fill = planVenueDepositFill({
      pool: aikenPool(),
      order: aikenDeposit(10_000_000n),
      network: 'Preprod',
      executorFee: WHOLE_FEE,
      minOutputLovelace: 1_000_000n,
    });
    expect(fill.poolAssets).toEqual({
      lovelace: 111_000_000n,
      [TOK_UNIT]: 110_250_000n,
      [LQ_UNIT]: MAX_LQ - 1_100_000n,
      [NFT_UNIT]: 1n,
    });
  });
});

describe('a redeem pays what redeem_order.ak accepts', () => {
  it('100,000 LQ is worth 10M of each side, and the 2 ADA collateral comes back on top', () => {
    const fill = planVenueRedeemFill({
      pool: aikenPool(),
      order: aikenRedeem(),
      network: 'Preprod',
      executorFee: WHOLE_FEE,
      minOutputLovelace: 1_000_000n,
    });
    // `fair_reward()` in the redeem tests.
    expect(fill.reward.assets).toEqual({ lovelace: 12_000_000n, [TOK_UNIT]: 10_000_000n });
    expect(fill.reward.address).toBe(credentialToAddress('Preprod', { type: 'Key', hash: PLACER }));
    expect(poolAccepts(fill.xDelta, fill.yDelta, -fill.lq)).toBe(true);
    expect(fill.poolAssets).toEqual({
      lovelace: 91_000_000n,
      [TOK_UNIT]: 90_250_000n,
      [LQ_UNIT]: MAX_LQ - 900_000n,
      [NFT_UNIT]: 1n,
    });
  });

  it('pays out no more than the pool allows', () => {
    const fill = planVenueRedeemFill({
      pool: aikenPool(),
      order: aikenRedeem(),
      network: 'Preprod',
      executorFee: WHOLE_FEE,
      minOutputLovelace: 1_000_000n,
    });
    expect(poolAccepts(fill.xDelta - 1n, fill.yDelta, -fill.lq)).toBe(false);
  });
});

describe('the split, on its own', () => {
  it('takes from each side the least that pays for the LQ, rounding in the pool’s favour', () => {
    // A pool of 10 and 10 against 3 LQ. 7 lovelace buys floor(21 / 10) = 2 LQ,
    // and 2 LQ costs 20 / 3 = 6.67 of each side, so 7 goes in, not 6: at 6 the
    // pool's own rule (2 × 10 ≤ 6 × 3) fails.
    const split = venueDepositSplit({ depositX: 7n, depositY: 100n, reservesX: 10n, reservesY: 10n, liquidity: 3n });
    expect(split.lq).toBe(2n);
    expect(split.xIn).toBe(7n);
    expect(split.yIn).toBe(7n);
    expect(split.xBack).toBe(0n);
    expect(split.yBack).toBe(93n);
  });

  it('never takes more of a side than was deposited', () => {
    for (const [dx, dy] of [
      [1n, 1n],
      [999n, 3n],
      [3n, 999n],
      [123_457n, 98_765n],
    ] as const) {
      const split = venueDepositSplit({
        depositX: dx,
        depositY: dy,
        reservesX: 1_000_003n,
        reservesY: 7_777_777n,
        liquidity: 55_555n,
      });
      expect(split.xIn).toBeLessThanOrEqual(dx);
      expect(split.yIn).toBeLessThanOrEqual(dy);
      expect(split.lq * 1_000_003n).toBeLessThanOrEqual(split.xIn * 55_555n);
      expect(split.lq * 7_777_777n).toBeLessThanOrEqual(split.yIn * 55_555n);
    }
  });
});

describe('what it refuses', () => {
  it('a request for a different pool', () => {
    const order = aikenDeposit(10_000_000n);
    order.datum = { ...order.datum, pool_nft: { policy: 'aa', name: '6f74686572' } };
    expect(() =>
      planVenueDepositFill({ pool: aikenPool(), order, network: 'Preprod', minOutputLovelace: 1_000_000n }),
    ).toThrow(/only ever be filled against the pool it named/);
  });

  it('a request holding an asset it does not name', () => {
    const order = aikenDeposit(10_000_000n);
    order.assets = { ...order.assets, '99737472': 1n };
    expect(() =>
      planVenueDepositFill({ pool: aikenPool(), order, network: 'Preprod', minOutputLovelace: 1_000_000n }),
    ).toThrow(/does not name/);
  });

  it('a fee below what a fill costs', () => {
    expect(() =>
      planVenueDepositFill({
        pool: aikenPool(),
        order: aikenDeposit(10_000_000n),
        network: 'Preprod',
        minOutputLovelace: 1_000_000n,
        fillCostLovelace: 1_410_000n,
      }),
    ).toThrow(/can never be filled/);
  });

  it('an executor fee above what the request allows', () => {
    expect(() =>
      planVenueRedeemFill({
        pool: aikenPool(),
        order: aikenRedeem(),
        network: 'Preprod',
        executorFee: 1_000_001n,
        minOutputLovelace: 1_000_000n,
      }),
    ).toThrow(/allows at most/);
  });

  it('a deposit that buys no LQ', () => {
    expect(() =>
      planVenueDepositFill({
        pool: aikenPool(),
        order: aikenDeposit(10n),
        network: 'Preprod',
        minOutputLovelace: 1_000_000n,
      }),
    ).toThrow(/buys no LQ/);
  });

  it('a pool with no liquidity to price against', () => {
    const pool = aikenPool();
    pool.assets = { ...pool.assets, [LQ_UNIT]: MAX_LQ };
    expect(() =>
      planVenueDepositFill({ pool, order: aikenDeposit(10_000_000n), network: 'Preprod', minOutputLovelace: 1n }),
    ).toThrow(/refuses one when it has none/);
  });

  it('says why a request can never fill, rather than throwing', () => {
    const order = aikenDeposit(10_000_000n);
    order.datum = { ...order.datum, ex_fee: 100_000n };
    order.assets = { ...order.assets, lovelace: 12_100_000n };
    const answer = venueLiquidityFillable({ pool: aikenPool(), order, network: 'Preprod', minOutputLovelace: 1n });
    expect(answer.fillable).toBe(false);
    expect(answer.fillable === false && answer.reason).toMatch(/can never be filled/);
  });
});

describe('the encodings the validators decode', () => {
  it('writes DepositConfig as the blueprint lays it out, eight fields under constructor 0', () => {
    const cfg: VenueDepositConfigData = aikenDeposit(1n).datum;
    const raw = Data.from(Data.to(cfg, VenueDepositConfigSchema)) as Constr<unknown>;
    expect(raw.index).toBe(0);
    expect(raw.fields).toHaveLength(8);
    expect(raw.fields[4]).toBe(1_000_000n); // ex_fee
    expect(raw.fields[5]).toBe(PLACER); // reward_pkh
    expect(raw.fields[6]).toEqual(new Constr(0, [STAKE])); // Some(stake)
    expect(raw.fields[7]).toBe(2_000_000n); // collateral_ada
  });

  it('writes an absent stake key as None, constructor 1 with no fields', () => {
    const cfg: VenueRedeemConfigData = aikenRedeem().datum;
    const raw = Data.from(Data.to(cfg, VenueRedeemConfigSchema)) as Constr<unknown>;
    expect(raw.fields).toHaveLength(7);
    expect(raw.fields[6]).toEqual(new Constr(1, []));
  });

  it('writes Apply as constructor 0 with its three positions, and Refund as constructor 1', () => {
    expect(Data.from(venueApplyRedeemer(1, 0, 1))).toEqual(new Constr(0, [1n, 0n, 1n]));
    expect(Data.from(venueRefundRedeemer())).toEqual(new Constr(1, []));
  });

  it('pins one DepositConfig to its bytes', () => {
    expect(Data.to(aikenDeposit(1n).datum, VenueDepositConfigSchema)).toBe(
      'd8799fd8799f41aa436e6674ffd8799f4040ffd8799f41bb45746f6b656effd8799f41cc426c71ff1a000f4240581c' +
        `${PLACER}d8799f581c${STAKE}ff1a001e8480ff`,
    );
  });
});

describe('a request a front end drafts', () => {
  it('pairs the ADA with the tokens the pool’s ratio asks for, rounded up', () => {
    // 100M/100M net, so one for one, and 10 ADA pairs with 10M Y.
    expect(venueDepositPair(aikenPool(), 10_000_000n)).toBe(10_000_000n);
    // A ratio that does not divide: the token side is rounded up, so the ADA
    // the placer chose is what limits the deposit.
    const pool = aikenPool();
    pool.assets = { ...pool.assets, [TOK_UNIT]: 100_250_003n };
    expect(venueDepositPair(pool, 10_000_000n)).toBe(10_000_001n);
  });

  it('carries both sides, the fee and the collateral, and names the pool’s own assets', () => {
    const draft = draftVenueDepositOrder({
      pool: aikenPool(),
      adaIn: 10_000_000n,
      tokenIn: 10_000_000n,
      rewardPkh: PLACER,
      stakePkh: STAKE,
      collateralAda: 1_300_000n,
    });
    expect(draft.assets).toEqual({ lovelace: 12_800_000n, [TOK_UNIT]: 10_000_000n });
    expect(draft.datum).toMatchObject({ pool_nft: NFTA, x: ADA, y: TOK, lq: LQA, ex_fee: 1_500_000n });
    expect(draft.expectedLq).toBe(100_000n);
    expect(draft.shareAfterBps).toBe(909n);
  });

  it('is filled, as drafted, for exactly the LQ it promised at an unmoved pool', () => {
    const draft = draftVenueDepositOrder({
      pool: aikenPool(),
      adaIn: 10_000_000n,
      tokenIn: 10_000_000n,
      rewardPkh: PLACER,
      collateralAda: 1_300_000n,
    });
    const fill = planVenueDepositFill({
      pool: aikenPool(),
      order: { ...aikenDeposit(0n), assets: draft.assets, datum: draft.datum },
      network: 'Preprod',
      minOutputLovelace: 1_000_000n,
    });
    expect(fill.lq).toBe(draft.expectedLq);
  });

  it('refuses a fee that cannot fund a fill', () => {
    expect(() =>
      draftVenueDepositOrder({
        pool: aikenPool(),
        adaIn: 10_000_000n,
        tokenIn: 10_000_000n,
        rewardPkh: PLACER,
        collateralAda: 1_300_000n,
        exFee: 500_000n,
      }),
    ).toThrow(/does not cover one fill/);
  });

  it('drafts a redeem that carries its LQ, the fee and the collateral', () => {
    const draft = draftVenueRedeemOrder({
      pool: aikenPool(),
      lqIn: 100_000n,
      rewardPkh: PLACER,
      collateralAda: 1_300_000n,
    });
    expect(draft.assets).toEqual({ lovelace: 2_800_000n, [LQ_UNIT]: 100_000n });
    expect(draft.expectedXOut).toBe(10_000_000n);
    expect(draft.expectedYOut).toBe(10_000_000n);
  });

  it('refuses a redeem of every LQ in circulation', () => {
    expect(() =>
      draftVenueRedeemOrder({ pool: aikenPool(), lqIn: 1_000_000n, rewardPkh: PLACER, collateralAda: 1_300_000n }),
    ).toThrow(/never all of it/);
  });
});

// ---------------------------------------------------------------------------
// Real transactions, built offline from the compiled validators.
// ---------------------------------------------------------------------------

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string }>;
}
function load(file: string): Blueprint {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano-dex', file), 'utf8'));
}
function pick(blueprint: Blueprint, title: string) {
  const found = blueprint.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from the venue blueprint`);
  return found;
}

const POOL_SCRIPT = pick(load(join('deployment', 'applied.json')), 'royalty_pool/pool.pool.spend');
const SWAP_SCRIPT = pick(load('plutus.json'), 'royalty_pool/swap_order.swap_order.spend');
const DEPOSIT_SCRIPT = pick(load('plutus.json'), VENUE_DEPOSIT_ORDER_TITLE);
const REDEEM_SCRIPT = pick(load('plutus.json'), VENUE_REDEEM_ORDER_TITLE);
const POOL_ADDRESS = scriptAddressOf(POOL_SCRIPT.compiledCode, 0);
const SWAP_ADDRESS = scriptAddressOf(SWAP_SCRIPT.compiledCode, 0);
const DEPOSIT_ADDRESS = scriptAddressOf(DEPOSIT_SCRIPT.compiledCode, 0);
const REDEEM_ADDRESS = scriptAddressOf(REDEEM_SCRIPT.compiledCode, 0);

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '0102030405060708091011121314151617181920212223242526272829303132'.slice(0, 62);
const REAL_TOKEN = { policy: 'bb'.repeat(28), name: '746f6b656e' };
const REAL_LQ = { policy: FACTORY, name: `11${LAUNCH}` };
const REAL_NFT = { policy: FACTORY, name: `10${LAUNCH}` };
const REAL_TOKEN_UNIT = venueUnitOf(REAL_TOKEN);
const REAL_LQ_UNIT = venueUnitOf(REAL_LQ);
const REAL_NFT_UNIT = venueUnitOf(REAL_NFT);
const EXECUTOR_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: '11'.repeat(28) });

function realPoolDatum(): VenuePoolConfigData {
  return {
    ...aikenPoolDatum(),
    pool_nft: REAL_NFT,
    pool_y: REAL_TOKEN,
    pool_lq: REAL_LQ,
    fee_num: 99_900n,
    treasury_x: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    treasury_address: 'ee'.repeat(57),
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
  };
}

/** A pool the size a real graduation opens: 20,000 ADA against 200M tokens, 1B LQ out. */
function realPool(txHash: string): VenuePoolUtxo {
  return {
    txHash,
    outputIndex: 0,
    address: POOL_ADDRESS,
    assets: {
      lovelace: 20_000_000_000n,
      [REAL_TOKEN_UNIT]: 200_000_000n,
      [REAL_LQ_UNIT]: MAX_LQ - 1_000_000_000n,
      [REAL_NFT_UNIT]: 1n,
    },
    datum: realPoolDatum(),
  };
}

function realDeposit(): VenueDepositOrderUtxo {
  return {
    kind: 'deposit',
    txHash: '02'.repeat(32),
    outputIndex: 0,
    address: DEPOSIT_ADDRESS,
    // 100 ADA and the million tokens it pairs with, 1.5 ADA fee, 1.3 ADA collateral.
    assets: { lovelace: 102_800_000n, [REAL_TOKEN_UNIT]: 1_000_000n },
    datum: {
      pool_nft: REAL_NFT,
      x: ADA,
      y: REAL_TOKEN,
      lq: REAL_LQ,
      ex_fee: 1_500_000n,
      reward_pkh: PLACER,
      stake_pkh: null,
      collateral_ada: 1_300_000n,
    },
  };
}

function realRedeem(): VenueRedeemOrderUtxo {
  return {
    kind: 'redeem',
    txHash: '02'.repeat(32),
    outputIndex: 0,
    address: REDEEM_ADDRESS,
    assets: { lovelace: 2_800_000n, [REAL_LQ_UNIT]: 5_000_000n },
    datum: {
      pool_nft: REAL_NFT,
      x: ADA,
      y: REAL_TOKEN,
      lq: REAL_LQ,
      ex_fee: 1_500_000n,
      reward_pkh: PLACER,
      stake_pkh: null,
    },
  };
}

function walletUtxo(txHash: string, lovelace: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: { address: EXECUTOR_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
  };
}

function meshWallet(): CurveSpendWallet {
  return {
    getChangeAddress: vi.fn().mockResolvedValue(EXECUTOR_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue([walletUtxo('11'.repeat(32), '500000000')]),
    getCollateral: vi.fn().mockResolvedValue([walletUtxo('22'.repeat(32), '5000000')]),
    signTx: vi.fn().mockResolvedValue('signed'),
    submitTx: vi.fn().mockResolvedValue('submitted-hash'),
  };
}

function ref(cbor: string, tx: string) {
  return { compiledScriptCbor: cbor, referenceScript: { txHash: tx, outputIndex: 0, scriptHash: scriptHashOf(cbor) } };
}

function realFiller(opts: { withRequests?: boolean } = {}) {
  return new VenueFiller({
    network: 'preprod',
    poolScript: ref(POOL_SCRIPT.compiledCode, 'a1'.repeat(32)),
    orderScript: ref(SWAP_SCRIPT.compiledCode, 'a2'.repeat(32)),
    ...(opts.withRequests === false
      ? {}
      : {
          depositScript: ref(DEPOSIT_SCRIPT.compiledCode, 'a3'.repeat(32)),
          redeemScript: { embeddedScriptCbor: REDEEM_SCRIPT.compiledCode },
        }),
    provider: {
      fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
      evaluateTx: vi.fn().mockResolvedValue([
        { tag: 'SPEND', index: 0, budget: VENUE_FILL_EXECUTION_UNITS },
        { tag: 'SPEND', index: 1, budget: VENUE_FILL_EXECUTION_UNITS },
      ]),
    } as never,
  });
}

function planFor(pool: VenuePoolUtxo, order: VenueDepositOrderUtxo | VenueRedeemOrderUtxo): VenueFillPlan {
  const fill =
    order.kind === 'deposit'
      ? planVenueDepositFill({ pool, order, network: 'Preprod', executorFee: 1_500_000n, minOutputLovelace: 1n })
      : planVenueRedeemFill({ pool, order, network: 'Preprod', executorFee: 1_500_000n, minOutputLovelace: 1n });
  return {
    kind: order.kind,
    pool: { txHash: pool.txHash, outputIndex: 0, address: pool.address, assets: pool.assets },
    order: { txHash: order.txHash, outputIndex: 0, address: order.address, assets: order.assets },
    poolOutput: {
      address: pool.address,
      assets: fill.poolAssets,
      datumCbor: Data.to(pool.datum, VenuePoolConfigSchema),
    },
    successorOutput: { address: fill.reward.address, assets: fill.reward.assets },
  };
}

function redeemersOf(txHex: string): Map<number, bigint[]> {
  const redeemers = deserializeTx(txHex).witnessSet().redeemers()?.values() ?? [];
  const out = new Map<number, bigint[]>();
  for (const r of redeemers) {
    out.set(Number(r.index()), (Data.from(r.data().toCbor()) as Constr<bigint>).fields);
  }
  return out;
}

describe('a liquidity fill, built', () => {
  it.each([
    ['a deposit, the pool sorting first', 'deposit', '01'.repeat(32), 0, 1, VENUE_POOL_ACTION.Deposit],
    ['a deposit, the pool sorting second', 'deposit', '03'.repeat(32), 1, 0, VENUE_POOL_ACTION.Deposit],
    ['a redeem, the pool sorting first', 'redeem', '01'.repeat(32), 0, 1, VENUE_POOL_ACTION.Redeem],
    ['a redeem, the pool sorting second', 'redeem', '03'.repeat(32), 1, 0, VENUE_POOL_ACTION.Redeem],
  ] as const)(
    'spends the pool under its own arm and names the inputs it really has: %s',
    async (_l, kind, poolTx, poolIx, orderIx, action) => {
      const order = kind === 'deposit' ? realDeposit() : realRedeem();
      const built = await realFiller().build(planFor(realPool(poolTx), order), meshWallet());

      const inputs = deserializeTx(built)
        .body()
        .inputs()
        .toCore()
        .map((i) => `${i.txId}#${i.index}`);
      expect(inputs).toHaveLength(2);
      expect(inputs[poolIx]).toBe(`${poolTx}#0`);

      const redeemers = redeemersOf(built);
      expect(redeemers.get(poolIx)).toEqual([BigInt(action), BigInt(poolIx)]);
      expect(redeemers.get(orderIx)).toEqual([BigInt(poolIx), BigInt(orderIx), 1n]);
    },
  );

  it('pays the placer in the second output, after the pool', async () => {
    const built = await realFiller().build(planFor(realPool('01'.repeat(32)), realDeposit()), meshWallet());
    const outputs = deserializeTx(built).body().outputs();
    expect(outputs[0]?.toCore().address).toBe(POOL_ADDRESS);
    expect(outputs[1]?.toCore().address).toBe(venueKeyAddress(PLACER, null, 'Preprod'));
  });

  it('refuses a deposit when it was not given the deposit validator', async () => {
    await expect(
      realFiller({ withRequests: false }).build(planFor(realPool('01'.repeat(32)), realDeposit()), meshWallet()),
    ).rejects.toThrow(/not given the deposit request validator/);
  });

  it('refuses a request that does not sit at the validator it references', async () => {
    const order = { ...realDeposit(), address: REDEEM_ADDRESS };
    await expect(realFiller().build(planFor(realPool('01'.repeat(32)), order), meshWallet())).rejects.toThrow(
      /Spending it would need the validator that locks it/,
    );
  });
});

// ---------------------------------------------------------------------------
// Reading requests, and a batcher round that holds both kinds.
// ---------------------------------------------------------------------------

function providerUtxo(
  address: string,
  txHash: string,
  assets: Record<string, bigint>,
  inlineDatum: string | null,
  outputIndex = 0,
): ProviderUtxo {
  return {
    tx_hash: txHash,
    output_index: outputIndex,
    address,
    amount: Object.entries(assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
    inline_datum: inlineDatum,
  };
}

function poolProviderUtxo(): ProviderUtxo {
  const pool = realPool('01'.repeat(32));
  return providerUtxo(POOL_ADDRESS, pool.txHash, pool.assets, Data.to(pool.datum, VenuePoolConfigSchema));
}

function depositProviderUtxo(txHash: string, outputIndex = 0): ProviderUtxo {
  const d = realDeposit();
  return providerUtxo(DEPOSIT_ADDRESS, txHash, d.assets, Data.to(d.datum, VenueDepositConfigSchema), outputIndex);
}

function redeemProviderUtxo(txHash: string): ProviderUtxo {
  const r = realRedeem();
  return providerUtxo(REDEEM_ADDRESS, txHash, r.assets, Data.to(r.datum, VenueRedeemConfigSchema));
}

function swapProviderUtxo(txHash: string): ProviderUtxo {
  const swap: VenueSwapConfigData = {
    pool_nft: REAL_NFT,
    input: ADA,
    output: REAL_TOKEN,
    tradable_input: 100_000_000n,
    base_price: { num: 8n, denom: 1_000n },
    min_marginal_output: 0n,
    ex_fee: 1_500_000n,
    reward_pkh: PLACER,
    stake_pkh: null,
    permitted_executors: [],
  };
  return providerUtxo(SWAP_ADDRESS, txHash, { lovelace: 103_000_000n }, Data.to(swap, VenueSwapConfigSchema));
}

function providerAt(
  byAddress: Record<string, ProviderUtxo[]>,
  positions: Record<string, { block_height: number; index: number }> = {},
): VenueChainProvider & { getTxPosition: ReturnType<typeof vi.fn> } {
  return {
    getAddressUtxosAll: vi.fn(async (address: string) => byAddress[address] ?? []),
    getTxPosition: vi.fn(async (txHash: string) => positions[txHash] ?? { block_height: 1_000, index: 0 }),
  };
}

describe('reading requests off the chain', () => {
  it('reads both kinds, sets aside what it cannot use, and says why', async () => {
    const provider = providerAt({
      [DEPOSIT_ADDRESS]: [
        depositProviderUtxo('0a'.repeat(32)),
        providerUtxo(DEPOSIT_ADDRESS, '0b'.repeat(32), { lovelace: 5_000_000n }, Data.to(new Constr(0, [1n]))),
        providerUtxo(DEPOSIT_ADDRESS, '0c'.repeat(32), { lovelace: 5_000_000n }, null),
      ],
      [REDEEM_ADDRESS]: [redeemProviderUtxo('0d'.repeat(32))],
    });
    const read = await readVenueLiquidityOrders(provider, {
      depositAddress: DEPOSIT_ADDRESS,
      redeemAddress: REDEEM_ADDRESS,
      knownPools: [REAL_NFT_UNIT],
    });
    expect(read.orders.map((o) => [o.kind, o.txHash])).toEqual([
      ['deposit', '0a'.repeat(32)],
      ['redeem', '0d'.repeat(32)],
    ]);
    expect(read.skipped.map((s) => s.txHash)).toEqual(['0b'.repeat(32), '0c'.repeat(32)]);
    expect(read.skipped[0]?.reason).toMatch(/not a deposit request/);
  });

  it('sets aside a request naming a pool it did not find', async () => {
    const provider = providerAt({ [DEPOSIT_ADDRESS]: [depositProviderUtxo('0a'.repeat(32))] });
    const read = await readVenueLiquidityOrders(provider, { depositAddress: DEPOSIT_ADDRESS, knownPools: [] });
    expect(read.orders).toHaveLength(0);
    expect(read.skipped[0]?.reason).toMatch(/not one of the pools this reader found/);
  });

  it('looks up a placement once per transaction', async () => {
    const provider = providerAt({
      [DEPOSIT_ADDRESS]: [depositProviderUtxo('0a'.repeat(32), 0), depositProviderUtxo('0a'.repeat(32), 1)],
    });
    await readVenueLiquidityOrders(provider, { depositAddress: DEPOSIT_ADDRESS, knownPools: [REAL_NFT_UNIT] });
    expect(provider.getTxPosition).toHaveBeenCalledTimes(1);
  });
});

/** A filler that plans for real and pretends to build, as buildSettled calls it. */
function recordingFiller(behaviour: { failOnCall?: number } = {}) {
  const plans: VenueFillPlan[] = [];
  let call = 0;
  const buildSettled = vi.fn(async (makePlan: (fee: bigint) => VenueFillPlan) => {
    call += 1;
    if (behaviour.failOnCall === call) throw new Error('the node refused it');
    makePlan(0n);
    plans.push(makePlan(1_400_000n));
    return { txHex: 'ab'.repeat(8), executorFee: 1_400_000n, networkFee: 400_000n };
  });
  return { filler: { buildSettled } as unknown as VenueFiller, plans };
}

function batcherWallet(): CurveSpendWallet {
  let n = 0;
  return {
    getChangeAddress: vi.fn().mockResolvedValue(EXECUTOR_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue([]),
    getCollateral: vi.fn().mockResolvedValue([]),
    signTx: vi.fn(async (hex: string) => `signed:${hex}`),
    submitTx: vi.fn(async () => {
      n += 1;
      return `${n}${n}`.padStart(2, '0').repeat(32);
    }),
  };
}

function liquidityBatcher(provider: VenueChainProvider, filler: VenueFiller) {
  return new VenueBatcher({
    provider,
    filler,
    wallet: batcherWallet(),
    network: 'preprod',
    poolAddress: POOL_ADDRESS,
    orderAddress: SWAP_ADDRESS,
    depositAddress: DEPOSIT_ADDRESS,
    redeemAddress: REDEEM_ADDRESS,
    factoryPolicyId: FACTORY,
    minOutputLovelace: 1_000_000n,
  });
}

const EARLY = { block_height: 100, index: 0 };
const LATE = { block_height: 101, index: 0 };

describe('a batcher round with liquidity requests in it', () => {
  it('fills a deposit under the pool’s deposit arm, leaving the pool’s datum as it was', async () => {
    const provider = providerAt({
      [POOL_ADDRESS]: [poolProviderUtxo()],
      [DEPOSIT_ADDRESS]: [depositProviderUtxo('0a'.repeat(32))],
    });
    const { filler, plans } = recordingFiller();
    const round = await liquidityBatcher(provider, filler).runRound();

    expect(round.filled).toBe(1);
    expect(round.liquidityOutcomes).toHaveLength(1);
    expect(round.liquidityOutcomes[0]?.status).toBe('filled');
    expect(plans[0]?.kind).toBe('deposit');
    expect(plans[0]?.poolOutput.datumCbor).toBe(Data.to(realPoolDatum(), VenuePoolConfigSchema));
    // 100 ADA into a 20,000-ADA pool with 1B LQ out buys 5,000,000 LQ.
    expect(plans[0]?.successorOutput.assets[REAL_LQ_UNIT]).toBe(5_000_000n);
  });

  it('fills requests and swaps in the order the chain accepted them, each against the pool the last left', async () => {
    const provider = providerAt(
      {
        [POOL_ADDRESS]: [poolProviderUtxo()],
        [SWAP_ADDRESS]: [swapProviderUtxo('0a'.repeat(32))],
        [DEPOSIT_ADDRESS]: [depositProviderUtxo('0b'.repeat(32))],
      },
      { ['0a'.repeat(32)]: LATE, ['0b'.repeat(32)]: EARLY },
    );
    const { filler, plans } = recordingFiller();
    const round = await liquidityBatcher(provider, filler).runRound();

    expect(round.filled).toBe(2);
    // The deposit was placed first, so it meets the pool first…
    expect(plans.map((p) => p.kind ?? 'swap')).toEqual(['deposit', 'swap']);
    // …and the swap is priced against the pool the deposit left: 100 ADA richer.
    expect(plans[1]?.pool.assets.lovelace).toBe(20_100_000_000n);
    expect(plans[1]?.pool.txHash).toBe('11'.repeat(32));
  });

  it('reports a request whose fee cannot fund a fill, and builds nothing for it', async () => {
    const d = realDeposit();
    const starved = { ...d.datum, ex_fee: 200_000n };
    const provider = providerAt({
      [POOL_ADDRESS]: [poolProviderUtxo()],
      [DEPOSIT_ADDRESS]: [
        providerUtxo(DEPOSIT_ADDRESS, '0a'.repeat(32), d.assets, Data.to(starved, VenueDepositConfigSchema)),
      ],
    });
    const { filler, plans } = recordingFiller();
    const round = await liquidityBatcher(provider, filler).runRound();

    expect(plans).toHaveLength(0);
    expect(round.liquidityOutcomes[0]?.status).toBe('unfillable');
  });

  it('stops the pool’s chain when a request’s fill fails, and says why', async () => {
    const provider = providerAt(
      {
        [POOL_ADDRESS]: [poolProviderUtxo()],
        [SWAP_ADDRESS]: [swapProviderUtxo('0a'.repeat(32))],
        [REDEEM_ADDRESS]: [redeemProviderUtxo('0b'.repeat(32))],
      },
      { ['0a'.repeat(32)]: LATE, ['0b'.repeat(32)]: EARLY },
    );
    const { filler } = recordingFiller({ failOnCall: 1 });
    const round = await liquidityBatcher(provider, filler).runRound();

    expect(round.failed).toBe(1);
    expect(round.liquidityOutcomes[0]).toMatchObject({ status: 'failed', reason: 'the node refused it' });
    expect(round.outcomes[0]?.status).toBe('declined');
  });

  it('reads no request address it was not given, and fills swaps exactly as before', async () => {
    const provider = providerAt({
      [POOL_ADDRESS]: [poolProviderUtxo()],
      [SWAP_ADDRESS]: [swapProviderUtxo('0a'.repeat(32))],
    });
    const { filler, plans } = recordingFiller();
    const round = await new VenueBatcher({
      provider,
      filler,
      wallet: batcherWallet(),
      network: 'preprod',
      poolAddress: POOL_ADDRESS,
      orderAddress: SWAP_ADDRESS,
      factoryPolicyId: FACTORY,
      minOutputLovelace: 1_000_000n,
    }).runRound();

    expect(round.filled).toBe(1);
    expect(round.liquidityOutcomes).toEqual([]);
    expect(plans[0]?.kind).toBeUndefined();
    expect(provider.getAddressUtxosAll).not.toHaveBeenCalledWith(DEPOSIT_ADDRESS);
  });
});
