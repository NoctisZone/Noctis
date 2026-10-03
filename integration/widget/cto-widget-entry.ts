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
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {
  BROWSER_PROPOSAL_TYPES,
  descriptionHashOf,
  type ProposalDescription,
  type ProposalOpening,
  type ProposalTypeName,
  proposalDescriptionText,
  proposalOpening,
  readProposalDescription,
  resolveProposalArgs,
} from '../cto-proposal-args.js';
import { coseKeyPublicKey, keyHashOf } from '../cto-royalty-key.js';
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
  claimProposalBondFromBrowser,
  createProposalFromBrowser,
  executeOnMidnightFromBrowser,
  fetchMyLeaf,
  finalizeFromBrowser,
  hasVoted,
  hexToBytes,
  type MyLeaf,
  type NotInSnapshot,
  type ProposeResult,
  type RegisterVoterResult,
  readBallotForCardano,
  readGovernance,
  registerVoter,
  sweepProposalBondFromBrowser,
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

/** Closes a ballot whose window has passed. Anyone may; the connected Midnight wallet pays. */
async function finalize(contractAddress: string, proposalIdHex: string): Promise<CastVoteResult> {
  const providers = await requireMidnightProviders();
  return finalizeFromBrowser(requireSession(), { providers, contractAddress, proposalIdHex });
}

/** Carries a passed proposal out on Midnight. Anyone may; the connected Midnight wallet pays. */
async function executeOnMidnight(contractAddress: string, proposalIdHex: string): Promise<CastVoteResult> {
  const providers = await requireMidnightProviders();
  return executeOnMidnightFromBrowser(requireSession(), { providers, contractAddress, proposalIdHex });
}

/**
 * A settled ballot, ready for the Cardano steps (window.NoctisCtoCardano) to
 * record. Plain values; the page passes it across as it is.
 */
async function ballotForCardano(contractAddress: string, proposalIdHex: string) {
  const providers = await requireMidnightProviders();
  return readBallotForCardano(providers.publicDataProvider, contractAddress, proposalIdHex);
}

// ----------------------------------------------------------------------------
// Proposing
// ----------------------------------------------------------------------------

/**
 * The connected Cardano wallet's payment public key and its key hash, read from
 * the signature the session already holds. A takeover vote names a community
 * wallet by its key hash and carries its public key, so the takeover can later
 * install it as the pool's royalty key without that wallet present.
 */
async function myWalletKey(): Promise<{ pubKeyHex: string; keyHashHex: string }> {
  const { key } = await requireSession().getMasterSignatureMaterial();
  const pubKeyHex = coseKeyPublicKey(key);
  return { pubKeyHex, keyHashHex: keyHashOf(pubKeyHex) };
}

/** The key hash a public key signs under: what a takeover vote names its community wallet by. */
function walletKeyHash(pubKeyHex: string): string {
  const key = pubKeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('A public key is 64 hex characters.');
  return keyHashOf(key);
}

type Opening = { open: true } | { open: false; reason: string; fromSeconds?: string };

/**
 * Whether each vote the page offers may be filed now, and if not, why and from
 * when. The contract's own gates, read against its own state; it still decides.
 */
async function openings(contractAddress: string, graduationSeconds?: string): Promise<Record<string, Opening>> {
  const g = await governance(contractAddress);
  const state = {
    ctoState: g.ctoState,
    hasClaimableBalance: g.hasClaimableBalance,
    lastCreatorActivity: BigInt(g.lastCreatorActivity),
    lastProposalEnd: BigInt(g.lastProposalEnd),
    activeProposalCount: BigInt(g.activeProposalCount),
    lastSnapshotTimestamp: BigInt(g.lastSnapshotTimestamp),
    balanceSnapshotRootHex: g.balanceSnapshotRootHex,
  };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const grad = graduationSeconds ? BigInt(graduationSeconds) : undefined;
  const out: Record<string, Opening> = {};
  for (const t of BROWSER_PROPOSAL_TYPES) {
    const o: ProposalOpening = proposalOpening(state, t, now, grad);
    out[t] = o.open
      ? o
      : {
          open: false,
          reason: o.reason,
          ...(o.fromSeconds === undefined ? {} : { fromSeconds: o.fromSeconds.toString() }),
        };
  }
  return out;
}

export interface ProposeParams extends ProposalDescription {
  contractAddress: string;
  launchId: string;
  proposalType: ProposalTypeName;
  /** VestingToLp: lovelace. VestingToStaking: a new pool's runway in days, or 0. FundAllocation: the amount. */
  allocationAmount?: string;
  /** FundAllocation: the recipient's 28-byte payment key hash. */
  allocationRecipientHex?: string;
  /** NIGHT atomic units. */
  bondAmount: string;
  /** The launch's bond floor, when the site knows it, so a bond under it is refused before a proof. */
  bondMin?: string;
}

function apiBase(): string {
  return requireConfig().apiBase.replace(/\/$/, '');
}

/**
 * Files a proposal: stores its description on the site under its SHA-256,
 * checks the site kept those exact bytes, then files the proposal committing to
 * that hash. A takeover vote names its community wallet by the key hash of the
 * public key its description carries.
 */
async function propose(params: ProposeParams): Promise<ProposeResult & { descriptionHashHex: string }> {
  if (!(BROWSER_PROPOSAL_TYPES as readonly string[]).includes(params.proposalType)) {
    throw new Error(`This page does not file ${params.proposalType} proposals.`);
  }
  const takeover = params.proposalType === 'SilenceLockTrigger';
  const walletKey = params.communityWalletPubKey;
  if (takeover && !walletKey) throw new Error('A takeover vote names the community wallet by its public key.');
  const text = proposalDescriptionText({
    title: params.title,
    text: params.text,
    ...(takeover ? { communityWalletPubKey: walletKey } : {}),
  });
  const descriptionHashHex = bytesToHex(descriptionHashOf(text));
  const resolved = resolveProposalArgs(
    {
      proposalType: params.proposalType,
      descriptionHashHex,
      allocationAmount: params.allocationAmount,
      allocationRecipientHex: params.allocationRecipientHex,
      proposedCommunityWalletHex: takeover && walletKey ? keyHashOf(walletKey) : undefined,
      bondAmount: params.bondAmount,
    },
    params.bondMin ? BigInt(params.bondMin) : undefined,
  );
  const providers = await requireMidnightProviders();

  const res = await fetch(`${apiBase()}/cto/description`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ launch_id: params.launchId, text }),
  });
  const body = (await res.json().catch(() => ({}))) as { hash?: string; message?: string };
  if (!res.ok) throw new Error(body.message || 'The site could not store the description.');
  if (body.hash !== descriptionHashHex) throw new Error('The site stored the description under a different hash.');

  const made = await createProposalFromBrowser(requireSession(), {
    providers,
    contractAddress: params.contractAddress,
    resolved,
  });
  return { ...made, descriptionHashHex };
}

/** A proposal's description from the site, checked against the hash the proposal commits to. */
async function description(
  launchId: string,
  descriptionHashHex: string,
): Promise<(ProposalDescription & { found: true }) | { found: false }> {
  const res = await fetch(
    `${apiBase()}/cto/description?launch_id=${encodeURIComponent(launchId)}&hash=${encodeURIComponent(descriptionHashHex)}`,
    { headers: { Accept: 'application/json' } },
  );
  if (res.status === 404) return { found: false };
  const body = (await res.json().catch(() => ({}))) as { text?: string; message?: string };
  if (!res.ok || typeof body.text !== 'string') throw new Error(body.message || 'The description could not be read.');
  if (bytesToHex(descriptionHashOf(body.text)) !== descriptionHashHex.toLowerCase()) {
    throw new Error('The stored description does not match the hash the proposal commits to.');
  }
  return { ...readProposalDescription(body.text), found: true };
}

/** Returns this proposer's bond, behind a ballot that drew a quorum, to the connected Midnight wallet. */
async function claimBond(contractAddress: string, proposalIdHex: string): Promise<CastVoteResult> {
  const providers = await requireMidnightProviders();
  const recipientAddress = midnight?.unshieldedAddress;
  if (!recipientAddress) throw new Error('Connect the Midnight wallet the bond should return to.');
  return claimProposalBondFromBrowser(requireSession(), {
    providers,
    contractAddress,
    proposalIdHex,
    recipientAddress,
  });
}

/** Sends the bond behind a ballot that drew no quorum to the platform. Anyone may; the connected Midnight wallet pays. */
async function sweepBond(contractAddress: string, proposalIdHex: string): Promise<CastVoteResult> {
  const providers = await requireMidnightProviders();
  return sweepProposalBondFromBrowser(requireSession(), { providers, contractAddress, proposalIdHex });
}

/**
 * Each listed contract's governance state, read through the site's public
 * indexer with no wallet connected: what is being voted on, and where each
 * launch stands. A contract that cannot be read is reported as such and does
 * not stop the rest.
 */
async function readOnlyGovernance(
  contractAddresses: readonly string[],
  indexer: { httpUrl: string; wsUrl: string },
): Promise<Array<{ contractAddress: string; governance?: CtoGovernanceSnapshot; error?: string }>> {
  if (!indexer.httpUrl || !indexer.wsUrl)
    throw new Error('The site has not configured a Midnight indexer to read from.');
  const provider = indexerPublicDataProvider(indexer.httpUrl, indexer.wsUrl);
  const out: Array<{ contractAddress: string; governance?: CtoGovernanceSnapshot; error?: string }> = [];
  for (const contractAddress of contractAddresses) {
    try {
      out.push({ contractAddress, governance: await readGovernance(provider, contractAddress) });
    } catch (err) {
      out.push({ contractAddress, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
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
  finalize,
  executeOnMidnight,
  ballotForCardano,
  myWalletKey,
  walletKeyHash,
  openings,
  propose,
  description,
  claimBond,
  sweepBond,
  readOnlyGovernance,
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
