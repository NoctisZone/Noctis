// ============================================================================
// Noctis Zone — Witness-Secret Persistence (reworked 2026-07-15)
// ============================================================================
// ORIGINAL DESIGN (first pass): identity secret key + per-launch buy
// nonces were RANDOMLY generated once, then stored in the browser's
// IndexedDB via @midnight-ntwrk/midnight-js-level-private-state-provider.
// That package's own doc comment is explicit that it "lacks a recovery
// mechanism" -- clearing browser data destroys it permanently, with no
// fallback except a manually-downloaded encrypted backup file the user had
// to remember to create AND keep safe. Flagged directly by Jinx as
// unacceptable for a product where the failure mode is real money (a
// forfeited NIGHT bond, an unrevealed buy, a lost allocation) locked behind
// "did you happen to have a backup file."
//
// REWORKED DESIGN: every value that MUST be recoverable is now DERIVED,
// not generated -- from a single deterministic wallet signature, not
// random bytes. Ed25519 signing (what every real Cardano wallet uses) is
// deterministic: the same wallet signing the same fixed message always
// produces the same signature, on any device, forever. That means:
//
//   masterSignature = wallet.signData(FIXED_DOMAIN_MESSAGE)   -- one prompt
//   identitySecretKey    = sha256("sk"        || masterSignature)
//   buyNonce(launchId)   = sha256("buy-nonce" || launchId || masterSignature)
//
// IndexedDB is now a CACHE for convenience (skip re-prompting the wallet on
// every call within a session/across reloads), not the only copy. If the
// cache is empty -- first use, or the browser data was wiped -- this module
// falls back to asking for the wallet signature again and re-derives the
// IDENTICAL values, fully recovering identity and every launch's buy nonce
// with no backup file needed. Recovery becomes "reconnect your wallet,"
// matching how every other real wallet product already trains users to
// think about recovery, instead of a bespoke file-management step.
//
// Privacy note: a signature is not the wallet's private key -- no real
// Midnight/Cardano wallet ever exposes secret key material to page JS
// (verified against the real dapp-connector-api this session, see
// wallet-connection.ts). Deriving from a signature also reveals nothing
// new to a third party that the platform's own governor doesn't already
// necessarily know -- the governor already links wallet address to
// DarkVeil identity during the eligibility/intake process (see
// darkveil-registration.php); this derivation doesn't change who can learn
// that mapping, only how resilient the USER's own copy of their identity
// is to losing local browser data.
//
// exportBackup/importBackup remain real and working below -- kept as an
// optional defense-in-depth path (e.g. for a user who'd rather not
// reconnect their wallet), not the primary recovery mechanism anymore.
// ============================================================================

import {
  type LevelPrivateStateProviderConfig,
  levelPrivateStateProvider,
} from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import {
  asContractAddress,
  type ExportPrivateStatesOptions,
  type ImportPrivateStatesOptions,
  type ImportPrivateStatesResult,
  type PrivateStateExport,
  type PrivateStateProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { sha256 } from '@noble/hashes/sha2.js';
import { MemoryLevel } from 'memory-level';
import type { UserSecretKey } from '../contracts/midnight/witnesses.js';

// ============================================================================
// HEX HELPERS
// ============================================================================

// Exported (2026-07-19) so cto-private-state-store.ts can reuse these
// rather than duplicating them — unlike the Compact contracts (which
// genuinely cannot share code across files), these are ordinary TS module
// exports within the same integration/ workspace.
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length} chars)`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toUtf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ============================================================================
// DETERMINISTIC DERIVATION
// ============================================================================

/**
 * The single fixed message every wallet signs once, per account, to unlock
 * DarkVeil recovery. Every derived value below is a domain-separated hash
 * of THIS ONE signature -- so only one wallet prompt is ever needed, no
 * matter how many launches a user later participates in.
 */
export const MASTER_SIGNATURE_DOMAIN = 'noctis:darkveil:master:v1';

const SK_DOMAIN = 'noctis:darkveil:derive:sk:v1';
const BUY_NONCE_DOMAIN = 'noctis:darkveil:derive:buy-nonce:v1';

/** Exported (2026-07-19) — same reasoning as the hex/byte helpers above. */
export function deriveFromSignature(domain: string, masterSignatureHex: string, extra?: Uint8Array): Uint8Array {
  const sigBytes = hexToBytes(masterSignatureHex);
  const input = extra ? concatBytes(toUtf8Bytes(domain), sigBytes, extra) : concatBytes(toUtf8Bytes(domain), sigBytes);
  return sha256(input);
}

// ============================================================================
// TYPES
// ============================================================================

export interface DarkVeilIdentity {
  userSecretKey: UserSecretKey;
}

/**
 * A record written before the registration nonce left the contract may still
 * carry `registrationNonceHex`; nothing reads it, so it is left where it is.
 */
interface StoredIdentity {
  secretKeyHex: string;
  /** Every launch contract address this identity has requested a buy nonce for -- see the file header's EXPORT/IMPORT note for why this list has to be self-tracked. */
  knownLaunchHexes: string[];
}

/**
 * A backup bundle covering every scope this store actually used, since the
 * real SDK only exports/imports one contract-address scope per call. Now a
 * SECONDARY safety net (see file header) -- the primary recovery path is
 * re-deriving from a wallet signature, which needs no bundle at all.
 */
export interface DarkVeilBackupBundle {
  identity: PrivateStateExport;
  buyNonces: Array<{
    launchContractAddressHex: string;
    export: PrivateStateExport;
  }>;
}

const IDENTITY_PRIVATE_STATE_ID = 'noctis:darkveil:identity:v1';
const BUY_NONCE_PRIVATE_STATE_ID = 'noctis:darkveil:buy-nonce:v1';

const IDENTITY_SENTINEL_HEX = `${'00'.repeat(31)}fd`;
const IDENTITY_SENTINEL_ADDRESS = asContractAddress(IDENTITY_SENTINEL_HEX);

export interface DarkVeilPrivateStore {
  /**
   * Get this account's DarkVeil identity. Reads the local cache first; on a
   * cache miss (first use, or the cache was wiped), asks
   * getMasterSignature() for a wallet signature and re-derives the
   * identical identity deterministically -- see file header.
   */
  getOrCreateIdentity(): Promise<DarkVeilIdentity>;
  /**
   * Get this account's buy nonce for a specific launch, same cache-then-
   * derive behavior as getOrCreateIdentity. DarkVeil allows exactly one buy
   * commitment per registrant per launch (buyNullifiers is single-use in
   * both eligibility_gate.compact and bonding_curve.compact), so one
   * derived nonce per launch is sufficient -- no per-attempt counter needed.
   */
  getOrCreateBuyNonce(launchContractAddressHex: string): Promise<Uint8Array>;
  /**
   * Optional secondary backup (see file header -- the primary recovery
   * path is re-deriving from a wallet signature, not this). Real encrypted
   * backup covering the identity scope plus every launch's buy-nonce scope
   * this identity has touched.
   */
  exportBackup(backupPassword: string): Promise<DarkVeilBackupBundle>;
  /** Restore from a real exportBackup() output -- every scope in the bundle, not just identity. */
  importBackup(bundle: DarkVeilBackupBundle, backupPassword: string): Promise<ImportPrivateStatesResult[]>;
  /** The underlying provider, for wiring into a full ContractProviders (see contract-providers.ts). */
  readonly provider: PrivateStateProvider;
}

export interface CreateDarkVeilPrivateStoreConfig {
  /** Connected wallet's address -- scopes storage per-account (SHA-256 hashed internally by the real provider). */
  accountId: string;
  /** Real password meeting the SDK's strength policy (validatePassword) -- see widget/password-derivation.ts. Can share the same underlying wallet signature as getMasterSignature below (different domain-separated hash of it), so only one wallet prompt is needed for both. */
  passwordProvider: () => string | Promise<string>;
  /**
   * Returns the hex signature over MASTER_SIGNATURE_DOMAIN from the
   * connected wallet (e.g. via wallet-connection.ts's signCardanoData).
   * Only called on a genuine cache miss -- a normal session with a warm
   * cache never prompts the wallet at all. Cached in-memory for the
   * lifetime of this store instance so a single session deriving both the
   * identity AND several launches' buy nonces still only prompts once.
   */
  getMasterSignature: () => Promise<string>;
  /** Passed through to levelPrivateStateProvider for test isolation (e.g. an in-memory level factory). Omit in production. */
  levelFactory?: LevelPrivateStateProviderConfig['levelFactory'];
}

// ============================================================================
// IMPLEMENTATION
// ============================================================================

export function createDarkVeilPrivateStore(config: CreateDarkVeilPrivateStoreConfig): DarkVeilPrivateStore {
  const provider = levelPrivateStateProvider<string, unknown>({
    privateStoragePasswordProvider: config.passwordProvider,
    accountId: config.accountId,
    ...(config.levelFactory ? { levelFactory: config.levelFactory } : {}),
  });

  // In-memory only (never persisted) -- reused within this store instance
  // so multiple cache misses in one session (identity + several buy
  // nonces) still only need one wallet signature prompt. Caches the
  // in-flight PROMISE, not the resolved value -- two concurrent cache
  // misses (e.g. getOrCreateIdentity and getOrCreateBuyNonce firing near-
  // simultaneously) must await the SAME wallet prompt, not each trigger
  // their own (found during audit: caching only the resolved value has
  // exactly this race). On rejection (e.g. the user declines the wallet
  // prompt), the cache is cleared so the next call retries fresh rather
  // than staying permanently stuck on one failed attempt.
  let signaturePromise: Promise<string> | null = null;
  function getMasterSignatureCached(): Promise<string> {
    if (signaturePromise === null) {
      signaturePromise = config.getMasterSignature().catch((err) => {
        signaturePromise = null;
        throw err;
      });
    }
    return signaturePromise;
  }

  async function readIdentityRecord(): Promise<StoredIdentity | null> {
    provider.setContractAddress(IDENTITY_SENTINEL_ADDRESS);
    return (await provider.get(IDENTITY_PRIVATE_STATE_ID)) as StoredIdentity | null;
  }

  async function getOrCreateIdentity(): Promise<DarkVeilIdentity> {
    const existing = await readIdentityRecord();
    if (existing) {
      return { userSecretKey: { bytes: hexToBytes(existing.secretKeyHex) } };
    }

    const masterSig = await getMasterSignatureCached();
    const userSecretKey: UserSecretKey = {
      bytes: deriveFromSignature(SK_DOMAIN, masterSig),
    };

    const stored: StoredIdentity = {
      secretKeyHex: bytesToHex(userSecretKey.bytes),
      knownLaunchHexes: [],
    };
    provider.setContractAddress(IDENTITY_SENTINEL_ADDRESS);
    await provider.set(IDENTITY_PRIVATE_STATE_ID, stored);
    return { userSecretKey };
  }

  async function recordKnownLaunch(launchContractAddressHex: string): Promise<void> {
    const record = await readIdentityRecord();
    if (!record) {
      throw new Error('recordKnownLaunch: no identity record exists yet');
    }
    if (record.knownLaunchHexes.includes(launchContractAddressHex)) return;
    const updated: StoredIdentity = {
      ...record,
      knownLaunchHexes: [...record.knownLaunchHexes, launchContractAddressHex],
    };
    provider.setContractAddress(IDENTITY_SENTINEL_ADDRESS);
    await provider.set(IDENTITY_PRIVATE_STATE_ID, updated);
  }

  async function getOrCreateBuyNonce(launchContractAddressHex: string): Promise<Uint8Array> {
    // Ensures the identity record (and its knownLaunchHexes list) exists
    // before this launch gets recorded into it.
    await getOrCreateIdentity();

    provider.setContractAddress(asContractAddress(launchContractAddressHex));
    const existingHex = (await provider.get(BUY_NONCE_PRIVATE_STATE_ID)) as string | null;
    if (existingHex) {
      return hexToBytes(existingHex);
    }

    const masterSig = await getMasterSignatureCached();
    const launchIdBytes = hexToBytes(launchContractAddressHex);
    const nonce = deriveFromSignature(BUY_NONCE_DOMAIN, masterSig, launchIdBytes);

    provider.setContractAddress(asContractAddress(launchContractAddressHex));
    await provider.set(BUY_NONCE_PRIVATE_STATE_ID, bytesToHex(nonce));
    await recordKnownLaunch(launchContractAddressHex);
    return nonce;
  }

  async function exportBackup(backupPassword: string): Promise<DarkVeilBackupBundle> {
    validatePassword(backupPassword);
    const options: ExportPrivateStatesOptions = { password: backupPassword };

    const record = await readIdentityRecord();
    if (!record) {
      throw new Error('exportBackup: no identity exists yet -- call getOrCreateIdentity first');
    }

    provider.setContractAddress(IDENTITY_SENTINEL_ADDRESS);
    const identity = await provider.exportPrivateStates(options);

    const buyNonces: DarkVeilBackupBundle['buyNonces'] = [];
    for (const launchContractAddressHex of record.knownLaunchHexes) {
      provider.setContractAddress(asContractAddress(launchContractAddressHex));
      const launchExport = await provider.exportPrivateStates(options);
      buyNonces.push({ launchContractAddressHex, export: launchExport });
    }

    return { identity, buyNonces };
  }

  async function importBackup(
    bundle: DarkVeilBackupBundle,
    backupPassword: string,
  ): Promise<ImportPrivateStatesResult[]> {
    validatePassword(backupPassword);
    const options: ImportPrivateStatesOptions = {
      password: backupPassword,
      conflictStrategy: 'overwrite',
    };

    const results: ImportPrivateStatesResult[] = [];

    provider.setContractAddress(IDENTITY_SENTINEL_ADDRESS);
    results.push(await provider.importPrivateStates(bundle.identity, options));

    for (const { launchContractAddressHex, export: launchExport } of bundle.buyNonces) {
      provider.setContractAddress(asContractAddress(launchContractAddressHex));
      results.push(await provider.importPrivateStates(launchExport, options));
    }

    return results;
  }

  return {
    getOrCreateIdentity,
    getOrCreateBuyNonce,
    exportBackup,
    importBackup,
    provider,
  };
}

/**
 * A password provider for a store that lives only as long as the process.
 *
 * Returns a PROVIDER, not a password, and the distinction is the whole point:
 * the store encrypts with whatever the provider returns and decrypts the same
 * way, so a provider that generates a fresh password each time it is called
 * encrypts under one key and then cannot read its own writes back. Generating
 * once and returning that same value is what makes the store usable.
 *
 * Per process rather than a fixed constant, because a fixed string is what ends
 * up copied into the next CLI and eventually into one whose store is not
 * ephemeral.
 *
 * The SDK requires characters from at least three of uppercase, lowercase,
 * digits and symbols, so one of each is included rather than left to chance in
 * the random part.
 */
export function ephemeralPrivateStatePassword(): () => string {
  // getRandomValues rather than node:crypto's randomBytes: this module is
  // reached from the browser widget as well as the CLIs, and a `node:` import
  // is not something a bundler can resolve for the browser at all. Both
  // runtimes have offered this same Web Crypto call as a global for years, and
  // it is a CSPRNG in both.
  // VALIDATED WITH THE SDK'S OWN CHECKER, not against a guess at its rules.
  //
  // `Aa1!` + 48 random hex characters satisfies the obvious requirements, and
  // usually passes — but random hex sometimes contains four identical
  // characters in a row, or a run like "1234"/"abcd", and the strength policy
  // rejects both. That makes this fail a few percent of the time, at a
  // different operation each run, with a different message each time, which
  // reads as anything except a bad password. It cost two misdiagnoses: once
  // blamed on a concurrent-runner race, once on network flakiness.
  //
  // Rather than encode the policy here — a second copy to drift from the real
  // one — generate and ASK. If the policy gains a rule, this keeps working.
  for (let attempt = 0; attempt < 32; attempt++) {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    const candidate = `Aa1!${bytesToHex(bytes)}`;
    try {
      validatePassword(candidate);
      return () => candidate;
    } catch {
      // Rejected on strength alone; draw again.
    }
  }
  // 32 consecutive rejections is not bad luck at these odds — it means the
  // policy now refuses this shape entirely, and silently returning an
  // unusable password would surface far from here.
  throw new Error(
    'could not generate a private-state password the SDK accepts after 32 attempts — ' +
      'the password policy has probably changed and this generator needs updating',
  );
}

/**
 * An in-memory store that keeps what is written to it for the life of the
 * process.
 *
 * The provider opens a database per operation and closes it again, so a factory
 * that constructs one each time hands every call its own empty database:
 * writes land in a database that is discarded immediately and reads see a fresh
 * one. Returning the same instance per name is what makes a value written by
 * one call readable by the next — which the signing key for a maintenance
 * update depends on, since it is set and then read back within one run.
 *
 * One factory per caller, not a module-level cache: two stores in the same
 * process are meant to be two stores.
 */
export function inMemoryLevelFactory(): (dbName: string) => never {
  const databases = new Map<string, unknown>();
  return (dbName: string) => {
    let database = databases.get(dbName);
    if (!database) {
      database = new MemoryLevel(dbName as never);
      databases.set(dbName, database);
    }
    return database as never;
  };
}
