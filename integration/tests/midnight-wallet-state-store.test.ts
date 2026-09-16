// Guards over the wallet snapshot store.
//
// WHY THIS EXISTS
// Snapshots exist so a Midnight wallet's chain replay survives a process that
// dies part-way through it. That makes the failure modes here unusually
// unforgiving, because every one of them is silent:
//
//   - A snapshot restored under the wrong SDK, network or seed does not throw.
//     It produces a wallet holding a confident, wrong view of what it owns.
//   - A snapshot that fails to load must degrade to a slow replay, never to an
//     exception. An outage is a worse outcome than a slow start.
//   - A save that reports success without persisting turns "resume from where
//     we stopped" into "start over", and only ever shows up as sync progress
//     that never accumulates.
//
// None of that is visible from the outside, so it is checked here instead.

import { mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Real implementations throughout — the spies only record, so every other test
// in this file exercises the genuine filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

import {
  changedBlobs,
  hasAnyBlob,
  type SnapshotGuards,
  seedFingerprintOf,
  startPeriodicSave,
  WalletStateStore,
  walletSdkVersion,
} from '../midnight-wallet-state-store.js';

const PASSPHRASE = 'test-passphrase-not-a-real-secret';

const GUARDS: SnapshotGuards = {
  sdkVersion: 'facade@4.0.1',
  networkId: 'preprod',
  seedFingerprint: 'aa'.repeat(32),
};

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'noctis-wallet-snapshot-'));
});

const newStore = () => new WalletStateStore(directory, PASSPHRASE);

describe('round trip', () => {
  it('returns exactly the blobs that were saved', async () => {
    const store = newStore();
    const blobs = { shielded: 'shielded-state', unshielded: 'unshielded-state', dust: 'dust-state' };
    await store.save('round-trip', GUARDS, blobs);

    expect(await store.load('round-trip', GUARDS)).toEqual(blobs);
  });

  it('survives a blob large enough to be a real snapshot', async () => {
    const store = newStore();
    // Real dust snapshots run to megabytes; a truncating write or an encoding
    // that only holds for short strings would pass every other test here.
    const big = 'x'.repeat(4 * 1024 * 1024);
    await store.save('big', GUARDS, { dust: big });

    const loaded = await store.load('big', GUARDS);
    expect(loaded?.dust).toHaveLength(big.length);
    expect(loaded?.dust).toBe(big);
  });

  it('does not leave the ciphertext recoverable from the file', async () => {
    const store = newStore();
    await store.save('secrecy', GUARDS, { unshielded: 'a-recognisable-utxo-marker' });

    const raw = await readFile(join(directory, 'secrecy.json'), 'utf8');
    expect(raw).not.toContain('a-recognisable-utxo-marker');
  });
});

describe('guards', () => {
  // Each case saves under GUARDS and loads under exactly one differing field,
  // so a load returning null can only be that field's guard.
  const cases: [string, SnapshotGuards][] = [
    ['sdk version', { ...GUARDS, sdkVersion: 'facade@9.9.9' }],
    ['network', { ...GUARDS, networkId: 'mainnet' }],
    ['seed fingerprint', { ...GUARDS, seedFingerprint: 'bb'.repeat(32) }],
  ];

  for (const [name, mismatched] of cases) {
    it(`cold-starts rather than restoring across a ${name} change`, async () => {
      const store = newStore();
      const account = `guard-${name.replace(/\s/g, '-')}`;
      await store.save(account, GUARDS, { dust: 'dust-state' });

      expect(await store.load(account, GUARDS)).not.toBeNull();
      expect(await store.load(account, mismatched)).toBeNull();
    });
  }

  it('discards stored blobs when a save moves a guard, rather than merging them forward', async () => {
    const store = newStore();
    await store.save('guard-move', GUARDS, { shielded: 'old-shielded', dust: 'old-dust' });

    // A new SDK version arrives and only the dust wallet has re-serialized yet.
    const upgraded = { ...GUARDS, sdkVersion: 'facade@5.0.0' };
    await store.save('guard-move', upgraded, { dust: 'new-dust' });

    const loaded = await store.load('guard-move', upgraded);
    expect(loaded).toEqual({ dust: 'new-dust' });
    // The old shielded blob was written by the previous SDK. Carrying it into a
    // snapshot now labelled with the new one would smuggle an incompatible blob
    // past the very guard that just rejected it.
    expect(loaded?.shielded).toBeUndefined();
  });
});

describe('degrading instead of throwing', () => {
  it('returns null for an account that was never saved', async () => {
    expect(await newStore().load('never-saved', GUARDS)).toBeNull();
  });

  it('returns null on the wrong passphrase', async () => {
    await newStore().save('wrong-pass', GUARDS, { dust: 'dust-state' });

    const other = new WalletStateStore(directory, 'a-different-passphrase');
    await expect(other.load('wrong-pass', GUARDS)).resolves.toBeNull();
  });

  it('returns null on a corrupted file', async () => {
    const store = newStore();
    await store.save('corrupt', GUARDS, { dust: 'dust-state' });
    await writeFile(join(directory, 'corrupt.json'), '{ this is not json');

    await expect(store.load('corrupt', GUARDS)).resolves.toBeNull();
  });

  it('returns null when the ciphertext has been tampered with', async () => {
    const store = newStore();
    await store.save('tampered', GUARDS, { dust: 'dust-state' });

    const path = join(directory, 'tampered.json');
    const file = JSON.parse(await readFile(path, 'utf8'));
    const ct = Buffer.from(file.blobs.dust.ct, 'base64');
    ct[0] ^= 0xff;
    file.blobs.dust.ct = ct.toString('base64');
    await writeFile(path, JSON.stringify(file));

    // GCM authenticates the ciphertext, so this must be detected rather than
    // decrypting into garbage that later fails somewhere less obvious.
    await expect(store.load('tampered', GUARDS)).resolves.toBeNull();
  });
});

describe('partial saves', () => {
  it('preserves sub-wallets the save did not mention', async () => {
    const store = newStore();
    await store.save('partial', GUARDS, { shielded: 'shielded-1', unshielded: 'unshielded-1', dust: 'dust-1' });
    // Only dust changed this round, which is the normal case: it moves every
    // block while the other two rarely do.
    await store.save('partial', GUARDS, { dust: 'dust-2' });

    expect(await store.load('partial', GUARDS)).toEqual({
      shielded: 'shielded-1',
      unshielded: 'unshielded-1',
      dust: 'dust-2',
    });
  });

  it('never writes directly over the previous snapshot', async () => {
    const store = newStore();
    const target = join(directory, 'atomic.json');
    vi.mocked(writeFile).mockClear();
    vi.mocked(rename).mockClear();

    await store.save('atomic', GUARDS, { dust: 'dust-state' });

    // The failure this module exists to survive is the process being killed
    // part-way through its work. A save that opens the live snapshot and writes
    // into it can be killed mid-write, leaving a truncated file — which discards
    // every snapshot banked before it, exactly when it is needed most. Writing
    // elsewhere and renaming into place is atomic: a kill leaves either the
    // previous complete snapshot or the new one.
    //
    // Checked against the calls rather than the leftovers on disk, because an
    // unsafe in-place write also leaves no temporary file behind and would pass
    // any check that only looked for one.
    const written = vi.mocked(writeFile).mock.calls.map(([path]) => String(path));
    expect(written).not.toContain(target);
    expect(written.every((path) => path.startsWith(target) && path.endsWith('.tmp'))).toBe(true);
    expect(vi.mocked(rename).mock.calls.map(([, to]) => String(to))).toContain(target);
  });
});

describe('diffing', () => {
  it('reports only sub-wallets whose blob actually changed', () => {
    const changed = changedBlobs(
      { shielded: 'same', unshielded: 'new', dust: 'dust-2' },
      { shielded: 'same', unshielded: 'old', dust: 'dust-1' },
    );

    expect(changed).toEqual({ unshielded: 'new', dust: 'dust-2' });
  });

  it('treats an absent blob as unchanged rather than as a deletion', () => {
    expect(changedBlobs({ dust: 'dust-1' }, { shielded: 'shielded-1', dust: 'dust-1' })).toEqual({});
  });

  it('recognises an empty diff', () => {
    expect(hasAnyBlob({})).toBe(false);
    expect(hasAnyBlob({ dust: 'dust-1' })).toBe(true);
  });
});

describe('the periodic save loop', () => {
  /** A facade stand-in exposing only what the save loop uses. */
  const fakeFacade = (read: () => Record<string, string>) => {
    const sub = (kind: string) => ({ serializeState: async () => read()[kind] ?? '' });
    return { shielded: sub('shielded'), unshielded: sub('unshielded'), dust: sub('dust') } as never;
  };

  const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition was never reached');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('banks progress without waiting for the wallet to finish syncing', async () => {
    const store = newStore();
    let current = { dust: 'dust-round-1' };
    const saves: string[] = [];

    const handle = startPeriodicSave(
      fakeFacade(() => current),
      store,
      'periodic',
      GUARDS,
      { intervalMs: 20, onSave: (saved) => saves.push(saved.dust ?? '') },
    );

    await waitFor(() => saves.length >= 1);
    current = { dust: 'dust-round-2' };
    await waitFor(() => saves.length >= 2);
    await handle.stop();

    expect(saves.slice(0, 2)).toEqual(['dust-round-1', 'dust-round-2']);
    expect((await store.load('periodic', GUARDS))?.dust).toBe('dust-round-2');
  });

  it('skips rounds in which nothing changed', async () => {
    const store = newStore();
    let saveCount = 0;

    const handle = startPeriodicSave(
      fakeFacade(() => ({ dust: 'unchanging' })),
      store,
      'idle',
      GUARDS,
      { intervalMs: 10, onSave: () => saveCount++ },
    );

    await waitFor(() => saveCount >= 1);
    const afterFirst = saveCount;
    await new Promise((resolve) => setTimeout(resolve, 120));
    await handle.stop();

    // Re-encrypting a multi-megabyte blob that did not change is the cost this
    // diff exists to avoid, so an unchanged wallet must go quiet.
    expect(saveCount).toBe(afterFirst);
  });

  it('retries a blob whose save failed instead of treating it as persisted', async () => {
    const store = newStore();
    const failing = new WalletStateStore(directory, PASSPHRASE);
    let failNext = true;
    const errors: unknown[] = [];
    const saved: string[] = [];

    // Fail the first write only. The blob is unchanged afterwards, so it is
    // re-saved only if the failure left the baseline where it was.
    failing.save = async (accountId, guards, blobs) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      return store.save(accountId, guards, blobs);
    };

    const handle = startPeriodicSave(
      fakeFacade(() => ({ dust: 'dust-state' })),
      failing,
      'retry',
      GUARDS,
      {
        intervalMs: 15,
        onSave: (blobs) => saved.push(blobs.dust ?? ''),
        onError: (err) => errors.push(err),
      },
    );

    await waitFor(() => saved.length >= 1);
    await handle.stop();

    expect(errors).toHaveLength(1);
    expect(saved).toContain('dust-state');
    expect((await store.load('retry', GUARDS))?.dust).toBe('dust-state');
  });

  it('takes a final snapshot on stop', async () => {
    const store = newStore();
    let current = { dust: 'early' };
    const saves: string[] = [];

    const handle = startPeriodicSave(
      fakeFacade(() => current),
      store,
      'final',
      GUARDS,
      { intervalMs: 10_000, onSave: (blobs) => saves.push(blobs.dust ?? '') },
    );

    // Nothing has ticked yet — the interval is far longer than this test. The
    // work since the last tick would be lost without a save on the way out.
    current = { dust: 'latest' };
    await handle.stop();

    expect(saves).toEqual(['latest']);
    expect((await store.load('final', GUARDS))?.dust).toBe('latest');
  });
});

describe('identity helpers', () => {
  it('fingerprints different seeds differently and one seed stably', () => {
    const a = seedFingerprintOf(new Uint8Array(32).fill(1));
    const b = seedFingerprintOf(new Uint8Array(32).fill(2));

    expect(a).toBe(seedFingerprintOf(new Uint8Array(32).fill(1)));
    expect(a).not.toBe(b);
  });

  it('does not leak the seed into the fingerprint', () => {
    const seed = new Uint8Array(32).fill(7);
    expect(seedFingerprintOf(seed)).not.toContain(Buffer.from(seed).toString('hex'));
  });

  it('reports a version string covering every serializing package', () => {
    const version = walletSdkVersion();

    // A snapshot is only as compatible as the least compatible sub-wallet that
    // wrote part of it, so all four have to appear.
    for (const name of ['facade@', 'shielded@', 'unshielded-wallet@', 'dust-wallet@']) {
      expect(version).toContain(name);
    }
  });
});

describe('generations', () => {
  // The live snapshot is rewritten every 30 seconds, so a fault that is only
  // recognised later — a dust wallet wedged at the chain tip keeps banking
  // happily — has already overwritten the last healthy state many times over.
  // Generations are what make that recoverable, and the thing they protect is
  // a replay measured in hours, so they are checked rather than assumed.
  const existsAt = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  it('keeps the previous snapshot when the live one is replaced', async () => {
    const store = new WalletStateStore(directory, PASSPHRASE);
    const account = `generations-${Date.now()}`;
    const live = join(directory, `${account}.json`);

    await store.save(account, GUARDS, { dust: 'first' });
    // Nothing existed before the first save, so there is no past to preserve.
    expect(await existsAt(`${live}.gen1`)).toBe(false);

    await store.save(account, GUARDS, { dust: 'second' });
    expect(await existsAt(`${live}.gen1`)).toBe(true);

    // The generation holds the DISPLACED state, not the current one — that is
    // the whole point, and an off-by-one here would silently keep the broken
    // snapshot twice instead of the good one.
    const recovered = new WalletStateStore(directory, PASSPHRASE);
    await rename(`${live}.gen1`, live);
    expect(await recovered.load(account, GUARDS)).toEqual({ dust: 'first' });
  });

  it('does not rotate again while the newest generation is still fresh', async () => {
    const store = new WalletStateStore(directory, PASSPHRASE);
    const account = `generations-fresh-${Date.now()}`;
    const live = join(directory, `${account}.json`);

    await store.save(account, GUARDS, { dust: 'one' });
    await store.save(account, GUARDS, { dust: 'two' });
    const first = await readFile(`${live}.gen1`, 'utf8');

    // Saves land seconds apart in a real run. If every one displaced a
    // generation, six of them would cover three minutes and protect nothing.
    await store.save(account, GUARDS, { dust: 'three' });
    await store.save(account, GUARDS, { dust: 'four' });
    expect(await readFile(`${live}.gen1`, 'utf8')).toBe(first);
    expect(await existsAt(`${live}.gen2`)).toBe(false);
  });
});
