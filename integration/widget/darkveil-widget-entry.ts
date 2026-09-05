// ============================================================================
// Noctis Zone — DarkVeil Private Buy Widget: browser entry point
// ============================================================================
// esbuild browser target (see ../build.mjs's widgetConfig) — bundled to
// assets/js/darkveil-widget.bundle.js in the theme, enqueued only on
// DarkVeil-phase page templates, following the exact pattern
// inc/enqueue.php already uses for page-create.php → create.js.
//
// Exposes window.NoctisDarkVeil, a plain object of async functions the
// theme's vanilla JS (no framework, per this project's standing rule) calls
// directly from DOM event handlers — same "global namespace object" shape
// as every other Noctis JS module (see assets/js/create.js's own pattern).
//
// HONEST SCOPE — read before wiring a template to this:
//
// 1. Every function below that touches Midnight state
//    (registerOnChain/submitBuyCommit/revealBuyCommit) needs a real
//    ContractProviders. `walletProvider`/`midnightProvider`/
//    `publicDataProvider` are built AUTOMATICALLY from the connected
//    Midnight wallet (see widget/midnight-wallet-bridge.ts, verified against
//    the real, official `midnightntwrk/example-zkloan` reference) — the
//    caller only needs to supply `midnightZk: { zkBaseUrl, proofServerUrl }`
//    via configure() (plain URLs — this bundle constructs the real
//    FetchZkConfigProvider/httpClientProofProvider objects internally, so
//    the WP theme's vanilla JS caller never imports an SDK class itself).
//    Both of those URLs point at real infrastructure Noctis must actually
//    operate, not just code: `zkBaseUrl` is a plain static file host (any
//    web host works — no backend logic needed); `proofServerUrl` is a real,
//    separately-running Midnight proof-server compute process. Confirmed
//    2026-07-15 via real Lace wallet source: wallet-delegated proving
//    (`getProvingProvider`) does NOT let Noctis skip operating that proof
//    server — Lace's own default proof-server address on every network,
//    including mainnet, is `http://localhost:6300` (expects one running on
//    the END USER's own machine), and the only real Foundation-hosted
//    remote option covers PreProd/Preview only, behind a manual per-user
//    opt-in, with no mainnet equivalent today. A caller who already has a
//    full hand-assembled ContractProviders can still pass `midnightProviders`
//    directly as a manual override; it takes priority over `midnightZk` if
//    both are supplied. Calling configure() with neither, or calling one of
//    these three functions without having connected a Midnight wallet,
//    throws a clear "not configured" error rather than silently doing
//    nothing or submitting something wrong.
//
// 2. claimTierB needs dvAmount/salt/merkleProof for the buyer's private
//    DarkVeil allocation — a DIFFERENT Merkle tree from registration's
//    allowlist (bonding_curve_tier_b.ak's dv_allocation_root, built by the
//    governor/relayer after DarkVeil closes). Resolved (2026-07-20):
//    darkveil-allocation.php now serves this for real — GET
//    /wp-json/np/v1/darkveil/allocation-proof?launch_id=...&cardano_address=...
//    returns { included, dvAmount, salt, merkleProof } for the calling
//    buyer's own allocation only. The caller should fetch from that
//    endpoint rather than supply these fields by hand.
//
// 3. claimTierB's underlying Lucid instance needs a Blockfrost API base URL
//    + project ID to run IN THE BROWSER (it signs with the buyer's own
//    connected wallet). Pointing `blockfrostUrl` directly at Blockfrost's
//    real API with a real project ID embedded in page config WOULD LEAK
//    THE KEY to anyone viewing page source. Resolved (2026-07-21): a
//    real, generic same-origin proxy now exists —
//    blockfrost-proxy.php's GET/POST /wp-json/np/v1/blockfrost-proxy/{path}
//    (GET forwards any Blockfrost read path; POST is restricted to exactly
//    tx/submit). configure() takes whatever blockfrostUrl it's given at
//    face value — callers MUST pass that proxy's base URL
//    (`<site>/wp-json/np/v1/blockfrost-proxy`), not Blockfrost's real API,
//    and any non-empty placeholder for blockfrostProjectId (the proxy
//    injects the real one server-side and ignores whatever the client
//    sends). This module still doesn't enforce that choice itself — it's a
//    deployment-time wiring responsibility, same as before, just no longer
//    blocked on the proxy not existing.
// ============================================================================

// Imported directly from @lucid-evolution/lucid rather than re-imported via
// darkveil-claim-submitter.ts's own local `Network as LucidNetwork` alias —
// that alias is never explicitly re-exported from that file (only used
// internally), so relying on it here worked by accident of TS's module
// resolution rather than a real public API of that module. Found during
// audit; importing the real type directly is the robust fix.
import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { createNoctisContractProviders } from '../contract-providers.js';
import { type BuyFlowContractParams, cancelBuyCommit, revealBuyCommit, submitBuyCommit } from './buy-flow.js';
import {
  type ClaimBundle,
  downloadClaimBundle,
  fetchClaimBundle,
  type NotIncluded,
  parseSavedClaimBundle,
} from './claim-bundle.js';
import { type ClaimTierBParams, claimTierBTokens } from './claim-flow.js';
import { buildMidnightWalletBridge } from './midnight-wallet-bridge.js';
import {
  type AllowlistStatus,
  checkEligibility,
  type EligibilityCheckResult,
  pollAllowlistProof,
  registerOnChain,
  submitRegistrationIntent,
} from './registration-flow.js';
import { type DarkVeilSession, listAvailableWallets, startDarkVeilSession } from './wallet-session.js';

// ============================================================================
// Configuration — set once per page load via configure(), before any other call.
// ============================================================================

export interface DarkVeilWidgetConfig {
  /** WordPress REST base, e.g. "https://noctis.example/wp-json/np/v1". */
  apiBase: string;
  /** Manual override: a fully hand-assembled ContractProviders. Takes priority over `midnightZk` below if both are supplied. */
  midnightProviders?: ContractProviders;
  /**
   * Automatic path: plain URLs, not pre-built SDK objects — the
   * caller (WP theme vanilla JS, per this project's standing rule) has no
   * business importing/constructing @midnight-ntwrk SDK classes itself;
   * this bundle does that internally. `walletProvider`/`midnightProvider`/
   * `publicDataProvider` are built automatically from the connected
   * Midnight wallet — see scope note 1.
   */
  midnightZk?: {
    /**
     * Static file host serving compiled ZK artifacts. Real, verified path
     * convention (from @midnight-ntwrk/midnight-js-fetch-zk-config-provider's
     * own source): `{zkBaseUrl}/keys/{circuitId}.prover`,
     * `{zkBaseUrl}/keys/{circuitId}.verifier`, `{zkBaseUrl}/zkir/{circuitId}.bzkir`.
     * Plain static files — any web host (including the WordPress host
     * itself, or a CDN in front of it) works; no backend logic needed.
     */
    zkBaseUrl: string;
    /**
     * URL of a running Midnight proof server (/check, /prove endpoints) —
     * a real compute service, NOT something this static file host can
     * double as. Confirmed via real Lace wallet source (2026-07-15): wallet-
     * delegated proving (getProvingProvider) does NOT let Noctis skip
     * operating this — Lace's own default proof-server address on every
     * network including mainnet is `http://localhost:6300` (i.e. it expects
     * ONE running on the end user's own machine), and the only real
     * Foundation-hosted remote option covers PreProd/Preview only, behind a
     * manual opt-in, with no mainnet equivalent today. Noctis must run and
     * operate its own proof-server process and put its URL here.
     */
    proofServerUrl: string;
  };
  /** For claimTierB (Cardano Launch only) — see scope note 3 above re: blockfrostUrl. */
  cardano?: {
    blockfrostProjectId: string;
    blockfrostUrl: string;
    network: LucidNetwork;
    compiledScriptCbor: string;
    /** The launch's thread-NFT policy id, hex, as rendered by the platform.
     *  The Cardano Launch curve UTXO the claim spends is authenticated against it. */
    threadNftPolicyId: string;
  };
}

let config: DarkVeilWidgetConfig | null = null;
let session: DarkVeilSession | null = null;

function requireConfig(): DarkVeilWidgetConfig {
  if (!config) throw new Error('NoctisDarkVeil.configure() must be called before any other method.');
  return config;
}

function requireSession(): DarkVeilSession {
  if (!session) throw new Error('NoctisDarkVeil.connectWallets() must be called before this method.');
  return session;
}

// Cached so a page performing several Midnight actions in a row (register,
// then later reveal) doesn't rebuild the wallet bridge — and doesn't prompt
// getConfiguration()/re-derive providers — on every single call.
let cachedProviders: ContractProviders | null = null;

async function requireMidnightProviders(): Promise<ContractProviders> {
  const cfg = requireConfig();
  if (cfg.midnightProviders) return cfg.midnightProviders;

  if (!cfg.midnightZk) {
    throw new Error(
      'This action needs Midnight contract providers — supply either `midnightProviders` (full manual override) or `midnightZk` (zkBaseUrl + proofServerUrl) via configure(). See darkveil-widget-entry.ts scope note 1.',
    );
  }
  const s = requireSession();
  if (!s.midnight) {
    throw new Error(
      'This action needs a connected Midnight wallet — call connectWallets() with a midnightWalletId first.',
    );
  }
  if (cachedProviders) return cachedProviders;

  const bridge = await buildMidnightWalletBridge({
    connection: s.midnight.api,
    shieldedCoinPublicKey: s.midnight.shieldedCoinPublicKey,
    shieldedEncryptionPublicKey: s.midnight.shieldedEncryptionPublicKey,
  });
  // Real, verified constructors (see DarkVeilWidgetConfig.midnightZk's own
  // doc comments for the exact path convention / infra requirement each
  // one implies) — built here, inside the bundle, so the WP theme's
  // vanilla JS caller only ever deals in plain URLs.
  const zkConfigProvider = new FetchZkConfigProvider<string>(cfg.midnightZk.zkBaseUrl);
  const proofProvider = httpClientProofProvider(cfg.midnightZk.proofServerUrl, zkConfigProvider);
  cachedProviders = createNoctisContractProviders({
    privateStore: s.privateStore,
    publicDataProvider: bridge.publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider: bridge.walletProvider,
    midnightProvider: bridge.midnightProvider,
  });
  return cachedProviders;
}

// ============================================================================
// Public API — window.NoctisDarkVeil
// ============================================================================

function configure(newConfig: DarkVeilWidgetConfig): void {
  config = newConfig;
  cachedProviders = null;
}

async function connectWallets(
  cardanoWalletId: string,
  midnightWalletId?: string,
): Promise<{
  cardanoAddress: string;
  midnightUnshieldedAddress: string | null;
}> {
  session = await startDarkVeilSession(cardanoWalletId, midnightWalletId);
  cachedProviders = null;
  return {
    cardanoAddress: session.cardano.address,
    midnightUnshieldedAddress: session.midnight?.unshieldedAddress ?? null,
  };
}

async function checkMyEligibility(creatorAddress: string): Promise<EligibilityCheckResult> {
  const s = requireSession();
  const { apiBase } = requireConfig();
  return checkEligibility(apiBase, s.cardano.address, creatorAddress);
}

async function submitIntent(launchId: string): Promise<{ ok: boolean; queued: boolean }> {
  const s = requireSession();
  const { apiBase } = requireConfig();
  return submitRegistrationIntent(apiBase, s, launchId);
}

async function checkAllowlistStatus(launchId: string): Promise<AllowlistStatus> {
  const s = requireSession();
  const { apiBase } = requireConfig();
  return pollAllowlistProof(apiBase, s, launchId);
}

async function register(params: {
  tier: 'B' | 'C';
  contractAddress: string;
  launchIdHex: string;
  bondAmount: bigint;
  allowlistProof: AllowlistStatus;
}) {
  const s = requireSession();
  if (!params.allowlistProof.included) {
    throw new Error('Not yet included in the allowlist — check back later, the governor batch run is periodic.');
  }
  const providers = await requireMidnightProviders();
  return registerOnChain(s, {
    tier: params.tier,
    contractAddress: params.contractAddress,
    launchIdBytes: hexToBytes(params.launchIdHex),
    bondAmount: params.bondAmount,
    merkleProof: params.allowlistProof.proof,
    providers,
  });
}

async function buyCommit(params: {
  tier: 'B' | 'C';
  contractAddress: string;
  launchIdHex: string;
  merkleProof: BuyFlowContractParams['merkleProof'];
  tokenAmount: bigint;
  pricePerToken: bigint;
  timestamp: bigint;
}) {
  const s = requireSession();
  const providers = await requireMidnightProviders();
  return submitBuyCommit(s, {
    tier: params.tier,
    contractAddress: params.contractAddress,
    launchIdBytes: hexToBytes(params.launchIdHex),
    merkleProof: params.merkleProof,
    providers,
    tokenAmount: params.tokenAmount,
    pricePerToken: params.pricePerToken,
    timestamp: params.timestamp,
  });
}

async function revealCommit(params: {
  tier: 'B' | 'C';
  contractAddress: string;
  launchIdHex: string;
  merkleProof: BuyFlowContractParams['merkleProof'];
  tokenAmount: bigint;
  pricePerToken: bigint;
  // Fix (2026-07-30): required now that Cardano Launch's revealBuyCommit
  // enforces a real 30-day reveal-window deadline — same caller-supplied
  // "now" convention buyCommit's own timestamp already uses above.
  currentTimestamp: bigint;
}) {
  const s = requireSession();
  const providers = await requireMidnightProviders();
  return revealBuyCommit(s, {
    tier: params.tier,
    contractAddress: params.contractAddress,
    launchIdBytes: hexToBytes(params.launchIdHex),
    merkleProof: params.merkleProof,
    providers,
    tokenAmount: params.tokenAmount,
    pricePerToken: params.pricePerToken,
    currentTimestamp: params.currentTimestamp,
  });
}

async function cancelCommit(params: {
  tier: 'B' | 'C';
  contractAddress: string;
  launchIdHex: string;
  merkleProof: BuyFlowContractParams['merkleProof'];
  tokenAmount: bigint;
  pricePerToken: bigint;
}) {
  const s = requireSession();
  const providers = await requireMidnightProviders();
  return cancelBuyCommit(s, {
    tier: params.tier,
    contractAddress: params.contractAddress,
    launchIdBytes: hexToBytes(params.launchIdHex),
    merkleProof: params.merkleProof,
    providers,
    tokenAmount: params.tokenAmount,
    pricePerToken: params.pricePerToken,
  });
}

async function claimTierB(launchId: Uint8Array, walletApi: WalletApi, claimParams: ClaimTierBParams) {
  const { cardano } = requireConfig();
  if (!cardano) {
    throw new Error(
      'claimTierB needs cardano config (blockfrost + compiled script) — see darkveil-widget-entry.ts scope note 3.',
    );
  }
  return claimTierBTokens(
    {
      blockfrostProjectId: cardano.blockfrostProjectId,
      blockfrostUrl: cardano.blockfrostUrl,
      network: cardano.network,
      compiledScriptCbor: cardano.compiledScriptCbor,
      threadNftPolicyId: cardano.threadNftPolicyId,
      launchId,
    },
    walletApi,
    claimParams,
  );
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * A buyer's own claim record, from the platform, verified before it is handed
 * over. The platform serves one buyer their own leaf and nothing else, which
 * is what keeps the rest of the roster private; the record is also the
 * thing the buyer is asked to save, because it cannot be rebuilt from the
 * chain once the platform's copy is gone.
 */
async function fetchMyClaimBundle(launchId: string, cardanoAddress: string): Promise<ClaimBundle | NotIncluded> {
  const { apiBase } = requireConfig();
  return fetchClaimBundle(apiBase, launchId, cardanoAddress);
}

const NoctisDarkVeil = {
  configure,
  fetchMyClaimBundle,
  downloadClaimBundle,
  parseSavedClaimBundle,
  listAvailableWallets,
  connectWallets,
  checkMyEligibility,
  submitIntent,
  checkAllowlistStatus,
  register,
  buyCommit,
  revealCommit,
  cancelCommit,
  claimTierB,
};

declare global {
  interface Window {
    NoctisDarkVeil: typeof NoctisDarkVeil;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisDarkVeil = NoctisDarkVeil;
}

export default NoctisDarkVeil;
