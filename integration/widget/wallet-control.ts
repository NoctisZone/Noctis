// ============================================================================
// Noctis Zone — proving control of a Cardano wallet to the platform's REST API
// ============================================================================
// Several endpoints hand back something private to one wallet (a DarkVeil
// claim record, a CTO balance leaf) or bind an identity to it. Each of them is
// gated server-side by np_dv_require_wallet_control: the caller fetches a
// fresh nonce for their STAKE address, signs it with the stake key, and sends
// the CIP-8 material alongside the request. The server verifies the signature
// and then checks that the base address being acted on is staked to that key.
//
// This module is the ONE client-side implementation of that handshake. Two
// entry points, same result:
//   - proveWalletControl(apiBase, api, binds)         from a raw CIP-30 API
//     object (the theme's WeldPress connection hands one over as `handler`)
//   - proveWalletControlFrom(apiBase, connection, …)  from an already-built
//     CardanoWalletConnection (the widget sessions)
//
// `buildBinds` scopes a signature to one action and its parameters. It MUST
// match NP_CIP8::build_binds server-side exactly: sha256 over the action name
// and each parameter, joined by '|', in a fixed order. The server pins the
// value into the nonce it issues and re-checks it on the signed payload, so a
// signature collected for any other purpose is rejected and no parameter can
// be substituted between signing and submission.
// ============================================================================

import { sha256 } from '@noble/hashes/sha2.js';
import type { CardanoWalletConnection } from '../wallet-connection.js';

/** The two CIP-30 calls the handshake needs; any wallet API object satisfies it. */
export interface SigningWalletApi {
  getRewardAddresses(): Promise<string[]>;
  signData(address: string, payload: string): Promise<{ signature: string; key: string }>;
}

/** Exactly the three query/body fields np_dv_require_wallet_control reads. */
export interface WalletControlProof {
  stake_address: string;
  signature: string;
  key: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function buildBinds(action: string, params: string[]): string {
  return bytesToHex(sha256(new TextEncoder().encode([action, ...params].join('|'))));
}

async function fetchNoncePayloadHex(apiBase: string, stakeAddress: string, binds?: string): Promise<string> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stake_address: stakeAddress, ...(binds ? { binds } : {}) }),
  });
  const json = (await res.json().catch(() => null)) as { payload_hex?: string; message?: string } | null;
  if (!res.ok || !json?.payload_hex) {
    throw new Error(json?.message ?? 'Could not obtain a sign-in challenge from the server.');
  }
  return json.payload_hex;
}

/**
 * Proves control from a raw CIP-30 API object. The reward address comes from
 * the wallet itself (hex), and its bech32 form is derived locally — never
 * typed in by the caller, so the address the server checks is the one the
 * signature is genuinely over.
 */
export async function proveWalletControl(
  apiBase: string,
  api: SigningWalletApi,
  binds?: string,
): Promise<WalletControlProof> {
  const rewards = await api.getRewardAddresses();
  const rewardAddressHex = rewards?.[0] ?? '';
  if (!rewardAddressHex) {
    throw new Error('This wallet has no stake (reward) address, so it cannot prove control of a base address.');
  }
  const { getAddressDetails } = await import('@lucid-evolution/lucid');
  const stakeAddress = getAddressDetails(rewardAddressHex).address.bech32;
  const payloadHex = await fetchNoncePayloadHex(apiBase, stakeAddress, binds);
  const { signature, key } = await api.signData(rewardAddressHex, payloadHex);
  return { stake_address: stakeAddress, signature, key };
}

/** The same handshake from a connection the widget already built. */
export async function proveWalletControlFrom(
  apiBase: string,
  cardano: Pick<CardanoWalletConnection, 'walletId' | 'stakeAddress' | 'rewardAddressHex'>,
  signData: (walletId: string, address: string, payloadHex: string) => Promise<{ signature: string; key: string }>,
  binds?: string,
): Promise<WalletControlProof> {
  if (!cardano.stakeAddress || !cardano.rewardAddressHex) {
    throw new Error('This wallet has no stake (reward) address, so it cannot prove control of a base address.');
  }
  const payloadHex = await fetchNoncePayloadHex(apiBase, cardano.stakeAddress, binds);
  const { signature, key } = await signData(cardano.walletId, cardano.rewardAddressHex, payloadHex);
  return { stake_address: cardano.stakeAddress, signature, key };
}

/** Appends the proof to a query string, encoded. */
export function withProofQuery(url: string, proof: WalletControlProof): string {
  const sep = url.includes('?') ? '&' : '?';
  return (
    `${url}${sep}stake_address=${encodeURIComponent(proof.stake_address)}` +
    `&signature=${encodeURIComponent(proof.signature)}&key=${encodeURIComponent(proof.key)}`
  );
}
