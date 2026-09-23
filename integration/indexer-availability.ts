// ============================================================================
// Noctis Zone — is the indexer there, and is it caught up
// ============================================================================
// Every Midnight-side step this platform takes goes through the public
// indexer: the wallet syncs over its websocket, every read of a contract goes
// to its HTTP endpoint, and a submission is only known to have landed once the
// indexer shows the block. The node can be perfectly healthy while the indexer
// answers 503 from its load balancer on every path — measured three times in
// one night on Preprod, for 44, 21 and 18 minutes — and during that time a
// driver that simply tries its next step dies, sometimes after the node has
// already accepted the transaction it was sending.
//
// So the indexer is probed as its own thing, before anything is built against
// it and again after anything fails. The probe asks for the latest block over
// the same HTTP endpoint the reads use, and "up" means two things: it answered,
// and the block it answered with is recent. An indexer that is back but hours
// behind the node would have every wallet sync against a state the chain has
// left, which the node refuses one transaction at a time with a code that
// names the proof rather than the staleness.
//
// Nothing here retries a transaction. Waiting is for the caller's READ — the
// step that died may well have landed, and only the chain can say.
// ============================================================================

import { describeError } from './error-detail.js';

/** The one query the probe makes. `timestamp` is milliseconds since the epoch, measured. */
export const INDEXER_HEAD_QUERY = '{ block { height hash timestamp } }';

/**
 * The instant at which an epoch value stops being ambiguous between seconds
 * and milliseconds; the same crossing guarded everywhere else in this
 * codebase. The indexer answered in milliseconds when measured, but a value
 * below the line is read as seconds rather than as the year 1970.
 */
const MS_UNIT_FLOOR = 1_000_000_000_000;

export type IndexerProbe =
  | {
      ok: true;
      /** Height of the latest block the indexer holds. */
      height: number;
      /** How old that block is, against this machine's clock. */
      blockAgeSeconds: number;
    }
  | {
      ok: false;
      /** The HTTP status, when there was one. A 503 from the load balancer is the shape of an outage. */
      status?: number;
      /** What went wrong, in a line. */
      why: string;
    };

export interface ProbeOptions {
  /** Replaces global fetch, for tests. */
  fetchImpl?: typeof fetch;
  /** How long one probe may take. An indexer that is up answers in about a second. */
  timeoutMs?: number;
  /** Milliseconds since the epoch; replaceable so a test can pin the clock. */
  now?: () => number;
}

/**
 * One request for the latest block.
 *
 * Never throws: a probe that threw would have to be caught by every caller,
 * and the whole point of it is to be asked in a loop until the answer is yes.
 */
export async function probeIndexer(indexerHttpUrl: string, options: ProbeOptions = {}): Promise<IndexerProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: INDEXER_HEAD_QUERY }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, why: `answered ${response.status}` };
    }
    const body = (await response.json()) as {
      data?: { block?: { height?: unknown; timestamp?: unknown } | null };
      errors?: Array<{ message?: string }>;
    };
    const block = body.data?.block;
    if (!block || typeof block.height !== 'number') {
      const detail = body.errors?.map((e) => e.message).join('; ') || 'no block in the reply';
      return { ok: false, status: response.status, why: `answered without a latest block (${detail})` };
    }
    const stamp = Number(block.timestamp);
    if (!Number.isFinite(stamp) || stamp <= 0) {
      return {
        ok: false,
        status: response.status,
        why: `answered a block with no usable timestamp (${String(block.timestamp)})`,
      };
    }
    const stampMs = stamp >= MS_UNIT_FLOOR ? stamp : stamp * 1000;
    return { ok: true, height: block.height, blockAgeSeconds: Math.max(0, Math.round((now() - stampMs) / 1000)) };
  } catch (err) {
    return { ok: false, why: controller.signal.aborted ? 'did not answer in time' : describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitForIndexerOptions extends ProbeOptions {
  /**
   * Longest to wait before giving up. Long by default: the outages measured
   * were under an hour each, and a driver that gives up early hands the wait
   * back to a human, which is the exact cost this exists to remove.
   */
  maxWaitMs?: number;
  /** How long between probes while the indexer is down. */
  pollMs?: number;
  /**
   * How far behind the clock the latest block may be before the indexer is
   * counted as "not caught up". Preprod's latest block was measured about
   * twenty seconds old on a healthy indexer.
   */
  maxBlockAgeSeconds?: number;
  /** Where to say what is being waited on. Silent by default. */
  log?: (message: string) => void;
  /** Replaceable so a test does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface IndexerWait {
  /** How long it took to get a usable answer. Zero when the first probe was fine. */
  waitedMs: number;
  height: number;
  blockAgeSeconds: number;
}

const DEFAULT_MAX_WAIT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_MAX_BLOCK_AGE_SECONDS = 600;

/** Whether one probe counts as "up and caught up". */
export function indexerUsable(probe: IndexerProbe, maxBlockAgeSeconds = DEFAULT_MAX_BLOCK_AGE_SECONDS): boolean {
  return probe.ok && probe.blockAgeSeconds <= maxBlockAgeSeconds;
}

/**
 * Resolve once the indexer answers with a recent block; throw once the wait
 * has gone on for longer than a caller is prepared to stand.
 *
 * Says something on the first failed probe and then every ten, so a log
 * shows an outage as one line at its start and a heartbeat through it,
 * rather than a wall of identical lines or nothing at all.
 */
export async function waitForIndexer(
  indexerHttpUrl: string,
  options: WaitForIndexerOptions = {},
): Promise<IndexerWait> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxAge = options.maxBlockAgeSeconds ?? DEFAULT_MAX_BLOCK_AGE_SECONDS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  let polls = 0;
  for (;;) {
    const probe = await probeIndexer(indexerHttpUrl, options);
    if (indexerUsable(probe, maxAge) && probe.ok) {
      const waitedMs = now() - started;
      if (polls > 0) options.log?.(`indexer back after ${Math.round(waitedMs / 1000)}s at block ${probe.height}`);
      return { waitedMs, height: probe.height, blockAgeSeconds: probe.blockAgeSeconds };
    }
    const why = probe.ok ? `is not caught up (its latest block is ${probe.blockAgeSeconds}s old)` : probe.why;
    if (polls === 0 || polls % 10 === 0) {
      options.log?.(`indexer at ${indexerHttpUrl} ${why}; waiting (${Math.round((now() - started) / 1000)}s so far)`);
    }
    if (now() - started + pollMs > maxWaitMs) {
      throw new Error(
        `The indexer at ${indexerHttpUrl} ${why} and did not become usable within ${Math.round(maxWaitMs / 1000)}s. ` +
          'Nothing was submitted while waiting. Read the chain before retrying anything that failed earlier.',
      );
    }
    polls += 1;
    await sleep(pollMs);
  }
}

/**
 * Refuse to start if the indexer is down or behind, in one probe.
 *
 * For a CLI that is about to build a wallet against the indexer: the sync
 * would otherwise fail minutes in with a websocket error that names neither
 * the indexer nor the reason, or — worse — succeed against a stale view. The
 * message is shaped so the failure classifier reads it as an outage, which
 * is what lets the caller wait and come back rather than stop.
 */
export async function assertIndexerReachable(
  indexerHttpUrl: string,
  options: ProbeOptions & { maxBlockAgeSeconds?: number } = {},
): Promise<void> {
  const probe = await probeIndexer(indexerHttpUrl, options);
  if (!probe.ok) {
    throw new Error(
      probe.status === undefined
        ? `The indexer at ${indexerHttpUrl} is not reachable (${probe.why}), so nothing built against it would land.`
        : `The indexer at ${indexerHttpUrl} answered ${probe.status}${probe.why.startsWith('answered') ? '' : ` (${probe.why})`}, so nothing built against it would land.`,
    );
  }
  const maxAge = options.maxBlockAgeSeconds ?? DEFAULT_MAX_BLOCK_AGE_SECONDS;
  if (probe.blockAgeSeconds > maxAge) {
    throw new Error(
      `The indexer at ${indexerHttpUrl} is not caught up (its latest block is ${probe.blockAgeSeconds}s old), ` +
        'so a wallet synced through it would build against a state the chain has left.',
    );
  }
}
