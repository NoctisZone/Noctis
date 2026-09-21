// ============================================================================
// Noctis Zone — Midnight wallet sync-state snapshots
// ============================================================================
// A Midnight wallet reaches usable state by replaying chain history. On preprod
// the dust sub-wallet's replay is expensive enough that a single process may not
// finish it: its serialized state grows steadily without collapsing (upstream
// midnightntwrk/midnight-wallet#639), and two earlier runs here ended in a
// JavaScript heap OOM before reaching the tip.
//
// This module makes that progress durable. Each sub-wallet can serialize itself
// mid-replay, so a snapshot taken every 30 seconds banks real progress from the
// first minute — a process that dies has still moved the wallet forward, and the
// next one resumes from where it stopped instead of starting over.
//
// Verified against the installed SDK before writing, not recalled:
//   - WalletFacade exposes `shielded`/`unshielded`/`dust` as the wallet APIs
//     (wallet-sdk-facade@4.0.1 index.d.ts), and each API declares
//     `serializeState(): Promise<TSerialized>`.
//   - `TSerialized` is `string` for all three default wallet types, so a
//     snapshot is a string end to end.
//   - Each wallet class declares `restore(serializedState: TSerialized)`
//     alongside its `startWith…` constructor.
// FacadeState ALSO has `shielded`/`unshielded`/`dust` fields, but those are
// state objects and carry no `serializeState` — the snapshot must be taken from
// the facade, never from a state emission.
//
// Snapshots are wallet sync state, not keys: UTXOs, balances, sync offsets. They
// are still encrypted at rest, because a wallet's UTXO set is exactly the
// holdings/activity picture this platform promises to keep private, and they are
// written under /local/ (gitignored) so they never reach the public repository.
// ============================================================================

import { createCipheriv, createDecipheriv, createHmac, pbkdf2, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How many past snapshots to keep beside the live one, and how far apart.
 *
 * The live file is rewritten every 30 seconds, so generations spaced by the
 * save loop would cover barely a minute and protect against nothing. What they
 * have to survive is a fault that is only RECOGNISED much later: a dust wallet
 * that reaches the chain tip and is then wedged by a rewound sync stream keeps
 * banking happily, so by the time the wedge is visible the healthy state has
 * been overwritten many times. Six generations ten minutes apart give an hour
 * of recoverable history, which is the scale that matters when the alternative
 * is replaying ~1.5M dust entries again.
 */
const SNAPSHOT_GENERATIONS = 6;
const GENERATION_INTERVAL_MS = 10 * 60 * 1000;

/** PBKDF2 work factor. Matches the reference implementation this pattern came from. */
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = 'sha256';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Bumped only if the on-disk envelope changes shape; a mismatch cold-starts. */
const ENVELOPE_VERSION = 1;

/** One encrypted blob, self-describing so it can be decrypted without side data. */
interface EncryptedEnvelope {
  v: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

/** The three sub-wallet snapshots. Any subset may be present. */
export interface WalletStateBlobs {
  shielded?: string;
  unshielded?: string;
  dust?: string;
}

export type SubWalletKind = keyof WalletStateBlobs;

export const SUB_WALLET_KINDS: readonly SubWalletKind[] = ['shielded', 'unshielded', 'dust'] as const;

/**
 * The three things that must match for a snapshot to be safe to restore.
 *
 * Each one corrupts a wallet differently if ignored: a snapshot from another SDK
 * version deserializes into a shape the code no longer expects, one from another
 * network describes UTXOs this chain never had, and one from another seed
 * describes someone else's holdings entirely.
 */
export interface SnapshotGuards {
  sdkVersion: string;
  networkId: string;
  seedFingerprint: string;
}

interface SnapshotFile extends SnapshotGuards {
  accountId: string;
  updatedAt: string;
  blobs: Partial<Record<SubWalletKind, EncryptedEnvelope>>;
}

/**
 * Version string covering every package whose serialization format a snapshot
 * depends on — all four, because a snapshot is only as compatible as the least
 * compatible sub-wallet that wrote part of it.
 *
 * Read from the installed packages rather than from this workspace's declared
 * ranges: the ranges are carets, and what matters is the code actually running.
 */
function installedVersionOf(name: string): string {
  // Located by walking node_modules rather than by resolving the package.
  //
  // These packages are ESM-only and expose exactly one export condition —
  // `import` for '.', and nothing for './package.json'. That leaves no resolver
  // path to the manifest at all: requiring the subpath is blocked by the exports
  // map, and resolving the package itself is blocked by the missing `require`
  // condition. Walking up to the installed copy answers the question directly,
  // and works the same whether this file runs from source or from a bundle.
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(directory, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
      if (parsed.version) return parsed.version;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Cannot determine the installed version of ${name}; wallet snapshots cannot be guarded safely.`);
    }
    directory = parent;
  }
}

export function walletSdkVersion(): string {
  const packages = [
    '@midnight-ntwrk/wallet-sdk-facade',
    '@midnight-ntwrk/wallet-sdk-shielded',
    '@midnight-ntwrk/wallet-sdk-unshielded-wallet',
    '@midnight-ntwrk/wallet-sdk-dust-wallet',
  ];
  return packages
    .map((name) => {
      // Short, stable names — the scope is identical across all four and adds
      // only noise to a string that gets compared byte for byte.
      return `${name.replace('@midnight-ntwrk/wallet-sdk-', '')}@${installedVersionOf(name)}`;
    })
    .join('+');
}

/**
 * A stable, non-reversible identifier for a seed.
 *
 * HMAC rather than a plain hash so the stored value cannot be checked against a
 * candidate seed without also knowing the label — the fingerprint sits next to
 * the encrypted blobs, and a bare digest of a 32-byte seed would invite exactly
 * that comparison.
 */
export function seedFingerprintOf(seed: Uint8Array): string {
  return createHmac('sha256', 'noctis-midnight-seed-fingerprint-v1').update(seed).digest('hex');
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Async so the derivation lands on the libuv threadpool instead of blocking
    // the event loop for the better part of a second.
    pbkdf2(passphrase, salt, PBKDF2_ITERATIONS, KEY_BYTES, PBKDF2_DIGEST, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Encrypted snapshot storage, one file per account.
 *
 * Files rather than a database: every consumer here is a one-shot CLI, so a
 * directory of files needs no new dependency, no schema migration and no server.
 */
export class WalletStateStore {
  /**
   * One derived key per account per process. PBKDF2 at 600k iterations is
   * deliberately expensive; deriving it per save would dominate the save loop.
   */
  readonly #keyCache = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly directory: string,
    private readonly passphrase: string,
  ) {}

  #generationPath(target: string, index: number): string {
    return `${target}.gen${index}`;
  }

  /**
   * Preserve the current snapshot as a generation, if the newest one is old
   * enough to be worth displacing.
   *
   * Copied rather than renamed. Renaming would be cheaper, but it leaves a
   * window in which no live snapshot exists at all, and a process killed inside
   * that window comes back with nothing to resume from — which is the exact
   * outcome this whole module exists to prevent. A 15 MB copy every ten minutes
   * is not worth that risk.
   */
  async #keepGeneration(target: string): Promise<void> {
    const newest = this.#generationPath(target, 1);
    const [live, latest] = await Promise.all([stat(target).catch(() => null), stat(newest).catch(() => null)]);
    if (!live) return; // Nothing live yet — the first save has no past to keep.
    if (latest && Date.now() - latest.mtimeMs < GENERATION_INTERVAL_MS) return;

    // Oldest first, so each slot is free before anything moves into it.
    await unlink(this.#generationPath(target, SNAPSHOT_GENERATIONS)).catch(() => {});
    for (let index = SNAPSHOT_GENERATIONS - 1; index >= 1; index--) {
      await rename(this.#generationPath(target, index), this.#generationPath(target, index + 1)).catch(() => {});
    }
    await copyFile(target, newest).catch(() => {});
  }

  #pathFor(accountId: string): string {
    // Account ids are internal role names (`buyer_3`, `wallet_seed`), but this
    // builds a filesystem path, so anything that could climb out of the
    // directory is replaced rather than trusted.
    const safe = accountId.replace(/[^A-Za-z0-9_.-]/g, '_');
    return join(this.directory, `${safe}.json`);
  }

  #keyFor(accountId: string, salt: Buffer): Promise<Buffer> {
    const cacheKey = `${accountId}:${salt.toString('base64')}`;
    let pending = this.#keyCache.get(cacheKey);
    if (!pending) {
      pending = deriveKey(this.passphrase, salt);
      this.#keyCache.set(cacheKey, pending);
      // A failed derivation must not be cached, or every later call inherits it.
      pending.catch(() => this.#keyCache.delete(cacheKey));
    }
    return pending;
  }

  /** Per-account salt, so two accounts never share a derived key. */
  #saltFor(accountId: string): Buffer {
    return createHmac('sha256', 'noctis-midnight-snapshot-salt-v1').update(accountId).digest();
  }

  async #encrypt(accountId: string, plaintext: string): Promise<EncryptedEnvelope> {
    const salt = this.#saltFor(accountId);
    const key = await this.#keyFor(accountId, salt);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      v: ENVELOPE_VERSION,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  async #decrypt(accountId: string, envelope: EncryptedEnvelope): Promise<string> {
    const key = await this.#keyFor(accountId, Buffer.from(envelope.salt, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    // GCM verifies the tag in final(); a wrong key or a tampered file throws
    // here rather than returning plausible-looking garbage.
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8');
  }

  async #readFile(accountId: string): Promise<SnapshotFile | null> {
    try {
      return JSON.parse(await readFile(this.#pathFor(accountId), 'utf8')) as SnapshotFile;
    } catch {
      // Absent, unreadable or malformed all mean the same thing to a caller:
      // there is nothing here to resume from.
      return null;
    }
  }

  /**
   * Load a snapshot, or null if there is nothing safe to restore.
   *
   * Never throws. A snapshot that cannot be used is not an error condition — it
   * means this wallet syncs from scratch, which is slow but always correct. An
   * exception here would turn a recoverable slow path into an outage.
   */
  async load(accountId: string, guards: SnapshotGuards): Promise<WalletStateBlobs | null> {
    const file = await this.#readFile(accountId);
    if (!file) return null;

    if (file.sdkVersion !== guards.sdkVersion) return null;
    if (file.networkId !== guards.networkId) return null;
    if (file.seedFingerprint !== guards.seedFingerprint) return null;

    try {
      const blobs: WalletStateBlobs = {};
      for (const kind of SUB_WALLET_KINDS) {
        const envelope = file.blobs[kind];
        if (!envelope) continue;
        if (envelope.v !== ENVELOPE_VERSION) return null;
        blobs[kind] = await this.#decrypt(accountId, envelope);
      }
      return blobs;
    } catch {
      return null;
    }
  }

  /**
   * Persist the given sub-wallet snapshots, preserving any not supplied.
   *
   * Callers pass only what changed — the dust snapshot moves every block while
   * the other two rarely do, and re-encrypting multi-megabyte blobs that did not
   * change is pure cost.
   */
  async save(accountId: string, guards: SnapshotGuards, blobs: WalletStateBlobs): Promise<void> {
    const existing = await this.#readFile(accountId);

    // Previously stored blobs survive only if they describe the same wallet on
    // the same network under the same SDK. If any guard moved, whatever is on
    // disk is about to be unusable anyway, so it must not be merged forward.
    const carriedOver =
      existing &&
      existing.sdkVersion === guards.sdkVersion &&
      existing.networkId === guards.networkId &&
      existing.seedFingerprint === guards.seedFingerprint
        ? existing.blobs
        : {};

    const merged: SnapshotFile['blobs'] = { ...carriedOver };
    for (const kind of SUB_WALLET_KINDS) {
      const plaintext = blobs[kind];
      if (plaintext !== undefined) merged[kind] = await this.#encrypt(accountId, plaintext);
    }

    const file: SnapshotFile = {
      accountId,
      ...guards,
      updatedAt: new Date().toISOString(),
      blobs: merged,
    };

    const target = this.#pathFor(accountId);
    await mkdir(dirname(target), { recursive: true });

    // Write then rename. The failure this whole module exists to survive is the
    // process being killed part-way through its work, and a plain overwrite that
    // is killed mid-write leaves a truncated file — discarding every snapshot
    // taken before it. Rename is atomic, so a kill leaves either the previous
    // complete snapshot or the new one, never a torn mix.
    await this.#keepGeneration(target);

    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
    await rename(temporary, target);
  }
}

/**
 * Reads a sub-wallet's applied cursor as of right now.
 *
 * Supplied by the caller rather than taken off the facade, because the cursor
 * lives on a state EMISSION (`FacadeState.dust.progress`) while serialization
 * lives on the facade's sub-wallet API — the two are different objects and this
 * module deliberately knows only the second. Returning `undefined` means "the
 * cursor could not be read", which is treated as "cannot prove the arm was
 * still", not as "it was".
 */
export type SubWalletCursorReader = (kind: SubWalletKind) => bigint | undefined;

/** Why a round declined to bank a sub-wallet, for a caller that reports it. */
export type SkipReason = 'serialize-failed' | 'cursor-unreadable' | 'cursor-moved' | 'empty';

export interface CollectedWalletState {
  blobs: WalletStateBlobs;
  /** Populated for every kind NOT in `blobs`. Never silently empty. */
  skipped: Partial<Record<SubWalletKind, SkipReason>>;
}

/**
 * Serialize whichever sub-wallets can be serialized WITHOUT TEARING, without
 * letting one failure lose the others.
 *
 * A SNAPSHOT IS ONLY BANKED FROM AN ARM WHOSE CURSOR DID NOT MOVE ACROSS ITS
 * OWN SERIALIZE, and that rule is the whole point of this function.
 *
 * A dust snapshot is two coupled fields: the ledger blob carrying the
 * generation tree, and the applied cursor. `serializeState()` is a read of
 * whatever the state observable is currently emitting — there is no fence, no
 * pause, and the only teardown the SDK offers is a full scope close — so an arm
 * that applies an update part-way through can hand back a tree and a cursor
 * captured at different instants. On restore the cursor alone decides which
 * events are ever applied, so a cursor ahead of its tree filters out the gap
 * FOREVER: the wallet is frozen rather than slow, and nothing re-requests the
 * missing entries. Reading the cursor either side of the serialize is what
 * closes that window — if it never moved, there was no interval to tear in,
 * which is also why the two idle arms always restored cleanly while the busy
 * one did not.
 *
 * Nothing here is swallowed. Every kind that is not banked is reported with a
 * reason, because the previous version's silent catch was the reason six
 * corrupt generations accumulated unnoticed: the window in which tearing
 * happens was exactly the window in which failures were designed to be ignored.
 */
export async function collectWalletStateBlobs(
  facade: {
    shielded: { serializeState(): Promise<string> };
    unshielded: { serializeState(): Promise<string> };
    dust: { serializeState(): Promise<string> };
  },
  readCursor: SubWalletCursorReader,
): Promise<CollectedWalletState> {
  const blobs: WalletStateBlobs = {};
  const skipped: Partial<Record<SubWalletKind, SkipReason>> = {};
  await Promise.all(
    SUB_WALLET_KINDS.map(async (kind) => {
      const before = readCursor(kind);
      let blob: string;
      try {
        blob = await facade[kind].serializeState();
      } catch {
        skipped[kind] = 'serialize-failed';
        return;
      }
      if (typeof blob !== 'string' || blob.length === 0) {
        skipped[kind] = 'empty';
        return;
      }
      const after = readCursor(kind);
      if (before === undefined || after === undefined) {
        skipped[kind] = 'cursor-unreadable';
        return;
      }
      if (before !== after) {
        skipped[kind] = 'cursor-moved';
        return;
      }
      blobs[kind] = blob;
    }),
  );
  return { blobs, skipped };
}

/** Sub-wallet snapshots that differ from the last confirmed save. */
export function changedBlobs(current: WalletStateBlobs, lastSaved: WalletStateBlobs): WalletStateBlobs {
  const changed: WalletStateBlobs = {};
  for (const kind of SUB_WALLET_KINDS) {
    const blob = current[kind];
    if (blob !== undefined && blob !== lastSaved[kind]) changed[kind] = blob;
  }
  return changed;
}

export function hasAnyBlob(blobs: WalletStateBlobs): boolean {
  return SUB_WALLET_KINDS.some((kind) => blobs[kind] !== undefined);
}

/**
 * The ledger's own complaint when a restored dust cursor sits ahead of the tree
 * it was banked with.
 *
 * Matched on the ledger's wording rather than on a code, because it arrives as
 * a plain throw with no code attached. The two real occurrences differed only
 * in their indices — `expected to insert index 393044, but received 393050`
 * and `1128734 … 1128751` — so the gap size is not part of the identity.
 */
const NON_LINEAR_DUST_INSERT = /inserted non-linearly into dust generation tree/i;

/**
 * True for the one error that means the snapshot is unusable FOREVER.
 *
 * This is not a transient the caller should sit out. The restored cursor
 * decides which updates are ever applied, so every subsequent update filters
 * out exactly the entries the tree is waiting for — retrying re-runs the same
 * arithmetic and throws in the same place. The only exit is to discard the
 * dust snapshot and replay that arm from genesis, which is what
 * `dustColdStart` does.
 */
export function isTornDustSnapshotError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NON_LINEAR_DUST_INSERT.test(message);
}

/** What to tell a human who has just hit a torn snapshot. Named once, used everywhere. */
export const TORN_DUST_SNAPSHOT_REMEDY =
  'The banked dust snapshot is torn: its cursor was saved ahead of its generation tree, so the ' +
  'entries in between are filtered out of every future update and can never arrive. This does not ' +
  'heal and must not be retried — re-run with dustColdStart to discard the dust snapshot and ' +
  'replay that arm from genesis. The shielded and unshielded snapshots are unaffected.';

/**
 * How long a freshly restored dust arm may sit without moving before the
 * snapshot behind it is treated as torn.
 *
 * A healthy restored arm applies continuously; the measured broken one advanced
 * by 2 in three days. Anything in between is comfortably separated by a window
 * of a few blocks, and erring long only delays the diagnosis — it never turns a
 * healthy wallet into a failed one, because a healthy wallet passes the moment
 * it moves.
 */
export const RESTORED_CURSOR_PROOF_MS = 90_000;

export interface CursorAdvanceResult {
  advanced: boolean;
  from: bigint;
  to: bigint;
  waitedMs: number;
}

/**
 * Wait until a restored cursor actually MOVES, and report if it never does.
 *
 * A successful `restore()` is not health. The torn snapshots all restored
 * without complaint and reported a plausible index; what separated them from
 * the good ones was that the index then stopped advancing. Reads do not need a
 * synced wallet, so nothing notices until something has to pay a fee — which,
 * in the run this came from, was six days later.
 *
 * Returns rather than throws, so the caller decides whether a stalled arm is
 * fatal or merely worth reporting.
 */
export async function waitForCursorToAdvance(
  readCursor: () => bigint | undefined,
  timeoutMs: number = RESTORED_CURSOR_PROOF_MS,
  pollMs = 2_000,
): Promise<CursorAdvanceResult> {
  const started = Date.now();
  const from = readCursor() ?? 0n;
  for (;;) {
    const now = readCursor() ?? from;
    if (now !== from) return { advanced: true, from, to: now, waitedMs: Date.now() - started };
    if (Date.now() - started >= timeoutMs) {
      return { advanced: false, from, to: now, waitedMs: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export interface PeriodicSaveHandle {
  /** Final serialize + save, then stop. Safe to call more than once. */
  stop(): Promise<void>;
}

export interface PeriodicSaveOptions {
  intervalMs?: number;
  /** Called after each successful save with what was banked, for progress logging. */
  onSave?: (saved: WalletStateBlobs, sizes: Record<string, number>) => void;
  onError?: (err: unknown) => void;
  /**
   * Called once per round with every sub-wallet the round declined to bank.
   *
   * Not optional in spirit, whatever the `?` says: an arm that is silently
   * never banked looks exactly like an arm that is healthy and unchanging, and
   * telling those two apart after the fact costs a chain replay.
   */
  onSkip?: (skipped: Partial<Record<SubWalletKind, SkipReason>>) => void;
}

/**
 * Snapshot the facade on a timer for as long as the process lives.
 *
 * The interval is what makes an OOM survivable rather than fatal: progress is
 * durable to within one interval, so a killed process loses at most that much
 * and the next one resumes from the rest.
 *
 * `readCursor` is positional and required rather than an option, for the same
 * reason the blueprint fingerprint is stamped on every bundle centrally: the
 * anti-tearing rule is only worth having if a new caller cannot leave it out by
 * accident. A caller with no cursor to read banks nothing, loudly.
 */
export function startPeriodicSave(
  facade: Parameters<typeof collectWalletStateBlobs>[0],
  store: WalletStateStore,
  accountId: string,
  guards: SnapshotGuards,
  readCursor: SubWalletCursorReader,
  options: PeriodicSaveOptions = {},
): PeriodicSaveHandle {
  const intervalMs = options.intervalMs ?? 30_000;
  let lastSaved: WalletStateBlobs = {};
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;

  const runSave = async () => {
    const { blobs: current, skipped } = await collectWalletStateBlobs(facade, readCursor);
    if (Object.keys(skipped).length > 0) options.onSkip?.(skipped);
    const changed = changedBlobs(current, lastSaved);
    if (!hasAnyBlob(changed)) return;

    await store.save(accountId, guards, changed);
    // The baseline advances only after the write resolved. Advancing it
    // optimistically would drop the change permanently if the write failed,
    // since the next round would see it as unchanged and skip it.
    lastSaved = { ...lastSaved, ...changed };

    const sizes: Record<string, number> = {};
    for (const kind of SUB_WALLET_KINDS) {
      const blob = changed[kind];
      if (blob !== undefined) sizes[kind] = blob.length;
    }
    options.onSave?.(changed, sizes);
  };

  // Saves are chained rather than overlapped: serializing three sub-wallets can
  // outlast one interval, and two concurrent rounds would race on both the
  // baseline and the file.
  const tick = () => {
    if (stopped) return;
    inFlight = inFlight.then(runSave).catch((err) => options.onError?.(err));
  };

  const timer = setInterval(tick, intervalMs);
  // Never hold the process open on the snapshot timer alone.
  timer.unref?.();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // One last save so the work done since the previous tick is not thrown
      // away, and only then let the caller tear the wallet down.
      await inFlight.catch(() => {});
      await runSave().catch((err) => options.onError?.(err));
    },
  };
}
