// ============================================================================
// Noctis Zone — Cardano Launch: read eligibility_gate.compact's real DarkVeil
// purchase totals
// ============================================================================
// Closes the same "how do you enumerate a Map off-chain" question
// cto-badge.ts already solved for cto_governance.compact's `proposals`
// field — Compact's Map has NO in-circuit enumeration (confirmed there
// against the real compiler: [Symbol.iterator] is tagged js-only, no VM
// opcode), but the compiled contract's own generated `ledger(state.data)`
// function decodes a real, TS-native object whose Map fields DO implement
// [Symbol.iterator] off-chain (confirmed directly against
// contracts/midnight/compiled/eligibility_gate/contract/index.d.ts:
// `dvTokensPurchased: { ..., [Symbol.iterator](): Iterator<[Uint8Array,
// bigint]> }`). Same query -> decode -> iterate shape, reused rather than
// re-derived.
//
// Governor-side building block for the allocation-tree pipeline: this
// gives the real (userPubKeyHex, dvAmount) pairs for every real DarkVeil
// buyer, keyed by Midnight UserPublicKey — cross-referencing each key back
// to a real Cardano wallet (needed for bonding_curve_tier_b.ak's
// hash_dv_leaf's `vkh` field) is a SEPARATE step, done by the PHP-side
// batch job using darkveil-registration.php's own intake registry (which
// already recorded each registrant's (cardano_address, midnight_pub_key)
// pair at registration time) — this module deliberately does not attempt
// that binding itself, matching the documented trust boundary
// (the governor's off-chain computation is trusted, not re-derived here).
// ============================================================================

import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { ledger } from '../contracts/midnight/compiled/eligibility_gate/contract/index.js';

type ContractAddress = string;

export interface DvPurchase {
  userPubKeyHex: string;
  dvAmount: string; // decimal string — bigint doesn't survive JSON.stringify
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Minimal shape this needs from a decoded Ledger — kept narrow so tests can construct fakes without touching real Midnight runtime types. */
export interface DecodedEligibilityGateLedger {
  dvTokensPurchased: Iterable<[Uint8Array, bigint]>;
  fairLaunchCert?: {
    launchId: Uint8Array;
    totalParticipants: bigint;
    totalTokensAllocated: bigint;
    totalRaised: bigint;
    participationRate: bigint;
    closeTimestamp: bigint;
    certHash: Uint8Array;
  };
  baseSlot?: bigint;
  totalTokensCommitted?: bigint;
  totalRaisedCommitted?: bigint;
  phase?: bigint | number;
  dvState?: bigint | number;
}

/** The contract's own enums, in declaration order. */
export const LAUNCH_PHASES = ['Pending', 'DarkVeil', 'Public', 'Graduated', 'Cancelled'] as const;
export const DV_STATES = ['Inactive', 'Registration', 'Buying', 'Closed', 'Cancelled'] as const;

/**
 * The ZK Fair Launch Certificate, as the contract publishes it.
 *
 * Every figure is decimal-stringified: these are Uint<128> on chain and a
 * bigint does not survive JSON.stringify, which is the boundary this crosses.
 *
 * `closeTimestamp` of 0 means DarkVeil has not closed, so the certificate is
 * not yet meaningful — `closed` says so explicitly rather than leaving each
 * caller to rediscover that a zero timestamp is the sentinel.
 */
export interface FairLaunchCertificate {
  closed: boolean;
  launchIdHex: string;
  totalParticipants: string;
  totalTokensAllocated: string;
  totalRaised: string;
  participationRate: string;
  closeTimestamp: string;
  certHashHex: string;
  /** Per-registrant allocation, needed to express what share of bonds returns. */
  baseSlot: string;
  /**
   * The SETTLED totals, read from the ledger rather than from the certificate.
   *
   * The certificate is stamped by `closeDarkVeil`, and in a commit/reveal
   * scheme the reveals come AFTER close — so `totalTokensAllocated` and
   * `totalRaised` on the certificate itself are legitimately zero at stamping
   * time and stay that way. The figures a reader means by "what this phase
   * raised" are these two, which the reveals accumulate.
   *
   * Kept separate from the certificate's own fields rather than substituted
   * into them, so nothing here misrepresents what the contract signed.
   */
  revealedTokens: string;
  revealedRaised: string;
}

export function extractFairLaunchCert(decoded: DecodedEligibilityGateLedger): FairLaunchCertificate | null {
  const cert = decoded.fairLaunchCert;
  if (!cert) return null;
  return {
    closed: cert.closeTimestamp > 0n,
    launchIdHex: bytesToHex(cert.launchId),
    totalParticipants: cert.totalParticipants.toString(),
    totalTokensAllocated: cert.totalTokensAllocated.toString(),
    totalRaised: cert.totalRaised.toString(),
    participationRate: cert.participationRate.toString(),
    closeTimestamp: cert.closeTimestamp.toString(),
    certHashHex: bytesToHex(cert.certHash),
    baseSlot: (decoded.baseSlot ?? 0n).toString(),
    revealedTokens: (decoded.totalTokensCommitted ?? 0n).toString(),
    revealedRaised: (decoded.totalRaisedCommitted ?? 0n).toString(),
  };
}

/** Pure extraction logic — no I/O, trivially testable. Only real (nonzero) purchases are returned; a zero entry (never legitimately written by revealBuyCommit, which always increments by a positive tokenAmount) is filtered defensively rather than assumed impossible. */
export function extractDvPurchases(decoded: DecodedEligibilityGateLedger): DvPurchase[] {
  const out: DvPurchase[] = [];
  for (const [userPubKey, dvAmount] of decoded.dvTokensPurchased) {
    if (dvAmount > 0n) {
      out.push({
        userPubKeyHex: bytesToHex(userPubKey),
        dvAmount: dvAmount.toString(),
      });
    }
  }
  return out;
}

/** Real I/O wrapper — queries the indexer's current contract state and decodes it via the compiled contract's own generated ledger() function. */
export async function readDvPurchases(
  publicDataProvider: PublicDataProvider,
  contractAddress: ContractAddress,
): Promise<{
  deployed: boolean;
  purchases: DvPurchase[];
  certificate: FairLaunchCertificate | null;
  /** Named rather than numeric: a caller comparing against 3 has to know the enum. */
  phase?: string;
  dvState?: string;
}> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) {
    return { deployed: false, purchases: [], certificate: null };
  }
  const decoded = ledger(contractState.data);
  // Returned alongside the purchases rather than from a second CLI: both come
  // from ONE decode of ONE contract-state query, so a caller that needs both
  // cannot see them from different blocks.
  return {
    deployed: true,
    purchases: extractDvPurchases(decoded),
    certificate: extractFairLaunchCert(decoded),
    phase: LAUNCH_PHASES[Number(decoded.phase ?? 0)],
    dvState: DV_STATES[Number(decoded.dvState ?? 0)],
  };
}
