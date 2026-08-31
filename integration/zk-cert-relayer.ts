// ============================================================================
// Noctis Zone — ZK Fair Launch Certificate Relayer
// ============================================================================
// CLAUDE.md's design: after DarkVeil closes on Midnight, the resulting ZK Fair
// Launch Certificate needs to be anchored on Cardano L1
// (contracts/cardano/validators/zk_anchor.ak) so it's publicly verifiable —
// including for Midnight Launch, whose launch otherwise has no Cardano footprint at
// all. CLAUDE.md's decision: "Default: Option A [direct Midnight SDK
// cross-chain posting] if supported, fall back to Option B [platform-
// operated relayer]. Do not use Option C [omit the anchor]."
//
// Option A confirmed NOT available (2026-07-10): every real Midnight SDK
// surface inspected this session — @midnight-ntwrk/midnight-js-contracts
// (earlier investigation), @midnight-ntwrk/dapp-connector-api (earlier
// investigation) — is entirely Midnight-side. Neither exposes any
// Cardano-aware primitive. This matches CLAUDE.md's own framing (Option B
// was already the practical default) rather than being a new finding, so
// this file implements Option B: a platform-operated relayer.
//
// SCOPE OF THIS FILE (honest, not aspirational):
//   - Fetching the FairLaunchCert from the connected Midnight contract: REAL.
//   - Assembling and Blake2b-256 hashing the proof bundle: REAL, matches
//     zk_anchor.ak's documented "Blake2b-256" hash exactly (verified against
//     the real @noble/hashes/blake2.js API before use, not guessed).
//   - IPFS pinning: a pluggable interface, not a hardcoded vendor — which
//     pinning service to use is an undecided operational choice (same
//     category as the stablecoin choice), not something to bake in here.
//   - Building + submitting the actual Cardano transaction that spends
//     zk_anchor.ak's UTXO via its AnchorCertificate redeemer: REAL as of
//     2026-07-10 — see `cardano-anchor-submitter.ts`'s `LucidAnchorSubmitter`,
//     which implements `CardanoTxSubmitter` below using `@lucid-evolution/
//     lucid` (confirmed real, published, actively maintained — Anvil's
//     documented endpoints and live docs site don't expose a generic
//     arbitrary-validator-plus-custom-redeemer spend, so Lucid Evolution was
//     used instead). The Data encoding, UTXO lookup, and transaction
//     construction are all built against Lucid Evolution's real, installed
//     API — not stubbed. What's NOT done: an actual end-to-end submission
//     against a live node, which needs a funded relayer key and a deployed
//     zk_anchor UTXO that don't exist in this dev environment. See that
//     file's header for the exact boundary of what's tested vs. not.
// ============================================================================

import { blake2b } from '@noble/hashes/blake2.js';
import type { NoctisLaunchManager } from './midnight-client.js';

// ============================================================================
// TYPES — mirror contracts/cardano/validators/zk_anchor.ak exactly
// ============================================================================

export type CertificateType = 'DarkVeilCert' | 'FullZKCert' | 'CtoVoteResult' | 'GraduationCert';

/** Mirrors bonding_curve.compact / darkveil.compact's `FairLaunchCert` struct. */
export interface FairLaunchCert {
  launchId: Uint8Array;
  totalParticipants: bigint;
  totalTokensAllocated: bigint;
  totalRaised: bigint;
  /**
   * Uint<8> — percentage of the allowlist that took part.
   *
   * A bigint, because that is what the compiled contract hands back for every
   * Compact numeric type regardless of width. The bundle below narrows it to a
   * JSON number, which is where the range is checked.
   */
  participationRate: bigint;
  closeTimestamp: bigint;
  certHash: Uint8Array; // Compact's own persistentHash — NOT the Blake2b-256 hash below
}

/** What actually gets submitted to zk_anchor.ak's AnchorCertificate redeemer. */
export interface AnchorCertificateParams {
  certType: CertificateType;
  proofBundleHash: Uint8Array; // Blake2b-256, 32 bytes
  proofIpfsCid: Uint8Array; // encoded CID bytes (not the string form)
  metadataHash: Uint8Array; // Blake2b-256, 32 bytes
  /**
   * When the anchor transaction itself is submitted, POSIX MILLISECONDS.
   *
   * Deliberately NOT the DarkVeil close time: zk_anchor.ak validates this
   * against the transaction's own validity range, which is the only clock a
   * Cardano script can see, and that range is in milliseconds. A value taken
   * from Midnight's own close timestamp could never fall inside it.
   *
   * The DarkVeil close time is still part of the certificate — it travels in
   * the proof bundle and is committed to by metadataHash — it just is not
   * what `anchor_timestamp` records.
   */
  timestamp: bigint;
}

// ============================================================================
// PROOF BUNDLE ASSEMBLY + HASHING (real)
// ============================================================================

/**
 * The "proof bundle" is the JSON blob pinned to IPFS and referenced by
 * proof_bundle_hash on Cardano — the certificate's public, human/tool
 * readable form. Field order is fixed (not object insertion order) so the
 * hash is deterministic across runs/languages.
 */
export interface ProofBundle {
  launchId: string; // hex
  tier: 'B' | 'C';
  totalParticipants: string; // decimal string — bigint doesn't survive JSON.stringify
  totalTokensAllocated: string;
  totalRaised: string;
  /**
   * A JSON number rather than the decimal string the other figures use, and it
   * stays that way: this value is hashed, so the encoding is part of what the
   * certificate commits to. `Uint<8>` spans 0-255, well inside what a JSON
   * number represents exactly, so narrowing it loses nothing.
   */
  participationRate: number;
  closeTimestamp: string;
  certHash: string; // hex — Compact's own persistentHash, included for cross-verification
  /**
   * The Merkle root the DarkVeil allocation actually settles against, hex.
   *
   * Everything above this line is an AGGREGATE — how many took part, how much
   * was raised, how many tokens went out. None of it says WHICH allocations
   * the launch will honour, and on Cardano Launch that is decided entirely by the root
   * `AnchorDvAllocationRoot` writes into the curve datum, since
   * `ClaimDarkVeilTokens` pays out against a proof under that root and nothing
   * else. Committing to it here is what lets a reader check that the
   * certificate and the money describe the same distribution: read
   * `dv_allocation_root` off the curve UTXO, compare it to this field, and any
   * disagreement is visible without trusting the relayer that published both.
   *
   * Empty string on Midnight Launch, and that is a real difference rather than an
   * omission: Midnight Launch allocates every registrant the same `baseSlot`
   * (`closeDarkVeil` sets one figure for all of them), so there is no
   * per-registrant tree for a root to summarise. `totalTokensAllocated` and
   * `totalParticipants` already pin that distribution between them. If Midnight Launch
   * ever gains per-registrant allocations, this is the field they bind to.
   */
  dvAllocationRoot: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * `dvAllocationRoot` is REQUIRED on Cardano Launch and refused rather than defaulted:
 * a Cardano Launch certificate that omits it is exactly the certificate that says
 * nothing about who gets paid, and a silent empty string would produce a
 * perfectly valid-looking bundle carrying that hole. Midnight Launch passes nothing —
 * see the field's own comment for why it has no root to bind.
 */
export function assembleProofBundle(cert: FairLaunchCert, tier: 'B' | 'C', dvAllocationRoot?: Uint8Array): ProofBundle {
  if (tier === 'B' && dvAllocationRoot?.length !== 32) {
    throw new Error(
      'Cannot assemble a Cardano Launch proof bundle without the DarkVeil allocation root: ' +
        `expected 32 bytes, got ${dvAllocationRoot ? `${dvAllocationRoot.length} bytes` : 'nothing'}. ` +
        'This is the root ClaimDarkVeilTokens settles against, so a certificate omitting it ' +
        'commits to no distribution at all.',
    );
  }
  if (tier === 'C' && dvAllocationRoot) {
    throw new Error(
      'Midnight Launch has no DarkVeil allocation root to bind — every registrant receives the same ' +
        'baseSlot, so there is no per-registrant tree. Passing one means the caller has ' +
        'confused it with something else.',
    );
  }
  // Narrowed here, not at the boundary, and checked rather than trusted. The
  // bundle is hashed by JSON serialisation, and JSON has no bigint — so a value
  // arriving as one has to become a number for the hash to exist at all. The
  // declared Uint<8> makes every legal value exact as a number; anything
  // outside that range did not come from this certificate's own field, and
  // stopping is better than hashing a figure the contract never published.
  if (cert.participationRate < 0n || cert.participationRate > 255n) {
    throw new Error(
      `participationRate ${cert.participationRate} is outside the Uint<8> range the certificate declares (0-255).`,
    );
  }
  return {
    launchId: toHex(cert.launchId),
    tier,
    totalParticipants: cert.totalParticipants.toString(),
    totalTokensAllocated: cert.totalTokensAllocated.toString(),
    totalRaised: cert.totalRaised.toString(),
    participationRate: Number(cert.participationRate),
    closeTimestamp: cert.closeTimestamp.toString(),
    certHash: toHex(cert.certHash),
    dvAllocationRoot: dvAllocationRoot ? toHex(dvAllocationRoot) : '',
  };
}

/** Deterministic serialization — fixed key order, no whitespace. */
function canonicalizeProofBundle(bundle: ProofBundle): Uint8Array {
  const ordered = {
    launchId: bundle.launchId,
    tier: bundle.tier,
    totalParticipants: bundle.totalParticipants,
    totalTokensAllocated: bundle.totalTokensAllocated,
    totalRaised: bundle.totalRaised,
    participationRate: bundle.participationRate,
    closeTimestamp: bundle.closeTimestamp,
    certHash: bundle.certHash,
    // Appended rather than slotted in beside the allocation figures, so every
    // field already in this order keeps its position and the only hash change
    // is the one this addition is meant to cause.
    dvAllocationRoot: bundle.dvAllocationRoot,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * Blake2b-256 (32-byte output — zk_anchor.ak's datum comment specifies
 * "Blake2b-256" for both proof_bundle_hash and metadata_hash). Verified
 * against the real @noble/hashes/blake2.js API (blake2b(msg, {dkLen})) by
 * extracting the actual published package before writing this — not
 * assumed from a generic "blake2b" memory.
 */
export function computeProofBundleHash(bundle: ProofBundle): Uint8Array {
  return blake2b(canonicalizeProofBundle(bundle), { dkLen: 32 });
}

/**
 * Additional metadata the anchor stores hash-committed rather than in the
 * clear (zk_anchor.ak: "Additional metadata ... hash-committed to preserve
 * privacy of underlying data"). What goes in here beyond the proof bundle
 * itself (e.g. launch display name, tier label for the certificate badge
 * UI) is a product decision, not fixed by the contract — this function
 * takes whatever the caller decides belongs here.
 */
export function computeMetadataHash(metadata: Record<string, string | number | boolean>): Uint8Array {
  const keys = Object.keys(metadata).sort();
  const ordered: Record<string, string | number | boolean> = {};
  for (const k of keys) ordered[k] = metadata[k];
  return blake2b(new TextEncoder().encode(JSON.stringify(ordered)), {
    dkLen: 32,
  });
}

// ============================================================================
// IPFS PINNING (pluggable — no vendor hardcoded)
// ============================================================================

export interface IpfsPinner {
  /** Pins `content` and returns the resulting CID as raw bytes (not the base32/base58 string form). */
  pin(content: Uint8Array): Promise<Uint8Array>;
}

// ============================================================================
// CARDANO SUBMISSION — honestly not implemented (see file header)
// ============================================================================

/**
 * What relayCertificate() below needs in order to actually anchor a
 * certificate. Implemented for real 2026-07-10 by `LucidAnchorSubmitter` in
 * `cardano-anchor-submitter.ts`, using `@lucid-evolution/lucid` (Anvil's
 * documented endpoints don't expose a generic arbitrary-validator-plus-
 * custom-redeemer spend, confirmed by checking its live docs site, so this
 * repo's Cardano tx-building layer is Lucid Evolution rather than Anvil).
 * This interface stays here so the rest of the relayer (cert fetching,
 * hashing, bundle assembly) can also be developed and tested against a
 * lightweight mock implementation, independent of Cardano wiring.
 */
export interface CardanoTxSubmitter {
  submitAnchorCertificate(params: AnchorCertificateParams, relayerAddress: string): Promise<{ txHash: string }>;
}

// ============================================================================
// ORCHESTRATION
// ============================================================================

export interface RelayCertificateResult {
  bundle: ProofBundle;
  proofBundleHash: Uint8Array;
  proofIpfsCid: Uint8Array;
  metadataHash: Uint8Array;
  txHash: string;
}

/**
 * Full relay flow: fetch the cert from Midnight, assemble + hash the proof
 * bundle, pin it to IPFS, then anchor the hashes on Cardano L1.
 *
 * `tier` determines certType: Cardano Launch closes DarkVeil into a public curve on
 * Cardano already so its cert is 'DarkVeilCert'; Midnight Launch's is the
 * 'FullZKCert' (the whole launch, not just DarkVeil, lives on Midnight).
 */
export async function relayCertificate(
  launchManager: NoctisLaunchManager,
  tier: 'B' | 'C',
  /**
   * The same 32 bytes `AnchorDvAllocationRoot` writes to the Cardano Launch curve, so
   * the certificate and the settlement commit to one distribution. Omitted on
   * Midnight Launch. `assembleProofBundle` refuses a Cardano Launch call without it.
   */
  dvAllocationRoot: Uint8Array | undefined,
  ipfsPinner: IpfsPinner,
  cardanoSubmitter: CardanoTxSubmitter,
  relayerAddress: string,
  extraMetadata: Record<string, string | number | boolean> = {},
): Promise<RelayCertificateResult> {
  // Returns the certificate itself. On Cardano Launch that is a read of the published
  // ledger; on Midnight Launch it is a circuit call whose `.private.result` unwrapping
  // the manager handles. Either way the caller gets a FairLaunchCert.
  const cert = await launchManager.getFairLaunchCert();

  const bundle = assembleProofBundle(cert, tier, dvAllocationRoot);
  const proofBundleHash = computeProofBundleHash(bundle);
  const metadataHash = computeMetadataHash({ tier, ...extraMetadata });
  const proofIpfsCid = await ipfsPinner.pin(canonicalizeProofBundle(bundle));

  const { txHash } = await cardanoSubmitter.submitAnchorCertificate(
    {
      certType: tier === 'B' ? 'DarkVeilCert' : 'FullZKCert',
      proofBundleHash,
      proofIpfsCid,
      metadataHash,
      // The anchoring time, not cert.closeTimestamp — see the field's own
      // doc comment on AnchorCertificateParams.
      timestamp: BigInt(Date.now()),
    },
    relayerAddress,
  );

  return { bundle, proofBundleHash, proofIpfsCid, metadataHash, txHash };
}
