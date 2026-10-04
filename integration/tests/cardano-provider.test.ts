// Guards over the failover Cardano provider.
//
// WHY THIS EXISTS
// Failover for SUBMISSION is only safe if a ledger refusal is never retried
// elsewhere and an outage always is. Getting the first wrong double-reports a
// refusal; getting the second wrong is the outage this exists for. Both are
// driven here with stand-in backends whose failures use the real message
// shapes Lucid's Blockfrost provider throws.

import type { Provider } from '@lucid-evolution/lucid';
import { describe, expect, it, vi } from 'vitest';
import {
  AmbiguousSubmissionError,
  cardanoProvider,
  FALLBACK_KOIOS_URL_ENV,
  FailoverProvider,
  isAlreadySubmitted,
  isTransitFailure,
} from '../cardano-provider.js';
import { CircuitBreakerManager } from '../chain-provider-router.js';

// What Lucid's Blockfrost provider throws: the node's own text on a 400, and
// this one bare sentence for every other failure (429, 5xx, 403, …).
const BLOCKFROST_TRANSIT = new Error('Could not submit transaction.');
const BLOCKFROST_REFUSAL = new Error(
  'transaction submit error ShelleyTxValidationError ShelleyBasedEraConway (ApplyTxError (ConwayUtxowFailure ' +
    '(UtxoFailure (ValueNotConservedUTxO (Mismatch {mismatchSupplied = MaryValue (Coin 500) ...',
);

function fake(overrides: Partial<Provider> = {}): Provider {
  return {
    getProtocolParameters: vi.fn(async () => ({}) as never),
    getUtxos: vi.fn(async () => []),
    getUtxosWithUnit: vi.fn(async () => []),
    getUtxoByUnit: vi.fn(async () => ({}) as never),
    getUtxosByOutRef: vi.fn(async () => []),
    getDelegation: vi.fn(async () => ({}) as never),
    getDatum: vi.fn(async () => 'd8799f'),
    awaitTx: vi.fn(async () => true),
    submitTx: vi.fn(async () => 'hash-from-backend'),
    evaluateTx: vi.fn(async () => []),
    ...overrides,
  } as Provider;
}

const two = (primary: Provider, secondary: Provider, breaker = new CircuitBreakerManager()) =>
  new FailoverProvider(
    [
      { name: 'blockfrost', provider: primary },
      { name: 'koios', provider: secondary },
    ],
    breaker,
    () => 'hash-from-cbor',
  );

describe('reading the failure', () => {
  it('reads Blockfrost’s bare sentence and network errors as transit, and a node refusal as a refusal', () => {
    expect(isTransitFailure(BLOCKFROST_TRANSIT)).toBe(true);
    expect(isTransitFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isTransitFailure(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
    // A refusal can carry any number — "Coin 500" must not read as an HTTP 500.
    expect(isTransitFailure(BLOCKFROST_REFUSAL)).toBe(false);
  });

  it('recognises an already-queued transaction', () => {
    expect(isAlreadySubmitted(new Error('Transaction already in mempool'))).toBe(true);
    expect(isAlreadySubmitted(BLOCKFROST_REFUSAL)).toBe(false);
  });
});

describe('submission', () => {
  it('never takes a ledger refusal to the second backend', async () => {
    const secondary = fake();
    const provider = two(fake({ submitTx: vi.fn(async () => Promise.reject(BLOCKFROST_REFUSAL)) }), secondary);
    await expect(provider.submitTx('84a4')).rejects.toBe(BLOCKFROST_REFUSAL);
    expect(secondary.submitTx).not.toHaveBeenCalled();
  });

  it('takes a transit failure to the second backend and returns its hash', async () => {
    const secondary = fake({ submitTx: vi.fn(async () => 'hash-from-koios') });
    const provider = two(fake({ submitTx: vi.fn(async () => Promise.reject(BLOCKFROST_TRANSIT)) }), secondary);
    await expect(provider.submitTx('84a4')).resolves.toBe('hash-from-koios');
    expect(secondary.submitTx).toHaveBeenCalledOnce();
  });

  it('counts an already-queued reply as success and returns the transaction’s own hash', async () => {
    const provider = two(
      fake({ submitTx: vi.fn(async () => Promise.reject(new Error('already in mempool'))) }),
      fake(),
    );
    await expect(provider.submitTx('84a4')).resolves.toBe('hash-from-cbor');
  });

  it('calls a refusal that follows a transit failure ambiguous, because the first may have landed it', async () => {
    const provider = two(
      fake({ submitTx: vi.fn(async () => Promise.reject(BLOCKFROST_TRANSIT)) }),
      fake({ submitTx: vi.fn(async () => Promise.reject(BLOCKFROST_REFUSAL)) }),
    );
    await expect(provider.submitTx('84a4')).rejects.toBeInstanceOf(AmbiguousSubmissionError);
  });

  it('reports the first transit failure when every backend fails in transit', async () => {
    const provider = two(
      fake({ submitTx: vi.fn(async () => Promise.reject(BLOCKFROST_TRANSIT)) }),
      fake({ submitTx: vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) }),
    );
    await expect(provider.submitTx('84a4')).rejects.toBe(BLOCKFROST_TRANSIT);
  });
});

describe('reads and the breaker', () => {
  it('falls back on any read failure, and reports the primary’s error when both fail', async () => {
    const primaryError = new Error('blockfrost down');
    const provider = two(
      fake({ getUtxos: vi.fn(async () => Promise.reject(primaryError)) }),
      fake({ getUtxos: vi.fn(async () => [{ txHash: 'k' }] as never) }),
    );
    await expect(provider.getUtxos('addr_test1')).resolves.toEqual([{ txHash: 'k' }]);
    const failing = two(
      fake({ getUtxos: vi.fn(async () => Promise.reject(primaryError)) }),
      fake({ getUtxos: vi.fn(async () => Promise.reject(new Error('koios down'))) }),
    );
    await expect(failing.getUtxos('addr_test1')).rejects.toBe(primaryError);
  });

  it('stops calling a backend whose circuit is open', async () => {
    const breaker = new CircuitBreakerManager({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const primary = fake({ getDatum: vi.fn(async () => Promise.reject(new Error('down'))) });
    const provider = two(primary, fake(), breaker);
    await provider.getDatum('h');
    await provider.getDatum('h');
    expect(primary.getDatum).toHaveBeenCalledOnce();
  });

  it('advertises an optional capability only when the primary has it', () => {
    const provider = two(fake(), fake({ getTreasury: vi.fn(async () => 1n) }));
    expect(provider.getTreasury).toBeUndefined();
    expect(two(fake({ getTreasury: vi.fn(async () => 1n) }), fake()).getTreasury).toBeTypeOf('function');
  });
});

describe('cardanoProvider', () => {
  const config = { blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0', blockfrostProjectId: 'preprodX' };

  it('is plain Blockfrost when no fallback is named, so adopting it changes nothing', () => {
    expect(cardanoProvider(config, {})).not.toBeInstanceOf(FailoverProvider);
    expect(cardanoProvider(config, { [FALLBACK_KOIOS_URL_ENV]: '  ' })).not.toBeInstanceOf(FailoverProvider);
  });

  it('fails over to Koios when one is named', () => {
    expect(cardanoProvider(config, { [FALLBACK_KOIOS_URL_ENV]: 'https://preprod.koios.rest/api/v1' })).toBeInstanceOf(
      FailoverProvider,
    );
  });
});
