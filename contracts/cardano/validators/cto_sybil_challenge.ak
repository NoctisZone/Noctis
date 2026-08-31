// ============================================================================
// Noctis Zone — Cardano L1 CTO Vote Sybil Challenge Contract (Aiken)
// every launch type (CLAUDE.md's CTO Governance runs on Midnight for all
// three tiers — see cto_governance.compact/cto_governance.ak)
// ============================================================================
// Item #16 of the CTO Governance milestone — the "secondary bonded
// challenge" half of the sybil/linked-wallet defense decided alongside
// the break-glass work (see CTO_GOVERNANCE_MILESTONE.md's "Decisions
// locked in" section). Direct structural adaptation of nhop_challenge.ak —
// same bonded-report / governor-adjudicated / defense-window / Upheld-
// Rejected-split shape, applied to a different accusation.
//
// WHAT THIS DEFENDS AGAINST: cto_governance.compact's castVote caps the
// CREATOR's own vote weight (creatorVoteCap) by comparing the voter's
// derived identity against ONE pinned creatorKey. If the creator controls
// multiple Midnight identities/wallets, only one of which is registered as
// creatorKey, they could vote through the OTHERS uncapped — evading the
// cap entirely. The PRIMARY defense is an automatic off-chain filter at
// balance-snapshot build time (excluding any wallet whose stake key
// matches the creator's or shows direct ADA flow from the creator, reusing
// checkStakeKeyMatch/checkNoDirectAdaFlow from eligibility-checker.ts —
// see integration/cto-badge.ts's sibling work). This contract is the
// SECONDARY layer: a bonded, community-submitted, governor-adjudicated
// report for a link the automatic filter missed (e.g. a more indirect
// N-hop transaction relationship, mirroring nhop_challenge.ak's own
// "within N hops" concept, but applied to voting identity rather than
// DarkVeil registration).
//
// WHY THIS DOES NOT (AND MUST NOT) REVERSE A VOTE OUTCOME: cto_governance.
// ak's own file header is explicit — "Once anchored, results are
// immutable — no reversal possible." A mechanism that could retroactively
// invalidate a challenged voter's weight AFTER finalizeProposal/
// executeProposal has run (and possibly already been relayed and acted
// upon via TriggerCTO/DissolveCTO/ClaimCommunityAllocation) would directly
// contradict that guarantee, and Compact's own cross-contract-call
// limitation means there is no live mechanism connecting a
// Cardano-side challenge resolution back into Midnight's castVote/
// finalizeProposal state anyway. Same reframing nhop_challenge.ak's own
// header already uses for the identical tradeoff: "post-fact detection,
// not real-time prevention" — this is a deterrent (bonded accountability +
// bounty) and a public record (useful for community trust, future
// governor decisions, or informing whether to challenge a LATER vote), not
// a vote-outcome-correction mechanism.
//
// Why this lives on Cardano, not Midnight: same reasoning as
// nhop_challenge.ak — the reporter bond is ADA-denominated (reusing
// NHOP_CHALLENGE_BOND, 25 ADA, for consistency — CLAUDE.md has no separate
// named constant for this specific mechanism, flagged for confirmation
// same as nhop_challenge.ak flagged its own undecided 60/40 split ratio),
// and ADA isn't representable as a Midnight-native token.
//
// challenged_voter_key/challenged_proposal_id are raw Midnight values
// (derived public key, proposal ID) being REFERENCED from a Cardano
// contract, not Cardano credentials — stored as plain ByteArray, not
// VerificationKeyHash, since they were never derived via Cardano's own key
// scheme.
//
// What's NOT verified on-chain (by design, same reasoning as
// nhop_challenge.ak): whether the accusation (stake-key link, tx-graph
// evidence, or whatever off-chain proof the challenger relied on) is real
// — governor-adjudicated off-chain, same trust boundary as every other
// governor-attested fact in this codebase (hasClaimableBalance,
// lastCreatorActivity). evidence_hash is an audit-trail commitment
// only, not independently checked here.
//
// What IS verified on-chain: governor-only resolution, no double-
// resolution (a resolved challenge's UTXO is fully spent), the defense
// window has genuinely elapsed (real chain time via validity_range), and
// the payout itself.
//
// Compiler: Aiken v1.1.23, Plutus v3 (matches every other validator in
// this directory).
// ============================================================================

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Script, from_script, from_verification_key,
  with_delegation_key}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use noctis/settlement

/// The declared validity range's own width, bounded. See any curve validator
/// for the full reasoning: `interval.contains` alone lets a caller widen the
/// range and pick a timestamp far from the real time.
fn validity_range_is_narrow(range: Interval, max_width: Int) -> Bool {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      hi >= lo && hi - lo <= max_width
    _ -> False
  }
}

const max_validity_range_width = 600_000

// ============================================================================
// TYPES
// ============================================================================

pub type CtoSybilChallengeDatum {
  launch_id: ByteArray,
  governor_pub_key_hash: VerificationKeyHash,
  /// The Midnight-derived voter public key being accused of secretly being
  /// the creator (evading creatorVoteCap) — a raw Midnight identity value,
  /// not a Cardano VerificationKeyHash.
  challenged_voter_key: ByteArray,
  /// The specific Midnight proposal ID this vote was cast on — ties the
  /// accusation to one concrete ballot, not a general claim about the
  /// wallet in the abstract.
  challenged_proposal_id: ByteArray,
  challenger_key_hash: VerificationKeyHash,
  /// Must equal the real lovelace locked in this UTXO — enforced
  /// implicitly by Cardano's balance-conservation rules at resolution,
  /// same as nhop_challenge.ak.
  bond_amount: Int,
  /// Posix MILLISECONDS the challenge was submitted — the defence window
  /// counts from here, and `defence_ms` beside it is milliseconds too. This
  /// comment said "seconds" while the arithmetic said otherwise; the same
  /// mismatch was found and corrected on nhop_challenge.ak.
  submitted_at: Int,
  /// Audit-trail commitment to the off-chain evidence (e.g. a hash of the
  /// challenger's claimed stake-key-match or tx-graph proof). Not
  /// independently verified on-chain — see file header.
  evidence_hash: ByteArray,
  treasury_pub_key_hash: VerificationKeyHash,
  ops_pub_key_hash: VerificationKeyHash,
}

pub type CtoSybilChallengeRedeemer {
  /// Governor-only. `current_timestamp` is verified against the tx's real
  /// validity range (Cardano scripts can't read wall-clock time directly),
  /// same idiom as every other timestamp check in this codebase.
  ResolveChallenge { upheld: Bool, current_timestamp: Int }
}

/// What the `mint` handler below is asked to do.
///
/// See nhop_challenge.ak's own copy for the full reasoning. In short: opening
/// a challenge is a payment to a script address and runs no validator, so the
/// submission time was whatever the challenger wrote, while the defence window
/// counts from it. Minting IS validated, and a validator's `mint` and `spend`
/// handlers compile to one script, so requiring a token minted here costs no
/// second script and no second address.
pub type CtoSybilMintRedeemer {
  /// Open a challenge, at a time the chain agrees with.
  OpenChallenge { current_timestamp: Int }
  /// Close one. `spend` runs alongside and decides whether it may end at all.
  CloseChallenge
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// 24 hours in MILLISECONDS — same NHOP_DEFENCE_HRS-equivalent window as
/// nhop_challenge.ak's own `nhop_defence_ms`, reused for consistency (this
/// mechanism's purpose — give the accused/governor time to investigate before
/// payout — is identical, independent of the ballot's own separate 72h
/// duration).
///
/// Milliseconds, and named for it: `current_timestamp` here is bound through
/// `interval.contains(self.validity_range, ...)`, so it arrives on Cardano's
/// own ms scale. Expressed in seconds this window lasted 86 of them.
const defence_ms = 86_400_000

/// Forfeited-bond split on a Rejected challenge — same 60/40 treasury/ops
/// ratio as nhop_challenge.ak, chosen for consistency, not because
/// CLAUDE.md specifies a ratio for this mechanism specifically.
const treasury_bps = 60

const ops_bps = 40

const bps_denominator = 100

// ============================================================================
// HELPERS
// ============================================================================

/// Verify some output pays at least `amount` lovelace to `key_hash`'s
/// wallet address — same pattern as nhop_challenge.ak's `paid_to`.
fn paid_to(
  self: Transaction,
  own_ref: OutputReference,
  key_hash: VerificationKeyHash,
  amount: Int,
) -> Bool {
  let cred = from_verification_key(key_hash).payment_credential
  list.any(
    self.outputs,
    fn(output: Output) {
      // The payout has to NAME the challenge it settles, by carrying that
      // challenge's own OutputReference as its datum.
      //
      // Without it this is an existential check over the whole transaction:
      // "somebody pays this wallet at least this much". Two settlements owing
      // the same wallet the same amount are then both satisfied by ONE output,
      // and they need not even be from the same contract, so no per-contract
      // restriction can see it. Scoping by address and amount cannot fix that,
      // because those are precisely what the two settlements have in common.
      //
      // An OutputReference is unique across the whole chain by construction,
      // so two settlements can never ask for the same tag, and one output can
      // never answer both.
      and {
        // The payment credential, not the whole address.
        // `from_verification_key` builds a bare ENTERPRISE address, while an
        // ordinary wallet hands out BASE addresses — payment credential plus a
        // staking part — so matching the whole address asks for a destination
        // almost nobody uses, and the bond could not be returned to one. Same
        // fix already applied to the curve, staking and escrow payouts.
        output.address.payment_credential == cred,
        assets.lovelace_of(output.value) >= amount,
        settlement.settles(output, own_ref),
      }
    },
  )
}

/// Fix (2026-07-20, Aiken security-review pass) — same finding,
/// same fix, as nhop_challenge.ak's own `single_own_utxo` (this contract
/// is a direct structural adaptation of that file — see this file's own
/// header). Zero constructor parameters means every CTO sybil challenge
/// across every launch shares one fixed script address; `paid_to`'s
/// existential check lets a single combined output satisfy two batched
/// challenges' payout checks at once, most concretely via the shared
/// real treasury/ops addresses on a Rejected/Rejected batch.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  // Compared by PAYMENT credential, never by the full Address — the staking
  // part is chosen freely by whoever builds the output, so two UTXOs at this
  // same script can differ there while being equally "ours".
  let own_payment = own_address.payment_credential
  list.length(
    list.filter(
      self.inputs,
      fn(input) { input.output.address.payment_credential == own_payment },
    ),
  ) <= 1
}

// ============================================================================
// VALIDATOR
// ============================================================================

/// One name for every challenge — what makes one unique is the UTXO it lives
/// in, which `spend` already binds a resolution to.
const challenge_asset_name: ByteArray = "sybil"

validator cto_sybil_challenge {
  /// Authenticates the submission time, which creation cannot otherwise check.
  ///
  /// Same mechanism as nhop_challenge.ak's `mint`, written out here rather
  /// than shared: the two contracts carry different datums, and they have
  /// diverged before.
  mint(redeemer: CtoSybilMintRedeemer, policy_id: PolicyId, self: Transaction) {
    let minted = assets.tokens(self.mint, policy_id) |> dict.to_pairs()
    when redeemer is {
      OpenChallenge { current_timestamp } -> {
        expect [Pair(name, quantity)] = minted
        let own_address = from_script(policy_id)
        expect [challenge_output] =
          list.filter(self.outputs, fn(output) { output.address == own_address })
        expect InlineDatum(raw_datum) = challenge_output.datum
        expect challenge: CtoSybilChallengeDatum = raw_datum
        and {
          name == challenge_asset_name,
          quantity == 1,
          assets.quantity_of(challenge_output.value, policy_id, name) == 1,
          challenge.submitted_at == current_timestamp,
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          assets.lovelace_of(challenge_output.value) == challenge.bond_amount,
          challenge.bond_amount > 0,
        }
      }
      CloseChallenge -> {
        expect [Pair(name, quantity)] = minted
        and {
          name == challenge_asset_name,
          quantity == -1,
        }
      }
    }
  }

  spend(
    datum_opt: Option<CtoSybilChallengeDatum>,
    redeemer: CtoSybilChallengeRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    let ResolveChallenge { upheld, current_timestamp } = redeemer
    // This script's own hash, which is also the policy id of the token a real
    // challenge carries — `mint` and `spend` are handlers of one script.
    expect Script(own_policy) = own_input.output.address.payment_credential
    let base_checks =
      and {
        list.has(self.extra_signatories, datum.governor_pub_key_hash),
        interval.contains(self.validity_range, current_timestamp),
        // Without these two the mint handler decides nothing: anyone could pay
        // this address directly and write whatever submission time suited
        // them. Holding the token is what makes the datum one the chain agreed
        // to, and burning it stops that token reaching a later forgery.
        assets.quantity_of(own_input.output.value, own_policy, challenge_asset_name) == 1,
        assets.quantity_of(self.mint, own_policy, challenge_asset_name) == -1,
        validity_range_is_narrow(self.validity_range, max_validity_range_width),
        current_timestamp >= datum.submitted_at + defence_ms,
        single_own_utxo(self, own_input.output.address),
        // Fix: same real-value-conservation gap as
        // nhop_challenge.ak — the file's own header claimed this was
        // "enforced implicitly by Cardano's balance-conservation rules,"
        // which was false; nothing tied datum.bond_amount to the real
        // locked value. Now actually enforced.
        assets.lovelace_of(own_input.output.value) == datum.bond_amount,
      }
    if upheld {
      and {
        base_checks,
        paid_to(self, own_ref, datum.challenger_key_hash, datum.bond_amount),
      }
    } else {
      let treasury_share = datum.bond_amount * treasury_bps / bps_denominator
      let ops_share = datum.bond_amount - treasury_share
      and {
        base_checks,
        paid_to(self, own_ref, datum.treasury_pub_key_hash, treasury_share),
        paid_to(self, own_ref, datum.ops_pub_key_hash, ops_share),
      }
    }
  }

  else(_) {
    fail
  }
}

// ============================================================================
// TESTS
// ============================================================================

fn mock_datum() -> CtoSybilChallengeDatum {
  CtoSybilChallengeDatum {
    launch_id: #"aa",
    governor_pub_key_hash: #"dd",
    challenged_voter_key: #"ee",
    challenged_proposal_id: #"12",
    challenger_key_hash: #"ff",
    bond_amount: 25_000_000,
    submitted_at: 1_000_000,
    evidence_hash: #"11",
    treasury_pub_key_hash: #"22",
    ops_pub_key_hash: #"33",
  }
}

/// This validator's own hash, in the fixtures — the script a challenge lives
/// at AND the policy its token is minted under, which one validator with both
/// handlers makes the same 28 bytes.
const mock_script_hash: ByteArray = #"cc"

fn mock_challenge_token() -> assets.Value {
  assets.from_asset(mock_script_hash, challenge_asset_name, 1)
}

fn mock_challenge_burn() -> assets.Value {
  assets.from_asset(mock_script_hash, challenge_asset_name, -1)
}

fn mock_input(datum: CtoSybilChallengeDatum) -> (OutputReference, transaction.Input) {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_input =
    transaction.Input {
      output_reference: own_ref,
      output: Output {
        address: from_script(mock_script_hash),
        value: assets.merge(assets.from_lovelace(25_000_000), mock_challenge_token()),
        datum: transaction.InlineDatum(datum),
        reference_script: None,
      },
    }
  (own_ref, own_input)
}

test resolve_upheld_succeeds_after_defence_window() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejected_splits_bond_treasury_ops() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + defence_ms
  let treasury_payout =
    Output {
      address: from_verification_key(datum.treasury_pub_key_hash),
      value: assets.from_lovelace(15_000_000),
      // 60% of 25 ADA
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let ops_payout =
    Output {
      address: from_verification_key(datum.ops_pub_key_hash),
      value: assets.from_lovelace(10_000_000),
      // remaining 40%
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [treasury_payout, ops_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: False, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejects_without_governor_signature() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      // No extra_signatories at all — impostor attempt.
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejects_before_defence_window_elapses() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let too_early = datum.submitted_at + defence_ms - 1
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(too_early - 10, too_early + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: too_early },
    own_ref,
    self,
  )
}

test resolve_upheld_rejects_underpaid_challenger() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + defence_ms
  let short_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount - 1),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [short_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejected_rejects_missing_ops_share() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + defence_ms
  let treasury_payout =
    Output {
      address: from_verification_key(datum.treasury_pub_key_hash),
      value: assets.from_lovelace(15_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      // Missing the ops payout entirely.
      outputs: [treasury_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: False, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

// Fix (2026-07-20): two challenges resolved in one transaction,
// both Rejected, sharing the same treasury/ops addresses — a single
// combined output must not be able to satisfy both challenges' payout
// checks simultaneously.
test resolve_rejects_when_batched_with_a_second_challenge_input() {
  let datum_a = mock_datum()
  let datum_b = CtoSybilChallengeDatum { ..mock_datum(), launch_id: #"bb" }
  let own_address = from_script(mock_script_hash)
  let own_ref_a = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_ref_b = OutputReference { transaction_id: #"00", output_index: 1 }
  let input_a =
    transaction.Input {
      output_reference: own_ref_a,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(25_000_000), mock_challenge_token()),
        datum: transaction.InlineDatum(datum_a),
        reference_script: None,
      },
    }
  let input_b =
    transaction.Input {
      output_reference: own_ref_b,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(25_000_000), mock_challenge_token()),
        datum: transaction.InlineDatum(datum_b),
        reference_script: None,
      },
    }
  let resolve_time = datum_a.submitted_at + defence_ms
  let treasury_payout =
    Output {
      address: from_verification_key(datum_a.treasury_pub_key_hash),
      value: assets.from_lovelace(15_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let ops_payout =
    Output {
      address: from_verification_key(datum_a.ops_pub_key_hash),
      value: assets.from_lovelace(10_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [input_a, input_b],
      outputs: [treasury_payout, ops_payout],
      extra_signatories: [datum_a.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum_a),
    ResolveChallenge { upheld: False, current_timestamp: resolve_time },
    own_ref_a,
    self,
  )
}

// Fix (2026-07-20): an overfunded challenge deposit must not let
// the excess go anywhere unaccounted.
test resolve_rejects_when_real_value_exceeds_claimed_bond_amount() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_input =
    transaction.Input {
      output_reference: own_ref,
      output: Output {
        address: from_script(mock_script_hash),
        value: assets.merge(assets.from_lovelace(30_000_000), mock_challenge_token()),
        datum: transaction.InlineDatum(datum),
        reference_script: None,
      },
    }
  let resolve_time = datum.submitted_at + defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

// One hour, as a literal. The defence window is twenty-four of them, so this
// must be refused. Deliberately not written as `defence_ms - something`: a
// boundary expressed in terms of the constant scales with it and would still
// pass if the window were only seconds long.
test resolve_rejects_one_hour_after_submission() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + 3_600_000
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

/// The challenger's bond, returned to the kind of address a wallet issues.
///
/// `from_verification_key` builds an ENTERPRISE address; real wallets hand out
/// BASE ones. Matching the whole address asked for a destination almost nobody
/// has, so a challenger proved RIGHT could not be paid back. Identical to the
/// passing resolve above except the challenger delegates their stake.
test resolve_upheld_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash)
        |> with_delegation_key(#"aa"),
      value: assets.from_lovelace(datum.bond_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}


// ----------------------------------------------------------------------------
// Opening a challenge — the mint handler
// ----------------------------------------------------------------------------

fn mock_open_output(datum: CtoSybilChallengeDatum) -> Output {
  Output {
    address: from_script(mock_script_hash),
    value: assets.merge(
      assets.from_lovelace(datum.bond_amount),
      mock_challenge_token(),
    ),
    datum: transaction.InlineDatum(datum),
    reference_script: None,
  }
}

fn mock_open_tx(
  datum: CtoSybilChallengeDatum,
  at: Int,
  half_width: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    outputs: [mock_open_output(datum)],
    mint: mock_challenge_token(),
    validity_range: interval.between(at - half_width, at + half_width),
  }
}

test open_challenge_succeeds_when_the_chain_agrees_with_the_claimed_time() {
  let datum = mock_datum()
  let self = mock_open_tx(datum, datum.submitted_at, 10)
  cto_sybil_challenge.mint(
    OpenChallenge { current_timestamp: datum.submitted_at },
    mock_script_hash,
    self,
  )
}

/// The reason this handler exists. A challenge opened with its submission
/// time already a day in the past arrives with the accused voter's whole
/// defence window spent.
test open_challenge_rejects_a_backdated_submission() {
  let real_now = 100_000_000
  let datum =
    CtoSybilChallengeDatum { ..mock_datum(), submitted_at: real_now - defence_ms }
  let self = mock_open_tx(datum, real_now, 10)
  !cto_sybil_challenge.mint(
    OpenChallenge { current_timestamp: real_now },
    mock_script_hash,
    self,
  )
}

/// A range wide enough to contain any convenient answer contains none.
test open_challenge_rejects_a_wide_validity_range() {
  let datum = mock_datum()
  let self = mock_open_tx(datum, datum.submitted_at, max_validity_range_width)
  !cto_sybil_challenge.mint(
    OpenChallenge { current_timestamp: datum.submitted_at },
    mock_script_hash,
    self,
  )
}

/// The bond has to be real when the clock starts, not merely claimed.
test open_challenge_rejects_a_bond_smaller_than_the_datum_claims() {
  let datum = mock_datum()
  let self =
    Transaction {
      ..mock_open_tx(datum, datum.submitted_at, 10),
      outputs: [
        Output {
          address: from_script(mock_script_hash),
          value: assets.merge(
            assets.from_lovelace(1_000_000),
            mock_challenge_token(),
          ),
          datum: transaction.InlineDatum(datum),
          reference_script: None,
        },
      ],
    }
  !cto_sybil_challenge.mint(
    OpenChallenge { current_timestamp: datum.submitted_at },
    mock_script_hash,
    self,
  )
}

/// Without this the mint handler decides nothing: anyone could pay the
/// address directly and never mint at all. A burn IS declared here, so the
/// burn check is satisfied and only the token-presence check can reject —
/// otherwise this test would be answered by the wrong guard and prove
/// nothing about the bypass it names.
test resolve_rejects_a_challenge_that_was_never_minted() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_input =
    transaction.Input {
      output_reference: own_ref,
      output: Output {
        address: from_script(mock_script_hash),
        value: assets.from_lovelace(25_000_000),
        datum: transaction.InlineDatum(datum),
        reference_script: None,
      },
    }
  let resolve_time = datum.submitted_at + defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

/// A resolved challenge must not leave its token behind for a forgery.
test resolve_rejects_leaving_the_token_unburned() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !cto_sybil_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}
