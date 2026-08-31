// ============================================================================
// Noctis Zone — Cardano L1 LP Escrow Contract (Aiken)
// Used by both Cardano curves (CLAUDE.md Contract Architecture table)
// ============================================================================
// This is the Cardano L1 counterpart to the Midnight lp_escrow.compact PSM
// (Midnight Launch uses a Midnight-native LP Escrow PSM instead). Same
// invariants either way:
//   1. 365-day lock from graduation timestamp
//   2. No withdraw() — EVER. Zero code paths return LP tokens to any wallet.
//   3. migrate() requires: lock expired + governor/community signature +
//      whitelist member
//   4. DEX whitelist is updatable via team multisig + 72h public notice
//      (Option B, implemented for real 2026-07-10 — see below)
//   5. CTO support: community wallet can migrate after lock expiry
//   6. Cancel state for a stuck bonding curve resolution
//
// Rewritten 2026-07-09 to match real Aiken v1.1.23 syntax — see
// bonding_curve.ak's header comment for the full explanation of what was
// wrong with the original draft (fictional `ScriptContext`/`Ed25519`/
// `Blake2b_224` API, `require()`, `fn spend(...) -> Void`). Authorization
// now uses `self.extra_signatories` instead of manually re-verifying
// signatures passed through the redeemer, and the DEX whitelist is typed
// as `List<Credential>` (a real Cardano address credential) instead of a
// raw `ByteArray` hash — this lets migration verification check the
// output's actual `payment_credential` directly instead of re-deriving it.
//
// Fix (2026-07-10): this file's own header claimed "Option B —
// multisig + 72h notice" from the day it was rewritten, but the actual
// `AddDex`/`RemoveDex` redeemers only ever required ONE governor signature
// with immediate effect — no multisig, no notice period. The comment
// described the intended design; the code didn't implement it. Replaced
// both redeemers with a propose → 72h-notice → execute pattern:
// `ProposeDexChange` (requires `multisig_threshold`-of-`multisig_signers`
// real signatures, not any hardcoded number — the M/N split is a
// deployment-time choice, not baked into contract logic), then
// `ExecuteDexChange` once `notice_period` (259_200s = 72h) has passed
// since the proposal — permissionless, same "the deadline check itself is
// the authorization" idiom as `ExpireCurve`'s, since the proposal was
// already public for the full notice window by the time anyone can
// execute it. `CancelPendingDexChange` lets the multisig withdraw a
// proposal before it takes effect (e.g. community pushback during the
// notice window).
//
// Fix (2026-07-10): `SealLock` previously just required a governor
// signature and flipped `lp_state` to `Locked` — it never checked that any
// real ADA or LP tokens actually arrived at this UTXO. Paired with the
// bonding curve contracts' new `Graduate` redeemer (bonding_curve.ak /
// bonding_curve_tier_b.ak), a graduation transaction now needs BOTH
// halves to validate in the same tx: Graduate verifies the curve's own
// balance shrinks by the exact amount moving here, and SealLock (now
// permissionless, replacing the governor-signature requirement with a real
// value check via `lp_value_received`) verifies this contract's own
// continuing output actually gained `seeded_ada` lovelace and exactly
// `lp_token_amount` of the launch token — the same "the correctness of the
// resulting state is the authorization, not a signature" idiom used by
// ExpireCurve/ExecuteDexChange/Graduate. `lp_token_amount` is fixed at
// deploy (15% of TOTAL_SUPPLY, known before graduation) and now represents
// the EXPECTED reserve quantity to be checked against, not just a record of
// what's already there.
//
// Fix (2026-07-10): CLAUDE.md's "Stream B — LP Trading Fees" describes
// DEX pool fees paying "directly to fee_recipient, not via escrow" — but
// since the LP position itself is locked HERE (a script address, not a
// wallet), any DEX-native fee-harvest mechanism has to be invoked through
// this contract, whatever "directly" means at the DEX's own level. Added a
// new `HarvestFees` redeemer and `fee_recipient_pub_key_hash` field
// (CTO-redirectable, same pattern as Migrate's authorization). Deliberately
// DEX-AGNOSTIC and narrow in scope: each whitelisted DEX (CSwap, Minswap,
// Splash, WingRiders, SundaeSwap) has its own real harvest interface, none of which is
// confirmed yet (still an open sub-question — "confirm fee harvesting
// capability per DEX before finalising whitelist"), so this script cannot
// verify the DEX-side call at all. What it CAN and DOES verify, regardless
// of which DEX is involved: the locked LP position is completely untouched
// (`lp_position_untouched`) and the correct recipient actually receives the
// harvested ADA in the same transaction (`fee_recipient_paid`) — the real
// per-DEX harvest call happens as other inputs/outputs in that same
// transaction, outside what this validator can or needs to see.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Credential, from_script, from_verification_key,
  with_delegation_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use noctis/lp_escrow_datum.{
  DexAction, LpEscrowDatum, LpState, PendingDexChange, ProposeAdd, ProposeRemove,
  Cancelled, Locked,
}
use noctis/settlement
use noctis/thread_nft
use cto_governance.{
  CtoGovernanceDatum, DissolveCTOProposal, Executed, Passed, PreCTO,
  ProposalAnchor, ProposalType, SilenceLockTrigger,
}

/// Same finding/fix as the linear curve's bonding_curve.ak — see that file's
/// own comment on `validity_range_is_narrow` for the full explanation.
/// Only `ExecuteDexChange` needs this here — it's the one permissionless,
/// timestamp-deadline-gated redeemer in this file (`ProposeDexChange`
/// requires a real multisig signature, same "trusted signer" exemption as
/// `ActivateCurve`; `SealLock`/`Migrate`'s own timestamp fields aren't
/// bound to `interval.contains` at all, a different mechanism entirely).
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


/// Redeemer actions — what the contract can be spent with
pub type LpEscrowRedeemer {
  /// Seals the lock (sets lock_timestamp), paired with the bonding
  /// curve's `Graduate` redeemer in the same transaction. Permissionless —
  /// verified by `lp_value_received` actually finding `seeded_ada`
  /// lovelace and `lp_token_amount` of the launch token in this contract's
  /// own continuing output, not by a governor signature.
  SealLock { timestamp: Int, seeded_ada: Int }
  /// Propose adding/removing a DEX from the whitelist. Requires
  /// `multisig_threshold`-of-`multisig_signers` real signatures. Starts
  /// the 72h public notice clock — does NOT change the whitelist yet.
  ProposeDexChange { dex_credential: Credential, action: DexAction, timestamp: Int }
  /// Apply a pending whitelist change once its 72h notice period has
  /// elapsed. Permissionless — the proposal was already public for the
  /// full window, same "deadline is the authorization" idiom as
  /// ExpireCurve's.
  ExecuteDexChange { current_timestamp: Int }
  /// Multisig withdraws a pending change before it takes effect.
  CancelPendingDexChange
  /// Migrate LP to a whitelisted DEX after lock expiry. Either governor or
  /// community wallet (if CTO triggered) can call this.
  ///
  /// The replacement position is DECLARED here rather than derived. A new
  /// pool's LP token identity is minted by that DEX and cannot be known when
  /// this datum is authored, so the transaction states what it is returning
  /// and the validator holds it to that statement — the escrow's continuing
  /// output must really carry it, and the continuing datum must name it.
  Migrate {
    target_dex_credential: Credential,
    current_timestamp: Int,
    new_lp_policy_id: PolicyId,
    new_lp_name: AssetName,
    new_lp_amount: Int,
  }
  /// Trigger CTO — redirect control to community wallet
  TriggerCTO { community_wallet_hash: VerificationKeyHash }
  /// Dissolve CTO — return control to governor
  DissolveCTO
  /// Cancel launch (bonding curve expired without graduation)
  CancelLaunch
  /// Harvest DEX trading fees without touching the locked LP position.
  /// Permissionless — like ExpireCurve/ExecuteDexChange/Graduate, the
  /// invariant checks are the authorization: the locked LP position cannot
  /// change and the correct recipient must actually be paid, so there is
  /// nothing a malformed or adversarial caller could gain by invoking this
  /// incorrectly. Real per-DEX harvest mechanics are NOT modeled here — see
  /// file header.
  HarvestFees { harvested_amount: Int }
  /// Read-only query, no state change, no authorization required
  QueryState
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// Minimum lock duration: 365 days in MILLISECONDS.
///
/// This is the floor a launch's own `lock_duration` must clear at SealLock,
/// and `is_lock_expired` adds that duration to a `lock_timestamp` carried on
/// Cardano's validity range — which is milliseconds. Expressed in seconds it
/// admitted a lock of about nine hours as a "365-day" lock. Same unit class as
/// `dex_change_notice_period` below and `execution_window` in cto_governance.
const min_lock_duration = 31_536_000_000

/// 90 days in MILLISECONDS — minimum gap between migrations of the same
/// position, per LP_MIGRATION_COOLDOWN. Written in the same units as
/// `min_lock_duration` above and for the same reason: every timestamp it is
/// compared against arrives on Cardano's validity range.
const migration_cooldown = 7_776_000_000

/// 72 hours in MILLISECONDS — public notice period between proposing
/// and executing a DEX whitelist change.
///
/// Fix (2026-07-17): was previously `259_200` (72 hours in SECONDS) —
/// same bug class as bonding_curve.ak's `max_curve_duration`,
/// cto_governance.ak's `execution_window`. `ProposeDexChange`'s `timestamp`
/// and `ExecuteDexChange`'s `current_timestamp` are both checked via
/// `interval.contains(self.validity_range, ...)`, and Cardano's real
/// transaction validity range is natively milliseconds — so the real
/// "72-hour public notice period" was actually only 259,200 milliseconds,
/// about 4.3 real minutes. Found while researching Phase 5b (real DEX
/// migration) of the Cardano Preprod milestone, before ever building or
/// testing the mechanism for real. Every existing test derives its
/// timestamps FROM this constant (`dex_change_notice_period ± 100`, not
/// hardcoded literals like earlier similar bugs), so no test rescaling was
/// needed — see internal tracking.
const dex_change_notice_period = 259_200_000

// ============================================================================
// HELPERS
// ============================================================================

fn is_whitelisted(whitelist: List<Credential>, credential: Credential) -> Bool {
  list.has(whitelist, credential)
}

/// At least `threshold` of `signers` must appear in the tx's real
/// signatures — a real M-of-N multisig check, not a single governor key.
fn multisig_satisfied(
  signers: List<VerificationKeyHash>,
  threshold: Int,
  self: Transaction,
) -> Bool {
  let signed_count =
    list.length(
      list.filter(signers, fn(vkh) { list.has(self.extra_signatories, vkh) }),
    )
  signed_count >= threshold
}

fn is_lock_expired(datum: LpEscrowDatum, current_timestamp: Int) -> Bool {
  current_timestamp >= datum.lock_timestamp + datum.lock_duration
}

/// Fix: real evidence a vote actually passed, replacing a
/// bare governor signature — same mechanism and reasoning as
/// bonding_curve.ak's own cto_vote_verified (see that file's doc comment
/// for the full explanation, including why last_executed_proposal rather
/// than the clearable active_proposal, and why expected_recipient is
/// `None` for DissolveCTOProposal).
fn cto_vote_verified(
  self: Transaction,
  datum: LpEscrowDatum,
  proposal_type: ProposalType,
  expected_recipient: Option<VerificationKeyHash>,
) -> Bool {
  expect Some(cto_ref_input) =
    list.find(
      self.reference_inputs,
      fn(input) {
        input.output.address.payment_credential == datum.cto_governance_credential
      },
    )
  expect InlineDatum(cto_raw_datum) = cto_ref_input.output.datum
  expect cto_datum: CtoGovernanceDatum = cto_raw_datum
  expect Some(executed) = cto_datum.last_executed_proposal

  let recipient_ok = when expected_recipient is {
    Some(recipient) -> executed.allocation_recipient_hash == recipient
    None -> True
  }

  and {
    // Fix (2026-07-23 audit): the referenced governance UTXO must carry
    // the genuine per-launch governance thread NFT (policy =
    // datum.thread_nft_policy, asset_name = launch_id). WITHOUT this,
    // list.find above trusts the UTXO by ADDRESS ALONE — and anyone can
    // create a UTXO at cto_governance_credential carrying a forged
    // governance datum claiming a passed, executed outcome
    // datum, because paying to a script address never runs its validator
    // and this reference input is never spent (no validator runs on it).
    // The NFT is minted once at governance setup under a governor-signature
    // policy (no attacker can mint it) and preserved in cto_governance.ak's
    // continuing output on every spend, so only the real governance UTXO
    // can ever carry it.
    assets.quantity_of(cto_ref_input.output.value, datum.thread_nft_policy, datum.launch_id) == 1,
    cto_datum.launch_id == datum.launch_id,
    executed.proposal_type == proposal_type,
    executed.outcome == Passed,
    executed.execution_status == Executed,
    recipient_ok,
  }
}

/// Governor, or (if CTO has been triggered) the community wallet
fn is_authorized(datum: LpEscrowDatum, self: Transaction) -> Bool {
  list.has(self.extra_signatories, datum.governor_pub_key_hash) || (
    datum.cto_triggered && list.has(
      self.extra_signatories,
      datum.community_wallet_hash,
    )
  )
}

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> LpEscrowDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: LpEscrowDatum = raw_datum
  new_datum
}

/// Verify this contract's own continuing output actually gained
/// `seeded_ada` lovelace (relative to the input being spent) and holds
/// exactly `lp_token_amount` of the launch token — the receiving-side
/// mirror of bonding_curve.ak's `graduation_funds_left_curve`/
/// `lp_seeding_output_ok`. Real value movement, not a self-reported claim.
fn lp_value_received(
  self: Transaction,
  own_ref: OutputReference,
  datum: LpEscrowDatum,
  seeded_ada: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  let lovelace_ok =
    assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) + seeded_ada
  let tokens_ok =
    assets.quantity_of(
      own_output.value,
      datum.lp_token_policy_id,
      datum.lp_token_name,
    ) == datum.lp_token_amount
  lovelace_ok && tokens_ok
}

/// Fix (2026-07-16): same fix, same reasoning, as bonding_curve.ak —
/// see that file's comment on output_value_clean for the full rationale
/// (MeshJS's own open-source escrow.ak names this the "unbounded value
/// vulnerability"). Both SealLock and HarvestFees are permissionless —
/// this contract's output could otherwise be padded on its long-lived, repeatedly-spent
/// LP UTXO with junk native assets.
fn output_value_clean(output: Output, max_assets: Int) -> Bool {
  list.length(assets.flatten(output.value)) <= max_assets
}

fn lp_own_output_clean(self: Transaction, own_ref: OutputReference) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  // 3, not 2, since the thread NFT was added: lovelace + the launch token + this launch's own
  // thread NFT.
  output_value_clean(own_output, 3)
}

/// Fix (2026-07-19, full-suite security audit) — same fix, same
/// reasoning, as bonding_curve.ak: closes a double-satisfaction risk,
/// since every launch's LP escrow shares this one fixed, unparameterized
/// script address. See that file's own comment on this exact helper for
/// the full explanation.
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

/// Fix (2026-07-19, full-suite security audit): CRITICAL finding —
/// `ExecuteDexChange`, `ProposeDexChange`, `CancelPendingDexChange`,
/// `TriggerCTO`, `DissolveCTO`, and `CancelLaunch` previously relied on
/// `own_continuing_datum` ALONE — which only ever compares the continuing
/// output's DATUM, never its VALUE. Nothing stopped any of these six
/// redeemers (three of them fully permissionless) from being satisfied by
/// a continuing output carrying the exact right datum but only min-UTXO
/// lovelace, while the REAL locked ADA + LP tokens were diverted
/// elsewhere in the same transaction — directly contradicting this file's
/// own "no withdraw() ever" invariant. This verifies the continuing
/// output's real value is byte-for-byte UNCHANGED from the input being
/// spent — the correct requirement for every one of these six redeemers,
/// none of which are meant to move the locked position at all (only
/// `SealLock`/`Migrate`/`HarvestFees` legitimately touch real value, and
/// each already has its own dedicated, real value-movement check).
/// The escrow's own continuing output really holds the replacement position
/// the migration declared.
///
/// A migration moves the LP out; this is what requires something to come
/// back. Without it the escrow keeps only its thread NFT and a datum still
/// naming the position it just sent away — a record of a holding it does not
/// have, which is the difference between moving a position and releasing one.
///
/// The identity is taken from the redeemer because a new pool's LP token is
/// minted by the DEX and cannot be known in advance. That makes this a check
/// on the escrow's real value against a declaration, not proof of where the
/// token came from; the datum's honesty is what it buys.
fn replacement_position_returned(
  self: Transaction,
  own_ref: OutputReference,
  new_lp_policy_id: PolicyId,
  new_lp_name: AssetName,
  new_lp_amount: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  when list.find(self.outputs, fn(output) { output.address == own_address }) is {
    None -> False
    Some(own_output) ->
      assets.quantity_of(own_output.value, new_lp_policy_id, new_lp_name) == new_lp_amount
  }
}

fn lp_value_unchanged(self: Transaction, own_ref: OutputReference) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  own_output.value == own_input.output.value
}

/// The active recipient of harvested DEX trading fees — the creator's
/// own wallet, or (once CTO has been triggered) the community wallet.
/// Mirrors `is_authorized`'s exact same governor-vs-community switch, just
/// for a payment destination instead of a signature check.
fn active_fee_recipient(datum: LpEscrowDatum) -> VerificationKeyHash {
  if datum.cto_triggered {
    datum.community_wallet_hash
  } else {
    datum.fee_recipient_pub_key_hash
  }
}

/// Verify the locked LP position is completely untouched by a
/// HarvestFees call — same policy target, quantity, and identity as the
/// input being spent. This is the core invariant the whole redeemer exists
/// to protect: harvesting trading fees must never be usable to drain the
/// locked LP itself.
fn lp_position_untouched(
  self: Transaction,
  own_ref: OutputReference,
  datum: LpEscrowDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.quantity_of(
    own_output.value,
    datum.lp_token_policy_id,
    datum.lp_token_name,
  ) == assets.quantity_of(
    own_input.output.value,
    datum.lp_token_policy_id,
    datum.lp_token_name,
  )
}

/// Verify the active fee recipient actually receives `harvested_amount`
/// lovelace in some output of this same transaction.
fn fee_recipient_paid(
  self: Transaction,
  own_ref: OutputReference,
  datum: LpEscrowDatum,
  harvested_amount: Int,
) -> Bool {
  // The payment credential, not the whole address. `from_verification_key`
  // builds a bare ENTERPRISE address, and an ordinary Cardano wallet hands out
  // BASE addresses — payment credential plus a staking part — so requiring the
  // whole address to match asks for a destination almost nobody actually uses.
  // The creator's LP trading fees are paid through here, so the effect was
  // that a normal wallet could not receive them at all. Same fix already
  // applied to the curve and staking payouts.
  let recipient_credential =
    from_verification_key(active_fee_recipient(datum)).payment_credential
  list.any(
    self.outputs,
    fn(output) {
      and {
        // Names THIS escrow's harvest. See noctis/settlement — a harvest and
        // an unrelated obligation owed to the same recipient would otherwise
        // both read one output as their own.
        settlement.settles(output, own_ref),
        output.address.payment_credential == recipient_credential,
        assets.lovelace_of(output.value) >= harvested_amount,
      }
    },
  ) && // ...and the recipient is genuinely better off by it.
  //
  // The check above asks whether an output at their credential holds the
  // harvest, which their own CHANGE also does — and now that a harvest is
  // signed by the recipient, the transaction CAN contain their utxos, which
  // is precisely the precondition that makes change indistinguishable from
  // payment. Adding the signature without this would have closed one gap by
  // opening another. See noctis/settlement's net_lovelace_gain.
  settlement.net_lovelace_gain(self, recipient_credential) >= harvested_amount
}

/// Verify the LP tokens land at the target DEX's payment credential, in the
/// full locked amount, in a single migration transaction.
///
/// Fix (2026-07-19, full-suite security audit): previously only
/// verified the LP TOKEN quantity — the escrow's real locked ADA (seeded
/// at SealLock time via `seeded_ada`, but not persisted anywhere in the
/// datum afterward) was never checked anywhere in `Migrate`, letting the
/// authorized signer (governor, or community post-CTO) divert all the
/// locked ADA to themselves while still completing an apparently-valid
/// migration to a real whitelisted DEX — directly contradicting CLAUDE.md's
/// "underlying ADA + tokens never appear in any wallet UTxO" migration
/// invariant. Since no datum field records the locked ADA amount, the only
/// real source of truth is the escrow's OWN INPUT value at the moment of
/// migration (`own_input`) — the target output must receive at least that
/// much lovelace, not a self-reported or datum-derived figure.
fn migration_output_ok(
  self: Transaction,
  datum: LpEscrowDatum,
  target_dex_credential: Credential,
  own_input_lovelace: Int,
) -> Bool {
  list.any(
    self.outputs,
    fn(output) {
      output.address.payment_credential == target_dex_credential && assets.quantity_of(
        output.value,
        datum.lp_token_policy_id,
        datum.lp_token_name,
      ) == datum.lp_token_amount && assets.lovelace_of(output.value) >= own_input_lovelace
    },
  )
}


/// State authentication (2026-08-03 audit) — the launch's own thread NFT must be present on the UTXO being
/// spent AND on the continuing output. See noctis/thread_nft, and the linear curve's
/// bonding_curve.ak thread_nft_intact, for the full reasoning: every
/// validator here is unparameterized, so all launches share one address and
/// a UTXO's legitimacy would otherwise rest on a datum anyone can author.
fn thread_nft_intact(
  self: Transaction,
  own_ref: OutputReference,
  datum: LpEscrowDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  let name =
    thread_nft.thread_asset_name(thread_nft.role_lp_escrow, datum.launch_id)
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

validator lp_escrow {
  spend(
    datum_opt: Option<LpEscrowDatum>,
    redeemer: LpEscrowRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    and {
      // See single_own_utxo's own doc comment — closes the
      // double-satisfaction risk for every redeemer below in one place.
      single_own_utxo(self, own_input.output.address),
      // State authentication (2026-08-03 audit) — see thread_nft_intact's own doc comment. Applied here, once,
      // for the same reason: it holds for every redeemer below.
      thread_nft_intact(self, own_ref, datum),
      when redeemer is {
        SealLock { timestamp, seeded_ada } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.lock_duration >= min_lock_duration,
          datum.lock_timestamp == 0,
          interval.contains(self.validity_range, timestamp),
          // The sealed `timestamp` is the origin the whole 365-day lock is
          // measured from (`is_lock_expired` adds `lock_duration` to it), and
          // sealing is permissionless — it rides the graduation transaction,
          // authorised by the LP value really arriving rather than by a
          // signature. So the two checks have to work together: containment
          // alone lets the caller declare a range wide enough to hold both
          // real chain time and a `timestamp` far from it, and the width
          // bound is what pins the declared value to now. Any redeemer that
          // accepts a caller-declared timestamp needs both halves.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          seeded_ada > 0,
          lp_value_received(self, own_ref, datum, seeded_ada),
          // The sealed LP position can't be padded with junk assets.
          lp_own_output_clean(self, own_ref),
          new_datum == LpEscrowDatum {
            ..datum,
            lock_timestamp: timestamp,
            lp_state: Locked,
          },
        }
      }

      ProposeDexChange { dex_credential, action, timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let action_makes_sense = when action is {
          ProposeAdd -> !is_whitelisted(datum.dex_whitelist, dex_credential)
          ProposeRemove -> is_whitelisted(datum.dex_whitelist, dex_credential)
        }
        and {
          multisig_satisfied(datum.multisig_signers, datum.multisig_threshold, self),
          datum.pending_dex_change == None,
          action_makes_sense,
          interval.contains(self.validity_range, timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          new_datum == LpEscrowDatum {
            ..datum,
            pending_dex_change: Some(
              PendingDexChange {
                dex_credential: dex_credential,
                action: action,
                proposed_at: timestamp,
              },
            ),
          },
          // This redeemer only ever proposes a future whitelist
          // change — it must never move the locked position's real value.
          lp_value_unchanged(self, own_ref),
        }
      }

      ExecuteDexChange { current_timestamp } -> {
        expect Some(pending) = datum.pending_dex_change
        let new_whitelist = when pending.action is {
          ProposeAdd -> [pending.dex_credential, ..datum.dex_whitelist]
          ProposeRemove ->
            list.filter(
              datum.dex_whitelist,
              fn(c) { c != pending.dex_credential },
            )
        }
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          interval.contains(self.validity_range, current_timestamp),
          // Bound the declared validity range's own width — without
          // this, ANYONE (this redeemer is permissionless by design) could
          // claim a far-future current_timestamp and bypass the real
          // 72-hour public notice period entirely.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp >= pending.proposed_at + dex_change_notice_period,
          new_datum == LpEscrowDatum {
            ..datum,
            dex_whitelist: new_whitelist,
            pending_dex_change: None,
          },
          // This redeemer is fully permissionless, so it must enforce full value
          // conservation on-chain: the locked ADA + LP tokens must be
          // preserved, not merely the datum. A correct-looking datum alone
          // must never authorize moving the locked value away
          // elsewhere in the same transaction). Only the whitelist and
          // pending-change fields should ever change here.
          lp_value_unchanged(self, own_ref),
        }
      }

      CancelPendingDexChange -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          multisig_satisfied(datum.multisig_signers, datum.multisig_threshold, self),
          datum.pending_dex_change != None,
          new_datum == LpEscrowDatum { ..datum, pending_dex_change: None },
          // This redeemer only ever clears a pending proposal — it
          // must never move the locked position's real value.
          lp_value_unchanged(self, own_ref),
        }
      }

      Migrate {
        target_dex_credential,
        current_timestamp,
        new_lp_policy_id,
        new_lp_name,
        new_lp_amount,
      } -> {
        // The position moves to a new DEX and stays escrowed: the LP tokens
        // and the escrow's lovelace go to the target, while this script keeps
        // a continuing output carrying the thread NFT and a datum recording
        // the move. `thread_nft_intact` above requires that output on every
        // spend, so there is always one to constrain.
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.lp_state == Locked,
          // A position that was never sealed has no lock to expire —
          // lock_timestamp is 0 until SealLock runs, which would otherwise
          // make `is_lock_expired` trivially true from genesis.
          datum.lock_timestamp != 0,
          is_lock_expired(datum, current_timestamp),
          // LP_MIGRATION_COOLDOWN: at least 90 days since the last move.
          // Zero means the position has never migrated, so the only gate is
          // the 365-day lock above.
          or {
            datum.last_migration_timestamp == 0,
            current_timestamp >= datum.last_migration_timestamp + migration_cooldown,
          },
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          is_whitelisted(datum.dex_whitelist, target_dex_credential),
          is_authorized(datum, self),
          // Fix: migration_output_ok now also requires the target
          // output receive at least the escrow's own real locked lovelace
          // (read from own_input, not a self-reported/datum figure — see
          // that function's own doc comment for why no datum field can
          // serve this purpose).
          migration_output_ok(
            self,
            datum,
            target_dex_credential,
            assets.lovelace_of(own_input.output.value),
          ),
          // A position must come back. The escrow's continuing output has to
          // really hold the replacement the redeemer declared, and a zero
          // amount is not a position — without that bound, declaring zero
          // would satisfy the check while nothing returned.
          new_lp_amount > 0,
          replacement_position_returned(
            self,
            own_ref,
            new_lp_policy_id,
            new_lp_name,
            new_lp_amount,
          ),
          // Everything about the position is carried forward except the
          // record of when it moved and the identity of what is now held.
          // Without this the continuing datum is unconstrained: it could keep
          // a stale migration timestamp and migrate again immediately, or
          // rewrite the whitelist, the fee recipient or the governor on the
          // way past — and it would go on naming the position just sent away.
          new_datum == LpEscrowDatum {
            ..datum,
            lp_token_policy_id: new_lp_policy_id,
            lp_token_name: new_lp_name,
            lp_token_amount: new_lp_amount,
            last_migration_timestamp: current_timestamp,
          },
        }
      }

      TriggerCTO { community_wallet_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Enforcement: permissionless, gated on real anchored vote
          // evidence instead of a bare governor signature.
          cto_vote_verified(
            self,
            datum,
            SilenceLockTrigger,
            Some(community_wallet_hash),
          ),
          !datum.cto_triggered,
          community_wallet_hash != #"",
          new_datum == LpEscrowDatum {
            ..datum,
            cto_triggered: True,
            community_wallet_hash: community_wallet_hash,
          },
          // CRITICAL fix: this redeemer is permissionless given real
          // vote evidence — was previously a drain path for the same
          // reason as ExecuteDexChange above. Only cto_triggered/
          // community_wallet_hash should ever change here.
          lp_value_unchanged(self, own_ref),
        }
      }

      DissolveCTO -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Enforcement: same reasoning, gated on a real anchored
          // DissolveCTOProposal instead of a bare governor signature.
          cto_vote_verified(self, datum, DissolveCTOProposal, None),
          datum.cto_triggered,
          new_datum == LpEscrowDatum {
            ..datum,
            cto_triggered: False,
            community_wallet_hash: #"",
          },
          // Same reasoning as TriggerCTO above.
          lp_value_unchanged(self, own_ref),
        }
      }

      CancelLaunch -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.lp_state == Locked,
          // Only a genesis/never-sealed position (no real value locked
          // yet) can be cancelled — the same lock_timestamp == 0
          // discriminator SealLock itself uses. A real, sealed position
          // must go through Migrate after real lock expiry instead.
          datum.lock_timestamp == 0,
          new_datum == LpEscrowDatum { ..datum, lp_state: Cancelled },
          // A governor signature alone should never be able to also
          // divert the locked position's real value while flipping this
          // flag — only the state transition should be observable here.
          lp_value_unchanged(self, own_ref),
        }
      }

      HarvestFees { harvested_amount } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.lp_state == Locked,
          harvested_amount > 0,
          new_datum == datum,
          // CRITICAL fix: lp_position_untouched only ever checked the
          // LP TOKEN quantity, never lovelace — this permissionless
          // redeemer could previously be called with a trivial
          // harvested_amount (e.g. 1) while the entire real locked ADA
          // balance was diverted as unaccounted-for "change" in the same
          // transaction. The real harvested fee must come from OUTSIDE
          // this escrow (a genuine external DEX fee-collection mechanism,
          // not this contract's own locked balance) — so the escrow's own
          // value must stay completely unchanged, same requirement as
          // every other non-SealLock/Migrate redeemer in this file.
          lp_value_unchanged(self, own_ref),
          lp_position_untouched(self, own_ref, datum),
          // Signed by whoever the fees are for.
          //
          // This was permissionless on the reasoning that nobody can gain by
          // calling it, since the LP position cannot move — true, and not the
          // whole question. Nobody could gain, but anyone could CHURN: the
          // continuing output is identical to the input, so this redeemer
          // rebuilds the escrow UTXO at a new reference for the price of a
          // fee. That invalidates whatever was being built against the old
          // one, and this UTXO is read as a REFERENCE INPUT by the CTO
          // anchor, which is the community's own rescue path.
          //
          // The recipient is the only party a harvest is for, so requiring
          // their signature costs nobody anything and removes the churn.
          list.has(self.extra_signatories, active_fee_recipient(datum)),
          fee_recipient_paid(self, own_ref, datum, harvested_amount),
          // HarvestFees is permissionless — the LP position's own
          // continuing output can't be padded with junk assets either.
          lp_own_output_clean(self, own_ref),
        }
      }

      // CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks),
      // an unconditional authorization over the locked LP position. See
      // that file's own comment on this exact line for the full
      // explanation.
      QueryState -> False
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

/// State authentication (2026-08-03 audit) — the thread NFT every fixture's own input and continuing output
/// must now carry, matching mock_datum's launch_id (#"01") and
/// thread_nft_policy (#"c0ffee"). Derived through thread_asset_name rather
/// than hard-coded so a scheme change cannot leave these silently passing.
/// The replacement position a migration declares it is returning. Arbitrary
/// values: the validator checks the escrow really holds what was declared,
/// not where the token came from.
const mock_new_lp_policy: ByteArray = #"44"

const mock_new_lp_name: ByteArray = "lp-v2"

const mock_new_lp_amount: Int = 500

/// A continuing output's value for a migration: the thread NFT plus the
/// declared replacement position. Every migration fixture uses this, so a
/// rejection test still fails for its own single reason rather than also
/// failing to return a position.
fn mock_thread_nft_with_new_lp() -> assets.Value {
  assets.merge(
    mock_thread_nft(),
    assets.from_asset(mock_new_lp_policy, mock_new_lp_name, mock_new_lp_amount),
  )
}

fn mock_thread_nft() -> assets.Value {
  assets.from_asset(
    #"c0ffee",
    thread_nft.thread_asset_name(thread_nft.role_lp_escrow, #"01"),
    1,
  )
}


fn mock_datum(lp_state: LpState, lock_timestamp: Int) -> LpEscrowDatum {
  LpEscrowDatum {
    launch_id: #"01",
    lock_timestamp: lock_timestamp,
    lock_duration: min_lock_duration,
    lp_state: lp_state,
    governor_pub_key_hash: #"22",
    community_wallet_hash: #"",
    cto_triggered: False,
    fee_recipient_pub_key_hash: #"dd",
    dex_whitelist: [],
    multisig_signers: [#"aa", #"bb", #"cc"],
    multisig_threshold: 2,
    pending_dex_change: None,
    lp_token_policy_id: #"33",
    lp_token_name: "lp",
    lp_token_amount: 1000,
    cto_governance_credential: from_verification_key(#"aa").payment_credential,
    thread_nft_policy: #"c0ffee",
    last_migration_timestamp: 0,
  }
}

fn mock_proposal_anchor(
  proposal_type: ProposalType,
  outcome: cto_governance.ProposalOutcome,
  execution_status: cto_governance.ExecutionStatus,
  allocation_recipient_hash: ByteArray,
) -> ProposalAnchor {
  ProposalAnchor {
    proposal_type: proposal_type,
    description_hash: #"aa",
    proof_bundle_hash: #"bb",
    yes_votes: 60_000,
    no_votes: 10_000,
    voter_count: 5,
    creator_yes_votes: 0,
    creator_no_votes: 0,
    outcome: outcome,
    start_timestamp: 0,
    end_timestamp: 1000,
    anchor_timestamp: 500,
    execution_status: execution_status,
    target_dex_credential: None,
    allocation_amount: 0,
    allocation_recipient_hash: allocation_recipient_hash,
    relayer_credential_hash: #"33",
  }
}

fn mock_cto_governance_datum(
  launch_id: ByteArray,
  last_executed_proposal: Option<ProposalAnchor>,
) -> CtoGovernanceDatum {
  CtoGovernanceDatum {
    launch_id: launch_id,
    cto_state: PreCTO,
    community_wallet_hash: #"",
    governor_credential_hash: #"22",
    total_supply: 1_000_000,
    quorum_bps: 500,
    creator_vote_cap_bps: 100,
    // Anti-whale-takeover fix (2026-07-28): mirrors cto_governance.compact's
    // minVoterCount — see that contract's own datum field for rationale.
    min_voter_count: 15,
    active_proposal: None,
    proposal_count: 1,
    last_executed_proposal: last_executed_proposal,
    pending_relayer_bond: 0,
    pending_relayer_key_hash: #"",
    treasury_pub_key_hash: #"55",
    ops_pub_key_hash: #"66",
    // Fix: must match both the escrow datum's thread_nft_policy and the
    // NFT placed in this reference UTXO's value in the CTO-vote tests below.
    thread_nft_policy: #"c0ffee",
    ballot_duration: 500,
    // These fixtures read a governance UTXO as a REFERENCE input; none of them
    // anchors a ballot, so the cooldown has no bearing here. 0 is the genesis
    // value: no ballot has ever run for this launch.
    last_ballot_end_timestamp: 0,
  }
}

/// A reference input at the given address holding the given
/// CtoGovernanceDatum — mirrors how a real TriggerCTO/DissolveCTO
/// transaction would present cto_governance.ak's own UTXO as evidence.
fn mock_cto_ref_input(
  cto_address: Address,
  cto_datum: CtoGovernanceDatum,
) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"cd", output_index: 0 },
    output: Output {
      address: cto_address,
      // Fix: genuine governance UTXO carries its per-launch thread NFT
      // (policy = the escrow datum's thread_nft_policy `#"c0ffee"`,
      // asset_name = launch_id); cto_vote_verified now requires it.
      value: assets.from_asset(#"c0ffee", cto_datum.launch_id, 1),
      datum: InlineDatum(cto_datum),
      reference_script: None,
    },
  }
}

test is_lock_expired_at_exact_boundary() {
  let datum = mock_datum(Locked, 1000)
  is_lock_expired(datum, 1000 + min_lock_duration)
}

test is_lock_expired_one_second_early_fails() {
  let datum = mock_datum(Locked, 1000)
  !is_lock_expired(datum, 1000 + min_lock_duration - 1)
}

test is_whitelisted_finds_member() {
  let dex = from_script(#"aa").payment_credential
  is_whitelisted([dex], dex)
}

test is_whitelisted_rejects_non_member() {
  let dex_a = from_script(#"aa").payment_credential
  let dex_b = from_script(#"bb").payment_credential
  !is_whitelisted([dex_a], dex_b)
}

test seal_lock_succeeds_with_real_value_received() {
  // SealLock is permissionless now — no extra_signatories at all —
  // verified instead by the continuing output actually holding the seeded
  // ADA and the exact lp_token_amount (1000, per mock_datum).
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // A real, narrow range around the declared seal time. The placeholder's
      // own range is unbounded, which satisfies containment without saying
      // anything about when this transaction actually happened.
      validity_range: interval.between(400, 600),
    }

  lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

test seal_lock_rejects_padded_output() {
  // Identical to seal_lock_succeeds_with_real_value_received, except
  // the sealed continuing output carries one extra, unrelated junk asset.
  // SealLock is permissionless, so ANYONE could otherwise pad this
  // long-lived LP UTXO this way before the fix.
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.merge(
          assets.from_lovelace(2_000_000 + 98_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

test seal_lock_rejects_timestamp_outside_validity_range() {
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // The declared timestamp (500) claims to seal the lock long
      // before this transaction's own real validity range began.
      validity_range: interval.between(10_000, 10_100),
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

// `seal_lock_succeeds_with_real_value_received` with the declared seal time
// moved back by the whole lock duration, and the validity range widened to
// keep containing it. The range still contains real chain time, so the ledger
// would carry this transaction; containment alone is satisfied. The width
// bound is what refuses it, and the second half of the test says why that
// matters: the lock this transaction tried to write would have been over at
// the instant it was sealed.
test seal_lock_rejects_a_seal_time_far_from_real_chain_time() {
  let now = 1_800_000_000_000
  let back = now - min_lock_duration - 1
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: back, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(back - 1000, now + 1000),
    }

  and {
    !lp_escrow.spend(
      Some(datum),
      SealLock { timestamp: back, seeded_ada: 98_000 },
      own_ref,
      self,
    ),
    // What the refusal is worth: this seal would have produced a position
    // whose 365 days had already elapsed.
    is_lock_expired(new_datum, now),
  }
}

test seal_lock_fails_if_already_sealed() {
  // lock_timestamp != 0 means it's already been sealed once
  let datum = mock_datum(Locked, 100)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

test seal_lock_rejects_zero_seeded_ada() {
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 0 },
    own_ref,
    self,
  )
}

test seal_lock_rejects_wrong_token_amount() {
  // Correct ADA, but only 900 of the expected 1000 lp_token_amount arrived
  // — proves the token quantity is checked exactly, not just "some tokens."
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 900),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

test migrate_succeeds_after_expiry_to_whitelisted_dex() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 1000),
      dex_whitelist: [target_dex.payment_credential],
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  // The escrow keeps a continuing output, and its datum has to record when
  // the position moved — that record is what the cooldown is measured from.
  let migrated_datum =
    LpEscrowDatum {
      ..datum,
      lp_token_policy_id: mock_new_lp_policy,
      lp_token_name: mock_new_lp_name,
      lp_token_amount: mock_new_lp_amount,
      last_migration_timestamp: 1000 + min_lock_duration }
  let thread_continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft_with_new_lp(),
      datum: InlineDatum(migrated_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output, thread_continuing_output],
      extra_signatories: [#"22"],
      validity_range: interval.between(1000 + min_lock_duration, 1000 + min_lock_duration + 100),
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: mock_new_lp_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: 1000 + min_lock_duration,
    }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

/// The passing migration with ONE thing changed each time: nothing comes
/// back, a zero position is declared, the escrow holds less than declared,
/// or the datum goes on naming the position that was sent away. Each is the
/// accepted transaction plus a single delta, so a failure names one cause.
fn migrate_fixture(
  continuing_value: assets.Value,
  continuing_datum: LpEscrowDatum,
  declared_amount: Int,
) -> Bool {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 1000),
      dex_whitelist: [target_dex.payment_credential],
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let thread_continuing_output =
    Output {
      address: own_address,
      value: continuing_value,
      datum: InlineDatum(continuing_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output, thread_continuing_output],
      extra_signatories: [#"22"],
      validity_range: interval.between(1000 + min_lock_duration, 1000 + min_lock_duration + 100),
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: declared_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: 1000 + min_lock_duration,
    }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

/// The datum a correct migration leaves behind: it names the position now
/// held, not the one just sent away.
fn migrated_datum_naming(policy: ByteArray, name: ByteArray, amount: Int) -> LpEscrowDatum {
  let target_dex = from_script(#"aa")
  LpEscrowDatum {
    ..mock_datum(Locked, 1000),
    dex_whitelist: [target_dex.payment_credential],
    lp_token_policy_id: policy,
    lp_token_name: name,
    lp_token_amount: amount,
    last_migration_timestamp: 1000 + min_lock_duration,
  }
}

test migrate_fixture_is_accepted_as_written() {
  // The positive control. Without it the three rejections below could all be
  // failing for some unrelated reason in the fixture itself.
  migrate_fixture(
    mock_thread_nft_with_new_lp(),
    migrated_datum_naming(mock_new_lp_policy, mock_new_lp_name, mock_new_lp_amount),
    mock_new_lp_amount,
  )
}

test migrate_rejects_when_no_position_comes_back() {
  // The escrow keeps its thread NFT and nothing else — the shape a migration
  // that sends the position out and returns nothing would produce.
  !migrate_fixture(
    mock_thread_nft(),
    migrated_datum_naming(mock_new_lp_policy, mock_new_lp_name, mock_new_lp_amount),
    mock_new_lp_amount,
  )
}

test migrate_rejects_a_declared_position_of_zero() {
  // Declaring nothing would otherwise satisfy a possession check trivially:
  // the escrow does hold zero of any token it does not have.
  !migrate_fixture(
    mock_thread_nft(),
    migrated_datum_naming(mock_new_lp_policy, mock_new_lp_name, 0),
    0,
  )
}

test migrate_rejects_holding_less_than_was_declared() {
  !migrate_fixture(
    assets.merge(
      mock_thread_nft(),
      assets.from_asset(mock_new_lp_policy, mock_new_lp_name, mock_new_lp_amount - 1),
    ),
    migrated_datum_naming(mock_new_lp_policy, mock_new_lp_name, mock_new_lp_amount),
    mock_new_lp_amount,
  )
}

test migrate_rejects_a_datum_still_naming_the_old_position() {
  // The position really came back; the record did not follow it. An escrow
  // whose datum names a holding it does not have is the state this closes.
  !migrate_fixture(
    mock_thread_nft_with_new_lp(),
    LpEscrowDatum {
      ..migrated_datum_naming(mock_new_lp_policy, mock_new_lp_name, mock_new_lp_amount),
      lp_token_policy_id: #"33",
      lp_token_name: "lp",
      lp_token_amount: 1000,
    },
    mock_new_lp_amount,
  )
}

test migrate_rejects_current_timestamp_outside_validity_range() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      dex_whitelist: [target_dex.payment_credential],
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output],
      extra_signatories: [#"22"],
      // The transaction's own real validity range is nowhere near
      // lock expiry — only the redeemer's claimed current_timestamp is.
      validity_range: interval.between(0, 100),
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: mock_new_lp_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: min_lock_duration,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test migrate_fails_before_lock_expiry() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      dex_whitelist: [target_dex.payment_credential],
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output],
      extra_signatories: [#"22"],
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: mock_new_lp_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: min_lock_duration - 1,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test migrate_fails_to_non_whitelisted_dex() {
  let target_dex = from_script(#"aa")
  // whitelist is empty — target_dex was never added
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output],
      extra_signatories: [#"22"],
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: mock_new_lp_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: min_lock_duration,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test trigger_cto_succeeds_with_real_anchored_vote() {
  let datum = mock_datum(Locked, 0)
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      cto_triggered: True,
      community_wallet_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output],
    }

  lp_escrow.spend(
    Some(datum),
    TriggerCTO { community_wallet_hash: #"ee" },
    own_ref,
    self,
  )
}

// Regression (2026-07-23 audit): a UTXO planted at
// cto_governance_credential with a fully forged "Passed / Executed" datum but
// WITHOUT the genuine governance thread NFT must NOT satisfy
// cto_vote_verified. Cleanly returns False (ref input exists, lacks the NFT),
// so a plain `!spend(...)` assertion works.
test trigger_cto_rejects_forged_governance_utxo_without_nft() {
  let datum = mock_datum(Locked, 0)
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      cto_triggered: True,
      community_wallet_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  // FORGED: right governance address, fully "passed" datum, but no NFT.
  let forged_ref_input =
    Input {
      output_reference: OutputReference { transaction_id: #"cd", output_index: 0 },
      output: Output {
        address: cto_address,
        value: assets.zero,
        datum: InlineDatum(cto_datum),
        reference_script: None,
      },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [forged_ref_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    TriggerCTO { community_wallet_hash: #"ee" },
    own_ref,
    self,
  )
}

// Enforcement: cto_vote_verified's `expect Some(cto_ref_input) = ...`
// panics rather than returning False when no matching reference input
// exists, so this needs the `fail` test annotation — same reasoning as
// bonding_curve.ak's identically-named test.
test trigger_cto_rejects_without_reference_input() fail {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      cto_triggered: True,
      community_wallet_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
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

  lp_escrow.spend(
    Some(datum),
    TriggerCTO { community_wallet_hash: #"ee" },
    own_ref,
    self,
  )
}

test dissolve_cto_succeeds_with_real_anchored_vote() {
  let datum =
    LpEscrowDatum { ..mock_datum(Locked, 0), cto_triggered: True, community_wallet_hash: #"ee" }
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      cto_triggered: False,
      community_wallet_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(DissolveCTOProposal, Passed, Executed, #"")
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output],
    }

  lp_escrow.spend(Some(datum), DissolveCTO, own_ref, self)
}

test dissolve_cto_rejects_if_not_triggered() fail {
  let datum = mock_datum(Locked, 0)
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      cto_triggered: False,
      community_wallet_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // No CTO was ever triggered on this launch, so no real DissolveCTOProposal
  // could legitimately exist for it — omitting the reference input entirely
  // (rather than fabricating one) is the honest way to model that; the
  // `expect` panic is what should reject this, same as the
  // rejects_without_reference_input case above.
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  lp_escrow.spend(Some(datum), DissolveCTO, own_ref, self)
}

test migrate_succeeds_via_community_wallet_after_cto() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 1000),
      dex_whitelist: [target_dex.payment_credential],
      cto_triggered: True,
      community_wallet_hash: #"ee",
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  // The escrow keeps a continuing output, and its datum has to record when
  // the position moved — that record is what the cooldown is measured from.
  let migrated_datum =
    LpEscrowDatum {
      ..datum,
      lp_token_policy_id: mock_new_lp_policy,
      lp_token_name: mock_new_lp_name,
      lp_token_amount: mock_new_lp_amount,
      last_migration_timestamp: 1000 + min_lock_duration }
  let thread_continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft_with_new_lp(),
      datum: InlineDatum(migrated_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output, thread_continuing_output],
      // community wallet signs, not governor
      extra_signatories: [#"ee"],
      validity_range: interval.between(1000 + min_lock_duration, 1000 + min_lock_duration + 100),
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: mock_new_lp_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: 1000 + min_lock_duration,
    }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test cancel_launch_succeeds_on_never_sealed_position() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = LpEscrowDatum { ..datum, lp_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
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

  lp_escrow.spend(Some(datum), CancelLaunch, own_ref, self)
}

test cancel_launch_rejects_already_sealed_position() {
  let datum = mock_datum(Locked, 500)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(15_000_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = LpEscrowDatum { ..datum, lp_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(15_000_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
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

  !lp_escrow.spend(Some(datum), CancelLaunch, own_ref, self)
}

// DEX-whitelist-change tests — mock_datum's multisig is [#"aa", #"bb", #"cc"], threshold 2.

test propose_dex_change_succeeds_with_threshold_signatures() {
  let datum = mock_datum(Locked, 0)
  let target_dex = from_script(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 1000,
        },
      ),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // 2-of-3: aa and bb sign, cc doesn't
      extra_signatories: [#"aa", #"bb"],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ProposeDexChange {
      dex_credential: target_dex.payment_credential,
      action: ProposeAdd,
      timestamp: 1000,
    }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test propose_dex_change_rejects_wide_validity_range() {
  let datum = mock_datum(Locked, 0)
  let target_dex = from_script(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 1000,
        },
      ),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"aa", #"bb"],
      // Wide enough to let the multisig claim any proposed_at within it,
      // regardless of when the transaction actually lands.
      validity_range: interval.between(0, 900_000),
    }
  let redeemer =
    ProposeDexChange {
      dex_credential: target_dex.payment_credential,
      action: ProposeAdd,
      timestamp: 1000,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test propose_dex_change_rejects_below_multisig_threshold() {
  let datum = mock_datum(Locked, 0)
  let target_dex = from_script(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 1000,
        },
      ),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // only 1-of-3 signs — below the threshold of 2
      extra_signatories: [#"aa"],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ProposeDexChange {
      dex_credential: target_dex.payment_credential,
      action: ProposeAdd,
      timestamp: 1000,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test propose_dex_change_rejects_when_a_change_is_already_pending() {
  let target_dex = from_script(#"aa")
  let other_dex = from_script(#"bb")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: other_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 500,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 1000,
        },
      ),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"aa", #"bb"],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ProposeDexChange {
      dex_credential: target_dex.payment_credential,
      action: ProposeAdd,
      timestamp: 1000,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test execute_dex_change_succeeds_after_notice_period() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  // Real, non-zero locked value (15,000 ADA + 150M LP tokens) —
  // proves the new lp_value_unchanged check doesn't reject a genuine,
  // value-preserving whitelist-change execution.
  let locked_value =
    assets.merge(assets.from_lovelace(15_000_000_000), assets.from_asset(#"33", "lp", 150_000_000))
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), locked_value),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      dex_whitelist: [target_dex.payment_credential],
      pending_dex_change: None,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), locked_value),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // no signatures at all — execution is permissionless once due
      validity_range: interval.between(
        dex_change_notice_period - 100,
        dex_change_notice_period + 100,
      ),
    }
  let redeemer = ExecuteDexChange { current_timestamp: dex_change_notice_period }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

// Regression test: the value-conservation case verified against the full
// security audit — ExecuteDexChange is permissionless, and previously
// only checked the continuing output's DATUM, never its value. This
// proves a transaction with the CORRECT new datum but a continuing output
// stripped down to a token min-UTXO (the real 15,000 ADA + 150M LP tokens
// diverted away from the script instead) is rejected.
test execute_dex_change_rejects_value_drain_attempt() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(15_000_000_000),
          assets.from_asset(#"33", "lp", 150_000_000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      dex_whitelist: [target_dex.payment_credential],
      pending_dex_change: None,
    }
  // Correct new datum, but a nearly-empty continuing output — the real
  // locked value goes to the attacker instead.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_lovelace(1_500_000)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(13_498_500_000),
        assets.from_asset(#"33", "lp", 150_000_000),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, drain_output],
      validity_range: interval.between(
        dex_change_notice_period - 100,
        dex_change_notice_period + 100,
      ),
    }
  let redeemer = ExecuteDexChange { current_timestamp: dex_change_notice_period }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

// Identical to execute_dex_change_succeeds_after_notice_period except
// the declared validity range is far wider than max_validity_range_width
// — before this fix, ANY caller (this redeemer is permissionless once a
// change is pending) could execute a DEX whitelist change immediately
// after ProposeDexChange by declaring a wide range and claiming a
// far-future current_timestamp, bypassing the real 72-hour public notice
// period entirely.
test execute_dex_change_rejects_wide_validity_range() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      dex_whitelist: [target_dex.payment_credential],
      pending_dex_change: None,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // Real proposal was at 0; a real, honest ExecuteDexChange tx would
      // declare a narrow range near the real notice-period boundary. This
      // one instead spans all the way from 0, comfortably exceeding
      // max_validity_range_width.
      validity_range: interval.between(0, dex_change_notice_period + 100),
    }
  let redeemer = ExecuteDexChange { current_timestamp: dex_change_notice_period }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test execute_dex_change_rejects_before_notice_period_elapsed() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      dex_whitelist: [target_dex.payment_credential],
      pending_dex_change: None,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let too_early = dex_change_notice_period - 1
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(too_early - 100, too_early + 100),
    }
  let redeemer = ExecuteDexChange { current_timestamp: too_early }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

// `expect Some(pending) = None` traps rather than returning false, so this
// is a genuine runtime abort, not a negatable Bool — marked `fail` per
// Aiken's expected-panic test convention instead of wrapping in `!`.
test execute_dex_change_rejects_with_no_pending_change() fail {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(
        dex_change_notice_period - 100,
        dex_change_notice_period + 100,
      ),
    }
  let redeemer = ExecuteDexChange { current_timestamp: dex_change_notice_period }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test cancel_pending_dex_change_succeeds_with_multisig() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = LpEscrowDatum { ..datum, pending_dex_change: None }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"bb", #"cc"],
    }

  lp_escrow.spend(Some(datum), CancelPendingDexChange, own_ref, self)
}

test cancel_pending_dex_change_rejects_below_multisig_threshold() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = LpEscrowDatum { ..datum, pending_dex_change: None }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"bb"],
    }

  !lp_escrow.spend(Some(datum), CancelPendingDexChange, own_ref, self)
}

// HarvestFees tests — mock_datum's fee_recipient_pub_key_hash is #"dd".

test harvest_fees_succeeds_paying_the_creator_when_no_cto() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Datum is completely unchanged — the LP position itself is never touched.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
      // The recipient signs: a harvest is for them, and requiring it is what
      // stops anyone else churning this UTXO for the price of a fee.
      extra_signatories: [mock_datum(Locked, 0).fee_recipient_pub_key_hash],
    }

  lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_rejects_padded_output() {
  // Identical to harvest_fees_succeeds_paying_the_creator_when_no_cto,
  // except the LP position's own continuing output carries one extra,
  // unrelated junk asset (the LP token quantity itself is still exactly
  // preserved — lp_position_untouched alone wouldn't catch this). Also
  // permissionless — the same padding risk as SealLock applies here too.
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_pays_the_community_wallet_once_cto_triggered() {
  let datum = LpEscrowDatum { ..mock_datum(Locked, 0), cto_triggered: True, community_wallet_hash: #"ee" }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let community_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: community_address,
      value: assets.from_lovelace(50_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
      // Post-CTO the recipient IS the community wallet, so that is the
      // signature a harvest now needs.
      extra_signatories: [#"ee"],
    }

  lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_rejects_payout_to_the_creator_once_cto_triggered() {
  // Same scenario as the success case, but the payout still targets the
  // ORIGINAL creator (fee_recipient_pub_key_hash, #"dd") instead of the
  // community wallet — proves the redirect is actually enforced, not just
  // documented.
  let datum = LpEscrowDatum { ..mock_datum(Locked, 0), cto_triggered: True, community_wallet_hash: #"ee" }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: creator_address,
      value: assets.from_lovelace(50_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_rejects_if_the_locked_lp_position_shrinks() {
  // The fee recipient IS correctly paid, but the LP's own locked token
  // quantity drops from 1000 to 900 in the same transaction — proves
  // HarvestFees cannot be used as a backdoor withdraw() on the locked LP.
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 900),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_rejects_before_lp_is_locked() {
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

// QueryState previously authorized ANY spend unconditionally
// (`QueryState -> True`, zero checks) — an unconditional authorization
// of the locked LP position. Proves the fix.
test query_state_rejects_unauthenticated_drain_attempt() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(15_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(15_000_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !lp_escrow.spend(Some(datum), QueryState, own_ref, self)
}

// Regression test: the value-conservation case verified against the full
// security audit — lp_position_untouched previously checked ONLY the LP
// TOKEN quantity, never lovelace. This proves a HarvestFees call that
// declares a trivial harvested_amount, keeps the LP token count exactly
// unchanged, but strips the escrow's real lovelace balance down to near
// nothing (the rest diverted away from the script) is rejected.
test harvest_fees_rejects_real_lovelace_drain_attempt() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(15_000_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // LP token count exactly preserved (satisfies the old, still-present
  // lp_position_untouched check) — but almost all the real lovelace is
  // gone.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(assets.from_lovelace(1_500_000), assets.from_asset(#"33", "lp", 1000))),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(1),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(14_998_500_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout, drain_output],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 1 }, own_ref, self)
}

// Fix regression test: Migrate previously only verified the LP TOKEN
// lands at the target DEX — the real locked ADA was never checked. This
// proves a migration that correctly delivers the LP tokens but diverts
// the real locked ADA elsewhere is now rejected.
test migrate_rejects_ada_diversion() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum { ..mock_datum(Locked, 0), dex_whitelist: [target_dex.payment_credential] }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(15_000_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Full LP token quantity correctly lands at the target DEX, but only a
  // token amount of ADA — the rest diverted to the attacker.
  let dex_output =
    Output {
      address: target_dex,
      value: assets.merge(assets.from_lovelace(1_500_000), assets.from_asset(#"33", "lp", 1000)),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(14_998_500_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [dex_output, drain_output],
      extra_signatories: [#"22"],
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: mock_new_lp_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: min_lock_duration,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

// A literal, not `min_lock_duration`. 31_536_000 is a year counted in seconds
// and about nine hours counted in the milliseconds this contract actually uses,
// so it must not clear the floor. Written as a literal on purpose: a boundary
// expressed in terms of the constant moves with the constant, and so could
// never notice the constant itself being wrong.
test seal_lock_rejects_a_year_expressed_in_seconds() {
  // SealLock is permissionless now — no extra_signatories at all —
  // verified instead by the continuing output actually holding the seeded
  // ADA and the exact lp_token_amount (1000, per mock_datum).
  let datum =
    LpEscrowDatum { ..mock_datum(Cancelled, 0), lock_duration: 31_536_000 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

// lock_timestamp is 0 until SealLock runs, and 0 plus any duration is already
// in the past — so without an explicit check a position that was never sealed
// reads as one whose lock expired long ago.
test migrate_rejects_a_position_that_was_never_sealed() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      dex_whitelist: [target_dex.payment_credential],
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  // The escrow keeps a continuing output, and its datum has to record when
  // the position moved — that record is what the cooldown is measured from.
  let migrated_datum =
    LpEscrowDatum {
      ..datum,
      lp_token_policy_id: mock_new_lp_policy,
      lp_token_name: mock_new_lp_name,
      lp_token_amount: mock_new_lp_amount,
      last_migration_timestamp: 1000 + min_lock_duration }
  let thread_continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft_with_new_lp(),
      datum: InlineDatum(migrated_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output, thread_continuing_output],
      extra_signatories: [#"22"],
      validity_range: interval.between(1000 + min_lock_duration, 1000 + min_lock_duration + 100),
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: mock_new_lp_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: 1000 + min_lock_duration,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}


// A position that moved a moment ago cannot move again. The cooldown is 90
// days; this one last migrated on the very block the lock expired, and tries
// again immediately.
test migrate_rejects_a_second_move_inside_the_cooldown() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 1000),
      last_migration_timestamp: 1000 + min_lock_duration - 1,
      dex_whitelist: [target_dex.payment_credential],
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_thread_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  // The escrow keeps a continuing output, and its datum has to record when
  // the position moved — that record is what the cooldown is measured from.
  let migrated_datum =
    LpEscrowDatum {
      ..datum,
      lp_token_policy_id: mock_new_lp_policy,
      lp_token_name: mock_new_lp_name,
      lp_token_amount: mock_new_lp_amount,
      last_migration_timestamp: 1000 + min_lock_duration }
  let thread_continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft_with_new_lp(),
      datum: InlineDatum(migrated_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output, thread_continuing_output],
      extra_signatories: [#"22"],
      validity_range: interval.between(1000 + min_lock_duration, 1000 + min_lock_duration + 100),
    }
  let redeemer =
    Migrate {
      new_lp_policy_id: mock_new_lp_policy,
      new_lp_name: mock_new_lp_name,
      new_lp_amount: mock_new_lp_amount,
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: 1000 + min_lock_duration,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

/// The creator's LP trading fees, paid to the kind of address a wallet
/// actually issues.
///
/// `from_verification_key` builds an ENTERPRISE address. Real wallets hand out
/// BASE addresses, which carry a staking part as well, so a check on the whole
/// address asked for a destination almost nobody has — and this is the path
/// Stream B fees reach the creator by. Identical in every respect to the
/// passing harvest above except that the recipient delegates their stake.
test harvest_fees_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_base_address =
    from_verification_key(#"dd") |> with_delegation_key(#"aa")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_base_address,
      value: assets.from_lovelace(50_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
      extra_signatories: [datum.fee_recipient_pub_key_hash],
    }

  lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}


/// Anyone could rebuild this UTXO at a new reference for the price of a fee.
///
/// The continuing output is identical to the input, so a harvest changes
/// nothing except where the escrow lives — which is enough to invalidate
/// anything being built against it, and this UTXO is read as a REFERENCE
/// INPUT by the CTO anchor. A harvest is for the recipient alone, so their
/// signature costs nobody anything and removes the churn.
test harvest_fees_rejects_a_stranger_churning_the_escrow() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(datum.fee_recipient_pub_key_hash)
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
      // Somebody else entirely.
      extra_signatories: [#"ba"],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

/// The recipient signs a harvest now, which means the transaction can carry
/// their own utxos — and an output at their credential holding the harvest is
/// then equally consistent with their change coming back while the real fee
/// goes elsewhere. Closing the churn without this would have opened that.
test harvest_fees_rejects_paying_the_recipient_with_their_own_ada() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(datum.fee_recipient_pub_key_hash)
  let attacker_address = from_verification_key(#"ba")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // The recipient's own ada, spent in this same transaction.
  let recipient_input =
    Input {
      output_reference: OutputReference { transaction_id: #"77", output_index: 0 },
      output: Output {
        address: recipient_address,
        value: assets.from_lovelace(2_000_000),
        datum: transaction.NoDatum,
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      )),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  // Their own ada handed straight back, tagged as though it were the harvest.
  let recipient_change =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(1_950_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  // The real harvested fee, going somewhere else.
  let attacker_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(50_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input, recipient_input],
      outputs: [continuing_output, recipient_change, attacker_output],
      extra_signatories: [datum.fee_recipient_pub_key_hash],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}
