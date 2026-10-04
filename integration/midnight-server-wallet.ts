// ============================================================================
// Noctis Zone — server-side (headless) Midnight wallet + provider bridge
// ============================================================================
// (2026-07-21): registerForDarkVeil needs a governor-published allowlist
// root (updateAllowlistRoot, a governor-only Compact circuit) — but every
// existing wallet/provider bridge in this codebase (widget/midnight-wallet-
// bridge.ts) is built from a CONNECTED BROWSER wallet's dapp-
// connector API. A server-side CLI has no browser wallet to connect to. This
// module builds the two providers a Node process CAN build itself — a real
// WalletProvider + MidnightProvider pair — from a raw 32-byte seed held
// server-side, with no dapp-connector/browser involvement at all.
//
// Verified against real source before writing (not recalled/assumed,
// per this project's own Midnight-SDK discipline): midnight-js-contracts'
// ContractProviders is a plain structural type (MidnightProviders) with no
// hidden runtime dependency on a browser — confirmed by reading
// midnightntwrk/midnight-js's packages/contracts/src/contract-providers.ts
// and packages/types/src/providers.ts directly. The construction pattern
// below (HDWallet -> ShieldedWallet/UnshieldedWallet/DustWallet ->
// WalletFacade) is the midnight-wallet:managing-test-wallets /
// midnight-wallet:wallet-sdk skills' own verified, STABLE-channel pattern
// (@midnight-ntwrk/wallet-sdk-hd@3.0.2, wallet-sdk-facade@4.0.1, etc. — all
// checked against the real npm registry, not the unreleased 5.0.0-beta/
// wallet-sdk@2.0.0-beta channel a first pass at this research surfaced and
// correctly rejected as unsafe to depend on).
//
// WalletProvider.balanceTx / MidnightProvider.submitTx are single-method
// interfaces; WalletFacade exposes a more granular multi-step pipeline
// (balance -> sign -> prove/finalize -> submit). The adapter class below
// chains WalletFacade's real methods (balanceUnboundTransaction ->
// signRecipe -> finalizeRecipe for balanceTx; submitTransaction for
// submitTx) to satisfy the single-method interfaces midnight-js-contracts
// actually requires.
//
// SCOPE (2026-08-12): this now runs against real Preprod. Wallets built here
// have submitted real transactions — DUST generation registration for the whole
// test set — against an operated proof server, and their registration state is
// confirmed from the chain rather than from the wallet's own view.
//
// A wallet is returned STARTED, not fully synced, and the difference matters:
// see buildServerWallet's own note. Callers that need a balance rather than
// keys must wait for that specific condition, and callers that pay a fee should
// resume from a snapshot — see midnight-wallet-state-store.ts.
// ============================================================================

import WebSocket from 'ws';

const globalWithWebSocket = globalThis as typeof globalThis & { WebSocket?: typeof WebSocket };
globalWithWebSocket.WebSocket = globalWithWebSocket.WebSocket ?? WebSocket;

import * as ledger from '@midnight-ntwrk/ledger-v8';
// FinalizedTransaction/CoinPublicKey/EncPublicKey are declared but not
// re-exported from midnight-js-types' own top-level index — import from
// their real source instead (the same module wallet-provider.d.ts itself
// imports them from).
import type { CoinPublicKey, EncPublicKey, FinalizedTransaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { MidnightProvider, UnboundTransaction, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  type DefaultConfiguration,
  type FacadeState,
  WalletEntrySchema,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { describeError } from './error-detail.js';
import {
  type SnapshotGuards,
  type SubWalletKind,
  seedFingerprintOf,
  WalletStateStore,
  walletSdkVersion,
} from './midnight-wallet-state-store.js';

export type MidnightNetwork = 'undeployed' | 'preview' | 'preprod' | 'mainnet';

/**
 * How long to wait for the facade's first state emission. Generous, because it
 * covers process start and the initial indexer connection — but bounded, so a
 * dead endpoint surfaces as an error instead of a hang.
 */
const FIRST_STATE_TIMEOUT_MS = 120_000;

export interface ServerWalletNetworkConfig {
  network: MidnightNetwork;
  /** wss://... (or ws://localhost:9944 for a local devnet) */
  relayUrl: string;
  /** http://... — the operated proof-server this launch's platform config points at. */
  provingServerUrl: string;
  indexerHttpUrl: string;
  indexerWsUrl: string;
  /**
   * Fee safety margin. **This is an exponent, not a multiplier** — the ledger's
   * own `feesWithMargin` warns that "it is very easy to get a completely
   * unreasonable margin here".
   *
   * It buys headroom against the fee rate rising between building a transaction
   * and it landing. Raising it costs more than it looks: a big transaction with
   * a large margin computes a fee past what a block can hold, and the node
   * rejects it as FeeCalculation.BlockLimitExceeded (232) — a failure that reads
   * like the transaction is too big when it is the margin that is too generous.
   *
   * Defaults are set per network below; override only with a reason.
   */
  feeBlocksMargin?: number;
}

/**
 * Real per-network endpoint defaults, verified against
 * midnight-wallet:managing-test-wallets' network-config.md. `mainnet`'s
 * real hostnames are not yet independently confirmed by this codebase (no
 * mainnet deployment exists yet) — callers targeting mainnet should
 * override relayUrl/indexerHttpUrl/indexerWsUrl explicitly rather than
 * trust a guessed hostname.
 */
export function defaultNetworkConfig(network: MidnightNetwork, provingServerUrl: string): ServerWalletNetworkConfig {
  switch (network) {
    case 'undeployed':
      return {
        network,
        relayUrl: 'ws://localhost:9944',
        provingServerUrl,
        indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
        indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
      };
    case 'preprod':
      return {
        network,
        relayUrl: 'wss://rpc.preprod.midnight.network',
        provingServerUrl,
        indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v3/graphql',
        indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
      };
    case 'preview':
      return {
        network,
        relayUrl: 'wss://rpc.preview.midnight.network',
        provingServerUrl,
        indexerHttpUrl: 'https://indexer.preview.midnight.network/api/v3/graphql',
        indexerWsUrl: 'wss://indexer.preview.midnight.network/api/v3/graphql/ws',
      };
    case 'mainnet':
      throw new Error(
        'No confirmed mainnet Midnight endpoint hostnames exist in this codebase yet — pass an explicit ServerWalletNetworkConfig rather than relying on this default.',
      );
  }
}

/** Endpoints a CLI input may name in place of its network's defaults. */
export interface NetworkEndpointOverrides {
  relayUrl?: string;
  indexerHttpUrl?: string;
  indexerWsUrl?: string;
}

/**
 * The network's defaults with any endpoint the input names put in their place.
 *
 * An indexer is the usual reason to name one: a wallet's sync cursor is
 * numbered by the indexer that served it, so a wallet synced through one
 * provider has to replay from genesis through another, and the CLI that
 * resumes it must reach the same one. Mainnet has no defaults here, so all
 * three must be named there.
 */
export function resolveNetworkConfig(
  network: MidnightNetwork,
  provingServerUrl: string,
  overrides: NetworkEndpointOverrides = {},
): ServerWalletNetworkConfig {
  const defaults = network === 'mainnet' ? undefined : defaultNetworkConfig(network, provingServerUrl);
  const relayUrl = overrides.relayUrl || defaults?.relayUrl;
  const indexerHttpUrl = overrides.indexerHttpUrl || defaults?.indexerHttpUrl;
  const indexerWsUrl = overrides.indexerWsUrl || defaults?.indexerWsUrl;
  if (!relayUrl || !indexerHttpUrl || !indexerWsUrl) {
    throw new Error(`relayUrl/indexerHttpUrl/indexerWsUrl must be supplied explicitly for network "${network}".`);
  }
  return { network, relayUrl, provingServerUrl, indexerHttpUrl, indexerWsUrl };
}

/**
 * WalletProvider + MidnightProvider adapter wrapping a real WalletFacade.
 * Verified against midnight-wallet:wallet-sdk's transactions.md and the
 * skill's own runnable transfer-flow.ts example — same
 * balanceUnboundTransaction -> signRecipe -> finalizeRecipe -> submitTransaction
 * chain that example uses for a real unshielded (signed) transfer.
 * updateAllowlistRoot's underlying transaction is unshielded (a plain
 * governor-authorized ledger call, not a private coin transfer), so the
 * signRecipe step is required here, same as that example's NIGHT transfer.
 */
class ServerWalletProvider implements WalletProvider, MidnightProvider {
  constructor(
    private readonly wallet: WalletFacade,
    private readonly shieldedSecretKeys: ledger.ZswapSecretKeys,
    private readonly dustSecretKey: ledger.DustSecretKey,
    private readonly unshieldedKeystore: ReturnType<typeof createKeystore>,
    // CoinPublicKey/EncPublicKey (@midnight-ntwrk/midnight-js-types) are
    // plain hex strings — real coin/encryption key TYPES here
    // (ShieldedCoinPublicKey/ShieldedEncryptionPublicKey, from
    // @midnight-ntwrk/wallet-sdk-address-format) are converted via their
    // own real .toHexString() before being stored.
    private readonly coinPublicKey: CoinPublicKey,
    private readonly encryptionPublicKey: EncPublicKey,
  ) {}

  getCoinPublicKey(): CoinPublicKey {
    return this.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.encryptionPublicKey;
  }

  async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      tx,
      {
        shieldedSecretKeys: this.shieldedSecretKeys,
        dustSecretKey: this.dustSecretKey,
      },
      // WalletFacade's own options require a concrete ttl — default to a
      // generous 1-hour window when the caller (WalletProvider.balanceTx's
      // own ttl parameter is optional) didn't supply one.
      { ttl: ttl ?? new Date(Date.now() + 3600_000) },
    );
    const signed = await this.wallet.signRecipe(recipe, (payload: Uint8Array) =>
      this.unshieldedKeystore.signData(payload),
    );
    return (await this.wallet.finalizeRecipe(signed)) as FinalizedTransaction;
  }

  async submitTx(tx: FinalizedTransaction): Promise<string> {
    if (process.env.NP_TX_COST) {
      process.stderr.write(`${describeTransactionCost(tx)}\n`);
    }
    return await submitWithReconnect((transaction) => this.wallet.submitTransaction(transaction), tx);
  }
}

/**
 * Errors that mean the node connection died, rather than that the node said no.
 *
 * Matched against the WHOLE failure chain. The word identifying a dropped
 * socket sits two or three layers down — "Transaction submission error"
 * wrapping "Transaction submission failed" wrapping the disconnect itself — so
 * a check reading only the message, or one level of cause, finds none of the
 * terms it looks for and mistakes a dropped connection for a refusal.
 */
function isLostConnection(err: unknown): boolean {
  return /disconnect|Transport error|not connected|socket|ECONNRESET|closed/i.test(describeError(err));
}

/**
 * Submit, and try again if the node connection was lost rather than the
 * transaction refused.
 *
 * The submission service opens its websocket to the node when the wallet is
 * built, then nothing uses it until a transaction is ready. Balancing a
 * transaction includes proving it, which takes long enough that a public
 * endpoint may close the connection as idle in the meantime — a clean close, so
 * the first submission after a long proof finds a socket that is already gone.
 * The provider reconnects on its own within a few seconds, so what this needs
 * is another attempt, not another proof.
 *
 * Retrying is safe because the transaction is already final: a second attempt
 * carries the identical extrinsic, which a node recognises as one it has
 * already seen rather than as a second transaction. A refusal is not retried —
 * it would be refused again for the same reason.
 */
export async function submitWithReconnect<T>(
  submit: (tx: T) => Promise<string>,
  tx: T,
  { attempts = 4, delayMs = 3_000, sleep = defaultSleep }: SubmitRetryOptions = {},
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await submit(tx);
    } catch (err) {
      lastError = err;
      if (!isLostConnection(err) || attempt === attempts) {
        throw err;
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export interface SubmitRetryOptions {
  attempts?: number;
  /** Long enough for the provider's own reconnect to have completed. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resume this wallet from a stored snapshot instead of replaying chain history.
 *
 * See midnight-wallet-state-store.ts for why that matters: the dust sub-wallet's
 * replay may not finish inside one process, and a snapshot lets the next process
 * continue rather than restart.
 */
export interface ServerWalletSnapshotOptions {
  store: WalletStateStore;
  /** Stable per-wallet key — this project uses the role name (`buyer_3`). */
  accountId: string;
  /**
   * Cold-start the dust sub-wallet even when a snapshot exists, restoring the
   * other two normally.
   *
   * A stored dust snapshot can reference Merkle roots the node has since dropped
   * from its recent-root history. The wallet then holds dust it cannot prove
   * against anything the node still recognises, and the node rejects the
   * transaction as `Zswap.Invalid.UnknownMerkleRoot` (241) — whose documented fix
   * is to resync against the current head and rebuild. Re-reading dust from chain
   * costs the replay this module exists to avoid, so it stays an explicit escape
   * hatch, not a default.
   *
   * Note this is a DIFFERENT failure from `NotNormalized` (117), which is a
   * zero-fee problem on an idle chain and is handled by the cost parameters
   * below. Confusing the two sends you looking in the wrong place.
   */
  dustColdStart?: boolean;
  onRestore?: (restored: readonly SubWalletKind[]) => void;
}

/** The fields a CLI needs to accept for its wallet to resume from a snapshot. */
export interface SnapshotCliInput {
  /** Directory holding snapshots. Must be outside the repository. */
  snapshotDir?: string;
  snapshotPassphrase?: string;
  /**
   * Pass through to {@link ServerWalletSnapshotOptions.dustColdStart}.
   *
   * Exposed on every CLI rather than only the sync one, because the CLIs that
   * PAY a fee are exactly the ones a stale dust snapshot stops — so the
   * documented remedy has to be reachable from the command that hits the
   * problem, not only from a separate one run beforehand.
   */
  dustColdStart?: boolean;
  /**
   * Which wallet's snapshot to resume — overriding the CLI's own default.
   *
   * A CLI that always pays from one wallet can name it once and never think
   * about this. A CLI that pays from a DIFFERENT wallet per invocation cannot:
   * it must say which, because a snapshot belongs to a specific seed. Asking
   * for the wrong one is not a silent no-op that costs a little time — the
   * seed fingerprint guard rejects it, the wallet falls back to replaying the
   * whole chain, and on a public testnet that does not finish inside any
   * sensible budget.
   */
  snapshotAccountId?: string;
}

/**
 * Build snapshot options from a CLI's own input, or undefined if it did not ask
 * for them.
 *
 * Every CLI that pays a DUST fee needs its wallet to have replayed far enough to
 * see that DUST, so they all want the same opt-in on the same two fields. This
 * keeps that wiring identical between them instead of separately reinvented.
 *
 * Both fields are required together: a snapshot directory without the passphrase
 * that wrote it can only produce snapshots nothing can read back.
 *
 * `accountId` is the CLI's default. `input.snapshotAccountId` overrides it, for
 * the CLIs whose paying wallet changes per invocation — see that field.
 */
export function snapshotOptionsFrom(
  input: SnapshotCliInput,
  accountId: string,
  log?: (message: string) => void,
): ServerWalletSnapshotOptions | undefined {
  if (!input.snapshotDir || !input.snapshotPassphrase) return undefined;
  const resolved = input.snapshotAccountId ?? accountId;
  return {
    store: new WalletStateStore(input.snapshotDir, input.snapshotPassphrase),
    accountId: resolved,
    dustColdStart: input.dustColdStart,
    onRestore: (restored) => log?.(`${resolved}: resumed ${restored.join(', ')} from snapshot`),
  };
}

export interface ServerWallet {
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
  /** Real WalletFacade instance — kept for callers that need waitForSyncedState()/state() directly. */
  facade: WalletFacade;
  /** Identifies this wallet/network/SDK combination for snapshot save and load. */
  snapshotGuards: SnapshotGuards;
  /** Which sub-wallets resumed from a snapshot. Empty when everything replayed from chain. */
  restoredFrom: readonly SubWalletKind[];
  /**
   * The unshielded keystore this wallet was derived from. DUST generation
   * registration is signed by the NIGHT key rather than balanced like an
   * ordinary transaction, so it needs the verifying key and a signing
   * callback that only the keystore can give — see cli/midnight-register-dust.ts.
   */
  unshieldedKeystore: ReturnType<typeof createKeystore>;
  /** Must be called when done — stops the facade's background sync/subscriptions. */
  shutdown(): Promise<void>;
}

/**
 * Resolve on the first facade state that satisfies `predicate`.
 *
 * Subscribes to the facade's own state observable rather than importing rxjs,
 * which is present only transitively here and is not a declared dependency of
 * this workspace.
 *
 * Rejects on timeout rather than hanging: every caller of this is a CLI, and a
 * CLI that waits forever is indistinguishable from one that crashed.
 */
export function waitForWalletState(
  facade: WalletFacade,
  predicate: (state: FacadeState) => boolean,
  timeoutMs: number,
  description: string,
): Promise<FacadeState> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: { unsubscribe(): void } | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      // May be undefined if the observable emitted synchronously on subscribe;
      // the trailing unsubscribe below covers that case.
      subscription?.unsubscribe();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.`))),
      timeoutMs,
    );

    subscription = facade.state().subscribe({
      next: (state) => {
        if (predicate(state)) finish(() => resolve(state));
      },
      error: (err) => finish(() => reject(err)),
    });

    if (settled) subscription.unsubscribe();
  });
}

/** True once this wallet can see at least one unshielded NIGHT UTXO of its own. */
export function hasUnshieldedNight(state: FacadeState): boolean {
  const nightTokenType = ledger.nativeToken().raw;
  return state.unshielded.availableCoins.some((coin) => coin.utxo.type === nightTokenType);
}

/**
 * Builds a real, started, server-side wallet + the two ContractProviders
 * fields a Node CLI needs to sign and submit a governor-authorized circuit
 * call, from a raw 32-byte seed.
 *
 * Started, deliberately not fully synced. `waitForSyncedState()` waits for all
 * three sub-wallets to reach the chain tip, and on preprod the dust sub-wallet
 * does not get there in reasonable time or memory: measured, it advances at
 * ~250 offsets/sec while its serialized state grows ~1.6 KB/s without
 * collapsing (upstream midnightntwrk/midnight-wallet#639), which put two
 * earlier runs into a JavaScript heap OOM before they reached the tip.
 *
 * The keys read below are derived, not synced, so the first emitted state
 * carries them. Callers that need more than keys — an unshielded balance, a
 * spendable coin — should wait for that specific condition with
 * `waitForWalletState`, which is both faster and honest about what it needs.
 *
 * This is the wallet that PAYS DUST fees for the transaction — a SEPARATE
 * concern from the governor's Compact WITNESS secret (getGovernorSecret(),
 * checked in-circuit against the contract's pinned governorKey). Either the
 * same 32 bytes or two entirely different secrets may be used for the two
 * roles; nothing on-chain requires them to match. See publish-allowlist-
 * root.ts's own header for how this project's CLI wires the two together.
 */
export async function buildServerWallet(
  seed: Uint8Array,
  config: ServerWalletNetworkConfig,
  snapshot?: ServerWalletSnapshotOptions,
): Promise<ServerWallet> {
  const seedBuffer = Buffer.from(seed);

  const hdResult = HDWallet.fromSeed(seedBuffer);
  if (hdResult.type !== 'seedOk') {
    throw new Error(`buildServerWallet: invalid seed (${JSON.stringify(hdResult)})`);
  }

  const derivationResult = hdResult.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
    .deriveKeysAt(0);
  hdResult.hdWallet.clear();
  if (derivationResult.type !== 'keysDerived') {
    throw new Error(`buildServerWallet: key derivation failed (${JSON.stringify(derivationResult)})`);
  }

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], config.network);

  const walletConfiguration: DefaultConfiguration = {
    networkId: config.network,
    // Two independent knobs, and an earlier version of this comment ran them
    // together. Keeping the correction visible because the failure it caused
    // was expensive to diagnose.
    //
    // feeBlocksMargin is an EXPONENT (see ServerWalletNetworkConfig), so it
    // scales the computed fee steeply. A deploy carrying a large circuit,
    // priced with a generous margin, computes a fee no block can hold and is
    // rejected as 232. Measured on Preprod: this contract's deploy fails at 5
    // and needs a small margin. That is why the margin is 1 off devnet.
    //
    // additionalFeeOverhead is a small ADDITIVE floor, and it does a different
    // job: it guarantees the fee is not zero. A zero fee gives the balancer no
    // imbalance to cover, so it selects no DUST inputs and builds an empty
    // DustActions, which the ledger rejects as NotNormalized (117).
    //
    // The old comment asserted that only a local devnet needs the floor,
    // because a real network "has a real fee rate". That does not hold: a
    // testnet's fee rate is demand-driven and an idle Preprod computes zero
    // just as a fresh devnet does. Observed directly — the same reveal circuit
    // that submitted successfully earlier in the day was rejected with 117 once
    // the chain went quiet, with nothing about the call changed.
    //
    // So the floor applies everywhere. It cannot reintroduce 232: it is a
    // fixed addend of 1e6 atomic units against a wallet holding ~1.1e18, and
    // the exponent is what drives a fee toward the block limit, not this.
    costParameters: {
      feeBlocksMargin: config.feeBlocksMargin ?? (config.network === 'undeployed' ? 5 : 1),
      additionalFeeOverhead: 1_000_000n,
    },
    relayURL: new URL(config.relayUrl),
    provingServerUrl: new URL(config.provingServerUrl),
    indexerClientConnection: {
      indexerHttpUrl: config.indexerHttpUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };

  const snapshotGuards: SnapshotGuards = {
    sdkVersion: walletSdkVersion(),
    networkId: config.network,
    seedFingerprint: seedFingerprintOf(seed),
  };

  // Null whenever no snapshot was requested, none exists, or any guard failed —
  // all of which simply mean this wallet replays from chain.
  const stored = snapshot ? await snapshot.store.load(snapshot.accountId, snapshotGuards) : null;
  const restoredFrom: SubWalletKind[] = [];

  const facade = await WalletFacade.init({
    configuration: walletConfiguration,
    shielded: (cfg) => {
      if (stored?.shielded) {
        restoredFrom.push('shielded');
        return ShieldedWallet(cfg).restore(stored.shielded);
      }
      return ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys);
    },
    unshielded: (cfg) => {
      if (stored?.unshielded) {
        restoredFrom.push('unshielded');
        return UnshieldedWallet(cfg).restore(stored.unshielded);
      }
      return UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
    },
    dust: (cfg) => {
      if (stored?.dust && !snapshot?.dustColdStart) {
        restoredFrom.push('dust');
        return DustWallet(cfg).restore(stored.dust);
      }
      return DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
    },
  });

  if (restoredFrom.length > 0) snapshot?.onRestore?.(restoredFrom);

  await facade.start(shieldedSecretKeys, dustSecretKey);
  const state = await waitForWalletState(
    facade,
    () => true,
    FIRST_STATE_TIMEOUT_MS,
    'the wallet to emit its first state',
  );

  const provider = new ServerWalletProvider(
    facade,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    state.shielded.coinPublicKey.toHexString() as CoinPublicKey,
    state.shielded.encryptionPublicKey.toHexString() as EncPublicKey,
  );

  return {
    walletProvider: provider,
    midnightProvider: provider,
    unshieldedKeystore,
    facade,
    snapshotGuards,
    restoredFrom,
    shutdown: () => facade.stop(),
  };
}

/**
 * What a finished transaction costs, against the limits a block enforces.
 *
 * The node refuses a transaction that would exhaust a block without saying
 * which of the five dimensions it exhausted, and the answer is not guessable:
 * a deploy is dominated by bytes written, while proof verification is paid for
 * in compute time. Measuring the real balanced-and-proven transaction is the
 * only way to know which one to attack.
 */
export function describeTransactionCost(tx: unknown): string {
  const priced = tx as { cost?: (params: ledger.LedgerParameters) => Record<string, bigint> };
  if (typeof priced.cost !== 'function') {
    return 'transaction cost: unavailable (this transaction type does not price itself)';
  }
  const limits: Record<string, bigint> = {
    readTime: 2_000_000_000_000n,
    computeTime: 2_000_000_000_000n,
    blockUsage: 1_000_000n,
    bytesWritten: 50_000n,
    bytesChurned: 50_000_000n,
  };
  try {
    const cost = priced.cost(ledger.LedgerParameters.initialParameters());
    const parts = Object.entries(limits).map(([dimension, limit]) => {
      const used = cost[dimension] ?? 0n;
      const percent = (Number(used) / Number(limit)) * 100;
      return `${dimension} ${used}/${limit} (${percent.toFixed(1)}%)${percent > 100 ? ' OVER' : ''}`;
    });
    return `transaction cost: ${parts.join('  ')}`;
  } catch (err) {
    return `transaction cost: could not be computed (${describeError(err)})`;
  }
}

/**
 * Refuse to start if the proof server cannot be reached.
 *
 * Everything expensive happens before a proof is requested: the wallet resumes,
 * catches up to the chain head, and the transaction is balanced. Only then does
 * the proof server get its first request, so an unreachable one is discovered a
 * minute or two in, as a proving failure that names neither the server nor the
 * reason.
 *
 * This is worth a check rather than a comment because the failure is real and
 * intermittent here: the proof server runs inside WSL and is reached over
 * mirrored networking, and that mapping has been observed to stop forwarding
 * while the VM itself stays up — /health answers, then minutes later the same
 * URL refuses a connection, then answers again once any wsl.exe command runs.
 * `local/preprod-harness/wsl-keepalive.ps1` holds it open; this makes its
 * absence obvious immediately instead of expensively.
 *
 * A request also warms the connection, which is the state the later proof wants.
 */
export async function assertProofServerReachable(provingServerUrl: string, timeoutMs = 10_000): Promise<void> {
  const health = new URL('/health', provingServerUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(health, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${health} answered ${response.status}.`);
    }
  } catch (err) {
    throw new Error(
      `The proof server at ${provingServerUrl} is not reachable, so this would fail after ` +
        'several minutes of work rather than now.\n' +
        `  cause: ${describeError(err)}\n` +
        '  If it runs under WSL, any wsl.exe command wakes the mapping, and ' +
        'local/preprod-harness/wsl-keepalive.ps1 holds it open for the length of an operation.',
    );
  } finally {
    clearTimeout(timer);
  }
}
