// ============================================================================
// Noctis Zone — Wallet Connection Layer
// ============================================================================
// Unified wallet abstraction for both Cardano (CIP-30) and Midnight wallets.
// Provides a single interface for the frontend to connect users to either
// chain without knowing the underlying wallet implementation.
//
// Cardano wallets: Nami, Eternl, Flint, Lace, Yoroi (CIP-30 compatible)
// Midnight wallets: Midnight-native wallet (window.midnight)
//
// The layer handles:
//   1. Wallet detection and connection
//   2. Address retrieval (payment + staking for Cardano, public key for Midnight)
//   3. Signature requests (for Aiken contract interactions)
//   4. Transaction submission (Cardano via CIP-30, Midnight via SDK)
//   5. Network detection (preview/preprod/mainnet for Cardano, local/devnet for Midnight)
// ============================================================================

// Real types from the real, installed @midnight-ntwrk/dapp-connector-api@4.0.1
// package — this used to be a hand-declared subset (see the earlier note on why
// that was flagged: "no dependency pin or import ties it to a real installed
// copy... it's hand-declared interfaces, never a real package dependency").
// Fixed while building the wallet bridge, which needs the FULL real
// ConnectedAPI (balanceUnsealedTransaction, submitTransaction,
// getConfiguration, etc.) — a hand-declared subset could never have supplied
// those.
import type { ConnectedAPI as MidnightConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

export type { ConnectedAPI as MidnightConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

// window.midnight is already declared globally by the real, installed
// @midnight-ntwrk/dapp-connector-api package (globals.d.ts) as
// `Record<string, InitialAPI> | undefined` — exactly what's needed here,
// so no augmentation of our own is required for it.
//
// window.cardano is ALSO already declared globally, by @lucid-evolution/
// lucid's own core-types package — but with a narrower per-wallet shape
// (`{ name, icon, apiVersion, enable(), isEnabled() }`, no `getNetworkId`)
// than the real CIP-30 wallets this file actually calls `getNetworkId()`
// on. Redeclaring `Window.cardano` ourselves would conflict with that
// existing ambient type (TypeScript requires identical merged
// declarations), so instead of fighting it, this one helper reads the
// real global and casts it to the fuller Cip30Wallet shape this file
// needs — every real CIP-30 wallet implements getNetworkId per the CIP-30
// spec, Lucid's own ambient type is just a narrower subset of it.
function getCardanoWallets(): Record<string, Cip30Wallet> | undefined {
  return window.cardano as unknown as Record<string, Cip30Wallet> | undefined;
}

// ============================================================================
// TYPES
// ============================================================================

export type ChainType = 'cardano' | 'midnight';

export type CardanoNetworkId = 0 | 1; // 0 = testnet, 1 = mainnet
export type CardanoNetwork = 'preview' | 'preprod' | 'mainnet';

export interface WalletInfo {
  id: string; // injection key: Cardano wallet id (e.g. "eternl") or, for
  // Midnight, the random per-session UUID under window.midnight
  name: string; // display name
  icon: string; // icon URL or data URI
  version: string;
  enabled: boolean;
  rdns?: string; // Midnight only — stable reverse-DNS wallet id (e.g. "io.lace.wallet");
  // use this, not `id`, to remember/recognize a wallet across sessions
}

export interface CardanoWalletConnection {
  chain: 'cardano';
  walletId: string;
  walletName: string;
  address: string; // base address (bech32) — decoded from the CIP-30 hex address
  paymentKeyHash: string; // Blake2b-224 of payment key
  stakingKeyHash: string; // Blake2b-224 of staking key
  rewardAddressHex: string; // CIP-30 reward (stake) address, hex — used to sign the DarkVeil auth nonce with the stake key
  stakeAddress: string; // reward address in bech32 (stake1.../stake_test1...) — '' for enterprise addresses
  networkId: CardanoNetworkId;
  network: CardanoNetwork;
  balance: string; // ADA balance in lovelace
}

export interface MidnightWalletConnection {
  chain: 'midnight';
  walletId: string; // window.midnight[...] key used to connect — a random
  // UUID, NOT stable across sessions (see walletRdns)
  walletRdns: string; // stable wallet identifier, e.g. "io.lace.wallet"
  walletName: string;
  shieldedAddress: string; // bech32m
  shieldedCoinPublicKey: string; // bech32m
  shieldedEncryptionPublicKey: string; // bech32m
  unshieldedAddress: string; // bech32m — used for NIGHT (unshielded) payments
  network: string; // networkId reported by getConnectionStatus(), not
  // a fixed union — the spec only guarantees 'mainnet'
  /** The raw real ConnectedAPI — needed by widget/midnight-wallet-bridge.ts to build a
   *  real WalletProvider/MidnightProvider/PublicDataProvider. The summary fields above cover
   *  the older display-only use cases; this is what a caller needs for real tx submission. */
  api: MidnightConnectedAPI;
}

export type WalletConnection = CardanoWalletConnection | MidnightWalletConnection;

// ============================================================================
// CIP-30 CARDANO WALLET INTERFACE
// ============================================================================

// Minimal CIP-30 API surface (what we actually use)
interface Cip30Wallet {
  enable(): Promise<Cip30Api>;
  isEnabled(): Promise<boolean>;
  getNetworkId(): Promise<number>;
  name: string;
  icon: string;
  apiVersion: string;
  _eventListeners?: Record<string, Array<(...args: unknown[]) => void>>;
}

interface Cip30Api {
  getBalance(): Promise<string>;
  getChangeAddress(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getRewardAddresses(): Promise<string[]>;
  getNetworkId(): Promise<number>;
  signData(address: string, payload: string): Promise<{ signature: string; key: string }>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  submitTx(tx: string): Promise<string>;
  getUtxos(): Promise<string[]>;
  getCollateral(): Promise<string[]>;
  experimental?: {
    on?: (event: string, callback: (...args: unknown[]) => void) => void;
    off?: (event: string, callback: (...args: unknown[]) => void) => void;
  };
}

// ============================================================================
// CARDANO WALLET MANAGER
// ============================================================================

/**
 * Detect all available CIP-30 compatible Cardano wallets in the browser.
 * Returns a list of wallet metadata for the UI to display.
 */
export function detectCardanoWallets(): WalletInfo[] {
  const cardanoWallets = getCardanoWallets();
  if (typeof window === 'undefined' || !cardanoWallets) {
    return [];
  }

  const cardano = cardanoWallets;
  const wallets: WalletInfo[] = [];

  for (const [id, wallet] of Object.entries(cardano)) {
    if (wallet && typeof wallet.enable === 'function') {
      wallets.push({
        id,
        name: wallet.name ?? id,
        icon: wallet.icon ?? '',
        version: wallet.apiVersion ?? 'unknown',
        enabled: false,
      });
    }
  }

  return wallets;
}

/**
 * Connect to a specific Cardano wallet via CIP-30.
 * Returns connection info including address, key hashes, and network.
 */
export async function connectCardanoWallet(walletId: string): Promise<CardanoWalletConnection> {
  const cardanoWallets = getCardanoWallets();
  if (typeof window === 'undefined' || !cardanoWallets) {
    throw new Error('No Cardano wallet found — install Nami, Eternl, Flint, or Lace');
  }

  const wallet: Cip30Wallet | undefined = cardanoWallets[walletId];
  if (!wallet) {
    throw new Error(`Wallet "${walletId}" not found`);
  }

  const api: Cip30Api = await wallet.enable();

  // Get addresses. CIP-30 getChangeAddress()/getUsedAddresses() return
  // HEX-CBOR addresses — NOT bech32 — so the raw value cannot be sent to the
  // Noctis backend (every endpoint validates bech32 `addr1…`) or used for
  // eligibility checks as-is. Decoding happens here, once, so every caller
  // downstream is handed a real bech32 address and real key hashes rather
  // than a raw-hex string it would have to recognise and convert itself.
  const changeAddress = await api.getChangeAddress();
  const usedAddresses = await api.getUsedAddresses();
  const rawAddress = changeAddress || (usedAddresses[0] ?? '');

  if (!rawAddress) {
    throw new Error('No address available from wallet');
  }

  // Decode via lucid-evolution — getAddressDetails accepts hex OR bech32 and
  // yields the canonical bech32 form plus payment/stake credentials. Dynamic
  // import matches the other widget entries (tier-a-buy, staking) and keeps
  // this off the module's synchronous load path.
  const { getAddressDetails } = await import('@lucid-evolution/lucid');
  const details = getAddressDetails(rawAddress);
  const address = details.address.bech32;
  const paymentKeyHash = details.paymentCredential?.hash ?? '';
  const stakingKeyHash = details.stakeCredential?.hash ?? '';

  // Reward (stake) address — the DarkVeil endpoints prove wallet control by
  // having the user sign a server nonce with their STAKE key.
  // getRewardAddresses() returns hex; keep both the hex (to pass to
  // signData) and the bech32 form (to send to /auth/nonce + the endpoints).
  // Enterprise addresses have no reward address — left empty; such wallets
  // simply can't register for DarkVeil, which matches the eligibility model
  // (a base address with a stake credential is required).
  let rewardAddressHex = '';
  let stakeAddress = '';
  try {
    const rewards = await api.getRewardAddresses();
    rewardAddressHex = rewards?.[0] ?? '';
    if (rewardAddressHex) {
      stakeAddress = getAddressDetails(rewardAddressHex).address.bech32;
    }
  } catch {
    // Wallet without reward addresses / enterprise-only — leave empty.
  }

  // Get network
  const networkId = (await api.getNetworkId()) as CardanoNetworkId;
  const network: CardanoNetwork = networkId === 1 ? 'mainnet' : 'preprod';

  // Get balance
  const balance = await api.getBalance();

  return {
    chain: 'cardano',
    walletId,
    walletName: wallet.name ?? walletId,
    address,
    paymentKeyHash,
    stakingKeyHash,
    rewardAddressHex,
    stakeAddress,
    networkId,
    network,
    balance,
  };
}

/**
 * Sign a transaction with the connected Cardano wallet.
 * Returns the signed transaction CBOR.
 */
export async function signCardanoTx(walletId: string, txCbor: string, partialSign = false): Promise<string> {
  const cardanoWallets = getCardanoWallets();
  if (typeof window === 'undefined' || !cardanoWallets) {
    throw new Error('No Cardano wallet found');
  }

  const wallet: Cip30Wallet | undefined = cardanoWallets[walletId];
  if (!wallet) {
    throw new Error(`Wallet "${walletId}" not found`);
  }

  const api: Cip30Api = await wallet.enable();
  return api.signTx(txCbor, partialSign);
}

/**
 * Submit a signed transaction to the Cardano network via the wallet.
 * Returns the transaction hash.
 */
export async function submitCardanoTx(walletId: string, signedTxCbor: string): Promise<string> {
  const cardanoWallets = getCardanoWallets();
  if (typeof window === 'undefined' || !cardanoWallets) {
    throw new Error('No Cardano wallet found');
  }

  const wallet: Cip30Wallet | undefined = cardanoWallets[walletId];
  if (!wallet) {
    throw new Error(`Wallet "${walletId}" not found`);
  }

  const api: Cip30Api = await wallet.enable();
  return api.submitTx(signedTxCbor);
}

/**
 * Sign a data payload with the connected Cardano wallet (CIP-8 / CIP-30 signData).
 * Used for off-chain authentication and message signing.
 */
export async function signCardanoData(
  walletId: string,
  address: string,
  payload: string,
): Promise<{ signature: string; key: string }> {
  const cardanoWallets = getCardanoWallets();
  if (typeof window === 'undefined' || !cardanoWallets) {
    throw new Error('No Cardano wallet found');
  }

  const wallet: Cip30Wallet | undefined = cardanoWallets[walletId];
  if (!wallet) {
    throw new Error(`Wallet "${walletId}" not found`);
  }

  const api: Cip30Api = await wallet.enable();
  return api.signData(address, payload);
}

// ============================================================================
// MIDNIGHT WALLET MANAGER
// ============================================================================
// Wallets inject an `InitialAPI` instance into `window.midnight`, keyed by a
// random UUID per the CAIP-372 draft — NOT a single object, and NOT a fixed
// key. `enable()`/`isEnabled()` from the older v3 API were removed in v4.0.0
// and replaced by `connect(networkId)`.

/**
 * Detect all Midnight wallets injected into window.midnight.
 * Per the DApp Connector spec, each wallet (and even each API version a
 * wallet supports) registers under its own random UUID key — a DApp must
 * enumerate, the same way detectCardanoWallets() enumerates window.cardano.
 */
export function detectMidnightWallets(): WalletInfo[] {
  if (typeof window === 'undefined' || !window.midnight) {
    return [];
  }

  const midnight = window.midnight;
  const wallets: WalletInfo[] = [];

  for (const [id, wallet] of Object.entries(midnight)) {
    if (wallet && typeof wallet.connect === 'function') {
      wallets.push({
        id,
        rdns: wallet.rdns ?? '',
        name: wallet.name ?? id,
        icon: wallet.icon ?? '',
        version: wallet.apiVersion ?? 'unknown',
        enabled: false,
      });
    }
  }

  return wallets;
}

/**
 * Connect to a specific Midnight wallet via the DApp Connector API.
 * `walletId` is the window.midnight key from detectMidnightWallets() (a
 * per-session UUID, not stable — use the returned walletRdns to recognize
 * the same wallet across sessions). `networkId` is only a connection hint;
 * the actual network is read back from getConnectionStatus().
 */
export async function connectMidnightWallet(
  walletId: string,
  networkId = 'testnet',
): Promise<MidnightWalletConnection> {
  if (typeof window === 'undefined' || !window.midnight) {
    throw new Error('No Midnight wallet found — install a Midnight wallet extension');
  }

  const midnight = window.midnight;
  const wallet = midnight[walletId];
  if (!wallet) {
    throw new Error(`Midnight wallet "${walletId}" not found`);
  }

  const api = await wallet.connect(networkId);

  const { shieldedAddress, shieldedCoinPublicKey, shieldedEncryptionPublicKey } = await api.getShieldedAddresses();
  const { unshieldedAddress } = await api.getUnshieldedAddress();

  const status = await api.getConnectionStatus();
  const network = status.status === 'connected' ? status.networkId : networkId;

  return {
    chain: 'midnight',
    walletId,
    walletRdns: wallet.rdns ?? '',
    walletName: wallet.name ?? walletId,
    shieldedAddress,
    shieldedCoinPublicKey,
    shieldedEncryptionPublicKey,
    unshieldedAddress,
    network,
    api,
  };
}

// ============================================================================
// UNIFIED WALLET MANAGER
// ============================================================================

/**
 * Unified wallet manager that handles both Cardano and Midnight connections.
 * The frontend uses this single interface regardless of which chain the user
 * is interacting with.
 */
export class WalletManager {
  private cardanoConnection: CardanoWalletConnection | null = null;
  private midnightConnection: MidnightWalletConnection | null = null;

  // --- Detection ---

  getAvailableCardanoWallets(): WalletInfo[] {
    return detectCardanoWallets();
  }

  getAvailableMidnightWallets(): WalletInfo[] {
    return detectMidnightWallets();
  }

  // --- Connection ---

  async connectCardano(walletId: string): Promise<CardanoWalletConnection> {
    this.cardanoConnection = await connectCardanoWallet(walletId);
    return this.cardanoConnection;
  }

  async connectMidnight(walletId: string, networkId?: string): Promise<MidnightWalletConnection> {
    this.midnightConnection = await connectMidnightWallet(walletId, networkId);
    return this.midnightConnection;
  }

  // --- State queries ---

  getCardanoConnection(): CardanoWalletConnection | null {
    return this.cardanoConnection;
  }

  getMidnightConnection(): MidnightWalletConnection | null {
    return this.midnightConnection;
  }

  isConnected(chain: ChainType): boolean {
    return chain === 'cardano' ? this.cardanoConnection !== null : this.midnightConnection !== null;
  }

  // --- Transaction operations ---

  async signAndSubmitCardanoTx(txCbor: string, partialSign = false): Promise<string> {
    if (!this.cardanoConnection) {
      throw new Error('Cardano wallet not connected');
    }
    const signed = await signCardanoTx(this.cardanoConnection.walletId, txCbor, partialSign);
    return submitCardanoTx(this.cardanoConnection.walletId, signed);
  }

  // --- Disconnect ---

  disconnectCardano(): void {
    this.cardanoConnection = null;
  }

  disconnectMidnight(): void {
    this.midnightConnection = null;
  }

  disconnectAll(): void {
    this.disconnectCardano();
    this.disconnectMidnight();
  }
}

// ============================================================================
// REACT HOOK (for the frontend)
// ============================================================================

/**
 * React hook for wallet management.
 * Usage:
 *   const { wallets, connect, disconnect, connection } = useWallet();
 */
export interface UseWalletReturn {
  cardanoWallets: WalletInfo[];
  midnightWallets: WalletInfo[];
  cardanoConnection: CardanoWalletConnection | null;
  midnightConnection: MidnightWalletConnection | null;
  connectCardano: (walletId: string) => Promise<void>;
  connectMidnight: (walletId: string, networkId?: string) => Promise<void>;
  disconnectCardano: () => void;
  disconnectMidnight: () => void;
}

// This is a framework-agnostic factory — wrap in useState/useEffect for React
export function createWalletManager(): WalletManager {
  return new WalletManager();
}
