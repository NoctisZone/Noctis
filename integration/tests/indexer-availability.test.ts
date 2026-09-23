import { describe, expect, it, vi } from 'vitest';
import { assertIndexerReachable, indexerUsable, probeIndexer, waitForIndexer } from '../indexer-availability.js';
import { indexerOutageIn } from '../submission-outcome.js';

const URL = 'https://indexer.example/api/v3/graphql';
// The clock the tests run against, and the block time a healthy indexer
// answered with when this was measured: about twenty seconds behind it.
const NOW_MS = 1_790_149_699_000;
const FRESH_BLOCK_MS = NOW_MS - 19_000;

/** A fetch that answers the block query the way the real indexer did. */
function healthy(timestamp: number = FRESH_BLOCK_MS): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { block: { height: 2_672_001, hash: '60978c53', timestamp } } }),
  })) as never;
}

/** What the load balancer sends during an outage: a 503 on every path. */
function outage(): typeof fetch {
  return vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as never;
}

const noSleep = async () => {};
const clock = () => NOW_MS;

describe('one probe', () => {
  it('reads the latest block and how old it is', async () => {
    const probe = await probeIndexer(URL, { fetchImpl: healthy(), now: clock });
    expect(probe).toEqual({ ok: true, height: 2_672_001, blockAgeSeconds: 19 });
    expect(indexerUsable(probe)).toBe(true);
  });

  it('asks over POST with the one query, because GET is refused (405) by the real endpoint', async () => {
    const fetchImpl = healthy();
    await probeIndexer(URL, { fetchImpl, now: clock });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).query).toMatch(/block\s*{\s*height/);
  });

  it('reports a 503 as down, with the status, and never throws', async () => {
    const probe = await probeIndexer(URL, { fetchImpl: outage(), now: clock });
    expect(probe).toMatchObject({ ok: false, status: 503 });
  });

  it('reports a transport failure as down, with the reason', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as never;
    const probe = await probeIndexer(URL, { fetchImpl, now: clock });
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.why).toMatch(/fetch failed/);
  });

  it('counts an indexer that is back but far behind as not usable', async () => {
    // An indexer hours behind the node would have every wallet build against
    // a state the chain has left. Being up is not the whole question.
    const probe = await probeIndexer(URL, { fetchImpl: healthy(NOW_MS - 3_600_000), now: clock });
    expect(probe.ok).toBe(true);
    expect(indexerUsable(probe)).toBe(false);
  });

  it('reads a timestamp in seconds as seconds, not as 1970', async () => {
    const probe = await probeIndexer(URL, { fetchImpl: healthy(Math.floor(FRESH_BLOCK_MS / 1000)), now: clock });
    expect(probe).toMatchObject({ ok: true, blockAgeSeconds: 19 });
  });
});

describe('waiting for it', () => {
  it('returns at once when the first probe is fine', async () => {
    const wait = await waitForIndexer(URL, { fetchImpl: healthy(), now: clock, sleep: noSleep });
    expect(wait).toEqual({ waitedMs: 0, height: 2_672_001, blockAgeSeconds: 19 });
  });

  it('keeps probing through an outage and resolves when the indexer is back', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 4
        ? { ok: false, status: 503, json: async () => ({}) }
        : {
            ok: true,
            status: 200,
            json: async () => ({ data: { block: { height: 7, hash: 'ab', timestamp: FRESH_BLOCK_MS } } }),
          };
    }) as never;
    const log: string[] = [];
    const wait = await waitForIndexer(URL, {
      fetchImpl,
      now: clock,
      sleep: noSleep,
      pollMs: 1,
      log: (m) => log.push(m),
    });
    expect(wait.height).toBe(7);
    expect(calls).toBe(4);
    // One line at the start of the outage, one when it ends: readable at 3am.
    expect(log[0]).toMatch(/answered 503; waiting/);
    expect(log.at(-1)).toMatch(/indexer back/);
  });

  it('gives up after the longest wait a caller allows, without having submitted anything', async () => {
    let t = NOW_MS;
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    await expect(
      waitForIndexer(URL, { fetchImpl: outage(), now, sleep, pollMs: 1_000, maxWaitMs: 5_000 }),
    ).rejects.toThrow(/did not become usable within 5s/);
  });

  it('waits for an indexer that is up but behind, rather than calling it ready', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      const timestamp = calls < 3 ? NOW_MS - 3_600_000 : FRESH_BLOCK_MS;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { block: { height: calls, hash: 'ab', timestamp } } }),
      };
    }) as never;
    const log: string[] = [];
    await waitForIndexer(URL, { fetchImpl, now: clock, sleep: noSleep, pollMs: 1, log: (m) => log.push(m) });
    expect(calls).toBe(3);
    expect(log[0]).toMatch(/is not caught up/);
  });
});

describe('refusing to start against a dead indexer', () => {
  it('passes quietly when the indexer is up and recent', async () => {
    await expect(assertIndexerReachable(URL, { fetchImpl: healthy(), now: clock })).resolves.toBeUndefined();
  });

  it('throws a message the failure classifier reads as an outage', async () => {
    // The CLI that refuses to start reports this to its caller, and the
    // caller decides what to do from the text. If the text did not classify
    // as an outage, a driver would stop for an operator instead of waiting.
    let message = '';
    await assertIndexerReachable(URL, { fetchImpl: outage(), now: clock }).catch((err: Error) => {
      message = err.message;
    });
    expect(message).toMatch(/answered 503/);
    expect(indexerOutageIn(message)).toBe(true);

    let behind = '';
    await assertIndexerReachable(URL, { fetchImpl: healthy(NOW_MS - 3_600_000), now: clock }).catch((err: Error) => {
      behind = err.message;
    });
    expect(behind).toMatch(/is not caught up/);
    expect(indexerOutageIn(behind)).toBe(true);
  });
});
