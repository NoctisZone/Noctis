// ============================================================================
// Noctis Zone — Cardano L1 Vesting Contract (Aiken)
// The linear curve only
// ============================================================================
// The linear curve's counterpart to contracts/midnight/vesting.compact (both launch types).
// Controls the release schedule of the creator's TOKEN allocation (5-10% of
// total supply) — separate from bonding_curve.ak's fee-claim circuits
// (ClaimCreatorFees), which handles the
// creator's ADA trade-fee income. CLAUDE.md is explicit that these are two
// distinct income streams and must never be conflated ("Two income streams
// for creators are distinct... never show them as one number") — this
// didn't exist as the linear curve contract at all until now; the linear curve had no vesting
// mechanism anywhere in the codebase.
//
// Vesting rules (CLAUDE.md):
//   - Creator chooses 90-365 days at launch wizard. No default — forced
//     active selection.
//   - No tokens release before graduation, regardless of elapsed time —
//     vesting only starts once StartVesting is called (governor, at
//     graduation).
//   - Linear daily release: claimable = token_allocation * elapsedSeconds /
//     vestSeconds. Unlike vesting.compact (which has to cross-multiply to
//     avoid division in a ZK circuit), Aiken/Plutus has no such
//     restriction, so this uses plain integer division.
//
// CTO (Community Takeover Opportunity):
//   If a SilenceLockTrigger proposal passes via cto_governance.ak, unvested
//   creator tokens are frozen and redirected to a community treasury — NOT
//   burned (CLAUDE.md's "What a Passed Vote Does" #3). Already-claimed
//   tokens are unaffected.
//
//   Phase B fix (2026-07-19): "redirected to a community treasury" had no
//   real claim path once frozen — TriggerCTO only ever set
//   community_treasury_wallet on the datum; nothing else in this file ever
//   referenced it. The frozen balance was stuck in this contract forever
//   with zero way out, contradicting the "NOT burned" promise above (stuck
//   forever is functionally indistinguishable from burned, from the
//   community's point of view). Per the agreed design (community votes to
//   direct SPECIFIC amounts to SPECIFIC recipients via FundAllocation
//   proposals, rather than one signer being able to move the whole frozen
//   balance at once), ClaimCommunityAllocation below releases exactly the
//   amount a real, passed+executed FundAllocation proposal authorizes, to
//   exactly the recipient it names — same reference-input evidence pattern
//   as TriggerCTO/DissolveCTO, and same value-conservation discipline as
//   ClaimVested (vesting_tokens_retained, reused directly since it's
//   already amount-generic). Replay protection against claiming the SAME
//   anchored proposal twice uses executed.anchor_timestamp as a
//   monotonically-increasing watermark (last_claimed_allocation_timestamp)
//   — every real proposal has a distinct anchor_timestamp (real chain
//   time), so requiring strictly-increasing values means each real
//   proposal can only ever fund one payout.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Credential, from_verification_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use noctis/settlement
use noctis/thread_nft
use cto_governance.{
  CtoGovernanceDatum, DissolveCTOProposal, Executed, FundAllocation, Passed,
  PreCTO, ProposalAnchor, ProposalType, SilenceLockTrigger,
}

/// Fix (2026-07-19, full-suite security audit): CRITICAL finding —
/// this file previously had ZERO usages of validity_range/interval
/// anywhere (confirmed via direct grep before this fix). Every timestamp
/// (`start_timestamp`, `current_timestamp`) was a completely free,
/// unverified redeemer field, unlike `ActivateCurve`/`ExpireCurve`
/// elsewhere in this codebase, which correctly bind theirs to the
/// transaction's real validity range. Concretely: nothing stopped the
/// creator (required signer on ClaimVested) from claiming
/// `current_timestamp = vest_start_timestamp + vest_days*86400*1000`
/// immediately after StartVesting, instantly unlocking 100% of their
/// allocation and completely defeating the linear-vesting anti-dump
/// guarantee this contract exists for.
fn validity_range_is_narrow(range: Interval, max_width: Int) -> Bool {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      hi >= lo && hi - lo <= max_width
    _ -> False
  }
}

/// 10 minutes in milliseconds — same width bound as every other
/// timestamp-sensitive redeemer in this codebase (bonding_curve.ak,
/// lp_escrow.ak, cto_governance.ak). Applied to ClaimVested specifically
/// (not StartVesting, which is governor-signed and trusted the same way
/// ActivateCurve already is) because the CREATOR has a real incentive to
/// pick a self-serving timestamp within an otherwise-wide declared range;
/// narrowing the range narrows how much "wiggle room" that choice has.
const max_validity_range_width = 600_000

// ============================================================================
// TYPES
// ============================================================================

pub type VestingState {
  NotStarted
  Vesting
  FullyClaimed
  CTOFrozen
  Cancelled
}

pub type VestingDatum {
  launch_id: ByteArray,
  creator_pub_key_hash: VerificationKeyHash,
  governor_pub_key_hash: VerificationKeyHash,
  // Fixed at deploy — never changes (unlike a fee accumulator)
  token_allocation: Int,
  vest_days: Int,
  // 90-365, forced active selection, no default
  vesting_state: VestingState,
  claimed_tokens: Int,
  vest_start_timestamp: Int,
  cto_triggered: Bool,
  community_treasury_wallet: VerificationKeyHash,
  // Token identity (the launch's native asset, locked in this UTxO)
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  // Fix: cto_governance.ak's own fixed script address, set
  // at genesis — same pattern as bonding_curve.ak's own
  // cto_governance_credential field; see that file's doc comment for the
  // full reasoning. Needed because TriggerCTO/DissolveCTO below now
  // require real reference-input evidence a vote actually passed, instead
  // of trusting a bare governor signature.
  cto_governance_credential: Credential,
  // Fix (2026-07-23 audit): governance THREAD NFT policy id — see the
  // full doc comment on bonding_curve.ak. cto_vote_verified now requires
  // the referenced governance UTXO to carry this NFT (asset_name =
  // launch_id). This is the worst-affected validator: ClaimCommunityAllocation
  // reads allocation_amount + allocation_recipient_hash straight out of that
  // referenced datum and delivers tokens accordingly, so an unhardened
  // forge let an attacker mint themselves an arbitrary community-allocation
  // payout. ClaimCommunityAllocation reads the governance ref DIRECTLY (not
  // via cto_vote_verified), so it enforces the same NFT quantity check inline.
  thread_nft_policy: PolicyId,
  // Phase B fix: replay guard for ClaimCommunityAllocation — the
  // anchor_timestamp of the last FundAllocation proposal already paid out.
  // Starts at 0 at genesis (no real proposal can ever anchor at timestamp
  // 0). A new claim must present a proposal with a strictly greater
  // anchor_timestamp, so the same passed proposal can't fund two payouts.
  last_claimed_allocation_timestamp: Int,
}

pub type VestingRedeemer {
  /// Governor starts vesting — called at graduation. No tokens release
  /// before this regardless of elapsed wall-clock time.
  StartVesting { start_timestamp: Int }
  /// Creator claims vested tokens
  ClaimVested { claim_amount: Int, current_timestamp: Int }
  /// Governor triggers CTO — freezes unvested tokens, redirects to
  /// community treasury
  TriggerCTO { community_treasury_wallet: VerificationKeyHash }
  /// Governor dissolves CTO — creator returned, resumes vesting
  DissolveCTO
  /// Phase B fix: permissionless — releases exactly the amount a real,
  /// passed+executed FundAllocation proposal authorizes, to exactly the
  /// recipient it names. Amount and recipient are both derived from the
  /// anchored proposal, never a free redeemer parameter — same reasoning
  /// as cto_vote_verified's expected_recipient check.
  ClaimCommunityAllocation
  /// Cancel launch (bonding curve expired without graduation).
  /// Fix: now only reachable from NotStarted — see the redeemer's
  /// own match-arm comment for why (a launch that already began vesting
  /// already graduated, so the "expired without graduation"
  /// rationale no longer applies to it).
  CancelLaunch
  /// Fix: the creator's own never-vested allocation had no recovery
  /// path once Cancelled — a single governor signature previously froze
  /// it permanently with zero way out for anyone, including the creator
  /// themselves. Since CancelLaunch (above) is now only reachable from
  /// NotStarted, claimed_tokens is always 0 here — nothing was ever
  /// vested or claimed, so returning the full token_allocation to the
  /// creator is safe: it's their own carved-out allocation, never
  /// distributed to or earned by anyone else.
  ClaimCancelledAllocation
  /// Read-only query, no state change, no authorization required
  QueryState
}

// ============================================================================
// HELPERS
// ============================================================================

/// The vesting UTXO's whole value, byte for byte, carried into the continuing
/// output.
///
/// For the redeemers that only advance state. Pinning the continuing DATUM
/// says nothing about the continuing VALUE, so a state transition without this
/// is also a withdrawal of the creator's whole unvested allocation while still
/// writing a datum the validator accepts. `thread_nft_intact` runs earlier in
/// the same short-circuiting `and`, so a continuing output is guaranteed to
/// exist by the time any branch evaluates.
fn vesting_value_unchanged(self: Transaction, own_ref: OutputReference) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  own_output.value == own_input.output.value
}

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> VestingDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: VestingDatum = raw_datum
  new_datum
}

/// Fix (2026-07-19, full-suite security audit) — same fix, same
/// reasoning, as bonding_curve.ak: closes a double-satisfaction risk,
/// since every launch's vesting position shares this one fixed,
/// unparameterized script address. See that file's own comment on this
/// exact helper for the full explanation.
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

/// Fix: real evidence a vote actually passed, replacing a
/// bare governor signature — same mechanism and reasoning as
/// bonding_curve.ak's own cto_vote_verified (see that file's doc comment
/// for the full explanation, including why last_executed_proposal rather
/// than the clearable active_proposal, and why expected_recipient is
/// `None` for DissolveCTOProposal).
fn cto_vote_verified(
  self: Transaction,
  datum: VestingDatum,
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

/// Verify the creator receives claim_amount of the launch token in some output
fn tokens_delivered(
  self: Transaction,
  own_ref: OutputReference,
  datum: VestingDatum,
  claim_amount: Int,
) -> Bool {
  list.any(
    self.outputs,
    fn(output: Output) {
      and {
        // The delivery output NAMES this vesting input as the obligation it
        // discharges. See noctis/settlement: without the tag this asks only
        // whether SOME output in the transaction holds claim_amount, which a
        // payout owed by an entirely different contract answers just as well
        // — one payment, two obligations discharged, the difference free.
        settlement.settles(output, own_ref),
        assets.quantity_of(output.value, datum.token_policy_id, datum.token_asset_name) == claim_amount,
      }
    },
  )
}

/// Phase B fix: unlike tokens_delivered (which only checks SOME output
/// carries the right amount — safe for ClaimVested only because the
/// creator's own signature is separately required there, so the creator
/// implicitly controls where their own payment goes), ClaimCommunityAllocation
/// is permissionless with no signature at all. Without pinning the
/// recipient too, any relayer submitting the transaction could redirect the
/// payout to themselves instead of the address the real vote named. Checks
/// the SPECIFIC recipient address the anchored proposal authorized.
fn community_allocation_delivered(
  self: Transaction,
  own_ref: OutputReference,
  datum: VestingDatum,
  amount: Int,
  recipient: VerificationKeyHash,
) -> Bool {
  let recipient_address = from_verification_key(recipient)
  list.any(
    self.outputs,
    fn(output: Output) {
      and {
        settlement.settles(output, own_ref),
        output.address == recipient_address,
        assets.quantity_of(output.value, datum.token_policy_id, datum.token_asset_name) == amount,
      }
    },
  )
}

/// Fix (2026-07-18): the ORIGINAL ClaimVested check only verified the
/// continuing output's DATUM (via own_continuing_datum) and that SOME
/// output delivered claim_amount (tokens_delivered) — nothing verified the
/// continuing output at vesting's own address actually RETAINED the
/// still-locked balance. Even with the creator-signature fix above, the
/// creator themselves could otherwise pay the correctly-updated datum to a
/// near-empty continuing output while draining the ENTIRE remaining
/// unvested balance to themselves in the same transaction — defeating the
/// whole point of a linear vesting schedule (a core anti-rug feature per
/// CLAUDE.md). Mirrors bonding_curve.ak's graduation_funds_left_curve
/// exactly: continuing output's token quantity must equal the input's
/// minus exactly claim_amount, a real relative decrease, not a claim.
fn vesting_tokens_retained(
  self: Transaction,
  own_ref: OutputReference,
  datum: VestingDatum,
  claim_amount: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.quantity_of(
    own_input.output.value,
    datum.token_policy_id,
    datum.token_asset_name,
  ) == assets.quantity_of(
    own_output.value,
    datum.token_policy_id,
    datum.token_asset_name,
  ) + claim_amount
}


/// State authentication (2026-08-03 audit) — the launch's own thread NFT must be present on the UTXO being
/// spent AND on the continuing output. See noctis/thread_nft, and the linear curve's
/// bonding_curve.ak thread_nft_intact, for the full reasoning: every
/// validator here is unparameterized, so all launches share one address and
/// a UTXO's legitimacy would otherwise rest on a datum anyone can author.
fn thread_nft_intact(
  self: Transaction,
  own_ref: OutputReference,
  datum: VestingDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  let name =
    thread_nft.thread_asset_name(thread_nft.role_vesting, datum.launch_id)
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

validator vesting {
  spend(
    datum_opt: Option<VestingDatum>,
    redeemer: VestingRedeemer,
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
        StartVesting { start_timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.vesting_state == NotStarted,
          // `start_timestamp` is the origin the entire release schedule is
          // measured from, so it is bound to real chain time the same way
          // bonding_curve.ak's ActivateCurve binds `phase_started_at`: the
          // declared value must sit inside the transaction's validity range,
          // AND that range must be narrow. Containment on its own is not the
          // binding it looks like — a range wide enough to hold both real
          // chain time and a distant `start_timestamp` satisfies it — so the
          // width bound is the half that makes the declared value mean now.
          //
          // A test that wants a schedule already part-elapsed sets
          // `vest_start_timestamp` in the datum it starts from rather than
          // declaring a start time the chain would not agree with.
          interval.contains(self.validity_range, start_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          new_datum == VestingDatum {
            ..datum,
            vesting_state: Vesting,
            vest_start_timestamp: start_timestamp,
          },
        }
      }

      ClaimVested { claim_amount, current_timestamp } -> {
        // Both sides in MILLISECONDS. `current_timestamp` is bound through
        // `interval.contains(self.validity_range, ...)`, so the elapsed term
        // arrives on Cardano's ms scale; the divisor has to match it or the
        // schedule runs fast by a factor of a thousand. The formula in this
        // file's own header comment — vest_days*86400*1000 — was already
        // right.
        let elapsed_ms = current_timestamp - datum.vest_start_timestamp
        let vest_ms = datum.vest_days * 86_400_000
        // Plain division is fine on Cardano — no ZK-circuit restriction.
        let vested_to_date =
          datum.token_allocation * elapsed_ms / vest_ms
        let new_total_claimed = datum.claimed_tokens + claim_amount
        let next_state = if new_total_claimed == datum.token_allocation {
          FullyClaimed
        } else {
          datum.vesting_state
        }
        let new_datum =
          VestingDatum {
            ..datum,
            claimed_tokens: new_total_claimed,
            vesting_state: next_state,
          }
        let continuing_datum = own_continuing_datum(self, own_ref)

        and {
          // Fix (2026-07-18): this redeemer had NO identity check of any
          // kind, and tokens_delivered only verifies SOME output holds
          // claim_amount of the token — not whose output. Since the vested
          // amount is fully derivable from public on-chain data
          // (vest_start_timestamp/vest_days/token_allocation), any third
          // party could previously construct a valid ClaimVested transaction
          // redirecting the creator's own vested tokens to their own
          // wallet — a real fund-theft vector, not just griefing. Fixed by
          // requiring the creator's real signature, the same pattern
          // bonding_curve.ak's ClaimCreatorFees already uses (list.has(
          // self.extra_signatories, ...)) — once only the creator can
          // authorize the claim, self-direction to their own address is
          // implicit, same trust model as every other claim-style redeemer
          // in this codebase.
          list.has(self.extra_signatories, datum.creator_pub_key_hash),
          datum.vesting_state == Vesting,
          !datum.cto_triggered,
          claim_amount > 0,
          new_total_claimed <= datum.token_allocation,
          new_total_claimed <= vested_to_date,
          // CRITICAL fix: current_timestamp was previously a
          // completely free redeemer field feeding directly into
          // vested_to_date's math — the creator (a required signer with a
          // real incentive to claim early) could forge a far-future value
          // and instantly unlock 100% of their allocation. Both checks
          // together close this: interval.contains ties the claim to real
          // chain time, and the narrow width bound (unlike StartVesting's
          // trusted-governor exemption) limits how much self-serving
          // "wiggle room" the creator gets within an otherwise-honest
          // declared range.
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          continuing_datum == new_datum,
          tokens_delivered(self, own_ref, datum, claim_amount),
          vesting_tokens_retained(self, own_ref, datum, claim_amount),
        }
      }

      TriggerCTO { community_treasury_wallet } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Enforcement: permissionless, gated on real anchored vote
          // evidence instead of a bare governor signature.
          cto_vote_verified(
            self,
            datum,
            SilenceLockTrigger,
            Some(community_treasury_wallet),
          ),
          !datum.cto_triggered,
          // Fix: was `!= FullyClaimed`, which is satisfiable from
          // NotStarted — the genesis state, before StartVesting has ever
          // run. A real CTO vote should only ever be able to freeze a
          // launch that has actually graduated and begun vesting (a
          // legitimate SilenceLockTrigger proposal requires 30+ days
          // post-graduation per CLAUDE.md, so a real one anchoring while
          // still NotStarted shouldn't be reachable from the Midnight side
          // either — this is defense-in-depth on the Cardano side). This
          // also closes a real gap: DissolveCTO never resets
          // vest_start_timestamp (it doesn't need to — it only ever ran
          // after a legitimate Vesting-state freeze before this fix), so
          // TriggerCTO from NotStarted -> DissolveCTO -> ClaimVested would
          // have computed elapsed time from a genesis-placeholder
          // timestamp, instantly unlocking the full allocation. Requiring
          // Vesting here means vest_start_timestamp is always already a
          // real value by the time TriggerCTO can ever fire.
          datum.vesting_state == Vesting,
          new_datum == VestingDatum {
            ..datum,
            cto_triggered: True,
            community_treasury_wallet: community_treasury_wallet,
            vesting_state: CTOFrozen,
          },
          // Freezing the schedule redirects who may later claim; it moves
          // nothing now, so the whole unvested allocation stays put.
          vesting_value_unchanged(self, own_ref),
        }
      }

      DissolveCTO -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Enforcement: same reasoning, gated on a real anchored
          // DissolveCTOProposal instead of a bare governor signature.
          cto_vote_verified(self, datum, DissolveCTOProposal, None),
          datum.cto_triggered,
          new_datum == VestingDatum {
            ..datum,
            cto_triggered: False,
            vesting_state: Vesting,
          },
          vesting_value_unchanged(self, own_ref),
        }
      }

      ClaimCommunityAllocation -> {
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

        let new_datum = own_continuing_datum(self, own_ref)
        let amount = executed.allocation_amount
        let recipient = executed.allocation_recipient_hash

        and {
          // Fix (2026-07-23 audit): this redeemer reads the referenced
          // governance datum DIRECTLY (not via cto_vote_verified), so it
          // needs the same NFT guard inline. `amount` and `recipient` above
          // come straight out of that datum and are paid out as real tokens
          // below — without this check, a UTXO planted at
          // cto_governance_credential with a forged
          // governance datum claiming an executed allocation
          // datum would drain the vesting reserve. The genuine per-launch
          // governance thread NFT (policy = thread_nft_policy, asset_name =
          // launch_id) can only ever sit in the real governance UTXO.
          assets.quantity_of(cto_ref_input.output.value, datum.thread_nft_policy, datum.launch_id) == 1,
          cto_datum.launch_id == datum.launch_id,
          executed.proposal_type == FundAllocation,
          executed.outcome == Passed,
          executed.execution_status == Executed,
          // Replay guard: this exact proposal (or any earlier one) can't
          // fund a second payout — see the datum field's own doc comment.
          executed.anchor_timestamp > datum.last_claimed_allocation_timestamp,
          datum.cto_triggered,
          datum.vesting_state == CTOFrozen,
          amount > 0,
          community_allocation_delivered(
            self,
            own_ref,
            datum, amount, recipient),
          vesting_tokens_retained(self, own_ref, datum, amount),
          new_datum == VestingDatum {
            ..datum,
            last_claimed_allocation_timestamp: executed.anchor_timestamp,
          },
        }
      }

      CancelLaunch -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          // Fix: was `!= Cancelled` (reachable from Vesting/
          // CTOFrozen/FullyClaimed too). This redeemer's own stated
          // purpose is "bonding curve expired without graduation."
          // A launch that already reached Vesting already graduated, so
          // that rationale no longer applies; cancelling a genuinely
          // in-progress or completed vesting schedule is a materially
          // different, unresolved question this fix deliberately does not
          // attempt to answer unilaterally (what should happen to a
          // partially-vested creator's REMAINING allocation is a real
          // product decision, not a mechanical bug fix). Restricting to
          // NotStarted keeps this redeemer inside the one case with a
          // clear, safe answer: nothing was ever vested, so there is
          // nothing ambiguous about giving the creator their own
          // never-distributed tokens back (see ClaimCancelledAllocation).
          datum.vesting_state == NotStarted,
          new_datum == VestingDatum { ..datum, vesting_state: Cancelled },
          // The allocation stays here for ClaimCancelledAllocation to
          // return to the creator — cancelling must not be a withdrawal.
          vesting_value_unchanged(self, own_ref),
        }
      }

      // Fix: real recovery path for a NotStarted launch's Cancelled
      // allocation — see this redeemer's own doc comment in
      // VestingRedeemer above.
      ClaimCancelledAllocation -> {
        and {
          list.has(self.extra_signatories, datum.creator_pub_key_hash),
          datum.vesting_state == Cancelled,
          // Sanity, not load-bearing given CancelLaunch's own NotStarted
          // restriction above — but cheap defense-in-depth against any
          // future change to that guard silently reopening this path with
          // real claimed_tokens outstanding.
          datum.claimed_tokens == 0,
          tokens_delivered(self, own_ref, datum, datum.token_allocation),
        }
      }

      // CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks),
      // an unconditional authorization over the creator's locked vesting
      // allocation. See that file's own comment on this exact line for the
      // full explanation.
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
fn mock_thread_nft() -> assets.Value {
  assets.from_asset(
    #"c0ffee",
    thread_nft.thread_asset_name(thread_nft.role_vesting, #"01"),
    1,
  )
}


fn mock_datum(vesting_state: VestingState, vest_start: Int) -> VestingDatum {
  VestingDatum {
    launch_id: #"01",
    creator_pub_key_hash: #"11",
    governor_pub_key_hash: #"22",
    token_allocation: 100_000_000,
    vest_days: 90,
    vesting_state: vesting_state,
    claimed_tokens: 0,
    vest_start_timestamp: vest_start,
    cto_triggered: False,
    community_treasury_wallet: #"",
    token_policy_id: #"33",
    token_asset_name: "tok",
    cto_governance_credential: from_verification_key(#"aa").payment_credential,
    last_claimed_allocation_timestamp: 0,
    thread_nft_policy: #"c0ffee",
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
    // Fix: must match both the vesting datum's thread_nft_policy and the
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
      // (policy = the vesting datum's thread_nft_policy `#"c0ffee"`,
      // asset_name = launch_id); cto_vote_verified / ClaimCommunityAllocation
      // now require it.
      value: assets.from_asset(#"c0ffee", cto_datum.launch_id, 1),
      datum: InlineDatum(cto_datum),
      reference_script: None,
    },
  }
}

// `start_vesting_succeeds_with_governor_signature` with the declared start
// moved a year into the past and the validity range widened to keep containing
// it — the governor's own signature is still present, so this is the trusted
// signer asking for it. The range still contains real chain time, so the
// ledger would carry the transaction and containment is satisfied; the width
// bound is what refuses it. That keeps the release schedule measured from when
// vesting really started, whoever builds the transaction.
test start_vesting_rejects_a_start_far_from_real_chain_time() {
  let now = 1_800_000_000_000
  let back = now - 31_536_000_000
  let datum = mock_datum(NotStarted, 0)
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
    VestingDatum { ..datum, vesting_state: Vesting, vest_start_timestamp: back }
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
      validity_range: interval.between(back - 1000, now + 1000),
    }

  !vesting.spend(
    Some(datum),
    StartVesting { start_timestamp: back },
    own_ref,
    self,
  )
}

test start_vesting_succeeds_with_governor_signature() {
  let datum = mock_datum(NotStarted, 0)
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
    VestingDatum { ..datum, vesting_state: Vesting, vest_start_timestamp: 500 }
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
      // A real, narrow range around the declared start. The placeholder's own
      // range is unbounded, which satisfies containment without saying
      // anything about when this transaction actually happened.
      validity_range: interval.between(400, 600),
    }

  vesting.spend(Some(datum), StartVesting { start_timestamp: 500 }, own_ref, self)
}

test claim_vested_succeeds_for_amount_within_vested_total() {
  // 90-day vest, 45 days elapsed (half), so up to half the allocation is
  // claimable: 100_000_000 / 2 = 50_000_000. own_input/continuing_output
  // hold the REAL full token_allocation (realistic pre-funded
  // balance, same lesson learned elsewhere: a zero-value placeholder can't exercise
  // vesting_tokens_retained's real relative-decrease check).
  let datum = mock_datum(Vesting, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 40_000_000
  let new_datum =
    VestingDatum { ..datum, claimed_tokens: claim_amount }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let current_timestamp = 45 * 86_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"11"],
      // current_timestamp must now fall within a real, narrow
      // validity range.
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
    }

  vesting.spend(
    Some(datum),
    ClaimVested { claim_amount: claim_amount, current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test claim_vested_fails_when_continuing_output_drained() {
  // The SECOND gap — same valid signature, claim_amount, datum, and
  // tokens_delivered as the succeeds test above, but the continuing output
  // at vesting's own address is left EMPTY instead of retaining
  // (100_000_000 - claim_amount). Proves a signed-in creator can no longer
  // drain the full unvested balance in one claim by shortchanging their
  // own continuing output.
  let datum = mock_datum(Vesting, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 40_000_000
  let new_datum =
    VestingDatum { ..datum, claimed_tokens: claim_amount }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      // drained — should hold 60_000_000
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      // attacker/creator receives the FULL 100M, not just claim_amount —
      // real fund-theft simulation, tokens_delivered alone doesn't catch this.
      value: assets.from_asset(#"33", "tok", 100_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let current_timestamp = 45 * 86_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"11"],
    }

  !vesting.spend(
    Some(datum),
    ClaimVested { claim_amount: claim_amount, current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test claim_vested_fails_without_creator_signature() {
  // Same otherwise-valid claim as
  // claim_vested_succeeds_for_amount_within_vested_total, but with NO
  // extra_signatories at all — the rejected case (any third
  // party redirecting the creator's vested tokens to themselves) is now
  // rejected. delivery_output here even correctly targets creator_address,
  // and own_input/continuing_output hold a realistic pre-funded balance,
  // to isolate that the missing signature alone is what fails this.
  let datum = mock_datum(Vesting, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 40_000_000
  let new_datum =
    VestingDatum { ..datum, claimed_tokens: claim_amount }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let current_timestamp = 45 * 86_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [],
    }

  !vesting.spend(
    Some(datum),
    ClaimVested { claim_amount: claim_amount, current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test claim_vested_fails_for_amount_exceeding_vested_total() {
  let datum = mock_datum(Vesting, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
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
  // Attempting to claim more than the 50% vested at the 45-day mark
  let claim_amount = 60_000_000
  let new_datum =
    VestingDatum { ..datum, claimed_tokens: claim_amount }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let current_timestamp = 45 * 86_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
    }

  !vesting.spend(
    Some(datum),
    ClaimVested { claim_amount: claim_amount, current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test claim_vested_fails_before_start_vesting() {
  let datum = mock_datum(NotStarted, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
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
  let claim_amount = 1_000_000
  let new_datum = VestingDatum { ..datum, claimed_tokens: claim_amount }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
    }

  !vesting.spend(
    Some(datum),
    ClaimVested { claim_amount: claim_amount, current_timestamp: 86_400_000 },
    own_ref,
    self,
  )
}

test trigger_cto_freezes_vesting() {
  let datum = mock_datum(Vesting, 0)
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
    VestingDatum {
      ..datum,
      cto_triggered: True,
      community_treasury_wallet: #"ee",
      vesting_state: CTOFrozen,
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

  vesting.spend(
    Some(datum),
    TriggerCTO { community_treasury_wallet: #"ee" },
    own_ref,
    self,
  )
}

// Enforcement: cto_vote_verified's `expect Some(cto_ref_input) = ...`
// panics rather than returning False when no matching reference input
// exists, so this needs the `fail` test annotation — same reasoning as
// bonding_curve.ak's identically-named test.
test trigger_cto_rejects_without_reference_input() fail {
  let datum = mock_datum(Vesting, 0)
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
    VestingDatum {
      ..datum,
      cto_triggered: True,
      community_treasury_wallet: #"ee",
      vesting_state: CTOFrozen,
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

  vesting.spend(
    Some(datum),
    TriggerCTO { community_treasury_wallet: #"ee" },
    own_ref,
    self,
  )
}

test dissolve_cto_resumes_vesting_with_real_anchored_vote() {
  let datum =
    VestingDatum {
      ..mock_datum(CTOFrozen, 0),
      cto_triggered: True,
      community_treasury_wallet: #"ee",
    }
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
    VestingDatum { ..datum, cto_triggered: False, vesting_state: Vesting }
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

  vesting.spend(Some(datum), DissolveCTO, own_ref, self)
}

test claim_community_allocation_succeeds_with_real_anchored_fund_allocation() {
  let datum =
    VestingDatum {
      ..mock_datum(CTOFrozen, 0),
      cto_triggered: True,
      community_treasury_wallet: #"ee",
    }
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 30_000_000
  let new_datum =
    VestingDatum { ..datum, last_claimed_allocation_timestamp: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: recipient_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let executed_proposal =
    ProposalAnchor {
      ..mock_proposal_anchor(FundAllocation, Passed, Executed, #"ee"),
      allocation_amount: claim_amount,
    }
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output, delivery_output],
    }

  vesting.spend(Some(datum), ClaimCommunityAllocation, own_ref, self)
}

// Regression (2026-07-23 audit): ClaimCommunityAllocation is the
// worst-affected redeemer of the whole finding — it reads allocation_amount
// and recipient straight out of the referenced governance datum and pays out
// real tokens, so a forged governance UTXO would let an attacker drain the
// entire vesting reserve to themselves for free. A UTXO planted at
// cto_governance_credential with a fully forged "FundAllocation / Passed /
// Executed, amount = everything, recipient = attacker" datum but WITHOUT the
// genuine governance thread NFT must be rejected. Cleanly returns False (the
// ref input exists, it just lacks the NFT), so a plain `!spend(...)` works.
test claim_community_allocation_rejects_forged_governance_utxo_without_nft() {
  let datum =
    VestingDatum {
      ..mock_datum(CTOFrozen, 0),
      cto_triggered: True,
      community_treasury_wallet: #"ee",
    }
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ba")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Regression: a caller attempts to release the entire reserve to themselves.
  let claim_amount = 100_000_000
  let new_datum =
    VestingDatum { ..datum, last_claimed_allocation_timestamp: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: attacker_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let forged_proposal =
    ProposalAnchor {
      ..mock_proposal_anchor(FundAllocation, Passed, Executed, #"ba"),
      allocation_amount: claim_amount,
    }
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(forged_proposal))
  // FORGED: correct governance address, a fully "passed" fund-allocation
  // datum naming the attacker as recipient — but the UTXO holds no NFT.
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
      outputs: [continuing_output, delivery_output],
    }

  !vesting.spend(Some(datum), ClaimCommunityAllocation, own_ref, self)
}

// Same `expect Some(cto_ref_input) = ...` panic reasoning as
// trigger_cto_rejects_without_reference_input above.
test claim_community_allocation_rejects_without_reference_input() fail {
  let datum =
    VestingDatum {
      ..mock_datum(CTOFrozen, 0),
      cto_triggered: True,
      community_treasury_wallet: #"ee",
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 30_000_000
  let new_datum =
    VestingDatum { ..datum, last_claimed_allocation_timestamp: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: recipient_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
    }

  vesting.spend(Some(datum), ClaimCommunityAllocation, own_ref, self)
}

test claim_community_allocation_rejects_replayed_proposal() {
  // datum's watermark already equals the proposal's anchor_timestamp (500)
  // — the exact same proposal being presented a second time. Proves a
  // relayer can't replay one passed FundAllocation vote into two payouts.
  let datum =
    VestingDatum {
      ..mock_datum(CTOFrozen, 0),
      cto_triggered: True,
      community_treasury_wallet: #"ee",
      last_claimed_allocation_timestamp: 500,
    }
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 30_000_000
  let new_datum =
    VestingDatum { ..datum, last_claimed_allocation_timestamp: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: recipient_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let executed_proposal =
    ProposalAnchor {
      ..mock_proposal_anchor(FundAllocation, Passed, Executed, #"ee"),
      allocation_amount: claim_amount,
    }
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output, delivery_output],
    }

  !vesting.spend(Some(datum), ClaimCommunityAllocation, own_ref, self)
}

test claim_community_allocation_rejects_wrong_recipient() {
  // Delivery goes to an address other than the one the anchored proposal
  // authorized (#"ee") — proves a relayer can't redirect the payout to
  // themselves, the reason community_allocation_delivered pins the
  // recipient instead of reusing the looser tokens_delivered.
  let datum =
    VestingDatum {
      ..mock_datum(CTOFrozen, 0),
      cto_triggered: True,
      community_treasury_wallet: #"ee",
    }
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ff")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 30_000_000
  let new_datum =
    VestingDatum { ..datum, last_claimed_allocation_timestamp: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: attacker_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let executed_proposal =
    ProposalAnchor {
      ..mock_proposal_anchor(FundAllocation, Passed, Executed, #"ee"),
      allocation_amount: claim_amount,
    }
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output, delivery_output],
    }

  !vesting.spend(Some(datum), ClaimCommunityAllocation, own_ref, self)
}

test claim_community_allocation_rejects_if_not_cto_triggered() {
  // CTO never triggered — vesting_state is Vesting, cto_triggered False —
  // there is no frozen community pool to claim from at all.
  let datum = mock_datum(Vesting, 0)
  let cto_address = from_verification_key(#"aa")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 30_000_000
  let new_datum =
    VestingDatum { ..datum, last_claimed_allocation_timestamp: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: recipient_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let executed_proposal =
    ProposalAnchor {
      ..mock_proposal_anchor(FundAllocation, Passed, Executed, #"ee"),
      allocation_amount: claim_amount,
    }
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output, delivery_output],
    }

  !vesting.spend(Some(datum), ClaimCommunityAllocation, own_ref, self)
}

test claim_vested_fails_while_cto_triggered() {
  let datum =
    VestingDatum { ..mock_datum(CTOFrozen, 0), cto_triggered: True }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
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
  let claim_amount = 1_000_000
  let new_datum = VestingDatum { ..datum, claimed_tokens: claim_amount }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_thread_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
    }

  !vesting.spend(
    Some(datum),
    ClaimVested { claim_amount: claim_amount, current_timestamp: 45 * 86_400_000 },
    own_ref,
    self,
  )
}

// QueryState previously authorized ANY spend unconditionally
// (`QueryState -> True`, zero checks) — an unconditional authorization
// of the creator's locked vesting allocation. Proves the fix.
test query_state_rejects_unauthenticated_drain_attempt() {
  let datum = mock_datum(Vesting, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "tok", 100_000_000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "tok", 100_000_000),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !vesting.spend(Some(datum), QueryState, own_ref, self)
}

// Regression test: the value-conservation case verified against the full
// security audit. A script cannot independently know "real chain time" —
// what it CAN enforce is that the transaction's own DECLARED validity
// range is narrow, closing off the actual attack surface: without a
// narrow-width bound, a creator could declare an implausibly WIDE range
// (e.g. spanning from real day-zero all the way to day 90) and claim a
// current_timestamp anywhere within it — including the far, self-serving
// end — while the transaction is really processed on day zero. This test
// proves that exact shape (a technically-honest-in-isolation
// current_timestamp of 90 days, paired with a wide declared range
// starting at day zero) is now rejected by validity_range_is_narrow,
// independent of whether the claimed vesting math would otherwise be
// legitimate at that single point in time.
test claim_vested_rejects_wide_validity_range() {
  let datum = mock_datum(Vesting, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 100_000_000
  let forged_timestamp = 90 * 86_400_000
  let new_datum = VestingDatum { ..datum, claimed_tokens: claim_amount, vesting_state: FullyClaimed }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 0)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"11"],
      // Spans the ENTIRE 90-day vesting period (far beyond the
      // 600,000ms/10-minute max_validity_range_width) — interval.contains
      // alone would accept this (forged_timestamp genuinely falls inside
      // the range), but validity_range_is_narrow must not.
      validity_range: interval.between(0, forged_timestamp + 100),
    }

  !vesting.spend(
    Some(datum),
    ClaimVested { claim_amount: claim_amount, current_timestamp: forged_timestamp },
    own_ref,
    self,
  )
}

// TriggerCTO was previously reachable from NotStarted (before
// StartVesting ever ran) — proves it's now rejected.
test trigger_cto_rejects_before_vesting_started() {
  let datum = mock_datum(NotStarted, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum = mock_cto_governance_datum(datum.launch_id, Some(proposal))
  let cto_ref_input = mock_cto_ref_input(from_verification_key(#"aa"), cto_datum)
  let new_datum =
    VestingDatum {
      ..datum,
      cto_triggered: True,
      community_treasury_wallet: #"ee",
      vesting_state: CTOFrozen,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output],
    }

  !vesting.spend(Some(datum), TriggerCTO { community_treasury_wallet: #"ee" }, own_ref, self)
}

// Real recovery path for the creator's own never-vested allocation
// once Cancelled — proves the redeemer works for real.
test claim_cancelled_allocation_succeeds_for_creator() {
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", 100_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let thread_continuing_output =
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
      outputs: [delivery_output, thread_continuing_output],
      extra_signatories: [#"11"],
    }

  vesting.spend(Some(datum), ClaimCancelledAllocation, own_ref, self)
}

// CancelLaunch is now only reachable from NotStarted — proves a
// launch that already began vesting can no longer be cancelled this way.
test cancel_launch_rejects_after_vesting_started() {
  let datum = mock_datum(Vesting, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = VestingDatum { ..datum, vesting_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
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

  !vesting.spend(Some(datum), CancelLaunch, own_ref, self)
}

// One hour into a ninety-day schedule. An hour of ninety days has vested about
// 46_296 of a 100_000_000 allocation, so a million is far too much and must be
// refused.
//
// The amount is chosen to sit between the two readings, which is the whole
// point: were the divisor counted in seconds, the schedule would complete in
// about two hours, roughly 46_296_296 would have vested by now, and a million
// would sail through. Claiming the entire allocation would NOT catch that --
// it is refused either way -- and a boundary written in terms of vest_days
// scales with the mistake and never sees it at all.
test claim_vested_rejects_a_million_an_hour_into_a_ninety_day_vest() {
  // 90-day vest, 45 days elapsed (half), so up to half the allocation is
  // claimable: 100_000_000 / 2 = 50_000_000. own_input/continuing_output
  // hold the REAL full token_allocation (realistic pre-funded
  // balance, same lesson learned elsewhere: a zero-value placeholder can't exercise
  // vesting_tokens_retained's real relative-decrease check).
  let datum = mock_datum(Vesting, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let claim_amount = 1_000_000
  let new_datum =
    VestingDatum { ..datum, claimed_tokens: claim_amount }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_thread_nft(), assets.from_asset(#"33", "tok", 100_000_000 - claim_amount)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", claim_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let current_timestamp = 3_600_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"11"],
      // current_timestamp must now fall within a real, narrow
      // validity range.
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
    }

  !vesting.spend(
    Some(datum),
    ClaimVested { claim_amount: claim_amount, current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}
