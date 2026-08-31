// ============================================================================
// Noctis Zone — Cardano L1 ZK Anchor Contract (Aiken)
// Used by Cardano Launch and Midnight Launch (CLAUDE.md Contract Architecture table)
// ============================================================================
// This contract receives and stores ZK proof bundles from Midnight PSMs.
// It serves as the public, on-chain anchor for ZK Fair Launch Certificates.
//
// Key properties:
//   1. Immutable — once a certificate is anchored, it cannot be removed
//   2. Publicly readable — anyone can query the anchor to verify a launch
//   3. Relayer-authenticated — only authorized relayers can submit proofs
//   4. Supports Cardano Launch (DarkVeil ZK cert) and Midnight Launch (full Midnight ZK cert)
//
// The anchor stores:
//   - The proof bundle hash (not the full proof — that's too large for a datum)
//   - The launch ID
//   - The certificate type (DarkVeil, FullZK, CTO vote, Graduation)
//   - The timestamp of anchoring
//   - The relayer who submitted it
//
// Off-chain verification:
//   1. Query the Cardano UTxO at the anchor address for the certificate datum
//   2. Fetch the full proof bundle from IPFS or the Noctis API
//   3. Verify the proof bundle hash matches the on-chain anchor
//   4. Verify the ZK proof using the Midnight verifier
//
// Rewritten 2026-07-09 to match real Aiken v1.1.23 syntax — see
// bonding_curve.ak's header comment for the full explanation. Relayer/
// governor authorization now uses `self.extra_signatories` instead of
// manually re-verifying a signature passed through the redeemer.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, from_verification_key}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use noctis/thread_nft

// ============================================================================
// TYPES
// ============================================================================

/// Certificate types — which Midnight PSM generated this proof
pub type CertificateType {
  /// DarkVeil Fair Launch Certificate (Cardano Launch) — proves: creator bought 0
  /// tokens, no front-running, >=50% participation
  DarkVeilCert
  /// Full ZK Certificate (Midnight Launch) — proves: all eligibility checks passed,
  /// private bonding curve was fair
  FullZKCert
  /// CTO Governance Result Anchor — anchors the result of a Midnight
  /// CTO governance vote to Cardano L1
  CtoVoteResult
  /// Bonding Curve Graduation Certificate — proves: 100% sell-through
  /// achieved, graduation was legitimate
  GraduationCert
}

/// The datum stored at the ZK Anchor UTxO
pub type ZkAnchorDatum {
  // Launch identity
  launch_id: ByteArray,
  // Certificate type
  cert_type: CertificateType,
  // Hash of the full ZK proof bundle (stored off-chain on IPFS), Blake2b-256
  proof_bundle_hash: ByteArray,
  // IPFS CID of the full proof bundle (for retrieval)
  proof_ipfs_cid: ByteArray,
  // When the certificate was anchored, POSIX MILLISECONDS — validated
  // against the transaction's own validity range, which is the only clock a
  // script can see and is itself in milliseconds. This is the anchoring
  // time, not the DarkVeil close time; the latter travels in the proof
  // bundle and is committed to by metadata_hash.
  anchor_timestamp: Int,
  // Relayer's verification key hash (who submitted this)
  relayer_credential_hash: VerificationKeyHash,
  // Platform governor's key hash (authorized relayer list manager)
  governor_credential_hash: VerificationKeyHash,
  // Additional metadata (e.g., total raised, participant count) —
  // hash-committed to preserve privacy of underlying data, Blake2b-256
  metadata_hash: ByteArray,
  // 2026-08-03 audit: policy id of this launch's thread NFTs. This UTXO
  // must carry (thread_nft_policy, role_zk_anchor ++ launch_id[..31]) on
  // both the spent input and the continuing output — see noctis/thread_nft.
  thread_nft_policy: PolicyId,
}

/// Redeemer actions
pub type ZkAnchorRedeemer {
  /// Submit a new ZK certificate (relayer only)
  AnchorCertificate {
    cert_type: CertificateType,
    proof_bundle_hash: ByteArray,
    proof_ipfs_cid: ByteArray,
    metadata_hash: ByteArray,
    timestamp: Int,
  }
  /// Add an authorized relayer (governor only)
  AddRelayer { relayer_credential_hash: VerificationKeyHash }
  /// Remove an authorized relayer (governor only)
  RemoveRelayer { relayer_credential_hash: VerificationKeyHash }
  /// Read-only query, no state change, no authorization required
  QueryCertificate
  /// Update IPFS CID (if the proof bundle needs re-pinning). Only the
  /// original relayer or governor can do this.
  UpdateIpfsCid { new_ipfs_cid: ByteArray }
}

// ============================================================================
// HELPERS
// ============================================================================

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> ZkAnchorDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: ZkAnchorDatum = raw_datum
  new_datum
}

/// Fix (2026-07-19, Cardano Launch cross-chain audit): same double-satisfaction
/// closure as bonding_curve.ak/lp_escrow.ak/etc.'s own single_own_utxo — this
/// validator has zero constructor parameters (one shared script address for
/// every both launch types launch's anchor, distinguished only by launch_id in the
/// datum), the same structural precondition that made this fix necessary
/// everywhere else. Missed by the original sweep since this file wasn't
/// in that pass's file list — see internal tracking.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  // Compared by PAYMENT credential, never by the full Address. The staking
  // part of an address is chosen freely by whoever builds the output, so two
  // UTXOs at this same script can carry different delegation keys while being
  // equally "ours". Matching on the whole Address would let those two stop
  // counting as one another's company, which is exactly what this check
  // exists to prevent.
  let own_payment = own_address.payment_credential
  list.length(
    list.filter(
      self.inputs,
      fn(input) { input.output.address.payment_credential == own_payment },
    ),
  ) <= 1 && list.length(
    list.filter(
      self.outputs,
      fn(output) { output.address.payment_credential == own_payment },
    ),
  ) <= 1
}

/// Fix: this contract is a pure anchor — no redeemer ever legitimately
/// moves ADA in or out (unlike bonding_curve.ak/lp_escrow.ak, which accrue
/// fees or hold real locked value). Every state-changing redeemer here only
/// ever mutates the datum, so the continuing output's real lovelace must
/// stay byte-for-byte unchanged. Closes the same "own_continuing_datum only
/// checks datum, never value" root-cause pattern found in cto_governance.ak
/// (§6c) — here fixed as a blanket check since there's no legitimate
/// value-changing case to carve out.
fn value_unchanged(self: Transaction, own_ref: OutputReference) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value)
}

/// A script only ever sees the transaction's OWN DECLARED validity range,
/// never real wall-clock time, so `interval.contains` alone lets a caller
/// claim any timestamp inside an arbitrarily wide self-chosen range. Bounding
/// the width is what makes `anchor_timestamp` mean something. Same helper and
/// same 10-minute bound already used by the bonding curves.
fn validity_range_is_narrow(range: Interval, max_width: Int) -> Bool {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      hi >= lo && hi - lo <= max_width
    _ -> False
  }
}

/// 10 minutes in milliseconds.
const max_validity_range_width = 600_000

/// Whether this launch's certificate has already been anchored.
///
/// A certificate is the launch's public trust artifact, so anchoring is
/// one-way: the evidence fields are written exactly once and never revised.
/// An empty `proof_bundle_hash` is the genesis state written by the launch's
/// own mint, and a real Blake2b-256 hash is never empty, so its emptiness is
/// a reliable "not yet anchored" marker with no extra datum field needed.
///
/// This does not freeze the whole datum: `UpdateIpfsCid` still lets the
/// relayer or governor repair the pointer to a re-pinned bundle, which
/// changes where the evidence is fetched from without changing the evidence
/// itself — its own structural-equality check already holds every other
/// field fixed.
fn already_anchored(datum: ZkAnchorDatum) -> Bool {
  datum.proof_bundle_hash != #""
}

/// State authentication (2026-08-03 audit) — the launch's own thread NFT must
/// be present on the UTXO being spent AND on the continuing output. See
/// noctis/thread_nft, and bonding_curve.ak's thread_nft_intact, for the full
/// reasoning: this validator is unparameterized, so every launch's anchor
/// shares one address.
///
/// One anchor UTXO per launch follows from this, since the asset name is
/// derived from launch_id alone. How a launch's certificate lifecycle should
/// be structured across that single UTXO is a separate, open design decision;
/// if it lands as one UTXO per certificate type, the role tag splits the same
/// way.
fn thread_nft_intact(
  self: Transaction,
  own_ref: OutputReference,
  datum: ZkAnchorDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  let name =
    thread_nft.thread_asset_name(thread_nft.role_zk_anchor, datum.launch_id)
  when list.find(self.outputs, fn(output) { output.address == own_address }) is {
    None -> False
    Some(own_output) -> and {
        assets.quantity_of(own_input.output.value, datum.thread_nft_policy, name) == 1,
        assets.quantity_of(own_output.value, datum.thread_nft_policy, name) == 1,
      }
  }
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator zk_anchor {
  spend(
    datum_opt: Option<ZkAnchorDatum>,
    redeemer: ZkAnchorRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    and {
      // Closes the shared-address double-satisfaction gap. Does NOT
      // also blanket-wrap value_unchanged here — QueryCertificate's `->
      // False` arm needs no continuing output to exist at all (that's
      // exactly the drain shape being rejected), and value_unchanged's own
      // `expect Some(own_output) = ...` would trap rather than cleanly
      // return False if forced unconditionally against that shape. Applied
      // individually inside each real (non-QueryCertificate) arm below
      // instead.
      single_own_utxo(self, own_input.output.address),
      // State authentication (2026-08-03 audit) — see thread_nft_intact.
      thread_nft_intact(self, own_ref, datum),
      when redeemer is {
        AnchorCertificate {
        cert_type,
        proof_bundle_hash,
        proof_ipfs_cid,
        metadata_hash,
        timestamp,
      } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.relayer_credential_hash),
          // Anchoring is one-way — see already_anchored. Without this the
          // relayer could silently replace a launch's published certificate
          // with a different one, and this file's own stated property #1
          // ("once a certificate is anchored, it cannot be removed") was
          // documented but never implemented.
          !already_anchored(datum),
          // A certificate with an empty proof bundle hash would satisfy the
          // guard above forever, leaving the anchor permanently re-writable.
          proof_bundle_hash != #"",
          // `timestamp` is a free redeemer parameter, so it is only
          // meaningful if it falls inside a validity range narrow enough to
          // approximate real time.
          interval.contains(self.validity_range, timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          // Real value must stay exactly unchanged — this action
          // only ever mutates the datum.
          value_unchanged(self, own_ref),
          new_datum == ZkAnchorDatum {
            ..datum,
            cert_type: cert_type,
            proof_bundle_hash: proof_bundle_hash,
            proof_ipfs_cid: proof_ipfs_cid,
            anchor_timestamp: timestamp,
            metadata_hash: metadata_hash,
          },
        }
      }

      AddRelayer { relayer_credential_hash } -> {
        // NOTE: single active relayer per anchor UTxO (matches the original
        // design's simplification) — replaces, doesn't accumulate a list.
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_credential_hash),
          value_unchanged(self, own_ref),
          new_datum == ZkAnchorDatum {
            ..datum,
            relayer_credential_hash: relayer_credential_hash,
          },
        }
      }

      RemoveRelayer { relayer_credential_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_credential_hash),
          relayer_credential_hash == datum.relayer_credential_hash,
          value_unchanged(self, own_ref),
          new_datum == ZkAnchorDatum {
            ..datum,
            relayer_credential_hash: #"",
          },
        }
      }

      // Fix (2026-07-19, Cardano Launch cross-chain audit): same critical
      // fix, same reasoning, as the other 6 validators — was an
      // unconditional `True` (zero checks). This file was a 7th validator
      // missed by that sweep; see internal tracking.
      QueryCertificate -> False

      UpdateIpfsCid { new_ipfs_cid } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let is_relayer =
          list.has(self.extra_signatories, datum.relayer_credential_hash)
        let is_governor =
          list.has(self.extra_signatories, datum.governor_credential_hash)
        and {
          is_relayer || is_governor,
          value_unchanged(self, own_ref),
          new_datum == ZkAnchorDatum {
            ..datum,
            proof_ipfs_cid: new_ipfs_cid,
          },
        }
      }
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

/// State authentication (2026-08-03 audit) — the thread NFT this launch's
/// state UTXO must carry, matching the mock datum's launch_id (#"01") and
/// thread_nft_policy (#"c0ffee"). Derived through thread_asset_name rather
/// than hard-coded so a scheme change cannot leave these silently passing.
fn mock_anchor_nft() -> assets.Value {
  assets.from_asset(
    #"c0ffee",
    thread_nft.thread_asset_name(thread_nft.role_zk_anchor, #"01"),
    1,
  )
}


/// The genesis state the launch's own mint writes: no certificate anchored
/// yet, so every evidence field is empty and anchor_timestamp is 0. Mirrors
/// build-tier-a-genesis-datums.ts's real output — a test that anchored from
/// an already-populated datum would be exercising a second anchor, which is
/// no longer a legal transition.
fn mock_unanchored_datum() -> ZkAnchorDatum {
  ZkAnchorDatum {
    ..mock_datum(),
    proof_bundle_hash: #"",
    proof_ipfs_cid: #"",
    anchor_timestamp: 0,
    metadata_hash: #"",
  }
}

fn mock_datum() -> ZkAnchorDatum {
  ZkAnchorDatum {
    launch_id: #"01",
    cert_type: DarkVeilCert,
    proof_bundle_hash: #"aa",
    proof_ipfs_cid: #"bb",
    anchor_timestamp: 1000,
    relayer_credential_hash: #"11",
    governor_credential_hash: #"22",
    metadata_hash: #"cc",
    thread_nft_policy: #"c0ffee",
  }
}

test anchor_certificate_succeeds_with_authorized_relayer() {
  let datum = mock_unanchored_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    ZkAnchorDatum {
      ..datum,
      cert_type: DarkVeilCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      anchor_timestamp: 2000,
      metadata_hash: #"ff",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
      validity_range: interval.between(1_900, 2_100),
    }
  let redeemer =
    AnchorCertificate {
      cert_type: DarkVeilCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      metadata_hash: #"ff",
      timestamp: 2000,
    }

  zk_anchor.spend(Some(datum), redeemer, own_ref, self)
}

/// Anchoring is one-way. mock_datum() is already anchored, so this is the
/// same honest transaction as above differing only in its starting state —
/// a relayer attempting to replace a launch's published certificate.
test anchor_certificate_rejects_overwriting_an_anchored_certificate() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    ZkAnchorDatum {
      ..datum,
      cert_type: GraduationCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      anchor_timestamp: 2000,
      metadata_hash: #"ff",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
      validity_range: interval.between(1_900, 2_100),
    }
  let redeemer =
    AnchorCertificate {
      cert_type: GraduationCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      metadata_hash: #"ff",
      timestamp: 2000,
    }

  !zk_anchor.spend(Some(datum), redeemer, own_ref, self)
}

/// An empty proof bundle hash would leave the anchor permanently rewritable,
/// since emptiness is what marks it unanchored.
test anchor_certificate_rejects_empty_proof_bundle_hash() {
  let datum = mock_unanchored_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    ZkAnchorDatum { ..datum, proof_ipfs_cid: #"ee", anchor_timestamp: 2000 }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
      validity_range: interval.between(1_900, 2_100),
    }
  let redeemer =
    AnchorCertificate {
      cert_type: DarkVeilCert,
      proof_bundle_hash: #"",
      proof_ipfs_cid: #"ee",
      metadata_hash: #"",
      timestamp: 2000,
    }

  !zk_anchor.spend(Some(datum), redeemer, own_ref, self)
}

/// A self-chosen validity range wide enough to make anchor_timestamp
/// meaningless is rejected — same bound the bonding curves already apply.
test anchor_certificate_rejects_wide_validity_range() {
  let datum = mock_unanchored_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    ZkAnchorDatum {
      ..datum,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      anchor_timestamp: 2000,
      metadata_hash: #"ff",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
      // 10 minutes + 1ms.
      validity_range: interval.between(2_000, 2_000 + 600_001),
    }
  let redeemer =
    AnchorCertificate {
      cert_type: DarkVeilCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      metadata_hash: #"ff",
      timestamp: 2000,
    }

  !zk_anchor.spend(Some(datum), redeemer, own_ref, self)
}

test anchor_certificate_fails_with_unauthorized_relayer() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    ZkAnchorDatum {
      ..datum,
      cert_type: GraduationCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      anchor_timestamp: 2000,
      metadata_hash: #"ff",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // signed by neither the relayer nor governor
      extra_signatories: [#"99"],
    }
  let redeemer =
    AnchorCertificate {
      cert_type: GraduationCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      metadata_hash: #"ff",
      timestamp: 2000,
    }

  !zk_anchor.spend(Some(datum), redeemer, own_ref, self)
}

/// State authentication (2026-08-03 audit): an anchor UTXO that does not
/// carry the launch's thread NFT cannot be spent, however well-formed its
/// datum. Identical to add_relayer_succeeds_with_governor_signature below
/// except for the missing token. This matters more here than elsewhere: the
/// certificate is a public trust artifact, so a UTXO anyone could author at
/// this address is one anyone could present as a genuine certificate.
test anchor_spend_rejects_utxo_without_thread_nft() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = ZkAnchorDatum { ..datum, relayer_credential_hash: #"55" }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  !zk_anchor.spend(
    Some(datum),
    AddRelayer { relayer_credential_hash: #"55" },
    own_ref,
    self,
  )
}

test add_relayer_succeeds_with_governor_signature() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = ZkAnchorDatum { ..datum, relayer_credential_hash: #"55" }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  zk_anchor.spend(
    Some(datum),
    AddRelayer { relayer_credential_hash: #"55" },
    own_ref,
    self,
  )
}

test update_ipfs_cid_succeeds_via_relayer() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = ZkAnchorDatum { ..datum, proof_ipfs_cid: #"77" }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
    }

  zk_anchor.spend(
    Some(datum),
    UpdateIpfsCid { new_ipfs_cid: #"77" },
    own_ref,
    self,
  )
}

test update_ipfs_cid_fails_via_stranger() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = ZkAnchorDatum { ..datum, proof_ipfs_cid: #"77" }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"99"],
    }

  !zk_anchor.spend(
    Some(datum),
    UpdateIpfsCid { new_ipfs_cid: #"77" },
    own_ref,
    self,
  )
}

// Fix (2026-07-19, Cardano Launch cross-chain audit): QueryCertificate previously
// authorized ANY spend unconditionally (`-> True`, zero checks) — the same
// bug fixed in every other validator, missed here since this file
// wasn't in that sweep. Proves the fix — a transaction spending this UTXO
// with redeemer=QueryCertificate, discarding the real datum entirely and
// draining real lovelace to an attacker, must now be rejected.
test query_certificate_rejects_unauthenticated_drain_attempt() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_anchor_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(2_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !zk_anchor.spend(Some(datum), QueryCertificate, own_ref, self)
}

// Two different launches' anchor UTXOs (same shared address, since
// this validator has zero constructor parameters) spent in one transaction
// must not let both script executions resolve to the same "first matching"
// continuing output.
test single_own_utxo_rejects_two_anchor_inputs_same_tx() {
  let datum_a = mock_datum()
  let datum_b = ZkAnchorDatum { ..mock_datum(), launch_id: #"02" }
  let own_address = from_verification_key(#"cc")
  let own_ref_a = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_ref_b = OutputReference { transaction_id: #"00", output_index: 1 }
  let input_a =
    Input {
      output_reference: own_ref_a,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum_a),
        reference_script: None,
      },
    }
  let input_b =
    Input {
      output_reference: own_ref_b,
      output: Output {
        address: own_address,
        value: mock_anchor_nft(),
        datum: InlineDatum(datum_b),
        reference_script: None,
      },
    }
  let new_datum_a =
    ZkAnchorDatum {
      ..datum_a,
      cert_type: GraduationCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      anchor_timestamp: 2000,
      metadata_hash: #"ff",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_anchor_nft(),
      datum: InlineDatum(new_datum_a),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [input_a, input_b],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
    }
  let redeemer =
    AnchorCertificate {
      cert_type: GraduationCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      metadata_hash: #"ff",
      timestamp: 2000,
    }

  !zk_anchor.spend(Some(datum_a), redeemer, own_ref_a, self)
}

// An authorized relayer's AnchorCertificate call must not be usable
// to also skim real lovelace out of the anchor UTXO — the datum-equality
// check alone (pre-fix) never verified the continuing output's real value.
test anchor_certificate_rejects_value_drain_attempt() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_anchor_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    ZkAnchorDatum {
      ..datum,
      cert_type: GraduationCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      anchor_timestamp: 2000,
      metadata_hash: #"ff",
    }
  let continuing_output =
    Output {
      address: own_address,
      // Correct datum, but only min-UTxO lovelace left — the difference
      // would go to the relayer's own change output.
      value: assets.merge(mock_anchor_nft(), assets.from_lovelace(1_000_000)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
    }
  let redeemer =
    AnchorCertificate {
      cert_type: GraduationCert,
      proof_bundle_hash: #"dd",
      proof_ipfs_cid: #"ee",
      metadata_hash: #"ff",
      timestamp: 2000,
    }

  !zk_anchor.spend(Some(datum), redeemer, own_ref, self)
}
