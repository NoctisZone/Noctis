// ============================================================================
// Noctis Zone — Cardano L1 N-Hop Challenge Contract (Aiken)
// Cardano Launch only (CLAUDE.md, 2026-07-12)
// ============================================================================
// Implements CLAUDE.md's N-Hop Challenge Window (constants NHOP_CHALLENGE_BOND,
// NHOP_MAX_HOPS, NHOP_LOOKBACK_DAYS, NHOP_WINDOW_HRS, NHOP_DEFENCE_HRS).
// No fuller spec than those 5 constants + one sentence exists anywhere in
// this repo or HISTORY_ARCHIVE.md — the mechanism below was designed this
// session from that alone, with Jinx confirming each real design fork.
//
// Purpose: lets anyone challenge a Cardano Launch DarkVeil claimant as a Sybil —
// specifically, a wallet within NHOP_MAX_HOPS (5) Cardano transaction hops
// of the creator's own wallet within a NHOP_LOOKBACK_DAYS (180) window,
// evidence of the "slot dilution" griefing vector described elsewhere (the
// creator's own associates registering as ghost DarkVeil participants to
// shrink `base_slot` for legitimate buyers).
//
// Why this is Cardano Launch only: Midnight Launch is already fully build-blocked,
// independent of this feature. Cardano Launch already has a full
// Cardano contract suite (bonding_curve_tier_b.ak) to sit alongside.
//
// Why this lives on Cardano, not Midnight: the reporter bond
// (NHOP_CHALLENGE_BOND, 25 ADA) is ADA-denominated, and DarkVeil
// registration itself lives on Midnight — same cross-chain mismatch
// already solved by moving Cardano Launch's public curve to Cardano entirely.
// ADA isn't representable as a Midnight-native token; this validator
// avoids that problem by existing on the same chain the bond is paid in.
//
// Why this triggers on CLAIM, not REGISTRATION (contradicts the constant's
// literal name, NHOP_WINDOW_HRS = "Challenge submission window after
// registration"): a registrant's real Cardano wallet is never publicly
// linked to their DarkVeil participation until they call
// `ClaimDarkVeilTokens` on `bonding_curve_tier_b.ak` — before that,
// not even the governor can prove on-chain which real wallet a given
// Midnight registration identity belongs to. Triggering the window at
// registration (as literally named) would require deanonymizing every
// registrant just to make them challengeable, defeating DarkVeil's whole
// privacy design. Jinx confirmed (2026-07-12): reinterpret the window as
// "72h after the wallet's real address becomes public via claim," not
// literally after registration. A registrant who never claims was never
// exposed, and is correctly never challengeable — consistent with
// internal tracking's existing description of this mechanism as "post-fact detection,"
// not real-time prevention (the claimed tokens can't be clawed back once
// delivered — this mechanism is about accountability + a bounty, not
// stopping the dilution before it happens).
//
// Why no reference input to bonding_curve_tier_b.ak's own UTXO: an earlier
// draft of this design tried to cross-verify the challenged wallet's real
// claim timestamp on-chain via a reference input to the curve's datum.
// Dropped: the governor already has to adjudicate the actual N-hop
// evidence off-chain (this validator has no way to independently verify a
// Cardano transaction graph inside a script either — same category of
// off-chain-attested fact as `hasClaimableBalance` or
// `lastCreatorActivity`), so requiring the SAME governor to also honestly
// judge "was this submitted within the real window" off-chain adds no new
// trust assumption, and keeps this validator's on-chain surface narrow:
// hold the bond, enforce the defense-window minimum wait, pay out
// correctly based on the governor's Upheld/Rejected call.
//
// What's NOT verified on-chain (by design, same reasoning as above):
//   - Whether the N-hop path evidence is real (governor-adjudicated
//     off-chain against real Blockfrost data before resolving)
//   - Whether the challenge was submitted within the real post-claim
//     window (same off-chain judgment)
//   - `evidence_hash` is an audit-trail commitment only (hash of the
//     off-chain tx-hash-sequence evidence the challenger is relying on),
//     not independently checked here
//
// What IS verified on-chain: governor-only resolution, no double-
// resolution (a resolved challenge's UTXO is fully spent — there is no
// continuing datum, so "already resolved" isn't a state to check, it's
// simply gone), the 24h defense window has genuinely elapsed (real chain
// time via validity_range, not a caller-supplied claim), and the payout
// itself: Upheld returns the challenger's bond in full; Rejected forfeits
// it, split 60/40 treasury/ops (same ratio as the forfeited-NIGHT-bond
// split, for consistency, not because CLAUDE.md specifies it for this
// mechanism — genuinely undecided beyond "some split," flagged here).
//
// Submission has no validator logic at all — depositing ADA + a datum at
// this script address needs no signature or check (Cardano doesn't gate
// deposits to a script, only spends from one). A malformed/underfunded
// challenge (e.g. a datum claiming a bond bigger than what's actually
// locked) simply can't resolve Upheld — Cardano's own balance-conservation
// rules block a payout exceeding what the input actually holds, so no
// extra on-chain check is needed to guard against it.
//
// Compiler: Aiken v1.1.23, Plutus v3 (matches every other validator in
// this directory).
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/collection/dict
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Script, from_script, from_verification_key,
  with_delegation_key}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use noctis/settlement

/// The declared validity range's own width, bounded — see any curve
/// validator's own copy of this for the full reasoning: `interval.contains`
/// alone lets a caller widen the range and pick a timestamp far from the
/// real time, so the range has to be narrow for containment to mean much.
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

pub type NHopChallengeDatum {
  launch_id: ByteArray,
  governor_pub_key_hash: VerificationKeyHash,
  // The wallet being accused of being within NHOP_MAX_HOPS of the
  // creator — only meaningful post-claim, see file header.
  challenged_wallet: VerificationKeyHash,
  challenger_key_hash: VerificationKeyHash,
  // Must equal the real lovelace locked in this UTXO — enforced
  // implicitly by Cardano's balance-conservation rules at resolution,
  // not re-checked explicitly here (see file header).
  bond_amount: Int,
  // Posix MILLISECONDS the challenge was submitted — the defense window
  // (NHOP_DEFENCE_HRS) counts from here. Milliseconds, not seconds — matches
  // every other timestamp in this codebase (`interval.contains` against a
  // real tx validity range requires ms on-chain, confirmed elsewhere) and this
  // file's own `current_timestamp` redeemer field, which it's compared
  // against directly. This field's doc comment previously said "Posix
  // seconds" while `nhop_defence_seconds` (now `nhop_defence_ms`) was named
  // and valued as seconds too — a real, unfixed instance of the same
  // ms-vs-seconds bug class found and fixed elsewhere, caught here
  // 2026-07-22 before any off-chain submitter existed to populate this field
  // with the wrong unit (this file had already been flagged as an open
  // instance of the same bug, unfixed at the time since no submitter
  // existed yet to verify the real convention against). Left unfixed, a
  // real ms-scale `current_timestamp` would always vastly exceed a
  // seconds-scale `submitted_at + nhop_defence_seconds` threshold, making
  // the 24-hour defense window resolvable immediately upon submission.
  submitted_at: Int,
  // Audit-trail commitment to the off-chain hop-path evidence (a hash of
  // the challenger's claimed tx-hash sequence). Not independently
  // verified on-chain — see file header.
  evidence_hash: ByteArray,
  /// Where a forfeited bond goes. ONE address, not the retired
  /// treasury/ops pair: the 60/40 ratio this used to apply borrowed its
  /// justification from a revenue split that no longer exists, so it was
  /// dividing a penalty by a rule nothing else on the platform follows —
  /// and it left two addresses to provision, hold keys for and disclose for
  /// money that arrives only when a challenge is rejected.
  ///
  /// WHICH address stays a deployment choice. A forfeited bond is arguably
  /// not platform revenue, and pointing this at a dedicated address instead
  /// of the platform wallet is a matter of what the datum is written with,
  /// not a contract change.
  payout_pub_key_hash: VerificationKeyHash,
}

pub type NHopChallengeRedeemer {
  /// Governor-only. `current_timestamp` is verified against the tx's real
  /// validity range (Cardano scripts can't read wall-clock time directly),
  /// same idiom as every other timestamp check in this codebase.
  ResolveChallenge { upheld: Bool, current_timestamp: Int }
}

/// What the `mint` handler below is asked to do.
///
/// Opening a challenge is a payment to a script address, and paying a script
/// address runs no validator — so nothing about the datum written there is
/// checked at the moment it is written. `submitted_at` is the field that
/// matters: the whole defence window counts from it, so a challenge opened
/// with it set in the past would arrive with that window already spent.
///
/// Minting IS validated. Requiring a challenge to carry a token minted by
/// this same script therefore moves the one field that needs authenticating
/// into a transaction that can be checked, without a second script or a
/// second address: an Aiken validator's `mint` and `spend` handlers compile
/// to one script, so the policy id here IS this validator's own hash.
pub type NHopMintRedeemer {
  /// Open a challenge. `current_timestamp` is bound to the transaction's real
  /// validity range and must be exactly what the new datum records.
  OpenChallenge { current_timestamp: Int }
  /// Close one. `spend` runs in the same transaction and decides whether the
  /// challenge may end at all; this only accounts for the token.
  CloseChallenge
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// 24 hours in MILLISECONDS (NHOP_DEFENCE_HRS) — minimum wait after
/// submission before the governor can resolve, giving the registrant time
/// to reach the governor with a rebuttal off-chain. Fixed 2026-07-22 — was
/// `nhop_defence_seconds = 86_400` (seconds), the same ms-vs-seconds bug
/// class found in other files' timestamp constants; see
/// `submitted_at`'s doc comment above for the full explanation.
const nhop_defence_ms = 86_400_000

// ============================================================================
// HELPERS
// ============================================================================

/// Verify some output pays at least `amount` lovelace to `key_hash`'s
/// wallet address — same real-value-movement pattern used throughout this
/// codebase's fee/refund payouts (e.g. bonding_curve_tier_b.ak's
/// `buyback_share_paid`).
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

/// Fix (2026-07-20, Aiken security-review pass): this validator has
/// zero constructor parameters — every N-hop challenge across every Cardano Launch
/// launch shares ONE fixed script address, distinguished only by launch_id
/// in the datum (same structural precondition as the double-satisfaction
/// gap fixed across bonding_curve.ak/lp_escrow.ak/vesting.ak/
/// staking_pool.ak/zk_anchor.ak/cto_governance.ak). `paid_to`'s existential
/// check (`list.any`, not scoped to a specific input) means resolving TWO
/// challenges in one transaction lets a SINGLE combined output satisfy
/// BOTH challenges' payout checks simultaneously — most concretely via
/// `payout_pub_key_hash`, which is the same real platform address across
/// every challenge, so two `Rejected`
/// resolutions in one tx could real-pay only one challenge's forfeited
/// bond while both validators independently accept. Requires the governor
/// to construct (or be tricked into signing) a batching transaction — not
/// a third-party drain — but closed structurally rather than left as a
/// "the off-chain tx-builder must remember never to batch" footgun, same
/// discipline as every other double-satisfaction fix this session.
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

/// The asset name every challenge token carries.
///
/// One name for all of them: what makes a given challenge unique is the UTXO
/// it lives in, not the token, and the spend handler already binds a
/// resolution to one input. A per-challenge name would buy nothing and cost
/// a scheme to agree on.
const challenge_asset_name: ByteArray = "nhop"

validator nhop_challenge {
  /// Authenticates the one datum field that creation cannot otherwise check.
  ///
  /// A challenge exists only if this ran, because `spend` refuses an input
  /// that does not hold the token. So `submitted_at` is no longer whatever
  /// the challenger felt like writing — it is a time the chain agreed with,
  /// inside a range narrow enough that agreeing means something.
  mint(redeemer: NHopMintRedeemer, policy_id: PolicyId, self: Transaction) {
    let minted = assets.tokens(self.mint, policy_id) |> dict.to_pairs()
    when redeemer is {
      OpenChallenge { current_timestamp } -> {
        // Exactly one challenge token, and nothing else under this policy.
        expect [Pair(name, quantity)] = minted
        // The challenge it opens: the single output at this script's own
        // address, which is where a challenge has to live to be spendable.
        let own_address = from_script(policy_id)
        expect [challenge_output] =
          list.filter(self.outputs, fn(output) { output.address == own_address })
        expect InlineDatum(raw_datum) = challenge_output.datum
        expect challenge: NHopChallengeDatum = raw_datum
        and {
          name == challenge_asset_name,
          quantity == 1,
          // The token goes into the challenge it authenticates, rather than
          // to the minter to place wherever they like afterwards.
          assets.quantity_of(challenge_output.value, policy_id, name) == 1,
          // The claim the whole defence window rests on, agreed with the
          // chain rather than asserted by the challenger.
          challenge.submitted_at == current_timestamp,
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          // The bond is real at the moment the clock starts, not merely
          // claimed. `ResolveChallenge` checks this too, but by then the
          // window has already run on a figure nobody verified.
          assets.lovelace_of(challenge_output.value) == challenge.bond_amount,
          challenge.bond_amount > 0,
        }
      }
      CloseChallenge -> {
        expect [Pair(name, quantity)] = minted
        and {
          name == challenge_asset_name,
          // Burned, so a resolved challenge cannot leave a token behind for
          // a later forgery to carry.
          quantity == -1,
        }
      }
    }
  }

  spend(
    datum_opt: Option<NHopChallengeDatum>,
    redeemer: NHopChallengeRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    let ResolveChallenge { upheld, current_timestamp } = redeemer
    // This script's own hash, which is also the policy id of the token a
    // real challenge carries — `mint` and `spend` are two handlers of one
    // script, so the two are the same 28 bytes.
    expect Script(own_policy) = own_input.output.address.payment_credential
    let base_checks =
      and {
        list.has(self.extra_signatories, datum.governor_pub_key_hash),
        interval.contains(self.validity_range, current_timestamp),
        // Without this the mint handler decides nothing: anyone could pay
        // this address directly, skip minting entirely, and write whatever
        // submitted_at suited them. Holding the token is what makes the datum
        // one the chain agreed to.
        assets.quantity_of(own_input.output.value, own_policy, challenge_asset_name) == 1,
        // ...and it does not survive the resolution, so it cannot be moved
        // into a forged challenge afterwards.
        assets.quantity_of(self.mint, own_policy, challenge_asset_name) == -1,
        // The declared range has to be narrow, for the same reason every
        // other timestamp check in this codebase requires it: a wide one lets
        // the caller choose a `current_timestamp` far from the real time.
        validity_range_is_narrow(self.validity_range, max_validity_range_width),
        current_timestamp >= datum.submitted_at + nhop_defence_ms,
        single_own_utxo(self, own_input.output.address),
        // Fix: the file's own header claims bond_amount "must
        // equal the real lovelace locked in this UTXO — enforced
        // implicitly by Cardano's balance-conservation rules" — false as
        // originally written; nothing tied datum.bond_amount to the real
        // input value, so an overfunded deposit (submission has no
        // validator logic at all, by design) let the governor route any
        // excess to an unaccounted destination while both payout checks
        // below still passed. Now actually enforced.
        assets.lovelace_of(own_input.output.value) == datum.bond_amount,
      }
    if upheld {
      and {
        base_checks,
        paid_to(self, own_ref, datum.challenger_key_hash, datum.bond_amount),
      }
    } else {
      and {
        base_checks,
        paid_to(self, own_ref, datum.payout_pub_key_hash, datum.bond_amount),
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

fn mock_datum() -> NHopChallengeDatum {
  NHopChallengeDatum {
    launch_id: #"aa",
    governor_pub_key_hash: #"dd",
    challenged_wallet: #"ee",
    challenger_key_hash: #"ff",
    bond_amount: 25_000_000,
    submitted_at: 1_000_000,
    evidence_hash: #"11",
    payout_pub_key_hash: #"22",
  }
}

/// This validator's own hash, in the fixtures. `spend` reads the policy id
/// off its own input's address, so the same 28 bytes have to be the script
/// the challenge lives at AND the policy its token is minted under — which is
/// exactly the relationship a single validator with both handlers creates.
const mock_script_hash: ByteArray = #"cc"

/// What a real challenge carries. Without it `spend` refuses the input, which
/// is the whole point: a challenge that was never minted was never checked.
fn mock_challenge_token() -> assets.Value {
  assets.from_asset(mock_script_hash, challenge_asset_name, 1)
}

/// Resolving burns it, so it cannot be carried into a forged challenge later.
fn mock_challenge_burn() -> assets.Value {
  assets.from_asset(mock_script_hash, challenge_asset_name, -1)
}

fn mock_input(datum: NHopChallengeDatum) -> (OutputReference, transaction.Input) {
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
  let resolve_time = datum.submitted_at + nhop_defence_ms
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

  nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejected_splits_bond_treasury_ops() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  // The WHOLE bond, to the one address the datum names.
  let bond_payout =
    Output {
      address: from_verification_key(datum.payout_pub_key_hash),
      value: assets.from_lovelace(25_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [bond_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: False, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejects_without_governor_signature() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
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

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejects_before_defence_window_elapses() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let too_early = datum.submitted_at + nhop_defence_ms - 1
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

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: too_early },
    own_ref,
    self,
  )
}

test resolve_upheld_rejects_underpaid_challenger() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
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

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejected_rejects_a_short_payout() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  // 15 of the 25 ADA bond. Right payee, real payment, and the same
  // input-ref datum tag the accepted resolution carries — the amount is the
  // ONE delta from it.
  //
  // It was not always. This fixture used to pay 15 ADA with NO datum on the
  // output, and the missing tag rejected it on its own: the test passed
  // without the amount ever mattering, and would have gone on passing had
  // the payout check been removed outright. Verified the other way before
  // this comment was written — at 25 ADA the spend now really succeeds.
  let short_payout =
    Output {
      address: from_verification_key(datum.payout_pub_key_hash),
      value: assets.from_lovelace(15_000_000),
      datum: InlineDatum(own_ref),
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

  !nhop_challenge.spend(
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
  let datum_b = NHopChallengeDatum { ..mock_datum(), launch_id: #"bb" }
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
  let resolve_time = datum_a.submitted_at + nhop_defence_ms
  // Only ONE real payout, sized for a single challenge's forfeiture —
  // both challenges' own paid_to checks would independently accept it.
  // The WHOLE bond, to the one address the datum names.
  let bond_payout =
    Output {
      address: from_verification_key(datum_a.payout_pub_key_hash),
      value: assets.from_lovelace(25_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [input_a, input_b],
      outputs: [bond_payout],
      extra_signatories: [datum_a.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum_a),
    ResolveChallenge { upheld: False, current_timestamp: resolve_time },
    own_ref_a,
    self,
  )
}

// Fix (2026-07-20): an overfunded challenge deposit (real locked
// value exceeds the datum's claimed bond_amount) must not let the excess
// go anywhere unaccounted — the full real input value must match the
// claimed bond_amount.
test resolve_rejects_when_real_value_exceeds_claimed_bond_amount() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_input =
    transaction.Input {
      output_reference: own_ref,
      output: Output {
        address: from_script(mock_script_hash),
        // Real locked value (30 ADA) exceeds datum.bond_amount (25 ADA).
        value: assets.merge(assets.from_lovelace(30_000_000), mock_challenge_token()),
        datum: transaction.InlineDatum(datum),
        reference_script: None,
      },
    }
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      // Pays exactly the claimed bond_amount — the 5 ADA excess is
      // unaccounted for (could go anywhere, e.g. back to the governor).
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

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

// One output cannot settle two challenges. This payout is real, goes to the
// right wallet and carries the right amount — it simply names a different
// challenge, which is what a single output shared between two settlements
// looks like from inside either one of them. Address and amount are precisely
// what the two have in common, so only the tag can tell them apart.
test resolve_rejects_a_payout_settling_a_different_challenge() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: InlineDatum(
        OutputReference { transaction_id: #"99", output_index: 7 },
      ),
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

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

/// The challenger's bond, returned to the kind of address a wallet issues.
///
/// `from_verification_key` builds an ENTERPRISE address; real wallets hand out
/// BASE ones, carrying a staking part too. Matching the whole address asked
/// for a destination almost nobody has, which on this path meant a challenger
/// who was proved RIGHT could not be given their bond back. Identical to the
/// passing resolve above except that the challenger delegates their stake.
test resolve_upheld_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
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

  nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

// ----------------------------------------------------------------------------
// Opening a challenge — the mint handler
// ----------------------------------------------------------------------------

/// The output a mint has to produce: a real challenge, at this script's own
/// address, holding the token and the bond.
fn mock_open_output(datum: NHopChallengeDatum) -> Output {
  Output {
    address: from_script(mock_script_hash),
    value: assets.merge(assets.from_lovelace(datum.bond_amount), mock_challenge_token()),
    datum: transaction.InlineDatum(datum),
    reference_script: None,
  }
}

fn mock_open_tx(datum: NHopChallengeDatum, at: Int, half_width: Int) -> Transaction {
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
  nhop_challenge.mint(
    OpenChallenge { current_timestamp: datum.submitted_at },
    mock_script_hash,
    self,
  )
}

/// The whole reason this handler exists.
///
/// Paying a script address runs no validator, so before this the challenger
/// wrote `submitted_at` themselves and nothing compared it to anything. A
/// value in the past arrives with the registrant's defence window already
/// spent. Here the claimed time is a full day earlier than the transaction
/// the chain is actually validating.
test open_challenge_rejects_a_backdated_submission() {
  let real_now = 100_000_000
  let datum = NHopChallengeDatum { ..mock_datum(), submitted_at: real_now - nhop_defence_ms }
  let self = mock_open_tx(datum, real_now, 10)
  !nhop_challenge.mint(
    OpenChallenge { current_timestamp: real_now },
    mock_script_hash,
    self,
  )
}

/// The claimed time also cannot simply sit outside the range it is checked
/// against — the redeemer and the datum agree here, and the chain does not.
test open_challenge_rejects_a_timestamp_outside_the_validity_range() {
  let datum = mock_datum()
  let self =
    Transaction {
      ..mock_open_tx(datum, datum.submitted_at, 10),
      validity_range: interval.between(
        datum.submitted_at + 1_000,
        datum.submitted_at + 2_000,
      ),
    }
  !nhop_challenge.mint(
    OpenChallenge { current_timestamp: datum.submitted_at },
    mock_script_hash,
    self,
  )
}

/// A range wide enough to contain any convenient answer contains no
/// information — same bound every other timestamped action here carries.
test open_challenge_rejects_a_wide_validity_range() {
  let datum = mock_datum()
  let self = mock_open_tx(datum, datum.submitted_at, max_validity_range_width)
  !nhop_challenge.mint(
    OpenChallenge { current_timestamp: datum.submitted_at },
    mock_script_hash,
    self,
  )
}

/// The token has to land in the challenge, not in the minter's pocket to be
/// placed somewhere convenient afterwards.
test open_challenge_rejects_keeping_the_token() {
  let datum = mock_datum()
  let self =
    Transaction {
      ..mock_open_tx(datum, datum.submitted_at, 10),
      outputs: [
        Output {
          address: from_script(mock_script_hash),
          value: assets.from_lovelace(datum.bond_amount),
          datum: transaction.InlineDatum(datum),
          reference_script: None,
        },
        Output {
          address: from_verification_key(datum.challenger_key_hash),
          value: mock_challenge_token(),
          datum: transaction.NoDatum,
          reference_script: None,
        },
      ],
    }
  !nhop_challenge.mint(
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
          value: assets.merge(assets.from_lovelace(1_000_000), mock_challenge_token()),
          datum: transaction.InlineDatum(datum),
          reference_script: None,
        },
      ],
    }
  !nhop_challenge.mint(
    OpenChallenge { current_timestamp: datum.submitted_at },
    mock_script_hash,
    self,
  )
}

/// Without this, the mint handler decides nothing: anyone could pay this
/// address directly, never mint, and write whatever time suited them.
test resolve_rejects_a_challenge_that_was_never_minted() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_input =
    transaction.Input {
      output_reference: own_ref,
      output: Output {
        address: from_script(mock_script_hash),
        // No challenge token — a plain payment to the script address.
        value: assets.from_lovelace(25_000_000),
        datum: transaction.InlineDatum(datum),
        reference_script: None,
      },
    }
  let resolve_time = datum.submitted_at + nhop_defence_ms
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
      // A burn IS declared, so the burn check is satisfied and only the
      // token-presence check can reject this. Without that the burn check
      // answers first and this test says nothing about the bypass it names —
      // which is what it did until the guard was removed to see.
      mint: mock_challenge_burn(),
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

/// A resolved challenge must not leave its token behind for a later forged
/// challenge to carry.
test resolve_rejects_leaving_the_token_unburned() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
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
      // Nothing burned.
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}
