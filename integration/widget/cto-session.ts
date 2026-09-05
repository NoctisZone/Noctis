// ============================================================================
// Noctis Zone — CTO Governance: session bootstrap
// ============================================================================
// Client-side entry point for CTO voting/proposing — mirrors
// widget/wallet-session.ts's shape closely (same wallet-connect +
// signature-caching + private-store-wiring pattern), but its own dedicated
// signature domain and store (cto-private-state-store.ts) — see that
// file's header for why this is deliberately NOT shared with DarkVeil's
// session. A user only ever needs a Cardano wallet here (no Midnight
// wallet extension required) — matches CLAUDE.md's "lite" requirement that
// CTO participation shouldn't demand a Midnight wallet.
//
// HONEST SCOPE NOTE (2026-07-19): getIdentityPublicKey() below gives a
// voter their own real, recoverable Midnight identity for
// createProposal/castVote — that part is real and tested. What this module
// does NOT do is REGISTER that identity anywhere the governor can look it
// up when building a balance-snapshot Merkle tree (item #11's own
// dependency) — that needs real server-side CIP-8 signature verification,
// deliberately scoped out of this pass (see cto-private-state-store.ts's
// header).
// ============================================================================

import { DOMAINS, deriveUserPublicKey, type UserPublicKey } from '../../contracts/midnight/witnesses.js';
import {
  CTO_MASTER_SIGNATURE_DOMAIN,
  type CtoIdentity,
  type CtoPrivateStore,
  createCtoPrivateStore,
} from '../cto-private-state-store.js';
import {
  type CardanoWalletConnection,
  connectCardanoWallet,
  detectCardanoWallets,
  signCardanoData,
  type WalletInfo,
} from '../wallet-connection.js';

function toUtf8Hex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface CtoSession {
  cardano: CardanoWalletConnection;
  privateStore: CtoPrivateStore;
  /** Cached after first getOrCreateIdentity() call. */
  getIdentity(): Promise<CtoIdentity>;
  /** The identity's derived public key for ONE launch, under
   *  cto_governance.compact's own domain — this is the value createProposal/
   *  castVote will see as proposerKey/voterKey. Scoped per launch, so a
   *  voter's key on one ballot cannot be matched to their key on another. */
  getIdentityPublicKey(launchId: Uint8Array): Promise<UserPublicKey>;
  /** The raw CIP-8 signature and key over the master message — what the
   *  server needs to verify a voter registration and re-derive the same
   *  identity. Cached with the signature itself: one wallet prompt. */
  getMasterSignatureMaterial(): Promise<{ signature: string; key: string }>;
}

/** Detects available Cardano wallets for a CTO connect UI to list. */
export function listAvailableCardanoWallets(): WalletInfo[] {
  return detectCardanoWallets();
}

/**
 * Connects the Cardano wallet and gets the one CTO master signature. The
 * signature prompt only fires on a genuine cache miss inside
 * cto-private-state-store.ts (first use, or cleared browser data) — a warm
 * session with a cached identity never prompts at all.
 */
export async function startCtoSession(cardanoWalletId: string): Promise<CtoSession> {
  const cardano = await connectCardanoWallet(cardanoWalletId);

  const getMasterSignature = async (): Promise<{ signature: string; key: string }> => {
    const payloadHex = toUtf8Hex(CTO_MASTER_SIGNATURE_DOMAIN);
    return signCardanoData(cardanoWalletId, cardano.address, payloadHex);
  };

  // Same in-flight-promise caching as wallet-session.ts's own
  // getCachedSignature, and for the same reason (concurrent cache misses
  // must await one wallet prompt, not several).
  let materialPromise: Promise<{ signature: string; key: string }> | null = null;
  function getMasterSignatureMaterial(): Promise<{ signature: string; key: string }> {
    if (materialPromise === null) {
      materialPromise = getMasterSignature().catch((err) => {
        materialPromise = null;
        throw err;
      });
    }
    return materialPromise;
  }
  const getCachedSignature = async (): Promise<string> => (await getMasterSignatureMaterial()).signature;

  const privateStore = createCtoPrivateStore({
    accountId: cardano.address,
    // Reuses the same signature the identity itself derives from, hashed
    // under its own domain internally by widget/password-derivation.ts's
    // real validatePassword-compliant derivation — one wallet prompt covers
    // both the storage password and the identity secret, same as
    // wallet-session.ts's own DarkVeil wiring.
    passwordProvider: async () => {
      const { derivePasswordFromSignature, CTO_PASSWORD_DOMAIN } = await import('./password-derivation.js');
      return derivePasswordFromSignature(await getCachedSignature(), CTO_PASSWORD_DOMAIN);
    },
    getMasterSignature: getCachedSignature,
  });

  let identityPromise: Promise<CtoIdentity> | null = null;
  function getIdentity(): Promise<CtoIdentity> {
    if (identityPromise === null) {
      identityPromise = privateStore.getOrCreateIdentity().catch((err) => {
        identityPromise = null;
        throw err;
      });
    }
    return identityPromise;
  }

  async function getIdentityPublicKey(launchId: Uint8Array): Promise<UserPublicKey> {
    const identity = await getIdentity();
    return deriveUserPublicKey(identity.userSecretKey, DOMAINS.CTO_USER, launchId);
  }

  return { cardano, privateStore, getIdentity, getIdentityPublicKey, getMasterSignatureMaterial };
}
