// venue-chain-reader.test.ts — what does the reader refuse, and does it say so?
//
// Both venue scripts are shared by every pool and every order in the venue, so
// the address proves nothing and anyone may park anything at either. The
// questions worth testing are therefore about REFUSAL, and about whether a
// refusal is visible: a reader that returns three pools when the chain holds
// four looks exactly like a chain that holds three, and the difference is a
// launch whose market has quietly stopped trading.
//
// Every rejection fixture below is the accepted one with a single change, so a
// fixture that fails for two reasons cannot pass for one.

import { Data } from '@lucid-evolution/lucid';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProviderUtxo,
  readVenueFillRound,
  readVenuePools,
  readVenueSwapOrders,
  type VenueChainProvider,
} from '../venue-chain-reader.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import { type VenueSwapConfigData, VenueSwapConfigSchema } from '../venue-swap.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const POOL_NFT = `${FACTORY}10${LAUNCH}`;
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN = `${'bb'.repeat(28)}746f6b656e`;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const ORDER_ADDRESS = 'addr_test1wq11111111111111111111111111111111111111111111111111gdvxvz';
const MAX_LQ = 0x7fffffffffffffffn;

function poolDatum(over: Partial<VenuePoolConfigData> = {}): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: `10${LAUNCH}` },
    pool_x: { policy: '', name: '' },
    pool_y: { policy: 'bb'.repeat(28), name: '746f6b656e' },
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
    output: { policy: 'bb'.repeat(28), name: '746f6b656e' },
    tradable_input: 100_000_000n,
    base_price: { num: 9n, denom: 1_000n },
    min_marginal_output: 0n,
    ex_fee: 1_500_000n,
    reward_pkh: '0d'.repeat(28),
    stake_pkh: null,
    permitted_executors: [],
    ...over,
  };
}

/** A live pool: the whole raise, the LP reserve, the NFT and the rest of the LQ. */
function poolUtxo(over: Partial<ProviderUtxo> = {}): ProviderUtxo {
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
    ...over,
  };
}

function orderUtxo(over: Partial<ProviderUtxo> = {}): ProviderUtxo {
  return {
    tx_hash: '02'.repeat(32),
    output_index: 0,
    address: ORDER_ADDRESS,
    amount: [{ unit: 'lovelace', quantity: '103000000' }],
    inline_datum: Data.to(swapDatum(), VenueSwapConfigSchema),
    ...over,
  };
}

function providerWith(utxos: ProviderUtxo[], positions: Record<string, { block_height: number; index: number }> = {}) {
  const provider: VenueChainProvider = {
    getAddressUtxosAll: vi.fn().mockResolvedValue(utxos),
    getTxPosition: vi.fn(async (txHash: string) => positions[txHash] ?? { block_height: 1_000, index: 0 }),
  };
  return provider;
}

// ---------------------------------------------------------------------------

describe('finding the pools', () => {
  const args = { poolAddress: POOL_ADDRESS, factoryPolicyId: FACTORY };

  it('reads a live pool, its reserves and its accrued counters', async () => {
    const read = await readVenuePools(providerWith([poolUtxo()]), args);
    expect(read.skipped).toEqual([]);
    expect(read.pools).toHaveLength(1);
    expect(read.pools[0]?.assets.lovelace).toBe(20_000_000_000n);
    expect(read.pools[0]?.assets[POOL_NFT]).toBe(1n);
    expect(read.pools[0]?.datum.fee_num).toBe(99_900n);
    expect(read.pools[0]?.address).toBe(POOL_ADDRESS);
  });

  it('refuses a UTXO that merely sits at the pool address', async () => {
    // The same datum, and no NFT. Somebody parked a copy of a real pool's
    // state at the address; without the token it is not a pool, which is
    // exactly what the pool validator says too.
    const parked = poolUtxo({ amount: [{ unit: 'lovelace', quantity: '20000000000' }] });
    const read = await readVenuePools(providerWith([parked]), args);
    expect(read.pools).toEqual([]);
    expect(read.skipped[0]?.reason).toMatch(/sitting at the pool address is not being a pool/);
  });

  it('refuses an NFT minted under somebody else’s policy', async () => {
    // A forger mints their own NFT and writes a datum naming it. Every test
    // derived from the datum alone passes; the factory's policy is what does
    // not.
    const forgedPolicy = 'ba'.repeat(28);
    const forged = poolUtxo({
      amount: [
        { unit: 'lovelace', quantity: '20000000000' },
        { unit: `${forgedPolicy}10${LAUNCH}`, quantity: '1' },
      ],
      inline_datum: Data.to(
        poolDatum({ pool_nft: { policy: forgedPolicy, name: `10${LAUNCH}` } }),
        VenuePoolConfigSchema,
      ),
    });
    const read = await readVenuePools(providerWith([forged]), args);
    expect(read.pools).toEqual([]);
    expect(read.skipped[0]?.reason).toMatch(/carries no single pool NFT under the factory policy/);
  });

  it('refuses a pool holding two of the factory’s NFTs rather than choosing', async () => {
    const twoNfts = poolUtxo({
      amount: [...poolUtxo().amount, { unit: `${FACTORY}10${'ab'.repeat(31)}`, quantity: '1' }],
    });
    const read = await readVenuePools(providerWith([twoNfts]), args);
    expect(read.pools).toEqual([]);
    expect(read.skipped[0]?.reason).toMatch(/no single pool NFT/);
  });

  it('does not mistake the LQ token for identity', async () => {
    // LQ shares the factory's policy and is fungible, so a balance of it says
    // nothing about which pool this is. Dropping the NFT leaves LQ behind.
    const lqOnly = poolUtxo({
      amount: [
        { unit: 'lovelace', quantity: '20000000000' },
        { unit: LQ, quantity: '5' },
      ],
    });
    const read = await readVenuePools(providerWith([lqOnly]), args);
    expect(read.pools).toEqual([]);
  });

  it('refuses a pool whose datum names a different NFT than it holds', async () => {
    const mismatched = poolUtxo({
      inline_datum: Data.to(
        poolDatum({ pool_nft: { policy: FACTORY, name: `10${'cd'.repeat(31)}` } }),
        VenuePoolConfigSchema,
      ),
    });
    const read = await readVenuePools(providerWith([mismatched]), args);
    expect(read.pools).toEqual([]);
    expect(read.skipped[0]?.reason).toMatch(/must be the same pool/);
  });

  it('refuses a datum that is not a pool config, without throwing', async () => {
    const junk = poolUtxo({ inline_datum: Data.to(new Map([[1n, 2n]])) });
    const read = await readVenuePools(providerWith([junk]), args);
    expect(read.pools).toEqual([]);
    expect(read.skipped[0]?.reason).toMatch(/datum is not a pool config/);
  });

  it('refuses a pool whose state is held by hash rather than inline', async () => {
    const read = await readVenuePools(providerWith([poolUtxo({ inline_datum: null })]), args);
    expect(read.pools).toEqual([]);
    expect(read.skipped[0]?.reason).toMatch(/no inline datum/);
  });

  it('reads the good ones and accounts for every bad one', async () => {
    const second = poolUtxo({
      tx_hash: '03'.repeat(32),
      amount: [
        { unit: 'lovelace', quantity: '5000000000' },
        { unit: TOKEN, quantity: '100000000' },
        { unit: LQ, quantity: String(MAX_LQ - 500_000_000n) },
        { unit: POOL_NFT, quantity: '1' },
      ],
    });
    const read = await readVenuePools(
      providerWith([poolUtxo(), poolUtxo({ tx_hash: '04'.repeat(32), inline_datum: null }), second]),
      args,
    );
    expect(read.pools).toHaveLength(2);
    expect(read.skipped).toHaveLength(1);
    // The count is the point: two plus one is the three the chain held.
    expect(read.pools.length + read.skipped.length).toBe(3);
  });
});

describe('finding the orders', () => {
  const args = { orderAddress: ORDER_ADDRESS, knownPools: [POOL_NFT] };

  it('reads an open request and where the chain accepted it', async () => {
    const provider = providerWith([orderUtxo()], { ['02'.repeat(32)]: { block_height: 12_345, index: 7 } });
    const read = await readVenueSwapOrders(provider, args);
    expect(read.skipped).toEqual([]);
    expect(read.orders).toHaveLength(1);
    expect(read.orders[0]?.datum.tradable_input).toBe(100_000_000n);
    expect(read.orders[0]?.placedAt).toEqual({ blockHeight: 12_345, txIndexInBlock: 7 });
  });

  it('sets aside a request naming a pool it did not find', async () => {
    const elsewhere = orderUtxo({
      inline_datum: Data.to(
        swapDatum({ pool_nft: { policy: FACTORY, name: `10${'ef'.repeat(31)}` } }),
        VenueSwapConfigSchema,
      ),
    });
    const read = await readVenueSwapOrders(providerWith([elsewhere]), args);
    expect(read.orders).toEqual([]);
    expect(read.skipped[0]?.reason).toMatch(/not one of the pools this reader found/);
  });

  it('sets aside a datum that is not a swap request, without throwing', async () => {
    const junk = orderUtxo({ inline_datum: Data.to(new Map([[1n, 2n]])) });
    const read = await readVenueSwapOrders(providerWith([junk]), args);
    expect(read.orders).toEqual([]);
    expect(read.skipped[0]?.reason).toMatch(/datum is not a swap request/);
  });

  it('looks a placement up once however many orders share the transaction', async () => {
    const provider = providerWith(
      [orderUtxo({ output_index: 0 }), orderUtxo({ output_index: 1 }), orderUtxo({ output_index: 2 })],
      { ['02'.repeat(32)]: { block_height: 9, index: 3 } },
    );
    const read = await readVenueSwapOrders(provider, args);
    expect(read.orders).toHaveLength(3);
    expect(provider.getTxPosition).toHaveBeenCalledTimes(1);
    expect(read.orders.every((o) => o.placedAt?.blockHeight === 9)).toBe(true);
  });

  it('asks for nothing it was already told', async () => {
    const provider = providerWith([orderUtxo()]);
    const positions = new Map([['02'.repeat(32), { blockHeight: 5, txIndexInBlock: 1 }]]);
    const read = await readVenueSwapOrders(provider, { ...args, positions });
    expect(provider.getTxPosition).not.toHaveBeenCalled();
    expect(read.orders[0]?.placedAt).toEqual({ blockHeight: 5, txIndexInBlock: 1 });
  });

  it('reads the good ones and accounts for every bad one', async () => {
    const read = await readVenueSwapOrders(
      providerWith([
        orderUtxo(),
        orderUtxo({ tx_hash: '05'.repeat(32), inline_datum: null }),
        orderUtxo({ tx_hash: '06'.repeat(32), output_index: 1 }),
      ]),
      args,
    );
    expect(read.orders).toHaveLength(2);
    expect(read.skipped).toHaveLength(1);
  });
});

describe('a round of work', () => {
  const args = { poolAddress: POOL_ADDRESS, orderAddress: ORDER_ADDRESS, factoryPolicyId: FACTORY };

  /** Orders and pools come back from one provider, keyed by address. */
  function twoAddressProvider(
    pools: ProviderUtxo[],
    orders: ProviderUtxo[],
    positions: Record<string, { block_height: number; index: number }> = {},
  ): VenueChainProvider {
    return {
      getAddressUtxosAll: vi.fn(async (address: string) => (address === POOL_ADDRESS ? pools : orders)),
      getTxPosition: vi.fn(async (txHash: string) => positions[txHash] ?? { block_height: 1, index: 0 }),
    };
  }

  it('hands back work in the order the chain accepted it, not the order it was read', async () => {
    const later = orderUtxo({ tx_hash: 'aa'.repeat(32) });
    const earlier = orderUtxo({ tx_hash: 'bb'.repeat(32) });
    const earliest = orderUtxo({ tx_hash: 'cc'.repeat(32) });
    const round = await readVenueFillRound(
      twoAddressProvider([poolUtxo()], [later, earlier, earliest], {
        ['aa'.repeat(32)]: { block_height: 100, index: 5 },
        ['bb'.repeat(32)]: { block_height: 100, index: 2 },
        ['cc'.repeat(32)]: { block_height: 99, index: 40 },
      }),
      args,
    );
    expect(round.candidates.map((c) => c.order.txHash)).toEqual(['cc'.repeat(32), 'bb'.repeat(32), 'aa'.repeat(32)]);
    expect(round.unfillable).toEqual([]);
  });

  it('prices each candidate against the pool it names', async () => {
    const round = await readVenueFillRound(twoAddressProvider([poolUtxo()], [orderUtxo()]), args);
    expect(round.candidates).toHaveLength(1);
    // The whole order clears its floor against a 20,000 ADA pool.
    expect(round.candidates[0]?.traded).toBe(100_000_000n);
    expect(round.candidates[0]?.pool.datum.fee_num).toBe(99_900n);
  });

  it('says why an order cannot be filled rather than dropping it', async () => {
    // A floor above spot: nothing clears it, at any fee.
    const tooTight = orderUtxo({
      inline_datum: Data.to(swapDatum({ base_price: { num: 1n, denom: 1n } }), VenueSwapConfigSchema),
    });
    const round = await readVenueFillRound(twoAddressProvider([poolUtxo()], [tooTight]), args);
    expect(round.candidates).toEqual([]);
    expect(round.unfillable[0]?.reason).toMatch(/nothing clears its price floor/);
  });

  it('says when the pool can serve it but the fee cannot pay for that much', async () => {
    // A floor tight enough that only a slice clears, and a fee funding one
    // whole fill and no less.
    const slice = orderUtxo({
      inline_datum: Data.to(
        swapDatum({ base_price: { num: 98_781n, denom: 10_000_000n }, ex_fee: 1_500_000n }),
        VenueSwapConfigSchema,
      ),
    });
    const round = await readVenueFillRound(twoAddressProvider([poolUtxo()], [slice]), args);
    expect(round.candidates).toEqual([]);
    expect(round.unfillable[0]?.reason).toMatch(/the fee only funds a fill of/);
  });

  it('carries every declined UTXO through, pools and orders together', async () => {
    const round = await readVenueFillRound(
      twoAddressProvider(
        [poolUtxo(), poolUtxo({ tx_hash: '07'.repeat(32), inline_datum: null })],
        [orderUtxo(), orderUtxo({ tx_hash: '08'.repeat(32), inline_datum: null })],
      ),
      args,
    );
    expect(round.candidates).toHaveLength(1);
    expect(round.skipped).toHaveLength(2);
    expect(round.skipped.map((s) => s.txHash).sort()).toEqual(['07'.repeat(32), '08'.repeat(32)]);
  });
});
