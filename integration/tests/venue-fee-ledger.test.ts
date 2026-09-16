// venue-fee-ledger.test.ts — is a collection worth the transaction it costs,
// and does the record add up?
//
// Two things here are worth more than the rest.
//
//   THE ADA SIDE PAYS FOR ITS OWN COLLECTION AND THE TOKEN SIDE NEVER DOES.
//   A withdrawal costs one network fee in lovelace and returns whatever has
//   accrued. So the decision turns on the ADA counter alone — the tokens come
//   out in the same transaction for nothing, which makes them no reason to go
//   and no reason to wait. A ledger that added the token side in at spot would
//   advise collecting pools that lose money on every collection.
//
//   EARNED LESS WITHDRAWN MUST EQUAL WHAT IS OWED. Over a COMPLETE history
//   that is a real assertion rather than arithmetic: a pool opens with all
//   four counters at zero, so anything owed today was earned on the record and
//   not yet taken. A gap says the pool is carrying a claim nothing paid for.
//   Over a partial history the same number means something else entirely, and
//   `complete` is the only thing that tells them apart.
//
// The pool below is the one the rest of the venue's tests use: 20,000 ADA
// against 200,000,000 tokens, a 120 basis point fee split 10/100/10 between
// the platform, the creator and the pool itself.

import { Data } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import {
  VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE,
  venueAccruedIsZero,
  venueCollectionAdvice,
  venueCollectionFrom,
  venueFeeLedger,
  venuePoolFeeReport,
  venueReconcileFees,
  venueTokenSideLovelace,
  venueTreasuryPosition,
} from '../venue-fee-ledger.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import {
  type HistoryTx,
  type HistoryTxUtxo,
  type VenuePoolHistory,
  venuePoolEventFrom,
} from '../venue-pool-history.js';
import type { VenuePoolUtxo } from '../venue-swap.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const POOL_NFT = `${FACTORY}10${LAUNCH}`;
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN = `${TOKEN_POLICY}746f6b656e`;
const USDM_POLICY = 'cc'.repeat(28);
const USDM = `${USDM_POLICY}55534444`;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const MAX_LQ = 0x7fffffffffffffffn;
const ISSUED = 1_000_000_000n;
const PLATFORM = 'ee'.repeat(28);

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
    treasury_address: PLATFORM,
    royalty_pub_key: 'ff'.repeat(32),
    nonce: 0n,
    ...over,
  };
}

function pool(over: Partial<VenuePoolConfigData> = {}, utxo: Partial<VenuePoolUtxo> = {}): VenuePoolUtxo {
  return {
    txHash: '01'.repeat(32),
    outputIndex: 0,
    address: POOL_ADDRESS,
    assets: {
      lovelace: 20_000_000_000n,
      [TOKEN]: 200_000_000n,
      [LQ]: MAX_LQ - ISSUED,
      [POOL_NFT]: 1n,
    },
    datum: poolDatum(over),
    ...utxo,
  };
}

/** 1 ADA and 50,000 tokens to the platform; 10 ADA and 500,000 to the creator. */
const EARNING = { treasury_x: 1_000_000n, treasury_y: 50_000n, royalty_x: 10_000_000n, royalty_y: 500_000n };
/** Under what a withdrawal costs, with a token side worth many times it. */
const THIN = { treasury_x: 300_000n, treasury_y: 20_000n };

describe('what a pool owes the platform', () => {
  it('splits the counters into what can pay for its own collection and what cannot', () => {
    const position = venueTreasuryPosition(pool(EARNING));
    expect(position.owedX).toBe(1_000_000n);
    expect(position.owedY).toBe(50_000n);
    expect(position.owedLovelace).toBe(1_000_000n);
    expect(position.owedTokens).toEqual([{ unit: TOKEN, amount: 50_000n }]);
    // Reported, and moved by a different redeemer under the creator's own key.
    expect(position.creatorOwed).toEqual({ x: 10_000_000n, y: 500_000n });
  });

  it('finds the ada side whichever of the two it is', () => {
    const flipped = venueTreasuryPosition(
      pool({
        pool_x: { policy: TOKEN_POLICY, name: '746f6b656e' },
        pool_y: { policy: '', name: '' },
        treasury_x: 50_000n,
        treasury_y: 1_000_000n,
      }),
    );
    expect(flipped.owedLovelace).toBe(1_000_000n);
    expect(flipped.owedTokens).toEqual([{ unit: TOKEN, amount: 50_000n }]);
  });

  it('reports no lovelace at all on a token-to-token pool, where both counters are tokens', () => {
    const position = venueTreasuryPosition(
      pool({
        pool_x: { policy: USDM_POLICY, name: '55534444' },
        pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
        treasury_x: 3_000n,
        treasury_y: 40_000n,
      }),
    );
    expect(position.owedLovelace).toBe(0n);
    expect(position.owedTokens).toEqual([
      { unit: USDM, amount: 3_000n },
      { unit: TOKEN, amount: 40_000n },
    ]);
  });
});

describe('whether to collect', () => {
  it('collects when the ada counter clears the fee, and nets exactly the difference', () => {
    const advice = venueCollectionAdvice({ pool: pool(EARNING) });
    expect(advice.collect).toBe(true);
    expect(advice.netLovelace).toBe(1_000_000n - VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE);
    expect(advice.reason).toContain('token side comes out in the same transaction');
  });

  it('waits when the ada counter is under the fee, however many tokens sit beside it', () => {
    const advice = venueCollectionAdvice({ pool: pool(THIN) });
    expect(advice.collect).toBe(false);
    expect(advice.netLovelace).toBe(300_000n - VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE);
    expect(advice.reason).toContain('worse off');
    // The tokens are real and worth having; they are simply not a reason to
    // pay a fee today, because they cost nothing to collect tomorrow.
    expect(advice.position.owedTokens).toEqual([{ unit: TOKEN, amount: 20_000n }]);
    expect(advice.tokenSideLovelace).toBeGreaterThan(0n);
  });

  it('is not fooled by a token side worth many times the fee', () => {
    // 20,000 tokens are worth about 2 ADA here — three times what the
    // withdrawal costs. Collecting still loses money, because a token has to
    // be sold before it pays for anything and selling it costs another
    // transaction.
    const advice = venueCollectionAdvice({ pool: pool(THIN) });
    expect(advice.tokenSideLovelace).toBeGreaterThan(VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE * 2n);
    expect(advice.collect).toBe(false);
  });

  it('says nothing has accrued rather than that it is not worth collecting', () => {
    const advice = venueCollectionAdvice({ pool: pool() });
    expect(advice.collect).toBe(false);
    expect(advice.reason).toContain('nothing has accrued');
  });

  it('takes the operator’s own cost figure when one is given', () => {
    const advice = venueCollectionAdvice({ pool: pool(THIN), costLovelace: 200_000n });
    expect(advice.collect).toBe(true);
    expect(advice.netLovelace).toBe(100_000n);
  });

  it('never collects on a token-to-token pool, where every withdrawal costs lovelace and returns none', () => {
    const advice = venueCollectionAdvice({
      pool: pool({
        pool_x: { policy: USDM_POLICY, name: '55534444' },
        pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
        treasury_x: 3_000n,
        treasury_y: 40_000n,
      }),
    });
    expect(advice.collect).toBe(false);
    expect(advice.netLovelace).toBe(-VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE);
    expect(advice.tokenSideLovelace).toBeNull();
  });
});

describe('valuing the token side', () => {
  it('prices it through the pool’s own quote, so the sale moves the price against itself', () => {
    // 50,000 tokens against 19,989,000,000 lovelace and 199,450,000 tokens,
    // at the pool's own 98,800/100,000 net rate.
    expect(venueTokenSideLovelace(pool(EARNING))).toBe(4_949_672n);
  });

  it('is nothing when nothing has accrued on the token side', () => {
    expect(venueTokenSideLovelace(pool({ treasury_x: 1_000_000n }))).toBeNull();
  });

  it('is nothing when the pool has no ada side to price against', () => {
    expect(
      venueTokenSideLovelace(
        pool({
          pool_x: { policy: USDM_POLICY, name: '55534444' },
          treasury_y: 40_000n,
        }),
      ),
    ).toBeNull();
  });

  it('is nothing when a side of the pool is empty, where no price exists at all', () => {
    expect(venueTokenSideLovelace(pool({ treasury_y: 40_000n }, { assets: { lovelace: 20_000_000_000n } }))).toBeNull();
  });
});

describe('the book across every pool', () => {
  const POOLS = [
    pool(EARNING),
    pool(THIN, { txHash: '02'.repeat(32) }),
    pool({}, { txHash: '03'.repeat(32) }),
    pool(
      {
        pool_x: { policy: USDM_POLICY, name: '55534444' },
        pool_y: { policy: TOKEN_POLICY, name: '746f6b656e' },
        treasury_x: 3_000n,
        treasury_y: 40_000n,
      },
      { txHash: '04'.repeat(32) },
    ),
  ];

  it('totals the platform’s claim by unit, lovelace first', () => {
    const ledger = venueFeeLedger({ pools: POOLS });
    expect(ledger.owedByUnit).toEqual([
      { unit: 'lovelace', amount: 1_300_000n },
      { unit: TOKEN, amount: 110_000n },
      { unit: USDM, amount: 3_000n },
    ]);
  });

  it('totals the creator’s claim separately, and never proposes moving it', () => {
    const ledger = venueFeeLedger({ pools: POOLS });
    expect(ledger.creatorOwedByUnit).toEqual([
      { unit: 'lovelace', amount: 10_000_000n },
      { unit: TOKEN, amount: 500_000n },
    ]);
  });

  it('proposes only the pools that pay for themselves', () => {
    const ledger = venueFeeLedger({ pools: POOLS });
    expect(ledger.collect).toHaveLength(1);
    expect(ledger.collect[0]?.position.owedLovelace).toBe(1_000_000n);
    expect(ledger.netLovelace).toBe(580_000n);
  });

  it('shows what sweeping every pool would cost instead, so the advice can be overruled on its own terms', () => {
    const ledger = venueFeeLedger({ pools: POOLS });
    // 580,000 gained on the first, 120,000 lost on the second, 420,000 lost on
    // the token-to-token pool. The empty pool is not withdrawable at all —
    // `treasury.ak` requires a side to really move — so it costs nothing here.
    expect(ledger.netLovelaceIfAll).toBe(40_000n);
    expect(ledger.netLovelace).toBeGreaterThan(ledger.netLovelaceIfAll);
  });

  it('orders the collections by what they net', () => {
    const richer = pool({ treasury_x: 9_000_000n }, { txHash: '05'.repeat(32) });
    const ledger = venueFeeLedger({ pools: [...POOLS, richer] });
    expect(ledger.collect.map((a) => a.netLovelace)).toEqual([8_580_000n, 580_000n]);
  });

  it('carries the pool’s market state alongside its fee position, off one datum', () => {
    const report = venuePoolFeeReport(pool(EARNING));
    expect(report.market.accrued.treasuryX).toBe(1_000_000n);
    expect(report.advice.position.owedLovelace).toBe(1_000_000n);
    // The reserves the market reports are already net of both counters, which
    // is why the fee position is a separate number rather than part of TVL.
    expect(report.market.reservesX).toBe(19_989_000_000n);
  });
});

// --- reconciliation, against a real walked history --------------------------

const T_OPEN = '01'.repeat(32);
const T_BUY = '02'.repeat(32);
const T_SELL = '03'.repeat(32);
const T_ROYALTY = '04'.repeat(32);
const T_COLLECT = '05'.repeat(32);

function entry(lovelace: bigint, tokens: bigint, datum: VenuePoolConfigData, over: Partial<HistoryTxUtxo> = {}) {
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
/** The creator takes their accrued lovelace out. Nothing of the platform's moves. */
const AFTER_ROYALTY = poolDatum({ treasury_x: 100_000n, royalty_x: 0n, treasury_y: 1_000n, royalty_y: 10_000n });
/** Then the platform takes both of its own counters. */
const AFTER_COLLECT = poolDatum({ treasury_x: 0n, royalty_x: 0n, treasury_y: 0n, royalty_y: 10_000n });

const TXS: Record<string, HistoryTx> = {
  [T_OPEN]: { hash: T_OPEN, inputs: [], outputs: [entry(20_000_000_000n, 200_000_000n, OPENED)] },
  [T_BUY]: {
    hash: T_BUY,
    inputs: [entry(20_000_000_000n, 200_000_000n, OPENED, { tx_hash: T_OPEN, output_index: 0 })],
    outputs: [entry(20_100_000_000n, 199_016_857n, AFTER_BUY)],
  },
  [T_SELL]: {
    hash: T_SELL,
    inputs: [entry(20_100_000_000n, 199_016_857n, AFTER_BUY, { tx_hash: T_BUY, output_index: 0 })],
    outputs: [entry(20_000_713_846n, 200_016_857n, AFTER_SELL)],
  },
  [T_ROYALTY]: {
    hash: T_ROYALTY,
    inputs: [entry(20_000_713_846n, 200_016_857n, AFTER_SELL, { tx_hash: T_SELL, output_index: 0 })],
    outputs: [entry(19_999_713_846n, 200_016_857n, AFTER_ROYALTY)],
  },
  [T_COLLECT]: {
    hash: T_COLLECT,
    inputs: [entry(19_999_713_846n, 200_016_857n, AFTER_ROYALTY, { tx_hash: T_ROYALTY, output_index: 0 })],
    outputs: [entry(19_999_613_846n, 200_015_857n, AFTER_COLLECT)],
  },
};

/** The events a real walk produces, newest first, from the same fixtures. */
function historyOf(hashes: string[], reachedGenesis: boolean): VenuePoolHistory {
  const events = hashes.map((hash) => {
    const event = venuePoolEventFrom({ tx: TXS[hash] as HistoryTx, factoryPolicyId: FACTORY });
    if (!event) throw new Error(`${hash} produced no event`);
    return event;
  });
  return reachedGenesis ? { events, reachedGenesis } : { events, reachedGenesis, stoppedBy: 'maxEvents' };
}

const WHOLE_LIFE = [T_COLLECT, T_ROYALTY, T_SELL, T_BUY, T_OPEN];

describe('reconciling what is owed against what was earned', () => {
  const nowUtxo = pool(
    { treasury_x: 0n, treasury_y: 0n, royalty_x: 0n, royalty_y: 10_000n },
    {
      txHash: T_COLLECT,
      assets: { lovelace: 19_999_613_846n, [TOKEN]: 200_015_857n, [LQ]: MAX_LQ - ISSUED, [POOL_NFT]: 1n },
    },
  );

  it('accounts for every counter movement, both directions', () => {
    const r = venueReconcileFees({ pool: nowUtxo, history: historyOf(WHOLE_LIFE, true) });
    expect(r.earned).toEqual({ treasuryX: 100_000n, treasuryY: 1_000n, royaltyX: 1_000_000n, royaltyY: 10_000n });
    expect(r.withdrawn).toEqual({ treasuryX: 100_000n, treasuryY: 1_000n, royaltyX: 1_000_000n, royaltyY: 0n });
  });

  it('leaves nothing unexplained over a complete history of a pool that opened empty', () => {
    const r = venueReconcileFees({ pool: nowUtxo, history: historyOf(WHOLE_LIFE, true) });
    expect(r.complete).toBe(true);
    expect(venueAccruedIsZero(r.unexplained)).toBe(true);
    expect(r.mismatch).toBeUndefined();
  });

  it('shows a pool that opened already owing somebody money', () => {
    // The one thing this check exists for, and it has no other signal: the
    // counters are what a withdrawal pays out, so an opening balance is a
    // claim on the pool's reserves that no trade ever funded.
    const opened = poolDatum({ treasury_x: 5_000n });
    const tx: HistoryTx = { hash: T_OPEN, inputs: [], outputs: [entry(20_000_000_000n, 200_000_000n, opened)] };
    const event = venuePoolEventFrom({ tx, factoryPolicyId: FACTORY });
    if (!event) throw new Error('no event');
    const r = venueReconcileFees({
      pool: pool({ treasury_x: 5_000n }, { txHash: T_OPEN }),
      history: { events: [event], reachedGenesis: true },
    });
    expect(r.complete).toBe(true);
    expect(r.unexplained.treasuryX).toBe(5_000n);
  });

  it('reports a partial history as partial rather than as a discrepancy', () => {
    // Exactly the same arithmetic as the previous case produces exactly the
    // same non-zero figure, and it means something else entirely. `complete`
    // is the only thing that separates them.
    const r = venueReconcileFees({ pool: nowUtxo, history: historyOf([T_COLLECT, T_ROYALTY], false) });
    expect(r.complete).toBe(false);
    expect(venueAccruedIsZero(r.unexplained)).toBe(false);
    expect(r.unexplained.royaltyY).toBe(10_000n);
  });

  it('refuses to reconcile a history walked for another pool', () => {
    const other = pool({}, { txHash: T_COLLECT, datum: poolDatum({ pool_nft: { policy: FACTORY, name: '99' } }) });
    const r = venueReconcileFees({ pool: other, history: historyOf(WHOLE_LIFE, true) });
    expect(r.mismatch).toContain('Nothing below');
  });

  it('says so when the history is of an earlier moment than the pool given', () => {
    const r = venueReconcileFees({ pool: nowUtxo, history: historyOf([T_ROYALTY, T_SELL], false) });
    expect(r.mismatch).toContain('earlier moment');
  });
});

describe('reading a collection back off the chain', () => {
  it('reports what left the pool, as an amount collected', () => {
    const collected = venueCollectionFrom({ tx: TXS[T_COLLECT] as HistoryTx, factoryPolicyId: FACTORY });
    expect(collected?.poolNft).toBe(POOL_NFT);
    expect(collected?.collected).toEqual({
      treasuryX: 100_000n,
      treasuryY: 1_000n,
      royaltyX: 0n,
      royaltyY: 0n,
    });
  });

  it('reads the creator’s claim the same way, since both move the same counters', () => {
    const collected = venueCollectionFrom({ tx: TXS[T_ROYALTY] as HistoryTx, factoryPolicyId: FACTORY });
    expect(collected?.collected.royaltyX).toBe(1_000_000n);
    expect(collected?.collected.treasuryX).toBe(0n);
  });

  it('is nothing for a transaction that was not a collection', () => {
    expect(venueCollectionFrom({ tx: TXS[T_BUY] as HistoryTx, factoryPolicyId: FACTORY })).toBeNull();
    expect(venueCollectionFrom({ tx: TXS[T_OPEN] as HistoryTx, factoryPolicyId: FACTORY })).toBeNull();
  });
});
