// ============================================================================
// Noctis Zone — Midnight Indexer Client (eligibility check #2)
// ============================================================================
//
// Computes a Midnight address's real, current NIGHT balance by querying the
// public indexer directly — genuine third-party verification, not a wallet
// self-report. Uses @midnightntwrk/wallet-sdk-indexer-client's
// `UnshieldedTransactions` subscription (note the unhyphenated scope: this
// is the current `midnightntwrk/midnight-wallet` monorepo package; the older
// hyphenated `@midnight-ntwrk/wallet-sdk-indexer-client` traces to a legacy
// `artifacts` mirror and stops at 1.2.2).
//
// Why a subscription can compute a one-shot balance: the indexer's GraphQL
// schema has no Query field for this at all — only a Subscription. Checked
// the actual resolver source (indexer-api/src/infra/api/v4/subscription/
// unshielded.rs, `make_unshielded_transactions`): opening the subscription
// with `transactionId: 0` genuinely replays the address's full existing
// transaction history first ("streaming events for existing transactions")
// before switching to a live tail. `createdUtxos`/`spentUtxos` in each event
// are already scoped server-side to the queried address (confirmed via
// `get_unshielded_utxos_by_address_created_by_transaction`/`..._spent_...`)
// — no other party's UTXOs from the same transaction leak in.
//
// Termination: the merged `UnshieldedTransactionsProgress` stream reports
// `highestTransactionId` (the highest tx ID known at subscribe time) — but
// since it's merged with the backlog stream, not sequenced after it, a
// progress event can arrive before the backlog catches up to it. We keep
// consuming until we've actually SEEN a transaction whose own `id` reaches
// that watermark, not just until a progress event arrives. A watermark of 0
// with no transaction ever seen means the address has no history at all —
// terminate immediately with balance 0n. This whole pull-and-terminate
// pattern was verified against the real `effect` package with a mocked
// stream (4 cases: normal backlog, out-of-order progress arrival,
// zero-history address, clean stream end) before being used here.
// ============================================================================

import { nativeToken } from '@midnight-ntwrk/ledger-v8';
import { UnshieldedTransactions } from '@midnightntwrk/wallet-sdk-indexer-client';
import { WsSubscriptionClient } from '@midnightntwrk/wallet-sdk-indexer-client/effect';
import { Chunk, Effect, Option, type Scope, Stream } from 'effect';
import NodeWebSocket from 'ws';

// graphql-ws's createClient (used internally by WsSubscriptionClient.layer, which
// exposes no webSocketImpl passthrough of its own — only {url, keepAlive}) falls
// back to the global `WebSocket` when none is passed explicitly. That global is a
// Node built-in only from v22+; this CLI can run under an older configured Node
// binary (confirmed: live's node_binary_path was pinned to a v20 install, which
// has no global WebSocket at all), so polyfill it here rather than depend on the
// host's Node version. Guarded so a real/newer-Node global is never overridden.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = NodeWebSocket;
}

export interface NightBalanceResult {
  /** Atomic NIGHT units, matching the token's on-chain integer denomination. */
  balance: bigint;
  /** Number of transactions processed before reaching the known watermark. */
  transactionsProcessed: number;
}

// WARN fix (2026-07-30, code-quality audit): shapes for the two real
// event variants this module consumes, matching UnshieldedTransactions'
// actual subscription payload (see this file's own header comment for how
// that was confirmed against the real indexer resolver source). Named and
// exported so a test file can build type-checked mock events without
// depending on @midnightntwrk/wallet-sdk-indexer-client's own (larger,
// harder-to-mock) generated types.
export interface UnshieldedUtxoEvent {
  tokenType: string;
  value: string | number | bigint;
  /** Present on created UTXOs; the chain's own view of registration status. */
  registeredForDustGeneration?: boolean;
}
export interface UnshieldedTransactionEvent {
  unshieldedTransactions:
    | {
        type: 'UnshieldedTransactionsProgress';
        highestTransactionId: number;
      }
    | {
        // Real transaction events report their own specific type string, but
        // the consumption loop only ever branches on "is this the Progress
        // variant" — a second concrete literal (rather than a generic
        // `string`, which TS can't discriminate against a specific-literal
        // sibling) is enough to make this a real discriminated union.
        type: 'UnshieldedTransaction';
        createdUtxos: UnshieldedUtxoEvent[];
        spentUtxos: UnshieldedUtxoEvent[];
        transaction: { id: number };
      };
}

/**
 * The real consumption/termination logic, extracted from
 * getUnshieldedNightBalance below so it can be tested against a mock
 * stream without opening a real WebSocket connection (that wiring —
 * UnshieldedTransactions.run + WsSubscriptionClient.layer — stays in the
 * thin wrapper below). See this file's header comment for the full
 * termination-condition rationale (why a subscription can compute a
 * one-shot balance, the highestTransactionId watermark race, the
 * zero-history short-circuit).
 */
export function consumeUnshieldedTransactions(
  stream: Stream.Stream<UnshieldedTransactionEvent, unknown>,
  nightTokenType: string,
): Effect.Effect<NightBalanceResult, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const pull = yield* Stream.toPull(stream);

    let balance = 0n;
    let highestKnownId: number | null = null;
    let sawAnyTransaction = false;
    let transactionsProcessed = 0;
    let caughtUp = false;

    while (!caughtUp) {
      const result = yield* Effect.either(pull);
      if (result._tag === 'Left') {
        // toPull's error channel is Option<E>: None means clean end of
        // stream (shouldn't happen against a real indexer, which streams
        // forever, but must not hang if it does); Some(e) is a real error.
        if (Option.isNone(result.left)) {
          break;
        }
        return yield* Effect.fail(result.left.value);
      }

      for (const event of Chunk.toReadonlyArray(result.right)) {
        const payload = event.unshieldedTransactions;

        if (payload.type === 'UnshieldedTransactionsProgress') {
          highestKnownId = payload.highestTransactionId;
          if (payload.highestTransactionId === 0 && !sawAnyTransaction) {
            caughtUp = true;
          }
          continue;
        }

        transactionsProcessed++;
        sawAnyTransaction = true;

        for (const utxo of payload.createdUtxos) {
          if (utxo.tokenType === nightTokenType) {
            balance += BigInt(utxo.value);
          }
        }
        for (const utxo of payload.spentUtxos) {
          if (utxo.tokenType === nightTokenType) {
            balance -= BigInt(utxo.value);
          }
        }

        const txId = payload.transaction.id;
        if (highestKnownId !== null && txId >= highestKnownId) {
          caughtUp = true;
          break;
        }
      }
    }

    return { balance, transactionsProcessed };
  });
}

/**
 * Query an address's current NIGHT (native token) balance from the public
 * Midnight indexer. `indexerWsUrl` is the indexer's GraphQL WebSocket
 * endpoint (per the indexer's own docs: `wss://<host>:<port>/api/v4/graphql/ws`).
 */
/**
 * The same query for SEVERAL addresses, over ONE provided subscription client.
 *
 * `getUnshieldedNightBalance` below builds its own `WsSubscriptionClient.layer`
 * per call, so reading eleven wallets one at a time opened eleven connections
 * from eleven processes. The addresses are still read sequentially here — the
 * indexer subscription is per-address — but the connection, the process and
 * the WASM initialisation behind `nativeToken()` are paid for once.
 *
 * Returns results positionally, so the caller can pair them back with whatever
 * it derived the addresses from.
 */
export async function getUnshieldedNightBalances(
  indexerWsUrl: string,
  addresses: readonly string[],
  tokenTypeHex?: string,
): Promise<NightBalanceResult[]> {
  if (addresses.length === 0) {
    return [];
  }
  const nightTokenType = tokenTypeHex ?? nativeToken().raw;
  return Effect.runPromise(
    Effect.scoped(
      Effect.forEach(
        addresses,
        (address) =>
          consumeUnshieldedTransactions(
            UnshieldedTransactions.run({ address, transactionId: 0 }) as unknown as Stream.Stream<
              UnshieldedTransactionEvent,
              unknown
            >,
            nightTokenType,
          ),
        // Sequential deliberately: the indexer replays an address's whole
        // history, and running eleven of those at once against a shared public
        // endpoint trades a server-side problem for a client-side one.
        { concurrency: 1 },
      ).pipe(Effect.provide(WsSubscriptionClient.layer({ url: indexerWsUrl }))),
    ),
  );
}

export async function getUnshieldedNightBalance(
  indexerWsUrl: string,
  address: string,
  tokenTypeHex?: string,
): Promise<NightBalanceResult> {
  // Defaults to NIGHT so every existing caller keeps its behaviour. A bond
  // denominated in a bridged stablecoin passes that asset's colour instead —
  // the filter below is a plain equality test and never cared which colour it
  // was given.
  const nightTokenType = tokenTypeHex ?? nativeToken().raw;
  const stream = UnshieldedTransactions.run({
    address,
    transactionId: 0,
  }) as unknown as Stream.Stream<UnshieldedTransactionEvent, unknown>;

  return Effect.runPromise(
    Effect.scoped(
      consumeUnshieldedTransactions(stream, nightTokenType).pipe(
        Effect.provide(WsSubscriptionClient.layer({ url: indexerWsUrl })),
      ),
    ),
  );
}

/** One address's DUST-generation registration state, as the CHAIN reports it. */
export interface UnshieldedRegistrationState {
  /** True when the address holds an unspent NIGHT UTXO already registered. */
  registered: boolean;
  createdNightUtxos: number;
  spentNightUtxos: number;
}

/**
 * Ask the indexer whether this address's NIGHT is already registered for DUST
 * generation.
 *
 * Do NOT infer this from a wallet's `availableCoins`. A short-lived facade
 * serves the ORIGINAL, ALREADY-SPENT UTXO because its unshielded sub-wallet
 * never syncs far enough to see the spend — so a caller that trusts it will
 * re-register an already-registered wallet, get 173
 * (InsufficientDustForRegistrationFee, the allowance having been consumed by
 * the registration that succeeded), and on repetition earn a 1012 ban.
 *
 * Registration ROTATES the UTXO: the original is spent and a replacement is
 * created carrying `registeredForDustGeneration = true`. That pair is the
 * evidence this reads.
 */
export async function getUnshieldedRegistrationState(
  indexerWsUrl: string,
  address: string,
): Promise<UnshieldedRegistrationState> {
  const nightTokenType = nativeToken().raw;
  const stream = UnshieldedTransactions.run({ address, transactionId: 0 }) as unknown as Stream.Stream<
    UnshieldedTransactionEvent,
    unknown
  >;

  const program = Effect.gen(function* () {
    const pull = yield* Stream.toPull(stream);
    let watermark: number | null = null;
    let seen = false;
    let caughtUp = false;
    let createdNightUtxos = 0;
    let spentNightUtxos = 0;
    let registered = false;

    while (!caughtUp) {
      const result = yield* Effect.either(pull);
      if (result._tag === 'Left') {
        if (Option.isNone(result.left)) break;
        return yield* Effect.fail(result.left.value);
      }
      for (const event of Chunk.toReadonlyArray(result.right)) {
        const payload = event.unshieldedTransactions;
        if (payload.type === 'UnshieldedTransactionsProgress') {
          watermark = payload.highestTransactionId;
          if (payload.highestTransactionId === 0 && !seen) caughtUp = true;
          continue;
        }
        seen = true;
        for (const utxo of payload.createdUtxos) {
          if (utxo.tokenType !== nightTokenType) continue;
          createdNightUtxos++;
          if ((utxo as { registeredForDustGeneration?: boolean }).registeredForDustGeneration === true) {
            registered = true;
          }
        }
        for (const utxo of payload.spentUtxos) {
          if (utxo.tokenType === nightTokenType) spentNightUtxos++;
        }
        if (watermark !== null && payload.transaction.id >= watermark) {
          caughtUp = true;
          break;
        }
      }
    }
    return { registered, createdNightUtxos, spentNightUtxos };
  });

  return Effect.runPromise(
    Effect.scoped(program.pipe(Effect.provide(WsSubscriptionClient.layer({ url: indexerWsUrl })))),
  );
}
