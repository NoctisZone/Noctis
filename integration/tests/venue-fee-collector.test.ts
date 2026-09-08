// venue-fee-collector.test.ts — which pools, when, and paid for out of what?
//
// Three things carry this file.
//
//   THE TWO MODES WEIGH THE TOKEN SIDE DIFFERENTLY, ON PURPOSE. The same pool
//   — a thin ADA counter beside a token counter worth many times the fee — is
//   left alone by `threshold` and collected by `sweep`, and both are right.
//   Threshold asks "is this worth going to today?", where the alternative is
//   waiting and waiting is free. Sweep asks "we are going anyway, is this
//   worth including?", where the alternative is leaving the money behind. One
//   fixture, opposite answers, is the clearest way to hold that.
//
//   EACH COLLECTION NEEDS ITS OWN FUNDING UTXO. Two collections built against
//   one wallet snapshot name the same UTXO, and the second is a double-spend
//   refused at the node for a reason naming neither pool. The round partitions
//   the wallet instead, so the test asserts the funding sets are DISJOINT and
//   that none of them is the collateral.
//
//   A ROUND REPORTS WHAT IT SUBMITTED; DISCLOSURE READS THE CHAIN. A submitted
//   transaction is not a confirmed one, and a royalty claim moves the same
//   pool the same way. Both would inflate a published figure taken from the
//   job's own record, so the disclosure path derives its total from the
//   transactions themselves and says what it could not account for.

import { Data } from '@lucid-evolution/lucid';
import type { UTxO as MeshUTxO } from '@meshsdk/core';
import { describe, expect, it, vi } from 'vitest';
import type { CurveSpendWallet } from '../mesh-curve-spend.js';
import type { ProviderUtxo } from '../venue-chain-reader.js';
import {
  VENUE_COLLECTION_THRESHOLD_LOVELACE,
  VenueFeeCollector,
  venueCollectionSchedule,
  venueDisclosureFrom,
} from '../venue-fee-collector.js';
import { VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE } from '../venue-fee-ledger.js';
import { type VenuePoolConfigData, VenuePoolConfigSchema } from '../venue-pool.js';
import type { HistoryTx, HistoryTxUtxo } from '../venue-pool-history.js';
import type { VenuePoolUtxo } from '../venue-swap.js';
import type { VenueTreasuryWithdrawer } from '../venue-treasury-withdrawal.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '01020304050607080910111213141516171819202122232425262728293031'.slice(0, 62);
const LQ = `${FACTORY}11${LAUNCH}`;
const TOKEN_POLICY = 'bb'.repeat(28);
const TOKEN = `${TOKEN_POLICY}746f6b656e`;
const POOL_ADDRESS = 'addr_test1wq00000000000000000000000000000000000000000000000000ge5wj4';
const OPS_ADDRESS = 'addr_test1vz00000000000000000000000000000000000000000000000000gpmhcx';
const MAX_LQ = 0x7fffffffffffffffn;
const ISSUED = 1_000_000_000n;
const PLATFORM = 'ee'.repeat(28);

/** Each pool gets its own NFT name so a round can tell them apart. */
function nftName(tag: string) {
  return `10${tag}${LAUNCH.slice(2)}`;
}

function poolDatum(tag: string, over: Partial<VenuePoolConfigData> = {}): VenuePoolConfigData {
  return {
    pool_nft: { policy: FACTORY, name: nftName(tag) },
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

function pool(tag: string, over: Partial<VenuePoolConfigData> = {}): VenuePoolUtxo {
  const datum = poolDatum(tag, over);
  return {
    txHash: tag.repeat(32),
    outputIndex: 0,
    address: POOL_ADDRESS,
    assets: {
      lovelace: 20_000_000_000n,
      [TOKEN]: 200_000_000n,
      [LQ]: MAX_LQ - ISSUED,
      [`${FACTORY}${nftName(tag)}`]: 1n,
    },
    datum,
  };
}

/** Well over the threshold: 80 ADA accrued. */
const RICH = pool('0a', { treasury_x: 80_000_000n, treasury_y: 100_000n });
/** Under it: 5 ADA, but a token side worth roughly 100 ADA. */
const TOKEN_HEAVY = pool('0b', { treasury_x: 5_000_000n, treasury_y: 1_000_000n });
/** Dust: a hundred lovelace and ten tokens, worth far less than one fee. */
const DUST = pool('0c', { treasury_x: 100n, treasury_y: 10n });
/** Nothing at all. */
const EMPTY = pool('0d');

function nftOf(p: VenuePoolUtxo) {
  return `${FACTORY}${p.datum.pool_nft.name}`;
}

describe('which pools a round decides on', () => {
  it('collects a pool whose ada counter has reached the threshold', () => {
    const s = venueCollectionSchedule({ pools: [RICH] });
    expect(s.collect.map((d) => d.poolNft)).toEqual([nftOf(RICH)]);
    expect(s.decisions[0]?.reason).toContain('reached the');
  });

  it('leaves a pool under the threshold alone, and says waiting costs nothing', () => {
    const s = venueCollectionSchedule({ pools: [TOKEN_HEAVY] });
    expect(s.collect).toHaveLength(0);
    expect(s.decisions[0]?.reason).toContain('Waiting costs nothing');
  });

  it('does not let a large token side pull a thin pool over the threshold', () => {
    // The deliberate asymmetry. Its tokens are worth roughly 100 ADA — far
    // more than the 50 ADA threshold and 200-odd times the fee — and it is
    // still left alone, because the alternative is waiting and the tokens do
    // not decay.
    const s = venueCollectionSchedule({ pools: [TOKEN_HEAVY] });
    expect(s.decisions[0]?.valueLovelace).toBeGreaterThan(VENUE_COLLECTION_THRESHOLD_LOVELACE);
    expect(s.decisions[0]?.collect).toBe(false);
  });

  it('collects that same pool in a sweep, where the alternative is leaving it behind', () => {
    const s = venueCollectionSchedule({ pools: [TOKEN_HEAVY], policy: { mode: 'sweep' } });
    expect(s.collect.map((d) => d.poolNft)).toEqual([nftOf(TOKEN_HEAVY)]);
    expect(s.decisions[0]?.reason).toContain('swept');
  });

  it('still leaves dust out of a sweep, because collecting it makes the record worse', () => {
    const s = venueCollectionSchedule({ pools: [DUST], policy: { mode: 'sweep' } });
    expect(s.collect).toHaveLength(0);
    expect(s.decisions[0]?.valueLovelace).toBeLessThan(VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE);
    expect(s.decisions[0]?.reason).toContain('worse, not tidier');
  });

  it('never proposes a pool with nothing accrued, in either mode', () => {
    for (const mode of ['threshold', 'sweep'] as const) {
      const s = venueCollectionSchedule({ pools: [EMPTY], policy: { mode } });
      expect(s.collect).toHaveLength(0);
      // Distinct from "not worth it": the validator refuses a withdrawal that
      // moves nothing, so this one could not be built at any threshold.
      expect(s.decisions[0]?.reason).toContain('moves nothing is refused');
    }
  });

  it('orders by what is at stake, and caps the round when asked', () => {
    const s = venueCollectionSchedule({
      pools: [TOKEN_HEAVY, RICH, DUST, EMPTY],
      policy: { mode: 'sweep', maxPerRound: 1 },
    });
    // TOKEN_HEAVY is worth about 105 ADA all in; RICH about 90.
    expect(s.collect.map((d) => d.poolNft)).toEqual([nftOf(TOKEN_HEAVY)]);
  });

  it('takes the operator’s own threshold', () => {
    const s = venueCollectionSchedule({ pools: [TOKEN_HEAVY], policy: { thresholdLovelace: 1_000_000n } });
    expect(s.collect).toHaveLength(1);
  });
});

// --- the round --------------------------------------------------------------

function providerUtxo(p: VenuePoolUtxo): ProviderUtxo {
  return {
    tx_hash: p.txHash,
    output_index: p.outputIndex,
    address: p.address,
    amount: Object.entries(p.assets).map(([unit, quantity]) => ({ unit, quantity: String(quantity) })),
    inline_datum: Data.to(p.datum, VenuePoolConfigSchema),
  };
}

function chainProvider(pools: VenuePoolUtxo[]) {
  return {
    getAddressUtxosAll: vi.fn(async () => pools.map(providerUtxo)),
    getTxPosition: vi.fn(async () => ({ block_height: 1, index: 0 })),
  };
}

function walletUtxo(txHash: string, lovelace: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: { address: OPS_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
  };
}

const COLLATERAL = walletUtxo('cc'.repeat(32), '5000000');

function fakeWallet(utxos: MeshUTxO[]): CurveSpendWallet {
  return {
    getChangeAddress: vi.fn().mockResolvedValue(OPS_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue(utxos),
    getCollateral: vi.fn().mockResolvedValue([COLLATERAL]),
    signTx: vi.fn().mockResolvedValue('signed'),
    submitTx: vi.fn().mockResolvedValue('hash'),
  };
}

/** Records what funding each collection was handed. */
function recordingWithdrawer(failOn: string[] = []) {
  const calls: Array<{ poolTxHash: string; funding: string[] }> = [];
  const withdrawer = {
    submit: vi.fn(async (plan, _wallet, opts) => {
      const funding = (opts?.fundingUtxos ?? []).map((u: MeshUTxO) => `${u.input.txHash}#${u.input.outputIndex}`);
      calls.push({ poolTxHash: plan.pool.txHash, funding });
      if (failOn.includes(plan.pool.txHash)) throw new Error('the node refused it');
      return `tx-${plan.pool.txHash.slice(0, 4)}`;
    }),
  } as unknown as Pick<VenueTreasuryWithdrawer, 'submit'>;
  return { withdrawer, calls };
}

function collector(
  pools: VenuePoolUtxo[],
  wallet: CurveSpendWallet,
  withdrawer: Pick<VenueTreasuryWithdrawer, 'submit'>,
  policy = {},
) {
  return new VenueFeeCollector({
    provider: chainProvider(pools),
    withdrawer,
    wallet,
    poolAddress: POOL_ADDRESS,
    factoryPolicyId: FACTORY,
    network: 'preprod',
    policy,
  });
}

describe('running a round', () => {
  it('submits one transaction per pool it decided on, and skips the rest by name', async () => {
    const { withdrawer } = recordingWithdrawer();
    const wallet = fakeWallet([walletUtxo('11'.repeat(32), '20000000')]);
    const round = await collector([RICH, TOKEN_HEAVY, EMPTY], wallet, withdrawer).runRound();
    expect(round.submitted).toBe(1);
    expect(round.outcomes.filter((o) => o.kind === 'skipped')).toHaveLength(2);
    expect(round.outcomes.find((o) => o.kind === 'submitted')?.poolNft).toBe(nftOf(RICH));
  });

  it('gives every collection its own funding utxo, and never the collateral', async () => {
    const { withdrawer, calls } = recordingWithdrawer();
    const wallet = fakeWallet([
      walletUtxo('11'.repeat(32), '20000000'),
      walletUtxo('22'.repeat(32), '20000000'),
      COLLATERAL,
    ]);
    const round = await collector([RICH, TOKEN_HEAVY], wallet, withdrawer, { mode: 'sweep' }).runRound();
    expect(round.submitted).toBe(2);
    const used = calls.flatMap((c) => c.funding);
    expect(used).toHaveLength(2);
    expect(new Set(used).size).toBe(2);
    expect(used).not.toContain(`${COLLATERAL.input.txHash}#0`);
  });

  it('holds the collateral out even when it is the largest thing the wallet has', async () => {
    // The selection takes the largest first, so a collateral UTXO that is
    // merely small is held out by accident rather than on purpose. Here it is
    // the biggest, so only the exclusion itself can keep it out — and using it
    // would put the same UTXO in two places in one transaction.
    const fat = walletUtxo(COLLATERAL.input.txHash, '900000000');
    const { withdrawer, calls } = recordingWithdrawer();
    const wallet = {
      ...fakeWallet([fat, walletUtxo('11'.repeat(32), '20000000')]),
      getCollateral: vi.fn().mockResolvedValue([fat]),
    };
    const round = await collector([RICH], wallet, withdrawer).runRound();
    expect(round.submitted).toBe(1);
    expect(calls[0]?.funding).toEqual([`${'11'.repeat(32)}#0`]);
  });

  it('defers pools past the wallet’s spare utxo count rather than building them', async () => {
    const { withdrawer } = recordingWithdrawer();
    const wallet = fakeWallet([walletUtxo('11'.repeat(32), '20000000'), COLLATERAL]);
    const round = await collector([RICH, TOKEN_HEAVY], wallet, withdrawer, { mode: 'sweep' }).runRound();
    expect(round.submitted).toBe(1);
    expect(round.deferred).toBe(1);
    const deferred = round.outcomes.find((o) => o.kind === 'deferred');
    expect(deferred?.reason).toContain('the count does not fall');
  });

  it('lets a failure end only itself, because nothing carries between pools', async () => {
    // The opposite of a round of fills, where one failure ends that pool's
    // whole chain. Different pools share no state, so the next is unaffected.
    const { withdrawer, calls } = recordingWithdrawer([TOKEN_HEAVY.txHash]);
    const wallet = fakeWallet([walletUtxo('11'.repeat(32), '20000000'), walletUtxo('22'.repeat(32), '20000000')]);
    const round = await collector([RICH, TOKEN_HEAVY], wallet, withdrawer, { mode: 'sweep' }).runRound();
    expect(round.failed).toBe(1);
    expect(round.submitted).toBe(1);
    expect(calls).toHaveLength(2);
    expect(round.outcomes.find((o) => o.kind === 'failed')?.reason).toContain('the node refused it');
  });

  it('nets what the submitted collections should return, and nothing for the failed one', async () => {
    const { withdrawer } = recordingWithdrawer([TOKEN_HEAVY.txHash]);
    const wallet = fakeWallet([walletUtxo('11'.repeat(32), '20000000'), walletUtxo('22'.repeat(32), '20000000')]);
    const round = await collector([RICH, TOKEN_HEAVY], wallet, withdrawer, { mode: 'sweep' }).runRound();
    expect(round.expectedNetLovelace).toBe(80_000_000n - VENUE_TREASURY_WITHDRAWAL_COST_LOVELACE);
  });

  it('reports what it submitted rather than what confirmed', async () => {
    const { withdrawer } = recordingWithdrawer();
    const wallet = fakeWallet([walletUtxo('11'.repeat(32), '20000000')]);
    const round = await collector([RICH], wallet, withdrawer).runRound();
    const submitted = round.outcomes.find((o) => o.kind === 'submitted');
    expect(submitted?.txHash).toBe('tx-0a0a');
    expect(submitted?.expected).toEqual({ lovelace: 80_000_000n, tokens: [{ unit: TOKEN, amount: 100_000n }] });
  });
});

// --- disclosure -------------------------------------------------------------

function entry(lovelace: bigint, tokens: bigint, datum: VenuePoolConfigData, over: Partial<HistoryTxUtxo> = {}) {
  return {
    address: POOL_ADDRESS,
    amount: [
      { unit: 'lovelace', quantity: String(lovelace) },
      { unit: TOKEN, quantity: String(tokens) },
      { unit: LQ, quantity: String(MAX_LQ - ISSUED) },
      { unit: `${FACTORY}${datum.pool_nft.name}`, quantity: '1' },
    ],
    inline_datum: Data.to(datum, VenuePoolConfigSchema),
    ...over,
  };
}

const BEFORE = poolDatum('0a', { treasury_x: 80_000_000n, treasury_y: 100_000n, royalty_x: 9_000_000n });
const AFTER_PLATFORM = poolDatum('0a', { treasury_x: 0n, treasury_y: 0n, royalty_x: 9_000_000n });
const AFTER_CREATOR = poolDatum('0a', { treasury_x: 80_000_000n, treasury_y: 100_000n, royalty_x: 0n });

const T_PLATFORM = 'a1'.repeat(32);
const T_CREATOR = 'a2'.repeat(32);
const T_SWAP = 'a3'.repeat(32);
const T_MISSING = 'a4'.repeat(32);

const DISCLOSURE_TXS: Record<string, HistoryTx> = {
  [T_PLATFORM]: {
    hash: T_PLATFORM,
    inputs: [entry(20_000_000_000n, 200_000_000n, BEFORE, { tx_hash: '0a'.repeat(32), output_index: 0 })],
    outputs: [entry(19_920_000_000n, 199_900_000n, AFTER_PLATFORM)],
  },
  [T_CREATOR]: {
    hash: T_CREATOR,
    inputs: [entry(20_000_000_000n, 200_000_000n, BEFORE, { tx_hash: '0a'.repeat(32), output_index: 0 })],
    outputs: [entry(19_991_000_000n, 200_000_000n, AFTER_CREATOR)],
  },
  [T_SWAP]: {
    hash: T_SWAP,
    inputs: [entry(20_000_000_000n, 200_000_000n, BEFORE, { tx_hash: '0a'.repeat(32), output_index: 0 })],
    outputs: [
      entry(
        20_100_000_000n,
        199_016_857n,
        poolDatum('0a', { treasury_x: 80_100_000n, treasury_y: 100_000n, royalty_x: 10_000_000n }),
      ),
    ],
  },
};

const historyProvider = {
  getTxUtxos: vi.fn(async (hash: string) => {
    const tx = DISCLOSURE_TXS[hash];
    if (!tx) throw new Error(`no such transaction ${hash}`);
    return tx;
  }),
};

describe('what the platform discloses', () => {
  it('totals what actually left the pools, by unit', async () => {
    const d = await venueDisclosureFrom(historyProvider, { txHashes: [T_PLATFORM], factoryPolicyId: FACTORY });
    expect(d.totalByUnit).toEqual([
      { unit: 'lovelace', amount: 80_000_000n },
      { unit: TOKEN, amount: 100_000n },
    ]);
    expect(d.collections[0]?.poolNft).toBe(`${FACTORY}${nftName('0a')}`);
  });

  it('excludes the creator’s claim, which moves the same pool the same way', async () => {
    const d = await venueDisclosureFrom(historyProvider, { txHashes: [T_CREATOR], factoryPolicyId: FACTORY });
    expect(d.collections).toHaveLength(0);
    expect(d.totalByUnit).toEqual([]);
    expect(d.unaccounted[0]?.reason).toContain("creator's royalty counters");
  });

  it('says what it could not account for rather than dropping it', async () => {
    const d = await venueDisclosureFrom(historyProvider, {
      txHashes: [T_PLATFORM, T_SWAP, T_MISSING],
      factoryPolicyId: FACTORY,
    });
    expect(d.collections).toHaveLength(1);
    expect(d.unaccounted.map((u) => u.txHash)).toEqual([T_SWAP, T_MISSING]);
    // A hash the job recorded but the chain does not have is the one that
    // would otherwise inflate a published figure.
    expect(d.unaccounted[1]?.reason).toContain('no such transaction');
  });

  it('adds up across several collections', async () => {
    const d = await venueDisclosureFrom(historyProvider, {
      txHashes: [T_PLATFORM, T_PLATFORM],
      factoryPolicyId: FACTORY,
    });
    expect(d.totalByUnit[0]).toEqual({ unit: 'lovelace', amount: 160_000_000n });
  });
});
