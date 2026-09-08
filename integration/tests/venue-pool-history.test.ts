// venue-pool-history.test.ts — does the walk follow what was SPENT?
//
// The chain below is a real pool's life: opened with 20,000 ADA against
// 200,000,000 tokens, a 100 ADA buy, a 1,000,000 token sell, then the creator
// taking their accrued royalty out. Every figure is the validators' own
// arithmetic, so a classifier that mis-reads a movement has nowhere to hide.
//
// Two things are worth more than the rest of this file.
//
//   A REFERENCE INPUT IS NEVER SPENT. Blockfrost returns reference and
//   collateral entries in the same `inputs` array as real ones, so a walk that
//   does not filter them follows a pool somebody merely LOOKED AT into a
//   history that never happened. The fixture puts the reference input first,
//   where a naive walk finds it.
//
//   RESERVES ARE NETTED; DELTAS ARE NOT. A swap's fee slices stay in the pool
//   and move to the counters, so the tradable reserve grows by less than the
//   trader put in. The 100 ADA buy below moves the balance by 100,000,000 and
//   the netted reserve by 98,900,000 — report the second as the trade and
//   every trade is understated by its own fee.

import { Data } from '@lucid-evolution/lucid';
import { describe, expect, it, vi } from 'vitest';
import type { TxUtxos } from '../blockfrost-client.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import {
  type HistoryTx,
  type HistoryTxUtxo,
  readVenuePoolHistory,
  venueFeesEarned,
  venuePoolEventFrom,
  venueSwapsOnly,
} from '../venue-pool-history.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const POOL_NFT = `${FACTORY}10${LAUNCH}`;
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN = `${TOKEN_POLICY}746f6b656e`;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const MAX_LQ = 0x7fffffffffffffffn;
const ISSUED = 1_000_000_000n;

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

/** A pool UTXO entry, as a provider reports one. */
function poolEntry(
  lovelace: bigint,
  tokens: bigint,
  datum: VenuePoolConfigData,
  over: Partial<HistoryTxUtxo> = {},
  lqHeld = MAX_LQ - ISSUED,
): HistoryTxUtxo {
  return {
    address: POOL_ADDRESS,
    amount: [
      { unit: 'lovelace', quantity: String(lovelace) },
      { unit: TOKEN, quantity: String(tokens) },
      { unit: LQ, quantity: String(lqHeld) },
      { unit: POOL_NFT, quantity: '1' },
    ],
    inline_datum: Data.to(datum, VenuePoolConfigSchema),
    ...over,
  };
}

/** Something at the pool address that is not the pool: no NFT. */
function noise(): HistoryTxUtxo {
  return {
    address: POOL_ADDRESS,
    amount: [{ unit: 'lovelace', quantity: '2000000' }],
    inline_datum: null,
  };
}

// --- the pool's life, oldest first -----------------------------------------

const OPENED = poolDatum();
const AFTER_BUY = poolDatum({ treasury_x: 100_000n, royalty_x: 1_000_000n });
const AFTER_SELL = poolDatum({
  treasury_x: 100_000n,
  royalty_x: 1_000_000n,
  treasury_y: 1_000n,
  royalty_y: 10_000n,
});
// The creator takes their 1,000,000 lovelace of accrued royalty out.
const AFTER_WITHDRAW = poolDatum({
  treasury_x: 100_000n,
  royalty_x: 0n,
  treasury_y: 1_000n,
  royalty_y: 10_000n,
});

const TXS: Record<string, HistoryTx> = {
  [T_OPEN]: {
    hash: T_OPEN,
    inputs: [noise()],
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

function providerFor(txs: Record<string, HistoryTx> = TXS) {
  return {
    getTxUtxos: vi.fn(async (hash: string) => {
      const tx = txs[hash];
      if (!tx) throw new Error(`no such transaction ${hash}`);
      return tx;
    }),
  };
}

const ARGS = { pool: { txHash: T_WITHDRAW }, factoryPolicyId: FACTORY };

// ---------------------------------------------------------------------------

describe('walking the pool back to where it started', () => {
  it('finds every event, newest first, and knows it reached the beginning', async () => {
    const history = await readVenuePoolHistory(providerFor(), ARGS);
    expect(history.events.map((e) => e.kind)).toEqual(['feeWithdrawal', 'swap', 'swap', 'opened']);
    expect(history.events.map((e) => e.txHash)).toEqual([T_WITHDRAW, T_SELL, T_BUY, T_OPEN]);
    expect(history.reachedGenesis).toBe(true);
    expect(history.stoppedBy).toBeUndefined();
  });

  it('carries the reserves after every event, which is the point of it', async () => {
    const history = await readVenuePoolHistory(providerFor(), ARGS);
    const buy = history.events.find((e) => e.txHash === T_BUY);
    // Netted: the balance less what the creator and the platform have accrued.
    expect(buy?.after.reservesX).toBe(20_098_900_000n);
    expect(buy?.after.reservesY).toBe(199_016_857n);
    expect(buy?.after.balanceX).toBe(20_100_000_000n);
    expect(buy?.before?.reservesX).toBe(20_000_000_000n);
  });

  it('reports a trade at what it executed at, not net of its own fee', async () => {
    const history = await readVenuePoolHistory(providerFor(), ARGS);
    const buy = history.events.find((e) => e.txHash === T_BUY);
    expect(buy?.swap).toEqual({
      inputUnit: 'lovelace',
      outputUnit: TOKEN,
      tradedIn: 100_000_000n,
      paidOut: 983_143n,
    });
    // The netted reserve moved by less — by exactly the two fee slices.
    expect((buy?.after.reservesX ?? 0n) - (buy?.before?.reservesX ?? 0n)).toBe(98_900_000n);
  });

  it('reads a sell as a sell, in the other direction', async () => {
    const history = await readVenuePoolHistory(providerFor(), ARGS);
    const sell = history.events.find((e) => e.txHash === T_SELL);
    expect(sell?.swap).toEqual({
      inputUnit: TOKEN,
      outputUnit: 'lovelace',
      tradedIn: 1_000_000n,
      paidOut: 99_286_154n,
    });
    expect(sell?.accrued.royaltyY).toBe(10_000n);
  });

  it('knows a fee withdrawal moves the balance and not the price', async () => {
    const history = await readVenuePoolHistory(providerFor(), ARGS);
    const withdrawal = history.events[0];
    expect(withdrawal?.kind).toBe('feeWithdrawal');
    expect(withdrawal?.accrued.royaltyX).toBe(-1_000_000n);
    // The balance fell by exactly the accrued amount, so the tradable reserve
    // did not move at all — nobody's price changed.
    expect(withdrawal?.after.balanceX).toBe((withdrawal?.before?.balanceX ?? 0n) - 1_000_000n);
    expect(withdrawal?.after.reservesX).toBe(withdrawal?.before?.reservesX);
  });
});

describe('following what was spent, not what was looked at', () => {
  it('ignores a reference input carrying the pool', async () => {
    // An older state of the pool, referenced rather than spent, listed FIRST
    // where a walk that does not filter finds it.
    const withReference: Record<string, HistoryTx> = {
      ...TXS,
      [T_SELL]: {
        hash: T_SELL,
        inputs: [
          poolEntry(20_000_000_000n, 200_000_000n, OPENED, {
            tx_hash: T_OPEN,
            output_index: 0,
            reference: true,
          }),
          poolEntry(20_100_000_000n, 199_016_857n, AFTER_BUY, { tx_hash: T_BUY, output_index: 0 }),
        ],
        outputs: [poolEntry(20_000_713_846n, 200_016_857n, AFTER_SELL)],
      },
    };
    const history = await readVenuePoolHistory(providerFor(withReference), ARGS);
    // Following the reference would skip the buy entirely.
    expect(history.events.map((e) => e.txHash)).toEqual([T_WITHDRAW, T_SELL, T_BUY, T_OPEN]);
    expect(history.events.find((e) => e.txHash === T_SELL)?.previousTxHash).toBe(T_BUY);
  });

  it('ignores a collateral entry carrying the pool', () => {
    const event = venuePoolEventFrom({
      tx: {
        hash: T_SELL,
        inputs: [
          poolEntry(20_000_000_000n, 200_000_000n, OPENED, {
            tx_hash: T_OPEN,
            output_index: 0,
            collateral: true,
          }),
          poolEntry(20_100_000_000n, 199_016_857n, AFTER_BUY, { tx_hash: T_BUY, output_index: 0 }),
        ],
        outputs: [poolEntry(20_000_713_846n, 200_016_857n, AFTER_SELL)],
      },
      factoryPolicyId: FACTORY,
    });
    expect(event?.previousTxHash).toBe(T_BUY);
  });

  it('is not fooled by an NFT minted under somebody else’s policy', () => {
    const forged = venuePoolEventFrom({ tx: TXS[T_BUY] as HistoryTx, factoryPolicyId: 'ee'.repeat(28) });
    expect(forged).toBeNull();
  });
});

describe('stopping short', () => {
  it('reads only what has happened since a transaction already known', async () => {
    const history = await readVenuePoolHistory(providerFor(), { ...ARGS, stopAtTxHash: T_BUY });
    expect(history.events.map((e) => e.txHash)).toEqual([T_WITHDRAW, T_SELL]);
    expect(history.reachedGenesis).toBe(false);
    expect(history.stoppedBy).toBe('stopAtTxHash');
  });

  it('bounds a feed, and says it was bounded', async () => {
    const history = await readVenuePoolHistory(providerFor(), { ...ARGS, maxEvents: 2 });
    expect(history.events).toHaveLength(2);
    expect(history.reachedGenesis).toBe(false);
    expect(history.stoppedBy).toBe('maxEvents');
  });

  it('says so when the chain does not lead anywhere', async () => {
    const broken: Record<string, HistoryTx> = {
      ...TXS,
      [T_BUY]: {
        hash: T_BUY,
        inputs: [poolEntry(20_000_000_000n, 200_000_000n, OPENED, { tx_hash: T_OPEN, output_index: 0 })],
        // No pool output at all: the chain stops here without reaching genesis.
        outputs: [noise()],
      },
    };
    const history = await readVenuePoolHistory(providerFor(broken), ARGS);
    expect(history.reachedGenesis).toBe(false);
    expect(history.stoppedBy).toBe('brokenChain');
  });
});

describe('what a real client hands it', () => {
  it('accepts what BlockfrostClient.getTxUtxos returns, field for field', () => {
    // A compile-time check that the client's own type satisfies the walk's,
    // so the two cannot drift apart silently.
    const fromClient: TxUtxos = {
      hash: T_BUY,
      inputs: [
        {
          address: POOL_ADDRESS,
          amount: [{ unit: 'lovelace', quantity: '20000000000' }],
          tx_hash: T_OPEN,
          output_index: 0,
          inline_datum: null,
          reference: false,
          collateral: false,
        },
      ],
      outputs: [{ address: POOL_ADDRESS, amount: [], output_index: 0, inline_datum: null }],
    };
    const asHistory: HistoryTx = fromClient;
    expect(asHistory.hash).toBe(T_BUY);
  });

  it('says the chain is broken rather than inventing a link when a datum is missing', () => {
    const event = venuePoolEventFrom({
      tx: {
        hash: T_BUY,
        inputs: [
          {
            ...poolEntry(20_000_000_000n, 200_000_000n, OPENED, { tx_hash: T_OPEN, output_index: 0 }),
            inline_datum: null,
          },
        ],
        outputs: [poolEntry(20_100_000_000n, 199_016_857n, AFTER_BUY)],
      },
      factoryPolicyId: FACTORY,
    });
    // No readable predecessor, so it cannot claim to know what came before.
    expect(event?.kind).toBe('opened');
    expect(event?.before).toBeUndefined();
  });
});

describe('reading liquidity and fees off the walk', () => {
  it('tells a deposit from a redeem by which way the liquidity went', () => {
    const deposited = poolEntry(22_000_000_000n, 220_000_000n, OPENED, {}, MAX_LQ - ISSUED - 100_000_000n);
    const deposit = venuePoolEventFrom({
      tx: {
        hash: T_BUY,
        inputs: [poolEntry(20_000_000_000n, 200_000_000n, OPENED, { tx_hash: T_OPEN, output_index: 0 })],
        outputs: [deposited],
      },
      factoryPolicyId: FACTORY,
    });
    expect(deposit?.kind).toBe('deposit');

    const redeem = venuePoolEventFrom({
      tx: {
        hash: T_SELL,
        inputs: [{ ...deposited, tx_hash: T_BUY, output_index: 0 }],
        outputs: [poolEntry(20_000_000_000n, 200_000_000n, OPENED)],
      },
      factoryPolicyId: FACTORY,
    });
    expect(redeem?.kind).toBe('redeem');
  });

  it('sums what was EARNED, which a withdrawal has already erased from the datum', async () => {
    const history = await readVenuePoolHistory(providerFor(), ARGS);
    const earned = venueFeesEarned(history);
    // The datum now says 0 royalty owed on the ada side; 1,000,000 was earned.
    expect(history.events[0]?.after.datum.royalty_x).toBe(0n);
    expect(earned.royaltyX).toBe(1_000_000n);
    expect(earned.treasuryX).toBe(100_000n);
    expect(earned.royaltyY).toBe(10_000n);
  });

  it('hands a price feed the swaps and nothing else', async () => {
    const history = await readVenuePoolHistory(providerFor(), ARGS);
    expect(venueSwapsOnly(history).map((e) => e.txHash)).toEqual([T_SELL, T_BUY]);
  });

  it('reports a movement matching nothing rather than guessing at it', () => {
    // Both reserves up, but no liquidity issued: not a deposit, not a swap.
    const odd = venuePoolEventFrom({
      tx: {
        hash: T_BUY,
        inputs: [poolEntry(20_000_000_000n, 200_000_000n, OPENED, { tx_hash: T_OPEN, output_index: 0 })],
        outputs: [poolEntry(21_000_000_000n, 210_000_000n, OPENED)],
      },
      factoryPolicyId: FACTORY,
    });
    expect(odd?.kind).toBe('unclassified');
    expect(odd?.reason).toMatch(/matches none of the shapes/);
  });
});
