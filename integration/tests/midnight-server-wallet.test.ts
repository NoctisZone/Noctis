// Tests for midnight-server-wallet.ts — the headless (no browser) server-side
// wallet + WalletProvider/MidnightProvider adapter built from a raw 32-byte
// seed. This file's own header is explicit that it has never been exercised
// against a live network (blocked on unprovisioned infra) — these tests can't
// change that, but they do lock down the two things most likely to silently
// break: `defaultNetworkConfig`'s per-network URLs (a wrong hostname here
// misroutes an entire launch's DUST-fee transactions with no compiler check
// to catch it), and `buildServerWallet`'s wiring through the real
// @midnight-ntwrk/wallet-sdk-* construction chain (HDWallet -> Shielded/
// Unshielded/Dust wallets -> WalletFacade, then the WalletProvider/
// MidnightProvider adapter's balanceTx/submitTx method-chaining) — the same
// "wrong argument order/count won't be caught by tsc" risk class the rest of
// this pass targets. The real SDK packages are mocked; production code is
// untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectAccountFn = vi.fn();
const selectRolesFn = vi.fn();
const deriveKeysAtFn = vi.fn();
const hdClearFn = vi.fn();
const hdFromSeedFn = vi.fn();

vi.mock('@midnight-ntwrk/wallet-sdk-hd', () => ({
  HDWallet: { fromSeed: (...a: unknown[]) => hdFromSeedFn(...a) },
  Roles: {
    Zswap: 'ROLE_ZSWAP',
    NightExternal: 'ROLE_NIGHT_EXTERNAL',
    Dust: 'ROLE_DUST',
  },
}));

const walletFacadeInitFn = vi.fn();

vi.mock('@midnight-ntwrk/wallet-sdk-facade', () => ({
  WalletFacade: { init: (...a: unknown[]) => walletFacadeInitFn(...a) },
  WalletEntrySchema: {},
}));

const shieldedStartWithSecretKeysFn = vi.fn();
vi.mock('@midnight-ntwrk/wallet-sdk-shielded', () => ({
  ShieldedWallet: vi.fn(() => ({
    startWithSecretKeys: (...a: unknown[]) => shieldedStartWithSecretKeysFn(...a),
  })),
}));

const unshieldedStartWithPublicKeyFn = vi.fn();
const createKeystoreFn = vi.fn();
const publicKeyFromKeyStoreFn = vi.fn();
vi.mock('@midnight-ntwrk/wallet-sdk-unshielded-wallet', () => ({
  UnshieldedWallet: vi.fn(() => ({
    startWithPublicKey: (...a: unknown[]) => unshieldedStartWithPublicKeyFn(...a),
  })),
  createKeystore: (...a: unknown[]) => createKeystoreFn(...a),
  PublicKey: {
    fromKeyStore: (...a: unknown[]) => publicKeyFromKeyStoreFn(...a),
  },
}));

const dustStartWithSecretKeyFn = vi.fn();
vi.mock('@midnight-ntwrk/wallet-sdk-dust-wallet', () => ({
  DustWallet: vi.fn(() => ({
    startWithSecretKey: (...a: unknown[]) => dustStartWithSecretKeyFn(...a),
  })),
}));

vi.mock('@midnight-ntwrk/wallet-sdk-abstractions', () => ({
  InMemoryTransactionHistoryStorage: vi.fn(function (this: unknown) {
    return this;
  }),
}));

const zswapFromSeedFn = vi.fn();
const dustSecretFromSeedFn = vi.fn();
const initialParametersFn = vi.fn();
vi.mock('@midnight-ntwrk/ledger-v8', () => ({
  ZswapSecretKeys: { fromSeed: (...a: unknown[]) => zswapFromSeedFn(...a) },
  DustSecretKey: { fromSeed: (...a: unknown[]) => dustSecretFromSeedFn(...a) },
  LedgerParameters: {
    initialParameters: (...a: unknown[]) => initialParametersFn(...a),
  },
}));

import {
  assertProofServerReachable,
  buildServerWallet,
  defaultNetworkConfig,
  resolveNetworkConfig,
  type ServerWalletNetworkConfig,
  snapshotOptionsFrom,
  submitWithReconnect,
} from '../midnight-server-wallet.js';

// ============================================================================
// defaultNetworkConfig
// ============================================================================

describe('defaultNetworkConfig', () => {
  it('undeployed: local devnet ws:// relay + http indexer on port 8088', () => {
    expect(defaultNetworkConfig('undeployed', 'http://localhost:6300')).toEqual({
      network: 'undeployed',
      relayUrl: 'ws://localhost:9944',
      provingServerUrl: 'http://localhost:6300',
      indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
      indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
    });
  });

  it('preprod: real hosted wss:// relay + https indexer', () => {
    expect(defaultNetworkConfig('preprod', 'https://prover.example')).toEqual({
      network: 'preprod',
      relayUrl: 'wss://rpc.preprod.midnight.network',
      provingServerUrl: 'https://prover.example',
      indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v3/graphql',
      indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
    });
  });

  it('preview: real hosted wss:// relay + https indexer', () => {
    expect(defaultNetworkConfig('preview', 'https://prover.example')).toEqual({
      network: 'preview',
      relayUrl: 'wss://rpc.preview.midnight.network',
      provingServerUrl: 'https://prover.example',
      indexerHttpUrl: 'https://indexer.preview.midnight.network/api/v3/graphql',
      indexerWsUrl: 'wss://indexer.preview.midnight.network/api/v3/graphql/ws',
    });
  });

  it('preprod and preview do not share the same hostnames (regression guard against a copy-paste mixup)', () => {
    const preprod = defaultNetworkConfig('preprod', 'https://p');
    const preview = defaultNetworkConfig('preview', 'https://p');
    expect(preprod.relayUrl).not.toBe(preview.relayUrl);
    expect(preprod.indexerHttpUrl).not.toBe(preview.indexerHttpUrl);
  });

  it('mainnet throws rather than guessing an unconfirmed hostname', () => {
    expect(() => defaultNetworkConfig('mainnet', 'https://prover.example')).toThrow(/No confirmed mainnet/);
  });
});

// ============================================================================
// resolveNetworkConfig
// ============================================================================

describe('resolveNetworkConfig', () => {
  const bf = {
    indexerHttpUrl: 'https://midnight-preprod.blockfrost.io/api/v0?project_id=k',
    indexerWsUrl: 'wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=k',
  };

  it("is the network's defaults when nothing is named", () => {
    expect(resolveNetworkConfig('preprod', 'https://p')).toEqual(defaultNetworkConfig('preprod', 'https://p'));
    expect(resolveNetworkConfig('preprod', 'https://p', {})).toEqual(defaultNetworkConfig('preprod', 'https://p'));
  });

  it('takes a named indexer and keeps the default relay', () => {
    expect(resolveNetworkConfig('preprod', 'https://p', bf)).toEqual({
      network: 'preprod',
      relayUrl: 'wss://rpc.preprod.midnight.network',
      provingServerUrl: 'https://p',
      indexerHttpUrl: bf.indexerHttpUrl,
      indexerWsUrl: bf.indexerWsUrl,
    });
  });

  it('treats an empty string as not named, so a blank payload field cannot blank an endpoint', () => {
    expect(resolveNetworkConfig('preprod', 'https://p', { indexerHttpUrl: '', relayUrl: '' }).indexerHttpUrl).toBe(
      'https://indexer.preprod.midnight.network/api/v3/graphql',
    );
  });

  it('carries no fields beyond the config itself, whatever else the input holds', () => {
    const input = { ...bf, network: 'preprod', walletSeedHex: 'ab'.repeat(32) };
    expect(Object.keys(resolveNetworkConfig('preprod', 'https://p', input)).sort()).toEqual(
      ['indexerHttpUrl', 'indexerWsUrl', 'network', 'provingServerUrl', 'relayUrl'].sort(),
    );
  });

  it('on mainnet needs all three named, and works once they are', () => {
    expect(() => resolveNetworkConfig('mainnet', 'https://p', bf)).toThrow(/must be supplied explicitly/);
    const all = { ...bf, relayUrl: 'wss://rpc.example' };
    expect(resolveNetworkConfig('mainnet', 'https://p', all).relayUrl).toBe('wss://rpc.example');
  });
});

// ============================================================================
// buildServerWallet
// ============================================================================

function fakeConfig(network: ServerWalletNetworkConfig['network'] = 'undeployed'): ServerWalletNetworkConfig {
  return {
    network,
    relayUrl: 'ws://localhost:9944',
    provingServerUrl: 'http://localhost:6300',
    indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
    indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
  };
}

const FAKE_ZSWAP_SK = { __tag: 'zswap-sk' };
const FAKE_DUST_SK = { __tag: 'dust-sk' };
const FAKE_KEYSTORE = {
  signData: vi.fn().mockResolvedValue('signature-bytes'),
};
const FAKE_PUBLIC_KEY = { __tag: 'unshielded-pubkey' };

function stubHdChain(derivationResult: unknown) {
  const hdWallet = { clear: hdClearFn, selectAccount: selectAccountFn };
  selectAccountFn.mockReturnValue({ selectRoles: selectRolesFn });
  selectRolesFn.mockReturnValue({ deriveKeysAt: deriveKeysAtFn });
  deriveKeysAtFn.mockReturnValue(derivationResult);
  hdFromSeedFn.mockReturnValue({ type: 'seedOk', hdWallet });
}

const FAKE_STATE = {
  shielded: {
    coinPublicKey: { toHexString: () => 'coin-pk-hex' },
    encryptionPublicKey: { toHexString: () => 'enc-pk-hex' },
  },
};

/**
 * Minimal stand-in for the facade's state observable. buildServerWallet takes
 * the FIRST emitted state rather than a fully synced one, so this emits once
 * and hands back an unsubscribe — enough to exercise the real subscribe path.
 */
function fakeStateObservable(state: unknown = FAKE_STATE) {
  return {
    subscribe: ({ next }: { next: (s: unknown) => void; error?: (e: unknown) => void }) => {
      next(state);
      return { unsubscribe: vi.fn() };
    },
  };
}

function makeFakeFacade() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    state: vi.fn(() => fakeStateObservable()),
    waitForSyncedState: vi.fn().mockResolvedValue(FAKE_STATE),
    balanceUnboundTransaction: vi.fn().mockResolvedValue('recipe-1'),
    signRecipe: vi.fn().mockResolvedValue('signed-recipe-1'),
    finalizeRecipe: vi.fn().mockResolvedValue('finalized-tx-1'),
    submitTransaction: vi.fn().mockResolvedValue('txhash-1'),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  zswapFromSeedFn.mockReturnValue(FAKE_ZSWAP_SK);
  dustSecretFromSeedFn.mockReturnValue(FAKE_DUST_SK);
  initialParametersFn.mockReturnValue({ dust: 'dust-ledger-params' });
  createKeystoreFn.mockReturnValue(FAKE_KEYSTORE);
  publicKeyFromKeyStoreFn.mockReturnValue(FAKE_PUBLIC_KEY);
  shieldedStartWithSecretKeysFn.mockReturnValue('shielded-instance');
  unshieldedStartWithPublicKeyFn.mockReturnValue('unshielded-instance');
  dustStartWithSecretKeyFn.mockReturnValue('dust-instance');
});

describe('buildServerWallet — seed/derivation error handling', () => {
  it('throws when HDWallet.fromSeed does not report seedOk, and never proceeds to WalletFacade.init', async () => {
    hdFromSeedFn.mockReturnValue({ type: 'invalidSeed', reason: 'too short' });
    await expect(buildServerWallet(new Uint8Array(32), fakeConfig())).rejects.toThrow(/invalid seed/);
    expect(walletFacadeInitFn).not.toHaveBeenCalled();
  });

  it('throws when key derivation does not report keysDerived, after calling hdWallet.clear()', async () => {
    stubHdChain({ type: 'derivationFailed' });
    await expect(buildServerWallet(new Uint8Array(32), fakeConfig())).rejects.toThrow(/key derivation failed/);
    expect(hdClearFn).toHaveBeenCalledTimes(1);
    expect(walletFacadeInitFn).not.toHaveBeenCalled();
  });
});

describe('buildServerWallet — happy path wiring', () => {
  it('derives with selectAccount(0) and exactly the three required roles', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: {
        ROLE_ZSWAP: 'zswap-seed',
        ROLE_NIGHT_EXTERNAL: 'night-seed',
        ROLE_DUST: 'dust-seed',
      },
    });
    walletFacadeInitFn.mockResolvedValue(makeFakeFacade());

    await buildServerWallet(new Uint8Array(32), fakeConfig('undeployed'));

    expect(selectAccountFn).toHaveBeenCalledWith(0);
    expect(selectRolesFn).toHaveBeenCalledWith(['ROLE_ZSWAP', 'ROLE_NIGHT_EXTERNAL', 'ROLE_DUST']);
    expect(deriveKeysAtFn).toHaveBeenCalledWith(0);
  });

  it('derives shielded/dust secret keys and the unshielded keystore from the correct per-role seed', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: {
        ROLE_ZSWAP: 'zswap-seed',
        ROLE_NIGHT_EXTERNAL: 'night-seed',
        ROLE_DUST: 'dust-seed',
      },
    });
    walletFacadeInitFn.mockResolvedValue(makeFakeFacade());

    await buildServerWallet(new Uint8Array(32), fakeConfig('preprod'));

    expect(zswapFromSeedFn).toHaveBeenCalledWith('zswap-seed');
    expect(dustSecretFromSeedFn).toHaveBeenCalledWith('dust-seed');
    expect(createKeystoreFn).toHaveBeenCalledWith('night-seed', 'preprod');
  });

  it('scales the fee margin by network but floors the fee on every network', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    walletFacadeInitFn.mockResolvedValue(makeFakeFacade());

    await buildServerWallet(new Uint8Array(32), fakeConfig('undeployed'));
    const undeployedCall = walletFacadeInitFn.mock.calls[0][0];
    expect(undeployedCall.configuration.costParameters).toEqual({
      feeBlocksMargin: 5,
      additionalFeeOverhead: 1_000_000n,
    });

    vi.clearAllMocks();
    zswapFromSeedFn.mockReturnValue(FAKE_ZSWAP_SK);
    dustSecretFromSeedFn.mockReturnValue(FAKE_DUST_SK);
    initialParametersFn.mockReturnValue({ dust: 'dust-ledger-params' });
    createKeystoreFn.mockReturnValue(FAKE_KEYSTORE);
    publicKeyFromKeyStoreFn.mockReturnValue(FAKE_PUBLIC_KEY);
    shieldedStartWithSecretKeysFn.mockReturnValue('shielded-instance');
    unshieldedStartWithPublicKeyFn.mockReturnValue('unshielded-instance');
    dustStartWithSecretKeyFn.mockReturnValue('dust-instance');
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    walletFacadeInitFn.mockResolvedValue(makeFakeFacade());

    await buildServerWallet(new Uint8Array(32), fakeConfig('preprod'));
    const preprodCall = walletFacadeInitFn.mock.calls[0][0];
    // A real network gets a SMALL margin, because the margin is an exponent:
    // the ledger's own feesWithMargin warns how easily it becomes unreasonable,
    // and a generous one prices a large transaction past what a block can hold.
    // The devnet keeps the larger value — its fee rate is effectively zero, so
    // the margin costs nothing there.
    //
    // The overhead is NOT devnet-only, and this assertion is the guard on that.
    // It is an additive floor keeping the computed fee off zero, and a fee of
    // zero builds an empty DustActions that the ledger rejects as 117. An idle
    // testnet computes zero exactly as a fresh devnet does — observed on
    // Preprod, mid-run, on a circuit that had submitted fine hours earlier.
    expect(preprodCall.configuration.costParameters).toEqual({
      feeBlocksMargin: 1,
      additionalFeeOverhead: 1_000_000n,
    });
  });

  it('lets a caller override the fee margin', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    walletFacadeInitFn.mockResolvedValue(makeFakeFacade());

    await buildServerWallet(new Uint8Array(32), { ...fakeConfig('preprod'), feeBlocksMargin: 3 });
    // The override moves the margin only. The fee floor is not a tuning knob —
    // a caller lowering the margin must not be able to reintroduce a zero fee.
    expect(walletFacadeInitFn.mock.calls[0][0].configuration.costParameters).toEqual({
      feeBlocksMargin: 3,
      additionalFeeOverhead: 1_000_000n,
    });
  });

  it('builds relayURL/provingServerUrl as real URL objects and passes through indexer endpoints', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    walletFacadeInitFn.mockResolvedValue(makeFakeFacade());
    const config = fakeConfig('preview');

    await buildServerWallet(new Uint8Array(32), config);

    const call = walletFacadeInitFn.mock.calls[0][0];
    expect(call.configuration.relayURL).toBeInstanceOf(URL);
    expect(call.configuration.relayURL.toString()).toBe(new URL(config.relayUrl).toString());
    expect(call.configuration.provingServerUrl).toBeInstanceOf(URL);
    expect(call.configuration.provingServerUrl.toString()).toBe(new URL(config.provingServerUrl).toString());
    expect(call.configuration.indexerClientConnection).toEqual({
      indexerHttpUrl: config.indexerHttpUrl,
      indexerWsUrl: config.indexerWsUrl,
    });
  });

  it('wires shielded/unshielded/dust wallet factories to the correct secret keys, and calls facade.start with the shielded+dust secret keys', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    const facade = makeFakeFacade();
    walletFacadeInitFn.mockResolvedValue(facade);

    await buildServerWallet(new Uint8Array(32), fakeConfig('undeployed'));

    const call = walletFacadeInitFn.mock.calls[0][0];
    // Exercise the passed factory functions the same way WalletFacade.init would.
    expect(call.shielded({})).toBe('shielded-instance');
    expect(shieldedStartWithSecretKeysFn).toHaveBeenCalledWith(FAKE_ZSWAP_SK);

    expect(call.unshielded({})).toBe('unshielded-instance');
    expect(publicKeyFromKeyStoreFn).toHaveBeenCalledWith(FAKE_KEYSTORE);
    expect(unshieldedStartWithPublicKeyFn).toHaveBeenCalledWith(FAKE_PUBLIC_KEY);

    expect(call.dust({})).toBe('dust-instance');
    expect(dustStartWithSecretKeyFn).toHaveBeenCalledWith(FAKE_DUST_SK, 'dust-ledger-params');

    expect(facade.start).toHaveBeenCalledWith(FAKE_ZSWAP_SK, FAKE_DUST_SK);
  });

  it('returns walletProvider and midnightProvider as the SAME adapter instance, with the real facade and a working shutdown()', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    const facade = makeFakeFacade();
    walletFacadeInitFn.mockResolvedValue(facade);

    const result = await buildServerWallet(new Uint8Array(32), fakeConfig());

    expect(result.walletProvider).toBe(result.midnightProvider);
    expect(result.facade).toBe(facade);
    await result.shutdown();
    expect(facade.stop).toHaveBeenCalledTimes(1);
  });

  it('takes the first emitted state and never waits for a fully synced one', async () => {
    // The dust sub-wallet does not reach the chain tip on preprod in workable
    // time or memory, so waiting for a full sync here means never returning.
    // This asserts the absence of that call, because nothing else would: the
    // wallet builds fine either way against a mock that resolves both.
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    const facade = makeFakeFacade();
    walletFacadeInitFn.mockResolvedValue(facade);

    await buildServerWallet(new Uint8Array(32), fakeConfig('undeployed'));

    expect(facade.state).toHaveBeenCalled();
    expect(facade.waitForSyncedState).not.toHaveBeenCalled();
  });

  it('getCoinPublicKey/getEncryptionPublicKey return the hex strings from the first emitted state', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    walletFacadeInitFn.mockResolvedValue(makeFakeFacade());

    const result = await buildServerWallet(new Uint8Array(32), fakeConfig());

    expect(result.walletProvider.getCoinPublicKey()).toBe('coin-pk-hex');
    expect(result.walletProvider.getEncryptionPublicKey()).toBe('enc-pk-hex');
  });
});

describe('buildServerWallet — ServerWalletProvider.balanceTx / submitTx', () => {
  it('balanceTx chains balanceUnboundTransaction -> signRecipe -> finalizeRecipe with the given ttl', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    const facade = makeFakeFacade();
    walletFacadeInitFn.mockResolvedValue(facade);
    const result = await buildServerWallet(new Uint8Array(32), fakeConfig());

    const ttl = new Date('2030-01-01T00:00:00Z');
    const finalized = await result.walletProvider.balanceTx('unbound-tx-1' as never, ttl);

    expect(facade.balanceUnboundTransaction).toHaveBeenCalledWith(
      'unbound-tx-1',
      { shieldedSecretKeys: FAKE_ZSWAP_SK, dustSecretKey: FAKE_DUST_SK },
      { ttl },
    );
    expect(facade.signRecipe).toHaveBeenCalledWith('recipe-1', expect.any(Function));
    expect(facade.finalizeRecipe).toHaveBeenCalledWith('signed-recipe-1');
    expect(finalized).toBe('finalized-tx-1');
  });

  it('balanceTx defaults ttl to roughly 1 hour from now when omitted', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    const facade = makeFakeFacade();
    walletFacadeInitFn.mockResolvedValue(facade);
    const result = await buildServerWallet(new Uint8Array(32), fakeConfig());

    const before = Date.now();
    await result.walletProvider.balanceTx('unbound-tx-1' as never);
    const after = Date.now();

    const optsArg = facade.balanceUnboundTransaction.mock.calls[0][2] as {
      ttl: Date;
    };
    const ttlMs = optsArg.ttl.getTime();
    expect(ttlMs).toBeGreaterThanOrEqual(before + 3_600_000 - 1000);
    expect(ttlMs).toBeLessThanOrEqual(after + 3_600_000 + 1000);
  });

  it("balanceTx's signRecipe callback delegates to the unshielded keystore's signData", async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    const facade = makeFakeFacade();
    walletFacadeInitFn.mockResolvedValue(facade);
    const result = await buildServerWallet(new Uint8Array(32), fakeConfig());

    await result.walletProvider.balanceTx('unbound-tx-1' as never);
    const signCallback = facade.signRecipe.mock.calls[0][1] as (payload: Uint8Array) => Promise<unknown>;
    const payload = new Uint8Array([1, 2, 3]);
    await signCallback(payload);

    expect(FAKE_KEYSTORE.signData).toHaveBeenCalledWith(payload);
  });

  it('submitTx calls facade.submitTransaction with the given finalized tx and returns its hash', async () => {
    stubHdChain({
      type: 'keysDerived',
      keys: { ROLE_ZSWAP: 'a', ROLE_NIGHT_EXTERNAL: 'b', ROLE_DUST: 'c' },
    });
    const facade = makeFakeFacade();
    walletFacadeInitFn.mockResolvedValue(facade);
    const result = await buildServerWallet(new Uint8Array(32), fakeConfig());

    const txHash = await result.midnightProvider.submitTx('finalized-tx-x' as never);

    expect(facade.submitTransaction).toHaveBeenCalledWith('finalized-tx-x');
    expect(txHash).toBe('txhash-1');
  });
});

describe('submitWithReconnect', () => {
  const noSleep = async () => {};

  it('returns the hash when the first attempt works', async () => {
    const submit = vi.fn().mockResolvedValue('0xabc');
    await expect(submitWithReconnect(submit, 'tx', { sleep: noSleep })).resolves.toBe('0xabc');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('tries again when the connection was lost', async () => {
    // The case this exists for: proving outlasts the node's idle timeout, so
    // the first submission after a long proof meets a closed socket.
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('disconnected from wss://rpc.preprod.midnight.network/: 1000:: Normal Closure'))
      .mockResolvedValue('0xdef');
    await expect(submitWithReconnect(submit, 'tx', { sleep: noSleep })).resolves.toBe('0xdef');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('does not retry a transaction the node refused', async () => {
    // A refusal is a verdict, not a hiccup — repeating it wastes a fee window
    // and hides the real reason behind an attempt count.
    const submit = vi.fn().mockRejectedValue(new Error('Invalid Transaction: BadProof'));
    await expect(submitWithReconnect(submit, 'tx', { sleep: noSleep })).rejects.toThrow(/BadProof/);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last attempt and reports the real error', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('Transport error (POST /prove)'));
    await expect(submitWithReconnect(submit, 'tx', { attempts: 3, sleep: noSleep })).rejects.toThrow(/Transport error/);
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it('waits between attempts, so the provider has time to reconnect', async () => {
    const waited: number[] = [];
    const submit = vi.fn().mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue('0x1');
    await submitWithReconnect(submit, 'tx', {
      delayMs: 3_000,
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    expect(waited).toEqual([3_000]);
  });

  it('recognises a lost connection reported through a cause', async () => {
    const err = new Error('Transaction submission failed');
    (err as { cause?: unknown }).cause = new Error('disconnected from wss://rpc: 1000:: Normal Closure');
    const submit = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('0x2');
    await expect(submitWithReconnect(submit, 'tx', { sleep: noSleep })).resolves.toBe('0x2');
  });
});

describe('assertProofServerReachable', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('passes when the proof server answers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
    await expect(assertProofServerReachable('http://localhost:6310')).resolves.toBeUndefined();
  });

  it('asks the health endpoint, not the root', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as never;
    await assertProofServerReachable('http://localhost:6310');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://localhost:6310/health');
  });

  it('names the server and the cause when it cannot be reached', async () => {
    // The whole point is that this failure is legible. Unreached, it surfaces
    // minutes later as a proving error naming neither.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed')) as never;
    await expect(assertProofServerReachable('http://localhost:6310')).rejects.toThrow(
      /localhost:6310[\s\S]*fetch failed/,
    );
  });

  it('treats a non-OK status as unreachable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as never;
    await expect(assertProofServerReachable('http://localhost:6310')).rejects.toThrow(/503/);
  });

  it('points at the keep-alive, since that is the usual remedy here', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    await expect(assertProofServerReachable('http://localhost:6310')).rejects.toThrow(/wsl-keepalive/);
  });
});

// ============================================================================
// snapshotOptionsFrom
// ============================================================================
// A pure mapper, but the kind that silently loses a field: every value here is
// optional, so dropping one changes behaviour without failing to compile.

describe('snapshotOptionsFrom', () => {
  const BOTH = { snapshotDir: 'C:/snaps', snapshotPassphrase: 'pw' };

  it('returns undefined unless BOTH the directory and the passphrase are given', () => {
    // A directory without the passphrase that wrote it can only produce
    // snapshots nothing can read back, so half the pair is not a partial
    // configuration — it is no configuration.
    expect(snapshotOptionsFrom({}, 'wallet_seed')).toBeUndefined();
    expect(snapshotOptionsFrom({ snapshotDir: 'C:/snaps' }, 'wallet_seed')).toBeUndefined();
    expect(snapshotOptionsFrom({ snapshotPassphrase: 'pw' }, 'wallet_seed')).toBeUndefined();
    expect(snapshotOptionsFrom(BOTH, 'wallet_seed')).toBeDefined();
  });

  it('carries the accountId through', () => {
    expect(snapshotOptionsFrom(BOTH, 'buyer_7')?.accountId).toBe('buyer_7');
  });

  it('lets the caller override the accountId, for CLIs whose paying wallet changes per run', () => {
    // A CLI with ONE paying wallet names it once. A CLI that pays from a
    // different wallet each run cannot, and getting this wrong is not a small
    // cost: a snapshot is fingerprinted to its seed, so asking for another
    // wallet's is rejected by the guard and the wallet replays the whole chain
    // instead — which on a public testnet does not finish. The failure reads as
    // a sync timeout and says nothing about the account name that caused it.
    expect(snapshotOptionsFrom({ ...BOTH, snapshotAccountId: 'buyer_2' }, 'wallet_seed')?.accountId).toBe('buyer_2');
  });

  it('names the overridden account when reporting a restore, not the default', () => {
    // The restore line is the only signal that a snapshot was used at all. If
    // it kept printing the default it would read as a successful resume of the
    // wrong wallet, which is the confusion this whole override exists to end.
    const lines: string[] = [];
    const options = snapshotOptionsFrom({ ...BOTH, snapshotAccountId: 'buyer_2' }, 'wallet_seed', (m) => lines.push(m));
    options?.onRestore?.(['dust']);
    expect(lines).toEqual(['buyer_2: resumed dust from snapshot']);
  });

  it('passes dustColdStart through, so the escape hatch reaches the CLI that needs it', () => {
    // The CLIs that PAY a fee are the ones a stale dust snapshot stops. Dropped
    // here, the flag would be accepted on stdin and quietly do nothing, and the
    // run would fail exactly as it did without it.
    expect(snapshotOptionsFrom({ ...BOTH, dustColdStart: true }, 'wallet_seed')?.dustColdStart).toBe(true);
    expect(snapshotOptionsFrom({ ...BOTH, dustColdStart: false }, 'wallet_seed')?.dustColdStart).toBe(false);
    expect(snapshotOptionsFrom(BOTH, 'wallet_seed')?.dustColdStart).toBeUndefined();
  });

  it('reports which sub-wallets were restored, naming the account', () => {
    const lines: string[] = [];
    const options = snapshotOptionsFrom(BOTH, 'buyer_3', (message) => lines.push(message));
    options?.onRestore?.(['shielded', 'dust']);
    expect(lines).toEqual(['buyer_3: resumed shielded, dust from snapshot']);
  });
});
