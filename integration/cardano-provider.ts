// ============================================================================
// The Cardano provider every server-side Lucid submitter builds on
// ============================================================================
// One constructor for the provider a submitter hands to `Lucid(...)`. With
// nothing configured it returns exactly the Blockfrost provider every
// submitter built for itself before, so adopting it changes no behaviour.
// With a second backend named it returns a FAILOVER provider: reads and
// submission try Blockfrost first and Koios second, behind the same circuit
// breaker the read router uses (chain-provider-router.ts).
//
// The second backend is named by environment, not by each CLI's input:
// `NP_CARDANO_FALLBACK_KOIOS_URL` (and `NP_CARDANO_FALLBACK_KOIOS_TOKEN` when
// the Koios tier needs one). Every submitter reads it here, so turning it on is
// one setting on the process that spawns the CLIs rather than a new field on
// twenty input shapes. Browser widgets do not use this module.
//
// SUBMISSION IS NOT A READ, and the rules for it are the point of the module.
// The pattern is ODATANO's (`srv/blockchain/cardano-client.ts`), with one
// deliberate difference noted below:
//   - A ledger REFUSAL is final. Another backend submits to the same ledger,
//     which refuses the same transaction for the same reason. Blockfrost
//     returns the node's own message on a 400, and that is what marks it.
//   - Anything that is not a refusal — a rate limit, a 5xx, a network failure,
//     Blockfrost's bare "Could not submit transaction." — tries the next
//     backend. ODATANO treats every 4xx as final, which makes a Blockfrost 429
//     final too; a rate limit says nothing about the transaction, so here it
//     moves on.
//   - "Already submitted / already in the mempool" is SUCCESS: the
//     transaction is on its way, and the caller gets its hash.
//   - A refusal from the SECOND backend after the first failed in transit is
//     reported as ambiguous rather than as a refusal: the first backend may
//     have accepted the transaction before its connection dropped, in which
//     case the second sees its own inputs already spent. The chain decides.
// ============================================================================

import { Blockfrost, CML, Koios, type Provider } from '@lucid-evolution/lucid';
import {
  AmbiguousSubmissionError,
  errorText,
  FALLBACK_KOIOS_TOKEN_ENV,
  FALLBACK_KOIOS_URL_ENV,
  isAlreadySubmitted,
} from './cardano-failover-rules.js';
import { CircuitBreakerManager } from './chain-provider-router.js';

// Declared once, in a module free of any chain library, so the Mesh provider
// shares them without importing Lucid. Re-exported so this stays the place
// Lucid submitters and their tests take them from.
export { AmbiguousSubmissionError, FALLBACK_KOIOS_TOKEN_ENV, FALLBACK_KOIOS_URL_ENV, isAlreadySubmitted };

export interface CardanoProviderConfig {
  blockfrostUrl: string;
  /** Optional exactly as Blockfrost's own constructor has it: a proxy URL needs none. */
  blockfrostProjectId?: string;
}

export interface NamedProvider {
  name: string;
  provider: Provider;
}

/**
 * The provider a server-side submitter should hand to `Lucid(...)`.
 *
 * Plain Blockfrost unless `NP_CARDANO_FALLBACK_KOIOS_URL` is set, in which
 * case Blockfrost then Koios. `env` is injectable for tests.
 */
export function cardanoProvider(
  config: CardanoProviderConfig,
  // Guarded because several submitters are also bundled into browser widgets,
  // where there is no `process`; a browser never names a fallback, so it gets
  // plain Blockfrost on the site's proxy URL, exactly as before.
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): Provider {
  const primary = new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId);
  const koiosUrl = env[FALLBACK_KOIOS_URL_ENV]?.trim();
  if (!koiosUrl) return primary;
  const token = env[FALLBACK_KOIOS_TOKEN_ENV]?.trim() || undefined;
  return new FailoverProvider([
    { name: 'blockfrost', provider: primary },
    { name: 'koios', provider: new Koios(koiosUrl, token) },
  ]);
}

/**
 * Whether a failed submission says nothing about the transaction itself —
 * the backend, its quota or the network failed, not the ledger.
 *
 * Blockfrost reports a ledger refusal (HTTP 400) with the node's own message
 * and EVERY other failure with the same bare sentence, which is what makes
 * this decidable from the message alone.
 */
export function isTransitFailure(err: unknown): boolean {
  const text = errorText(err);
  // Blockfrost's bare sentence is matched EXACTLY: a ledger refusal is free
  // text that may contain any word or number, so nothing looser is safe here.
  // Koios wraps EVERY failure, refusals included, in one `KoiosError`, so a
  // Koios refusal reads as transit too; as the last backend that only means
  // its error is reported as a failure rather than as a refusal.
  if (text.trim() === 'Could not submit transaction.') return true;
  return /fetch failed|socket hang up|ECONN(?:RESET|REFUSED)|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Too Many Requests|\bstatus(?: code)?:? (?:429|5\d\d)\b|KoiosError|TimeoutException|request timed out/i.test(
    text,
  );
}

/** The hash of a signed transaction's body, from its CBOR. */
export function txHashOf(txCbor: string): string {
  return CML.hash_transaction(CML.Transaction.from_cbor_hex(txCbor).body()).to_hex();
}

type ReadMethod = Exclude<keyof Provider, 'submitTx'>;

/**
 * Lucid `Provider` over an ordered list of backends.
 *
 * Optional provider capabilities are exposed only when the FIRST backend has
 * them, because Lucid probes for them and takes a different path when present:
 * advertising one the primary lacks would route every call to the fallback.
 */
export class FailoverProvider implements Provider {
  getUtxosWithPolicy?: Provider['getUtxosWithPolicy'];
  getTreasury?: Provider['getTreasury'];
  getRewardAccount?: Provider['getRewardAccount'];
  getTransactionStatus?: Provider['getTransactionStatus'];

  constructor(
    private readonly backends: readonly NamedProvider[],
    private readonly breaker: CircuitBreakerManager = new CircuitBreakerManager(),
    private readonly hashOf: (txCbor: string) => string = txHashOf,
  ) {
    if (backends.length === 0) throw new Error('FailoverProvider needs at least one backend');
    const primary = backends[0].provider;
    if (primary.getUtxosWithPolicy) this.getUtxosWithPolicy = (...a) => this.read('getUtxosWithPolicy', a);
    if (primary.getTreasury) this.getTreasury = (...a) => this.read('getTreasury', a);
    if (primary.getRewardAccount) this.getRewardAccount = (...a) => this.read('getRewardAccount', a);
    if (primary.getTransactionStatus) this.getTransactionStatus = (...a) => this.read('getTransactionStatus', a);
  }

  /**
   * A read tries each backend the breaker allows, in order. Reads are
   * idempotent, so any failure moves on; if every backend fails, the FIRST
   * backend's error is the one reported, since that is the one that names the
   * usual source.
   */
  private async read<M extends ReadMethod>(
    method: M,
    args: unknown[],
  ): Promise<Awaited<ReturnType<NonNullable<Provider[M]>>>> {
    let firstError: unknown;
    let attempted = false;
    for (const { name, provider } of this.backends) {
      const fn = provider[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (!fn || !this.breaker.shouldAttempt(name)) continue;
      attempted = true;
      try {
        const result = await fn.apply(provider, args);
        this.breaker.recordSuccess(name);
        return result as Awaited<ReturnType<NonNullable<Provider[M]>>>;
      } catch (err) {
        this.breaker.recordFailure(name);
        firstError ??= err;
      }
    }
    if (!attempted) throw new Error(`No backend is available for ${String(method)} (all circuits open)`);
    throw firstError;
  }

  async submitTx(tx: string): Promise<string> {
    let transit: unknown;
    for (const { name, provider } of this.backends) {
      if (!this.breaker.shouldAttempt(name)) continue;
      try {
        const hash = await provider.submitTx(tx);
        this.breaker.recordSuccess(name);
        return hash;
      } catch (err) {
        if (isAlreadySubmitted(err)) {
          this.breaker.recordSuccess(name);
          return this.hashOf(tx);
        }
        if (isTransitFailure(err)) {
          this.breaker.recordFailure(name);
          transit ??= err;
          continue;
        }
        // A refusal. Final — but if an earlier backend failed in transit it
        // may have accepted this very transaction, so say so.
        this.breaker.recordSuccess(name);
        throw transit === undefined ? err : new AmbiguousSubmissionError(transit, err);
      }
    }
    throw transit ?? new Error('No backend is available for submitTx (all circuits open)');
  }

  getProtocolParameters(...a: Parameters<Provider['getProtocolParameters']>) {
    return this.read('getProtocolParameters', a);
  }
  getUtxos(...a: Parameters<Provider['getUtxos']>) {
    return this.read('getUtxos', a);
  }
  getUtxosWithUnit(...a: Parameters<Provider['getUtxosWithUnit']>) {
    return this.read('getUtxosWithUnit', a);
  }
  getUtxoByUnit(...a: Parameters<Provider['getUtxoByUnit']>) {
    return this.read('getUtxoByUnit', a);
  }
  getUtxosByOutRef(...a: Parameters<Provider['getUtxosByOutRef']>) {
    return this.read('getUtxosByOutRef', a);
  }
  getDelegation(...a: Parameters<Provider['getDelegation']>) {
    return this.read('getDelegation', a);
  }
  getDatum(...a: Parameters<Provider['getDatum']>) {
    return this.read('getDatum', a);
  }
  awaitTx(...a: Parameters<Provider['awaitTx']>) {
    return this.read('awaitTx', a);
  }
  evaluateTx(...a: Parameters<Provider['evaluateTx']>) {
    return this.read('evaluateTx', a);
  }
}
