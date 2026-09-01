// ============================================================================
// Noctis Zone — Cardano L1 Bonding Curve Contract (Aiken)
// The linear curve only
// ============================================================================
// The linear curve never touches Midnight — this is the entire public sale mechanism
// for linear-curve launches. Per CLAUDE.md's tier design, the linear curve is deliberately
// the "weak" tier: LINEAR pricing (not quadratic) and a weak per-ADDRESS
// cap (not a strong ZK-identity cap — the same wallet can be split to dodge
// it, an accepted trade-off for the free/simple tier). The quadratic curve
// + ZK-identity cap combination is both launch types's, on Midnight instead — see
// contracts/midnight/bonding_curve.compact. Do not import that file's
// shape here; the two are intentionally different curves for different
// tiers, not two implementations of the same thing.
//
// Price formula: price = base_price + k * sold
//   where k = (max_price - base_price) / curve_supply
//   i.e. price = base_price + ((max_price - base_price) * sold) / curve_supply
//
// At sold=0:             price = base_price
// At sold=curve_supply:  price = max_price
//
// Fee structure (1.5% total, same split as both launch types):
//   0.5% -> creator fee accumulator (claimed by creator; mirrors the
//           "Stream A" Bonding Curve Escrow pattern from CLAUDE.md — the linear curve
//           has no separate Cardano Creator Fee Escrow contract in the
//           architecture table, so this curve contract accrues and gates
//           the claim directly instead of handing off to another PSM)
//   1.0% -> platform fee accumulator (governor-claimed). ONE accrual for
//           ONE wallet — not a treasury slice plus an ops slice.
//
// Graduation: 100% sell-through only (CLAUDE.md — no partial graduation).
// On graduation this contract stops accepting buys and marks Graduated.
//
// Fix (2026-07-10): 100% sell-through only ever flipped a `curve_state`
// flag — nothing actually moved the raised ADA or the LP token reserve into
// lp_escrow.ak, so a "graduated" launch never really produced a working LP.
// Added a `Graduate` redeemer (permissionless, same "the condition itself is
// the authorization" idiom as ExpireCurve below) that consumes the curve's
// accrued `total_raised` ADA (Option A, all net-of-fee principal) and a
// dedicated `lp_reserve_tokens` balance — held in this same UTXO from deploy
// time onward, untouched by BuyTokens/ClaimBuyback — and verifies both
// actually land at the launch's `lp_escrow_credential` in the same
// transaction. The curve contract is NOT fully consumed by Graduate: its fee
// accumulators (creator/treasury/ops) stay claimable afterward exactly as
// before, matching CLAUDE.md's Stream A description ("amount fixed at
// graduation, does not continue, but is still claimed after"). A `lp_seeded`
// flag guards against double-seeding.
//
// Bonus fix found while designing Graduate (2026-07-10): `token_delivered`
// (used by BuyTokens) only ever checked that SOME output held `token_amount`
// of the launch token — it never checked that the curve's OWN reserve
// actually decreased by that amount, the delivery-side mirror of the earlier
// payment-side fix. Undetected before now because nothing downstream relied
// on the curve's real token balance staying honest; it matters now because
// `lp_reserve_tokens` sits in the same UTXO Graduate reads from, so an
// inflated/fake `tokens_sold` count (reachable by self-supplying the
// "delivery" output while the curve's real balance never moves) could
// falsely trigger Graduated and let Graduate try to pay out a reserve that
// was never actually there. Fixed via a new `curve_token_balance_decreased`
// check, applied to BuyTokens the same way `payment_received` already is —
// same real-value-movement discipline as ClaimBuyback's helpers below.
//
// Fix (2026-07-10): 100% sell-through with no timeout meant a
// poorly-marketed or abandoned curve could stall below Graduated forever —
// no LP ever seeds, so early buyers hold permanently illiquid tokens with
// no forced resolution if the governor never acts. Added `phase_started_at`
// (set when ActivateCurve fires) and a permissionless `ExpireCurve`
// redeemer, mirroring cto_governance.ak's `ExpireProposal` idiom exactly:
// a `current_timestamp` redeemer field checked against the tx's actual
// validity range via `interval.contains` (Cardano scripts can't read a
// wall clock directly), no signature required once the deadline has
// passed. `max_curve_duration` defaults to 90 days — same order of
// magnitude as SILENCE_LOCK_DAYS's "something hasn't happened in a
// reasonable business timeframe" precedent, not a value CLAUDE.md
// specified; treat as adjustable, same status as the settlement-window
// default. Stranded-principal disposition (once Cancelled) is
// ClaimBuyback below — that question is resolved, not open anymore.
//
// Rewritten 2026-07-09 to match real Aiken v1.1.23 syntax — the original
// draft used a fictional API (`fn spend(...) -> Void`, `ctx: ScriptContext`,
// `Ed25519.verify(...)`, `Blake2b_224.hash(...)`, `require(...)`) that
// doesn't exist in any real Aiken version and crashed the compiler on
// import resolution. Authorization now uses the idiomatic pattern of
// checking `self.extra_signatories` (the ledger already verifies those
// signatures before the script runs) instead of manually re-verifying an
// Ed25519 signature passed through the redeemer.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Credential, from_verification_key, with_delegation_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use cto_governance.{
  CTOTriggered as CtoAnchorTriggered, CtoGovernanceDatum, DissolveCTOProposal,
  Executed, Passed, PreCTO, ProposalAnchor, ProposalType, SilenceLockTrigger,
}
use noctis/cap_accumulator.{CapProofStep}
use noctis/settlement
use noctis/staking_pool_datum
use noctis/thread_nft

/// A Cardano script only ever sees a transaction's OWN DECLARED
/// validity range, never real wall-clock time — `interval.contains` alone
/// lets ANY caller claim ANY timestamp within an arbitrarily wide,
/// self-chosen range, which defeats a "deadline" check entirely for a
/// PERMISSIONLESS redeemer (no trusted signer to rely on instead, unlike
/// e.g. ActivateCurve). `ExpireCurve` is permissionless by design ("the
/// deadline check itself is the authorization") — without this, literally
/// a curve must not be cancellable immediately after activation by
/// simply declaring a wide-enough validity range and claiming a
/// timestamp near its far end. Found while researching Phase 5b (real DEX
/// migration) of the Cardano Preprod milestone — see internal tracking
/// for the full cross-contract audit — every other permissionless,
/// timestamp-gated redeemer on the platform carries this same bound,
/// applied in the same pass. `max_width` is generous
/// (10 minutes) relative to Preprod's real ~20s block time, comfortably
/// covering real network/build delays while still closing the gap.
fn validity_range_is_narrow(range: Interval, max_width: Int) -> Bool {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      hi >= lo && hi - lo <= max_width
    _ -> False
  }
}

/// 10 minutes in milliseconds — the max validity-range width permitted for
/// any permissionless, timestamp-deadline-gated redeemer in this file.
const max_validity_range_width = 600_000

// ============================================================================
// TYPES
// ============================================================================

/// Curve lifecycle
pub type CurveState {
  Inactive
  Active
  Graduated
  Cancelled
}

/// The datum stored at the bonding curve UTxO
//
// FIELD ORDER IS LOAD-BEARING, and not for the reason it usually is.
//
// A record update walks the constructor's field list to reach the field it
// replaces, so what a `BondingCurveDatum { ..datum, x: y }` costs in compiled
// script bytes scales with x's INDEX — not with how many fields the record
// has. Measured on this validator: ~10 bytes of script per index position per
// update site.
//
// Every field a redeemer REWRITES is therefore declared first, and everything
// set once at genesis and only read afterwards is declared after them. That
// single change took this script from 12,134 bytes to 11,042 — 9% — with no
// behavioural difference whatsoever. Cardano Launch's datum is ordered on the same
// rule and shares this prefix, so the two read alike.
//
// So: a new field that a redeemer writes belongs at the FRONT, next to its
// neighbours. A new read-only field belongs at the BACK. Either way the
// off-chain schema in integration/tier-a-schemas.ts must move with it — the
// encoding is positional, and a mismatch decodes to the wrong field rather
// than failing.
pub type BondingCurveDatum {
  // total tokens sellable on this curve
  // Live state
  curve_state: CurveState,
  // The platform runs ONE wallet. What used to be a treasury slice and an
  // ops slice is a single accrual, claimed once.
  platform_fees_accrued: Int,
  // net of fees, lovelace
  // Fee accumulators (1.5% total: 0.5 creator / 1.0 platform, same as both
  // launch types)
  creator_fees_accrued: Int,
  total_raised: Int,
  tokens_sold: Int,
  /// The keys allowed to apply a batch against this curve. `BatchTrades`
  /// requires the named batcher to appear HERE as well as in the
  /// transaction's real signatures, so naming a key in the redeemer and
  /// signing with it is no longer enough on its own.
  ///
  /// It sits in the datum rather than in the script so the set can change
  /// without moving the launch's address, and `SetBatcherAllowlist` is the
  /// only thing that may rewrite it. Capped at `max_batcher_allowlist`
  /// entries there: this datum rides in every trade transaction, so an
  /// unbounded list would let the set grow until a trade no longer fits.
  ///
  /// Declared near the FRONT because `SetBatcherAllowlist` rewrites it, per
  /// this datum's ordering rule — a record update walks the field list to
  /// reach what it replaces, so a rewritten field at the back is paid for in
  /// script bytes. At the back this cost the Cardano Launch curve enough to
  /// put it over the size a publishing transaction can carry.
  ///
  /// An empty list means no batch can be applied. That is a real state a
  /// governor can choose, and it strands nothing — an order UTXO is spendable
  /// by its own owner at any time, with no batcher and no deadline involved.
  batcher_allowlist: List<VerificationKeyHash>,
  // The cumulative wallet cap, as ONE root over `key -> tokens taken from
  // this curve`. Declared near the front because every trade rewrites it —
  // see the ordering note above this type.
  //
  // Identical tree, leaf layout and depth as Cardano Launch's — see
  // `noctis/cap_accumulator` for why it is a root rather than a list, and why
  // both tiers share one definition. Genesis writes the empty tree's root, so
  // every slot starts unoccupied and the curve is open to anyone from block
  // one: there is no registration step and no allowlist.
  cap_root: ByteArray,
  // CTO fee-redirect fix (2026-07-12): once a CTO passes via
  // cto_governance.ak's SilenceLockTrigger, future ClaimCreatorFees claims
  // redirect to the community wallet instead of the creator — mirrors
  // lp_escrow.ak's cto_triggered/community_wallet_hash pattern,
  // applied here for the first time to bonding-curve trade fees. Before
  // this fix, a passed CTO vote never actually redirected anything: this
  // contract had no CTO concept at all, so the creator could keep claiming
  // regardless of governance outcome.
  community_pub_key_hash: VerificationKeyHash,
  cto_triggered: Bool,
  // Posix time (ms) the curve entered the state it is in: the mint, written
  // at genesis, and then the activation, written by ActivateCurve.
  //
  // It is the clock ExpireCurve measures its stall window from, which is why
  // it has to be set from genesis rather than left at zero until activation.
  // A curve waiting to be activated is as capable of stalling as one that is
  // trading — more so, since ActivateCurve is the governor's call — and a
  // zero here would have meant "expired since 1970" rather than "not yet
  // started", making the escape a griefing tool instead of a backstop.
  phase_started_at: Int,
  lp_seeded: Bool,
  staking_seeded: Bool,
  // Identity
  launch_id: ByteArray,
  creator_pub_key_hash: VerificationKeyHash,
  governor_pub_key_hash: VerificationKeyHash,
  // Curve parameters (fixed at deploy)
  base_price: Int,
  // lovelace per token at sold = 0
  max_price: Int,
  // lovelace per token at sold = curve_supply
  curve_supply: Int,
  // 5% of curve_supply, CUMULATIVE per wallet across every trade — held
  // against `cap_root` above rather than as a per-wallet total in this datum,
  // which is what keeps the datum one fixed size for the life of a launch.
  //
  // What it does NOT do, stated plainly so no product surface overclaims it:
  // one WALLET KEY is capped, one PERSON is not. A buyer who wants more uses
  // a second key. Sybil resistance on both launch types comes from DarkVeil's
  // eligibility checks and the N-hop challenge; the linear curve has neither, so the
  // honest reading of this cap on the linear curve is "per wallet", full stop.
  wallet_cap: Int,
  // Token identity (the launch's native asset, locked in this UTxO)
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  // LP graduation fields. `lp_escrow_credential` is fixed at deploy —
  // the payment credential of THIS launch's own LP Escrow contract UTXO, so
  // Graduate can't be redirected to seed an unrelated address.
  // `lp_reserve_tokens` (15% of TOTAL_SUPPLY, per CLAUDE.md's
  // LP_RESERVE_PCT) is deposited into this same UTXO at deploy time
  // alongside the curve_supply worth of sellable tokens, and is untouched
  // by BuyTokens/ClaimBuyback — only Graduate ever moves it.
  lp_escrow_credential: Credential,
  lp_reserve_tokens: Int,
  // Staking Rewards Pool (2026-07-14): optional per-launch feature.
  // `staking_pool_credential` is fixed at deploy — this launch's own
  // staking_pool.ak instance, same "can't be redirected" guarantee as
  // `lp_escrow_credential`. `staking_reserve_tokens` is 0 when the creator
  // didn't opt in; when they did, it's STAKING_ALLOC_PCT (25%) of
  // TOTAL_SUPPLY, deposited into this UTXO at deploy time alongside
  // curve_supply and lp_reserve_tokens, untouched by BuyTokens/ClaimBuyback
  // — only Graduate ever moves it, in the same transaction as LP seeding.
  staking_enabled: Bool,
  staking_pool_credential: Credential,
  staking_reserve_tokens: Int,
  // The runway the creator commits to at launch creation, and the pool's
  // whole emission schedule: `staking_reserve_tokens / staking_duration_days`
  // is the rate the pool opens with and keeps for life. On chain here, rather
  // than off, because graduation is permissionless — a rate chosen at
  // graduation would be a rate chosen by whoever submitted it.
  staking_duration_days: Int,
  // Fix: cto_governance.ak's own fixed script address, set
  // at genesis exactly like lp_escrow_credential/staking_pool_credential
  // above — same "no constructor params, one fixed address shared across
  // every launch, so this field never actually varies" shape. Needed
  // because TriggerCTO/DissolveCTO below now require real reference-input
  // evidence a vote actually passed, instead of trusting a bare governor
  // signature — that evidence lives at this address.
  cto_governance_credential: Credential,
  // Fix (2026-07-23 security audit): the governance THREAD NFT's policy
  // id. Paying to a script address never runs its validator, and reference
  // inputs are read-only — so trusting a reference input at
  // cto_governance_credential by address alone is not sufficient authentication, because
  // place a UTXO there carrying an unauthenticated
  // datum and reference it. cto_vote_verified now additionally requires the
  // referenced governance UTXO to carry the genuine per-launch governance
  // NFT (this policy, asset_name = launch_id) — minted once, at governance
  // setup, under a governor-signature policy no attacker can satisfy, and
  // preserved in cto_governance.ak's continuing output on every spend. Set
  // at genesis exactly like the credentials above.
  thread_nft_policy: PolicyId,
}

/// Redeemer actions — what the contract can be spent with
/// One order inside a batch. Mirrors Cardano Launch's identical type; see
/// bonding_curve_tier_b.ak for the reasoning, which does not differ by tier.
pub type BatchOrder {
  owner: VerificationKeyHash,
  /// The order UTXO this fill settles.
  ///
  /// One owner may hold several orders in a batch, and they are owed
  /// separately. Identifying a fill by its owner alone cannot tell two of them
  /// apart, so one payment reads as satisfying both. A reference is unique
  /// across the chain, so tagging each fill with the order it settles makes
  /// them distinguishable however alike they are — and it is the same
  /// reference `curve_order` checks against, so the two validators agree on
  /// which output is which fill.
  order_ref: OutputReference,
  is_buy: Bool,
  amount: Int,
  min_received: Int,
  /// The owner's committed total before this order, and the proof of it. A
  /// batch applies orders in sequence, so each proof is taken against the root
  /// the PRECEDING order left behind — see Cardano Launch's identical field.
  cap_committed_before: Int,
  cap_proof: List<CapProofStep>,
}

pub type BondingCurveRedeemer {
  /// Governor activates the curve (Inactive -> Active). `current_timestamp`
  /// is stamped into `phase_started_at`, verified against the tx's actual
  /// validity range so ExpireCurve has a trustworthy start point.
  ActivateCurve { current_timestamp: Int }
  /// Public buy — no identity proof required, unlike both launch types's DarkVeil-
  /// gated purchases. The caller names only how much they want and who they
  /// are; the contract derives the price and the fee split itself from the
  /// datum, so the amount charged is a function of curve position and batch
  /// size alone (see `gross_range`).
  ///
  /// `cap_committed_before` is what this buyer has already taken from the
  /// curve, and `cap_proof` is what makes that number true rather than
  /// claimed — it must reach `cap_root` from the buyer's own slot. Understate
  /// the total and the proof does not reach the root; overstate it and the
  /// buyer only shrinks their own headroom.
  BuyTokens {
    token_amount: Int,
    buyer_key_hash: VerificationKeyHash,
    cap_committed_before: Int,
    cap_proof: List<CapProofStep>,
  }
  /// Creator claims accrued creator fees (Stream A pattern — pre-graduation
  /// bonding curve fees only; distinct from post-graduation LP trading fees).
  ///
  /// Two guarantees this redeemer makes. (1) Value conservation: the curve's
  /// real lovelace balance must decrease by exactly `amount` and that `amount`
  /// must reach the claimer, verified by real value movement rather than by
  /// the datum's counter alone — the same discipline every other value-moving
  /// redeemer here uses (`payment_received`, `lovelace_paid_from_curve`,
  /// `graduation_funds_left_curve`). Buyers' principal cannot leave by this
  /// path. (2) `platform_claim_fee`: a real, on-chain-enforced flat charge
  /// paid INTO the curve alongside the claim, accruing to
  /// `platform_fees_accrued`. It approximates CLAUDE.md's
  /// `STAKING_CLAIM_FEE_USD` ($1) precedent, but as a real on-chain minimum
  /// rather than a client convention. Aiken has no in-circuit oracle access,
  /// so `min_platform_claim_fee_lovelace` below is a deliberately
  /// conservative SANITY FLOOR, not a live $1 peg — the real $1-equivalent is
  /// computed off-chain via `integration/ada-usd-price.ts` and paid with
  /// margin above the floor in the normal case.
  ClaimCreatorFees { amount: Int, platform_claim_fee: Int }
  /// Governor claims accrued treasury fees.
  ///
  /// Fix: same missing value-conservation gap as ClaimCreatorFees,
  /// fixed the same way — no new fee added here (the governor is claiming
  /// treasury's OWN existing accrual, not paying a new platform charge).
  /// Governor claims the platform's accrued fees. One redeemer, because
  /// the platform runs one wallet.
  ClaimPlatformFees { amount: Int }
  /// Public sell — the reverse of BuyTokens (2026-07-19). Both sides price
  /// the range of curve positions the trade actually moves through, summed
  /// token by token: a buy of `n` at `tokens_sold = s` prices `[s, s+n)`, the
  /// range being added, and a sell of `n` at `tokens_sold = s` prices
  /// `[s-n, s)`, the range being removed. A buy and an immediate sell of the
  /// same size therefore quote the SAME range, and net to zero before fees —
  /// the 1.5% fee charged on each leg is the only friction. Because a sum is additive
  /// over adjacent ranges (see `gross_range`), that holds however the exit is
  /// sized or split: proceeds depend on which positions are vacated, not on
  /// the shape of the trades that vacate them.
  ///
  /// The value invariant `total_raised + creator_fees_accrued +
  /// platform_fees_accrued == curve's real lovelace
  /// balance` holds after this redeemer exactly as it does after BuyTokens:
  /// `total_raised` decreases by the FULL `gross_proceeds` (not just
  /// `net_proceeds`), while `fee_total` accrues to the same 3 accumulators
  /// exactly as a buy's fee does — only `net_proceeds` (gross minus fees)
  /// actually leaves the curve to pay the seller.
  ///
  /// Entitlement is possession: the seller hands real tokens back to the
  /// curve in the same transaction, so holding them is what qualifies them
  /// to sell. Nothing is looked up, and a wallet that acquired its tokens by
  /// ordinary transfer can sell them here like any other holder.
  ///
  /// The creator is blocked explicitly. That block used to be implicit — a
  /// creator can never buy, so their tracked purchase total was always zero —
  /// and with no such total it has to be stated outright, or a creator could
  /// sell vested allocation into the curve and draw down principal that
  /// public buyers paid in.
  ///
  /// A sell DECREMENTS the seller's committed total, so the cap tracks what a
  /// wallet currently holds off the curve rather than what it has ever bought
  /// — otherwise a trader who buys their full 5% and sells it again is barred
  /// from the launch for good. A seller whose slot is empty (tokens acquired
  /// by transfer, never from this curve) proves the empty slot and leaves the
  /// root where it is; their total floors at zero rather than going negative.
  SellTokens {
    token_amount: Int,
    seller_key_hash: VerificationKeyHash,
    cap_committed_before: Int,
    cap_proof: List<CapProofStep>,
  }
  /// Cancel the launch (governor only, failure path — voluntary, any time)
  CancelCurve
  /// Permissionless — anyone can force-cancel a curve that's been Active
  /// for longer than `max_curve_duration` without reaching Graduated
  /// (max_curve_duration). No signature required, same trust model as
  /// cto_governance.ak's `ExpireProposal`: the deadline check itself is
  /// the authorization.
  ExpireCurve { current_timestamp: Int }
  /// Pro-rata buyback (2026-07-10): once Cancelled, a token holder
  /// returns `token_amount` of the launch token to this contract and
  /// reclaims their proportional share of the stranded ADA principal
  /// (`total_raised * token_amount / tokens_sold`, using the curve's own
  /// real division — Aiken's Int is arbitrary-precision, no ZK-circuit
  /// division restriction the way Compact has). The buyer must actually
  /// send the tokens in the same transaction (`tokens_returned_to_curve`)
  /// and actually receive the computed ADA share
  /// (`lovelace_paid_from_curve`) — same real-value-movement pattern as
  /// `payment_received`/`token_delivered`, not a self-reported claim.
  ClaimBuyback { token_amount: Int, buyer_key_hash: VerificationKeyHash }
  /// Seed the LP once Graduated. Permissionless — same idiom as
  /// ExpireCurve, since every effect is verified against real value
  /// movement, not a signature-backed claim: nobody benefits from calling
  /// this "incorrectly" because a malformed attempt simply fails the
  /// invariant checks below. Moves `total_raised` lovelace and
  /// `lp_reserve_tokens` of the launch token to `lp_escrow_credential`;
  /// fee accumulators are untouched and remain separately claimable.
  Graduate
  /// Trigger CTO — governor only, called after a SilenceLockTrigger
  /// proposal passes on cto_governance.ak. Redirects future
  /// ClaimCreatorFees claims to community_pub_key_hash. Same pattern as
  /// lp_escrow.ak's TriggerCTO.
  TriggerCTO { community_pub_key_hash: VerificationKeyHash }
  /// Dissolve CTO — governor only, called after a DissolveCTO proposal
  /// passes (creator returned). Reverts ClaimCreatorFees back to the
  /// original creator.
  DissolveCTO
  /// Read-only query, no state change — off-chain callers should just read
  /// the datum directly rather than spend through this redeemer
  QueryState
  /// Applies N orders in one transaction. Every order on a side pays that
  /// side's batch average: one `gross_range` per side, split pro-rata, so a
  /// position inside the batch is worth nothing. `batcher_key_hash` must
  /// appear in `batcher_allowlist` and in the transaction's own signatures.
  /// Appended LAST so no already-deployed constructor index moves.
  BatchTrades { orders: List<BatchOrder>, batcher_key_hash: VerificationKeyHash }
  /// Rewrites `batcher_allowlist`. Governor-signed, bounded at
  /// `max_batcher_allowlist`, and moves no value. Appended LAST for the same
  /// constructor-index reason.
  SetBatcherAllowlist { batchers: List<VerificationKeyHash> }
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// Fee split in basis points (10000 = 100%) — 0.5% creator + 1.0% platform
/// = 1.5% total, plus the batcher fee charged per order.
const creator_bps = 50

/// One platform line, not a treasury slice plus an ops slice.
const platform_bps = 100

const bps_denominator = 10_000

/// The most keys `SetBatcherAllowlist` will write into the datum.
///
/// The datum is carried by every trade, so this list competes for the same
/// transaction budget the orders themselves need. Eight is far more batchers
/// than a launch has any use for and costs a couple of hundred bytes at worst.
const max_batcher_allowlist = 8

/// Deliberately conservative SANITY FLOOR for ClaimCreatorFees's new
/// platform_claim_fee, not a precise $1 peg (Aiken has no in-circuit oracle
/// access — same constraint Compact has). 0.2 ADA comfortably undershoots
/// $1's real ADA value across ADA's entire realistic historical trading
/// range; the real $1-equivalent is computed off-chain via the already-
/// real usdToMinAdaLovelace() Orcfax oracle and paid with margin above
/// this floor in the normal case. Same "fixed ADA figure, not oracle-
/// verified in-circuit" idiom as NHOP_CHALLENGE_BOND (25 ADA).
const min_platform_claim_fee_lovelace = 200_000

/// 90 days in MILLISECONDS — max time a curve can sit Active without
/// reaching Graduated before anyone can force-expire it. Not a
/// CLAUDE.md-specified constant; same status as the settlement-window
/// default — a documented starting point, adjustable.
///
/// Fix (2026-07-17): this was previously `7_776_000` (90 days in
/// SECONDS), justified by a comment claiming it matched cto_governance.ak's
/// own `execution_window` "Posix seconds, not ms" convention — that
/// justification was itself wrong. `ActivateCurve`/`ExpireCurve`'s
/// `current_timestamp` is checked via `interval.contains(self.validity_range,
/// current_timestamp)`, and Cardano's real transaction validity range is
/// natively expressed in MILLISECONDS (confirmed via a real, on-chain-
/// confirmed `ActivateCurve` transaction recording `phase_started_at:
/// 1784273626775`, a 13-digit ms epoch). Adding a seconds-scale constant to
/// a ms-scale `phase_started_at` meant the documented "90-day stall window" was
/// actually enforced as ~7,776,000ms ≈ 2.16 real hours. Found while
/// building Phase 5 of the Cardano Preprod milestone (see internal tracking)
/// — fixed here, and the SAME bug pattern was found and fixed in
/// cto_governance.ak's `execution_window` in the same pass (that field is
/// ALSO checked via `interval.contains`, so it needed the identical fix).
const max_curve_duration = 7_776_000_000

// ============================================================================
// HELPERS
// ============================================================================

/// The cost of the token range `[from_sold, from_sold + amount)` on the linear
/// curve `P(x) = base_price + (max_price - base_price) * x / curve_supply`,
/// returned as an unreduced `(numerator, denominator)` pair.
///
/// A bonding curve sells DISCRETE tokens: token `i` costs `P(i)`, so a batch
/// costs the sum of its members' prices. Summing rather than applying one
/// price across the batch is what gives this curve the property its economics
/// rest on — a sum is additive over adjacent ranges:
///
///   sum[a,c) == sum[a,b) + sum[b,c)
///
/// so a batch costs exactly what the same tokens cost traded in any number of
/// smaller pieces. Price depends on position along the curve alone, never on
/// how a trade is split up, and the two sides of a round trip are quoted from
/// the same range.
///
/// Closed form, with `r = max_price - base_price` and `S = curve_supply`:
///
///   sum(s, n) = n*base + r*n*(2s + n - 1) / (2S)
///
/// The pair is returned unreduced so each caller applies its own rounding
/// direction — see `buy_cost` and `sell_proceeds`, which is where that choice
/// belongs and where it is named. Aiken's `Int` is arbitrary precision, so the
/// intermediate products carry no overflow or precision concern.
fn gross_range(
  datum: BondingCurveDatum,
  from_sold: Int,
  amount: Int,
) -> (Int, Int) {
  let price_range = datum.max_price - datum.base_price
  let numerator =
    2 * datum.curve_supply * amount * datum.base_price + price_range * amount * (
      2 * from_sold + amount - 1
    )
  (numerator, 2 * datum.curve_supply)
}

/// What a buyer pays for `amount` tokens starting at `from_sold` — the range
/// cost rounded UP, so any integer remainder resolves in the curve's favour
/// and a buyer never pays below the true sum.
fn buy_cost(datum: BondingCurveDatum, from_sold: Int, amount: Int) -> Int {
  let (numerator, denominator) = gross_range(datum, from_sold, amount)
  ( numerator + denominator - 1 ) / denominator
}

/// What a seller receives for `amount` tokens starting at `from_sold` — the
/// same range cost rounded DOWN, the mirror of `buy_cost`, so the curve never
/// pays out above the true sum.
fn sell_proceeds(datum: BondingCurveDatum, from_sold: Int, amount: Int) -> Int {
  let (numerator, denominator) = gross_range(datum, from_sold, amount)
  numerator / denominator
}

/// One fee slice of `gross`, floored. The three slices together take
/// `creator_bps + platform_bps` of the trade; flooring each leaves
/// any remainder with the curve.
fn fee_slice(gross: Int, bps: Int) -> Int {
  gross * bps / bps_denominator
}

/// This validator's own input — the one being spent.
fn own_input_of(self: Transaction, own_ref: OutputReference) -> Input {
  expect Some(found) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  found
}

/// The continuing output, or None when there is none.
///
/// Option-shaped ON PURPOSE, and this is the important half of the pair: a
/// transaction with NO continuing output is a real thing an attacker sends —
/// it is what draining this UTXO looks like — and some callers have to REJECT
/// that cleanly rather than abort on it. Anything that must tell "no continuing
/// output" apart from "wrong continuing output" belongs here.
fn own_output_opt(self: Transaction, own_address: Address) -> Option<Output> {
  list.find(self.outputs, fn(output) { output.address == own_address })
}

/// The continuing output, required — aborts when absent.
///
/// Only for callers already guaranteed one by an earlier check in the same
/// `and` block. If you are not sure, you want `own_output_opt`.
fn own_output_required(self: Transaction, own_address: Address) -> Output {
  expect Some(found) = own_output_opt(self, own_address)
  found
}

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> BondingCurveDatum {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: BondingCurveDatum = raw_datum
  new_datum
}

/// Verify the buyer's `gross_payment` lovelace actually increased the
/// validator's own continuing output by exactly that amount.
///
/// Fix (2026-07-09): before this, `gross_payment` was purely
/// self-reported — `token_delivered` below checked the buyer received
/// their tokens, but nothing checked the buyer actually paid anything.
/// Same class of gap as bonding_curve.compact's missing `receiveUnshielded`
/// (fixed the same day on the Midnight side); here the equivalent is
/// checking the UTXO's own lovelace value increased, since Cardano's value
/// model makes real payment a property of the transaction's outputs, not
/// something a circuit declares as an effect.
fn payment_received(
  self: Transaction,
  own_ref: OutputReference,
  gross_payment: Int,
) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) + gross_payment
}

/// Batch delivery: THIS ORDER must be filled. `token_delivered` below only
/// asks that some output holds the amount, which is enough with one buyer in a
/// transaction and wrong with N.
///
/// Tagged with the ORDER's reference rather than the curve's, because one
/// owner may hold several orders in a batch and is owed for each. Tagging by
/// the curve's own reference would make every fill in the batch carry the same
/// tag, and a check that cannot tell two of an owner's fills apart accepts one
/// payment for both — which is the whole reason a fill names what it settles.
fn tokens_paid_to(
  self: Transaction,
  order_ref: OutputReference,
  datum: BondingCurveDatum,
  owner: VerificationKeyHash,
  token_amount: Int,
) -> Bool {
  let cred = from_verification_key(owner).payment_credential
  list.any(
    self.outputs,
    fn(output: Output) {
      and {
        settlement.settles(output, order_ref),
        output.address.payment_credential == cred,
        assets.quantity_of(
          output.value,
          datum.token_policy_id,
          datum.token_asset_name,
        ) >= token_amount,
      }
    },
  )
}

fn token_delivered(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveDatum,
  token_amount: Int,
) -> Bool {
  list.any(
    self.outputs,
    fn(output: Output) {
      and {
        settlement.settles(output, own_ref),
        assets.quantity_of(output.value, datum.token_policy_id, datum.token_asset_name) == token_amount,
      }
    },
  )
}

/// Bonus fix found while designing Graduate (2026-07-10): verify the curve's OWN
/// continuing output's token balance actually decreased by `token_amount` —
/// the delivery-side mirror of `payment_received`'s payment-side check.
/// Without this, `token_delivered` above only proves SOME output received
/// tokens, not that they came from the curve's own reserve — a buyer could
/// self-supply the "delivery" from tokens they already hold, inflating
/// `tokens_sold` (and therefore triggering Graduated) without the curve's
/// real balance ever shrinking. Matters concretely now that
/// `lp_reserve_tokens` sits in this same UTXO: a falsely-triggered
/// Graduated state would let Graduate try to pay out a reserve that isn't
/// really backed.
fn curve_token_balance_decreased(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveDatum,
  token_amount: Int,
) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  assets.quantity_of(
    own_input.output.value,
    datum.token_policy_id,
    datum.token_asset_name,
  ) == assets.quantity_of(
    own_output.value,
    datum.token_policy_id,
    datum.token_asset_name,
  ) + token_amount
}

/// Fix (2026-07-16): caps how many distinct (policy, asset name)
/// entries a script-controlled output may hold. Found by comparing against
/// MeshJS's own open-source escrow.ak, which names this the "unbounded
/// value vulnerability" and fixes it the same way (value_length <= 9 —
/// tighter here at 2, since Noctis's own outputs only ever legitimately
/// hold lovelace + one tracked launch token, unlike MeshJS's escrow which
/// genuinely allows multiple asset kinds per party by design). Without
/// this, the curve's own continuing UTXO — spent and re-created on every
/// single buy for the launch's entire life — could be padded with junk
/// native assets by any buyer, inflating the execution-unit cost of every
/// subsequent buy until the curve becomes expensive or impossible to
/// interact with. Not a fund-theft risk; a griefing/availability one.
fn output_value_clean(output: Output, max_assets: Int) -> Bool {
  list.length(assets.flatten(output.value)) <= max_assets
}

/// The curve's whole value, byte for byte, carried into the continuing output.
///
/// For the redeemers that only advance state. Pinning the continuing DATUM
/// says nothing at all about the continuing VALUE, so a state transition
/// without this is also a withdrawal of everything the curve holds — the
/// lovelace it raised and its unsold token reserve — while still writing a
/// datum the validator accepts. Compares the full `Value` rather than just
/// lovelace, so the token reserve is covered too.
///
/// Uses `own_output_required` deliberately: `thread_nft_intact` runs earlier
/// in the same short-circuiting `and`, so by the time any redeemer branch
/// evaluates, a continuing output is already guaranteed to exist.
fn curve_value_unchanged(self: Transaction, own_ref: OutputReference) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_output = own_output_required(self, own_input.output.address)
  own_output.value == own_input.output.value
}

/// The curve's own continuing output specifically — looked up the
/// same way payment_received/curve_token_balance_decreased already do.
fn curve_own_output_clean(self: Transaction, own_ref: OutputReference) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  // 3, not 2, since the thread NFT was added: lovelace + the launch token + this launch's own
  // curve thread NFT.
  output_value_clean(own_output, 3)
}

/// State authentication (2026-08-03 audit) — the launch's own thread NFT must be present on the UTXO being
/// spent AND on the continuing output.
///
/// Every validator in this project is unparameterized, so all the linear curve
/// launches share ONE curve address and a UTXO's legitimacy would otherwise
/// rest entirely on a datum anyone can author (paying to a script address
/// never runs its validator). Requiring the NFT on the INPUT means an
/// attacker-authored UTXO at this address cannot be spent through this
/// validator at all; requiring it on the OUTPUT means it cannot be stripped
/// mid-life, which would make the UTXO forgeable from that point on.
///
/// The policy is minted once per launch at genesis under a
/// governor-signature native script, so no attacker can produce a matching
/// token. Applied once at the top of the validator alongside
/// single_own_utxo rather than duplicated into every redeemer branch —
/// every redeemer here produces a continuing output, so there is no path
/// this wrongly blocks.
fn thread_nft_intact(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveDatum,
) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let name =
    thread_nft.thread_asset_name(
      thread_nft.role_bonding_curve,
      datum.launch_id,
    )
  // Deliberately `when ... is None -> False` rather than `expect Some(..)`:
  // a transaction that produces NO continuing output at this address would
  // destroy the thread NFT, and that must be a clean rejection rather than
  // a script crash. Both reject the transaction on-chain, but returning
  // False keeps the failure attributable to this check.
  when own_output_opt(self, own_address) is {
    None -> False
    Some(own_output) -> and {
        assets.quantity_of(own_input.output.value, datum.thread_nft_policy, name) == 1,
        assets.quantity_of(own_output.value, datum.thread_nft_policy, name) == 1,
      }
  }
}

/// Fix (2026-07-19, full-suite security audit): closes a
/// double-satisfaction risk. Every value-check helper in this file locates
/// "this input's own continuing output" by ADDRESS ONLY
/// (list.find/list.any on own_address) — not by a per-UTXO beacon token or
/// input-index correlation. Since every linear-curve launch's curve shares ONE
/// fixed, unparameterized script address (no constructor params — see this
/// file's own header), a transaction combining inputs from TWO DIFFERENT
/// launches' curves in one transaction would make every such lookup
/// resolve to whichever matching output happens to come first, not
/// necessarily the one that specific input's own checks intend — the
/// classic eUTXO "double satisfaction" bug shape. Requiring AT MOST ONE
/// input and AT MOST ONE output at this contract's own address, for the
/// WHOLE transaction, makes every list.find/list.any call in this file
/// unambiguous by construction: there is only ever one real candidate to
/// find. Applied once at the top of the validator (see `spend` below)
/// rather than duplicated into every redeemer branch.
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

/// Verify the caller actually sent token_amount of
/// the launch token INTO this contract's own continuing output (the
/// reverse of token_delivered). Originally ClaimBuyback-only ("the
/// buyback's return-the-tokens half"); reused as-is by SellTokens —
/// the check is identical regardless of which redeemer needs "tokens flow
/// into the curve" verified.
fn tokens_returned_to_curve(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveDatum,
  token_amount: Int,
) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  assets.quantity_of(own_output.value, datum.token_policy_id, datum.token_asset_name) == assets.quantity_of(
    own_input.output.value,
    datum.token_policy_id,
    datum.token_asset_name,
  ) + token_amount
}

/// Verify this contract's own continuing
/// output lovelace decreased by exactly `share`, and `recipient_key_hash`
/// actually received `share` lovelace in some output (reverse of
/// payment_received). Originally ClaimBuyback-only; reused as-is by
/// SellTokens (seller in place of buyer) and ClaimPlatformFees
/// (governor in place of buyer) — the check is
/// identical regardless of which redeemer needs "lovelace flows out of the
/// curve to X" verified. ClaimCreatorFees needs a different, two-way
/// check (money out AND platform_claim_fee in, same transaction) — see its
/// own match arm below, not this helper.
///
/// Fix (2026-07-22): previously compared the FULL output address
/// against `from_verification_key(recipient_key_hash)` — Aiken stdlib's
/// real `from_verification_key` (confirmed against the installed
/// `aiken-lang/stdlib` source) constructs a bare ENTERPRISE address (no
/// stake credential), not the recipient's real base address. Since this
/// helper is shared by all four redeemers above, that meant EVERY one of
/// them (not just ClaimBuyback, which is where this was first found) could
/// only pay out to a derived enterprise address, never the recipient's own
/// real wallet address directly. Not a security bug (the recipient's own
/// key controls either address identically), but a real UX footgun — funds
/// landing somewhere a normal wallet UI doesn't automatically surface —
/// and it forced every off-chain submitter for all four redeemers to
/// separately re-derive that same enterprise address rather than just
/// paying the recipient's real address. Fixed by comparing only the
/// PAYMENT CREDENTIAL, matching the same `.address.payment_credential`
/// idiom this file already uses elsewhere (`lp_escrow_credential`/
/// `staking_pool_credential`/`cto_governance_credential` checks) — any
/// output whose payment credential matches `recipient_key_hash`,
/// enterprise or base, satisfies this now.
/// Batch proceeds: THIS ORDER's seller must be paid, tagged with the order it
/// settles — the sell-side twin of `tokens_paid_to`.
///
/// Deliberately does NOT check the curve's own balance, unlike the
/// single-trade `lovelace_paid_from_curve` below. That one asks the curve to
/// have decreased by exactly this payout, which is true of a lone sell and
/// false of every sell in a batch of several. A batch checks its own balance
/// once, against the fold's totals — see `batch_value_conserved`.
fn order_proceeds_paid(
  self: Transaction,
  order_ref: OutputReference,
  owner: VerificationKeyHash,
  net: Int,
) -> Bool {
  let cred = from_verification_key(owner).payment_credential
  list.any(
    self.outputs,
    fn(output) {
      and {
        settlement.settles(output, order_ref),
        output.address.payment_credential == cred,
        assets.lovelace_of(output.value) >= net,
      }
    },
  )
}


fn lovelace_paid_from_curve(
  self: Transaction,
  own_ref: OutputReference,
  recipient_key_hash: VerificationKeyHash,
  share: Int,
) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_output = own_output_required(self, own_input.output.address)
  and {
    assets.lovelace_of(own_input.output.value) == assets.lovelace_of(own_output.value) + share,
    // The recipient half is exactly what a batched fill checks, tagged with
    // the curve's own reference because a lone payout settles the curve spend
    // itself rather than an order.
    order_proceeds_paid(self, own_ref, recipient_key_hash, share),
    // ...and the recipient really is better off by it. Unlike a batched fill,
    // this path is signed by the recipient, so the transaction can spend the
    // recipient's OWN utxos — and an output at their credential holding the
    // share is then equally consistent with their change coming back. Netting
    // their inputs out leaves only what arrived from somewhere else. See
    // noctis/settlement's net_lovelace_gain.
    settlement.net_lovelace_gain(
      self,
      from_verification_key(recipient_key_hash).payment_credential,
    ) >= share,
  }
}

/// Verify the curve's own continuing output lovelace decreased by
/// exactly `lp_ada` AND its token balance decreased by exactly
/// `lp_reserve_tokens` — the "funds actually left the curve" half of
/// Graduate, same real-value-movement discipline as lovelace_paid_from_curve /
/// tokens_returned_to_curve above.
fn graduation_funds_left_curve(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveDatum,
  lp_ada: Int,
) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  let lovelace_ok =
    assets.lovelace_of(own_input.output.value) == assets.lovelace_of(own_output.value) + lp_ada
  // staking_reserve_tokens leaves the curve alongside lp_reserve_tokens
  // in the same Graduate transaction, when the launch opted in (0 otherwise).
  let tokens_leaving = datum.lp_reserve_tokens + datum.staking_reserve_tokens
  let tokens_ok =
    assets.quantity_of(
      own_input.output.value,
      datum.token_policy_id,
      datum.token_asset_name,
    ) == assets.quantity_of(
      own_output.value,
      datum.token_policy_id,
      datum.token_asset_name,
    ) + tokens_leaving
  lovelace_ok && tokens_ok
}

/// Fix: real evidence a vote actually passed, replacing a
/// bare governor signature. Before this, TriggerCTO/DissolveCTO required
/// only `list.has(self.extra_signatories, datum.governor_pub_key_hash)` —
/// no check anywhere that a real community vote ever happened, let alone
/// passed. A compromised or rogue governor could unilaterally seize any
/// launch's creator fees with zero community involvement. Fixed by
/// requiring a reference input at cto_governance.ak's own fixed address
/// (`datum.cto_governance_credential`, set at genesis) showing a real
/// anchored `last_executed_proposal` for THIS launch matching the
/// expected type/outcome/recipient. `last_executed_proposal` — not the
/// clearable `active_proposal` — specifically because a governor could
/// otherwise let a vote pass, then call cto_governance.ak's
/// governor-only `ClearProposal` before this reference-input check ever
/// ran against it, erasing the only on-chain evidence and reopening the
/// same gap. See that field's own doc comment in cto_governance.ak.
///
/// Once this evidence exists, the redeemer becomes fully permissionless —
/// same "the passed state is the authorization" idiom already used for
/// ExpireCurve/Graduate in this file. Residual, low-probability risk
/// worth naming: `last_executed_proposal` is a single slot that a LATER,
/// unrelated proposal could in principle overwrite before this call ever
/// fires — cto_governance.ak's own 90-day mandatory cooldown between any
/// two proposals gives a wide real-world window to act on it first.
/// `expected_recipient` is only meaningful for SilenceLockTrigger —
/// cto_governance.ak's own AnchorVoteResult only ever copies
/// `allocation_recipient_hash` into the new community wallet for that
/// proposal type (DissolveCTOProposal always resets it to empty
/// regardless of whatever value was submitted), so checking it for
/// dissolve would test an arbitrary, meaningless value. Pass `None` for
/// DissolveCTOProposal, where the proposal_type + outcome +
/// execution_status match is the only real evidence needed.
fn cto_vote_verified(
  self: Transaction,
  datum: BondingCurveDatum,
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
    // 2026-08-03 audit: the asset name is now role-tagged rather than the
    // bare launch_id, so one policy can carry a distinct thread NFT for
    // each of this launch's state UTXOs. See noctis/thread_nft.
    assets.quantity_of(
      cto_ref_input.output.value,
      datum.thread_nft_policy,
      thread_nft.thread_asset_name(
        thread_nft.role_cto_governance,
        datum.launch_id,
      ),
    ) == 1,
    cto_datum.launch_id == datum.launch_id,
    executed.proposal_type == proposal_type,
    executed.outcome == Passed,
    executed.execution_status == Executed,
    recipient_ok,
  }
}

/// The identity currently allowed to claim creator fees — the creator's own
/// key, or (once CTO has been triggered) the community wallet. Mirrors
/// lp_escrow.ak's active_fee_recipient exactly.
fn active_fee_recipient(datum: BondingCurveDatum) -> VerificationKeyHash {
  if datum.cto_triggered {
    datum.community_pub_key_hash
  } else {
    datum.creator_pub_key_hash
  }
}

/// Verify an output at the launch's own `lp_escrow_credential` holds
/// AT LEAST `lp_ada` lovelace and exactly `lp_reserve_tokens` of the launch
/// token — the "funds actually arrived at the LP" half of Graduate.
///
/// Fix (2026-07-17): the lovelace check was previously EXACT equality
/// (`== lp_ada`), which can never be satisfied in a real transaction —
/// `lp_escrow.ak`'s genesis placeholder UTXO always holds a non-zero
/// min-ADA balance BEFORE `SealLock` runs (a real, unavoidable Cardano
/// requirement — no UTXO can hold 0 lovelace), and `SealLock`'s own
/// `lp_value_received` check is RELATIVE (`own_output == own_input +
/// seeded_ada`), so the real resulting output always holds MORE than
/// `lp_ada` alone (existing balance + lp_ada). The two checks were
/// mathematically incompatible for any real, already-funded lp_escrow
/// UTXO — confirmed by a real, on-chain-reproduced Graduate+SealLock
/// transaction failure (see internal tracking), then isolated to
/// this exact line via `aiken tx simulate` (redeemer-index-to-input
/// mapping showed the FAILING redeemer was Graduate, not SealLock — the
/// opposite of the original bisection's conclusion) and confirmed with a
/// minimal Aiken unit test modeling a realistic (non-zero) pre-existing
/// lp_escrow balance. `graduation_funds_left_curve` already enforces an
/// EXACT decrease on the curve's OWN side, and `lp_value_received`
/// already enforces an EXACT relative increase on lp_escrow's OWN side —
/// this check only needs to confirm real value arrived, not re-derive an
/// absolute amount it has no way to know (it doesn't see lp_escrow's
/// pre-existing balance). `>=` closes the gap without weakening any
/// invariant: nothing is gained by an attacker padding this output with
/// EXTRA lovelace from a third source (same "harmless donation" reasoning
/// already applied elsewhere in this file).
/// **These outputs must carry NO stake credential.** `Graduate` is
/// permissionless — the condition is the authorization — so whoever submits it
/// chooses the addresses it creates. Matching only the payment credential lets
/// them attach a staking credential of their own to the LP escrow, which then
/// delegates locked LP to their pool for the whole 365-day lock, and survives
/// every later escrow spend because `lp_escrow.ak` matches its continuing
/// output by full address. The same applies to the staking pool's own reserve.
///
/// `None` rather than a credential named in the datum: an honest graduation
/// already builds a bare script address, so this costs nothing today, and
/// delegating protocol LP deliberately would be a feature with a datum field
/// behind it rather than something any submitter may decide.
fn lp_seeding_output_ok(
  self: Transaction,
  datum: BondingCurveDatum,
  lp_ada: Int,
) -> Bool {
  list.any(
    self.outputs,
    fn(output) {
      output.address.payment_credential == datum.lp_escrow_credential && output.address.stake_credential == None && assets.lovelace_of(
        output.value,
      ) >= lp_ada && assets.quantity_of(
        output.value,
        datum.token_policy_id,
        datum.token_asset_name,
      ) == datum.lp_reserve_tokens && assets.quantity_of(
        output.value,
        datum.thread_nft_policy,
        thread_nft.thread_asset_name(
          thread_nft.role_lp_escrow,
          datum.launch_id,
        ),
      ) == 1 && output_value_clean(output, 3)
    },
  )
}

/// Verify an output at the launch's own `staking_pool_credential` holds
/// exactly `staking_reserve_tokens` of the launch token — the "funds
/// actually arrived at the staking pool" half of Graduate. Trivially true
/// when the launch never opted into staking (staking_enabled == False),
/// same "0 means nothing to check" convention as lp_reserve_tokens would
/// use if it were ever optional.
fn staking_seeding_output_ok(self: Transaction, datum: BondingCurveDatum) -> Bool {
  if !datum.staking_enabled {
    True
  } else if !staking_pool_datum.terms_are_real(
    datum.staking_reserve_tokens,
    datum.staking_duration_days,
  ) {
    False
  } else {
    list.any(
      self.outputs,
      fn(output) {
        and {
          output.address.payment_credential == datum.staking_pool_credential,
          output.address.stake_credential == None,
          assets.quantity_of(
            output.value,
            datum.token_policy_id,
            datum.token_asset_name,
          ) == datum.staking_reserve_tokens,
          assets.quantity_of(
            output.value,
            datum.thread_nft_policy,
            thread_nft.thread_asset_name(
              thread_nft.role_staking_pool,
              datum.launch_id,
            ),
          ) == 1,
          output_value_clean(output, 3),
          // The pool's OPENING DATUM, pinned field for field rather than left
          // to whoever submits the graduation. Graduate is permissionless, so
          // an unchecked datum here is an unchecked datum written by a
          // stranger: an emission rate that empties the pool in an afternoon,
          // a budget of zero, or — the one that takes the money — a
          // `stake_root` already crediting its author with the whole reserve,
          // ready to be unstaked. `genesis` derives every field from terms
          // fixed at launch creation, including the rate, so there is nothing
          // left to choose.
          //
          // The opening timestamp is the one field a submitter supplies, and
          // the validity range is what keeps it honest — same
          // contains-plus-narrow idiom every other timestamp in this file
          // uses.
          when output.datum is {
            InlineDatum(raw) -> {
              expect opened: staking_pool_datum.StakingPoolDatum = raw
              and {
                interval.contains(self.validity_range, opened.last_update_ms),
                validity_range_is_narrow(
                  self.validity_range,
                  max_validity_range_width,
                ),
                opened == staking_pool_datum.genesis(
                  datum.launch_id,
                  datum.creator_pub_key_hash,
                  datum.token_policy_id,
                  datum.token_asset_name,
                  datum.thread_nft_policy,
                  datum.staking_reserve_tokens,
                  datum.staking_duration_days,
                  opened.last_update_ms,
                  datum.governor_pub_key_hash,
                ),
              }
            }
            _ -> False
          },
        }
      },
    )
  }
}

/// The cumulative wallet cap's read-and-rewrite, in one call: proves `before`
/// is this key's real running total under `datum.cap_root`, and returns the
/// root it becomes at `after`. Lives in `noctis/cap_accumulator` because Cardano Launch
/// runs the identical tree and one off-chain builder serves both — see that
/// module's own header for the whole design.
fn cap_transition(
  root: ByteArray,
  cap_key: ByteArray,
  before: Int,
  after: Int,
  proof: List<CapProofStep>,
) -> (Bool, ByteArray) {
  cap_accumulator.transition(root, cap_key, before, after, proof)
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator bonding_curve {
  spend(
    datum_opt: Option<BondingCurveDatum>,
    redeemer: BondingCurveRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    let own_input = own_input_of(self, own_ref)

    and {
      // See single_own_utxo's own doc comment — closes the
      // double-satisfaction risk for every redeemer below in one place.
      single_own_utxo(self, own_input.output.address),
      // State authentication (2026-08-03 audit) — see thread_nft_intact's own doc comment. Applied here, once,
      // for the same reason: it holds for every redeemer below.
      thread_nft_intact(self, own_ref, datum),
      when redeemer is {
        ActivateCurve { current_timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.curve_state == Inactive,
          interval.contains(self.validity_range, current_timestamp),
          // `phase_started_at` written here is the origin `ExpireCurve`
          // measures its 90-day backstop from, so this timestamp decides when
          // a stalled curve becomes expirable. Bounding the declared range's
          // width pins it to real chain time, which keeps the permissionless
          // backstop's deadline outside the control of the party who starts
          // the clock. Cardano Launch's equivalent arm carries the same bound.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          new_datum == BondingCurveDatum {
            ..datum,
            curve_state: Active,
            phase_started_at: current_timestamp,
          },
        }
      }

      BuyTokens {
        token_amount,
        buyer_key_hash,
        cap_committed_before,
        cap_proof,
      } -> {
        let remaining = datum.curve_supply - datum.tokens_sold
        // The range being ADDED starts at the current `tokens_sold`.
        let gross_payment = buy_cost(datum, datum.tokens_sold, token_amount)
        let creator_fee = fee_slice(gross_payment, creator_bps)
        let platform_fee = fee_slice(gross_payment, platform_bps)
        let fee_total = creator_fee + platform_fee
        let net_payment = gross_payment - fee_total
        let new_tokens_sold = datum.tokens_sold + token_amount
        let next_state = if new_tokens_sold == datum.curve_supply {
          Graduated
        } else {
          datum.curve_state
        }
        let cap_after = cap_committed_before + token_amount
        let (cap_ok, next_cap_root) =
          cap_transition(
            datum.cap_root,
            buyer_key_hash,
            cap_committed_before,
            cap_after,
            cap_proof,
          )
        let expected_datum =
          BondingCurveDatum {
            ..datum,
            tokens_sold: new_tokens_sold,
            total_raised: datum.total_raised + net_payment,
            creator_fees_accrued: datum.creator_fees_accrued + creator_fee,
            platform_fees_accrued: datum.platform_fees_accrued + platform_fee,
            curve_state: next_state,
            cap_root: next_cap_root,
          }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          datum.curve_state == Active,
          token_amount > 0,
          token_amount <= remaining,
          // A buy always moves real lovelace: the curve's own constants put
          // every position at a positive price, and this makes that a rule
          // the contract enforces rather than a property it assumes.
          gross_payment > 0,
          // The cumulative cap. `cap_ok` is what makes `cap_committed_before`
          // this buyer's REAL total — it has to reach `cap_root` from their
          // own slot — so the sum below is a running total across every
          // earlier buy, not just this one transaction.
          cap_ok,
          cap_after <= datum.wallet_cap,
          // Fix: buyer_key_hash was previously self-reported in the
          // redeemer with no cryptographic binding to who actually signed
          // the tx — matching Cardano Launch's bonding_curve_tier_b.ak, which
          // already had this check. Without it, the creator-block below is
          // not sufficient on its own and the
          // wallet cap itself is theatrical (claim a fresh hash every buy).
          list.has(self.extra_signatories, buyer_key_hash),
          // The creator MAY buy on the public curve. They may never sell
          // (see SellTokens), so ADA they put in can only ever stay in —
          // which is what makes this safe: wash-trading requires a round
          // trip, and there is no way out. Their buys are flagged to the
          // community off-chain by matching this hash.
          //
          // This is also the only enforceable reading of "a creator cannot
          // dump vested allocation": tokens are fungible, so once a creator
          // holds both vested and publicly-bought tokens nothing on chain
          // can tell them apart. Blocking the sell side blocks both.
          new_datum == expected_datum,
          token_delivered(self, own_ref, datum, token_amount),
          payment_received(self, own_ref, gross_payment),
          // Bonus fix (found while designing Graduate): the curve's own reserve
          // must actually shrink by token_amount, not just "some output"
          // claim to hold it.
          curve_token_balance_decreased(self, own_ref, datum, token_amount),
          // The curve's own continuing output can't be padded with
          // junk assets — this UTXO is reused by every future buy.
          curve_own_output_clean(self, own_ref),
        }
      }

      SellTokens {
        token_amount,
        seller_key_hash,
        cap_committed_before,
        cap_proof,
      } -> {
        let new_sold = datum.tokens_sold - token_amount
        // `new_sold` is the LOW edge of the range being REMOVED: selling `n`
        // at `tokens_sold = s` vacates the positions `[s-n, s)`, so that is
        // the range priced — the same one a buy of `n` at `new_sold` pays for.
        let gross_proceeds = sell_proceeds(datum, new_sold, token_amount)
        let creator_fee = fee_slice(gross_proceeds, creator_bps)
        let platform_fee = fee_slice(gross_proceeds, platform_bps)
        let fee_total = creator_fee + platform_fee
        let net_proceeds = gross_proceeds - fee_total
        // Floors at zero rather than going negative: a seller may hold tokens
        // they never bought here, and their slot is empty in that case.
        let cap_after =
          if cap_committed_before > token_amount {
            cap_committed_before - token_amount
          } else {
            0
          }
        let (cap_ok, next_cap_root) =
          cap_transition(
            datum.cap_root,
            seller_key_hash,
            cap_committed_before,
            cap_after,
            cap_proof,
          )
        let expected_datum =
          BondingCurveDatum {
            ..datum,
            tokens_sold: new_sold,
            // Subtract the FULL gross_proceeds (not net_proceeds) —
            // see this redeemer's own doc comment in BondingCurveRedeemer
            // above for the invariant this preserves.
            total_raised: datum.total_raised - gross_proceeds,
            creator_fees_accrued: datum.creator_fees_accrued + creator_fee,
            platform_fees_accrued: datum.platform_fees_accrued + platform_fee,
            cap_root: next_cap_root,
          }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          datum.curve_state == Active,
          token_amount > 0,
          new_sold >= 0,
          // A seller must return real tokens to the curve
          // (`tokens_returned_to_curve` below), so holding them IS the
          // entitlement — there is nothing to look up.
          //
          // The creator block is now EXPLICIT. It used to fall out of the
          // per-wallet purchase total being zero for a creator who can never
          // buy; with no such total, it has to be stated. Without it a
          // creator could sell vested allocation into the curve and draw down
          // principal that public buyers paid in.
          seller_key_hash != datum.creator_pub_key_hash,
          // Still per-transaction on this side: a cumulative bound only ever
          // falls on a sell, so what is worth holding is that no single
          // transaction dumps more than the cap into the curve at once.
          token_amount <= datum.wallet_cap,
          // Releasing headroom is exactly as much a state change as taking it,
          // so a sell carries a proof too — without one, a wallet could sell
          // its position and still be barred from re-entering the launch.
          cap_ok,
          // NOTE: deliberately no `gross_proceeds <= datum.total_raised`
          // guard here — an earlier draft had one, reasoning "don't let
          // total_raised go negative," but tracing a concrete symmetric
          // round-trip (buy 10 at sold=0, immediately sell the same 10
          // back to sold=0) through the numbers showed total_raised going
          // negative by exactly the ORIGINAL buy's fee_total is the
          // CORRECT, expected outcome, not a bug: the SUM invariant
          // (total_raised + 3 accumulators == curve's real lovelace above
          // its base) holds exactly regardless of total_raised's
          // individual sign, because fee_total on both the buy and the
          // sell always lands in the accumulators, never lost. A guard
          // here would have rejected legitimate round-trip sells — the
          // exact transactions this feature exists for. total_raised
          // going negative only means Graduate can't succeed until enough
          // net buying brings it positive again (checked by
          // graduation_funds_left_curve's own real-value-movement
          // requirement) — never a fund-safety issue, since
          // lovelace_paid_from_curve already makes it physically
          // impossible to pay out more real ADA than the curve holds.
          //
          // A sale always returns real lovelace to the seller — the mirror of
          // BuyTokens' `gross_payment > 0`, enforced rather than assumed for
          // the same reason.
          gross_proceeds > fee_total,
          list.has(self.extra_signatories, seller_key_hash),
          new_datum == expected_datum,
          tokens_returned_to_curve(self, own_ref, datum, token_amount),
          lovelace_paid_from_curve(self, own_ref, seller_key_hash, net_proceeds),
          curve_own_output_clean(self, own_ref),
        }
      }

      ClaimCreatorFees { amount, platform_claim_fee } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let own_input = own_input_of(self, own_ref)
        let own_address = own_input.output.address
        let own_output = own_output_required(self, own_address)
        // The curve's own balance moves in TWO directions in the
        // same transaction — `amount` leaves (paid to the claimer),
        // `platform_claim_fee` arrives (paid by the claimer) — a
        // different shape from lovelace_paid_from_curve's single-direction
        // check, so verified directly here rather than via that helper.
        let curve_balance_net_ok =
          assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) - amount + platform_claim_fee
        // Fix (2026-07-22): same payment-credential-only fix as
        // lovelace_paid_from_curve above — this redeemer has its own
        // separate recipient check (not routed through that helper, since
        // it's a two-directional balance check), so needed the identical
        // fix applied here independently.
        let recipient_credential = from_verification_key(active_fee_recipient(datum)).payment_credential
        let recipient_paid =
          list.any(
            self.outputs,
            fn(output) {
              output.address.payment_credential == recipient_credential && assets.lovelace_of(
                output.value,
              ) >= amount && // The payout NAMES this spend, so it answers this claim and no
              // other. See noctis/settlement for why an address-and-amount
              // check alone cannot tell two identical obligations apart.
              settlement.settles(output, own_ref)
            },
          )
        and {
          // CTO fee-redirect fix: was hardcoded to creator_pub_key_hash —
          // now respects cto_triggered via active_fee_recipient.
          list.has(self.extra_signatories, active_fee_recipient(datum)),
          // A claim is for a positive amount. Without this, a negative one
          // passes the bound above and SUBTRACTS from the accrued figure —
          // increasing it — while the value checks stay satisfied because
          // lovelace moves the other way too. Nothing is stolen by that on
          // its own, and no reader should have to work that out.
          amount > 0,
          amount <= datum.creator_fees_accrued,
          platform_claim_fee >= min_platform_claim_fee_lovelace,
          curve_balance_net_ok,
          recipient_paid,
          new_datum == BondingCurveDatum {
            ..datum,
            creator_fees_accrued: datum.creator_fees_accrued - amount,
            platform_fees_accrued: datum.platform_fees_accrued + platform_claim_fee,
          },
          curve_own_output_clean(self, own_ref),
        }
      }

      ClaimPlatformFees { amount } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          // A claim is for a positive amount. Without this, a negative one
          // passes the bound above and SUBTRACTS from the accrued figure —
          // increasing it — while the value checks stay satisfied because
          // lovelace moves the other way too. Nothing is stolen by that on
          // its own, and no reader should have to work that out.
          amount > 0,
          amount <= datum.platform_fees_accrued,
          new_datum == BondingCurveDatum {
            ..datum,
            platform_fees_accrued: datum.platform_fees_accrued - amount,
          },
          lovelace_paid_from_curve(self, own_ref, datum.governor_pub_key_hash, amount),
          curve_own_output_clean(self, own_ref),
        }
      }

      CancelCurve -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.curve_state != Graduated,
          new_datum == BondingCurveDatum { ..datum, curve_state: Cancelled },
          // Cancelling is a state change only. Everything the curve holds
          // stays with it, so ClaimBuyback has principal left to refund.
          curve_value_unchanged(self, own_ref),
        }
      }

      ExpireCurve { current_timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Both live states, not just the trading one. ActivateCurve is
          // governor-signed, so a curve that is minted and never activated
          // depends on one key to move at all — and everything the launch
          // holds sits in this UTXO while it waits. Reaching Inactive from
          // here gives that curve the same 90-day backstop a trading one has,
          // measured from the same field.
          or {
            datum.curve_state == Active,
            datum.curve_state == Inactive,
          },
          interval.contains(self.validity_range, current_timestamp),
          // Bound the declared validity range's own width — see this
          // file's own `validity_range_is_narrow` comment for why.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp > datum.phase_started_at + max_curve_duration,
          new_datum == BondingCurveDatum { ..datum, curve_state: Cancelled },
          // This redeemer is permissionless by design, so the value check
          // is what keeps "anyone may expire a stalled curve" from also
          // meaning "anyone may empty it".
          curve_value_unchanged(self, own_ref),
        }
      }

      ClaimBuyback { token_amount, buyer_key_hash } -> {
        // Fix (2026-07-19, full-suite security audit): total_raised
        // can legitimately go negative after enough SellTokens
        // round-trip activity — see that redeemer's own doc comment for
        // why this is a correct, not buggy, outcome. Left unguarded here,
        // a negative total_raised produced a negative `share`, which
        // inverted this redeemer's own value-conservation checks (the
        // curve would need to INCREASE, not decrease, and "buyer_paid >=
        // negative_number" became trivially true for any output) —
        // breaking this redeemer's whole pro-rata-refund guarantee for
        // every legitimate holder on a curve that saw heavy net selling
        // before being cancelled. Flooring at 0 means: once total_raised
        // is non-positive, there is genuinely no stranded PRINCIPAL left
        // to redistribute this way (any real remaining value has already
        // been reclassified into the fee accumulators via SellTokens'
        // own accounting) — a real, defensible outcome, not a workaround.
        let effective_total_raised = if datum.total_raised > 0 {
          datum.total_raised
        } else {
          0
        }
        // Pro-rata share of the stranded principal, computed with real
        // division (Aiken's Int is arbitrary-precision) — no caller-
        // supplied claim to verify, unlike the Compact-side circuits.
        let share = effective_total_raised * token_amount / datum.tokens_sold
        let new_datum =
          BondingCurveDatum {
            ..datum,
            tokens_sold: datum.tokens_sold - token_amount,
            total_raised: datum.total_raised - share,
          }
        let actual_new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.curve_state == Cancelled,
          token_amount > 0,
          token_amount <= datum.tokens_sold,
          datum.tokens_sold > 0,
          list.has(self.extra_signatories, buyer_key_hash),
          actual_new_datum == new_datum,
          tokens_returned_to_curve(self, own_ref, datum, token_amount),
          lovelace_paid_from_curve(self, own_ref, buyer_key_hash, share),
          curve_own_output_clean(self, own_ref),
        }
      }

      Graduate -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let expected_datum =
          BondingCurveDatum {
            ..datum,
            total_raised: 0,
            lp_seeded: True,
            staking_seeded: True,
          }
        and {
          datum.curve_state == Graduated,
          !datum.lp_seeded,
          !datum.staking_seeded,
          // Fix (2026-07-19, full-suite security audit): a curve can
          // reach tokens_sold == curve_supply (Graduated) while
          // total_raised is non-positive, if enough SellTokens
          // activity happened before the final buy that pushed it to
          // 100%. Left unguarded, Graduate could succeed with
          // total_raised <= 0 — graduation_funds_left_curve's own check
          // degrades to "curve doesn't decrease" (trivially true at 0) and
          // lp_seeding_output_ok's lovelace requirement becomes `>= a
          // non-positive number` (trivially satisfiable by any real
          // output) — producing a real, "Graduated"-labeled launch with a
          // ZERO-ADA-backed, permanently-locked-for-365-days LP position.
          // Unlike ClaimBuyback (where flooring the share at 0 is a
          // legitimate outcome — nothing stranded, nothing owed), silently
          // graduating with a worthless LP would misrepresent what
          // actually happened to anyone trusting the Graduated status or
          // certificate — better to require real, positive backing before
          // this redeemer can ever succeed.
          datum.total_raised > 0,
          graduation_funds_left_curve(self, own_ref, datum, datum.total_raised),
          lp_seeding_output_ok(self, datum, datum.total_raised),
          staking_seeding_output_ok(self, datum),
          // The curve's own post-graduation output, and the two new
          // genesis outputs it creates, can't be padded with junk assets.
          curve_own_output_clean(self, own_ref),
        }
      }

      TriggerCTO { community_pub_key_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Enforcement: permissionless, gated on real anchored vote
          // evidence instead of a bare governor signature — see
          // cto_vote_verified's own doc comment for the full reasoning.
          cto_vote_verified(
            self,
            datum,
            SilenceLockTrigger,
            Some(community_pub_key_hash),
          ),
          !datum.cto_triggered,
          community_pub_key_hash != #"",
          new_datum == BondingCurveDatum {
            ..datum,
            cto_triggered: True,
            community_pub_key_hash: community_pub_key_hash,
          },
          // Redirecting who may later claim the fees moves no value now.
          curve_value_unchanged(self, own_ref),
        }
      }

      DissolveCTO -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Enforcement: same reasoning, gated on a real anchored
          // DissolveCTOProposal instead of a bare governor signature. No
          // recipient to check — see cto_vote_verified's own doc comment
          // for why that field isn't meaningful for this proposal type.
          cto_vote_verified(self, datum, DissolveCTOProposal, None),
          datum.cto_triggered,
          new_datum == BondingCurveDatum {
            ..datum,
            cto_triggered: False,
            community_pub_key_hash: #"",
          },
          curve_value_unchanged(self, own_ref),
        }
      }

      // CRITICAL fix (2026-07-19, full-suite security audit): this was
      // previously `True` — an unconditional pass with ZERO checks. Any
      // transaction spending this UTXO with redeemer=QueryState was fully
      // authorized regardless of what it did with the curve's real value —
      // an unconditional authorization, which must never be possible (buyers' principal, all 3
      // fee accumulators, the LP/staking reserves) reachable by anyone, on
      // every deployed linear-curve launch. QueryState was always DOCUMENTED as
      // "off-chain callers should read the datum directly rather than
      // spend through this redeemer" — the redeemer variant exists so
      // off-chain tooling can reference it as a value, but it must never
      // actually authorize spending. `False` closes this without removing
      // the variant (avoids a wider blast-radius rename across every
      // off-chain caller).
      BatchTrades { orders, batcher_key_hash } -> {
        // UNIFORM CLEARING PRICE — the same rule and the same
        // arithmetic as the quadratic curve; see that file for the reasoning.
        //
        // Every order on a side pays that side's batch average, so position
        // within a batch is worth nothing and the batcher's ordering choice
        // stops being something to police. Both sides are anchored at the
        // position the curve held BEFORE the batch, which is what makes the
        // result independent of the order the batch is listed in.
        let sides =
          list.foldl(
            orders,
            (0, 0),
            fn(order, acc) {
              let (buys, sells) = acc
              if order.is_buy {
                (buys + order.amount, sells)
              } else {
                (buys, sells + order.amount)
              }
            },
          )
        let (batch_buy_amount, batch_sell_amount) = sides

        // A batch cannot sell back more than the curve has ever sold; the
        // anchored sell range would otherwise start below zero.
        let sell_range_real = batch_sell_amount <= datum.tokens_sold

        let batch_buy_gross =
          if batch_buy_amount > 0 {
            buy_cost(datum, datum.tokens_sold, batch_buy_amount)
          } else {
            0
          }
        let batch_sell_gross =
          if and { batch_sell_amount > 0, sell_range_real } {
            sell_proceeds(
              datum,
              datum.tokens_sold - batch_sell_amount,
              batch_sell_amount,
            )
          } else {
            0
          }

        // tokens_sold is still threaded, for the supply and floor checks and
        // to land the final position — it just no longer sets any price. The
        // cap root still advances per order.
        let folded =
          list.foldl(
            orders,
            (datum.tokens_sold, 0, 0, 0, 0, datum.cap_root, True),
            fn(order, acc) {
              let (sold, ada_in, ada_out, creator_acc, platform_acc, root, ok) =
                acc
              if order.is_buy {
                // Pro-rata slice of the one batch range, rounded UP so the
                // remainder stays with the curve.
                let gross =
                  ( batch_buy_gross * order.amount + batch_buy_amount - 1 ) / batch_buy_amount
                let creator_fee = fee_slice(gross, creator_bps)
                let platform_fee = fee_slice(gross, platform_bps)
                let cap_after = order.cap_committed_before + order.amount
                let (cap_ok, next_root) =
                  cap_transition(
                    root,
                    order.owner,
                    order.cap_committed_before,
                    cap_after,
                    order.cap_proof,
                  )
                (
                  sold + order.amount,
                  ada_in + gross,
                  ada_out,
                  creator_acc + creator_fee,
                  platform_acc + platform_fee,
                  next_root,
                  ok && order.amount > 0 && order.amount <= datum.curve_supply - sold && order.amount >= order.min_received && cap_ok && cap_after <= datum.wallet_cap && order.owner != datum.creator_pub_key_hash && tokens_paid_to(
                    self,
                    order.order_ref,
                    datum,
                    order.owner,
                    order.amount,
                  ),
                )
              } else {
                let new_sold = sold - order.amount
                // Rounded DOWN, so the curve never pays above its own range.
                let gross = batch_sell_gross * order.amount / batch_sell_amount
                let creator_fee = fee_slice(gross, creator_bps)
                let platform_fee = fee_slice(gross, platform_bps)
                let net = gross - creator_fee - platform_fee
                let cap_after =
                  if order.cap_committed_before > order.amount {
                    order.cap_committed_before - order.amount
                  } else {
                    0
                  }
                let (cap_ok, next_root) =
                  cap_transition(
                    root,
                    order.owner,
                    order.cap_committed_before,
                    cap_after,
                    order.cap_proof,
                  )
                (
                  new_sold,
                  ada_in,
                  ada_out + net,
                  creator_acc + creator_fee,
                  platform_acc + platform_fee,
                  next_root,
                  ok && order.amount > 0 && new_sold >= 0 && net >= order.min_received && cap_ok && order.amount <= datum.wallet_cap && order.owner != datum.creator_pub_key_hash && order_proceeds_paid(
                    self,
                    order.order_ref,
                    order.owner,
                    net,
                  ),
                )
              }
            },
          )
        let (
          final_sold,
          ada_in,
          ada_out,
          creator_total,
          platform_total,
          final_cap_root,
          orders_ok,
        ) = folded
        let next_state =
          if final_sold == datum.curve_supply {
            Graduated
          } else {
            datum.curve_state
          }
        let expected_datum =
          BondingCurveDatum {
            ..datum,
            tokens_sold: final_sold,
            total_raised: datum.total_raised + ada_in - creator_total - platform_total - ada_out,
            creator_fees_accrued: datum.creator_fees_accrued + creator_total,
            platform_fees_accrued: datum.platform_fees_accrued + platform_total,
            curve_state: next_state,
            cap_root: final_cap_root,
          }
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.curve_state == Active,
          orders_ok,
          // The batch's sells price from below the pre-batch position, so it
          // cannot sell back more than the curve has ever sold.
          sell_range_real,
          !list.is_empty(orders),
          // Two separate facts, and the batch needs both: the curve's own
          // datum names this key as a batcher, and the transaction really
          // carries its signature. The signature alone proves only that
          // whoever built the batch controls the key they named.
          list.has(datum.batcher_allowlist, batcher_key_hash),
          list.has(self.extra_signatories, batcher_key_hash),
          new_datum == expected_datum,
          // The datum above is a record of what the batch claims; these are
          // the curve's own UTXO actually moving by it, through the same two
          // helpers a single trade uses. Fees stay in the curve until claimed,
          // so the lovelace it keeps is everything taken in less everything
          // paid out.
          payment_received(self, own_ref, ada_in - ada_out),
          curve_token_balance_decreased(
            self,
            own_ref,
            datum,
            final_sold - datum.tokens_sold,
          ),
          curve_own_output_clean(self, own_ref),
        }
      }

      // Who may batch is a running operational decision — a batcher key is
      // rotated, a second one added for redundancy — so it belongs to the
      // governor and to the datum, not to the script. Sealing it at genesis
      // would mean a new address for every such change, and putting it in the
      // redeemer would mean no gate at all.
      //
      // The batch arm is where this is enforced; everything this arm does is
      // hand the batch arm a different list to check against.
      SetBatcherAllowlist { batchers } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          // Bounded because this datum rides in every trade. Without a cap
          // the governor could write a list long enough that no trade fits.
          list.length(batchers) <= max_batcher_allowlist,
          new_datum == BondingCurveDatum { ..datum, batcher_allowlist: batchers },
          // Naming who may batch later moves nothing now.
          curve_value_unchanged(self, own_ref),
        }
      }

      QueryState -> False
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

/// State authentication (2026-08-03 audit) — the thread NFT every curve fixture's own input and continuing
/// output must now carry, matching mock_datum's launch_id (#"01") and
/// thread_nft_policy (#"c0ffee").
///
/// Deliberately derived through thread_nft.thread_asset_name rather than
/// hand-written as a literal: a fixture carrying a hard-coded name would
/// keep passing if the naming scheme changed, which is exactly the blind
/// spot these tests exist to cover.
fn mock_curve_nft() -> assets.Value {
  assets.from_asset(
    #"c0ffee",
    thread_nft.thread_asset_name(thread_nft.role_bonding_curve, #"01"),
    1,
  )
}

/// A realistically funded curve UTXO: the lovelace it has raised, its unsold
/// launch-token reserve, and its thread NFT.
///
/// The state-transition tests use this rather than the NFT alone. With an
/// empty value on both sides, a redeemer that failed to conserve value would
/// have nothing to lose and the suite could not tell the difference — the
/// same lesson `vesting.ak` already records for its own fixtures.
fn mock_curve_funded() -> assets.Value {
  mock_curve_nft()
    |> assets.merge(assets.from_lovelace(250_000_000))
    |> assets.merge(assets.from_asset(#"33", "tok", 900))
}

/// The lp_escrow / staking_pool thread NFTs a Graduate destination output
/// must carry — see lp_seeding_output_ok / staking_seeding_output_ok.
fn mock_lp_escrow_nft() -> assets.Value {
  assets.from_asset(
    #"c0ffee",
    thread_nft.thread_asset_name(thread_nft.role_lp_escrow, #"01"),
    1,
  )
}

fn mock_staking_pool_nft() -> assets.Value {
  assets.from_asset(
    #"c0ffee",
    thread_nft.thread_asset_name(thread_nft.role_staking_pool, #"01"),
    1,
  )
}

// ----------------------------------------------------------------------------
// Cap accumulator fixtures
//
// Derived through `noctis/cap_accumulator`'s own tree construction rather than
// written as literal roots. A hard-coded root would keep every test below
// passing if the leaf layout, the node hash or the depth changed — which is
// the one blind spot these tests exist to cover. Identical to Cardano Launch's, on
// purpose: one tree, two curves.
// ----------------------------------------------------------------------------

/// `key`'s proof against a tree holding exactly `held`. An absent key proves
/// its empty slot, which is what a first-time buyer does.
fn cap_proof(key: ByteArray, held: List<(ByteArray, Int)>) -> List<CapProofStep> {
  cap_accumulator.proof_in(key, held)
}

/// The root of a tree holding exactly `held` — `[]` being what genesis writes.
fn cap_root(held: List<(ByteArray, Int)>) -> ByteArray {
  cap_accumulator.root_of(held)
}

fn cap_total_of(held: List<(ByteArray, Int)>, key: ByteArray) -> Int {
  when list.find(held, fn(e) { e.1st == key }) is {
    Some((_, total)) -> total
    None -> 0
  }
}

fn cap_set(
  held: List<(ByteArray, Int)>,
  key: ByteArray,
  total: Int,
) -> List<(ByteArray, Int)> {
  list.push(list.filter(held, fn(e) { e.1st != key }), (key, total))
}

/// What a batch's orders do to the accumulator, derived from their OWNERS and
/// AMOUNTS rather than from the proofs they carry — so a batch built with a
/// wrong proof still fails against this.
fn held_after(orders: List<BatchOrder>) -> List<(ByteArray, Int)> {
  list.foldl(
    orders,
    [],
    fn(order, held) {
      let before = cap_total_of(held, order.owner)
      let after =
        if order.is_buy {
          before + order.amount
        } else if before > order.amount {
          before - order.amount
        } else {
          0
        }
      cap_set(held, order.owner, after)
    },
  )
}

/// Builds a batch from `(owner, is_buy, amount, min_received)` specs, giving
/// each order the proof it needs against the tree the PRECEDING orders leave
/// behind — which is also exactly what the off-chain batcher has to do.
/// A distinct reference per order, so each fill can be told from the others.
/// Index-derived rather than constant: a fixture where two orders shared a
/// reference would be a fixture that cannot show the difference.
fn order_ref_at(index: Int) -> OutputReference {
  OutputReference { transaction_id: #"0d", output_index: index }
}

fn batch_orders(specs: List<(ByteArray, Bool, Int, Int)>) -> List<BatchOrder> {
  let (_, _, built) =
    list.foldl(
      specs,
      (0, [], []),
      fn(spec, acc) {
        let (index, held, out) = acc
        let (owner, is_buy, amount, min_received) = spec
        let before = cap_total_of(held, owner)
        let after =
          if is_buy {
            before + amount
          } else if before > amount {
            before - amount
          } else {
            0
          }
        let order =
          BatchOrder {
            owner: owner,
            order_ref: order_ref_at(index),
            is_buy: is_buy,
            amount: amount,
            min_received: min_received,
            cap_committed_before: before,
            cap_proof: cap_proof(owner, held),
          }
        (index + 1, cap_set(held, owner, after), list.push(out, order))
      },
    )
  list.reverse(built)
}

fn mock_datum(curve_state: CurveState, tokens_sold: Int) -> BondingCurveDatum {
  BondingCurveDatum {
    launch_id: #"01",
    creator_pub_key_hash: #"11",
    governor_pub_key_hash: #"22",
    base_price: 100,
    max_price: 1000,
    curve_supply: 1000,
    curve_state: curve_state,
    phase_started_at: 0,
    tokens_sold: tokens_sold,
    total_raised: 0,
    creator_fees_accrued: 0,
    platform_fees_accrued: 0,
    wallet_cap: 500,
    token_policy_id: #"33",
    token_asset_name: "tok",
    lp_escrow_credential: from_verification_key(#"ff").payment_credential,
    lp_reserve_tokens: 150,
    lp_seeded: False,
    community_pub_key_hash: #"",
    cto_triggered: False,
    staking_enabled: False,
    staking_pool_credential: from_verification_key(#"aa").payment_credential,
    staking_reserve_tokens: 0,
    staking_duration_days: 0,
    staking_seeded: False,
    cto_governance_credential: from_verification_key(#"dd").payment_credential,
    // Fix: mock governance thread NFT policy — matches the NFT placed in
    // the cto_governance reference input's value in the CTO-vote tests below.
    thread_nft_policy: #"c0ffee",
    // Every slot empty, which is what genesis writes and what leaves the
    // curve open to any wallet with no registration step.
    cap_root: cap_root([]),
    // The one key every batch fixture below signs with, so a fixture that
    // wants to test the allowlist changes exactly this line and nothing else.
    batcher_allowlist: [#"ba"],
  }
}

// ----------------------------------------------------------------------------
// Pricing
//
// mock_datum: base=100, max=1000, curve_supply=1000, so r=900 and
// P(x) = 100 + 900*x/1000. P(0)=100, P(500)=550, P(999)=999.1.
// ----------------------------------------------------------------------------

/// Test helper: proceeds from leaving a position of `chunks` (newest first,
/// each entry a chunk size) starting at `tokens_sold = start`.
fn chunked_exit_proceeds(
  datum: BondingCurveDatum,
  start: Int,
  chunks: List<Int>,
) -> Int {
  when chunks is {
    [] -> 0
    [n, ..rest] -> {
      let low = start - n
      sell_proceeds(datum, low, n) + chunked_exit_proceeds(datum, low, rest)
    }
  }
}

test buying_one_token_costs_the_price_at_that_position() {
  and {
    buy_cost(mock_datum(Active, 0), 0, 1) == 100,
    buy_cost(mock_datum(Active, 500), 500, 1) == 550,
  }
}

test buying_the_whole_curve_costs_the_sum_of_every_token_price() {
  buy_cost(mock_datum(Active, 0), 0, 1000) == 549_550
}

test adjacent_ranges_sum_to_the_range_that_spans_them() {
  let d = mock_datum(Active, 0)
  buy_cost(d, 0, 500) + buy_cost(d, 500, 500) == buy_cost(d, 0, 1000)
}

/// The property the curve's economics rest on: proceeds depend on which
/// positions a trade vacates, never on how the exit is sized or split. Any
/// remainder from integer division falls to the trader, so a split exit is
/// never worth more than a single one.
test chunked_exit_never_beats_a_single_lot() {
  let d = mock_datum(Active, 1000)
  let single = sell_proceeds(d, 0, 1000)
  and {
    single == 549_550,
    chunked_exit_proceeds(d, 1000, [500, 500]) == single,
    chunked_exit_proceeds(d, 1000, [334, 333, 333]) <= single,
    chunked_exit_proceeds(d, 1000, [250, 250, 250, 250]) <= single,
    chunked_exit_proceeds(d, 1000, [1, 999]) <= single,
    chunked_exit_proceeds(d, 1000, [999, 1]) <= single,
    chunked_exit_proceeds(d, 1000, [100, 200, 300, 400]) <= single,
  }
}

/// A buy and a sell of the same size at the same curve position quote the
/// same range, so a round trip returns no more than it cost — before the
/// 1.5% fee is applied on both legs.
test a_round_trip_returns_no_more_than_it_cost() {
  let d = mock_datum(Active, 400)
  buy_cost(d, 400, 100) >= sell_proceeds(d, 400, 100)
}

/// At a position whose price is not a whole number of lovelace, the two
/// directions round opposite ways: P(999) = 999.1.
test rounding_at_a_fractional_price_favours_the_curve() {
  let d = mock_datum(Active, 999)
  and {
    buy_cost(d, 999, 1) == 1000,
    sell_proceeds(d, 999, 1) == 999,
  }
}

test pricing_boundaries() {
  let d = mock_datum(Active, 0)
  and {
    // the very first token
    buy_cost(d, 0, 1) == 100,
    // the very last token, priced just under max
    buy_cost(d, 999, 1) == 1000,
    // a range ending exactly at curve_supply
    buy_cost(d, 500, 500) == 387_275,
  }
}

/// A curve whose price range and supply share no common factor still prices
/// every partial trade as a definite lovelace amount, at every position.
test partial_trades_price_on_a_curve_with_coprime_parameters() {
  let d =
    BondingCurveDatum { ..mock_datum(Active, 0), base_price: 1, max_price: 8 }
  and {
    buy_cost(d, 1, 1) == 2,
    buy_cost(d, 0, 1) == 1,
    buy_cost(d, 0, 1000) == 4_497,
    // and it stays additive
    buy_cost(d, 0, 400) + buy_cost(d, 400, 600) >= buy_cost(d, 0, 1000),
  }
}

test fee_slices_take_one_and_a_half_percent_between_them() {
  and {
    fee_slice(100_000, creator_bps) == 500,
    fee_slice(100_000, platform_bps) == 1_000,
  }
}

/// Each slice floors independently, so the two together take slightly less
/// than 1.5% of an amount that does not divide cleanly — the remainder stays
/// with the curve rather than being paid out twice.
test fee_slices_floor_and_leave_the_remainder_with_the_curve() {
  let gross = 999
  let total = fee_slice(gross, creator_bps) + fee_slice(gross, platform_bps)
  and {
    // floor(999*50/10000) = 4, floor(999*100/10000) = 9
    total == 13,
    total * bps_denominator <= gross * (creator_bps + platform_bps),
  }
}

test activate_curve_succeeds_with_governor_signature() {
  let datum = mock_datum(Inactive, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, curve_state: Active, phase_started_at: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
      validity_range: interval.between(400, 600),
    }

  bonding_curve.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

test activate_curve_fails_without_governor_signature() {
  let datum = mock_datum(Inactive, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, curve_state: Active, phase_started_at: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(400, 600),
      // no extra_signatories — governor never signed
    }

  !bonding_curve.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

// `activate_curve_succeeds_with_governor_signature` with ONE field changed:
// the declared validity range is wider than max_validity_range_width. The
// timestamp is still contained in it, and every other field is identical, so
// the width bound is the only thing this can fail on.
//
// It matters because ActivateCurve writes `phase_started_at`, and that field
// is the origin ExpireCurve measures its 90-day backstop from. A range wide
// enough to hold any timestamp the signer likes would let the party starting
// the clock also choose where its deadline falls.
test activate_curve_rejects_wide_validity_range() {
  let datum = mock_datum(Inactive, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, curve_state: Active, phase_started_at: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
      // The one delta: 600_001 ms wide, one millisecond past the bound.
      // 500 is still inside it, so containment alone would pass.
      validity_range: interval.between(400, 400 + max_validity_range_width + 1),
    }

  !bonding_curve.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

test expire_curve_succeeds_after_deadline_with_no_signature() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // One ms past the 90-day (7_776_000_000ms) deadline from phase_started_at: 0
  let past_deadline = 7_776_000_001
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(
        past_deadline - 100,
        past_deadline + 100,
      ),
      // deliberately no extra_signatories — ExpireCurve is permissionless
    }

  bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

// Identical to expire_curve_succeeds_after_deadline_with_no_signature
// except the declared validity range is far wider than
// max_validity_range_width (600_000ms) — before this fix, ANY caller could
// force-expire a curve immediately after activation by simply declaring a
// wide range and claiming a timestamp near its far end, since
// interval.contains alone never checked how wide the caller's OWN declared
// range was.
test expire_curve_rejects_wide_validity_range() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let past_deadline = 7_776_000_001
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // Real activation was just now (0); a real, honest ExpireCurve tx
      // would declare a narrow range near 0. This one instead spans all
      // the way out to past_deadline, comfortably exceeding
      // max_validity_range_width, to claim current_timestamp is already
      // past the real 90-day deadline when it isn't.
      validity_range: interval.between(0, past_deadline + 100),
    }

  !bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test expire_curve_rejects_before_deadline() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // One ms BEFORE the 90-day (7_776_000_000ms) deadline — should be rejected
  let before_deadline = 7_775_999_999
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(
        before_deadline - 100,
        before_deadline + 100,
      ),
    }

  !bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: before_deadline },
    own_ref,
    self,
  )
}

test expire_curve_rejects_already_graduated_curve() {
  // Fully sold-through curve is Graduated, not Active — ExpireCurve should
  // never be usable to retroactively cancel a successful launch.
  let datum =
    BondingCurveDatum { ..mock_datum(Graduated, 1000), phase_started_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // ms-scale, matches max_curve_duration's real unit
  let past_deadline = 7_776_000_001
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(
        past_deadline - 100,
        past_deadline + 100,
      ),
    }

  !bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test buy_tokens_succeeds_with_correct_price_and_fees() {
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  // Base lovelace already held by the curve UTXO (min-UTXO + whatever's
  // been raised so far) — payment_received checks the continuing output
  // holds exactly this much MORE, so both inputs need a real starting value.
  // Curve also holds its full curve_supply (1000) of the launch token at
  // the start — curve_token_balance_decreased checks this shrinks by
  // exactly token_amount on every buy.
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Buying 10 tokens from sold=0 costs the sum of P(0)..P(9), which is
  // 1040.5 lovelace, rounded up to 1041. Fees: creator 1.0% = 10,
  // treasury 0.6% = 6, ops 0.4% = 4. Net = 1021.
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      // The buy fills this buyer's own slot, and only theirs.
      cap_root: cap_root([(#"dd", 10)]),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1041),
        assets.from_asset(#"33", "tok", 990),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_padded_continuing_output() {
  // Everything about this buy is otherwise correct (price, fees,
  // token delivery, datum update, real payment) — the only difference
  // from buy_tokens_succeeds_with_correct_price_and_fees is a THIRD,
  // unrelated junk asset stuffed into the curve's own continuing output.
  // Before the fix, output_value_clean didn't exist and this would
  // have been accepted — a buyer could pad the curve's reused UTXO with
  // spam assets, degrading every subsequent buyer.
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.merge(
          assets.from_lovelace(base_lovelace + 1041),
          assets.from_asset(#"33", "tok", 990),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_payment_not_actually_received() {
  // Fix regression: everything else about this buy is correct (price,
  // fees, token delivery, datum update) — only the continuing output's
  // lovelace value is unchanged, i.e. the buyer never actually paid the
  // claimed gross_payment. Before this fix, this transaction would have
  // been accepted.
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
    }
  let continuing_output =
    Output {
      address: own_address,
      // No increase at all — claims to have received 1000 lovelace but didn't.
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace),
        assets.from_asset(#"33", "tok", 990),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_underpayment() {
  // Buyer pays 999 lovelace instead of the claimed 1000 — a subtler
  // version of the same gap, proving the check is an exact equality, not
  // just "some positive amount arrived."
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1040),
        assets.from_asset(#"33", "tok", 990),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_missing_token_delivery() {
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
    }
  let continuing_output =
    Output {
      address: own_address,
      // Payment IS correctly received here, and the curve's own balance
      // correctly shrinks — isolates this test to exactly one failure
      // cause (missing external delivery), not several.
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1041),
        assets.from_asset(#"33", "tok", 990),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // No delivery output to the buyer at all this time.
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_tokens_not_sourced_from_curve_reserve() {
  // Bonus fix regression test (found while designing Graduate): the buyer
  // receives 10 tokens (token_delivered passes) but the curve's own
  // reserve never shrinks — as if the buyer supplied their own tokens as
  // "proof of delivery" instead of the curve's reserve actually paying out.
  // Before this fix, this transaction would have been accepted, letting
  // tokens_sold (and therefore Graduated) advance without any real
  // depletion of the curve's reserve.
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
    }
  let continuing_output =
    Output {
      address: own_address,
      // Payment IS correctly received — curve's token balance is
      // UNCHANGED (still 1000), not decreased to 990.
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1041),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_unauthenticated_buyer_key_hash() {
  // Fix regression: everything else about this buy is correct (price,
  // fees, payment, delivery) — but nobody signed as #"dd", so the redeemer's
  // buyer_key_hash is just an unverified claim. Before this fix, this
  // transaction would have been accepted, making the wallet cap trivially
  // bypassable (claim a fresh hash every time) and the creator-block below
  // meaningless (claim a different hash while still being the real signer).
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1041),
        assets.from_asset(#"33", "tok", 990),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      // deliberately no extra_signatories — buyer_key_hash #"dd" is unsigned
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// The CUMULATIVE cap
//
// The linear curve has no DarkVeil, so this is the whole of its cap story: a wallet's 5%
// is spent across every trade it makes, not refreshed per transaction. Each
// test pairs a rejection with the otherwise-identical acceptance, so none can
// pass by rejecting everything.
// ----------------------------------------------------------------------------

/// A fully-formed public buy — correct price, payment, delivery and datum — so
/// the only thing left to reject it is the cap.
///
/// `held` is the accumulator's real contents (and, so the fixture is coherent,
/// the curve's position too). `declared_before` is what the buyer PUTS IN THE
/// REDEEMER, which the understatement test needs to differ from the truth.
fn run_cap_buy(
  buyer: VerificationKeyHash,
  amount: Int,
  declared_before: Int,
  held: List<(ByteArray, Int)>,
) -> Bool {
  let sold = list.foldl(held, 0, fn(e, acc) { acc + e.2nd })
  let datum =
    BondingCurveDatum { ..mock_datum(Active, sold), cap_root: cap_root(held) }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let base = 5_000_000
  let gross = buy_cost(datum, sold, amount)
  let creator_fee = fee_slice(gross, creator_bps)
  let platform_fee = fee_slice(gross, platform_bps)
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base),
          assets.from_asset(#"33", "tok", 1000 - sold),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: sold + amount,
      total_raised: datum.total_raised + gross - creator_fee - platform_fee,
      creator_fees_accrued: datum.creator_fees_accrued + creator_fee,
      platform_fees_accrued: datum.platform_fees_accrued + platform_fee,
      cap_root: cap_root(cap_set(held, buyer, declared_before + amount)),
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [
        Output {
          address: own_address,
          value: assets.merge(mock_curve_nft(), assets.merge(
            assets.from_lovelace(base + gross),
            assets.from_asset(#"33", "tok", 1000 - sold - amount),
          )),
          datum: InlineDatum(new_datum),
          reference_script: None,
        },
        Output {
          address: from_verification_key(buyer),
          value: assets.from_asset(#"33", "tok", amount),
          datum: InlineDatum(own_ref),
          reference_script: None,
        },
      ],
      extra_signatories: [buyer],
    }
  bonding_curve.spend(
    Some(datum),
    BuyTokens {
      token_amount: amount,
      buyer_key_hash: buyer,
      cap_committed_before: declared_before,
      cap_proof: cap_proof(buyer, held),
    },
    own_ref,
    self,
  )
}

/// The property the whole design rests on. Under a per-transaction cap BOTH
/// of these are accepted, because each buy is under 500 on its own.
test tier_a_buy_caps_a_wallet_across_separate_transactions() {
  and {
    // 495 already taken, 5 more lands exactly on the 500 cap.
    run_cap_buy(#"dd", 5, 495, [(#"dd", 495)]),
    // 495 already taken, 10 more would be 505. Identical in every other way.
    !run_cap_buy(#"dd", 10, 495, [(#"dd", 495)]),
  }
}

/// A wallet cannot buy its way past the cap by declaring a smaller history
/// than it has: the proof is taken against the root, and an understated total
/// does not reach it.
test tier_a_buy_rejects_an_understated_committed_total() {
  and {
    run_cap_buy(#"dd", 5, 495, [(#"dd", 495)]),
    // Same buyer, same real 495 in the tree, claiming to hold nothing.
    !run_cap_buy(#"dd", 5, 0, [(#"dd", 495)]),
  }
}

/// One wallet filling its cap leaves every other wallet's untouched — the
/// property that makes a single root a substitute for a per-wallet list.
test tier_a_buy_caps_each_wallet_separately() {
  and {
    run_cap_buy(#"de", 400, 0, [(#"dd", 500)]),
    !run_cap_buy(#"dd", 400, 500, [(#"dd", 500)]),
  }
}

test buy_tokens_allows_creator_buying_own_curve() {
  // The creator may buy publicly. They can never sell (SellTokens blocks
  // them outright), so ADA they commit here can only stay in the curve —
  // there is no round trip to wash-trade with. Their buys are flagged to
  // the community off-chain by matching the buyer hash against
  // `creator_pub_key_hash`. The DarkVeil path stays closed to them, since
  // the Fair Launch Certificate publishes that they bought none.
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      // mock_datum's creator_pub_key_hash is #"11"
      cap_root: cap_root([(#"11", 10)]),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1041),
        assets.from_asset(#"33", "tok", 990),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      // creator DOES sign as themselves — proves the rejection is the
      // creator-identity check, not the signature-authentication fix
      // above (which would also reject an unsigned #"11").
      extra_signatories: [#"11"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"11",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"11", []),
    }

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// SellTokens
// ----------------------------------------------------------------------------

/// Shared starting state for the SellTokens tests: wallet #"dd" already
/// bought 10 tokens at sold=0 (mirrors buy_tokens_succeeds_with_correct_
/// price_and_fees's own resulting state exactly), so selling them back is
/// a real, traceable round trip.
fn sold_state_datum() -> BondingCurveDatum {
  BondingCurveDatum {
    ..mock_datum(Active, 10),
    total_raised: 1026,
    creator_fees_accrued: 5,
    platform_fees_accrued: 10,
  }
}

test sell_tokens_succeeds_symmetric_round_trip() {
  // Selling all 10 tokens back vacates positions 0..9 — the SAME range the
  // original buy paid for. That range is worth 1040.5 lovelace, rounded
  // DOWN to 1040 for a seller against the buyer's 1041, so the round trip
  // costs one lovelace before fees. fee_total = 15 (creator 5 + platform 10),
  // net_proceeds = 1025 paid to the seller.
  let datum = sold_state_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let seller_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace + 1041),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 0,
      // 1026 - 1040 = -14 — see the redeemer's own inline comment for why
      // this is the correct outcome, not a bug.
      total_raised: -14,
      creator_fees_accrued: 10,
      platform_fees_accrued: 20,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1041 - 1025),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(1025),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    SellTokens {
      token_amount: 10,
      seller_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_selling_more_than_ever_bought() {
  let datum = sold_state_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let seller_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace + 1041),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Wallet #"dd" only ever bought 10 (per sold_state_datum) — attempting
  // to sell 11 (as though tokens were topped up via a secondary transfer)
  // must be rejected, per this redeemer's own documented scope limit.
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: -1,
      total_raised: -120,
      creator_fees_accrued: 21,
      platform_fees_accrued: 20,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000 - 1078),
        assets.from_asset(#"33", "tok", 1001),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(1078),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    SellTokens {
      token_amount: 11,
      seller_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_creator_selling_own_curve() {
  // The creator is permanently blocked from BuyTokens, so their
  // The creator block on SellTokens is now an explicit check rather than a
  // side effect of an empty purchase total. This confirms it holds.
  let datum = mock_datum(Active, 10)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(5_000_000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, tokens_sold: 0 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(5_000_000 - 1020),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: creator_address,
      value: assets.from_lovelace(1020),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      extra_signatories: [#"11"],
    }
  let redeemer =
    SellTokens {
      token_amount: 10,
      seller_key_hash: #"11",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"11", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_unauthenticated_seller_key_hash() {
  let datum = sold_state_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let seller_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace + 1041),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -19,
      creator_fees_accrued: 20,
      platform_fees_accrued: 20,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 21),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(1020),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      // No extra_signatories at all — #"dd" never actually signed.
    }
  let redeemer =
    SellTokens {
      token_amount: 10,
      seller_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_a_payout_larger_than_the_range_is_worth() {
  let datum = sold_state_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let seller_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace + 1041),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: 820,
      // Attempts to draw the proceeds of the top of the curve (price 1000,
      // the sold=1000 spot) for a range that actually sits at the bottom.
      creator_fees_accrued: 110,
      platform_fees_accrued: 110,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000 - 9800),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(9800),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    SellTokens {
      token_amount: 10,
      seller_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// Enforcement: TriggerCTO/DissolveCTO gated on real anchored vote
// evidence (reference input into cto_governance.ak) instead of a bare
// governor signature + redirected ClaimCreatorFees
// ----------------------------------------------------------------------------

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
    payout_pub_key_hash: #"55",
    // Fix: must match both the curve datum's thread_nft_policy and the
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
      // Fix: the genuine governance UTXO carries its per-launch thread
      // NFT (policy = the curve datum's thread_nft_policy `#"c0ffee"`,
      // asset_name = launch_id). cto_vote_verified now requires it.
      value: assets.from_asset(
        #"c0ffee",
        thread_nft.thread_asset_name(
          thread_nft.role_cto_governance,
          cto_datum.launch_id,
        ),
        1,
      ),
      datum: InlineDatum(cto_datum),
      reference_script: None,
    },
  }
}

test trigger_cto_succeeds_with_real_anchored_vote() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
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

  bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

// Regression (2026-07-23 audit): a UTXO planted at
// cto_governance_credential with a fully forged "Passed / Executed,
// recipient = attacker" datum but WITHOUT the genuine governance thread NFT
// must NOT satisfy cto_vote_verified — this is the exact free forgery the
// fix closes (paying to a script address never runs its validator, and
// a reference input is never spent). Identical to
// trigger_cto_succeeds_with_real_anchored_vote except the reference input's
// value carries no NFT, so quantity_of(...) == 1 is False and the spend
// cleanly returns False (the ref input exists; it just lacks the NFT — no
// panic, so a plain `!spend(...)` assertion suffices).
test trigger_cto_rejects_forged_governance_utxo_without_nft() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, cto_triggered: True, community_pub_key_hash: #"ee" }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  // FORGED: same governance address, a fully "passed" datum naming the
  // attacker as recipient — but the UTXO does NOT hold the thread NFT.
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

  !bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

// Enforcement: cto_vote_verified's `expect Some(cto_ref_input) = ...`
// panics (rather than returning False) when no matching reference input
// exists — Aiken's `expect` semantics, not a graceful pattern match. A
// `!spend(...)` assertion can't observe a panic, only a clean False, so
// this needs the `fail` test annotation instead (same real pattern already
// used by lp_escrow.ak's execute_dex_change_rejects_with_no_pending_change).
test trigger_cto_rejects_without_reference_input() fail {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // no reference_inputs at all — no evidence a vote ever happened,
      // and a bare governor signature is no longer
      // sufficient on its own either.
      extra_signatories: [#"22"],
    }

  bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

test trigger_cto_rejects_wrong_recipient() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // Real anchored vote exists, but it named a DIFFERENT recipient (#"ff")
  // than what this TriggerCTO call is trying to install (#"ee") — a
  // malicious relayer/governor can't redirect a legitimately-passed vote
  // to an address the community never actually voted for.
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ff")
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

  !bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

test trigger_cto_rejects_wrong_launch_id() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // Real, valid, passed+executed vote — but anchored for a DIFFERENT
  // launch. A shared cto_governance.ak address serves every launch on the
  // platform, so a launch_id mismatch must be rejected, not just a
  // missing reference input entirely.
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum =
    mock_cto_governance_datum(#"99", Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output],
    }

  !bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

test trigger_cto_rejects_if_already_triggered() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      cto_governance_credential: cto_credential,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, community_pub_key_hash: #"ff" }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ff")
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

  !bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ff" },
    own_ref,
    self,
  )
}

test dissolve_cto_succeeds_with_real_anchored_vote() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      cto_governance_credential: cto_credential,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      cto_triggered: False,
      community_pub_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
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

  bonding_curve.spend(Some(datum), DissolveCTO, own_ref, self)
}

// Same `fail`-annotation reasoning as
// trigger_cto_rejects_without_reference_input above.
test dissolve_cto_rejects_without_reference_input() fail {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      cto_governance_credential: cto_credential,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      cto_triggered: False,
      community_pub_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_nft(),
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

  bonding_curve.spend(Some(datum), DissolveCTO, own_ref, self)
}

test dissolve_cto_rejects_if_not_triggered() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      cto_triggered: False,
      community_pub_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
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

  !bonding_curve.spend(Some(datum), DissolveCTO, own_ref, self)
}

/// Shared shape for the ClaimCreatorFees success-path tests below —
/// curve holds 1,000,000 lovelace going in; claimer takes `amount` (200)
/// out and pays `platform_claim_fee` (exactly the floor, 200,000) in, so
/// the curve's continuing output must show 1,000,000 - 200 + 200,000 =
/// 1,199,800.
fn claim_creator_fees_tx(
  datum: BondingCurveDatum,
  new_datum: BondingCurveDatum,
  recipient_key_hash: VerificationKeyHash,
  signer: VerificationKeyHash,
) -> (OutputReference, Transaction) {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_199_800)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let recipient_payout =
    Output {
      address: from_verification_key(recipient_key_hash),
      value: assets.from_lovelace(200),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, recipient_payout],
      extra_signatories: [signer],
    }
  (own_ref, self)
}

test claim_creator_fees_succeeds_via_creator_when_no_cto() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  let (own_ref, self) = claim_creator_fees_tx(datum, new_datum, #"11", #"11")

  bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

/// One delta from claim_creator_fees_succeeds_via_creator_when_no_cto above:
/// the payout no longer names the spend it settles. Everything else — the
/// signature, the amounts, the continuing datum, the curve's own balance —
/// is byte-for-byte the accepted transaction, so this can only be refused by
/// the tag.
test claim_creator_fees_rejects_untagged_payout() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  let (own_ref, self) = claim_creator_fees_tx(datum, new_datum, #"11", #"11")
  expect [continuing, payout] = self.outputs
  let untagged =
    Transaction {
      ..self,
      outputs: [continuing, Output { ..payout, datum: transaction.NoDatum }],
    }

  !bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    untagged,
  )
}

test claim_creator_fees_rejects_creator_once_cto_triggered() {
  // The exact gap this fix closes: before it, the creator could keep
  // claiming bonding-curve fees regardless of a passed CTO vote, since this
  // contract had no CTO concept at all.
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      creator_fees_accrued: 500,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  // Original creator (#"11") signs, not the community wallet — must now be
  // rejected.
  let (own_ref, self) = claim_creator_fees_tx(datum, new_datum, #"11", #"11")

  !bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test claim_creator_fees_succeeds_via_community_wallet_once_cto_triggered() {
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      creator_fees_accrued: 500,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  let (own_ref, self) = claim_creator_fees_tx(datum, new_datum, #"ee", #"ee")

  bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

// Value-conservation requirement identified in the pre-test security review
// describes — draining far more than `amount` while the datum shows only a
// small decrement. Same setup as the success case, except the continuing
// output's lovelace is nowhere near 1,199,800 (most of the curve's balance
// was siphoned off as unaccounted-for "change").
test claim_creator_fees_rejects_draining_more_than_amount() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500, total_raised: 900_000 }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Only 1,800 lovelace left in the curve instead of the real 1,199,800 —
  // the rest (998,200) silently left as change to the signer, with the
  // datum still claiming only a 200-lovelace creator_fees_accrued decrement.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_800)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let recipient_payout =
    Output {
      address: from_verification_key(#"11"),
      value: assets.from_lovelace(200),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, recipient_payout],
      extra_signatories: [#"11"],
    }

  !bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test claim_creator_fees_rejects_platform_fee_below_floor() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveDatum { ..datum, creator_fees_accrued: 300, platform_fees_accrued: 10 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // platform_claim_fee of 10 lovelace — far below the 200,000 floor.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.from_lovelace(999_810)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let recipient_payout =
    Output {
      address: from_verification_key(#"11"),
      value: assets.from_lovelace(200),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, recipient_payout],
      extra_signatories: [#"11"],
    }

  !bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 10 },
    own_ref,
    self,
  )
}

test claim_platform_fees_rejects_without_real_payout() {
  // Same gap as ClaimCreatorFees, applied to the governor's platform-fee
  // claim — datum shows the right decrement, but no output ever pays the
  // governor.
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), platform_fees_accrued: 500 }
  let new_datum = BondingCurveDatum { ..datum, platform_fees_accrued: 300 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      // Curve's own balance never actually shrank.
      value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
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

  !bonding_curve.spend(Some(datum), ClaimPlatformFees { amount: 200 }, own_ref, self)
}

test claim_platform_fees_succeeds_with_real_payout() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), platform_fees_accrued: 500 }
  let new_datum = BondingCurveDatum { ..datum, platform_fees_accrued: 300 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.from_lovelace(999_800)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let governor_payout =
    Output {
      address: from_verification_key(#"22"),
      value: assets.from_lovelace(200),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, governor_payout],
      extra_signatories: [#"22"],
    }

  bonding_curve.spend(Some(datum), ClaimPlatformFees { amount: 200 }, own_ref, self)
}

/// The test above with ONE thing changed: the amount is negative, and every
/// value in the transaction follows it consistently. Without the positivity
/// guard this passes — the bound `amount <= platform_fees_accrued` holds for
/// a negative, subtracting it INCREASES the accrued figure, and the balance
/// checks are satisfied because the lovelace moves the other way too.
///
/// Built as the passing fixture plus one delta rather than by hand, so it
/// cannot pass for some reason other than the one it names.
test claim_platform_fees_rejects_a_negative_amount() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), platform_fees_accrued: 500 }
  let new_datum = BondingCurveDatum { ..datum, platform_fees_accrued: 700 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // The curve GAINS the lovelace, which is what a negative share means.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_200)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let governor_payout =
    Output {
      address: from_verification_key(#"22"),
      value: assets.from_lovelace(200),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, governor_payout],
      extra_signatories: [#"22"],
    }

  !bonding_curve.spend(Some(datum), ClaimPlatformFees { amount: -200 }, own_ref, self)
}

/// Fix (2026-07-22) regression: proves the real fix for
/// lovelace_paid_from_curve, shared by ClaimPlatformFees/
/// SellTokens/ClaimBuyback. Under the OLD exact-full-address check, this
/// test would have FAILED — the governor's real production wallet is
/// always a base address (payment + stake, per WeldPress_CardanoWalletPHP's
/// real wallet generation), never a bare enterprise address, meaning
/// ClaimPlatformFees's real production payout was silently
/// broken before this fix, not just a cosmetic UX gap like ClaimBuyback's
/// already-worked-around case.
test claim_platform_fees_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), platform_fees_accrued: 500 }
  let new_datum = BondingCurveDatum { ..datum, platform_fees_accrued: 300 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.from_lovelace(999_800)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let governor_base_address = from_verification_key(#"22") |> with_delegation_key(#"ee")
  let governor_payout =
    Output {
      address: governor_base_address,
      value: assets.from_lovelace(200),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, governor_payout],
      extra_signatories: [#"22"],
    }

  bonding_curve.spend(Some(datum), ClaimPlatformFees { amount: 200 }, own_ref, self)
}

fn buyback_datum() -> BondingCurveDatum {
  // 100 tokens sold, 1000 lovelace raised (net) — ratio 10 lovelace/token.
  BondingCurveDatum {
    ..mock_datum(Cancelled, 100),
    total_raised: 1000,
  }
}

test claim_buyback_succeeds_with_correct_pro_rata_share() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Buyer returns 10 tokens; share = 1000 * 10 / 100 = 100 lovelace.
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_padded_continuing_output() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.merge(
          assets.from_lovelace(base_lovelace - 100),
          assets.from_asset(#"33", "tok", 10),
        ),
        assets.from_asset(#"deadbeef", "spam", 1),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

/// Fix (2026-07-22) regression: proves the real fix, not just that
/// the old enterprise-address-only behavior still happens to pass. Pays the
/// buyback share to the buyer's REAL BASE ADDRESS (payment credential #"dd"
/// PLUS a stake credential #"ee") — under the old exact-full-address check
/// this would have been rejected (from_verification_key(#"dd") never equals
/// a base address), since only the bare enterprise address ever matched.
test claim_buyback_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_base_address = from_verification_key(#"dd") |> with_delegation_key(#"ee")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_base_address,
      value: assets.from_lovelace(100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_before_curve_cancelled() {
  let datum = BondingCurveDatum { ..buyback_datum(), curve_state: Active }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_unauthenticated_buyer() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      // deliberately no extra_signatories — buyer_key_hash #"dd" is unsigned
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_tokens_not_actually_returned() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  // Pays the ADA share but the tokens never actually flow into the curve's
  // continuing output — still 0 tokens held, claims 10 were returned.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_ada_share_not_actually_paid() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  // Tokens ARE returned, but the curve's lovelace balance never decreases
  // and the buyer receives nothing — no payout output at all.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace),
        assets.from_asset(#"33", "tok", 10),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

fn graduation_datum() -> BondingCurveDatum {
  BondingCurveDatum { ..mock_datum(Graduated, 1000), total_raised: 98_000 }
}

test graduate_succeeds_with_correct_lp_seeding() {
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  // Curve holds the raised ADA plus its own min-UTXO rent, and the 150
  // lp_reserve_tokens set aside at deploy (mock_datum). No sellable tokens
  // remain — tokens_sold == curve_supply, i.e. fully graduated.
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
      // Graduate is permissionless — deliberately no extra_signatories.
    }

  bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

/// Identical to the passing graduation above, except the LP escrow output
/// carries a STAKING CREDENTIAL. Everything else is right — correct script,
/// correct ada, correct tokens, correct thread NFT.
///
/// `Graduate` is permissionless, so whoever submits it picks that credential.
/// It would delegate the locked LP to their own pool for the whole 365-day
/// lock, and `lp_escrow.ak` matches its continuing output by full address, so
/// every later spend would preserve it rather than notice it.
test graduate_rejects_lp_output_carrying_a_staking_credential() {
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  // The same LP script, with somebody's staking credential bolted on.
  let hijacked = from_verification_key(#"ff") |> with_delegation_key(#"5a")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: hijacked,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_padded_lp_output() {
  // Identical to graduate_succeeds_with_correct_lp_seeding, except the
  // new lp_escrow genesis output carries one extra, unrelated junk asset.
  // Graduate is permissionless (see comment below), so ANYONE could
  // otherwise pad the newly-seeded lp_escrow UTXO this way before the
  // fix.
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.merge(
          assets.from_lovelace(98_000),
          assets.from_asset(#"33", "tok", 150),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_before_graduated() {
  let datum = BondingCurveDatum { ..graduation_datum(), curve_state: Active }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_if_already_seeded() {
  let datum = BondingCurveDatum { ..graduation_datum(), lp_seeded: True }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_wrong_lp_destination() {
  // Correct amounts, wrong address — proves the LP credential is actually
  // checked, not just the value totals.
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let wrong_address = from_verification_key(#"ee")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: wrong_address,
      value: assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_underpaid_lp_seeding() {
  // LP output exists at the right address but is short on lovelace —
  // proves the amount is checked exactly, not just "some value arrived."
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 90_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        // Only 90,000 instead of the full 98,000 raised.
        assets.from_lovelace(90_000),
        assets.from_asset(#"33", "tok", 150),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

// Graduate + staking rewards pool seeding

/// The one datum a graduation may open this launch's pool with — derived, not
/// written, so a fixture cannot quietly disagree with what the validator
/// derives for itself.
fn staking_genesis(datum: BondingCurveDatum, opened_at: Int) -> staking_pool_datum.StakingPoolDatum {
  staking_pool_datum.genesis(
    datum.launch_id,
    datum.creator_pub_key_hash,
    datum.token_policy_id,
    datum.token_asset_name,
    datum.thread_nft_policy,
    datum.staking_reserve_tokens,
    datum.staking_duration_days,
    opened_at,
    datum.governor_pub_key_hash,
  )
}

/// When these graduations happen. Any value works; it only has to sit inside
/// the transaction's own validity range.
const graduation_time = 1_700_000_000_000


fn staking_graduation_datum() -> BondingCurveDatum {
  BondingCurveDatum {
    ..graduation_datum(),
    staking_enabled: True,
    staking_reserve_tokens: 250,
    // 250 over 10 days = 25 a day.
    staking_duration_days: 10,
  }
}

test graduate_succeeds_with_lp_and_staking_seeding() {
  let datum = staking_graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let staking_address = from_verification_key(#"aa")
  // Curve holds raised ADA + rent, plus 150 lp_reserve_tokens and 250
  // staking_reserve_tokens set aside at deploy.
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 400),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let staking_output =
    Output {
      address: staking_address,
      value: assets.merge(mock_staking_pool_nft(), assets.from_asset(#"33", "tok", 250)),
      datum: InlineDatum(staking_genesis(datum, graduation_time)),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output, staking_output],
      validity_range: interval.between(
        graduation_time - 100,
        graduation_time + 100,
      ),
    }

  bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_missing_staking_output_when_enabled() {
  // LP seeding is correct, but the staking pool output is entirely
  // missing — proves staking_seeding_output_ok is actually enforced when
  // staking_enabled, not skipped.
  let datum = staking_graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 400),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      // Never actually loses the 250 staking_reserve_tokens.
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 250),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_succeeds_without_staking_output_when_disabled() {
  // Staking never enabled for this launch (staking_reserve_tokens == 0) —
  // Graduate must succeed with only LP seeding, same as the earlier tests.
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      )),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

// QueryState must never authorize a spend. Regression guard: a
// transaction spending a real, funded curve UTXO with
// redeemer=QueryState and its value routed away from the script
// (no signature, no legitimate state transition) must be rejected.
// ============================================================================
// Thread-NFT forge rejection
// ============================================================================
// Each test below is the honest ActivateCurve / Graduate transaction with
// exactly ONE thing changed, so a failure is attributable to that change and
// nothing else. The positive controls are
// activate_curve_succeeds_with_governor_signature and
// graduate_succeeds_with_lp_and_staking_seeding above.

/// The core state-authentication property: a UTXO at this shared script address that does not
/// carry the launch's thread NFT cannot be spent through the validator at all,
/// no matter how well-formed its (attacker-authored) datum is.
test spend_rejects_curve_utxo_without_thread_nft() {
  let datum = mock_datum(Inactive, 0)
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
  let new_datum =
    BondingCurveDatum { ..datum, curve_state: Active, phase_started_at: 500 }
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
      validity_range: interval.between(400, 600),
    }

  !bonding_curve.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

/// The NFT cannot be stripped mid-life: present on the input, absent from the
/// continuing output. Without the output half of the check, one legitimate
/// spend would leave the UTXO forgeable from then on.
test spend_rejects_thread_nft_stripped_from_continuing_output() {
  let datum = mock_datum(Inactive, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, curve_state: Active, phase_started_at: 500 }
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
      validity_range: interval.between(400, 600),
    }

  !bonding_curve.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

/// Role tags are load-bearing: another of this same launch's thread NFTs,
/// minted under the same genuine policy, must not satisfy the curve's check.
test spend_rejects_wrong_role_thread_nft() {
  let datum = mock_datum(Inactive, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        // Genuine policy, genuine launch — wrong role.
        value: mock_lp_escrow_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, curve_state: Active, phase_started_at: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_lp_escrow_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
      validity_range: interval.between(400, 600),
    }

  !bonding_curve.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

/// Identical to graduate_succeeds_with_lp_and_staking_seeding except the
/// lp_escrow destination carries no thread NFT. The destination was
/// previously constrained by payment credential, lovelace and token quantity
/// only; it must also be a genuine, platform-minted escrow UTXO.
test graduate_rejects_lp_output_without_thread_nft() {
  let datum = staking_graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let staking_address = from_verification_key(#"aa")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          mock_curve_nft(),
          assets.merge(
            assets.from_lovelace(base_lovelace),
            assets.from_asset(#"33", "tok", 400),
          ),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        mock_curve_nft(),
        assets.merge(
          assets.from_lovelace(base_lovelace - 98_000),
          assets.from_asset(#"33", "tok", 0),
        ),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      // The one change: no thread NFT on the destination.
      value: assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let staking_output =
    Output {
      address: staking_address,
      value: assets.merge(
        mock_staking_pool_nft(),
        assets.from_asset(#"33", "tok", 250),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output, staking_output],
      validity_range: interval.between(
        graduation_time - 100,
        graduation_time + 100,
      ),
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

/// Same requirement for the staking destination, which carries a larger
/// share of supply than the LP reserve.
test graduate_rejects_staking_output_without_thread_nft() {
  let datum = staking_graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let staking_address = from_verification_key(#"aa")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          mock_curve_nft(),
          assets.merge(
            assets.from_lovelace(base_lovelace),
            assets.from_asset(#"33", "tok", 400),
          ),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        mock_curve_nft(),
        assets.merge(
          assets.from_lovelace(base_lovelace - 98_000),
          assets.from_asset(#"33", "tok", 0),
        ),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        mock_lp_escrow_nft(),
        assets.merge(
          assets.from_lovelace(98_000),
          assets.from_asset(#"33", "tok", 150),
        ),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let staking_output =
    Output {
      address: staking_address,
      // The one change: no thread NFT on the destination.
      value: assets.from_asset(#"33", "tok", 250),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output, staking_output],
      validity_range: interval.between(
        graduation_time - 100,
        graduation_time + 100,
      ),
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test query_state_rejects_unauthenticated_drain_attempt() {
  let datum = mock_datum(Active, 100)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(50_000_000),
          assets.from_asset(#"33", "tok", 900),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // The entire curve balance routed to the attacker — no continuing
  // output at the script address at all.
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(50_000_000),
        assets.from_asset(#"33", "tok", 900),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !bonding_curve.spend(Some(datum), QueryState, own_ref, self)
}

// Closes the double-satisfaction risk found in the full security
// audit — a transaction combining TWO different launches' curve UTXOs
// (same shared script address, different launch_id) must be rejected
// outright, regardless of whether either individual leg looks otherwise
// valid, since no value-check helper in this file can safely disambiguate
// which output belongs to which input once more than one real UTXO from
// this address is present.
test single_own_utxo_rejects_two_curve_inputs_same_tx() {
  let datum_a = mock_datum(Active, 0)
  let datum_b = BondingCurveDatum { ..mock_datum(Active, 0), launch_id: #"02" }
  let own_ref_a = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_ref_b = OutputReference { transaction_id: #"00", output_index: 1 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let input_a =
    Input {
      output_reference: own_ref_a,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum_a),
        reference_script: None,
      },
    }
  let input_b =
    Input {
      output_reference: own_ref_b,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum_b),
        reference_script: None,
      },
    }
  let new_datum_a =
    BondingCurveDatum {
      ..datum_a,
      tokens_sold: 10,
      total_raised: 1026,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
    }
  let continuing_output_a =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1041),
        assets.from_asset(#"33", "tok", 990),
      )),
      datum: InlineDatum(new_datum_a),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      // Tagged for curve A, so the settlement check ACCEPTS this delivery
      // and cannot be what rejects the transaction. single_own_utxo is,
      // which is the check this test is named for.
      datum: InlineDatum(own_ref_a),
      reference_script: None,
    }
  // Curve B's own UTXO is spent too (present as a second input at the
  // same shared address) but has no matching continuing output at all —
  // this is deliberately malformed on curve B's side; the point is that
  // curve A's OWN otherwise-fully-correct BuyTokens must ALSO be rejected
  // purely because a second same-address input exists in the transaction.
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [input_a, input_b],
      outputs: [continuing_output_a, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve.spend(Some(datum_a), redeemer, own_ref_a, self)
}

// Fix regression test: a curve that reaches 100% sold (Graduated)
// with non-positive total_raised (reachable via heavy SellTokens activity
// before the final buy — see SellTokens' own doc comment) must not be
// allowed to graduate with a worthless, zero-backed LP position.
test graduate_rejects_non_positive_total_raised() {
  let datum = BondingCurveDatum { ..mock_datum(Graduated, 1000), total_raised: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(assets.from_lovelace(98_000), assets.from_asset(#"33", "tok", 150))),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, total_raised: 0, lp_seeded: True, staking_seeded: True }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(assets.from_lovelace(98_000), assets.from_asset(#"33", "tok", 0))),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // A real output at the LP address, but with ZERO backing ADA — exactly
  // the "valid-looking but worthless LP" scenario this fix closes.
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(assets.from_lovelace(0), assets.from_asset(#"33", "tok", 150))),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

// ----------------------------------------------------------------------------
// BatchTrades — N orders applied against one curve UTXO (the linear curve, linear)
// ----------------------------------------------------------------------------

fn a_run_batch_signed(
  datum: BondingCurveDatum,
  orders: List<BatchOrder>,
  owner_outputs: List<Output>,
  gross_total: Int,
  batcher: VerificationKeyHash,
) -> Bool {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let base = 5_000_000
  let sold_total = list.foldl(orders, 0, fn(o, acc) { acc + o.amount })
  // Per-order fees come off each order's UNIFORM share, the same basis the
  // validator charges on. These folds used to walk the batch sequentially and
  // still agreed on these fixtures — a fee total taken from a partition of one
  // range is the same under either model unless the flooring happens to differ
  // — so they would have gone on passing while expecting the wrong thing.
  let creator_total =
    list.foldl(
      orders,
      0,
      fn(o, fees) {
        fees + fee_slice(
          a_uniform_buy_share(datum, orders, o.amount),
          creator_bps,
        )
      },
    )
  let platform_total =
    list.foldl(
      orders,
      0,
      fn(o, fees) {
        fees + fee_slice(
          a_uniform_buy_share(datum, orders, o.amount),
          platform_bps,
        )
      },
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          mock_curve_nft(),
          assets.merge(
            assets.from_lovelace(base),
            assets.from_asset(#"33", "tok", 1000),
          ),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: datum.tokens_sold + sold_total,
      total_raised: datum.total_raised + gross_total - creator_total - platform_total,
      creator_fees_accrued: datum.creator_fees_accrued + creator_total,
      platform_fees_accrued: datum.platform_fees_accrued + platform_total,
      cap_root: cap_root(held_after(orders)),
    }
  let continuing =
    Output {
      address: own_address,
      value: assets.merge(
        mock_curve_nft(),
        assets.merge(
          assets.from_lovelace(base + gross_total),
          assets.from_asset(#"33", "tok", 1000 - sold_total),
        ),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: list.concat([continuing], owner_outputs),
      extra_signatories: [#"ba"],
    }
  bonding_curve.spend(
    Some(datum),
    BatchTrades { orders: orders, batcher_key_hash: batcher },
    own_ref,
    self,
  )
}

fn a_run_batch(
  datum: BondingCurveDatum,
  orders: List<BatchOrder>,
  owner_outputs: List<Output>,
  gross_total: Int,
) -> Bool {
  a_run_batch_signed(datum, orders, owner_outputs, gross_total, #"ba")
}

/// A fill for the order at `index`, tagged with that order's own reference.
/// The index matters: it is what makes one owner's two fills distinguishable,
/// so a helper that ignored it would build fixtures unable to fail.
fn a_tok_out(index: Int, owner: VerificationKeyHash, amount: Int) -> Output {
  Output {
    address: from_verification_key(owner),
    value: assets.from_asset(#"33", "tok", amount),
    datum: InlineDatum(order_ref_at(index)),
    reference_script: None,
  }
}

/// Amounts large enough that curve POSITION changes the integer price. On this
/// fixture a small order costs the same wherever it sits, which would make the
/// negative case below unfalsifiable.
fn a_two_orders() -> List<BatchOrder> {
  batch_orders([(#"de", True, 400, 400), (#"df", True, 300, 300)])
}

/// What one buy order pays under uniform pricing: the whole batch's range,
/// split by amount, rounded UP so the curve is never short. The same
/// arithmetic the batch arm does, written out independently of it.
fn a_uniform_buy_share(
  datum: BondingCurveDatum,
  orders: List<BatchOrder>,
  amount: Int,
) -> Int {
  let batch_amount = list.foldl(orders, 0, fn(o, acc) { acc + o.amount })
  let batch_gross = buy_cost(datum, datum.tokens_sold, batch_amount)
  ( batch_gross * amount + batch_amount - 1 ) / batch_amount
}

/// The accepted batch with its continuing value varied by one delta. A datum
/// is a record of what a batch claims; these are the curve's own UTXO failing
/// to move by it.
fn a_run_batch_drained(
  datum: BondingCurveDatum,
  orders: List<BatchOrder>,
  owner_outputs: List<Output>,
  gross_total: Int,
  lovelace_delta: Int,
  token_delta: Int,
) -> Bool {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let base = 5_000_000
  let sold_total = list.foldl(orders, 0, fn(o, acc) { acc + o.amount })
  // Per-order fees come off each order's UNIFORM share, the same basis the
  // validator charges on. These folds used to walk the batch sequentially and
  // still agreed on these fixtures — a fee total taken from a partition of one
  // range is the same under either model unless the flooring happens to differ
  // — so they would have gone on passing while expecting the wrong thing.
  let creator_total =
    list.foldl(
      orders,
      0,
      fn(o, fees) {
        fees + fee_slice(
          a_uniform_buy_share(datum, orders, o.amount),
          creator_bps,
        )
      },
    )
  let platform_total =
    list.foldl(
      orders,
      0,
      fn(o, fees) {
        fees + fee_slice(
          a_uniform_buy_share(datum, orders, o.amount),
          platform_bps,
        )
      },
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          mock_curve_nft(),
          assets.merge(
            assets.from_lovelace(base),
            assets.from_asset(#"33", "tok", 1000),
          ),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: datum.tokens_sold + sold_total,
      total_raised: datum.total_raised + gross_total - creator_total - platform_total,
      creator_fees_accrued: datum.creator_fees_accrued + creator_total,
      platform_fees_accrued: datum.platform_fees_accrued + platform_total,
      cap_root: cap_root(held_after(orders)),
    }
  let continuing =
    Output {
      address: own_address,
      value: assets.merge(
        mock_curve_nft(),
        assets.merge(
          assets.from_lovelace(base + gross_total + lovelace_delta),
          assets.from_asset(#"33", "tok", 1000 - sold_total + token_delta),
        ),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: list.concat([continuing], owner_outputs),
      extra_signatories: [#"ba"],
    }
  bonding_curve.spend(
    Some(datum),
    BatchTrades { orders: orders, batcher_key_hash: #"ba" },
    own_ref,
    self,
  )
}

test tier_a_batch_accepts_the_shape_the_rejections_vary() {
  let d = mock_datum(Active, 0)
  a_run_batch_drained(
    d,
    a_two_orders(),
    [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)],
    buy_cost(d, 0, 400) + buy_cost(d, 400, 300),
    0,
    0,
  )
}

test tier_a_batch_rejects_keeping_the_payment() {
  let d = mock_datum(Active, 0)
  let gross = buy_cost(d, 0, 400) + buy_cost(d, 400, 300)
  !a_run_batch_drained(
    d,
    a_two_orders(),
    [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)],
    gross,
    -gross,
    0,
  )
}

test tier_a_batch_rejects_leaving_the_reserve_intact() {
  let d = mock_datum(Active, 0)
  let gross = buy_cost(d, 0, 400) + buy_cost(d, 400, 300)
  !a_run_batch_drained(
    d,
    a_two_orders(),
    [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)],
    gross,
    0,
    700,
  )
}


/// Every order in a batch pays the batch average. The curve is linear where
/// the other is quadratic, so the arithmetic is genuinely separate, not a copy.
///
/// THE AGGREGATE TRANSACTION IS THE SAME UNDER BOTH PRICING MODELS on this
/// fixture, and that is not a quirk worth hiding: a range cost is additive, so
/// the curve takes 290,185 either way, and on these particular amounts the
/// floored fee slices land on the same figures too. The batch a batcher would
/// submit is therefore byte-identical. What differs is what each ORDER pays —
/// 279.55 and 594.55 per token sequentially against 414.55 for both here —
/// and that is enforced by curve_order.ak against each order's own max_spend,
/// not by this validator.
///
/// So the acceptance check below cannot tell the two models apart, and saying
/// it does would be false. The per-order figures underneath it are what
/// actually discriminates, pinned as literals so a regression to sequential
/// pricing fails here rather than passing quietly.
test tier_a_batch_prices_every_order_at_the_batch_average() {
  let d = mock_datum(Active, 0)
  let batch = buy_cost(d, 0, 700)
  and {
    // Uniform: one range, split pro-rata.
    ( batch * 400 + 699 ) / 700 == 165_820,
    ( batch * 300 + 699 ) / 700 == 124_365,
    // Sequential, for contrast — what this used to charge.
    buy_cost(d, 0, 400) == 111_820,
    buy_cost(d, 400, 300) == 178_365,
    // Identical to the curve, which is why the change is free.
    batch == 290_185,
    buy_cost(d, 0, 400) + buy_cost(d, 400, 300) == 290_185,
    a_run_batch(
      d,
      a_two_orders(),
      [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)],
      batch,
    ),
  }
}

/// Two orders of the SAME size, which sequential pricing would still charge
/// differently (14,455 then 23,455) and uniform pricing charges alike. The
/// curve's total is identical either way — that is additivity — so the batch
/// TOTAL cannot tell the two models apart, and a test that asserted only the
/// total would pass under both. The creator's fee can tell them apart:
/// flooring 18,955 twice takes 188, flooring 14,455 and 23,455 takes 189. The
/// batch below carries 188 in its continuing datum, so it validates only
/// against a curve that really prices uniformly.
test tier_a_batch_fee_total_distinguishes_uniform_from_sequential() {
  let d = mock_datum(Active, 0)
  let orders = batch_orders([(#"de", True, 100, 100), (#"df", True, 100, 100)])
  let share = a_uniform_buy_share(d, orders, 100)
  and {
    share == 18_955,
    buy_cost(d, 0, 100) == 14_455,
    buy_cost(d, 100, 100) == 23_455,
    // Identical totals, which is why the change costs the curve nothing.
    share * 2 == 37_910,
    buy_cost(d, 0, 100) + buy_cost(d, 100, 100) == 37_910,
    // One lovelace, and the only figure the two models disagree on here.
    fee_slice(share, creator_bps) * 2 == 188,
    fee_slice(buy_cost(d, 0, 100), creator_bps) + fee_slice(
      buy_cost(d, 100, 100),
      creator_bps,
    ) == 189,
    a_run_batch(
      d,
      orders,
      [a_tok_out(0, #"de", 100), a_tok_out(1, #"df", 100)],
      37_910,
    ),
  }
}

test tier_a_batch_rejects_pricing_every_order_from_the_batch_start() {
  let d = mock_datum(Active, 0)
  !a_run_batch(
    d,
    a_two_orders(),
    [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)],
    buy_cost(d, 0, 400) + buy_cost(d, 0, 300),
  )
}

/// One owner cannot be paid for the whole batch, and the right total to the
/// wrong wallet is not a fill.
test tier_a_batch_requires_each_owner_to_be_paid_individually() {
  let d = mock_datum(Active, 0)
  let orders = a_two_orders()
  let gross = buy_cost(d, 0, 400) + buy_cost(d, 400, 300)
  and {
    a_run_batch(d, orders, [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)], gross),
    !a_run_batch(d, orders, [a_tok_out(0, #"de", 700)], gross),
    !a_run_batch(d, orders, [a_tok_out(0, #"de", 400), a_tok_out(1, #"ff", 300)], gross),
  }
}

test tier_a_batch_enforces_min_received_cap_creator_and_batcher() {
  let d = mock_datum(Active, 0)
  let gross = buy_cost(d, 0, 400) + buy_cost(d, 400, 300)
  let short_bound =
    batch_orders([(#"de", True, 400, 400), (#"df", True, 300, 301)])
  let creator_order = batch_orders([(#"11", True, 400, 400)])
  let over_cap = batch_orders([(#"de", True, 600, 600)])
  and {
    !a_run_batch(
      d,
      short_bound,
      [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)],
      gross,
    ),
    // #"11" is the fixture creator.
    !a_run_batch(d, creator_order, [a_tok_out(0, #"11", 400)], buy_cost(d, 0, 400)),
    // wallet_cap is 500.
    !a_run_batch(d, over_cap, [a_tok_out(0, #"de", 600)], buy_cost(d, 0, 600)),
    // An empty batch would move the curve datum for nothing.
    !a_run_batch(d, [], [], 0),
    // A batcher key nobody signed for.
    !a_run_batch_signed(
      d,
      a_two_orders(),
      [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)],
      gross,
      #"ff",
    ),
  }
}

/// The signature and the allowlist are two separate gates and a batch needs
/// both. Same orders, same signature, same everything as the accepted batch —
/// the only delta is which keys the curve's own datum names.
test tier_a_batch_rejects_a_batcher_the_datum_does_not_name() {
  let d = mock_datum(Active, 0)
  let orders = a_two_orders()
  let gross = buy_cost(d, 0, 700)
  let outs = [a_tok_out(0, #"de", 400), a_tok_out(1, #"df", 300)]
  let elsewhere = BondingCurveDatum { ..d, batcher_allowlist: [#"b0", #"b1"] }
  let nobody = BondingCurveDatum { ..d, batcher_allowlist: [] }
  and {
    a_run_batch(d, orders, outs, gross),
    // Signed by #"ba", which the datum no longer names.
    !a_run_batch(elsewhere, orders, outs, gross),
    // An empty list stops every batch. That is the state a governor reaches to
    // stand a batcher down, and it strands nothing: an order UTXO is spendable
    // by its own owner whenever they like.
    !a_run_batch(nobody, orders, outs, gross),
  }
}

/// Drives `SetBatcherAllowlist`. `lovelace_kept` is what the continuing output
/// carries, so a caller can vary exactly that and nothing else.
fn a_run_set_batchers_keeping(
  datum: BondingCurveDatum,
  batchers: List<VerificationKeyHash>,
  signer: VerificationKeyHash,
  lovelace_kept: Int,
) -> Bool {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let tokens = assets.from_asset(#"33", "tok", 1000)
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          mock_curve_nft(),
          assets.merge(assets.from_lovelace(5_000_000), tokens),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing =
    Output {
      address: own_address,
      value: assets.merge(
        mock_curve_nft(),
        assets.merge(assets.from_lovelace(lovelace_kept), tokens),
      ),
      datum: InlineDatum(
        BondingCurveDatum { ..datum, batcher_allowlist: batchers },
      ),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing],
      extra_signatories: [signer],
    }
  bonding_curve.spend(
    Some(datum),
    SetBatcherAllowlist { batchers: batchers },
    own_ref,
    self,
  )
}

fn a_run_set_batchers(
  datum: BondingCurveDatum,
  batchers: List<VerificationKeyHash>,
  signer: VerificationKeyHash,
) -> Bool {
  a_run_set_batchers_keeping(datum, batchers, signer, 5_000_000)
}

test tier_a_set_batcher_allowlist_is_the_governors_and_is_bounded() {
  let d = mock_datum(Active, 0)
  let eight = [#"b0", #"b1", #"b2", #"b3", #"b4", #"b5", #"b6", #"b7"]
  let nine = list.concat(eight, [#"b8"])
  and {
    // #"22" is the fixture governor.
    a_run_set_batchers(d, [#"b0", #"b1"], #"22"),
    a_run_set_batchers(d, [], #"22"),
    // Nobody appoints themselves: not the batcher the datum already names,
    // and not the creator.
    !a_run_set_batchers(d, [#"ba"], #"ba"),
    !a_run_set_batchers(d, [#"ba"], #"11"),
    // The list rides in every trade, so it is capped rather than unbounded.
    a_run_set_batchers(d, eight, #"22"),
    !a_run_set_batchers(d, nine, #"22"),
  }
}

/// Naming who may batch later must move nothing now — otherwise the governor
/// has a signed path to the raise that reads as an administrative change.
test tier_a_set_batcher_allowlist_cannot_take_the_curve_with_it() {
  let d = mock_datum(Active, 0)
  and {
    a_run_set_batchers_keeping(d, [#"b0"], #"22", 5_000_000),
    !a_run_set_batchers_keeping(d, [#"b0"], #"22", 1_000_000),
  }
}

/// The batch path must not be the way around the cumulative cap. Splitting one
/// wallet's purchase into two orders that are each individually under the cap
/// is exactly the move a per-order check would wave through — and the reason
/// the fold threads the root rather than checking each order against the
/// batch's starting state.
test tier_a_batch_rejects_splitting_one_wallet_across_orders() {
  let d = mock_datum(Active, 0)
  let under = batch_orders([(#"de", True, 200, 200), (#"de", True, 200, 200)])
  let over = batch_orders([(#"de", True, 300, 300), (#"de", True, 300, 300)])
  and {
    // 200 + 200 = 400, inside the 500 cap. Two orders, so two fills: each
    // names the order it settles even though both belong to one wallet.
    a_run_batch(
      d,
      under,
      [a_tok_out(0, #"de", 200), a_tok_out(1, #"de", 200)],
      buy_cost(d, 0, 200) + buy_cost(d, 200, 200),
    ),
    // 300 + 300 = 600. Each order is under the cap on its own; together they
    // are not.
    !a_run_batch(
      d,
      over,
      [a_tok_out(0, #"de", 300), a_tok_out(1, #"de", 300)],
      buy_cost(d, 0, 300) + buy_cost(d, 300, 300),
    ),
  }
}

/// One owner's two orders are two obligations. Before each fill named the
/// order it settles, a single payment sized for ONE of them answered both —
/// the curve advanced by 400 tokens and the owner received 200.
test tier_a_batch_rejects_one_payment_for_two_of_one_owners_orders() {
  let d = mock_datum(Active, 0)
  let two = batch_orders([(#"de", True, 200, 200), (#"de", True, 200, 200)])
  let gross = buy_cost(d, 0, 200) + buy_cost(d, 200, 200)
  and {
    // The control: paid properly, it is accepted.
    a_run_batch(d, two, [a_tok_out(0, #"de", 200), a_tok_out(1, #"de", 200)], gross),
    // One fill, tagged for the first order only.
    !a_run_batch(d, two, [a_tok_out(0, #"de", 200)], gross),
    // One output large enough for both, but naming only one of them.
    !a_run_batch(d, two, [a_tok_out(0, #"de", 400)], gross),
  }
}

// A state-only redeemer must carry the curve's whole value into its continuing
// output. Both of these build a transaction that writes the correct new datum
// and keeps the thread NFT, while moving the raised lovelace and the unsold
// token reserve to a third party — and both must be rejected.

test expire_curve_rejects_value_drain() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let drained_output =
    Output {
      address: own_address,
      value: mock_curve_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let taken =
    Output {
      address: from_verification_key(#"ba"),
      value: assets.from_lovelace(250_000_000)
        |> assets.merge(assets.from_asset(#"33", "tok", 900)),
      datum: InlineDatum(0),
      reference_script: None,
    }
  let past_deadline = 7_776_000_001
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [drained_output, taken],
      validity_range: interval.between(past_deadline - 100, past_deadline + 100),
    }

  !bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test cancel_curve_rejects_value_drain() {
  let datum = mock_datum(Active, 100)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let drained_output =
    Output {
      address: own_address,
      value: mock_curve_nft(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let taken =
    Output {
      address: from_verification_key(#"ba"),
      value: assets.from_lovelace(250_000_000)
        |> assets.merge(assets.from_asset(#"33", "tok", 900)),
      datum: InlineDatum(0),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [drained_output, taken],
      // Even the governor, who may legitimately cancel, cannot empty it.
      extra_signatories: [datum.governor_pub_key_hash],
    }

  !bonding_curve.spend(Some(datum), CancelCurve, own_ref, self)
}

// A curve that is minted and never activated depends entirely on the governor
// to move, because ActivateCurve is the only way out of Inactive and it is
// governor-signed. These two prove that state has the same 90-day backstop a
// trading curve has, measured from the genesis-set phase_started_at.
test expire_curve_succeeds_from_inactive_after_deadline() {
  let datum = BondingCurveDatum { ..mock_datum(Inactive, 0), phase_started_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let past_deadline = 7_776_000_001
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(past_deadline - 100, past_deadline + 100),
    }

  bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

// The backstop is a backstop, not a way to kill a launch that is simply
// waiting to open. Genesis stamps phase_started_at with the mint time for
// exactly this reason.
test expire_curve_rejects_from_inactive_before_deadline() {
  let datum = BondingCurveDatum { ..mock_datum(Inactive, 0), phase_started_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_curve_funded(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let before_deadline = 7_775_999_999
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(
        before_deadline - 100,
        before_deadline + 100,
      ),
    }

  !bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: before_deadline },
    own_ref,
    self,
  )
}

/// The buyer returns their tokens and is refunded with their own ada.
///
/// Same shape as the staking pool's claim, and reachable for the same reason:
/// the buyer signs this, so a builder holding that signature can spend a UTXO
/// they already own, return the refund amount to them as change, tag it as
/// settling this curve, and send the curve's real ada elsewhere. The curve
/// decreases by the share, an output at the buyer's credential carries it,
/// and the datum's accounting is correct — but the buyer has handed over
/// tokens and received nothing that was not already theirs.
test claim_buyback_rejects_refunding_the_buyer_with_their_own_ada() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let attacker_address = from_verification_key(#"ba")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // The buyer's own ada and the tokens they are returning, spent here.
  let buyer_input =
    Input {
      output_reference: OutputReference { transaction_id: #"77", output_index: 0 },
      output: Output {
        address: buyer_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "tok", 10),
        ),
        datum: transaction.NoDatum,
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // Change: the buyer's own ada back, tagged as though the curve refunded it.
  let buyer_change =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(1_900_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  // The curve's real refund, going somewhere else.
  let attacker_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(100_100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input, buyer_input],
      outputs: [continuing_output, buyer_change, attacker_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}
