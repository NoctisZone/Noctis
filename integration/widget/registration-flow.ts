// ============================================================================
// Noctis Zone — DarkVeil widget: registration flow
// ============================================================================
// Registration is the 3-stage pipeline discovered while building this
// widget (see architecture.html's 2026-07-15 callout): submit an intent →
// wait for the governor's periodic batch run to include you in the
// allowlist tree → only then can the real on-chain registerForDarkVeil be
// submitted. Stage 3 (the governor publishing the tree's root on-chain via
// updateAllowlistRoot) is NOT built anywhere in this codebase — no governor
// key custody mechanism exists — so registerOnChain below will correctly
// fail on-chain (Invalid allowlist proof) against any root the governor
// hasn't actually published yet, regardless of what allowlist-proof
// reports. That's expected until the publish step is built elsewhere.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import type { MerkleProofEntry } from '../../contracts/midnight/witnesses.js';
import { NoctisLaunchManager, NoctisMidnightClient } from '../midnight-client.js';
import { type CardanoWalletConnection, signCardanoData } from '../wallet-connection.js';
import { buildBinds } from './wallet-control.js';
import type { DarkVeilSession } from './wallet-session.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.message ?? `Request to ${url} failed with ${res.status}`);
  }
  return json as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.message ?? `Request to ${url} failed with ${res.status}`);
  }
  return json as T;
}

// ============================================================================
// Stage 0 — eligibility check (informational, shown to the user before
// they submit an intent — the REAL gate is the governor's own batch run,
// this is just so the UI doesn't ask someone to wait around for nothing)
// ============================================================================

export interface EligibilityCheckResult {
  ok: boolean;
  eligible: boolean;
  checks: {
    not_creator: { eligible: boolean };
    wallet_age: {
      eligible: boolean;
      age_days: number;
      earliest_tx_hash: string | null;
    };
    stake_key_match: {
      eligible: boolean;
      registrant_stake_address: string | null;
      creator_stake_address: string | null;
    };
    no_direct_ada_flow: { eligible: boolean; violating_tx_hash: string | null };
    night_balance: {
      eligible: boolean;
      balance_atomic: string | null;
      min_required_atomic: string | null;
    };
  };
}

export async function checkEligibility(
  apiBase: string,
  registrantAddress: string,
  creatorAddress: string,
): Promise<EligibilityCheckResult> {
  return postJson<EligibilityCheckResult>(`${apiBase}/darkveil/check-eligibility`, {
    registrant_address: registrantAddress,
    creator_address: creatorAddress,
  });
}

// ============================================================================
// Stage 1 — submit intent
// ============================================================================

/**
 * Proves control of the connected Cardano wallet to the DarkVeil server
 * (M-2/M-3 gate, np_dv_require_wallet_control): fetch a fresh nonce for the
 * wallet's stake address, sign it with the wallet's STAKE key, and return the
 * CIP-8 material. Reuses the platform's existing /auth/nonce challenge — the
 * server verifies with NP_CIP8::verify and then confirms the signed stake key
 * owns the base `cardano_address` being registered.
 */
async function buildDarkVeilAuthProof(
  apiBase: string,
  cardano: CardanoWalletConnection,
  binds?: string,
): Promise<{ stake_address: string; signature: string; key: string }> {
  if (!cardano.stakeAddress || !cardano.rewardAddressHex) {
    throw new Error(
      'This wallet has no stake (reward) address. DarkVeil registration requires a base address with a staking key.',
    );
  }
  const nonceRes = await postJson<{ ok: boolean; payload_hex: string }>(`${apiBase}/auth/nonce`, {
    stake_address: cardano.stakeAddress,
    ...(binds ? { binds } : {}),
  });
  if (!nonceRes?.payload_hex) {
    throw new Error('Could not obtain a sign-in challenge from the server.');
  }
  const { signature, key } = await signCardanoData(cardano.walletId, cardano.rewardAddressHex, nonceRes.payload_hex);
  return { stake_address: cardano.stakeAddress, signature, key };
}

/**
 * Scopes a signature to one action and its parameters. MUST match
 * NP_CIP8::build_binds server-side exactly: sha256 over the action name and
 * each parameter, joined by '|', in a fixed order. The server pins this value
 * into the nonce it issues and re-checks it on the signed payload, so a
 * signature collected for any other purpose is rejected and no parameter can
 * be substituted between signing and submission.
 */

export async function submitRegistrationIntent(
  apiBase: string,
  session: DarkVeilSession,
  launchId: string,
): Promise<{ ok: boolean; queued: boolean }> {
  const pubKey = await session.getIdentityPublicKey(hexToBytes(launchId));
  const pubKeyHex = bytesToHex(pubKey.bytes);

  // The NIGHT-balance eligibility check runs against MIDNIGHT, so registration
  // has to carry a Midnight address. It cannot come from pubKeyHex above —
  // that is a one-way hash of (domain, secret, launchId), deliberately scoped
  // per launch so registrations cannot be linked to one person. The connected
  // wallet's unshielded address is the real thing, and unshielded is the right
  // one: it is where NIGHT is held.
  //
  // Refused here rather than server-side so the person sees it while they can
  // still act on it — connecting the Midnight wallet they were going to need
  // for the private buy anyway.
  const midnightAddress = session.midnight?.unshieldedAddress;
  if (!midnightAddress) {
    throw new Error(
      'Connect your Midnight wallet before registering — DarkVeil checks your NIGHT balance on Midnight.',
    );
  }

  const auth = await buildDarkVeilAuthProof(
    apiBase,
    session.cardano,
    // The Midnight address is inside the signed bytes, so it cannot be swapped
    // for someone else's after signing — it is what the balance is measured
    // against. Must stay in step with NP_CIP8::build_binds server-side.
    buildBinds('darkveil:register-intent', [launchId, pubKeyHex, midnightAddress]),
  );
  return postJson(`${apiBase}/darkveil/register-intent`, {
    launch_id: launchId,
    cardano_address: session.cardano.address,
    midnight_pub_key_hex: pubKeyHex,
    midnight_address: midnightAddress,
    stake_address: auth.stake_address,
    signature: auth.signature,
    key: auth.key,
  });
}

// ============================================================================
// Stage 2 — poll for inclusion in the governor's published allowlist
// ============================================================================

export type AllowlistStatus =
  | { included: false }
  | {
      included: true;
      root: string;
      proof: MerkleProofEntry[];
      updatedAt: number;
    };

export async function pollAllowlistProof(
  apiBase: string,
  session: DarkVeilSession,
  launchId: string,
): Promise<AllowlistStatus> {
  const pubKey = await session.getIdentityPublicKey(hexToBytes(launchId));
  const pubKeyHex = bytesToHex(pubKey.bytes);
  const res = await getJson<{
    ok: boolean;
    included: boolean;
    root?: string;
    proof?: Array<{ siblingHex: string; goesLeft: boolean }>;
    updated_at?: number;
  }>(`${apiBase}/darkveil/allowlist-proof?launch_id=${encodeURIComponent(launchId)}&midnight_pub_key_hex=${pubKeyHex}`);

  if (!res.included || !res.root || !res.proof) {
    return { included: false };
  }

  return {
    included: true,
    root: res.root,
    proof: res.proof.map((p) => ({
      sibling: hexToBytes(p.siblingHex),
      goesLeft: p.goesLeft,
    })),
    updatedAt: res.updated_at ?? 0,
  };
}

// ============================================================================
// Stage 3 (buyer side) — the real on-chain registration, once included
// ============================================================================

export interface RegisterOnChainParams {
  tier: 'B' | 'C';
  /** The deployed eligibility_gate (Cardano Launch) or bonding_curve (Midnight Launch) contract's real address — NOT the same as launchId. */
  contractAddress: string;
  /** The deploy-time launchId baked into the contract's own ledger state — a separate value from contractAddress. */
  launchIdBytes: Uint8Array;
  /**
   * The real NIGHT amount (atomic units) being bonded — must match what the
   * contract's own payment enforcement expects. Computing this correctly
   * (matching NP_NIGHT_BOND_USD at the oracle's current price) is the
   * caller's responsibility; this module only builds the commitment hash
   * from whatever value is supplied.
   */
  bondAmount: bigint;
  merkleProof: MerkleProofEntry[];
  providers: ContractProviders;
}

export async function registerOnChain(session: DarkVeilSession, params: RegisterOnChainParams) {
  const identity = await session.getIdentity();
  const buyNonce = await session.getBuyNonce(params.contractAddress);

  const client = new NoctisMidnightClient(identity.userSecretKey);
  if (params.tier === 'B') {
    await client.connectEligibilityGate(params.providers, params.contractAddress, params.merkleProof, buyNonce);
  } else {
    await client.connectBondingCurve(params.providers, params.contractAddress, params.merkleProof, buyNonce);
  }

  // registerForDarkVeil takes nothing: it derives the caller's identity and
  // registration nullifier in-circuit from the witness secret the client
  // above was constructed with.
  const manager = new NoctisLaunchManager(client);
  return manager.registerForDarkVeil();
}

export { bytesToHex, hexToBytes };
