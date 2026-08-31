// ============================================================================
// Noctis Zone — DarkVeil widget: buy-commit + reveal flow
// ============================================================================
// The exact scenario (GitHub #70) started from: commit and reveal
// are two separate transactions, potentially across browser sessions. The
// buy nonce used in both MUST match, or reveal fails — this is now
// guaranteed by session.getBuyNonce() being deterministic (derived from the
// wallet signature, see private-state-store.ts), not a random value that
// could vanish between the two calls.
//
// Same honest scope note as registration-flow.ts: both functions need a
// real ContractProviders to actually submit a Midnight transaction — not
// built anywhere in this codebase yet (no WalletProvider/MidnightProvider
// bridge from the raw dapp-connector API exists). Also same as
// registration-flow.ts: connecting to the contract at all requires the
// SAME witness triple (merkleProof, buyNonce, registrationNonce) regardless
// of which circuit gets called afterward — submitBuyCommit/revealBuyCommit
// don't use the Merkle proof directly, but the witness closure still needs
// one to construct the contract handle.
// ============================================================================

import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { DOMAINS, deriveUserPublicKey, type MerkleProofEntry } from '../../contracts/midnight/witnesses.js';
import { computeBuyCommit } from '../../packages/zk-proofs/src/darkveil.js';
import { NoctisLaunchManager, NoctisMidnightClient } from '../midnight-client.js';
import type { DarkVeilSession } from './wallet-session.js';

export interface BuyFlowContractParams {
  tier: 'B' | 'C';
  contractAddress: string;
  launchIdBytes: Uint8Array;
  merkleProof: MerkleProofEntry[];
  providers: ContractProviders;
}

async function connectForBuyFlow(session: DarkVeilSession, params: BuyFlowContractParams) {
  const identity = await session.getIdentity();
  const buyNonce = await session.getBuyNonce(params.contractAddress);

  const client = new NoctisMidnightClient(identity.userSecretKey);
  if (params.tier === 'B') {
    await client.connectEligibilityGate(params.providers, params.contractAddress, params.merkleProof, buyNonce);
  } else {
    await client.connectBondingCurve(params.providers, params.contractAddress, params.merkleProof, buyNonce);
  }

  const buyerKey = deriveUserPublicKey(identity.userSecretKey, DOMAINS.ELIGIBILITY_USER, params.launchIdBytes).bytes;
  return {
    client,
    manager: new NoctisLaunchManager(client),
    buyerKey,
    buyNonce,
  };
}

export async function submitBuyCommit(
  session: DarkVeilSession,
  params: BuyFlowContractParams & {
    tokenAmount: bigint;
    pricePerToken: bigint;
    timestamp: bigint;
  },
) {
  const { manager, buyerKey, buyNonce } = await connectForBuyFlow(session, params);

  const commitment = computeBuyCommit({
    buyerKey,
    launchId: params.launchIdBytes,
    tokenAmount: params.tokenAmount,
    pricePerToken: params.pricePerToken,
    nonce: buyNonce,
  });

  // submitBuyCommit takes no nullifier parameter: the contract derives it
  // in-circuit from the caller's own secret key (see computeBuyNullifier in
  // eligibility_gate.compact/bonding_curve.compact), so there is nothing
  // for this client to compute or supply.
  return manager.submitDarkVeilBuyCommit(commitment, params.timestamp);
}

export async function revealBuyCommit(
  session: DarkVeilSession,
  params: BuyFlowContractParams & {
    tokenAmount: bigint;
    pricePerToken: bigint;
    // Fix (2026-07-30): Cardano Launch's eligibility_gate.compact
    // revealBuyCommit now takes a real currentTimestamp, bound to real
    // chain time, enforcing a 30-day reveal window after DarkVeil closes.
    // Required for both tiers here (Midnight Launch's circuit ignores it, but the
    // caller always supplies real wall-clock "now").
    currentTimestamp: bigint;
    // Required for Midnight Launch only — bonding_curve.compact's revealBuyCommit
    // now verifies and accrues real fee slices (fix, 2026-07-21;
    // see midnight-client.ts's revealDarkVeilBuyCommit for the full
    // rationale). Cardano Launch's eligibility_gate.compact stays payment-free by
    // design (real settlement is on Cardano), so this is omitted
    // there.
    tierCFees?: {
      claimedCreatorFee: bigint;
      claimedPlatformFee: bigint;
    };
  },
) {
  const { manager, buyerKey, buyNonce } = await connectForBuyFlow(session, params);

  if (params.tier === 'C' && !params.tierCFees) {
    throw new Error(
      'revealBuyCommit: tierCFees is required for Midnight Launch (see manager.revealDarkVeilBuyCommit).',
    );
  }

  // Recomputed with the SAME nonce used at commit time — guaranteed equal
  // now that the nonce is derived, not randomly generated.
  const commitment = computeBuyCommit({
    buyerKey,
    launchId: params.launchIdBytes,
    tokenAmount: params.tokenAmount,
    pricePerToken: params.pricePerToken,
    nonce: buyNonce,
  });

  return manager.revealDarkVeilBuyCommit(
    commitment,
    params.tokenAmount,
    params.pricePerToken,
    params.currentTimestamp,
    params.tierCFees,
  );
}

export async function cancelBuyCommit(
  session: DarkVeilSession,
  params: BuyFlowContractParams & {
    tokenAmount: bigint;
    pricePerToken: bigint;
  },
) {
  const { manager, buyerKey, buyNonce } = await connectForBuyFlow(session, params);

  // Same recompute as revealBuyCommit — cancelDarkVeilBuyCommit's real
  // signature (midnight-client.ts) takes the commitment hash itself, not
  // its component fields, so the caller's original (tokenAmount,
  // pricePerToken) has to be supplied again to reproduce it.
  const commitment = computeBuyCommit({
    buyerKey,
    launchId: params.launchIdBytes,
    tokenAmount: params.tokenAmount,
    pricePerToken: params.pricePerToken,
    nonce: buyNonce,
  });

  return manager.cancelDarkVeilBuyCommit(commitment);
}
