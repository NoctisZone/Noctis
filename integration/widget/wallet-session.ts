// ============================================================================
// Noctis Zone — DarkVeil widget: session bootstrap
// ============================================================================
// The foundation every other widget flow builds on: connects the Cardano
// wallet (required for every tier — DV eligibility proof, fee payment, and
// for Cardano Launch the actual DarkVeil claim), optionally the Midnight wallet
// (required for Midnight Launch, and for actually submitting a Midnight transaction
// on any tier), gets the ONE master signature both password-derivation.ts
// and private-state-store.ts need, and wires up the DarkVeilPrivateStore.
//
// HONEST SCOPE NOTE: this module gets a session to the point where identity/
// buy-nonce derivation and Cardano-side actions (eligibility checks,
// registration intent, Cardano Launch claim) all work for real. Actually SUBMITTING
// a Midnight transaction (registerForDarkVeil, submitBuyCommit,
// revealBuyCommit) needs a real ContractProviders.
// widget/midnight-wallet-bridge.ts builds the WalletProvider/
// MidnightProvider/PublicDataProvider trio from this session's connected
// `midnight` field automatically (wired in via darkveil-widget-entry.ts's
// `requireMidnightProviders()`) — verified against the real, official
// `midnightntwrk/example-zkloan` reference dApp, not improvised. What's
// still genuinely open is the OTHER two ContractProviders fields
// (zkConfigProvider/proofProvider) — a separate deployment decision (where
// Noctis's compiled contracts' ZK artifacts are hosted for a browser to
// fetch), which the caller must still supply via configure()'s `midnightZk`
// option. registration-flow.ts/buy-flow.ts still take `providers:
// ContractProviders` as an explicit parameter — darkveil-widget-entry.ts is
// what assembles that value now, this module just exposes the raw
// `midnight` connection (with its real `api` field) needed to do so.
// ============================================================================

import { DOMAINS, deriveUserPublicKey, type UserPublicKey } from '../../contracts/midnight/witnesses.js';
import {
  createDarkVeilPrivateStore,
  type DarkVeilIdentity,
  type DarkVeilPrivateStore,
  MASTER_SIGNATURE_DOMAIN,
} from '../private-state-store.js';
import {
  type CardanoWalletConnection,
  connectCardanoWallet,
  connectMidnightWallet,
  detectCardanoWallets,
  detectMidnightWallets,
  type MidnightWalletConnection,
  signCardanoData,
  type WalletInfo,
} from '../wallet-connection.js';
import { derivePasswordFromSignature } from './password-derivation.js';

function toUtf8Hex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface DarkVeilSession {
  cardano: CardanoWalletConnection;
  midnight: MidnightWalletConnection | null;
  privateStore: DarkVeilPrivateStore;
  /** Cached after first getOrCreateIdentity() call. */
  getIdentity(): Promise<DarkVeilIdentity>;
  /** The identity's derived public key for ONE launch, under the shared
   *  eligibility/curve domain — this is the value that becomes an allowlist
   *  leaf. Scoped per launch, so the same wallet presents a different key to
   *  each one and two registrations cannot be matched to the same person. */
  getIdentityPublicKey(launchId: Uint8Array): Promise<UserPublicKey>;
  getBuyNonce(launchContractAddressHex: string): Promise<Uint8Array>;
}

/**
 * Detects available Cardano/Midnight wallets for the connect UI to list.
 * Pure passthrough to wallet-connection.ts — kept here so widget code has
 * one place to import wallet-listing from.
 */
export function listAvailableWallets(): {
  cardano: WalletInfo[];
  midnight: WalletInfo[];
} {
  return { cardano: detectCardanoWallets(), midnight: detectMidnightWallets() };
}

/**
 * Connects the Cardano wallet (required) and optionally the Midnight
 * wallet, gets the one master signature, and wires up the private store.
 * The signature prompt itself only fires on a genuine cache miss inside
 * private-state-store.ts (first use, or cleared browser data) — a warm
 * session with cached identity/nonces never prompts at all.
 */
export async function startDarkVeilSession(
  cardanoWalletId: string,
  midnightWalletId?: string,
): Promise<DarkVeilSession> {
  const cardano = await connectCardanoWallet(cardanoWalletId);
  const midnight = midnightWalletId ? await connectMidnightWallet(midnightWalletId) : null;

  const getMasterSignature = async (): Promise<string> => {
    const payloadHex = toUtf8Hex(MASTER_SIGNATURE_DOMAIN);
    const { signature } = await signCardanoData(cardanoWalletId, cardano.address, payloadHex);
    return signature;
  };

  // Reused for BOTH the local-storage password (password-derivation.ts) and
  // identity/nonce derivation (private-state-store.ts) — one wallet prompt
  // covers both, since each hashes the same signature under its own
  // distinct domain string (see private-state-store.ts's SK_DOMAIN/
  // REG_NONCE_DOMAIN/BUY_NONCE_DOMAIN vs. password-derivation.ts's own
  // internal salted-retry domain).
  // Caches the in-flight PROMISE, not the resolved value — two concurrent
  // callers (e.g. checkAllowlistStatus and checkMyEligibility firing near-
  // simultaneously) must await the same wallet prompt, not each trigger
  // their own. Caching only the resolved value has this exact race: both
  // would see the cache empty and each call the wallet, showing the user
  // two signature prompts instead of one.
  let signaturePromise: Promise<string> | null = null;
  function getCachedSignature(): Promise<string> {
    if (signaturePromise === null) {
      signaturePromise = getMasterSignature().catch((err) => {
        signaturePromise = null; // retry fresh next time rather than staying stuck on one rejection (e.g. the user declined the wallet prompt)
        throw err;
      });
    }
    return signaturePromise;
  }

  const privateStore = createDarkVeilPrivateStore({
    accountId: cardano.address,
    passwordProvider: async () => derivePasswordFromSignature(await getCachedSignature()),
    getMasterSignature: getCachedSignature,
  });

  // Same in-flight-promise caching as getCachedSignature above, and for the
  // same reason — getOrCreateIdentity() itself may need a wallet signature
  // on a cache miss.
  let identityPromise: Promise<DarkVeilIdentity> | null = null;
  function getIdentity(): Promise<DarkVeilIdentity> {
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
    return deriveUserPublicKey(identity.userSecretKey, DOMAINS.ELIGIBILITY_USER, launchId);
  }

  async function getBuyNonce(launchContractAddressHex: string): Promise<Uint8Array> {
    return privateStore.getOrCreateBuyNonce(launchContractAddressHex);
  }

  return {
    cardano,
    midnight,
    privateStore,
    getIdentity,
    getIdentityPublicKey,
    getBuyNonce,
  };
}
