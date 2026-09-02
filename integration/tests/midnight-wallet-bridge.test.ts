// Tests for widget/midnight-wallet-bridge.ts — builds the 3
// wallet-derivable ContractProviders fields (walletProvider, midnightProvider,
// publicDataProvider) from an already-connected Midnight wallet. The real
// risk surface here (per the file's own header comments) is a handful of
// easy-to-get-wrong details verified against a real reference implementation:
// the exact 3-argument Transaction.deserialize marker call ('signature',
// 'proof', 'binding' — NOT a class-static reference), the hex<->bytes
// round-trip feeding it, the Lace-wallet quirk requiring an explicit {}
// second argument to balanceUnsealedTransaction, and the onFlowMessage
// set-then-clear-in-finally lifecycle. `connection` (a MidnightConnectedAPI)
// and the two SDK-level dependencies are faked/mocked; production code is
// untouched.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const indexerPublicDataProviderFn = vi.fn();
vi.mock('@midnight-ntwrk/midnight-js-indexer-public-data-provider', () => ({
  indexerPublicDataProvider: (...a: unknown[]) => indexerPublicDataProviderFn(...a),
}));

const transactionDeserializeFn = vi.fn();
vi.mock('@midnight-ntwrk/midnight-js-protocol/ledger', () => ({
  Transaction: {
    deserialize: (...a: unknown[]) => transactionDeserializeFn(...a),
  },
}));

import type { MidnightConnectedAPI } from '../wallet-connection.js';
import { buildMidnightWalletBridge, type MidnightWalletBridgeParams } from '../widget/midnight-wallet-bridge.js';

function fakeTx(serializedBytes: Uint8Array, identifiers: string[] = ['tx-id-1']) {
  return {
    serialize: vi.fn().mockReturnValue(serializedBytes),
    identifiers: vi.fn().mockReturnValue(identifiers),
  };
}

function fakeConnection(overrides: Record<string, unknown> = {}) {
  return {
    getConfiguration: vi.fn().mockResolvedValue({
      indexerUri: 'https://indexer.example/api',
      indexerWsUri: 'wss://indexer.example/ws',
    }),
    balanceUnsealedTransaction: vi.fn().mockResolvedValue({ tx: 'aabbcc' }),
    submitTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MidnightConnectedAPI;
}

function baseParams(overrides: Partial<MidnightWalletBridgeParams> = {}): MidnightWalletBridgeParams {
  return {
    connection: fakeConnection(),
    shieldedCoinPublicKey: 'coin-pk-abc',
    shieldedEncryptionPublicKey: 'enc-pk-abc',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildMidnightWalletBridge — construction', () => {
  it('calls getConfiguration once and returns the reported indexer URIs alongside the three providers', async () => {
    const connection = fakeConnection();
    indexerPublicDataProviderFn.mockReturnValue('fake-public-data-provider');

    const bridge = await buildMidnightWalletBridge(baseParams({ connection }));

    expect(connection.getConfiguration).toHaveBeenCalledTimes(1);
    expect(bridge.indexerUri).toBe('https://indexer.example/api');
    expect(bridge.indexerWsUri).toBe('wss://indexer.example/ws');
    expect(bridge.publicDataProvider).toBe('fake-public-data-provider');
    expect(indexerPublicDataProviderFn).toHaveBeenCalledWith('https://indexer.example/api', 'wss://indexer.example/ws');
  });

  it('walletProvider.getCoinPublicKey/getEncryptionPublicKey return the params passed in, not re-fetched from the wallet', async () => {
    const bridge = await buildMidnightWalletBridge(
      baseParams({
        shieldedCoinPublicKey: 'my-coin-pk',
        shieldedEncryptionPublicKey: 'my-enc-pk',
      }),
    );
    expect(bridge.walletProvider.getCoinPublicKey()).toBe('my-coin-pk');
    expect(bridge.walletProvider.getEncryptionPublicKey()).toBe('my-enc-pk');
  });
});

describe('buildMidnightWalletBridge — walletProvider.balanceTx', () => {
  it('hex-encodes the serialized tx, passes an explicit {} second arg (Lace quirk), and hex-decodes the result before handing it to Transaction.deserialize', async () => {
    const serializedBytes = new Uint8Array([0x00, 0xab, 0xff]);
    const tx = fakeTx(serializedBytes);
    const connection = fakeConnection({
      balanceUnsealedTransaction: vi.fn().mockResolvedValue({ tx: '0102ff' }),
    });
    transactionDeserializeFn.mockReturnValue('finalized-tx-sentinel');

    const bridge = await buildMidnightWalletBridge(baseParams({ connection }));
    const result = await bridge.walletProvider.balanceTx(tx as never);

    expect(connection.balanceUnsealedTransaction).toHaveBeenCalledWith('00abff', {});
    expect(transactionDeserializeFn).toHaveBeenCalledTimes(1);
    const [marker1, marker2, marker3, bytesArg] = transactionDeserializeFn.mock.calls[0];
    expect(marker1).toBe('signature');
    expect(marker2).toBe('proof');
    expect(marker3).toBe('binding');
    expect(Array.from(bytesArg as Uint8Array)).toEqual([0x01, 0x02, 0xff]);
    expect(result).toBe('finalized-tx-sentinel');
  });

  it('accepts a 0x-prefixed result, because a wallet is free to return one', async () => {
    // The two forms have to decode to the same bytes: a prefix taken as data
    // would shift every byte and deserialize garbage, and which form a wallet
    // returns is its own choice rather than something we can require.
    const tx = fakeTx(new Uint8Array([0x00]));
    const connection = fakeConnection({
      balanceUnsealedTransaction: vi.fn().mockResolvedValue({ tx: '0x0102ff' }),
    });
    transactionDeserializeFn.mockReturnValue('finalized-tx-sentinel');

    const bridge = await buildMidnightWalletBridge(baseParams({ connection }));
    await bridge.walletProvider.balanceTx(tx as never);

    const [, , , bytesArg] = transactionDeserializeFn.mock.calls[0];
    expect(Array.from(bytesArg as Uint8Array)).toEqual([0x01, 0x02, 0xff]);
  });

  it('signals onFlowMessage with a signing message, then clears it (finally) on success', async () => {
    const tx = fakeTx(new Uint8Array([0x01]));
    transactionDeserializeFn.mockReturnValue('finalized-tx-sentinel');
    const messages: Array<string | undefined> = [];
    const onFlowMessage = (m: string | undefined) => messages.push(m);

    const bridge = await buildMidnightWalletBridge(baseParams({ onFlowMessage }));
    await bridge.walletProvider.balanceTx(tx as never);

    expect(messages).toEqual(['Signing the transaction with your Midnight wallet...', undefined]);
  });

  it('clears onFlowMessage (finally) even when balanceUnsealedTransaction rejects, and propagates the error', async () => {
    const tx = fakeTx(new Uint8Array([0x01]));
    const boom = new Error('wallet rejected the balance request');
    const connection = fakeConnection({
      balanceUnsealedTransaction: vi.fn().mockRejectedValue(boom),
    });
    const messages: Array<string | undefined> = [];

    const bridge = await buildMidnightWalletBridge(baseParams({ connection, onFlowMessage: (m) => messages.push(m) }));

    await expect(bridge.walletProvider.balanceTx(tx as never)).rejects.toThrow(boom);
    expect(messages).toEqual(['Signing the transaction with your Midnight wallet...', undefined]);
  });

  it('works without an onFlowMessage callback (optional param)', async () => {
    const tx = fakeTx(new Uint8Array([0x01]));
    transactionDeserializeFn.mockReturnValue('finalized-tx-sentinel');
    const bridge = await buildMidnightWalletBridge(baseParams());
    await expect(bridge.walletProvider.balanceTx(tx as never)).resolves.toBe('finalized-tx-sentinel');
  });
});

describe('buildMidnightWalletBridge — midnightProvider.submitTx', () => {
  it("hex-encodes the serialized tx, calls submitTransaction, and returns the tx's own first identifier", async () => {
    const tx = fakeTx(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), ['first-id', 'second-id']);
    const connection = fakeConnection();

    const bridge = await buildMidnightWalletBridge(baseParams({ connection }));
    const txId = await bridge.midnightProvider.submitTx(tx as never);

    expect(connection.submitTransaction).toHaveBeenCalledWith('deadbeef');
    expect(txId).toBe('first-id');
  });

  it('signals onFlowMessage with a submitting message, then clears it (finally) on success', async () => {
    const tx = fakeTx(new Uint8Array([0x01]));
    const messages: Array<string | undefined> = [];

    const bridge = await buildMidnightWalletBridge(baseParams({ onFlowMessage: (m) => messages.push(m) }));
    await bridge.midnightProvider.submitTx(tx as never);

    expect(messages).toEqual(['Submitting transaction...', undefined]);
  });

  it('clears onFlowMessage (finally) even when submitTransaction rejects, and propagates the error', async () => {
    const tx = fakeTx(new Uint8Array([0x01]));
    const boom = new Error('node rejected the transaction');
    const connection = fakeConnection({
      submitTransaction: vi.fn().mockRejectedValue(boom),
    });
    const messages: Array<string | undefined> = [];

    const bridge = await buildMidnightWalletBridge(baseParams({ connection, onFlowMessage: (m) => messages.push(m) }));

    await expect(bridge.midnightProvider.submitTx(tx as never)).rejects.toThrow(boom);
    expect(messages).toEqual(['Submitting transaction...', undefined]);
  });
});

describe('hex encoding round-trip (exercised indirectly via balanceTx/submitTx)', () => {
  it('handles a byte array containing 0x00 without dropping the leading zero nibble', async () => {
    const tx = fakeTx(new Uint8Array([0x00, 0x0f, 0xf0]));
    const connection = fakeConnection();
    const bridge = await buildMidnightWalletBridge(baseParams({ connection }));

    await bridge.midnightProvider.submitTx(tx as never);
    expect(connection.submitTransaction).toHaveBeenCalledWith('000ff0');
  });

  it('decodes an empty-length-adjacent odd-looking but valid hex string back to the exact byte sequence', async () => {
    const tx = fakeTx(new Uint8Array([0x01]));
    const connection = fakeConnection({
      balanceUnsealedTransaction: vi.fn().mockResolvedValue({ tx: '00' }),
    });
    transactionDeserializeFn.mockReturnValue('finalized-tx-sentinel');

    const bridge = await buildMidnightWalletBridge(baseParams({ connection }));
    await bridge.walletProvider.balanceTx(tx as never);

    const bytesArg = transactionDeserializeFn.mock.calls[0][3] as Uint8Array;
    expect(Array.from(bytesArg)).toEqual([0x00]);
  });
});
