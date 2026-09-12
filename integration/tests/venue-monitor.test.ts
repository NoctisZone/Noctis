// venue-monitor.test.ts — does it stay quiet through a quiet market, and shout
// through a broken one?
//
// Those are the two failure modes, and they are opposites. A monitor that pages
// on anything but `failed` pages through every idle hour until the operator
// mutes it; a monitor that watches fills alone is silent through an outage,
// because a venue with nothing fillable and a venue that cannot fill both
// produce zero fills.
//
// So the two load-bearing tests here are the NEGATIVE ones: a round that is
// entirely `unfillable` must produce no alert at all, and a long fill drought
// must produce none either. Both pass trivially if the rules are right and fail
// loudly the moment somebody "improves" the monitor by alerting on quiet.

import { describe, expect, it } from 'vitest';
import type { VenueBatcherRound, VenueFillOutcome } from '../venue-batcher.js';
import { VenueMonitor, venuePagingAlerts } from '../venue-monitor.js';
import type { VenueSwapConfigData, VenueSwapOrderUtxo } from '../venue-swap.js';

const FACTORY = 'fa'.repeat(28);
const LAUNCH = '0102030405060708091011121314151617181920212223242526272829303132'.slice(0, 62);
const TOKEN_POLICY = 'bb'.repeat(28);

function swapDatum(poolName = `10${LAUNCH}`): VenueSwapConfigData {
  return {
    pool_nft: { policy: FACTORY, name: poolName },
    input: { policy: '', name: '' },
    output: { policy: TOKEN_POLICY, name: '746f6b656e' },
    tradable_input: 100_000_000n,
    base_price: { num: 1n, denom: 100n },
    min_marginal_output: 1n,
    ex_fee: 1_500_000n,
    reward_pkh: 'aa'.repeat(28),
    stake_pkh: null,
    permitted_executors: [],
  };
}

function order(id: string, poolName?: string): VenueSwapOrderUtxo {
  return {
    txHash: id.padEnd(64, '0'),
    outputIndex: 0,
    address: 'addr_test1wtest',
    assets: { lovelace: 101_500_000n },
    datum: swapDatum(poolName),
  };
}

function round(outcomes: VenueFillOutcome[], skipped: VenueBatcherRound['skipped'] = []): VenueBatcherRound {
  return {
    outcomes,
    skipped,
    filled: outcomes.filter((o) => o.status === 'filled').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
  };
}

const filled = (id: string, poolName?: string): VenueFillOutcome => ({
  status: 'filled',
  order: order(id, poolName),
  txHash: `${id}tx`.padEnd(64, '0'),
  traded: 100_000_000n,
  exFeeTaken: 1_400_000n,
  networkFee: 400_000n,
});

const unfillable = (id: string, poolName?: string): VenueFillOutcome => ({
  status: 'unfillable',
  order: order(id, poolName),
  reason: 'the price floor is above what the pool can realise',
});

const declined = (id: string, poolName?: string): VenueFillOutcome => ({
  status: 'declined',
  order: order(id, poolName),
  reason: 'this order names other permitted executors',
});

const failed = (id: string, poolName?: string): VenueFillOutcome => ({
  status: 'failed',
  order: order(id, poolName),
  reason: 'the submitted transaction was rejected',
});

describe('a quiet market', () => {
  it('says nothing at all when every order is simply resting', () => {
    const monitor = new VenueMonitor();
    const alerts = monitor.observeRound(round([unfillable('a'), unfillable('b'), unfillable('c')]), 1_000);
    expect(alerts).toEqual([]);
  });

  it('says nothing when the batcher declines orders under its own rules', () => {
    const monitor = new VenueMonitor();
    const alerts = monitor.observeRound(round([declined('a'), declined('b')]), 1_000);
    expect(alerts).toEqual([]);
  });

  it('does not page for a long drought of fills, only for a drought of ROUNDS', () => {
    const monitor = new VenueMonitor({ roundStalenessMs: 60_000 });
    // Six hours of rounds, every one of them fill-free and perfectly healthy.
    let now = 0;
    for (let i = 0; i < 720; i += 1) {
      now += 30_000;
      expect(monitor.observeRound(round([unfillable('a')]), now)).toEqual([]);
    }
    expect(monitor.checkLiveness(now)).toEqual([]);
    expect(monitor.snapshot().lastFillAtMs).toBeNull();
    expect(monitor.snapshot().roundsCompleted).toBe(720);
  });
});

describe('a failed fill', () => {
  it('pages, and names every order that failed', () => {
    const monitor = new VenueMonitor();
    const alerts = monitor.observeRound(round([filled('a'), failed('b'), unfillable('c')]), 1_000);
    const paging = venuePagingAlerts(alerts);
    expect(paging).toHaveLength(1);
    expect(paging[0].code).toBe('fill_failed');
    expect(paging[0].detail).toMatch(/rejected/);
  });

  it('counts one alert per round, however many orders failed in it', () => {
    const monitor = new VenueMonitor();
    const alerts = venuePagingAlerts(monitor.observeRound(round([failed('a'), failed('b')]), 1_000));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toMatch(/2 fills/);
  });
});

describe('a round that threw against a round with failures in it', () => {
  it('warns on a single provider error rather than paging', () => {
    const monitor = new VenueMonitor({ providerErrorsBeforePage: 3 });
    const alerts = monitor.observeRoundError(new Error('blockfrost 502'), 1_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('warn');
    expect(alerts[0].code).toBe('provider_error');
  });

  it('pages once enough have happened in a row to mean the batcher is down', () => {
    const monitor = new VenueMonitor({ providerErrorsBeforePage: 3 });
    monitor.observeRoundError(new Error('one'), 1_000);
    monitor.observeRoundError(new Error('two'), 2_000);
    const alerts = venuePagingAlerts(monitor.observeRoundError(new Error('three'), 3_000));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].code).toBe('provider_down');
  });

  it('records WHEN it threw, so a silent stretch can be told apart from a stopped one', () => {
    const monitor = new VenueMonitor({ providerErrorsBeforePage: 5 });
    monitor.observeRound(round([unfillable('a')]), 1_000);
    monitor.observeRoundError(new Error('down'), 9_000);
    const state = monitor.snapshot();
    expect(state.lastRoundAtMs).toBe(1_000);
    expect(state.lastErrorAtMs).toBe(9_000);
  });

  it('says a provider error implies nothing about the venue itself', () => {
    const monitor = new VenueMonitor({ providerErrorsBeforePage: 1 });
    const alerts = monitor.observeRoundError(new Error('timeout'), 1_000);
    expect(alerts[0].detail).toMatch(/nothing is known about the venue itself/);
  });

  it('a completed round clears the run, however that round went', () => {
    const monitor = new VenueMonitor({ providerErrorsBeforePage: 3 });
    monitor.observeRoundError(new Error('one'), 1_000);
    monitor.observeRoundError(new Error('two'), 2_000);
    monitor.observeRound(round([unfillable('a')]), 3_000);
    expect(monitor.snapshot().consecutiveProviderErrors).toBe(0);
    const alerts = monitor.observeRoundError(new Error('three'), 4_000);
    expect(alerts[0].code).toBe('provider_error');
  });
});

describe('liveness', () => {
  it('pages when no ROUND has completed for too long', () => {
    const monitor = new VenueMonitor({ roundStalenessMs: 60_000 });
    monitor.observeRound(round([unfillable('a')]), 1_000);
    expect(monitor.checkLiveness(50_000)).toEqual([]);
    const alerts = monitor.checkLiveness(1_000 + 60_001);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].code).toBe('batcher_stalled');
  });

  it('says nothing before the first round, having nothing to compare against', () => {
    const monitor = new VenueMonitor({ roundStalenessMs: 1 });
    expect(monitor.checkLiveness(10_000_000)).toEqual([]);
  });
});

describe('pools read', () => {
  it('warns when the pools worked fall away from the high-water mark', () => {
    const monitor = new VenueMonitor({ poolsReadDropBeforeWarn: 2 });
    monitor.observeRound(
      round([unfillable('a', `10${LAUNCH}`), unfillable('b', `11${LAUNCH}`), unfillable('c', `12${LAUNCH}`)]),
      1_000,
    );
    const alerts = monitor.observeRound(round([unfillable('d', `10${LAUNCH}`)]), 2_000);
    const warn = alerts.find((a) => a.code === 'pools_read_dropped');
    expect(warn?.severity).toBe('warn');
    expect(warn?.summary).toMatch(/1 pools against a high-water mark of 3/);
  });

  it('does not warn for one pool missing — a UTXO can be mid-spend', () => {
    const monitor = new VenueMonitor({ poolsReadDropBeforeWarn: 2 });
    monitor.observeRound(round([unfillable('a', `10${LAUNCH}`), unfillable('b', `11${LAUNCH}`)]), 1_000);
    const alerts = monitor.observeRound(round([unfillable('c', `10${LAUNCH}`)]), 2_000);
    expect(alerts.find((a) => a.code === 'pools_read_dropped')).toBeUndefined();
  });

  it('never lets a bad read lower the yardstick', () => {
    const monitor = new VenueMonitor({ poolsReadDropBeforeWarn: 2 });
    monitor.observeRound(
      round([unfillable('a', `10${LAUNCH}`), unfillable('b', `11${LAUNCH}`), unfillable('c', `12${LAUNCH}`)]),
      1_000,
    );
    monitor.observeRound(round([]), 2_000);
    expect(monitor.snapshot().poolsReadHighWater).toBe(3);
  });

  it('is a warning and not a page — a market really can go quiet', () => {
    const monitor = new VenueMonitor({ poolsReadDropBeforeWarn: 1 });
    monitor.observeRound(round([unfillable('a', `10${LAUNCH}`), unfillable('b', `11${LAUNCH}`)]), 1_000);
    const alerts = monitor.observeRound(round([]), 2_000);
    expect(venuePagingAlerts(alerts)).toEqual([]);
  });
});

describe('skipped UTXOs', () => {
  it('counts every reason the reader gave, across rounds', () => {
    const monitor = new VenueMonitor();
    monitor.observeRound(
      round(
        [],
        [
          { txHash: 'a'.repeat(64), outputIndex: 0, reason: 'no pool NFT' },
          { txHash: 'b'.repeat(64), outputIndex: 1, reason: 'no pool NFT' },
          { txHash: 'c'.repeat(64), outputIndex: 0, reason: 'datum would not decode' },
        ],
      ),
      1_000,
    );
    expect(monitor.snapshot().skippedByReason).toEqual({
      'no pool NFT': 2,
      'datum would not decode': 1,
    });
  });

  it('reports them as information, never as a page', () => {
    const monitor = new VenueMonitor();
    const alerts = monitor.observeRound(
      round([], [{ txHash: 'a'.repeat(64), outputIndex: 0, reason: 'no pool NFT' }]),
      1_000,
    );
    const info = alerts.find((a) => a.code === 'utxos_skipped');
    expect(info?.severity).toBe('info');
    expect(venuePagingAlerts(alerts)).toEqual([]);
  });
});

describe('the running tally', () => {
  it('keeps the four outcomes apart', () => {
    const monitor = new VenueMonitor();
    monitor.observeRound(round([filled('a'), failed('b'), unfillable('c'), declined('d')]), 1_000);
    const state = monitor.snapshot();
    expect(state).toMatchObject({
      ordersSeen: 4,
      filled: 1,
      failed: 1,
      unfillable: 1,
      declined: 1,
      roundsCompleted: 1,
      lastFillAtMs: 1_000,
    });
  });

  it('hands back a copy, so a caller cannot edit the monitor’s own tally', () => {
    const monitor = new VenueMonitor();
    monitor.observeRound(round([filled('a')]), 1_000);
    const snap = monitor.snapshot();
    snap.filled = 999;
    snap.skippedByReason.invented = 5;
    expect(monitor.snapshot().filled).toBe(1);
    expect(monitor.snapshot().skippedByReason.invented).toBeUndefined();
  });
});
