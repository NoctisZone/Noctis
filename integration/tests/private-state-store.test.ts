import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { asContractAddress } from '@midnight-ntwrk/midnight-js-types';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  createDarkVeilPrivateStore,
  ephemeralPrivateStatePassword,
  inMemoryLevelFactory,
} from '../private-state-store.js';

// Every test here that builds a store pays for real password-based key
// derivation and real encryption, several times over, and that cost is what
// the file is for -- a mocked provider would prove nothing about the
// guarantee a DarkVeil buyer depends on. So these are slow by construction,
// and the runner's 5s default is sized for trivial unit tests.
//
// MEASURED, on a 32-thread machine, for the slowest test in this file:
//   run alone ................................ ~0.7s
//   inside the full suite (107 files) ........ 1.8s
//   with every core saturated ................ 4.5s
//
// That last figure is 89% of the default, which is why this file produced a
// single unreproducible failure inside one full run and passed on the retry
// and in isolation. Nothing here can fail on its VALUE -- an identity and a
// buy nonce are each a pure hash of a fixed signature and a fixed launch id,
// so the same inputs cannot derive two answers. The only failure available
// to it was running out of time.
//
// A generous ceiling rather than a tuned one: it exists to stop the clock
// being the thing under test, and a real hang still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

// Real password meeting the SDK's actual strength policy (validatePassword:
// 16+ chars, 3+ character classes, no 4+-char runs/sequences, no more than
// 3 consecutive identical chars) -- not a mock, this is what gets fed to the
// real levelPrivateStateProvider/StorageEncryption underneath.
const REAL_PASSWORD = 'Tr0ub4dor&Zebra!9k';
const OTHER_REAL_PASSWORD = 'Qx7$mVenice42Lagoon';

// Fake wallet signatures -- deterministic per "wallet" (128 hex chars, same
// length as a real Ed25519 signature), standing in for what a real
// CIP-8 signCardanoData call would return for a given wallet + fixed
// message. Real Ed25519 signing is deterministic (same key + same message
// -> same signature always), which is the whole property this rework
// depends on -- these fakes just skip an actual wallet round-trip in tests.
const WALLET_A_SIGNATURE = 'aa'.repeat(64);
const WALLET_B_SIGNATURE = 'bb'.repeat(64);

// The shared factory the CLIs use, not a copy of it — a test-only duplicate is
// exactly how the production CLIs came to pass an unmemoized factory while this
// file quietly held the correct one. See its own doc comment for why memoizing
// by dbName is what the provider requires.
const freshMemoryLevelFactory = inMemoryLevelFactory;

function makeStore(accountId: string, walletSignature: string, password = REAL_PASSWORD) {
  const getMasterSignature = vi.fn(async () => walletSignature);
  const store = createDarkVeilPrivateStore({
    accountId,
    passwordProvider: () => password,
    getMasterSignature,
    levelFactory: freshMemoryLevelFactory(),
  });
  return { store, getMasterSignature };
}

describe('private-state-store.ts — deterministic identity derivation (rework, 2026-07-15)', () => {
  it('generates a fresh identity on first use, derived from the wallet signature', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const identity = await store.getOrCreateIdentity();
    expect(identity.userSecretKey.bytes).toBeInstanceOf(Uint8Array);
    expect(identity.userSecretKey.bytes.length).toBe(32);
    expect(identity.registrationNonce).toBeInstanceOf(Uint8Array);
    expect(identity.registrationNonce.length).toBe(32);
  });

  it('returns the SAME identity on a second call, without re-prompting the wallet (cache hit)', async () => {
    const { store, getMasterSignature } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const first = await store.getOrCreateIdentity();
    const second = await store.getOrCreateIdentity();
    expect(second.userSecretKey.bytes).toEqual(first.userSecretKey.bytes);
    expect(second.registrationNonce).toEqual(first.registrationNonce);
    expect(getMasterSignature).toHaveBeenCalledTimes(1); // not called again on cache hit
  });

  it('THE CORE FIX: recovers the IDENTICAL identity in a fresh store (simulated cleared browser data) given the same wallet signature', async () => {
    const original = await (async () => {
      const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
      return store.getOrCreateIdentity();
    })();

    // Fresh store = fresh backing memory-level (own freshMemoryLevelFactory
    // call), as if IndexedDB had been wiped by a browser data clear. Only
    // thing carried over is the wallet producing the same signature again.
    const { store: recoveredStore } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const recovered = await recoveredStore.getOrCreateIdentity();

    expect(recovered.userSecretKey.bytes).toEqual(original.userSecretKey.bytes);
    expect(recovered.registrationNonce).toEqual(original.registrationNonce);
  });

  it('different wallets (different signatures) derive different identities', async () => {
    const { store: storeA } = makeStore('wallet-addr-A', WALLET_A_SIGNATURE);
    const { store: storeB } = makeStore('wallet-addr-B', WALLET_B_SIGNATURE);
    const idA = await storeA.getOrCreateIdentity();
    const idB = await storeB.getOrCreateIdentity();
    expect(idA.userSecretKey.bytes).not.toEqual(idB.userSecretKey.bytes);
  });
});

describe('private-state-store.ts — deterministic buy nonce derivation', () => {
  const LAUNCH_A = 'aa'.repeat(32);
  const LAUNCH_B = 'bb'.repeat(32);

  it('generates a fresh nonce on first use for a launch', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const nonce = await store.getOrCreateBuyNonce(LAUNCH_A);
    expect(nonce).toBeInstanceOf(Uint8Array);
    expect(nonce.length).toBe(32);
  });

  it('returns the SAME nonce on a second call for the same launch', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const first = await store.getOrCreateBuyNonce(LAUNCH_A);
    const second = await store.getOrCreateBuyNonce(LAUNCH_A);
    expect(second).toEqual(first);
  });

  it('THE CORE FIX: recovers the IDENTICAL buy nonce in a fresh store given the same wallet signature — this is the exact GitHub #70 scenario (lost the nonce needed to reveal a commit)', async () => {
    const original = await (async () => {
      const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
      return store.getOrCreateBuyNonce(LAUNCH_A);
    })();

    const { store: recoveredStore } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const recovered = await recoveredStore.getOrCreateBuyNonce(LAUNCH_A);

    expect(recovered).toEqual(original);
  });

  it('different launches get different nonces', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const nonceA = await store.getOrCreateBuyNonce(LAUNCH_A);
    const nonceB = await store.getOrCreateBuyNonce(LAUNCH_B);
    expect(nonceA).not.toEqual(nonceB);
  });

  it('a launch-scoped buy nonce does not collide with the identity sentinel scope', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const identity = await store.getOrCreateIdentity();
    const nonce = await store.getOrCreateBuyNonce(LAUNCH_A);
    expect(nonce).not.toEqual(identity.registrationNonce);
  });

  it('deriving an identity AND a buy nonce in one session only prompts the wallet ONCE (in-memory signature reuse)', async () => {
    const { store, getMasterSignature } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    await store.getOrCreateIdentity();
    await store.getOrCreateBuyNonce(LAUNCH_A);
    await store.getOrCreateBuyNonce(LAUNCH_B);
    expect(getMasterSignature).toHaveBeenCalledTimes(1);
  });

  it('CONCURRENCY FIX: firing getOrCreateIdentity + two getOrCreateBuyNonce calls WITHOUT awaiting between them still only prompts the wallet ONCE', async () => {
    // Regression test for a real bug found during the widget audit: caching
    // only the RESOLVED signature (not the in-flight promise) meant two
    // calls landing before the first had resolved would each see an empty
    // cache and independently call getMasterSignature — double-prompting
    // the wallet. Firing all three with Promise.all (no sequential await)
    // is exactly the shape that would have triggered it.
    const { store, getMasterSignature } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const [identity, nonceA, nonceB] = await Promise.all([
      store.getOrCreateIdentity(),
      store.getOrCreateBuyNonce(LAUNCH_A),
      store.getOrCreateBuyNonce(LAUNCH_B),
    ]);
    expect(getMasterSignature).toHaveBeenCalledTimes(1);
    expect(identity.userSecretKey.bytes.length).toBe(32);
    expect(nonceA).not.toEqual(nonceB);
  });
});

describe('private-state-store.ts — optional secondary backup flow (export/import)', () => {
  it('round-trips an identity through exportBackup/importBackup into a fresh store', async () => {
    const { store: storeA } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const original = await storeA.getOrCreateIdentity();
    const backup = await storeA.exportBackup(OTHER_REAL_PASSWORD);
    expect(backup.identity.format).toBe('midnight-private-state-export');
    expect(backup.buyNonces).toEqual([]); // no launches touched yet

    // Fresh store, fresh backing memory-level, DIFFERENT wallet signature
    // this time — proves the backup restores the original identity even
    // when the deterministic re-derivation path isn't available (e.g. the
    // user no longer has that wallet), which is exactly the scenario this
    // secondary path exists for.
    const { store: storeB } = makeStore('wallet-addr-1', WALLET_B_SIGNATURE);
    await storeB.importBackup(backup, OTHER_REAL_PASSWORD);
    const restored = await storeB.getOrCreateIdentity();

    expect(restored.userSecretKey.bytes).toEqual(original.userSecretKey.bytes);
    expect(restored.registrationNonce).toEqual(original.registrationNonce);
  });

  it('round-trips buy nonces through export/import too, not just identity', async () => {
    const LAUNCH = 'cc'.repeat(32);
    const { store: storeA } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    const originalNonce = await storeA.getOrCreateBuyNonce(LAUNCH);
    const backup = await storeA.exportBackup(OTHER_REAL_PASSWORD);
    // Real finding, real reason for DarkVeilBackupBundle's shape: the SDK's
    // exportPrivateStates only ever covers the CURRENTLY-set contract
    // address scope, never "everything" -- confirmed by reading the real
    // installed package source, not assumed from its .d.ts comment (which
    // reads misleadingly as "export all private states"). This module
    // self-tracks every launch address touched (knownLaunchHexes, inside
    // the identity record) specifically so exportBackup can enumerate and
    // export each scope separately -- one bundle entry per launch.
    expect(backup.buyNonces).toHaveLength(1);
    expect(backup.buyNonces[0].launchContractAddressHex).toBe(LAUNCH);

    const { store: storeB } = makeStore('wallet-addr-1', WALLET_B_SIGNATURE);
    await storeB.importBackup(backup, OTHER_REAL_PASSWORD);
    const restoredNonce = await storeB.getOrCreateBuyNonce(LAUNCH);

    expect(restoredNonce).toEqual(originalNonce);
  });

  it('rejects a backup password that fails the real SDK strength policy', async () => {
    const { store } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    await store.getOrCreateIdentity();
    await expect(store.exportBackup('short')).rejects.toThrow(/Password is shorter than 16 characters/);
  });

  it('importing with the WRONG password fails rather than silently returning garbage', async () => {
    const { store: storeA } = makeStore('wallet-addr-1', WALLET_A_SIGNATURE);
    await storeA.getOrCreateIdentity();
    const backup = await storeA.exportBackup(OTHER_REAL_PASSWORD);

    const { store: storeB } = makeStore('wallet-addr-1', WALLET_B_SIGNATURE);
    await expect(storeB.importBackup(backup, 'Wr0ngPassw0rd!!Nope')).rejects.toThrow(/Failed to decrypt export data/);
  });
});

describe('inMemoryLevelFactory', () => {
  it('returns the same database for a repeated name, so a write is readable afterwards', () => {
    // The provider opens a database per operation and closes it again. A
    // factory constructing one each time gives every call its own empty
    // database, and a value written by one call is gone by the next — which is
    // silent, because nothing errors: reads simply find nothing.
    const factory = inMemoryLevelFactory();

    expect(factory('noctis-db')).toBe(factory('noctis-db'));
  });

  it('keeps different names apart', () => {
    const factory = inMemoryLevelFactory();

    expect(factory('one')).not.toBe(factory('two'));
  });

  it('gives each caller its own set of databases', () => {
    // Two stores in the same process are meant to be two stores, so this must
    // not become a module-level cache shared between them.
    expect(inMemoryLevelFactory()('shared-name')).not.toBe(inMemoryLevelFactory()('shared-name'));
  });
});

describe('ephemeralPrivateStatePassword', () => {
  it('returns the same password every time it is asked, so the store can read its own writes', () => {
    // The store encrypts with whatever the provider returns and decrypts the
    // same way. A provider handing out a fresh password per call encrypts under
    // one key and then cannot decrypt — which surfaces as a cipher failure far
    // from here, not as anything resembling a password problem.
    const provider = ephemeralPrivateStatePassword();

    expect(provider()).toBe(provider());
  });

  it('gives a different password to each process, so no fixed string is baked in', () => {
    expect(ephemeralPrivateStatePassword()()).not.toBe(ephemeralPrivateStatePassword()());
  });

  it('meets the SDK strength policy the store really enforces', () => {
    // Checked against the real validatePassword rather than a restatement of
    // its rules, which is what a hand-written regex here would be.
    expect(() => validatePassword(ephemeralPrivateStatePassword()())).not.toThrow();
  });

  it('really does round-trip a signing key through the store', async () => {
    const provider = levelPrivateStateProvider({
      privateStateStoreName: 'ephemeral-password-state',
      signingKeyStoreName: 'ephemeral-password-signing',
      privateStoragePasswordProvider: ephemeralPrivateStatePassword(),
      accountId: 'ephemeral-password-test',
      levelFactory: inMemoryLevelFactory(),
    });
    const address = asContractAddress(`${'00'.repeat(31)}ee`);

    await provider.setSigningKey(address, 'ab'.repeat(32));

    expect(await provider.getSigningKey(address)).toBe('ab'.repeat(32));
  });
});
