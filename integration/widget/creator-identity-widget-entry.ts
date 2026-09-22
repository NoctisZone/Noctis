// ============================================================================
// Noctis Zone — creator identity widget: browser entry point
// ============================================================================
// Exposes window.NoctisCreatorIdentity, a plain object of async functions the
// create wizard's vanilla JS (assets/js/create.js) calls right after a mint is
// registered. Same shape and same rules as the other entries: the theme deals
// in plain strings, every SDK object is built in here, and the logic worth
// testing lives in creator-identity.ts rather than in this file — a bundle
// entry runs on import and cannot be exercised directly.
//
// WHAT IT IS FOR. The eligibility gate seals a creator identity at deploy and
// refuses a DarkVeil registration that derives to it. That check is worth
// exactly as much as the value in the slot — seal an identity the creator
// never uses and it excludes nobody, while every other check still passes.
// The identity exists only in the creator's own browser, so the only way for
// the launch to learn it is to be told, by somebody who can prove they are the
// creator.
//
// THE DOMAIN IS THE WHOLE POINT, AND IT IS THE EASY THING TO GET WRONG. The
// gate compares a registrant against deriveUserPublicKey(sk, launchId) under
// pad(32, "noctis:user:pk:v1") — the ELIGIBILITY_USER domain, launch-scoped.
// That is what widget/wallet-session.ts derives, which is why this entry
// builds a DarkVeil session and not the lighter CTO one: the CTO session's key
// is derived under its own domain, would pass every check this route, the
// deploy and the contract can make, and would exclude a person who does not
// exist. tests/creator-identity-bind.test.ts pins that difference.
// ============================================================================

import { signCardanoData, type WalletInfo } from '../wallet-connection.js';
import { bindCreatorIdentity, type CreatorIdentityResult, launchIdFromHex } from './creator-identity.js';
import { type DarkVeilSession, listAvailableWallets, startDarkVeilSession } from './wallet-session.js';

export interface CreatorIdentityWidgetConfig {
  /** WordPress REST base, e.g. "https://noctis.example/wp-json/np/v1/". */
  apiBase: string;
}

let config: CreatorIdentityWidgetConfig | null = null;
let session: DarkVeilSession | null = null;

/** Trailing slash either way: the submit path appends to it, the nonce path strips it. */
function normaliseBase(base: string): string {
  return `${base.replace(/\/+$/, '')}/`;
}

function requireConfig(): CreatorIdentityWidgetConfig {
  if (!config) throw new Error('NoctisCreatorIdentity.configure() must be called before any other method.');
  return config;
}

function requireSession(): DarkVeilSession {
  if (!session) throw new Error('NoctisCreatorIdentity.connect() must be called before this method.');
  return session;
}

// ============================================================================
// Public API — window.NoctisCreatorIdentity
// ============================================================================

function configure(c: CreatorIdentityWidgetConfig): void {
  config = { ...c, apiBase: normaliseBase(c.apiBase) };
}

/** Cardano only. The identity derives from a Cardano signature and no Midnight
 *  transaction is submitted, so a Midnight wallet buys nothing here. */
function listWallets(): WalletInfo[] {
  return listAvailableWallets().cardano;
}

async function connect(cardanoWalletId: string): Promise<{ cardanoAddress: string }> {
  session = await startDarkVeilSession(cardanoWalletId);
  return { cardanoAddress: session.cardano.address };
}

/**
 * This wallet's identity for one launch — the value the gate will be asked to
 * exclude. No network and no server: a UI can show it before anyone signs
 * anything, and re-deriving it later gives the same answer.
 */
async function deriveKey(launchIdHex: string): Promise<string> {
  const s = requireSession();
  const key = await s.getIdentityPublicKey(launchIdFromHex(launchIdHex));
  return Array.from(key.bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Derive the identity and hand it to the launch record. */
async function bind(params: {
  slug: string;
  launchIdHex: string;
}): Promise<CreatorIdentityResult & { keyHex: string }> {
  return bindCreatorIdentity({
    apiBase: requireConfig().apiBase,
    slug: params.slug,
    launchIdHex: params.launchIdHex,
    source: requireSession(),
    signData: signCardanoData,
  });
}

const NoctisCreatorIdentity = {
  configure,
  listWallets,
  connect,
  deriveKey,
  bind,
};

declare global {
  interface Window {
    NoctisCreatorIdentity: typeof NoctisCreatorIdentity;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisCreatorIdentity = NoctisCreatorIdentity;
  // The bundle instantiates wasm asynchronously, so this line runs AFTER a
  // deferred glue script that merely follows it in the document. The glue
  // waits for this event when the object is not there yet.
  window.dispatchEvent(new CustomEvent('noctis-creator-identity-ready'));
}

export default NoctisCreatorIdentity;
