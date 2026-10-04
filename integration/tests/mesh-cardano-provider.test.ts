// Guards over the failover provider the Mesh-built submitters use.
//
// WHY THIS EXISTS
// Failover for SUBMISSION is only safe if a ledger refusal is never retried
// elsewhere and an outage always is. Mesh reports both as strings of JSON or,
// for a dropped connection, as a ReferenceError, so the classification has to
// be read from those exact shapes. The values classified here are not copies:
// each is what Mesh's real BlockfrostProvider threw against a local server
// answering the way Blockfrost does.
//
// The Koios half is pinned at the request: the full base URL the plugin sets
// must reach Koios's own paths, with no "Bearer undefined" header (which Koios
// answers with a 403), and the reads Mesh's Koios provider lacks must arrive
// in the shape Mesh's builder reads.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BlockfrostProvider } from '@meshsdk/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AmbiguousSubmissionError, FALLBACK_KOIOS_TOKEN_ENV, FALLBACK_KOIOS_URL_ENV } from '../cardano-provider.js';
import { CircuitBreakerManager } from '../chain-provider-router.js';
import {
  isMeshAlreadySubmitted,
  isMeshTransitFailure,
  type MeshChainProvider,
  MeshFailoverProvider,
  MeshKoiosFallback,
  meshCardanoProvider,
  readMeshFailure,
} from '../mesh-cardano-provider.js';

// A node refusal, as Blockfrost returns it. It carries numbers that look like
// HTTP statuses, which is the point: only the response's own status counts.
const REFUSAL_BODY = {
  status_code: 400,
  error: 'Bad Request',
  message:
    '"transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure ' +
    '(UtxoFailure (ValueNotConservedUTxO (Mismatch {mismatchSupplied = MaryValue (Coin 500) ... (Coin 429)"',
};

/** What each first path segment answers, the way Blockfrost answers it. */
const ROUTES: Record<string, { status: number; body: unknown }> = {
  refusal: { status: 400, body: REFUSAL_BODY },
  already: { status: 400, body: { status_code: 400, error: 'Bad Request', message: 'Transaction already in mempool' } },
  'rate-limited': {
    status: 429,
    body: { status_code: 429, error: 'Project Over Limit', message: 'Usage is over limit.' },
  },
  'server-error': { status: 500, body: { status_code: 500, error: 'Internal Server Error', message: 'Unexpected.' } },
  unavailable: { status: 503, body: '<html>Service Unavailable</html>' },
  missing: {
    status: 404,
    body: { status_code: 404, error: 'Not Found', message: 'The requested component has not been found.' },
  },
  // A script that fails evaluation: Blockfrost answers 200 with the failure.
  'eval-failure': {
    status: 200,
    body: { type: 'jsonwsp/response', result: { EvaluationFailure: { ScriptFailures: { 'spend:0': [] } } } },
  },
};

let server: Server;
let base: string;
const real: Record<string, unknown> = {};

/** What Mesh's real BlockfrostProvider throws when the server answers on `route`. */
async function thrownBy(route: string, call: (provider: BlockfrostProvider) => Promise<unknown>): Promise<unknown> {
  try {
    await call(new BlockfrostProvider(`${base}/${route}`));
  } catch (err) {
    return err;
  }
  throw new Error(`${route} did not fail`);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const route = (req.url ?? '').split('/')[1] ?? '';
      // The connection drops with no response at all.
      if (route === 'reset') return req.socket.destroy();
      const { status, body } = ROUTES[route] ?? { status: 404, body: {} };
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' });
      res.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const route of ['refusal', 'already', 'rate-limited', 'server-error', 'unavailable', 'missing', 'reset']) {
    real[route] = await thrownBy(route, (p) => p.submitTx('84a0'));
  }
  real.evalFailure = await thrownBy('eval-failure', (p) => p.evaluateTx('84a0'));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function fake(overrides: Partial<Record<keyof MeshChainProvider, unknown>> = {}): MeshChainProvider {
  return {
    fetchAccountInfo: vi.fn(async () => ({})),
    fetchAddressUTxOs: vi.fn(async () => []),
    fetchAddressTxs: vi.fn(async () => []),
    fetchAssetAddresses: vi.fn(async () => []),
    fetchAssetMetadata: vi.fn(async () => ({})),
    fetchBlockInfo: vi.fn(async () => ({})),
    fetchCollectionAssets: vi.fn(async () => ({ assets: [] })),
    fetchProtocolParameters: vi.fn(async () => ({})),
    fetchCostModels: vi.fn(async () => [[1], [2], [3]]),
    fetchTxInfo: vi.fn(async () => ({})),
    fetchUTxOs: vi.fn(async () => []),
    fetchGovernanceProposal: vi.fn(async () => ({})),
    get: vi.fn(async () => ({})),
    submitTx: vi.fn(async () => 'hash-from-backend'),
    evaluateTx: vi.fn(async () => []),
    ...overrides,
  } as unknown as MeshChainProvider;
}

const rejecting = (err: unknown) => vi.fn(async () => Promise.reject(err));

const two = (primary: MeshChainProvider, secondary: MeshChainProvider, breaker = new CircuitBreakerManager()) =>
  new MeshFailoverProvider(
    [
      { name: 'blockfrost', provider: primary },
      { name: 'koios', provider: secondary },
    ],
    breaker,
    () => 'hash-from-cbor',
  );

describe('reading what Mesh threw', () => {
  it('reads a 400 as a refusal, whatever numbers its text carries', () => {
    expect(typeof real.refusal).toBe('string');
    expect(readMeshFailure(real.refusal)).toMatchObject({ status: 400 });
    expect(readMeshFailure(real.refusal).body).toContain('Coin 500');
    expect(isMeshTransitFailure(real.refusal)).toBe(false);
  });

  it('reads a rate limit, a 5xx and a dropped connection as transit', () => {
    expect(isMeshTransitFailure(real['rate-limited'])).toBe(true);
    expect(isMeshTransitFailure(real['server-error'])).toBe(true);
    expect(isMeshTransitFailure(real.unavailable)).toBe(true);
    // Under Node, Mesh reports a request with no response this way.
    expect(real.reset).toBeInstanceOf(ReferenceError);
    expect(isMeshTransitFailure(real.reset)).toBe(true);
  });

  it('reads a failed evaluation as an answer, not as transit', () => {
    expect(readMeshFailure(real.evalFailure).body).toContain('EvaluationFailure');
    expect(isMeshTransitFailure(real.evalFailure)).toBe(false);
  });

  it('recognises an already-queued transaction from the body alone', () => {
    expect(isMeshAlreadySubmitted(real.already)).toBe(true);
    expect(isMeshAlreadySubmitted(real.refusal)).toBe(false);
  });
});

describe('submission', () => {
  it('never takes a ledger refusal to the second backend', async () => {
    const secondary = fake();
    const provider = two(fake({ submitTx: rejecting(real.refusal) }), secondary);
    await expect(provider.submitTx('84a4')).rejects.toBe(real.refusal);
    expect(secondary.submitTx).not.toHaveBeenCalled();
  });

  it.each(['rate-limited', 'server-error', 'reset'])(
    'takes a %s failure to the second backend and returns its hash',
    async (route) => {
      const secondary = fake({ submitTx: vi.fn(async () => 'hash-from-koios') });
      const provider = two(fake({ submitTx: rejecting(real[route]) }), secondary);
      await expect(provider.submitTx('84a4')).resolves.toBe('hash-from-koios');
      expect(secondary.submitTx).toHaveBeenCalledOnce();
    },
  );

  it('counts an already-queued reply as success and returns the transaction’s own hash', async () => {
    const secondary = fake();
    const provider = two(fake({ submitTx: rejecting(real.already) }), secondary);
    await expect(provider.submitTx('84a4')).resolves.toBe('hash-from-cbor');
    expect(secondary.submitTx).not.toHaveBeenCalled();
  });

  it('calls a refusal that follows a transit failure ambiguous, because the first may have landed it', async () => {
    const provider = two(fake({ submitTx: rejecting(real.reset) }), fake({ submitTx: rejecting(real.refusal) }));
    const err = await provider.submitTx('84a4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousSubmissionError);
    expect(err).toMatchObject({ transitError: real.reset, refusal: real.refusal });
  });

  it('reports the first transit failure when every backend fails in transit', async () => {
    const provider = two(
      fake({ submitTx: rejecting(real['rate-limited']) }),
      fake({ submitTx: rejecting(real.reset) }),
    );
    await expect(provider.submitTx('84a4')).rejects.toBe(real['rate-limited']);
  });
});

describe('evaluation', () => {
  it('moves on in transit', async () => {
    const budgets = [{ tag: 'SPEND', index: 0, budget: { mem: 1, steps: 2 } }];
    const provider = two(
      fake({ evaluateTx: rejecting(real['server-error']) }),
      fake({ evaluateTx: vi.fn(async () => budgets) }),
    );
    await expect(provider.evaluateTx('84a4')).resolves.toBe(budgets);
  });

  it('keeps a failed evaluation final rather than asking an evaluator that could hide it', async () => {
    const secondary = fake();
    const provider = two(fake({ evaluateTx: rejecting(real.evalFailure) }), secondary);
    await expect(provider.evaluateTx('84a4')).rejects.toBe(real.evalFailure);
    expect(secondary.evaluateTx).not.toHaveBeenCalled();
  });
});

describe('reads and the breaker', () => {
  it('falls back on any read failure, and reports the primary’s error when both fail', async () => {
    const utxos = [{ input: { txHash: 'k', outputIndex: 0 } }];
    const provider = two(fake({ fetchUTxOs: rejecting(real.missing) }), fake({ fetchUTxOs: vi.fn(async () => utxos) }));
    await expect(provider.fetchUTxOs('k')).resolves.toBe(utxos);
    const failing = two(fake({ fetchUTxOs: rejecting(real.missing) }), fake({ fetchUTxOs: rejecting(real.reset) }));
    await expect(failing.fetchUTxOs('k')).rejects.toBe(real.missing);
  });

  it('asks the next backend when an address read comes back empty, since Mesh reports every failure that way', async () => {
    const utxos = [{ input: { txHash: 'k', outputIndex: 0 } }];
    const secondary = fake({ fetchAddressUTxOs: vi.fn(async () => utxos) });
    await expect(two(fake(), secondary).fetchAddressUTxOs('addr_test1')).resolves.toBe(utxos);

    const untouched = fake({ fetchAddressUTxOs: vi.fn(async () => utxos) });
    await expect(
      two(fake({ fetchAddressUTxOs: vi.fn(async () => utxos) }), untouched).fetchAddressUTxOs('a'),
    ).resolves.toBe(utxos);
    expect(untouched.fetchAddressUTxOs).not.toHaveBeenCalled();

    await expect(two(fake(), fake()).fetchAddressUTxOs('addr_test1')).resolves.toEqual([]);
  });

  it('stops calling a backend whose circuit a transit failure opened', async () => {
    const breaker = new CircuitBreakerManager({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const primary = fake({ fetchUTxOs: rejecting(real['rate-limited']) });
    const provider = two(primary, fake(), breaker);
    await provider.fetchUTxOs('h');
    await provider.fetchUTxOs('h');
    expect(primary.fetchUTxOs).toHaveBeenCalledOnce();
    // Submission skips it too, straight to the second backend.
    await expect(provider.submitTx('84a4')).resolves.toBe('hash-from-backend');
    expect(primary.submitTx).not.toHaveBeenCalled();
  });

  it('keeps the circuit closed for a backend that answered "not found"', async () => {
    const breaker = new CircuitBreakerManager({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const primary = fake({ fetchUTxOs: rejecting(real.missing) });
    const provider = two(primary, fake(), breaker);
    await provider.fetchUTxOs('h');
    await provider.fetchUTxOs('h');
    expect(primary.fetchUTxOs).toHaveBeenCalledTimes(2);
  });

  it('sends a path in one backend’s own API to that backend alone', async () => {
    const secondary = fake();
    const provider = two(fake({ get: rejecting(real['server-error']) }), secondary);
    await expect(provider.get('epochs/latest')).rejects.toBe(real['server-error']);
    expect(secondary.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The Koios side, at the request
// ---------------------------------------------------------------------------

/** The value the plugin sets on Preprod, exactly. */
const KOIOS_PREPROD = 'https://preprod.koios.rest/api/v1';

interface StubbableAxios {
  defaults: { adapter?: unknown };
  getUri(config: unknown): string;
}

/**
 * Answers a Mesh provider's requests in place of the network, keyed by the
 * full URL each would have gone to, and records what was sent.
 */
function answer(provider: object, replies: Record<string, { status: number; data: unknown }>) {
  const http = (provider as { _axiosInstance: StubbableAxios })._axiosInstance;
  const sent: Array<{ url: string; authorization: unknown }> = [];
  http.defaults.adapter = async (config: { headers?: Record<string, unknown> }) => {
    const url = http.getUri(config);
    sent.push({ url, authorization: config.headers?.Authorization });
    const reply = replies[url];
    if (!reply) throw new Error(`unexpected request to ${url}`);
    return { ...reply, statusText: 'OK', headers: {}, config, request: {} };
  };
  return sent;
}

describe('the Koios fallback', () => {
  it('takes the full base URL as given, and sends no "Bearer undefined" when there is no token', async () => {
    // Blockfrost is real and answers 503; Koios is the URL the plugin sets.
    const provider = meshCardanoProvider(`${base}/unavailable`, { [FALLBACK_KOIOS_URL_ENV]: KOIOS_PREPROD });
    expect(provider).toBeInstanceOf(MeshFailoverProvider);
    const koios = (provider as MeshFailoverProvider).backends[1].provider;
    const sent = answer(koios, { [`${KOIOS_PREPROD}/submittx`]: { status: 202, data: 'hash-from-koios' } });

    await expect(provider.submitTx('84a0')).resolves.toBe('hash-from-koios');
    expect(sent).toEqual([{ url: 'https://preprod.koios.rest/api/v1/submittx', authorization: undefined }]);
  });

  it('sends the token as a bearer token when one is named', async () => {
    const provider = meshCardanoProvider(`${base}/unavailable`, {
      [FALLBACK_KOIOS_URL_ENV]: KOIOS_PREPROD,
      [FALLBACK_KOIOS_TOKEN_ENV]: 'koios-token',
    });
    const sent = answer((provider as MeshFailoverProvider).backends[1].provider, {
      [`${KOIOS_PREPROD}/submittx`]: { status: 202, data: 'hash-from-koios' },
    });
    await provider.submitTx('84a0');
    expect(sent[0]?.authorization).toBe('Bearer koios-token');
  });

  it('reads cost models, which Mesh’s Koios provider lacks, in the order the builder takes them', async () => {
    const koios = new MeshKoiosFallback(KOIOS_PREPROD);
    const models = { PlutusV1: [1, 2], PlutusV2: [3, 4], PlutusV3: [5, -6] };
    const sent = answer(koios, {
      [`${KOIOS_PREPROD}/tip`]: { status: 200, data: [{ epoch_no: 317 }] },
      [`${KOIOS_PREPROD}/epoch_params?_epoch_no=317&select=cost_models`]: {
        status: 200,
        data: [{ cost_models: models }],
      },
    });
    await expect(koios.fetchCostModels()).resolves.toEqual([
      [1, 2],
      [3, 4],
      [5, -6],
    ]);
    expect(sent.map((s) => s.url)).toEqual([
      'https://preprod.koios.rest/api/v1/tip',
      'https://preprod.koios.rest/api/v1/epoch_params?_epoch_no=317&select=cost_models',
    ]);
  });

  it('refuses cost models it cannot read rather than handing the builder something else', async () => {
    const koios = new MeshKoiosFallback(KOIOS_PREPROD);
    answer(koios, {
      [`${KOIOS_PREPROD}/epoch_params?_epoch_no=9&select=cost_models`]: { status: 200, data: [{ cost_models: {} }] },
    });
    await expect(koios.fetchCostModels(9)).rejects.toThrow(/no cost models for epoch 9/);
  });

  it('tags a withdrawal’s budget the way Mesh’s builder looks for it', async () => {
    const koios = new MeshKoiosFallback(KOIOS_PREPROD);
    // Ogmios's evaluation result, as Koios relays it.
    answer(koios, {
      [`${KOIOS_PREPROD}/ogmios`]: {
        status: 200,
        data: {
          jsonrpc: '2.0',
          result: [
            { validator: { purpose: 'spend', index: 0 }, budget: { memory: 10, cpu: 20 } },
            { validator: { purpose: 'withdraw', index: 0 }, budget: { memory: 30, cpu: 40 } },
          ],
        },
      },
    });
    await expect(koios.evaluateTx('84a0')).resolves.toEqual([
      { tag: 'SPEND', index: 0, budget: { mem: 10, steps: 20 } },
      { tag: 'REWARD', index: 0, budget: { mem: 30, steps: 40 } },
    ]);
  });
});

describe('meshCardanoProvider', () => {
  it('is plain Blockfrost when no fallback is named, so adopting it changes nothing', () => {
    for (const env of [{}, { [FALLBACK_KOIOS_URL_ENV]: '  ' }]) {
      const provider = meshCardanoProvider(`preprod${'x'.repeat(32)}`, env);
      expect(provider).toBeInstanceOf(BlockfrostProvider);
      expect(provider).not.toBeInstanceOf(MeshFailoverProvider);
    }
  });
});
