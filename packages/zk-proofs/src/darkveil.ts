// The DarkVeil-phase hashes, shared by both tiers.
//
// DarkVeil has no contract of its own: its logic lives inside
// eligibility_gate.compact (Cardano Launch) and bonding_curve.compact (Midnight Launch),
// which each carry an identical copy of these `pure circuit` helpers —
// same domain strings, same struct field order. That is why this module is
// named for the phase rather than for either contract, and why one twin
// serves both tiers.
//
// Domain strings and struct field orders are copied verbatim from those
// files — do not change either without updating both contracts to match.
// The commitment a buyer submits has to equal what revealBuyCommit
// recomputes on-chain, so a drift here is a reveal that can never succeed;
// the contract tests exercise that round trip and go red on any mismatch.
//
// `domain` leads every struct below because `persistentHash` hashes a
// value's ENCODED FIELDS, not its type: two structs with the same field
// types in the same order hash identically for the same values, as does a
// `Vector<n, Bytes<32>>` against an n-field struct of `Bytes<32>`. The
// distinct leading constant is what separates these values from every
// other hash the contracts compute.

import { bytes32Type, pad32, persistentHash, structType, uintType } from './compact-types.js';

interface BuyCommitInput {
  buyerKey: Uint8Array;
  launchId: Uint8Array;
  tokenAmount: bigint;
  pricePerToken: bigint;
  nonce: Uint8Array;
}

const BUY_COMMIT_DOMAIN = 'noctis:dv:buy:commit:v1';

const buyCommitInputType = structType<BuyCommitInput & { domain: Uint8Array }>([
  ['domain', bytes32Type],
  ['buyerKey', bytes32Type],
  ['launchId', bytes32Type],
  ['tokenAmount', uintType(128)],
  ['pricePerToken', uintType(128)],
  ['nonce', bytes32Type],
]);

/** `computeBuyCommit` — eligibility_gate.compact and bonding_curve.compact. */
export function computeBuyCommit(input: BuyCommitInput): Uint8Array {
  return persistentHash(buyCommitInputType, { domain: pad32(BUY_COMMIT_DOMAIN), ...input });
}

interface CertHashInput {
  launchId: Uint8Array;
  totalParticipants: bigint;
  totalTokensAllocated: bigint;
  totalRaised: bigint;
  closeTimestamp: bigint;
}

const CERT_HASH_DOMAIN = 'noctis:dv:cert:v1';

const certHashInputType = structType<CertHashInput & { domain: Uint8Array }>([
  ['domain', bytes32Type],
  ['launchId', bytes32Type],
  ['totalParticipants', uintType(64)],
  ['totalTokensAllocated', uintType(128)],
  ['totalRaised', uintType(128)],
  ['closeTimestamp', uintType(64)],
]);

/** `computeCertHash` — eligibility_gate.compact and bonding_curve.compact. */
export function computeCertHash(input: CertHashInput): Uint8Array {
  return persistentHash(certHashInputType, { domain: pad32(CERT_HASH_DOMAIN), ...input });
}
