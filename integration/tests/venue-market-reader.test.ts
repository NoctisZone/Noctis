// venue-market-reader.test.ts — does the venue site's read say what the chain said?
//
// Built on the same four-transaction pool life the history walk is tested on
// (opened, a buy, a sell, a royalty withdrawal), so every figure asserted here
// is one the walk itself produced rather than a second, hand-written story.
//
// The three things that are silent when wrong:
//   EXTENDS OR REPLACES. A caller stitches an incremental read onto what it
//   holds. A read that stopped for any reason other than meeting the caller's
//   point must say so, or a recent window is stitched onto an old history with
//   a hole in the middle that nothing on the page can reveal.
//   WHOSE ORDERS. The book is read once for the whole venue; a pool's queue
//   must hold its own orders and nobody else's.
//   WHOSE LIQUIDITY. The pool holds its own unissued LQ supply; listed as a
//   provider it would own nearly all of its own pool.

import { Data } from '@lucid-evolution/lucid';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderUtxo, VenueChainProvider } from '../venue-chain-reader.js';
import { readVenueMarket, type VenueMarketDeps } from '../venue-market-reader.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import type { HistoryTx, HistoryTxUtxo } from '../venue-pool-history.js';
import type { VenueBlockProvider } from '../venue-price-feed.js';
import { type VenueSwapConfigData, VenueSwapConfigSchema } from '../venue-swap.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const OTHER_LAUNCH = '99887766554433221100aabbccddeeff00112233445566778899aabbccddee'.slice(0, 62);
const POOL_NFT = `${FACTORY}10${LAUNCH}`;
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN = `${TOKEN_POLICY}746f6b656e`;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const ORDER_ADDRESS = 'addr_test1wq11111111111111111111111111111111111111111111111111gdvxvz';
const ESCROW_ADDRESS = 'addr_test1wq22222222222222222222222222222222222222222222222222escrow';
const MAX_LQ = 0x7fffffffffffffffn;
const ISSUED = 1_000_000_000n;
const PLACER = '0d'.repeat(28);
const OTHER_PLACER = '0e'.repeat(28);

const T_OPEN = '01'.repeat(32);
const T_BUY = '02'.repeat(32);
const T_SELL = '03'.repeat(32);
const T_WITHDRAW = '04'.repeat(32);

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

function poolEntry(
  lovelace: bigint,
  tokens: bigint,
  datum: VenuePoolConfigData,
  over: Partial<HistoryTxUtxo> = {},
): HistoryTxUtxo {
  return {
    address: POOL_ADDRESS,
    amount: [
      { unit: 'lovelace', quantity: String(lovelace) },
      { unit: TOKEN, quantity: String(tokens) },
      { unit: LQ, quantity: String(MAX_LQ - ISSUED) },
      { unit: POOL_NFT, quantity: '1' },
    ],
    inline_datum: Data.to(datum, VenuePoolConfigSchema),
    ...over,
  };
}

const OPENED = poolDatum();
const AFTER_BUY = poolDatum({ treasury_x: 100_000n, royalty_x: 1_000_000n });
const AFTER_SELL = poolDatum({ treasury_x: 100_000n, royalty_x: 1_000_000n, treasury_y: 1_000n, royalty_y: 10_000n });
const AFTER_WITHDRAW = poolDatum({ treasury_x: 100_000n, royalty_x: 0n, treasury_y: 1_000n, royalty_y: 10_000n });

const TXS: Record<string, HistoryTx> = {
  [T_OPEN]: {
    hash: T_OPEN,
    inputs: [{ address: POOL_ADDRESS, amount: [{ unit: 'lovelace', quantity: '2000000' }], inline_datum: null }],
    outputs: [poolEntry(20_000_000_000n, 200_000_000n, OPENED)],
  },
  [T_BUY]: {
    hash: T_BUY,
    inputs: [poolEntry(20_000_000_000n, 200_000_000n, OPENED, { tx_hash: T_OPEN, output_index: 0 })],
    outputs: [poolEntry(20_100_000_000n, 199_016_857n, AFTER_BUY)],
  },
  [T_SELL]: {
    hash: T_SELL,
    inputs: [poolEntry(20_100_000_000n, 199_016_857n, AFTER_BUY, { tx_hash: T_BUY, output_index: 0 })],
    outputs: [poolEntry(20_000_713_846n, 200_016_857n, AFTER_SELL)],
  },
  [T_WITHDRAW]: {
    hash: T_WITHDRAW,
    inputs: [poolEntry(20_000_713_846n, 200_016_857n, AFTER_SELL, { tx_hash: T_SELL, output_index: 0 })],
    outputs: [poolEntry(19_999_713_846n, 200_016_857n, AFTER_WITHDRAW)],
  },
};

const STAMPS: Record<string, { height: number; timeSeconds: number }> = {
  [T_OPEN]: { height: 100, timeSeconds: 1_000 },
  [T_BUY]: { height: 101, timeSeconds: 2_000 },
  [T_SELL]: { height: 102, timeSeconds: 3_000 },
  [T_WITHDRAW]: { height: 103, timeSeconds: 4_000 },
};

/** The pool as it stands, at the pool address: the withdrawal's output. */
function currentPool(): ProviderUtxo {
  const entry = poolEntry(19_999_713_846n, 200_016_857n, AFTER_WITHDRAW);
  return {
    tx_hash: T_WITHDRAW,
    output_index: 0,
    address: POOL_ADDRESS,
    amount: entry.amount,
    inline_datum: entry.inline_datum ?? null,
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

function orderUtxo(txHash: string, swap: VenueSwapConfigData): ProviderUtxo {
  const isBuy = swap.input.policy === '';
  return {
    tx_hash: txHash,
    output_index: 0,
    address: ORDER_ADDRESS,
    amount: isBuy
      ? [{ unit: 'lovelace', quantity: String(swap.tradable_input + swap.ex_fee + 1_500_000n) }]
      : [
          { unit: 'lovelace', quantity: String(swap.ex_fee + 1_500_000n) },
          { unit: TOKEN, quantity: String(swap.tradable_input) },
        ],
    inline_datum: Data.to(swap, VenueSwapConfigSchema),
  };
}

const BUY_ORDER = 'a1'.repeat(32);
const SELL_ORDER = 'a2'.repeat(32);
const ORPHAN_ORDER = 'a3'.repeat(32);

const ORDERS: ProviderUtxo[] = [
  orderUtxo(BUY_ORDER, swapDatum()),
  orderUtxo(
    SELL_ORDER,
    swapDatum({
      input: { policy: TOKEN_POLICY, name: '746f6b656e' },
      output: { policy: '', name: '' },
      tradable_input: 1_000_000n,
      base_price: { num: 90n, denom: 1n },
      reward_pkh: OTHER_PLACER,
    }),
  ),
  // Names a pool that does not exist: the tracker keeps it, this pool must not.
  orderUtxo(ORPHAN_ORDER, swapDatum({ pool_nft: { policy: FACTORY, name: `10${OTHER_LAUNCH}` } })),
];

const HOLDERS: Record<string, Array<{ address: string; quantity: string }>> = {
  // The pool's own unissued supply, the escrow's graduation LP, one provider.
  [LQ]: [
    { address: POOL_ADDRESS, quantity: String(MAX_LQ - ISSUED) },
    { address: 'addr_test1provider', quantity: '25000000' },
    { address: ESCROW_ADDRESS, quantity: String(ISSUED - 25_000_000n) },
  ],
  [TOKEN]: [
    { address: 'addr_test1small', quantity: '10' },
    { address: POOL_ADDRESS, quantity: '200016857' },
    { address: 'addr_test1big', quantity: '5000000' },
    { address: 'addr_test1mid', quantity: '400000' },
    { address: 'addr_test1gone', quantity: '0' },
  ],
};

function deps(over: Partial<VenueMarketDeps> = {}): VenueMarketDeps {
  const chain: VenueChainProvider = {
    getAddressUtxosAll: vi.fn(async (address: string) => (address === POOL_ADDRESS ? [currentPool()] : ORDERS)),
    getTxPosition: vi.fn(async () => ({ block_height: 900, index: 0 })),
  };
  const blocks: VenueBlockProvider = {
    getTxBlock: vi.fn(async (txHash: string) => {
      const stamp = STAMPS[txHash];
      if (!stamp) throw new Error(`no block for ${txHash}`);
      return stamp;
    }),
  };
  return {
    chain,
    history: {
      getTxUtxos: vi.fn(async (hash: string) => {
        const tx = TXS[hash];
        if (!tx) throw new Error(`no such transaction ${hash}`);
        return tx;
      }),
    },
    blocks,
    holders: { getAssetAddresses: vi.fn(async (unit: string) => HOLDERS[unit] ?? []) },
    ...over,
  };
}

const ARGS = { poolAddress: POOL_ADDRESS, orderAddress: ORDER_ADDRESS, factoryPolicyId: FACTORY };

/** a/b == c/d, without dividing. */
function sameRate(num: bigint, denom: bigint, c: bigint, d: bigint): boolean {
  return num * d === c * denom;
}

describe('readVenueMarket — a first read is the whole story', () => {
  it('returns the trades newest first, stamped, priced as they realised', async () => {
    const { pools } = await readVenueMarket(deps(), ARGS);
    expect(pools).toHaveLength(1);
    const pool = pools[0];
    expect(pool.poolNft).toBe(POOL_NFT);
    expect(pool.head).toBe(T_WITHDRAW);
    expect(pool.utxo).toBe(`${T_WITHDRAW}#0`);
    expect(pool.trades.map((t) => t.txHash)).toEqual([T_SELL, T_BUY]);

    const [sell, buy] = pool.trades;
    expect(buy).toMatchObject({
      side: 'buy',
      inUnit: 'lovelace',
      inAmount: 100_000_000n,
      outUnit: TOKEN,
      outAmount: 983_143n,
    });
    expect(buy.time).toBe(2_000);
    expect(buy.height).toBe(101);
    // Ada over token in both directions, so a series reads the same way round.
    expect(sameRate(buy.realisedNum, buy.realisedDenom, 100_000_000n, 983_143n)).toBe(true);
    // The reserves the buy left, net of what the counters took from it.
    expect(buy.reservesAfter).toEqual({ x: 20_100_000_000n - 100_000n - 1_000_000n, y: 199_016_857n });
    expect(sell).toMatchObject({
      side: 'sell',
      inUnit: TOKEN,
      inAmount: 1_000_000n,
      outUnit: 'lovelace',
      outAmount: 99_286_154n,
    });
    expect(sameRate(sell.realisedNum, sell.realisedDenom, 99_286_154n, 1_000_000n)).toBe(true);
  });

  it('says it reached the opening, so it replaces what the caller holds and is whole', async () => {
    const [pool] = (await readVenueMarket(deps(), ARGS)).pools;
    expect(pool.reachedOpening).toBe(true);
    expect(pool.extends).toBe(false);
    expect(pool.reason).toBeUndefined();
    expect(pool.counts).toEqual({ opened: 1, swap: 2, deposit: 0, redeem: 0, feeWithdrawal: 1, unclassified: 0 });
  });

  it('reports what the counters gained, which a withdrawal does not undo', async () => {
    const [pool] = (await readVenueMarket(deps(), ARGS)).pools;
    expect(pool.earned).toEqual({ treasuryX: 100_000n, treasuryY: 1_000n, royaltyX: 1_000_000n, royaltyY: 10_000n });
  });

  it('states the reserves net of the counters, and the LQ issued', async () => {
    const [pool] = (await readVenueMarket(deps(), ARGS)).pools;
    expect(pool.reserves).toEqual({
      unitX: 'lovelace',
      x: 19_999_713_846n - 100_000n,
      unitY: TOKEN,
      y: 200_016_857n - 1_000n - 10_000n,
    });
    expect(pool.liquidity).toBe(ISSUED);
    expect(pool.lqUnit).toBe(LQ);
  });
});

describe('readVenueMarket — an incremental read extends or replaces, and says which', () => {
  it('returns only what is newer than the caller’s point, and extends', async () => {
    const [pool] = (await readVenueMarket(deps(), { ...ARGS, since: { [POOL_NFT]: T_BUY } })).pools;
    expect(pool.trades.map((t) => t.txHash)).toEqual([T_SELL]);
    expect(pool.extends).toBe(true);
    expect(pool.reachedOpening).toBe(false);
    expect(pool.reason).toBeUndefined();
    expect(pool.counts).toMatchObject({ swap: 1, feeWithdrawal: 1, opened: 0 });
  });

  it('replaces with a recent window, and says why, when its limit cuts the walk short', async () => {
    const [pool] = (await readVenueMarket(deps(), { ...ARGS, maxEvents: 2 })).pools;
    expect(pool.trades.map((t) => t.txHash)).toEqual([T_SELL]);
    expect(pool.extends).toBe(false);
    expect(pool.reachedOpening).toBe(false);
    expect(pool.reason).toMatch(/event limit/);
  });

  it('reads back to the opening and replaces when the caller’s point is not on the chain any more', async () => {
    const [pool] = (await readVenueMarket(deps(), { ...ARGS, since: { [POOL_NFT]: 'ff'.repeat(32) } })).pools;
    expect(pool.trades.map((t) => t.txHash)).toEqual([T_SELL, T_BUY]);
    expect(pool.extends).toBe(false);
    expect(pool.reachedOpening).toBe(true);
  });
});

describe('readVenueMarket — the book, the liquidity and the holders', () => {
  it('queues this pool’s orders and no other pool’s, with their terms', async () => {
    const [pool] = (await readVenueMarket(deps(), ARGS)).pools;
    expect(pool.queue.map((o) => o.ref).sort()).toEqual([`${BUY_ORDER}#0`, `${SELL_ORDER}#0`].sort());
    const buy = pool.queue.find((o) => o.ref === `${BUY_ORDER}#0`);
    expect(buy).toMatchObject({
      owner: PLACER,
      side: 'buy',
      inUnit: 'lovelace',
      amount: 100_000_000n,
      outUnit: TOKEN,
      exFee: 1_500_000n,
      placedAtHeight: 900,
    });
    expect(['fillable', 'waiting', 'unfundable', 'orphaned']).toContain(buy?.state);
    expect(typeof buy?.reason).toBe('string');
    const sell = pool.queue.find((o) => o.ref === `${SELL_ORDER}#0`);
    expect(sell).toMatchObject({ owner: OTHER_PLACER, side: 'sell', inUnit: TOKEN, amount: 1_000_000n });
  });

  it('lists liquidity providers largest first, leaving out the pool’s own unissued supply', async () => {
    const [pool] = (await readVenueMarket(deps(), ARGS)).pools;
    expect(pool.providers).toEqual([
      { address: ESCROW_ADDRESS, quantity: ISSUED - 25_000_000n },
      { address: 'addr_test1provider', quantity: 25_000_000n },
    ]);
  });

  it('counts every holder with a balance and returns the largest, as many as asked', async () => {
    const [pool] = (await readVenueMarket(deps(), { ...ARGS, holdersLimit: 2 })).pools;
    expect(pool.holders.total).toBe(4);
    // Every unit held anywhere, contracts included: 10 + 200,016,857 + 5,000,000 + 400,000.
    expect(pool.holders.supply).toBe(205_416_867n);
    expect(pool.holders.top).toEqual([
      { address: POOL_ADDRESS, quantity: 200_016_857n },
      { address: 'addr_test1big', quantity: 5_000_000n },
    ]);
  });
});

describe('readVenueMarket — scope and failure', () => {
  it('reads one pool when asked for one, and none when the one asked for is not there', async () => {
    expect((await readVenueMarket(deps(), { ...ARGS, poolNft: POOL_NFT })).pools).toHaveLength(1);
    expect((await readVenueMarket(deps(), { ...ARGS, poolNft: `${FACTORY}10${OTHER_LAUNCH}` })).pools).toHaveLength(0);
  });

  it('fails rather than returning a pool with part of its story missing', async () => {
    const broken = deps({
      holders: {
        getAssetAddresses: vi.fn(async () => {
          throw new Error('fetch failed');
        }),
      },
    });
    await expect(readVenueMarket(broken, ARGS)).rejects.toThrow(/fetch failed/);
  });

  it('refuses a limit that would walk nothing', async () => {
    await expect(readVenueMarket(deps(), { ...ARGS, maxEvents: 0 })).rejects.toThrow(/maxEvents/);
  });
});
