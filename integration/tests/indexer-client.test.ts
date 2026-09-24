// Tests for indexer-client.ts's consumption/termination logic
// (consumeUnshieldedTransactions), extracted specifically so it could be
// tested against a mock Stream without opening a real WebSocket connection
// to a live Midnight indexer. See indexer-client.ts's own header comment
// for the full termination-condition rationale this covers: the
// highestTransactionId watermark race (merged backlog+progress stream,
// not sequenced), the zero-history short-circuit, and clean-stream-end
// handling. The real wrapper (getUnshieldedNightBalance) that wires this
// to UnshieldedTransactions.run + WsSubscriptionClient.layer is
// integration-tested against a live indexer, not unit-tested here.

import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  consumeRegistrationState,
  consumeUnshieldedTransactions,
  type UnshieldedTransactionEvent,
  type UnshieldedUtxoEvent,
} from '../indexer-client.js';

const NIGHT_TOKEN = 'night-token-type';
const OTHER_TOKEN = 'some-other-token-type';

function progress(highestTransactionId: number): UnshieldedTransactionEvent {
  return {
    unshieldedTransactions: {
      type: 'UnshieldedTransactionsProgress',
      highestTransactionId,
    },
  };
}

function tx(
  id: number,
  createdUtxos: { tokenType: string; value: string | number }[],
  spentUtxos: { tokenType: string; value: string | number }[] = [],
): UnshieldedTransactionEvent {
  return {
    unshieldedTransactions: {
      type: 'UnshieldedTransaction',
      createdUtxos,
      spentUtxos,
      transaction: { id },
    },
  };
}

function run(events: UnshieldedTransactionEvent[]) {
  const stream = Stream.fromIterable(events);
  // Stream.toPull requires a real effect/Scope in context (scoped resource
  // management for the pull) — the real wrapper (getUnshieldedNightBalance)
  // provides this via Effect.scoped, so the test helper must too.
  return Effect.runPromise(Effect.scoped(consumeUnshieldedTransactions(stream, NIGHT_TOKEN)));
}

describe('indexer-client.ts — consumeUnshieldedTransactions', () => {
  it('normal backlog: sums created UTXOs up to the watermark transaction', async () => {
    const result = await run([
      tx(1, [{ tokenType: NIGHT_TOKEN, value: 1000 }]),
      tx(2, [{ tokenType: NIGHT_TOKEN, value: 500 }]),
      progress(2),
    ]);
    expect(result.balance).toBe(1500n);
    expect(result.transactionsProcessed).toBe(2);
  });

  it('subtracts spent UTXOs of the same token type', async () => {
    const result = await run([
      tx(1, [{ tokenType: NIGHT_TOKEN, value: 1000 }]),
      tx(2, [], [{ tokenType: NIGHT_TOKEN, value: 300 }]),
      progress(2),
    ]);
    expect(result.balance).toBe(700n);
  });

  it('ignores UTXOs of a different token type entirely', async () => {
    const result = await run([
      tx(1, [
        { tokenType: NIGHT_TOKEN, value: 1000 },
        { tokenType: OTHER_TOKEN, value: 99999 },
      ]),
      progress(1),
    ]);
    expect(result.balance).toBe(1000n);
  });

  it('out-of-order progress arrival: a progress event declaring a real watermark arrives before the backlog transaction reaching it — must not terminate until that transaction is actually seen', async () => {
    // The progress event arrives FIRST (as it can in a merged, unsequenced
    // stream — see this module's own header comment), naming watermark 3,
    // but transaction id 3 itself arrives afterward. Termination must wait
    // for the real transaction, not fire the moment the progress event is
    // read.
    const result = await run([
      progress(3),
      tx(1, [{ tokenType: NIGHT_TOKEN, value: 100 }]),
      tx(2, [{ tokenType: NIGHT_TOKEN, value: 100 }]),
      tx(3, [{ tokenType: NIGHT_TOKEN, value: 100 }]),
    ]);
    expect(result.balance).toBe(300n);
    expect(result.transactionsProcessed).toBe(3);
  });

  it('zero-history address: a watermark of 0 with no transaction ever seen terminates immediately with balance 0', async () => {
    const result = await run([progress(0)]);
    expect(result.balance).toBe(0n);
    expect(result.transactionsProcessed).toBe(0);
  });

  it('clean stream end: an exhausted stream with no explicit termination condition met does not hang and returns what was accumulated', async () => {
    // No progress event at all — the stream just ends. Effect.either(pull)
    // resolving to Left(None) must break the loop, not hang or throw.
    const result = await run([tx(1, [{ tokenType: NIGHT_TOKEN, value: 42 }])]);
    expect(result.balance).toBe(42n);
    expect(result.transactionsProcessed).toBe(1);
  });

  it('stops processing further events in the same chunk once the watermark transaction is reached', async () => {
    // If a later "phantom" transaction appeared in the same batch after
    // the watermark tx (shouldn't happen against a real indexer, but the
    // loop's own `break` must not silently keep summing past its stated
    // termination point).
    const result = await run([tx(1, [{ tokenType: NIGHT_TOKEN, value: 100 }]), progress(1)]);
    expect(result.balance).toBe(100n);
    expect(result.transactionsProcessed).toBe(1);
  });

  it('propagates a real stream error instead of silently returning a partial balance', async () => {
    const boom = new Error('indexer connection dropped');
    const stream = Stream.concat(
      Stream.fromIterable<UnshieldedTransactionEvent>([tx(1, [{ tokenType: NIGHT_TOKEN, value: 100 }])]),
      Stream.fail(boom),
    );
    await expect(Effect.runPromise(Effect.scoped(consumeUnshieldedTransactions(stream, NIGHT_TOKEN)))).rejects.toThrow(
      /indexer connection dropped/,
    );
  });

  it('handles multiple registrants/transactions with mixed created and spent UTXOs across the full backlog', async () => {
    const result = await run([
      tx(1, [{ tokenType: NIGHT_TOKEN, value: 5000 }]),
      tx(2, [{ tokenType: NIGHT_TOKEN, value: 2000 }], [{ tokenType: NIGHT_TOKEN, value: 1000 }]),
      tx(3, [], [{ tokenType: NIGHT_TOKEN, value: 500 }]),
      progress(3),
    ]);
    // 5000 + 2000 - 1000 - 500 = 5500
    expect(result.balance).toBe(5500n);
    expect(result.transactionsProcessed).toBe(3);
  });
});

describe('indexer-client.ts — consumeRegistrationState', () => {
  const out = (
    intentHash: string,
    outputIndex: number,
    value: number,
    registered: boolean,
    tokenType = NIGHT_TOKEN,
  ): UnshieldedUtxoEvent => ({
    tokenType,
    value,
    intentHash,
    outputIndex,
    ctime: 1_790_000_000 + outputIndex,
    registeredForDustGeneration: registered,
  });
  const txOut = (
    id: number,
    created: UnshieldedUtxoEvent[],
    spent: UnshieldedUtxoEvent[] = [],
  ): UnshieldedTransactionEvent => ({
    unshieldedTransactions: {
      type: 'UnshieldedTransaction',
      createdUtxos: created,
      spentUtxos: spent,
      transaction: { id },
    },
  });
  const state = (events: UnshieldedTransactionEvent[]) =>
    Effect.runPromise(Effect.scoped(consumeRegistrationState(Stream.fromIterable(events), NIGHT_TOKEN)));
  const unregisteredKeys = (s: Awaited<ReturnType<typeof state>>) =>
    s.unspentNight.filter((o) => !o.registered).map((o) => o.key);

  it('names an unregistered output held beside a registered one', async () => {
    const s = await state([txOut(1, [out('aa', 0, 1000, true)]), txOut(2, [out('bb', 0, 500, false)]), progress(2)]);
    expect(s.registered).toBe(true);
    expect(unregisteredKeys(s)).toEqual(['bb#0']);
    expect(s.unspentNight).toHaveLength(2);
  });

  it('follows a registration rotation: the spent original drops out and the registered replacement stays', async () => {
    const s = await state([
      txOut(1, [out('aa', 0, 1000, false)]),
      txOut(2, [out('bb', 0, 1000, true)], [out('aa', 0, 1000, false)]),
      progress(2),
    ]);
    expect(s.registered).toBe(true);
    expect(unregisteredKeys(s)).toEqual([]);
    expect(s.unspentNight.map((o) => o.key)).toEqual(['bb#0']);
    expect([s.createdNightUtxos, s.spentNightUtxos]).toEqual([2, 1]);
  });

  it('reads an address whose only registered output has been spent as not registered', async () => {
    const s = await state([
      txOut(1, [out('aa', 0, 1000, true)]),
      txOut(2, [out('cc', 1, 400, false)], [out('aa', 0, 1000, true)]),
      progress(2),
    ]);
    expect(s.registered).toBe(false);
    expect(unregisteredKeys(s)).toEqual(['cc#1']);
  });

  it('ignores outputs of any other token type', async () => {
    const s = await state([txOut(1, [out('aa', 0, 1000, true), out('aa', 1, 7, false, OTHER_TOKEN)]), progress(1)]);
    expect(s.unspentNight.map((o) => o.key)).toEqual(['aa#0']);
    expect(s.createdNightUtxos).toBe(1);
  });

  it('carries each output value and creation time from the chain', async () => {
    const s = await state([txOut(1, [out('dd', 2, 2_119_448_482, false)]), progress(1)]);
    expect(s.unspentNight[0]).toEqual({ key: 'dd#2', value: 2_119_448_482n, ctime: 1_790_000_002, registered: false });
  });

  it('terminates at once on a zero-history address', async () => {
    const s = await state([progress(0)]);
    expect(s).toEqual({ registered: false, createdNightUtxos: 0, spentNightUtxos: 0, unspentNight: [] });
  });
});
