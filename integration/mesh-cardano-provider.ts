// ============================================================================
// The Cardano provider every server-side Mesh submitter builds on
// ============================================================================
// The Mesh counterpart of cardano-provider.ts. With nothing configured it
// returns exactly the `BlockfrostProvider` each site built for itself, so
// adopting it changes no behaviour. With `NP_CARDANO_FALLBACK_KOIOS_URL` set —
// the same setting the Lucid submitters read, and the same full base URL, e.g.
// `https://preprod.koios.rest/api/v1` — it returns a FAILOVER provider over
// Mesh's Blockfrost and then Mesh's Koios, behind the read router's circuit
// breaker (chain-provider-router.ts). A browser has no `process`, never names
// a fallback, and keeps plain Blockfrost on the site's proxy URL.
//
// HOW MESH REPORTS A FAILURE. Read from @meshsdk/provider's own source and
// confirmed by pointing both providers at a local server, not assumed:
//   - An HTTP error is thrown as a STRING: the JSON of `{ data, headers,
//     status }`, where `data` is the response body. A 400 from Blockfrost or
//     Koios carries the node's refusal in `data`.
//   - A request that got no response at all — refused, reset, unresolvable —
//     is thrown under Node as `ReferenceError: XMLHttpRequest is not defined`:
//     Mesh's formatter tests for a browser global that Node does not have.
//   - `fetchAddressUTxOs` never throws, on either provider. Every failure
//     comes back as an empty list, so an empty list is the only sign of one.
//
// SUBMISSION follows cardano-provider.ts's rules:
//   - A 400 is a ledger REFUSAL and is final. Another backend submits to the
//     same ledger, which refuses the same transaction for the same reason.
//   - Any other status — a rate limit, a 5xx, a 403 for a bad key, a 425 for a
//     full mempool — and no response at all is TRANSIT: the next backend is
//     tried.
//   - "Already submitted / in the mempool" is success, and the caller gets the
//     transaction's hash.
//   - A refusal from a later backend after an earlier one failed in transit is
//     AmbiguousSubmissionError: the first may have accepted the transaction.
// The status is the error's own `status` field, never a number found in its
// text: a refusal is free text and carries any number, "Coin 500" included.
//
// EVALUATION has no side effect, but it too moves on only in transit. A script
// that fails on one evaluator fails on the next, and Mesh's Koios evaluator
// returns an EMPTY budget list for a 2xx reply that carries no result, so a
// failed evaluation sent on could come back as a transaction built on
// placeholder budgets.
//
// THE FALLBACK IS MADE WHOLE where Mesh's Koios provider falls short of what
// these builds need, each one measured:
//   - Given a URL and no token it sends `Authorization: Bearer undefined`,
//     which Koios answers with a 403 on every request. The header is dropped.
//   - It has no cost models ("Method not implemented"). Mesh's builder then
//     uses its built-in ones, which no longer match Preprod's, and a Plutus
//     spend built on them is refused for a script-integrity mismatch. They are
//     read from Koios's `epoch_params` instead.
//   - It labels a withdrawal's budget WITHDRAW, Ogmios's word, where Mesh's
//     builder looks for REWARD, so a withdraw-zero script would keep its
//     placeholder budget. The tag is renamed.
// ============================================================================

import {
  type Action,
  BlockfrostProvider,
  type IEvaluator,
  type IFetcher,
  type ISubmitter,
  KoiosProvider,
  resolveTxHash,
  type UTxO,
} from '@meshsdk/core';
import {
  AmbiguousSubmissionError,
  errorText,
  FALLBACK_KOIOS_TOKEN_ENV,
  FALLBACK_KOIOS_URL_ENV,
  isAlreadySubmitted,
} from './cardano-failover-rules.js';
import { CircuitBreakerManager } from './chain-provider-router.js';

/** What a Mesh submitter needs from a chain provider: fetch, submit and evaluate. */
export type MeshChainProvider = IFetcher & ISubmitter & IEvaluator;

export interface NamedMeshProvider {
  name: string;
  provider: MeshChainProvider;
}

/**
 * The provider a server-side Mesh submitter should hand to its wallet and
 * builder.
 *
 * `blockfrost` is a project id or a URL; Mesh's own constructor tells the two
 * apart, as it did at every site before. Plain Blockfrost unless
 * `NP_CARDANO_FALLBACK_KOIOS_URL` is set. `env` is injectable for tests.
 */
export function meshCardanoProvider(
  blockfrost: string,
  // Guarded because some of these submitters are also bundled into browser
  // widgets, where there is no `process` and no fallback is ever named.
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): MeshChainProvider {
  const primary = new BlockfrostProvider(blockfrost);
  const koiosUrl = env[FALLBACK_KOIOS_URL_ENV]?.trim();
  if (!koiosUrl) return primary;
  const token = env[FALLBACK_KOIOS_TOKEN_ENV]?.trim() || undefined;
  return new MeshFailoverProvider([
    { name: 'blockfrost', provider: primary },
    { name: 'koios', provider: new MeshKoiosFallback(koiosUrl, token) },
  ]);
}

/** A failure as Mesh threw it: the HTTP status and body when there was a response. */
export interface MeshFailure {
  status?: number;
  /** axios's code for a request that got no response, when Mesh reports one. */
  code?: string;
  body: string;
}

/** Reads what Mesh threw. See this module's header for the shapes. */
export function readMeshFailure(err: unknown): MeshFailure {
  if (typeof err === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(err);
    } catch {
      return { body: err };
    }
    if (parsed !== null && typeof parsed === 'object') {
      const { status, code, data } = parsed as { status?: unknown; code?: unknown; data?: unknown };
      if (typeof status === 'number') {
        return { status, body: typeof data === 'string' ? data : JSON.stringify(data ?? null) };
      }
      if (typeof code === 'string') return { code, body: err };
    }
    return { body: typeof parsed === 'string' ? parsed : err };
  }
  return { body: errorText(err) };
}

/** axios's codes for a request that never got a response. */
const NO_RESPONSE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_NETWORK',
]);

/**
 * Whether a failure says nothing about the transaction itself: the backend,
 * its quota or the network failed, not the ledger.
 *
 * Decided from the failure's shape alone. A response's status is read from its
 * own field; no text is searched for numbers.
 */
export function isMeshTransitFailure(err: unknown): boolean {
  // Mesh's report of a request that got no response, under Node.
  if (err instanceof ReferenceError) return /XMLHttpRequest is not defined/.test(err.message);
  const failure = readMeshFailure(err);
  if (failure.status !== undefined) return failure.status !== 400;
  return failure.code !== undefined && NO_RESPONSE_CODES.has(failure.code);
}

/** Whether a failed submission only says the transaction is already queued or known. */
export function isMeshAlreadySubmitted(err: unknown): boolean {
  return isAlreadySubmitted(readMeshFailure(err).body);
}

/** The axios instance Mesh keeps private, reached only to drop a header Koios refuses. */
function axiosOf(provider: KoiosProvider): { defaults: { headers: Record<string, unknown> } } {
  return (provider as unknown as { _axiosInstance: { defaults: { headers: Record<string, unknown> } } })._axiosInstance;
}

/**
 * Mesh's Koios provider, made whole for the builds that fail over to it. See
 * this module's header for what each difference is for.
 */
export class MeshKoiosFallback extends KoiosProvider {
  constructor(baseUrl: string, token?: string) {
    // Mesh declares no token for the URL form, but its constructor reads one
    // from the second argument and sends it as a bearer token.
    super(...([baseUrl, token] as unknown as [string]));
    if (!token) delete axiosOf(this).defaults.headers.Authorization;
  }

  /**
   * Cost models from Koios's `epoch_params`, in the order Mesh's Blockfrost
   * provider returns them: PlutusV1, V2, V3. With no epoch named, the current
   * one is read from the tip, as Mesh's own protocol-parameter read does.
   */
  override async fetchCostModels(epoch?: number): Promise<number[][]> {
    const epochNo = epoch || ((await this.get('tip')) as Array<{ epoch_no?: number }>)[0]?.epoch_no;
    const rows = (await this.get(`epoch_params?_epoch_no=${epochNo}&select=cost_models`)) as Array<{
      cost_models?: Record<string, unknown>;
    }>;
    const models = rows[0]?.cost_models;
    const lists = [models?.PlutusV1, models?.PlutusV2, models?.PlutusV3];
    if (!lists.every((list): list is number[] => Array.isArray(list) && list.every(Number.isInteger))) {
      throw new Error(`Koios returned no cost models for epoch ${epochNo}.`);
    }
    return lists;
  }

  /** Mesh's Koios evaluation, with a withdrawal tagged as Mesh's builder reads it. */
  override async evaluateTx(
    tx: string,
    additionalUtxos?: UTxO[],
    additionalTxs?: string[],
  ): Promise<Omit<Action, 'data'>[]> {
    const actions = await super.evaluateTx(tx, additionalUtxos, additionalTxs);
    return actions.map((action) =>
      String(action.tag) === 'WITHDRAW' ? { ...action, tag: 'REWARD' as const } : action,
    );
  }
}

/** A read the failover routes; the rest go to the first backend alone. */
type FailoverRead = Exclude<keyof IFetcher, 'get' | 'fetchAddressTxs' | 'fetchGovernanceProposal'>;
type ReadResult<M extends FailoverRead> = Awaited<ReturnType<IFetcher[M]>>;

/**
 * Mesh fetcher, submitter and evaluator over an ordered list of backends.
 *
 * Three reads go to the first backend alone: `get` takes a path in that
 * backend's own API, which means nothing to another; Mesh's Koios answers
 * `fetchAddressTxs` with placeholder records and `fetchGovernanceProposal` not
 * at all. Sending them on would turn a failure into a wrong answer.
 */
export class MeshFailoverProvider implements MeshChainProvider {
  constructor(
    /** In order of preference. Readable for health reporting and tests. */
    readonly backends: readonly NamedMeshProvider[],
    private readonly breaker: CircuitBreakerManager = new CircuitBreakerManager(),
    private readonly hashOf: (txCbor: string) => string = resolveTxHash,
  ) {
    if (backends.length === 0) throw new Error('MeshFailoverProvider needs at least one backend');
  }

  /**
   * Only a backend that failed to answer counts against its circuit. A 404 is
   * an answer — a transaction not indexed yet, say — and a run of them while
   * one is being indexed must not divert submission elsewhere.
   */
  private record(name: string, err: unknown): void {
    if (isMeshTransitFailure(err) && readMeshFailure(err).status !== 404) this.breaker.recordFailure(name);
    else this.breaker.recordSuccess(name);
  }

  /**
   * A read tries each backend the breaker allows, in order. Reads are
   * idempotent, so any failure moves on; if every backend fails, the FIRST
   * backend's error is the one reported.
   *
   * `isEmpty` marks an answer that may be a failure in disguise. An empty
   * answer from a backend that is not the last is asked again of the next one,
   * and returned only if nothing better comes back.
   */
  private async read<M extends FailoverRead>(
    method: M,
    args: unknown[],
    isEmpty?: (result: ReadResult<M>) => boolean,
  ): Promise<ReadResult<M>> {
    let firstError: unknown;
    let attempted = false;
    let empty: { result: ReadResult<M> } | undefined;
    for (const { name, provider } of this.backends) {
      if (!this.breaker.shouldAttempt(name)) continue;
      attempted = true;
      try {
        const fn = provider[method] as (...a: unknown[]) => Promise<ReadResult<M>>;
        const result = await fn.apply(provider, args);
        if (isEmpty?.(result)) {
          // Not recorded either way: an empty answer cannot say whether the
          // backend is up.
          empty ??= { result };
          continue;
        }
        this.breaker.recordSuccess(name);
        return result;
      } catch (err) {
        this.record(name, err);
        firstError ??= err;
      }
    }
    if (empty) return empty.result;
    if (!attempted) throw new Error(`No backend is available for ${method} (all circuits open)`);
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
        if (isMeshAlreadySubmitted(err)) {
          this.breaker.recordSuccess(name);
          return this.hashOf(tx);
        }
        if (isMeshTransitFailure(err)) {
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

  /** Moves on only in transit; see this module's header for why. */
  async evaluateTx(tx: string, additionalUtxos?: UTxO[], additionalTxs?: string[]): Promise<Omit<Action, 'data'>[]> {
    let transit: unknown;
    for (const { name, provider } of this.backends) {
      if (!this.breaker.shouldAttempt(name)) continue;
      try {
        const result = await provider.evaluateTx(tx, additionalUtxos, additionalTxs);
        this.breaker.recordSuccess(name);
        return result;
      } catch (err) {
        this.record(name, err);
        if (!isMeshTransitFailure(err)) throw err;
        transit ??= err;
      }
    }
    throw transit ?? new Error('No backend is available for evaluateTx (all circuits open)');
  }

  fetchAddressUTxOs(...a: Parameters<IFetcher['fetchAddressUTxOs']>) {
    return this.read('fetchAddressUTxOs', a, (utxos) => utxos.length === 0);
  }
  fetchUTxOs(...a: Parameters<IFetcher['fetchUTxOs']>) {
    return this.read('fetchUTxOs', a);
  }
  fetchProtocolParameters(...a: Parameters<IFetcher['fetchProtocolParameters']>) {
    return this.read('fetchProtocolParameters', a);
  }
  fetchCostModels(...a: Parameters<IFetcher['fetchCostModels']>) {
    return this.read('fetchCostModels', a);
  }
  fetchTxInfo(...a: Parameters<IFetcher['fetchTxInfo']>) {
    return this.read('fetchTxInfo', a);
  }
  fetchBlockInfo(...a: Parameters<IFetcher['fetchBlockInfo']>) {
    return this.read('fetchBlockInfo', a);
  }
  fetchAccountInfo(...a: Parameters<IFetcher['fetchAccountInfo']>) {
    return this.read('fetchAccountInfo', a);
  }
  fetchAssetAddresses(...a: Parameters<IFetcher['fetchAssetAddresses']>) {
    return this.read('fetchAssetAddresses', a);
  }
  fetchAssetMetadata(...a: Parameters<IFetcher['fetchAssetMetadata']>) {
    return this.read('fetchAssetMetadata', a);
  }
  fetchCollectionAssets(...a: Parameters<IFetcher['fetchCollectionAssets']>) {
    return this.read('fetchCollectionAssets', a);
  }

  fetchAddressTxs(...a: Parameters<IFetcher['fetchAddressTxs']>) {
    return this.backends[0].provider.fetchAddressTxs(...a);
  }
  fetchGovernanceProposal(...a: Parameters<IFetcher['fetchGovernanceProposal']>) {
    return this.backends[0].provider.fetchGovernanceProposal(...a);
  }
  get(...a: Parameters<IFetcher['get']>) {
    return this.backends[0].provider.get(...a);
  }
}
