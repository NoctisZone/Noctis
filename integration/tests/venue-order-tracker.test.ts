// venue-order-tracker.test.ts — can a placer tell waiting from stuck?
//
// From outside they look identical: an order sitting at an address, doing
// nothing. One of them is a limit order behaving exactly as intended and the
// other will never fill however long anyone leaves it, and the difference is
// the whole reason this module exists — a venue order has no expiry, so
// nothing eventually clears a stuck one on the placer's behalf.
//
// Two of the four states are permanent, and both are tested for being reported
// as such: an order whose execution fee is under one fill's cost can never be
// filled at any price because the fee is fixed in the datum, and an order
// naming a pool that does not exist can never be filled because one unit of a
// pool NFT is ever minted.
//
// The pool below holds 20,000 ADA against 200,000,000 tokens — spot, fee
// included, is 0.00988 tokens per lovelace. A floor of 0.0099 is 70 basis
// points out of reach, which is a normal day; 0.015 is 3,446, which is a
// different market. That distinction is the number the tracker exists to give.

import { Data } from '@lucid-evolution/lucid';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderUtxo, VenueChainProvider } from '../venue-chain-reader.js';
import { trackVenueOrder, trackVenueOrders, venueOrdersWorthCancelling } from '../venue-order-tracker.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import { type VenuePoolUtxo, type VenueSwapConfigData, VenueSwapConfigSchema } from '../venue-swap.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const OTHER_LAUNCH = '99887766554433221100aabbccddeeff00112233445566778899aabbccddee'.slice(0, 62);
const POOL_NFT = `${FACTORY}10${LAUNCH}`;
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN = `${TOKEN_POLICY}746f6b656e`;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const ORDER_ADDRESS = 'addr_test1wq11111111111111111111111111111111111111111111111111gdvxvz';
const MAX_LQ = 0x7fffffffffffffffn;
const PLACER = '0d'.repeat(28);
const OTHER_PLACER = '0e'.repeat(28);

function poolDatum(over: Partial<VenuePoolConfigData> = {}): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
    pool_lq: { policy: FACTORY, name: `11${LAUNCH}` },
    fee_num: 99_900n,
    treasury_fee: 100n,
    royalty_fee: 1_000n,
    treasury_x: 0n,
    treasury_y: 0n,
    royalty_x: 0n,
    royalty_y: 0n,
    dao_policy: [],
    treasury_address: 'ee'.repeat(57),
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
    ...over,
  };
}

function swapDatum(over: Partial<VenueSwapConfigData> = {}): VenueSwapConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    input: { policy: '', name: '' },
    output: { policy: TOKEN_POLICY, name: '746f6b656e' },
    tradable_input: 100_000_000n,
    base_price: { num: 88n, denom: 10_000n },
    min_marginal_output: 0n,
    ex_fee: 1_500_000n,
    reward_pkh: PLACER,
    stake_pkh: null,
    permitted_executors: [],
    ...over,
  };
}

function poolUtxo(): ProviderUtxo {
  return {
    tx_hash: '01'.repeat(32),
    output_index: 0,
    address: POOL_ADDRESS,
    amount: [
      { unit: 'lovelace', quantity: '20000000000' },
      { unit: TOKEN, quantity: '200000000' },
      { unit: LQ, quantity: String(MAX_LQ - 1_000_000_000n) },
      { unit: POOL_NFT, quantity: '1' },
    ],
    inline_datum: Data.to(poolDatum(), VenuePoolConfigSchema),
  };
}

const livePool: VenuePoolUtxo = {
  txHash: '01'.repeat(32),
  outputIndex: 0,
  address: POOL_ADDRESS,
  assets: {
    lovelace: 20_000_000_000n,
    [TOKEN]: 200_000_000n,
    [LQ]: MAX_LQ - 1_000_000_000n,
    [POOL_NFT]: 1n,
  },
  datum: poolDatum(),
};

function orderUtxo(txHash: string, swap: VenueSwapConfigData = swapDatum()): ProviderUtxo {
  return {
    tx_hash: txHash,
    output_index: 0,
    address: ORDER_ADDRESS,
    amount: [{ unit: 'lovelace', quantity: String(swap.tradable_input + swap.ex_fee + 1_500_000n) }],
    inline_datum: Data.to(swap, VenueSwapConfigSchema),
  };
}

function order(txHash: string, swap: VenueSwapConfigData = swapDatum()) {
  return {
    txHash,
    outputIndex: 0,
    address: ORDER_ADDRESS,
    assets: { lovelace: swap.tradable_input + swap.ex_fee + 1_500_000n },
    datum: swap,
  };
}

function providerWith(
  pools: ProviderUtxo[],
  orders: ProviderUtxo[],
  positions: Record<string, { block_height: number; index: number }> = {},
): VenueChainProvider {
  return {
    getAddressUtxosAll: vi.fn(async (address: string) => (address === POOL_ADDRESS ? pools : orders)),
    getTxPosition: vi.fn(async (txHash: string) => positions[txHash] ?? { block_height: 1_000, index: 0 }),
  };
}

const ARGS = { poolAddress: POOL_ADDRESS, orderAddress: ORDER_ADDRESS, factoryPolicyId: FACTORY };

// ---------------------------------------------------------------------------

describe('classifying one order', () => {
  it('says an order is fillable, and how much of it', () => {
    const tracked = trackVenueOrder({ order: order('0a'.repeat(32)), pool: livePool });
    expect(tracked.state).toBe('fillable');
    expect(tracked.fillableNow).toBe(100_000_000n);
    expect(tracked.shortfallBps).toBe(0n);
  });

  it('says how far short the pool is when an order is only waiting', () => {
    const near = trackVenueOrder({
      order: order('0a'.repeat(32), swapDatum({ base_price: { num: 99n, denom: 10_000n } })),
      pool: livePool,
    });
    expect(near.state).toBe('waiting');
    expect(near.shortfallBps).toBe(70n);

    // The same order shape with a floor nobody is going to reach today.
    const far = trackVenueOrder({
      order: order('0b'.repeat(32), swapDatum({ base_price: { num: 150n, denom: 10_000n } })),
      pool: livePool,
    });
    expect(far.state).toBe('waiting');
    expect(far.shortfallBps).toBe(3_446n);
  });

  it('calls an underfunded order permanently stuck, whatever the pool is doing', () => {
    // The pool would happily serve this one — the fee is why it cannot be
    // filled, and the fee is fixed when the order is placed.
    const tracked = trackVenueOrder({
      order: order('0a'.repeat(32), swapDatum({ ex_fee: 100_000n })),
      pool: livePool,
    });
    expect(tracked.state).toBe('unfundable');
    expect(tracked.reason).toMatch(/no part of it can be filled at any price/);
    expect(tracked.fillableNow).toBe(0n);
  });

  it('calls an order naming no live pool permanently stuck too', () => {
    const tracked = trackVenueOrder({ order: order('0a'.repeat(32)), pool: undefined });
    expect(tracked.state).toBe('orphaned');
    expect(tracked.reason).toMatch(/nothing can arrive later to fill this/);
  });

  it('reports no shortfall against a floor that asks for nothing', () => {
    const anyPrice = trackVenueOrder({
      order: order('0a'.repeat(32), swapDatum({ base_price: { num: 0n, denom: 1n } })),
      pool: livePool,
    });
    expect(anyPrice.state).toBe('fillable');
    expect(anyPrice.shortfallBps).toBe(0n);
  });

  it('reports the pool as maximally short when a side of it is empty', () => {
    const drained: VenuePoolUtxo = {
      ...livePool,
      assets: { lovelace: 20_000_000_000n, [POOL_NFT]: 1n },
    };
    const tracked = trackVenueOrder({ order: order('0a'.repeat(32)), pool: drained });
    expect(tracked.state).toBe('waiting');
    expect(tracked.shortfallBps).toBe(10_000n);
  });

  it('flags an order that only its named executors may fill', () => {
    const gated = trackVenueOrder({
      order: order('0a'.repeat(32), swapDatum({ permitted_executors: ['11'.repeat(28)] })),
      pool: livePool,
    });
    expect(gated.gated).toBe(true);
    expect(gated.reason).toMatch(/only be filled by the executors it names/);
    expect(trackVenueOrder({ order: order('0b'.repeat(32)), pool: livePool }).gated).toBe(false);
  });
});

describe('tracking the venue', () => {
  it('returns an order naming an unknown pool rather than dropping it', () => {
    // The batcher sets these aside because it cannot act on one. The placer
    // needs it most of all: it is the case nothing will ever resolve.
    const orphan = swapDatum({ pool_nft: { policy: FACTORY, name: `10${OTHER_LAUNCH}` } });
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32), orphan)]);
    return trackVenueOrders(provider, ARGS).then((tracking) => {
      expect(tracking.orders).toHaveLength(1);
      expect(tracking.orders[0]?.state).toBe('orphaned');
      expect(tracking.skipped).toHaveLength(0);
    });
  });

  it('counts every order it returns, and returns every order it counts', async () => {
    const tracking = await trackVenueOrders(
      providerWith(
        [poolUtxo()],
        [
          orderUtxo('0a'.repeat(32)),
          orderUtxo('0b'.repeat(32), swapDatum({ base_price: { num: 99n, denom: 10_000n } })),
          orderUtxo('0c'.repeat(32), swapDatum({ ex_fee: 100_000n })),
          orderUtxo('0d'.repeat(32), swapDatum({ pool_nft: { policy: FACTORY, name: `10${OTHER_LAUNCH}` } })),
        ],
      ),
      ARGS,
    );
    expect(tracking.counts).toEqual({ fillable: 1, waiting: 1, unfundable: 1, orphaned: 1 });
    const total = Object.values(tracking.counts).reduce((a, b) => a + b, 0);
    expect(tracking.orders).toHaveLength(total);
  });

  it('shows one placer their own orders and nobody else’s', async () => {
    const provider = providerWith(
      [poolUtxo()],
      [orderUtxo('0a'.repeat(32)), orderUtxo('0b'.repeat(32), swapDatum({ reward_pkh: OTHER_PLACER }))],
    );
    const mine = await trackVenueOrders(provider, { ...ARGS, owner: PLACER });
    expect(mine.orders).toHaveLength(1);
    expect(mine.orders[0]?.order.txHash).toBe('0a'.repeat(32));
    expect((await trackVenueOrders(provider, ARGS)).orders).toHaveLength(2);
  });

  it('lists them in the order fills would take them', async () => {
    const provider = providerWith([poolUtxo()], [orderUtxo('0b'.repeat(32)), orderUtxo('0a'.repeat(32))], {
      ['0a'.repeat(32)]: { block_height: 100, index: 0 },
      ['0b'.repeat(32)]: { block_height: 101, index: 0 },
    });
    const tracking = await trackVenueOrders(provider, ARGS);
    expect(tracking.orders.map((o) => o.order.txHash)).toEqual(['0a'.repeat(32), '0b'.repeat(32)]);
  });

  it('flags an order as long-resting only when asked, and never on its own', async () => {
    const provider = providerWith([poolUtxo()], [orderUtxo('0a'.repeat(32))], {
      ['0a'.repeat(32)]: { block_height: 1_000, index: 0 },
    });
    expect((await trackVenueOrders(provider, ARGS)).orders[0]?.stale).toBeUndefined();

    const old = await trackVenueOrders(provider, {
      ...ARGS,
      staleAfterBlocks: 500,
      currentBlockHeight: 2_000,
    });
    expect(old.orders[0]?.stale).toBe(true);

    const fresh = await trackVenueOrders(provider, {
      ...ARGS,
      staleAfterBlocks: 500,
      currentBlockHeight: 1_100,
    });
    expect(fresh.orders[0]?.stale).toBe(false);
  });
});

describe('what to offer a cancel for', () => {
  it('puts the permanently stuck first and never suggests a fillable order', async () => {
    const tracking = await trackVenueOrders(
      providerWith(
        [poolUtxo()],
        [
          orderUtxo('0a'.repeat(32)),
          orderUtxo('0b'.repeat(32), swapDatum({ pool_nft: { policy: FACTORY, name: `10${OTHER_LAUNCH}` } })),
          orderUtxo('0c'.repeat(32), swapDatum({ ex_fee: 100_000n })),
        ],
      ),
      ARGS,
    );
    expect(venueOrdersWorthCancelling(tracking).map((o) => o.state)).toEqual(['unfundable', 'orphaned']);
  });

  it('suggests a waiting order only once it has been resting a long while', async () => {
    const waiting = [orderUtxo('0a'.repeat(32), swapDatum({ base_price: { num: 150n, denom: 10_000n } }))];
    const provider = providerWith([poolUtxo()], waiting, {
      ['0a'.repeat(32)]: { block_height: 1_000, index: 0 },
    });
    expect(venueOrdersWorthCancelling(await trackVenueOrders(provider, ARGS))).toHaveLength(0);
    expect(
      venueOrdersWorthCancelling(
        await trackVenueOrders(provider, { ...ARGS, staleAfterBlocks: 100, currentBlockHeight: 5_000 }),
      ),
    ).toHaveLength(1);
  });
});
