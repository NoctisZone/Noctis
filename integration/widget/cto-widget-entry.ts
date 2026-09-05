// ============================================================================
// Noctis Zone — CTO Governance widget: browser entry point
// ============================================================================
// Exposes window.NoctisCto, a plain object of async functions the theme's
// vanilla-JS glue (assets/js/cto-vote.js) calls. Same shape and same rules as
// darkveil-widget-entry.ts: the theme deals in plain strings and URLs; every
// SDK object is built in here.
//
// Two wallets, two jobs. The CARDANO wallet is the holder's identity — its
// signature derives the launch-scoped voting key, and it proves control of the
// address the governor snapshotted. The MIDNIGHT wallet pays for and submits
// the vote transaction. A holder without a Midnight wallet can still register
// and see their voting power; they need one to cast the vote itself.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import type { CtoGovernanceSnapshot } from '../midnight-public-state.js';
import {
  connectMidnightWallet,
  detectMidnightWallets,
  type MidnightWalletConnection,
  type WalletInfo,
} from '../wallet-connection.js';
import { type CtoSession, listAvailableCardanoWallets, startCtoSession } from './cto-session.js';
import {
  bytesToHex,
  type CastVoteResult,
  castVoteFromBrowser,
  fetchMyLeaf,
  hasVoted,
  hexToBytes,
  type MyLeaf,
  type NotInSnapshot,
  type RegisterVoterResult,
  readGovernance,
  registerVoter,
} from './cto-vote-flow.js';
import { buildMidnightWalletBridge } from './midnight-wallet-bridge.js';

export interface CtoWidgetConfig {
  /** WordPress REST base, e.g. "https://noctis.example/wp-json/np/v1". */
  apiBase: string;
  /** Static host serving the GOVERNANCE contract's compiled artifacts (keys/, zkir/) and the proof server. */
  midnightZk?: { zkBaseUrl: string; proofServerUrl: string };
}

let config: CtoWidgetConfig | null = null;
let session: CtoSession | null = null;
let midnight: MidnightWalletConnection | null = null;
let cachedProviders: ContractProviders | null = null;

function requireConfig(): CtoWidgetConfig {
  if (!config) throw new Error('NoctisCto.configure() must be called before any other method.');
  return config;
}

function requireSession(): CtoSession {
  if (!session) throw new Error('NoctisCto.connectWallets() must be called before this method.');
  return session;
}

async function requireMidnightProviders(): Promise<ContractProviders> {
  const cfg = requireConfig();
  const s = requireSession();
  if (!midnight) {
    throw new Error('This action needs a connected Midnight wallet — connect one first.');
  }
  if (!cfg.midnightZk) {
    throw new Error('The platform has not configured where the governance circuits and proof server live yet.');
  }
  if (cachedProviders) return cachedProviders;

  const bridge = await buildMidnightWalletBridge({
    connection: midnight.api,
    shieldedCoinPublicKey: midnight.shieldedCoinPublicKey,
    shieldedEncryptionPublicKey: midnight.shieldedEncryptionPublicKey,
  });
  const zkConfigProvider = new FetchZkConfigProvider<string>(cfg.midnightZk.zkBaseUrl);
  const proofProvider = httpClientProofProvider(cfg.midnightZk.proofServerUrl, zkConfigProvider);
  // The CTO private store carries the identity only (no buy nonce), so the
  // providers are assembled here rather than through the DarkVeil helper.
  cachedProviders = {
    privateStateProvider: s.privateStore.provider,
    publicDataProvider: bridge.publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider: bridge.walletProvider,
    midnightProvider: bridge.midnightProvider,
  };
  return cachedProviders;
}

// ============================================================================
// Public API — window.NoctisCto
// ============================================================================

function configure(c: CtoWidgetConfig): void {
  config = c;
  cachedProviders = null;
}

function listAvailableWallets(): { cardano: WalletInfo[]; midnight: WalletInfo[] } {
  return { cardano: listAvailableCardanoWallets(), midnight: detectMidnightWallets() };
}

async function connectWallets(
  cardanoWalletId: string,
  midnightWalletId?: string,
): Promise<{ cardanoAddress: string; midnightUnshieldedAddress: string | null }> {
  session = await startCtoSession(cardanoWalletId);
  midnight = midnightWalletId ? await connectMidnightWallet(midnightWalletId) : null;
  cachedProviders = null;
  return {
    cardanoAddress: session.cardano.address,
    midnightUnshieldedAddress: midnight?.unshieldedAddress ?? null,
  };
}

/** This wallet's voting key for one launch — what the governor's snapshot names it by. */
async function myVoterKey(launchIdHex: string): Promise<string> {
  const s = requireSession();
  return bytesToHex((await s.getIdentityPublicKey(hexToBytes(launchIdHex))).bytes);
}

async function register(launchId: string, launchIdHex: string): Promise<RegisterVoterResult> {
  return registerVoter(requireConfig().apiBase, requireSession(), launchId, launchIdHex);
}

async function myLeaf(launchId: string, launchIdHex: string): Promise<MyLeaf | NotInSnapshot> {
  return fetchMyLeaf(requireConfig().apiBase, requireSession(), launchId, launchIdHex);
}

async function governance(contractAddress: string): Promise<CtoGovernanceSnapshot> {
  const providers = await requireMidnightProviders();
  return readGovernance(providers.publicDataProvider, contractAddress);
}

async function haveIVoted(contractAddress: string, launchIdHex: string, proposalIdHex: string): Promise<boolean> {
  const providers = await requireMidnightProviders();
  return hasVoted(providers.publicDataProvider, contractAddress, requireSession(), launchIdHex, proposalIdHex);
}

async function vote(params: {
  contractAddress: string;
  proposalIdHex: string;
  support: boolean;
  leaf: MyLeaf;
}): Promise<CastVoteResult> {
  const providers = await requireMidnightProviders();
  return castVoteFromBrowser(requireSession(), {
    providers,
    contractAddress: params.contractAddress,
    proposalIdHex: params.proposalIdHex,
    support: params.support,
    leaf: params.leaf,
  });
}

const NoctisCto = {
  configure,
  listAvailableWallets,
  connectWallets,
  myVoterKey,
  register,
  myLeaf,
  governance,
  haveIVoted,
  vote,
};

declare global {
  interface Window {
    NoctisCto: typeof NoctisCto;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisCto = NoctisCto;
  // The bundle instantiates wasm asynchronously, so this line runs AFTER a
  // deferred glue script that merely follows it in the document. The glue
  // waits for this event when the object is not there yet.
  window.dispatchEvent(new CustomEvent('noctis-cto-ready'));
}

export default NoctisCto;
