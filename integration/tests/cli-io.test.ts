// Tests for integration/cli/cli-io.ts — the shared I/O helpers extracted
// from ~20 near-identical inline copies across the real CLI scripts (a
// survey of all 32 files found 3 genuinely different required-field truth
// tables and 2 readStdin/jsonSafe variants — this suite locks each one down
// exactly, including the disagreement matrix, so a future edit can't
// silently collapse them into the wrong behavior for a given file).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CARDANO_NETWORK_MAP,
  claimStdoutForResult,
  isNetworkFailure,
  jsonSafe,
  loadPlutusBlueprint,
  loadValidatorCbor,
  parseJsonStdin,
  readStdin,
  requireField,
  requireFieldsAllowZero,
  requireFieldsFalsy,
  requireFieldsStrict,
  requireTimestampMs,
  resultJsonFrom,
  withFetchRetry,
} from '../cli/cli-io.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn() };
});

const originalStdin = process.stdin;
afterEach(() => {
  Object.defineProperty(process, 'stdin', {
    value: originalStdin,
    configurable: true,
  });
  vi.mocked(readFileSync).mockReset();
});

function fakeStdin(chunks: string[]) {
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield Buffer.from(chunk, 'utf8');
      },
    },
  });
}

describe('resultJsonFrom (the result object, whatever was printed before it)', () => {
  // The exact stdout a delivery CLI produced on Preprod: the wallet SDK's
  // logger wrote a multi-line WARN record through console.log ahead of the
  // result, and the caller's plain JSON.parse read the whole run as "no JSON
  // result" although the transaction had landed.
  const POLLUTED =
    'timestamp=2026-09-23T02:11:00.308Z level=WARN fiber=#26 message="{\n' +
    '  \\"message\\": \\"An unknown error occurred\\",\n' +
    '  \\"_tag\\": \\"ServerError\\"\n' +
    '}" message="Observed error in PendingTransactionsService, retrying"\n' +
    '{"ok":false,"error":"Transaction submission error <- Failed to parse result provided by node"}';

  it('takes the last line that is an object, past anything logged ahead of it', () => {
    expect(resultJsonFrom(POLLUTED)).toEqual({
      ok: false,
      error: 'Transaction submission error <- Failed to parse result provided by node',
    });
  });

  it('reads a clean single-line result as before', () => {
    expect(resultJsonFrom('{"ok":true,"state":{"dvState":1}}\n')).toEqual({ ok: true, state: { dvState: 1 } });
  });

  it('reads a pretty-printed result that spans lines', () => {
    expect(resultJsonFrom('{\n "ok": true,\n "turns": []\n}\n')).toEqual({ ok: true, turns: [] });
  });

  it('is null for output that holds no object at all', () => {
    expect(resultJsonFrom('')).toBeNull();
    expect(resultJsonFrom('Error: something\n    at file:///x.js:1:1\n')).toBeNull();
    expect(resultJsonFrom('[1,2]')).toBeNull();
  });

  it('skips a line that starts like an object and is not one', () => {
    expect(resultJsonFrom('{"ok":true}\n{ not json')).toEqual({ ok: true });
  });
});

describe('claimStdoutForResult', () => {
  it('sends console.log and its siblings to stderr and leaves console.error alone', () => {
    const saved = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      debug: console.debug,
      error: console.error,
    };
    const err = vi.fn();
    console.error = err as never;
    try {
      claimStdoutForResult();
      console.log('a record');
      console.warn('another');
      expect(err).toHaveBeenCalledTimes(2);
      expect(err).toHaveBeenNthCalledWith(1, 'a record');
    } finally {
      Object.assign(console, saved);
    }
  });
});

describe('readStdin', () => {
  it('concatenates every chunk into one UTF-8 string', async () => {
    fakeStdin(['{"a":', '1}']);
    await expect(readStdin()).resolves.toBe('{"a":1}');
  });

  it('returns an empty string for empty stdin', async () => {
    fakeStdin([]);
    await expect(readStdin()).resolves.toBe('');
  });
});

describe('parseJsonStdin', () => {
  it('parses valid JSON', () => {
    expect(parseJsonStdin<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('throws the exact "Invalid JSON on stdin." message on malformed input (matching 30/32 real CLI files)', () => {
    expect(() => parseJsonStdin('{not valid json')).toThrow('Invalid JSON on stdin.');
  });

  it('throws the same message for empty input', () => {
    expect(() => parseJsonStdin('')).toThrow('Invalid JSON on stdin.');
  });
});

describe('requireFieldsAllowZero (rejects falsy EXCEPT the number 0)', () => {
  it('accepts a 0 value', () => {
    expect(() => requireFieldsAllowZero({ amount: 0 }, ['amount'])).not.toThrow();
  });

  it('rejects undefined, null, empty string, and false', () => {
    expect(() => requireFieldsAllowZero({ a: undefined }, ['a'])).toThrow('Missing required field: a');
    expect(() => requireFieldsAllowZero({ a: null }, ['a'])).toThrow('Missing required field: a');
    expect(() => requireFieldsAllowZero({ a: '' }, ['a'])).toThrow('Missing required field: a');
    expect(() => requireFieldsAllowZero({ a: false }, ['a'])).toThrow('Missing required field: a');
  });

  it('checks every key in the list, reporting the first missing one', () => {
    expect(() => requireFieldsAllowZero({ a: 'ok', b: undefined, c: 'ok' }, ['a', 'b', 'c'])).toThrow(
      'Missing required field: b',
    );
  });
});

describe('requireFieldsFalsy (rejects ANY falsy value, including 0)', () => {
  it('rejects a 0 value — the real disagreement with requireFieldsAllowZero', () => {
    expect(() => requireFieldsFalsy({ amount: 0 }, ['amount'])).toThrow('Missing required field: amount');
  });

  it('rejects empty string and false too', () => {
    expect(() => requireFieldsFalsy({ a: '' }, ['a'])).toThrow('Missing required field: a');
    expect(() => requireFieldsFalsy({ a: false }, ['a'])).toThrow('Missing required field: a');
  });

  it('accepts any truthy value', () => {
    expect(() => requireFieldsFalsy({ a: 'ok', b: 1, c: true }, ['a', 'b', 'c'])).not.toThrow();
  });
});

describe('requireFieldsStrict (rejects only undefined/null/empty-string; accepts 0 and false)', () => {
  it('accepts 0 and false — the real disagreement with requireFieldsFalsy', () => {
    expect(() => requireFieldsStrict({ amount: 0, flag: false }, ['amount', 'flag'])).not.toThrow();
  });

  it('rejects undefined, null, and empty string', () => {
    expect(() => requireFieldsStrict({ a: undefined }, ['a'])).toThrow('Missing required field: a');
    expect(() => requireFieldsStrict({ a: null }, ['a'])).toThrow('Missing required field: a');
    expect(() => requireFieldsStrict({ a: '' }, ['a'])).toThrow('Missing required field: a');
  });
});

describe('requireField (single-field, action-dispatch CLIs)', () => {
  it('returns the value when present (accepts 0/false, same truth table as requireFieldsStrict)', () => {
    expect(requireField({ amount: 0 }, 'amount')).toBe(0);
    expect(requireField({ flag: false }, 'flag')).toBe(false);
  });

  it('throws a plain message with no action label given', () => {
    expect(() => requireField({ a: undefined }, 'a')).toThrow('Missing required field: a');
  });

  it("includes the action label in the error message when given, matching stake-action.ts/tier-b-curve-action.ts/token-metadata-action.ts's real format", () => {
    expect(() => requireField({ a: undefined }, 'a', 'stake')).toThrow('Missing required field for action "stake": a');
  });
});

describe('requireTimestampMs (the seconds/milliseconds boundary)', () => {
  // Cardano's validity range is milliseconds and every validator timestamp
  // is compared against it; Midnight's ledger block field is
  // `secondsSinceEpoch`. This codebase talks to both, so the units genuinely
  // differ by destination and the CLI is where a PHP-supplied value crosses
  // into the Cardano half. A seconds value here is not a slightly wrong
  // time, it is 1970.
  const REAL_NOW_MS = 1_775_000_000_000;
  const SAME_INSTANT_SECONDS = 1_775_000_000;

  it('accepts a real millisecond timestamp and returns it unchanged', () => {
    expect(requireTimestampMs(REAL_NOW_MS, 'currentTimestampMs')).toBe(REAL_NOW_MS);
  });

  it('rejects the same instant expressed in seconds', () => {
    expect(() => requireTimestampMs(SAME_INSTANT_SECONDS, 'currentTimestampMs')).toThrow(/must be MILLISECONDS/);
  });

  it('names the offending field, so the error points at the real caller', () => {
    expect(() => requireTimestampMs(SAME_INSTANT_SECONDS, 'lockSealTimestampMs')).toThrow(/lockSealTimestampMs/);
  });

  it('accepts the exact boundary and rejects one below it', () => {
    // 1e12 ms is 2001-09-09, the instant below which a value could honestly
    // be either unit. Pinned from both sides one unit apart so the
    // comparison cannot drift to the wrong side without a test noticing.
    expect(requireTimestampMs(1_000_000_000_000, 'ts')).toBe(1_000_000_000_000);
    expect(() => requireTimestampMs(999_999_999_999, 'ts')).toThrow(/must be MILLISECONDS/);
  });

  it('rejects a non-integer or non-finite value before the unit check', () => {
    expect(() => requireTimestampMs(1.5, 'ts')).toThrow(/integer number of milliseconds/);
    expect(() => requireTimestampMs(Number.NaN, 'ts')).toThrow(/integer number of milliseconds/);
    expect(() => requireTimestampMs(Number.POSITIVE_INFINITY, 'ts')).toThrow(/integer number of milliseconds/);
  });
});

describe('jsonSafe', () => {
  it('converts a bigint to a string', () => {
    expect(jsonSafe(123n)).toBe('123');
  });

  it('converts a Uint8Array to a hex string', () => {
    expect(jsonSafe(new Uint8Array([0x00, 0xab, 0xff]))).toBe('00abff');
  });

  it('recurses into arrays', () => {
    expect(jsonSafe([1n, 2n, 'three'])).toEqual(['1', '2', 'three']);
  });

  it('recurses into nested plain objects', () => {
    expect(jsonSafe({ a: 1n, b: { c: 2n, d: 'ok' } })).toEqual({
      a: '1',
      b: { c: '2', d: 'ok' },
    });
  });

  it('leaves strings, numbers, booleans, and null unchanged', () => {
    expect(jsonSafe('x')).toBe('x');
    expect(jsonSafe(42)).toBe(42);
    expect(jsonSafe(true)).toBe(true);
    expect(jsonSafe(null)).toBe(null);
  });

  it('round-trips through JSON.stringify without throwing (the whole point of this function)', () => {
    const value = {
      txHash: 'abc',
      grossPayment: 500_000n,
      buyerKeyHash: new Uint8Array([1, 2, 3]),
    };
    expect(() => JSON.stringify(jsonSafe(value))).not.toThrow();
    expect(JSON.parse(JSON.stringify(jsonSafe(value)))).toEqual({
      txHash: 'abc',
      grossPayment: '500000',
      buyerKeyHash: '010203',
    });
  });
});

describe('CARDANO_NETWORK_MAP', () => {
  it("maps all three real network names to Lucid Evolution's expected values", () => {
    expect(CARDANO_NETWORK_MAP).toEqual({
      preview: 'Preview',
      preprod: 'Preprod',
      mainnet: 'Mainnet',
    });
  });
});

describe('loadPlutusBlueprint / loadValidatorCbor', () => {
  it("loadPlutusBlueprint reads plutus.json from 3 levels above the caller's __dirname", async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ validators: [] }));
    loadPlutusBlueprint('/project/integration/cli/dist');
    const calledPath = vi.mocked(readFileSync).mock.calls[0][0] as string;
    // join('/project/integration/cli/dist', '..','..','..', 'contracts','cardano','plutus.json')
    expect(calledPath.replace(/\\/g, '/')).toBe('/project/contracts/cardano/plutus.json');
  });

  it('loadValidatorCbor finds the entry matching the given title', () => {
    const blueprint = {
      validators: [
        {
          title: 'bonding_curve_tier_b.bonding_curve_tier_b.spend',
          compiledCode: 'deadbeef',
        },
      ],
    };
    expect(loadValidatorCbor(blueprint, 'bonding_curve_tier_b.bonding_curve_tier_b.spend')).toBe('deadbeef');
  });

  it('loadValidatorCbor throws the exact "<title> not found in plutus.json." message every CLI file already uses', () => {
    const blueprint = { validators: [] };
    expect(() => loadValidatorCbor(blueprint, 'missing.validator')).toThrow(
      'missing.validator not found in plutus.json.',
    );
  });
});

describe('withFetchRetry — a dropped connection is the same request owed again', () => {
  const dropped = () =>
    new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  const terminated = () => new TypeError('terminated');
  const reply = (status: number) => ({ status }) as Response;
  const noWait = () => 0;

  it('retries a network failure and returns the reply that finally arrives', async () => {
    const base = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(dropped())
      .mockRejectedValueOnce(terminated())
      .mockResolvedValueOnce(reply(200));
    const res = await withFetchRetry(base, 4, noWait)('https://example.test/x');
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(3);
  });

  it('never retries a reply, whatever its status', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(reply(500));
    const res = await withFetchRetry(base, 4, noWait)('https://example.test/x');
    expect(res.status).toBe(500);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('never retries a failure that is not the network', async () => {
    const base = vi.fn<typeof fetch>().mockRejectedValue(new Error('Maximum Input Count Exceeded'));
    await expect(withFetchRetry(base, 4, noWait)('https://example.test/x')).rejects.toThrow(/Maximum Input Count/);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('gives up after the stated attempts with the last failure', async () => {
    const base = vi.fn<typeof fetch>().mockRejectedValue(dropped());
    await expect(withFetchRetry(base, 3, noWait)('https://example.test/x')).rejects.toThrow(/fetch failed/);
    expect(base).toHaveBeenCalledTimes(3);
  });

  it('waits the stated backoff between attempts, and not before the first', async () => {
    const waits: number[] = [];
    const base = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(dropped())
      .mockRejectedValueOnce(dropped())
      .mockResolvedValueOnce(reply(200));
    await withFetchRetry(base, 4, (attempt) => {
      waits.push(attempt);
      return 0;
    })('https://example.test/x');
    expect(waits).toEqual([1, 2]);
  });

  it('recognises a network failure by its message, its code or its cause, and nothing else', () => {
    expect(isNetworkFailure(dropped())).toBe(true);
    expect(isNetworkFailure(terminated())).toBe(true);
    expect(isNetworkFailure(new Error('request failed', { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
    expect(isNetworkFailure('socket hang up')).toBe(true);
    expect(isNetworkFailure(new Error('HTTP 429'))).toBe(false);
    expect(isNetworkFailure(new DOMException('The operation was aborted', 'AbortError'))).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});
