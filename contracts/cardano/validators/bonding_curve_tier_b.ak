// ============================================================================
// Noctis Zone — Cardano L1 Bonding Curve Contract (Aiken)
// Cardano Launch — public phase only
// ============================================================================
// Resolution (2026-07-09): Cardano Launch's public bonding curve moved from a
// Midnight PSM to Cardano/Aiken entirely. Reasoning: the public phase is,
// by definition, public — nothing about price, amounts, or cap status
// needs Midnight's privacy once DarkVeil closes. Cardano already proved it
// can do real quadratic curve math AND real payment enforcement natively
// (see bonding_curve.ak, the linear curve) with no bridge at all. Keeping the public
// curve on Midnight would have needed a NEW relayer/oracle just so
// `buyTokens` could learn a Cardano payment happened — worse than the
// bridge this file avoids by existing. Only DarkVeil's private
// registration/buying phase stays on Midnight, in
// contracts/midnight/eligibility_gate.compact — the standalone
// darkveil.compact this note originally pointed to was retired and merged
// into eligibility_gate.compact during the Phase 2 security-audit pass
// (2026-07-11); it no longer exists as a separate file.
//
// What stayed the same as bonding_curve.compact's quadratic design:
//   Price formula: price = base_price + k * sold^2
//     where k = (max_price - base_price) / curve_supply^2
//   Same k for both Cardano Launch and Midnight Launch (Jinx's explicit call, unchanged by
//   this move) — this file and bonding_curve.compact (now Midnight Launch only)
//   verify the identical formula, just in two different languages.
//
// What's different from the linear curve's bonding_curve.ak:
//   - Quadratic pricing, not linear (see verify_price below)
//   - The wallet cap here is per-TRANSACTION, exactly as on the linear curve. Both
//     tiers previously kept a cumulative per-wallet running total in the
//     datum; a datum that grows with every new participant eventually
//     exceeds the transaction size limit, which would strand a curve at
//     precisely the moment it was succeeding. See the `wallet_cap` field.
//     Cardano Launch's real sybil resistance is DarkVeil's eligibility checks and
//     the N-hop challenge, not this cap.
//
// Privacy fix (2026-07-11): the ORIGINAL version of this file
// pre-seeded `identity_purchases` at deploy with every registrant's
// `(cardano_vkh, dv_cumulative_amount)` pair, in plaintext, in the public
// datum — regardless of whether that wallet ever claimed or transacted
// again. That directly contradicted CLAUDE.md's Fair Launch Certificate
// promise ("Private forever: Individual wallet addresses, Individual buy
// amounts") and, separately, never actually delivered tokens or charged
// ADA for a DarkVeil purchase at all — the pre-seed only ever fed the cap
// check, not a real settlement. Both problems are fixed together:
//   - No per-wallet purchase list is published at all. The datum carries no
//     roster, no amounts and no participant entries, so there is nothing to
//     leak whether a wallet has transacted or not.
//   - `dv_allocation_root` replaces the plaintext pre-seed: a Merkle root
//     over `(vkh, dv_amount, salt)` leaves, computed off-chain from
//     eligibility_gate.compact's private `cumulativePurchases` map and
//     anchored once at DarkVeil close by the platform relayer (same
//     relayer/trust pattern already used for the ZK Fair Launch
//     Certificate — not a new trust dependency).
//   - The new `ClaimDarkVeilTokens` redeemer lets a DV buyer settle their
//     private purchase for real: they present their own `(dv_amount,
//     salt, merkle_proof)` — known only to them — pay `dv_amount *
//     base_price` in real ADA (the flat DarkVeil price, same pattern as
//     `payment_received` below), receive the tokens
//     (`token_delivered`/`curve_token_balance_decreased`), and are marked
//     in `dv_claimed` so the same allocation can't be claimed twice.
//     Nobody's DV amount is ever visible on-chain unless and until that
//     specific wallet claims — and even then, only their own amount is
//     ever revealed, mirroring the nullifier pattern already used
//     elsewhere in this codebase (a spend reveals the spender's own data,
//     never anyone else's).
//   - Cross-PSM cumulative cap tracking is still resolved as a side
//     effect: there is no cross-PSM call at buy OR claim time. The DV
//     allocation crosses exactly once, at DarkVeil close, as a single
//     Merkle root — not a per-registrant list, and not on every buy.
//
// Fix (2026-07-10): same graduation gap as the linear curve — `Graduated` was
// just a state flag with no redeemer moving the raised ADA or LP token
// reserve into lp_escrow.ak. Added the identical `Graduate` redeemer
// (permissionless, verified by real value movement, not a signature) and
// the identical `curve_token_balance_decreased` bonus fix to BuyTokens —
// see bonding_curve.ak's header for the full reasoning on both; not
// repeated here since the mechanism is byte-for-byte the same, just typed
// against BondingCurveTierBDatum instead.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_256}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, from_verification_key, with_delegation_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use cto_governance.{
  CtoGovernanceDatum, DissolveCTOProposal, Executed, Passed, PreCTO,
  ProposalAnchor, ProposalType, SilenceLockTrigger,
}
use noctis/bitmap
use noctis/cap_accumulator.{CapProofStep}
use noctis/settlement
use noctis/staking_pool_datum
use noctis/thread_nft

/// Same finding/fix as the linear curve's bonding_curve.ak — see that file's
/// own comment on `validity_range_is_narrow` for the full explanation.
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

pub type CurveState {
  Inactive
  Active
  Graduated
  Cancelled
  /// The DarkVeil claim window: registrants settle their private allocations
  /// against the curve, and nothing else can happen. `BuyTokens`/`SellTokens`
  /// require `Active`, so public trading is closed for the whole window and
  /// no public buyer can take supply a registrant has already paid a bond
  /// for. `Inactive -> DvClaim -> Active`.
  ///
  /// Declared LAST for the same reason `SellTokens` is last in the redeemer
  /// type below — a datum's `CurveState` is encoded by declaration order, and
  /// inserting a variant anywhere but the end would silently renumber
  /// `Active`/`Graduated`/`Cancelled` for every already-deployed launch.
  DvClaim
}

/// One step of a Merkle inclusion proof — same `(sibling, direction)` shape
/// already used by the Compact contracts' allowlist/balance-snapshot
/// proofs, just typed for Aiken instead.
pub type MerkleProofStep {
  sibling: ByteArray,
  goes_left: Bool,
}

// FIELD ORDER IS LOAD-BEARING, and not for the reason it usually is.
//
// A record update walks the constructor's field list to reach the field it
// replaces, so what a `BondingCurveTierBDatum { ..datum, x: y }` costs in
// compiled script bytes scales with x's INDEX — not with how many fields the
// record has. Measured on this validator: ~10 bytes of script per index
// position per update site.
//
// Every field a redeemer REWRITES is therefore declared first, and everything
// set once at genesis and only read afterwards is declared after them. That
// single change took this script from 15,952 bytes to 13,715 — 14% — with no
// behavioural difference whatsoever. The linear curve's datum is ordered on the same
// rule, with the same prefix, so the two read alike.
//
// So: a new field that a redeemer writes belongs at the FRONT, next to its
// neighbours. A new read-only field belongs at the BACK. Either way the
// off-chain schema in integration/tier-a-schemas.ts must move with it — the
// encoding is positional, and a mismatch decodes to the wrong field rather
// than failing.
pub type BondingCurveTierBDatum {
  curve_state: CurveState,
  // The platform runs ONE wallet. What used to be a treasury slice and an
  // ops slice is a single accrual, claimed once.
  platform_fees_accrued: Int,
  creator_fees_accrued: Int,
  total_raised: Int,
  tokens_sold: Int,
  // The cumulative wallet cap, as ONE root over `cap_key -> tokens taken from
  // this curve`. Declared near the front because every trade rewrites it —
  // see the ordering note above this type.
  //
  // Why a root and not a list. A running total per wallet is the only way to
  // make `wallet_cap` cumulative, and a list of them grows with participation
  // until the datum every trade carries no longer fits in a transaction — a
  // curve that bricks precisely when a launch succeeds. A root is 32 bytes
  // whether one wallet trades or a million, and each trade carries the one
  // proof for its own slot instead.
  //
  // What that buys, stated exactly: one WALLET KEY cannot take more than
  // `wallet_cap` from this curve across DarkVeil and the public phase
  // combined. One PERSON still can, by trading from separate keys — see the
  // per-redeemer notes below and the file header. Nothing here is a sybil
  // defence; DarkVeil eligibility and the N-hop challenge are.
  //
  // Genesis sets this to the empty tree's root at `cap_tree_depth`, so every
  // slot starts unoccupied and the curve is open to anyone from block one:
  // there is no registration step and no allowlist. A genesis datum carrying
  // some other root would leave wallets unable to prove their own slots, which
  // stalls trading visibly rather than moving any funds.
  cap_root: ByteArray,
  // Nullifier set: one bit per allocation leaf index, MSB-first, set when
  // that leaf is claimed. Sized by the relayer at OpenDvClaim from the real
  // registrant count and FIXED thereafter, so the datum every transaction
  // carries cannot grow with participation.
  //
  // ActivateCurve empties it: no claim is possible once Active, so the datum
  // that every public trade carries holds no claim state at all.
  claimed_bits: ByteArray,
  // Posix time (ms) the claim window opened — 0 until OpenDvClaim. Claims
  // must land within `dv_claim_window` of it; the curve may not open until
  // `dv_claim_window + dv_settlement_window` past it.
  dv_claim_opened_at: Int,
  // CTO fee-redirect fix (2026-07-12): same as the linear curve's bonding_curve.ak —
  // once a CTO passes, ClaimCreatorFees redirects to the community wallet.
  // Mirrors lp_escrow.ak's cto_triggered/community_wallet_hash.
  community_pub_key_hash: VerificationKeyHash,
  cto_triggered: Bool,
  // Posix time (ms) the curve entered the state it is in: the mint, written
  // at genesis, and then the activation, written by ActivateCurve. See Tier
  // A's bonding_curve.ak for the full reasoning — it is the clock ExpireCurve
  // measures its stall window from, on both tiers, and it is set from genesis
  // so that a curve waiting on activation has the same backstop as one that
  // is trading.
  phase_started_at: Int,
  // Fix (2026-07-19, Cardano Launch cross-chain audit): whether
  // dv_allocation_root has been anchored to a real, governor-computed
  // value yet. Starts False at genesis (real value unknown at mint time —
  // DarkVeil hasn't even opened yet). Set True only by the new
  // AnchorDvAllocationRoot redeemer, and required True by ActivateCurve —
  // closes the gap where dv_allocation_root previously had NO on-chain
  // write path at all, meaning ClaimDarkVeilTokens could never succeed for
  // any real buyer. A dedicated Bool rather than comparing against a
  // placeholder byte value — avoids any ambiguity about what counts as
  // "still unset." See file header and internal tracking.
  dv_settled: Bool,
  // Merkle root over `(vkh, dv_amount, index, salt)` leaves, anchored once by
  // the relayer at DarkVeil close (privacy fix). Lets ClaimDarkVeilTokens
  // verify a private allocation without ever publishing the full list.
  dv_allocation_root: ByteArray,
  lp_seeded: Bool,
  staking_seeded: Bool,
  launch_id: ByteArray,
  creator_pub_key_hash: VerificationKeyHash,
  governor_pub_key_hash: VerificationKeyHash,
  base_price: Int,
  max_price: Int,
  curve_supply: Int,
  // 5% of curve_supply. CUMULATIVE across the DarkVeil claim window and the
  // public curve, per wallet, held against `cap_root` above — a wallet that
  // claims 3% in DarkVeil has 2% of public buying left, not a fresh 5%.
  wallet_cap: Int,
  // Total tokens the DarkVeil phase may ever settle, drawn from curve_supply
  // (there is no separate token carve-out — the DarkVeil share sits INSIDE
  // curve_supply, which is why anything unclaimed when the window closes is
  // simply still sellable on the public curve, with no code to move it).
  // The allocation root already bounds the real total off-chain; this makes
  // the contract enforce it rather than assume it. 0 for a launch with no
  // DarkVeil phase, which is what lets ActivateCurve skip the window.
  dv_reserve_tokens: Int,
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  // Same LP graduation fields as the linear curve's bonding_curve.ak — see that
  // file's datum comment for the full reasoning.
  lp_escrow_credential: Credential,
  lp_reserve_tokens: Int,
  // Staking Rewards Pool (2026-07-14): optional per-launch feature —
  // same fields and Graduate-time seeding semantics as the linear curve's
  // bonding_curve.ak. See that file's datum comment for the full reasoning.
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
  // at genesis — same pattern as the linear curve's bonding_curve.ak; see that
  // file's doc comment for the full reasoning. Needed because
  // TriggerCTO/DissolveCTO below now require real reference-input
  // evidence a vote actually passed, instead of trusting a bare governor
  // signature.
  cto_governance_credential: Credential,
  // Fix (2026-07-23 audit): governance THREAD NFT policy id — see the
  // full doc comment on the linear curve's bonding_curve.ak. cto_vote_verified now
  // requires the referenced governance UTXO to carry this NFT
  // (asset_name = launch_id), closing the forge-a-fake-governance-UTXO gap.
  thread_nft_policy: PolicyId,
  // How long registrants have to claim once `OpenDvClaim` starts the clock,
  // and the dead window between that closing and public trading opening —
  // both Posix milliseconds, both declared at genesis and never rewritten,
  // which is why they sit at the BACK of this datum.
  //
  // These were compile-time constants (24h and 30m). A launch could not state
  // different terms without a different script, and therefore a different
  // address. As datum fields the terms belong to the launch, and the bounds
  // `OpenDvClaim` enforces are what keep them honest.
  //
  // Declared at GENESIS rather than supplied to `OpenDvClaim`, deliberately:
  // the window a registrant is shown before they register is then the window
  // they actually get. A redeemer-supplied value could be shortened after
  // registration closed, by the one party who knows who registered.
  dv_claim_window: Int,
  dv_settlement_window: Int,
}

/// One order inside a batch. The order's own UTXO holds the funds being spent
/// (ADA for a buy, tokens for a sell); this is the curve's view of it.
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
  /// True buys tokens, False sells them.
  is_buy: Bool,
  amount: Int,
  /// Slippage bound the owner set. Tokens for a buy, lovelace for a sell.
  min_received: Int,
  /// The owner's committed total before this order, and the proof of it.
  ///
  /// A batch applies orders in sequence, so each proof is taken against the
  /// root the PRECEDING order left behind, not against the root the batch
  /// started from. The batcher holds the tree and builds them that way; a
  /// proof against a stale root simply fails, which is the same freshness
  /// requirement the curve datum itself already imposes on every trade.
  cap_committed_before: Int,
  cap_proof: List<CapProofStep>,
}

pub type BondingCurveTierBRedeemer {
  /// `current_timestamp` stamped into `phase_started_at`, verified against the
  /// tx's validity range (same pattern as the linear curve).
  ActivateCurve { current_timestamp: Int }
  /// The caller names only how much they want and who they are; the contract
  /// derives the price and the fee split itself from the datum, so the amount
  /// charged is a function of curve position and batch size alone (see
  /// `gross_range`).
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
  /// Privacy fix (2026-07-11): settles a private DarkVeil purchase for
  /// real — charges the flat DV price in ADA, delivers the tokens, and
  /// consumes the buyer's own Merkle leaf without ever revealing anyone
  /// else's allocation. See file header.
  ///
  /// The DarkVeil price is deliberately flat at `base_price` rather than a
  /// point on the curve — that discount is what the phase offers — so this
  /// redeemer prices `dv_amount * base_price` directly instead of calling
  /// `gross_range`. Its fee split is computed here exactly as the curve's is.
  /// `leaf_index` selects the claimer's own bit in `claimed_bits` and is part
  /// of the leaf hash, so it cannot be pointed at anyone else's bit.
  /// `current_timestamp` is bound to the transaction's validity range and
  /// enforces the 24-hour window — without it a claim would stay possible for
  /// as long as nobody happened to call `ActivateCurve`.
  ///
  /// Two Merkle proofs, against two different roots, doing two different jobs:
  /// `merkle_proof` proves the ALLOCATION under `dv_allocation_root` (what the
  /// claimer is owed), and `cap_proof` reads and rewrites their running total
  /// under `cap_root` (what they have taken). This is where the cumulative cap
  /// actually spans both phases — a DarkVeil claim spends the same headroom a
  /// public buy would.
  ClaimDarkVeilTokens {
    dv_amount: Int,
    salt: ByteArray,
    merkle_proof: List<MerkleProofStep>,
    buyer_key_hash: VerificationKeyHash,
    leaf_index: Int,
    current_timestamp: Int,
    cap_committed_before: Int,
    cap_proof: List<CapProofStep>,
  }
  /// Same two guarantees as the linear curve's ClaimCreatorFees — see that file's own
  /// doc comment for the full reasoning. (1) Value conservation verified by
  /// real value movement, so buyers' principal cannot leave by this path.
  /// (2) `platform_claim_fee`, a real on-chain-enforced flat charge paid INTO
  /// the curve and accruing to `platform_fees_accrued`, with the same
  /// deliberately conservative sanity floor since Aiken has no in-circuit
  /// oracle access.
  ClaimCreatorFees { amount: Int, platform_claim_fee: Int }
  /// Fix: same missing value-conservation gap as ClaimCreatorFees,
  /// fixed the same way — no new fee added here (the governor is claiming
  /// treasury's OWN existing accrual, not paying a new platform charge).
  /// Governor claims the platform's accrued fees. One redeemer, because
  /// the platform runs one wallet.
  ClaimPlatformFees { amount: Int }
  CancelCurve
  /// Permissionless force-cancel once Active for longer than
  /// `max_curve_duration` without reaching Graduated — same idiom
  /// as the linear curve's ExpireCurve.
  ExpireCurve { current_timestamp: Int }
  /// Pro-rata buyback — same mechanism as the linear curve's ClaimBuyback.
  ClaimBuyback { token_amount: Int, buyer_key_hash: VerificationKeyHash }
  /// Seed the LP once Graduated — same mechanism as the linear curve's Graduate.
  Graduate
  /// CTO fee-redirect fix (2026-07-12) — same mechanism as the linear curve's
  /// bonding_curve.ak.
  TriggerCTO { community_pub_key_hash: VerificationKeyHash }
  DissolveCTO
  /// Fix (2026-07-19, Cardano Launch cross-chain audit): anchors the real
  /// dv_allocation_root computed off-chain by the governor from
  /// eligibility_gate.compact's dvTokensPurchased map, once DarkVeil has
  /// closed on Midnight. Governor-signed — same trust boundary as
  /// ActivateCurve; no open-relay/censorship-resistance need here, unlike
  /// cto_governance.ak's AnchorVoteResult, since there's no
  /// community vote this value could be used to suppress. Gated on
  /// curve_state == Inactive, so it can only run before public trading
  /// opens and can be safely re-called (overwriting a mistaken root) any
  /// number of times while still Inactive — ClaimDarkVeilTokens itself
  /// requires curve_state == Active, so no claim could ever have processed
  /// against a not-yet-final root. See file header and
  /// internal tracking.
  AnchorDvAllocationRoot { dv_allocation_root: ByteArray }
  QueryState
  /// Public sell — the reverse of BuyTokens. Same mechanism as the linear curve's
  /// bonding_curve.ak SellTokens — see that file's own doc comment
  /// for the full pricing-symmetry and value-conservation reasoning
  /// (the same "total_raised can go negative after a round-trip, and that's
  /// correct" invariant holds).
  ///
  /// Entitlement is possession, as on the linear curve: the seller returns real tokens
  /// to the curve in the same transaction, so holding them is what qualifies
  /// them. A wallet that acquired its tokens by DarkVeil claim, public buy or
  /// ordinary transfer can all sell them here alike. The creator is blocked
  /// by an explicit check.
  ///
  /// Deliberately declared LAST in this type (not grouped next to
  /// BuyTokens/ClaimDarkVeilTokens where it reads most naturally) — Plutus
  /// redeemer encoding assigns each variant's on-chain constructor index by
  /// declaration order, and tier-b-curve-submitter.ts hardcodes those
  /// indices for every other action (e.g. `Constr(3, ...)` for
  /// ClaimCreatorFees, `Constr(7, ...)` for ExpireCurve). Inserting a new
  /// variant anywhere but the end would silently shift every already-
  /// deployed index after it — appending here changes nothing for any
  /// existing action.
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
  /// Opens the 24-hour DarkVeil claim window: `Inactive -> DvClaim`.
  /// Governor-signed, and only once the allocation root is anchored, since
  /// the relayer must know the real registrant count to size `claimed_bits`.
  ///
  /// Appended LAST for the constructor-index reason documented on
  /// `SellTokens` above — this is the newest variant, so it takes the newest
  /// index and shifts nothing already deployed.
  OpenDvClaim { claimed_bits: ByteArray, current_timestamp: Int }
  /// Applies N orders against the curve in one transaction. Each order prices
  /// at ITS OWN position: order k starts where order k-1 finished, which is
  /// exactly what `gross_range`'s additivity gives for free.
  ///
  /// Appended LAST, same constructor-index reason as every variant above.
  BatchTrades { orders: List<BatchOrder>, batcher_key_hash: VerificationKeyHash }
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// Fee split in basis points (10000 = 100%) — 0.5% creator + 1.0% platform
/// = 1.5% total, plus the batcher fee charged per order. Same as the linear curve.
const creator_bps = 50

/// One platform line, not a treasury slice plus an ops slice.
const platform_bps = 100

const bps_denominator = 10_000

/// Fix (2026-07-21): ported verbatim from the linear curve's bonding_curve.ak —
/// deliberately conservative SANITY FLOOR for ClaimCreatorFees's
/// new platform_claim_fee, not a precise $1 peg (Aiken has no in-circuit
/// oracle access). 0.2 ADA comfortably undershoots $1's real ADA value
/// across ADA's entire realistic historical trading range; the real
/// $1-equivalent is computed off-chain via the same usdToMinAdaLovelace()
/// Orcfax oracle the linear curve uses, paid with margin above this floor in the
/// normal case.
const min_platform_claim_fee_lovelace = 200_000

/// 90 days in MILLISECONDS — same default and rationale as the linear curve's
/// bonding_curve.ak.
///
/// Fix (2026-07-17): same bug, same fix, as the linear curve's bonding_curve.ak
/// own `max_curve_duration` — this file's `ActivateCurve`/
/// `ExpireCurve` bind `current_timestamp`/`phase_started_at` to
/// `interval.contains(self.validity_range, ...)` identically, so the same
/// ms-vs-seconds mismatch applied here too, never separately checked when
/// The linear curve bug was fixed. Found during Phase 5b research.
const max_curve_duration = 7_776_000_000

/// Bounds on the launch's declared `dv_claim_window` — the time registrants
/// have to settle their allocation once `OpenDvClaim` starts the clock. A
/// claim after it is rejected on-chain, which is what makes the Midnight-side
/// bond forfeiture for a non-claimer well-defined rather than a matter of
/// timing luck.
///
/// Bounded rather than fixed so a launch can state its own terms, and bounded
/// at all because paying to a script address runs no code: a genesis datum is
/// whatever its author wrote until a redeemer says otherwise. The floor keeps
/// a window from being too short to claim in; the ceiling keeps a launch from
/// being parked indefinitely with its curve unable to open.
///
/// 10 minutes. A claiming buyer needs one transaction, and Blockfrost's utxo
/// index lags a confirmed one, so back-to-back claims from a single wallet
/// need room to retry.
const min_dv_claim_window = 600_000

/// 7 days. `max_curve_duration` is 90 days; a claim window past a week leaves
/// a launch looking stalled with no recourse.
const max_dv_claim_window = 604_800_000

/// Bounds on the launch's declared `dv_settlement_window` — the dead window
/// between the claim window closing and public trading opening. Nothing at all
/// can execute inside it: claims are past their deadline and the curve is not
/// `Active` yet. It exists so DarkVeil settlement is provably final before the
/// first public trade, with margin for the relayer to reconcile who claimed.
///
/// Distinct from CLAUDE.md's SETTLEMENT_WINDOW (10 min), which sits earlier
/// and on the other chain — between DarkVeil closing on Midnight and this
/// claim window opening on Cardano.
///
/// 1 minute floor: below that it is not a window. 24 hour ceiling: the same
/// parking argument as the claim window above.
const min_dv_settlement_window = 60_000

const max_dv_settlement_window = 86_400_000

// ============================================================================
// HELPERS
// ============================================================================

/// Leaf hash for a DarkVeil allocation: `blake2b_256(vkh || dv_amount_16be
/// || leaf_index_4be || salt)`. `salt` is chosen off-chain per registrant so
/// the leaf can't be brute-forced from a guessed `(vkh, dv_amount)` pair
/// alone — the same role a nonce plays in the Compact contracts' commitment
/// schemes.
///
/// `leaf_index` binds each registrant to one bit of `claimed_bits`. Because
/// it is inside the hash, a claimer cannot present a real allocation against
/// somebody else's (already-clear) bit.
fn hash_dv_leaf(
  vkh: VerificationKeyHash,
  dv_amount: Int,
  leaf_index: Int,
  salt: ByteArray,
) -> ByteArray {
  blake2b_256(
    bytearray.concat(
      bytearray.concat(
        bytearray.concat(vkh, bytearray.from_int_big_endian(dv_amount, 16)),
        bytearray.from_int_big_endian(leaf_index, 4),
      ),
      salt,
    ),
  )
}

/// Internal Merkle node hash: `blake2b_256(left || right)`.
fn hash_dv_node(left: ByteArray, right: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(left, right))
}

/// Verify `leaf` is included under `root` via `proof` — walks bottom-up,
/// folding each sibling in on the side its `goes_left` flag indicates.
/// Proof length is whatever depth the off-chain tree actually has (no
/// fixed-depth padding needed — unlike Compact's 32-level Merkle proofs,
/// Aiken has no `fold`-only-fixed-loop-count constraint to work around).
fn verify_dv_merkle_proof(
  root: ByteArray,
  leaf: ByteArray,
  proof: List<MerkleProofStep>,
) -> Bool {
  recompute_merkle_root(leaf, proof) == root
}

/// The fold `verify_dv_merkle_proof` runs, exposed on its own so a caller can
/// use the SAME path twice: once against the old root to prove a leaf's
/// current value, once with the updated leaf to derive the root that value
/// becomes. That pair is what turns a read-only membership proof into an
/// updatable accumulator, and it is what lets a per-wallet running total live
/// behind a single 32-byte root instead of a datum list that grows with every
/// participant.
fn recompute_merkle_root(leaf: ByteArray, proof: List<MerkleProofStep>) -> ByteArray {
  list.foldl(
    proof,
    leaf,
    fn(step, acc) {
      if step.goes_left {
        hash_dv_node(step.sibling, acc)
      } else {
        hash_dv_node(acc, step.sibling)
      }
    },
  )
}

/// The cumulative wallet cap's read-and-rewrite, in one call: proves
/// `before` is this key's real running total under `datum.cap_root`, and
/// returns the root it becomes at `after`. Lives in `noctis/cap_accumulator`
/// because the linear curve runs the identical tree and one off-chain builder serves
/// both — see that module's own header.
///
/// Deliberately a DIFFERENT tree from `dv_allocation_root` above, with its own
/// proof type: that one is a fixed roster of allocations anchored once at
/// DarkVeil close, this one is a running total rewritten by every trade.
fn cap_transition(
  root: ByteArray,
  cap_key: ByteArray,
  before: Int,
  after: Int,
  proof: List<CapProofStep>,
) -> (Bool, ByteArray) {
  cap_accumulator.transition(root, cap_key, before, after, proof)
}

/// `m(m+1)(2m+1)`, six times the sum of the squares `0^2 + 1^2 + ... + m^2`.
/// Kept unscaled so `gross_range` below can carry the factor of six in its
/// denominator and stay in exact integers throughout. `g(-1) == 0`, which is
/// what lets a range starting at position 0 need no special case.
fn sum_squares_x6(m: Int) -> Int {
  m * ( m + 1 ) * ( 2 * m + 1 )
}

/// The cost of the token range `[from_sold, from_sold + amount)` on the
/// quadratic curve `P(x) = base_price + (max_price - base_price) * x^2 /
/// curve_supply^2`, returned as an unreduced `(numerator, denominator)` pair.
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
/// Closed form, with `r = max_price - base_price`, `S = curve_supply` and
/// `g(m) = m(m+1)(2m+1)`:
///
///   sum(s, n) = n*base + r * ( g(s+n-1) - g(s-1) ) / (6 * S^2)
///
/// The pair is returned unreduced so each caller applies its own rounding
/// direction — see `buy_cost` and `sell_proceeds`, which is where that choice
/// belongs and where it is named. Aiken's `Int` is arbitrary precision, so the
/// cubic term carries no overflow or precision concern; this is the same
/// reason the quadratic price itself needs none of the narrow-Uint bit-
/// budgeting bonding_curve.compact requires on the Midnight side.
fn gross_range(
  datum: BondingCurveTierBDatum,
  from_sold: Int,
  amount: Int,
) -> (Int, Int) {
  let price_range = datum.max_price - datum.base_price
  let supply_squared = datum.curve_supply * datum.curve_supply
  let square_sum =
    sum_squares_x6(from_sold + amount - 1) - sum_squares_x6(from_sold - 1)
  let numerator =
    6 * supply_squared * amount * datum.base_price + price_range * square_sum
  (numerator, 6 * supply_squared)
}

/// What a buyer pays for `amount` tokens starting at `from_sold` — the range
/// cost rounded UP, so any integer remainder resolves in the curve's favour
/// and a buyer never pays below the true sum.
fn buy_cost(datum: BondingCurveTierBDatum, from_sold: Int, amount: Int) -> Int {
  let (numerator, denominator) = gross_range(datum, from_sold, amount)
  ( numerator + denominator - 1 ) / denominator
}

/// What a seller receives for `amount` tokens starting at `from_sold` — the
/// same range cost rounded DOWN, the mirror of `buy_cost`, so the curve never
/// pays out above the true sum.
fn sell_proceeds(
  datum: BondingCurveTierBDatum,
  from_sold: Int,
  amount: Int,
) -> Int {
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

/// Find this validator's own continuing output and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> BondingCurveTierBDatum {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: BondingCurveTierBDatum = raw_datum
  new_datum
}

/// Fix: real evidence a vote actually passed, replacing a
/// bare governor signature — same mechanism and reasoning as the linear curve's
/// bonding_curve.ak's own cto_vote_verified (see that file's doc comment
/// for the full explanation).
fn cto_vote_verified(
  self: Transaction,
  datum: BondingCurveTierBDatum,
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
    // 2026-08-03 audit: role-tagged asset name — see noctis/thread_nft.
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

/// Verify the buyer's `gross_payment` lovelace actually increased the
/// validator's own continuing output by exactly that amount — same real
/// payment-enforcement pattern as the linear curve's bonding_curve.ak.
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

/// Batch delivery: THIS ORDER must be filled. The single-trade helper below
/// only asks that some output holds the amount, which is enough when there is
/// one buyer in the transaction and not enough when there are N.
///
/// Tagged with the ORDER's reference rather than the curve's, because one
/// owner may hold several orders in a batch and is owed for each. Tagging by
/// the curve's own reference would make every fill in the batch carry the same
/// tag, and a check that cannot tell two of an owner's fills apart accepts one
/// payment for both — which is the whole reason a fill names what it settles.
fn tokens_paid_to(
  self: Transaction,
  order_ref: OutputReference,
  datum: BondingCurveTierBDatum,
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
  datum: BondingCurveTierBDatum,
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

/// Bonus fix found while designing Graduate (2026-07-10) — same as the linear curve's
/// bonding_curve.ak: verify the curve's OWN reserve actually shrinks by
/// token_amount, not just that some output claims to hold it. See that
/// file's comment on the equivalent helper for the full reasoning.
fn curve_token_balance_decreased(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveTierBDatum,
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

/// Reverse of curve_token_balance_decreased — verify the curve's own
/// reserve actually GREW by token_amount on a sell (the seller's tokens
/// really arrived, not just claimed). Same mechanism as the linear curve's
/// bonding_curve.ak tokens_returned_to_curve.
fn tokens_returned_to_curve(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveTierBDatum,
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

/// Fix: same fix, same reasoning, as the linear curve's bonding_curve.ak — see that
/// file's comment on output_value_clean for the full rationale (MeshJS's
/// escrow.ak names this the "unbounded value vulnerability").
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

fn curve_own_output_clean(self: Transaction, own_ref: OutputReference) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  // 3, not 2, since the thread NFT was added: lovelace + the launch token + this launch's own
  // curve thread NFT.
  output_value_clean(own_output, 3)
}

/// State authentication (2026-08-03 audit) — identical fix, identical reasoning, to the linear curve's bonding_curve.ak.
/// See that file's thread_nft_intact for the full rationale. The only
/// difference is the role tag: two Cardano curves are different
/// scripts at different addresses, so the linear curve thread NFT must not satisfy
/// a Cardano Launch check for the same launch.
fn thread_nft_intact(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveTierBDatum,
) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let name =
    thread_nft.thread_asset_name(
      thread_nft.role_bonding_curve_tier_b,
      datum.launch_id,
    )
  // Option-shaped deliberately: a missing continuing output is a drain
  // attempt, which this must reject cleanly rather than abort on.
  when own_output_opt(self, own_address) is {
    None -> False
    Some(own_output) -> and {
        assets.quantity_of(own_input.output.value, datum.thread_nft_policy, name) == 1,
        assets.quantity_of(own_output.value, datum.thread_nft_policy, name) == 1,
      }
  }
}

/// Fix (2026-07-19, full-suite security audit) — same fix, same
/// reasoning, as the linear curve's bonding_curve.ak: closes a double-satisfaction
/// risk since every Cardano Launch launch's curve shares this one fixed,
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

/// Same buyback helpers as the linear curve's bonding_curve.ak.
fn buyback_tokens_returned(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveTierBDatum,
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

/// Fix (2026-07-22): previously compared the FULL output address
/// against `from_verification_key(buyer_key_hash)` — a bare enterprise
/// address, not the buyer's real base address (the original the linear curve
/// finding; confirmed to apply byte-for-byte identically here).
/// Fixed to compare only the payment credential — same idiom this file
/// already uses for lp_escrow_credential/staking_pool_credential/
/// cto_governance_credential checks.
fn buyback_share_paid(
  self: Transaction,
  own_ref: OutputReference,
  buyer_key_hash: VerificationKeyHash,
  share: Int,
) -> Bool {
  let own_input = own_input_of(self, own_ref)
  let own_address = own_input.output.address
  let own_output = own_output_required(self, own_address)
  let curve_decreased_by_share =
    assets.lovelace_of(own_input.output.value) == assets.lovelace_of(own_output.value) + share
  let buyer_credential = from_verification_key(buyer_key_hash).payment_credential
  let buyer_paid =
    list.any(
      self.outputs,
      fn(output) {
        and {
        // The output NAMES the input it settles. See noctis/settlement:
        // recipient and amount are what two obligations owed to one wallet
        // have in common, so an output matched on those alone answers both
        // at once — and a check that omits the tag accepts an output another
        // contract tagged, which is why every payout carries it.
          settlement.settles(output, own_ref),
          output.address.payment_credential == buyer_credential,
          assets.lovelace_of(output.value) >= share,
        }
      },
    )
  // ...and the buyer really is better off by it. This path is signed by the
  // buyer, so the transaction can spend the buyer's OWN utxos, and an output
  // at their credential holding the share is then equally consistent with
  // their own change coming back while the curve's ada goes elsewhere.
  // Netting their inputs out leaves only what arrived from somewhere else.
  // See noctis/settlement's net_lovelace_gain, and the linear curve's own
  // lovelace_paid_from_curve.
  let buyer_gained =
    settlement.net_lovelace_gain(self, buyer_credential) >= share
  curve_decreased_by_share && buyer_paid && buyer_gained
}

/// Fix (2026-07-21): ported from the linear curve's bonding_curve.ak — real
/// value-conservation check for a single-direction curve payout (money
/// only leaves, nothing comes in). Used by ClaimPlatformFees
/// below; ClaimCreatorFees needs a different two-way check since
/// platform_claim_fee also flows IN — see that redeemer's own comment.
///
/// Fix (2026-07-22): same payment-credential-only fix as
/// buyback_share_paid above — this was ported from the linear curve's now-fixed
/// lovelace_paid_from_curve, so it inherited the identical bug at
/// port time (this fix predates that later fix).
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
  }
}

/// Same graduation helpers as the linear curve's bonding_curve.ak.
fn graduation_funds_left_curve(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveTierBDatum,
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

/// The identity currently allowed to claim creator fees — same
/// active_fee_recipient pattern as the linear curve's bonding_curve.ak and
/// lp_escrow.ak's (CTO fee-redirect fix, 2026-07-12).
fn active_fee_recipient(datum: BondingCurveTierBDatum) -> VerificationKeyHash {
  if datum.cto_triggered {
    datum.community_pub_key_hash
  } else {
    datum.creator_pub_key_hash
  }
}

/// Fix (2026-07-17): same bug, same fix, as the linear curve's bonding_curve.ak
/// own `lp_seeding_output_ok` — see that file's comment for the full
/// on-chain-reproduced/aiken-tx-simulate-isolated/unit-test-confirmed
/// explanation. Exact lovelace equality against `lp_ada` alone can never
/// be satisfied against a real, already-funded lp_escrow genesis UTXO;
/// `>=` is correct since `graduation_funds_left_curve`/`lp_value_received`
/// already enforce the exact amounts on each side independently.
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
  datum: BondingCurveTierBDatum,
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

/// Same staking_seeding_output_ok pattern as the linear curve's bonding_curve.ak.
fn staking_seeding_output_ok(self: Transaction, datum: BondingCurveTierBDatum) -> Bool {
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

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator bonding_curve_tier_b {
  spend(
    datum_opt: Option<BondingCurveTierBDatum>,
    redeemer: BondingCurveTierBRedeemer,
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
        // A launch with a DarkVeil phase must have gone through the claim
        // window; one without (DarkVeil cancelled below MIN_DV_PARTICIPANTS,
        // and the linear curve shape generally) opens straight from Inactive.
        let has_darkveil = datum.dv_reserve_tokens > 0
        let from_state_ok =
          if has_darkveil {
            datum.curve_state == DvClaim
          } else {
            datum.curve_state == Inactive
          }
        // Public trading opens only after the full claim window AND the dead
        // window that follows it, so DarkVeil settlement is final before the
        // first public trade rather than merely likely to be.
        let window_closed =
          !has_darkveil || current_timestamp >= datum.dv_claim_opened_at + datum.dv_claim_window + datum.dv_settlement_window
        and {
          // Permissionless once the deadline has passed — the same "the
          // deadline is the authorization" idiom as ExpireCurve, Graduate and
          // lp_escrow.ak's ExecuteDexChange. Deliberately NOT governor-signed
          // any more: a signature requirement here would let the governor
          // hold a launch inside the claim window indefinitely, with every
          // registrant's tokens already paid for and public trading unable to
          // start. The timestamp is still bound to the validity range, and
          // the range is still bounded, so the caller cannot invent a time.
          from_state_ok,
          // Cannot open public trading until the real dv_allocation_root has
          // been anchored (AnchorDvAllocationRoot below) — closes the gap
          // where a launch could go public with DarkVeil claims permanently
          // broken with no on-chain signal.
          datum.dv_settled,
          window_closed,
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          new_datum == BondingCurveTierBDatum {
            ..datum,
            curve_state: Active,
            phase_started_at: current_timestamp,
            // No claim can execute once Active, so the nullifier has served
            // its whole purpose. Emptying it here keeps the datum that every
            // public trade carries free of claim state entirely, whatever the
            // launch's participation was.
            claimed_bits: #"",
          },
        }
      }

      BatchTrades { orders, batcher_key_hash } -> {
        // UNIFORM CLEARING PRICE.
        //
        // Every order on a side pays that side's batch average, not the price
        // its own position in the batch would have given. Position in a batch
        // is therefore worth nothing, which is the point: the batcher's
        // ordering choice stops being a thing to police or be accused of.
        //
        // The curve is unaffected. A range cost is additive over adjacent
        // ranges, so pricing [s0, s0+n) once yields exactly what pricing it in
        // n pieces yields — the same total, differently distributed. What
        // changes is only who inside the batch pays what.
        //
        // BOTH SIDES ARE ANCHORED AT THE PRE-BATCH POSITION, s0. Buys price
        // the range above it and sells the range below it. Anchoring is what
        // makes the result independent of the order the batch is listed in: a
        // sell priced after the batch's buys would depend on those buys, and
        // ordering would matter again through the back door. It also keeps a
        // single-order batch identical to the same trade made directly, since
        // that is exactly the range a lone buy or lone sell already uses.
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

        // A batch cannot sell back more than the curve has ever sold. The
        // sequential fold got this only incidentally, from each sell leaving
        // tokens_sold non-negative; that misses a batch which dips and is
        // lifted again by a later buy, and whose sell range would then start
        // below zero. Anchoring makes the aggregate the thing to check.
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

        // Fold the batch: thread tokens_sold AND cap_root through, accumulate
        // what the curve owes and is owed, and require every order to be
        // satisfiable. tokens_sold no longer sets any price — it is threaded
        // for the supply and floor checks, and to land the final position —
        // while the cap root still advances per order, so each proof is taken
        // against the root the preceding order left.
        let folded =
          list.foldl(
            orders,
            (datum.tokens_sold, 0, 0, 0, 0, datum.cap_root, True),
            fn(order, acc) {
              let (sold, ada_in, ada_out, creator_acc, platform_acc, root, ok) =
                acc
              if order.is_buy {
                // This order's share of the one batch range, rounded UP so
                // the remainder resolves in the curve's favour — the same
                // direction `buy_cost` rounds a range it prices directly.
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
                // Rounded DOWN, mirroring `sell_proceeds`, so the curve never
                // pays out above the range it is settling.
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
        let net_in = ada_in - creator_total - platform_total
        let next_state =
          if final_sold == datum.curve_supply {
            Graduated
          } else {
            datum.curve_state
          }
        let expected_datum =
          BondingCurveTierBDatum {
            ..datum,
            tokens_sold: final_sold,
            total_raised: datum.total_raised + net_in - ada_out,
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
          // cannot sell back more than the curve has ever sold. Without this
          // the anchored range would start below zero.
          sell_range_real,
          !list.is_empty(orders),
          // Whitelisted batcher, same trust boundary as Minswap's.
          list.has(self.extra_signatories, batcher_key_hash),
          new_datum == expected_datum,
          // The datum above is a record of what the batch claims; this is the
          // curve's own UTXO actually moving by it. Fees stay in the curve
          // until claimed, so the lovelace it keeps is everything taken in
          // less everything paid out.
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

      OpenDvClaim { claimed_bits, current_timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.curve_state == Inactive,
          // The root has to be final before the window opens: it is what
          // every claim proves against, and AnchorDvAllocationRoot can only
          // run while Inactive, so this is the point of no return for it.
          datum.dv_settled,
          datum.dv_reserve_tokens > 0,
          // A window with no bits is a window nobody could claim in.
          bytearray.length(claimed_bits) > 0,
          // Bound the launch's declared windows HERE, at the one transaction
          // that starts the clock they are measured from. Paying to a script
          // address runs no code, so a genesis datum holds whatever its author
          // wrote; this is the first spend that relies on these two, and every
          // arm after it carries the datum forward unchanged, so bounding once
          // here binds every later read.
          //
          // A zero claim window would confiscate every allocation on the spot;
          // an unbounded one would leave the curve unable to open at all.
          datum.dv_claim_window >= min_dv_claim_window,
          datum.dv_claim_window <= max_dv_claim_window,
          datum.dv_settlement_window >= min_dv_settlement_window,
          datum.dv_settlement_window <= max_dv_settlement_window,
          // Every bit starts clear — the governor cannot pre-burn a
          // registrant's claim by opening the window with their bit set.
          claimed_bits == bytearray.from_int_big_endian(
            0,
            bytearray.length(claimed_bits),
          ),
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          new_datum == BondingCurveTierBDatum {
            ..datum,
            curve_state: DvClaim,
            dv_claim_opened_at: current_timestamp,
            claimed_bits: claimed_bits,
          },
          curve_own_output_clean(self, own_ref),
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
        // May already be non-zero here — this buyer could have already
        // claimed a DarkVeil allocation via ClaimDarkVeilTokens, not
        // starting fresh (see file header).
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
          BondingCurveTierBDatum {
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
          // own slot — so the sum below is a running total across DarkVeil and
          // every earlier public buy, not just this one transaction.
          cap_ok,
          cap_after <= datum.wallet_cap,
          // `buyer_key_hash` is the accumulator's key as well as the delivery
          // address, and it signs here — so a buyer cannot spend anyone else's
          // headroom, and cannot dodge their own by naming a stranger.
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
          // must actually shrink by token_amount.
          curve_token_balance_decreased(self, own_ref, datum, token_amount),
          // The curve's own continuing output can't be padded.
          curve_own_output_clean(self, own_ref),
        }
      }

      ClaimDarkVeilTokens {
        dv_amount,
        salt,
        merkle_proof,
        buyer_key_hash,
        leaf_index,
        current_timestamp,
        cap_committed_before,
        cap_proof,
      } -> {
        let remaining = datum.curve_supply - datum.tokens_sold
        // Flat DarkVeil price (base_price = P0), not the summed curve range —
        // the buyer already locked this price privately on Midnight during
        // the DV buying window (see file header). It is below what the same
        // tokens cost on the curve, which is the discount the phase exists to
        // give; the fee split is computed from it exactly as a buy's is.
        let gross_payment = dv_amount * datum.base_price
        let creator_fee = fee_slice(gross_payment, creator_bps)
        let platform_fee = fee_slice(gross_payment, platform_bps)
        let fee_total = creator_fee + platform_fee
        let net_payment = gross_payment - fee_total
        // Both this and `next_bits` below are guarded on the SAME range check
        // rather than on the `and` block's ordering, because both bindings are
        // evaluated before that block runs: `hash_dv_leaf` would abort on a
        // negative index (big-endian encoding rejects one) and `set_bit` would
        // abort on any out-of-range index. Guarded, an out-of-range claim
        // fails cleanly on `index_in_range` instead.
        let index_in_range =
          leaf_index >= 0 && leaf_index < bytearray.length(datum.claimed_bits) * 8
        let leaf =
          if index_in_range {
            hash_dv_leaf(buyer_key_hash, dv_amount, leaf_index, salt)
          } else {
            #""
          }
        // No Graduated transition: claims are bounded by dv_reserve_tokens,
        // which is strictly less than curve_supply, so a claim can never sell
        // a curve through. Graduation is the public curve's business alone.
        let new_tokens_sold = datum.tokens_sold + dv_amount
        let next_bits =
          if index_in_range {
            bitmap.set_bit(datum.claimed_bits, leaf_index)
          } else {
            datum.claimed_bits
          }
        let cap_after = cap_committed_before + dv_amount
        let (cap_ok, next_cap_root) =
          cap_transition(
            datum.cap_root,
            buyer_key_hash,
            cap_committed_before,
            cap_after,
            cap_proof,
          )
        let expected_datum =
          BondingCurveTierBDatum {
            ..datum,
            tokens_sold: new_tokens_sold,
            total_raised: datum.total_raised + net_payment,
            creator_fees_accrued: datum.creator_fees_accrued + creator_fee,
            platform_fees_accrued: datum.platform_fees_accrued + platform_fee,
            claimed_bits: next_bits,
            cap_root: next_cap_root,
          }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          // The claim window, not the public curve. BuyTokens and SellTokens
          // both require Active, so for the whole of this window no public
          // buyer can take supply a registrant has already bonded for, and no
          // claimer can turn round and sell what they have just claimed.
          datum.curve_state == DvClaim,
          // The launch's own declared window from OpenDvClaim, enforced here
          // rather than left to whenever somebody happens to call
          // ActivateCurve. OpenDvClaim bounded the value before starting the
          // clock, and every arm since carries the datum forward unchanged.
          current_timestamp <= datum.dv_claim_opened_at + datum.dv_claim_window,
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          dv_amount > 0,
          dv_amount <= remaining,
          // The DarkVeil phase cannot settle more than its own allocation,
          // however the root was built.
          new_tokens_sold <= datum.dv_reserve_tokens,
          verify_dv_merkle_proof(datum.dv_allocation_root, leaf, merkle_proof),
          // In range, and not already claimed. leaf_index is inside the leaf
          // hash, so a valid proof pins the claimer to this one bit.
          index_in_range,
          !bytearray.test_bit(datum.claimed_bits, leaf_index),
          // A claim always moves real lovelace, on the same reasoning as
          // BuyTokens above.
          gross_payment > 0,
          // The SAME accumulator the public curve uses. A registrant whose
          // allocation is already the whole cap has no public headroom left
          // afterwards — which is what "5% across DarkVeil and the public
          // phase combined" has to mean to be true.
          cap_ok,
          cap_after <= datum.wallet_cap,
          list.has(self.extra_signatories, buyer_key_hash),
          // The creator is blocked from DarkVeil, unlike the public curve
          // where they may buy. This one is not a wash-trade guard — it is
          // what the Fair Launch Certificate publishes as fact ("creator
          // wallet purchased 0 tokens during DarkVeil"), and CLAUDE.md's
          // registration check #3 says the same. A creator taking a
          // discounted DarkVeil allocation would make that claim false.
          buyer_key_hash != datum.creator_pub_key_hash,
          new_datum == expected_datum,
          token_delivered(self, own_ref, datum, dv_amount),
          payment_received(self, own_ref, gross_payment),
          curve_token_balance_decreased(self, own_ref, datum, dv_amount),
          // The curve's own continuing output can't be padded.
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
          BondingCurveTierBDatum {
            ..datum,
            tokens_sold: new_sold,
            // Subtract the FULL gross_proceeds, not net_proceeds — see this
            // redeemer's own doc comment (SellTokens, in the type
            // definition above) and the linear curve's identical reasoning for
            // the invariant this preserves.
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
          // Can only sell back what this wallet is tracked as having
          // acquired via THIS contract (public buy or DarkVeil claim) — see
          // the redeemer's own doc comment above.
          // Entitlement is possession — the seller returns real tokens to the
          // curve below. The creator block is explicit now; it used to fall
          // out of a creator's tracked purchase total always being zero.
          seller_key_hash != datum.creator_pub_key_hash,
          // Still per-transaction on this side: a cumulative bound is not the
          // useful one for a sell (it only ever falls), so what is worth
          // holding is that no single transaction dumps more than the cap
          // into the curve at once.
          token_amount <= datum.wallet_cap,
          // Releasing headroom is exactly as much a state change as taking it,
          // so a sell carries a proof too — without one, a wallet could sell
          // its position and still be barred from re-entering the launch.
          cap_ok,
          // Deliberately no `gross_proceeds <= datum.total_raised` guard —
          // same reasoning as the linear curve's SellTokens: a symmetric
          // buy-then-sell round-trip legitimately drives total_raised
          // negative by exactly the original buy's fee_total, and the sum
          // invariant (total_raised + 3 fee accumulators == curve's real
          // lovelace above its base) holds regardless of total_raised's
          // individual sign. Graduate's own graduation_funds_left_curve
          // check (real value movement, not this field) is what actually
          // gates graduation — never a fund-safety issue either way, since
          // lovelace_paid_from_curve already makes it physically
          // impossible to pay out more real ADA than the curve holds.
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
        // `platform_claim_fee` arrives (paid by the claimer) — same shape
        // as the linear curve's identical fix, verified directly here rather than
        // via lovelace_paid_from_curve's single-direction check.
        let curve_balance_net_ok =
          assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) - amount + platform_claim_fee
        // Fix (2026-07-22): same payment-credential-only fix as
        // lovelace_paid_from_curve/buyback_share_paid above.
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
          new_datum == BondingCurveTierBDatum {
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
          new_datum == BondingCurveTierBDatum {
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
          new_datum == BondingCurveTierBDatum { ..datum, curve_state: Cancelled },
          // Cancelling is a state change only. Everything the curve holds
          // stays with it, so ClaimBuyback has principal left to refund.
          curve_value_unchanged(self, own_ref),
        }
      }

      ExpireCurve { current_timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Active and Inactive, and deliberately NOT DvClaim.
          //
          // Including Inactive is what guarantees every state a Cardano Launch curve
          // can rest in has an exit reachable without the governor. The two
          // forward moves out of Inactive (OpenDvClaim, AnchorDvAllocationRoot)
          // are governor-signed, so this arm is the one that answers for a
          // launch holding its whole supply while it waits.
          //
          // DvClaim does not: ActivateCurve out of it is permissionless once
          // the claim and settlement windows have passed, and dv_settled was
          // already required before the window could open, so that state
          // always has an exit that does not depend on anyone in particular.
          // Adding it here would let a curve be cancelled out from under
          // registrants who have paid for allocations they can still claim.
          or {
            datum.curve_state == Active,
            datum.curve_state == Inactive,
          },
          interval.contains(self.validity_range, current_timestamp),
          // Bound the declared validity range's own width.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp > datum.phase_started_at + max_curve_duration,
          new_datum == BondingCurveTierBDatum { ..datum, curve_state: Cancelled },
          curve_own_output_clean(self, own_ref),
          // curve_own_output_clean bounds how MANY assets the output carries;
          // this is what bounds their AMOUNTS. Permissionless by design, so
          // "anyone may expire a stalled curve" must not also mean "anyone
          // may empty it".
          curve_value_unchanged(self, own_ref),
        }
      }

      ClaimBuyback { token_amount, buyer_key_hash } -> {
        let share = datum.total_raised * token_amount / datum.tokens_sold
        let new_datum =
          BondingCurveTierBDatum {
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
          buyback_tokens_returned(self, own_ref, datum, token_amount),
          buyback_share_paid(self, own_ref, buyer_key_hash, share),
          curve_own_output_clean(self, own_ref),
        }
      }

      Graduate -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let expected_datum =
          BondingCurveTierBDatum {
            ..datum,
            total_raised: 0,
            lp_seeded: True,
            staking_seeded: True,
          }
        and {
          datum.curve_state == Graduated,
          !datum.lp_seeded,
          !datum.staking_seeded,
          new_datum == expected_datum,
          // Real, positive backing before a launch can call itself graduated
          // — see the linear curve's own Graduate arm for the full reasoning. Enough
          // SellTokens activity before the final buy can leave total_raised
          // non-positive at 100% sell-through, and at zero both of the value
          // checks below degrade into things any output satisfies. This tier
          // has the same SellTokens redeemer and reaches the same state the
          // same way, so it needs the same guard.
          datum.total_raised > 0,
          graduation_funds_left_curve(self, own_ref, datum, datum.total_raised),
          lp_seeding_output_ok(self, datum, datum.total_raised),
          staking_seeding_output_ok(self, datum),
          // The curve's own post-graduation output can't be padded.
          curve_own_output_clean(self, own_ref),
        }
      }

      TriggerCTO { community_pub_key_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // Enforcement: permissionless, gated on real anchored vote
          // evidence instead of a bare governor signature.
          cto_vote_verified(
            self,
            datum,
            SilenceLockTrigger,
            Some(community_pub_key_hash),
          ),
          !datum.cto_triggered,
          community_pub_key_hash != #"",
          new_datum == BondingCurveTierBDatum {
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
          // DissolveCTOProposal instead of a bare governor signature.
          cto_vote_verified(self, datum, DissolveCTOProposal, None),
          datum.cto_triggered,
          new_datum == BondingCurveTierBDatum {
            ..datum,
            cto_triggered: False,
            community_pub_key_hash: #"",
          },
          curve_value_unchanged(self, own_ref),
        }
      }

      // Fix (2026-07-19, Cardano Launch cross-chain audit): see
      // AnchorDvAllocationRoot's own doc comment in
      // BondingCurveTierBRedeemer above for the full reasoning.
      AnchorDvAllocationRoot { dv_allocation_root } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.curve_state == Inactive,
          new_datum == BondingCurveTierBDatum {
            ..datum,
            dv_allocation_root: dv_allocation_root,
            dv_settled: True,
          },
          // Recording the allocation root moves no value.
          curve_value_unchanged(self, own_ref),
        }
      }

      // CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks),
      // an unconditional authorization, which must never be possible. See that file's own comment
      // on this exact line for the full explanation.
      QueryState -> False
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

/// Thread-NFT fixtures — see the linear curve's bonding_curve.ak for why these are derived
/// through thread_nft.thread_asset_name rather than hard-coded.
fn mock_curve_nft() -> assets.Value {
  assets.from_asset(
    #"c0ffee",
    thread_nft.thread_asset_name(thread_nft.role_bonding_curve_tier_b, #"01"),
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
// the one blind spot these tests exist to cover.
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
/// behind. That threading is the whole reason this is a builder rather than a
/// literal list — it is also exactly what the off-chain batcher has to do.
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

fn mock_datum(
  curve_state: CurveState,
  tokens_sold: Int,
) -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
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
    dv_allocation_root: #"00",
    // 150 of the 1000 curve_supply — the documented 15% DarkVeil share of a
    // 1B/75% split, at test scale.
    dv_reserve_tokens: 150,
    dv_claim_opened_at: 0,
    // One byte, so leaf indices 0-7 are addressable. Tests that need more
    // override it.
    claimed_bits: #"00",
    // Real launches must call AnchorDvAllocationRoot before
    // ActivateCurve; tests that specifically exercise ActivateCurve
    // override this explicitly (see activate_curve_* tests below) — every
    // other test passes curve_state directly, bypassing ActivateCurve's
    // own check, so False here doesn't affect them.
    dv_settled: False,
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
    thread_nft_policy: #"c0ffee",
    // Every slot empty, which is what genesis writes and what leaves the
    // curve open to any wallet with no registration step.
    cap_root: cap_root([]),
    // The production defaults, so every test that does not care about the
    // windows exercises the values a real launch is expected to carry.
    dv_claim_window: 86_400_000,
    dv_settlement_window: 1_800_000,
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
      // Fix: genuine governance UTXO carries its per-launch thread NFT
      // (policy = the curve datum's thread_nft_policy `#"c0ffee"`,
      // asset_name = launch_id); cto_vote_verified now requires it.
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

// ----------------------------------------------------------------------------
// Pricing
//
// mock_datum: base=100, max=1000, curve_supply=1000, so r=900 and
// P(x) = 100 + 900*x^2/1000^2. P(0)=100, P(100)=109, P(500)=325,
// P(999)=998.2009, P(1000)=1000.
// ----------------------------------------------------------------------------

/// Test helper: proceeds from leaving a position of `chunks` (newest first,
/// each entry a chunk size) starting at `tokens_sold = start`.
fn chunked_exit_proceeds(
  datum: BondingCurveTierBDatum,
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

test buying_one_token_costs_the_quadratic_price_at_that_position() {
  and {
    buy_cost(mock_datum(Active, 0), 0, 1) == 100,
    buy_cost(mock_datum(Active, 100), 100, 1) == 109,
    buy_cost(mock_datum(Active, 500), 500, 1) == 325,
  }
}

/// The curve really is x^2, not x: at 10% sold the price has risen by 9
/// lovelace where a linear curve over the same endpoints would be at 190.
test the_curve_climbs_slowly_early_and_steeply_late() {
  let d = mock_datum(Active, 0)
  and {
    buy_cost(d, 100, 1) == 109,
    buy_cost(d, 900, 1) == 829,
    // the last hundred tokens cost far more than the first hundred
    buy_cost(d, 900, 100) > 8 * buy_cost(d, 0, 100),
  }
}

test buying_the_whole_curve_costs_the_sum_of_every_token_price() {
  buy_cost(mock_datum(Active, 0), 0, 1000) == 399_551
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
    single == 399_550,
    chunked_exit_proceeds(d, 1000, [500, 500]) <= single,
    chunked_exit_proceeds(d, 1000, [334, 333, 333]) <= single,
    chunked_exit_proceeds(d, 1000, [250, 250, 250, 250]) <= single,
    chunked_exit_proceeds(d, 1000, [1, 999]) <= single,
    chunked_exit_proceeds(d, 1000, [999, 1]) <= single,
    chunked_exit_proceeds(d, 1000, [100, 200, 300, 400]) <= single,
  }
}

/// A buy and a sell of the same size at the same curve position quote the
/// same range, so a round trip returns no more than it cost — before the
/// 2.0% fee is applied on both legs.
test a_round_trip_returns_no_more_than_it_cost() {
  let d = mock_datum(Active, 400)
  buy_cost(d, 400, 100) >= sell_proceeds(d, 400, 100)
}

/// At a position whose price is not a whole number of lovelace, the two
/// directions round opposite ways: P(999) = 998.2009.
test rounding_at_a_fractional_price_favours_the_curve() {
  let d = mock_datum(Active, 999)
  and {
    buy_cost(d, 999, 1) == 999,
    sell_proceeds(d, 999, 1) == 998,
  }
}

test pricing_boundaries() {
  let d = mock_datum(Active, 0)
  and {
    buy_cost(d, 0, 1) == 100,
    buy_cost(d, 999, 1) == 999,
    buy_cost(d, 500, 500) == 312_163,
  }
}

/// A curve whose price range and supply share no common factor still prices
/// every partial trade as a definite lovelace amount, at every position.
test partial_trades_price_on_a_curve_with_coprime_parameters() {
  let d =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 0),
      base_price: 1,
      max_price: 8,
    }
  and {
    buy_cost(d, 0, 1) == 1,
    buy_cost(d, 1, 1) == 2,
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

test buy_tokens_succeeds_for_buyer_who_already_claimed_darkveil() {
  // A wallet that already claimed a DarkVeil allocation buys publicly. The
  // curve keeps no per-wallet history, so this is priced and capped exactly
  // like any other buy — which is the point: a prior claim neither blocks
  // nor discounts a later public purchase.
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 986,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      // The buy fills this buyer's own slot, and only theirs.
      cap_root: cap_root([(#"dd", 10)]),
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1001),
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

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_padded_continuing_output() {
  // Identical to a normal successful buy, except the curve's own
  // continuing output carries one extra, unrelated junk asset. Before the
  // fix, output_value_clean didn't exist and this would have been
  // accepted — any buyer could pad the curve's reused UTXO with spam
  // assets, degrading every subsequent buyer for the launch's whole life.
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 986,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.merge(
          assets.from_lovelace(base_lovelace + 1001),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_tokens_not_sourced_from_curve_reserve() {
  // Bonus fix regression test (found while designing Graduate) — same as Tier
  // A: the buyer's delivery output is present, but the curve's own token
  // balance never shrinks. Before this fix, this would have been accepted.
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 986,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      // Curve's token balance unchanged (still 1000) — not the required 990.
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1001),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_allows_creator_buying_own_curve() {
  // The creator may buy publicly. They can never sell (SellTokens blocks
  // them outright), so ADA they commit here can only stay in the curve —
  // there is no round trip to wash-trade with. Their buys are flagged to
  // the community off-chain by matching the buyer hash against
  // `creator_pub_key_hash`. The DarkVeil path stays closed to them, since
  // the Fair Launch Certificate publishes that they bought none.
  // Same protection as the linear curve's bonding_curve.ak — creator cannot
  // wash-trade their own public curve to force last-mile 100% sell-through.
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 986,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      // mock_datum's creator_pub_key_hash is #"11"
      cap_root: cap_root([(#"11", 10)]),
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1001),
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
      // creator-identity check, not the pre-existing signature check.
      extra_signatories: [#"11"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"11",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"11", []),
    }

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// The CUMULATIVE cap
//
// The claim these have to hold up is the one the product surface makes: a
// wallet's 5% is spent across DarkVeil and every public trade combined, not
// refreshed per transaction. Each test below pairs a rejection with the
// otherwise-identical acceptance, so none of them can pass by rejecting
// everything.
// ----------------------------------------------------------------------------

/// A fully-formed public buy — correct price, payment, delivery and datum —
/// so the only thing left to reject it is the cap.
///
/// `held` is the accumulator's real contents (and, so the fixture is coherent,
/// the curve's position too). `declared_before` is what the buyer PUTS IN THE
/// REDEEMER, which the understatement test needs to be able to differ from the
/// truth.
fn run_cap_buy(
  buyer: VerificationKeyHash,
  amount: Int,
  declared_before: Int,
  held: List<(ByteArray, Int)>,
) -> Bool {
  let sold = list.foldl(held, 0, fn(e, acc) { acc + e.2nd })
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, sold),
      cap_root: cap_root(held),
    }
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
    BondingCurveTierBDatum {
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
  bonding_curve_tier_b.spend(
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
test buy_tokens_caps_a_wallet_across_separate_transactions() {
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
test buy_tokens_rejects_an_understated_committed_total() {
  and {
    run_cap_buy(#"dd", 5, 495, [(#"dd", 495)]),
    // Same buyer, same real 495 in the tree, claiming to hold nothing.
    !run_cap_buy(#"dd", 5, 0, [(#"dd", 495)]),
  }
}

/// One wallet filling its cap leaves every other wallet's untouched — the
/// property that makes a single root a substitute for a per-wallet list.
test buy_tokens_caps_each_wallet_separately() {
  and {
    run_cap_buy(#"de", 400, 0, [(#"dd", 500)]),
    !run_cap_buy(#"dd", 400, 500, [(#"dd", 500)]),
  }
}

test buy_tokens_rejects_a_single_purchase_over_the_cap() {
  // The cap is per transaction. Everything about this buy is otherwise
  // valid — price, payment, delivery, datum — and the 10-token amount
  // exceeds a deliberately lowered 5-token cap, so the cap check is the
  // only thing that can reject it.
  let datum = BondingCurveTierBDatum { ..mock_datum(Active, 0), wallet_cap: 5 }
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 986,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1001),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// Privacy fix (2026-07-11): ClaimDarkVeilTokens + Merkle proof helpers
// ----------------------------------------------------------------------------

test verify_dv_merkle_proof_accepts_single_leaf_tree() {
  // Edge case: zero real levels — the root IS the leaf, proof is empty.
  let leaf = hash_dv_leaf(#"aa", 100, 0, #"01")
  verify_dv_merkle_proof(leaf, leaf, [])
}

test verify_dv_merkle_proof_accepts_real_proof_in_two_leaf_tree() {
  let leaf0 = hash_dv_leaf(#"aa", 100, 0, #"01")
  let leaf1 = hash_dv_leaf(#"bb", 200, 1, #"02")
  let root = hash_dv_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]
  let proof1 = [MerkleProofStep { sibling: leaf0, goes_left: True }]
  and {
    verify_dv_merkle_proof(root, leaf0, proof0),
    verify_dv_merkle_proof(root, leaf1, proof1),
  }
}

test verify_dv_merkle_proof_rejects_tampered_sibling() {
  let leaf0 = hash_dv_leaf(#"aa", 100, 0, #"01")
  let leaf1 = hash_dv_leaf(#"bb", 200, 1, #"02")
  let root = hash_dv_node(leaf0, leaf1)
  let tampered_proof = [MerkleProofStep { sibling: #"ff", goes_left: False }]
  !verify_dv_merkle_proof(root, leaf0, tampered_proof)
}

test verify_dv_merkle_proof_rejects_flipped_direction_bit() {
  let leaf0 = hash_dv_leaf(#"aa", 100, 0, #"01")
  let leaf1 = hash_dv_leaf(#"bb", 200, 1, #"02")
  let root = hash_dv_node(leaf0, leaf1)
  let flipped_proof = [MerkleProofStep { sibling: leaf1, goes_left: True }]
  !verify_dv_merkle_proof(root, leaf0, flipped_proof)
}

test hash_dv_leaf_differs_for_different_salts() {
  // Salt binding matters: without it, a leaf could be brute-forced from a
  // guessed (vkh, dv_amount) pair alone.
  hash_dv_leaf(#"aa", 100, 0, #"01") != hash_dv_leaf(#"aa", 100, 0, #"02")
}

/// Drives OpenDvClaim against `datum` with `bits`, signed by `signer`.
fn run_open_dv_claim(
  datum: BondingCurveTierBDatum,
  bits: ByteArray,
  signer: VerificationKeyHash,
) -> Bool {
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
    BondingCurveTierBDatum {
      ..datum,
      curve_state: DvClaim,
      dv_claim_opened_at: 500,
      claimed_bits: bits,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [
        Output {
          address: own_address,
          value: mock_curve_nft(),
          datum: InlineDatum(new_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [signer],
      validity_range: interval.between(400, 600),
    }
  bonding_curve_tier_b.spend(
    Some(datum),
    OpenDvClaim { claimed_bits: bits, current_timestamp: 500 },
    own_ref,
    self,
  )
}

fn pre_claim_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum { ..mock_datum(Inactive, 0), dv_settled: True }
}

test open_dv_claim_succeeds_for_governor_with_a_cleared_bitmap() {
  run_open_dv_claim(pre_claim_datum(), #"0000", #"22")
}

test open_dv_claim_rejects_non_governor() {
  !run_open_dv_claim(pre_claim_datum(), #"0000", #"ff")
}

// The governor sizes the bitmap but must not be able to burn a registrant's
// claim by opening the window with their bit already set.
test open_dv_claim_rejects_a_pre_set_bit() {
  and {
    !run_open_dv_claim(pre_claim_datum(), #"8000", #"22"),
    !run_open_dv_claim(pre_claim_datum(), #"0001", #"22"),
  }
}

// A window nobody can claim in.
test open_dv_claim_rejects_an_empty_bitmap() {
  !run_open_dv_claim(pre_claim_datum(), #"", #"22")
}

// The launch declares its own windows, so this is the transaction that has to
// hold them to something. Each case below is the passing open with ONE field
// moved one millisecond past a bound, so the bound is the only thing it can
// fail on.
//
// Paying to a script address runs no code, so these values are whatever the
// genesis author wrote until this arm says otherwise.
test open_dv_claim_rejects_a_claim_window_below_the_floor() {
  !run_open_dv_claim(
    BondingCurveTierBDatum {
      ..pre_claim_datum(),
      dv_claim_window: min_dv_claim_window - 1,
    },
    #"0000",
    #"22",
  )
}

test open_dv_claim_rejects_a_claim_window_above_the_ceiling() {
  !run_open_dv_claim(
    BondingCurveTierBDatum {
      ..pre_claim_datum(),
      dv_claim_window: max_dv_claim_window + 1,
    },
    #"0000",
    #"22",
  )
}

test open_dv_claim_rejects_a_settlement_window_below_the_floor() {
  !run_open_dv_claim(
    BondingCurveTierBDatum {
      ..pre_claim_datum(),
      dv_settlement_window: min_dv_settlement_window - 1,
    },
    #"0000",
    #"22",
  )
}

test open_dv_claim_rejects_a_settlement_window_above_the_ceiling() {
  !run_open_dv_claim(
    BondingCurveTierBDatum {
      ..pre_claim_datum(),
      dv_settlement_window: max_dv_settlement_window + 1,
    },
    #"0000",
    #"22",
  )
}

// Both floors together, which is what a short-window launch actually carries.
// Without this the four rejections above would be equally satisfied by an arm
// that refused every value.
test open_dv_claim_accepts_the_windows_at_their_floors() {
  run_open_dv_claim(
    BondingCurveTierBDatum {
      ..pre_claim_datum(),
      dv_claim_window: min_dv_claim_window,
      dv_settlement_window: min_dv_settlement_window,
    },
    #"0000",
    #"22",
  )
}

test open_dv_claim_rejects_before_the_root_is_anchored() {
  !run_open_dv_claim(
    BondingCurveTierBDatum { ..pre_claim_datum(), dv_settled: False },
    #"0000",
    #"22",
  )
}

test open_dv_claim_rejects_a_launch_with_no_darkveil() {
  !run_open_dv_claim(
    BondingCurveTierBDatum { ..pre_claim_datum(), dv_reserve_tokens: 0 },
    #"0000",
    #"22",
  )
}

test open_dv_claim_rejects_reopening_the_window() {
  !run_open_dv_claim(
    BondingCurveTierBDatum { ..pre_claim_datum(), curve_state: DvClaim },
    #"0000",
    #"22",
  )
}

test set_bit_matches_test_bit_across_a_byte_boundary() {
  // MSB-first, and length-preserving — a claim must not be able to grow the
  // datum it writes back.
  let empty = #"0000"
  let b0 = bitmap.set_bit(empty, 0)
  let b7 = bitmap.set_bit(empty, 7)
  let b8 = bitmap.set_bit(empty, 8)
  let b15 = bitmap.set_bit(empty, 15)
  and {
    b0 == #"8000",
    b7 == #"0100",
    b8 == #"0080",
    b15 == #"0001",
    bytearray.test_bit(b0, 0),
    !bytearray.test_bit(b0, 1),
    bytearray.test_bit(b8, 8),
    !bytearray.test_bit(b8, 7),
    // Setting a second bit leaves the first alone.
    bitmap.set_bit(b0, 9) == #"8040",
    bytearray.length(bitmap.set_bit(empty, 15)) == 2,
  }
}

// Cross-implementation ground truth, shared with integration/
// dv-allocation-tree.ts's own test of the same three values. The off-chain
// tree builder and this validator must agree byte-for-byte or no proof
// verifies; pinning the literals in BOTH places is what makes a silent drift
// between them impossible.
test hash_dv_leaf_matches_the_offchain_tree_builder() {
  let leaf0 = hash_dv_leaf(#"aa", 100, 0, #"01")
  let leaf1 = hash_dv_leaf(#"bb", 200, 1, #"02")
  and {
    leaf0 == #"eb01560639a5cd1228c9424a325c02cf30dbdd15256e0012a718af2b1d4c5578",
    leaf1 == #"49a01736c806987b039b2f0b076989c8166a8119abdf71e8101018d29c6287b6",
    hash_dv_node(leaf0, leaf1) == #"737dd30dd854d1fd266d50006b5efc236b827b8a55f521a10fc2811951f0f70d",
  }
}

test hash_dv_leaf_differs_for_different_leaf_indices() {
  // Without index binding, a registrant could present a real allocation
  // against somebody else's still-clear bit.
  hash_dv_leaf(#"aa", 100, 0, #"01") != hash_dv_leaf(#"aa", 100, 1, #"01")
}

/// Runs a claim at `now` against `datum`, with the leaf pre-anchored as the
/// root (single-leaf tree, empty proof) so these cases isolate one rule each.
fn run_claim(
  datum: BondingCurveTierBDatum,
  leaf_index: Int,
  now: Int,
) -> Bool {
  let buyer_key = #"dd"
  let dv_amount = 10
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
  // set_bit indexes the bytearray directly, so an out-of-range index would
  // error HERE — inside the test's own expectation — before the validator ever
  // got the chance to reject it. Out-of-range cases expect the bits unchanged;
  // the validator's own range checks are what must do the rejecting.
  let expected_bits =
    if leaf_index >= 0 && leaf_index < bytearray.length(datum.claimed_bits) * 8 {
      bitmap.set_bit(datum.claimed_bits, leaf_index)
    } else {
      datum.claimed_bits
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: datum.tokens_sold + dv_amount,
      // gross 10 * 100 = 1000; creator 0.5% = 5, platform 1.0% = 10.
      total_raised: datum.total_raised + 985,
      creator_fees_accrued: datum.creator_fees_accrued + 5,
      platform_fees_accrued: datum.platform_fees_accrued + 10,
      claimed_bits: expected_bits,
      // A DarkVeil claim spends the same headroom a public buy would — it
      // fills the claimer's own slot in the very accumulator the public curve
      // reads afterwards.
      cap_root: cap_root([(buyer_key, dv_amount)]),
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [
        Output {
          address: own_address,
          value: assets.merge(mock_curve_nft(), assets.merge(
            assets.from_lovelace(base_lovelace + 1000),
            assets.from_asset(#"33", "tok", 990),
          )),
          datum: InlineDatum(new_datum),
          reference_script: None,
        },
        Output {
          address: from_verification_key(buyer_key),
          value: assets.from_asset(#"33", "tok", 10),
          datum: InlineDatum(own_ref),
          reference_script: None,
        },
      ],
      extra_signatories: [buyer_key],
      validity_range: interval.between(now - 100, now + 100),
    }
  bonding_curve_tier_b.spend(
    Some(datum),
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: #"aa",
      merkle_proof: [],
      buyer_key_hash: buyer_key,
      leaf_index: leaf_index,
      current_timestamp: now,
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    },
    own_ref,
    self,
  )
}

/// A datum in the claim window whose root is the leaf for `leaf_index`.
fn claimable_datum(leaf_index: Int) -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    ..mock_datum(DvClaim, 0),
    dv_settled: True,
    dv_allocation_root: hash_dv_leaf(#"dd", 10, leaf_index, #"aa"),
    claimed_bits: #"00",
  }
}

test claim_darkveil_tokens_accepts_on_the_final_millisecond_of_the_window() {
  and {
    run_claim(claimable_datum(0), 0, test_claim_closes),
    !run_claim(claimable_datum(0), 0, test_claim_closes + 1),
  }
}

// The deadline is the LAUNCH's, not the script's. This is the test that would
// have failed before the window became a datum field: at 600,001 ms a claim is
// barely ten minutes old and sits far inside the 24 hours the old constant
// imposed on every launch alike, so under that constant it was accepted. It is
// refused here because THIS launch declared ten minutes.
test claim_darkveil_tokens_follows_the_launchs_own_window() {
  let short =
    BondingCurveTierBDatum {
      ..claimable_datum(0),
      dv_claim_window: min_dv_claim_window,
    }
  and {
    run_claim(short, 0, min_dv_claim_window),
    !run_claim(short, 0, min_dv_claim_window + 1),
  }
}

// The bit is addressed by index, so a claim must land on its own bit and only
// on bits the window was actually sized for.
test claim_darkveil_tokens_uses_its_own_bit() {
  and {
    run_claim(claimable_datum(3), 3, 1000),
    // Index 8 is out of range for a one-byte bitmap.
    !run_claim(claimable_datum(8), 8, 1000),
    !run_claim(claimable_datum(0), -1, 1000),
  }
}

test claim_darkveil_tokens_rejects_a_bit_already_set() {
  let datum =
    BondingCurveTierBDatum { ..claimable_datum(1), claimed_bits: #"40" }
  !run_claim(datum, 1, 1000)
}

// Whatever the allocation root says, the phase cannot settle more than its own
// share of supply.
test claim_darkveil_tokens_rejects_exceeding_the_darkveil_reserve() {
  let datum =
    BondingCurveTierBDatum {
      ..claimable_datum(0),
      dv_reserve_tokens: 5,
    }
  !run_claim(datum, 0, 1000)
}

// Claims belong to the window and nowhere else: not before it opens, and not
// once public trading has started.
test claim_darkveil_tokens_rejects_outside_the_claim_state() {
  and {
    !run_claim(
      BondingCurveTierBDatum { ..claimable_datum(0), curve_state: Inactive },
      0,
      1000,
    ),
    !run_claim(
      BondingCurveTierBDatum { ..claimable_datum(0), curve_state: Active },
      0,
      1000,
    ),
  }
}

test claim_darkveil_tokens_succeeds_with_valid_proof_and_payment() {
  let buyer_key = #"dd"
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, 0, salt)
  let datum =
    BondingCurveTierBDatum { ..mock_datum(DvClaim, 0), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 985,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      claimed_bits: #"80",
      cap_root: cap_root([(buyer_key, dv_amount)]),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
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
      extra_signatories: [buyer_key],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      buyer_key_hash: buyer_key,
      leaf_index: 0,
      current_timestamp: 1000,
      cap_committed_before: 0,
      cap_proof: cap_proof(buyer_key, []),
    }

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_double_claim() {
  let buyer_key = #"dd"
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, 0, salt)
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(DvClaim, 0),
      dv_allocation_root: leaf,
      // Already claimed once — this is the exact double-claim this test
      // proves is rejected.
      claimed_bits: #"80",
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 985,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
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
      extra_signatories: [buyer_key],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      buyer_key_hash: buyer_key,
      leaf_index: 0,
      current_timestamp: 1000,
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_wrong_salt() {
  // Same scaffolding as the success test, but the claim presents a
  // different salt than the one the root was actually built from — the
  // derived leaf won't match, proving the claim is bound to the real
  // private allocation, not just a guessed (vkh, amount) pair.
  let buyer_key = #"dd"
  let dv_amount = 10
  let real_salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, 0, real_salt)
  let datum =
    BondingCurveTierBDatum { ..mock_datum(DvClaim, 0), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 985,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      claimed_bits: #"80",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
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
      extra_signatories: [buyer_key],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: #"bb",
      merkle_proof: [],
      buyer_key_hash: buyer_key,
      leaf_index: 0,
      current_timestamp: 1000,
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_creator_claiming() {
  // Same wash-trade protection: the creator cannot claim a DarkVeil
  // allocation against their own launch, even with a structurally valid
  // proof — same wash-trade concern BuyTokens already guards against.
  let creator_key = #"11"
  // mock_datum's creator_pub_key_hash
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(creator_key, dv_amount, 0, salt)
  let datum =
    BondingCurveTierBDatum { ..mock_datum(DvClaim, 0), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(creator_key)
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 985,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      claimed_bits: #"80",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
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
      extra_signatories: [creator_key],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      buyer_key_hash: creator_key,
      leaf_index: 0,
      current_timestamp: 1000,
      cap_committed_before: 0,
      cap_proof: cap_proof(creator_key, []),
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_payment_not_received() {
  let buyer_key = #"dd"
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, 0, salt)
  let datum =
    BondingCurveTierBDatum { ..mock_datum(DvClaim, 0), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 985,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      claimed_bits: #"80",
    }
  let continuing_output =
    Output {
      address: own_address,
      // No lovelace increase — claimed payment but didn't actually send it.
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
      extra_signatories: [buyer_key],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      buyer_key_hash: buyer_key,
      leaf_index: 0,
      current_timestamp: 1000,
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_a_single_claim_over_the_cap() {
  // The cap applies per transaction on the DarkVeil path too. This claim is
  // otherwise entirely valid — real Merkle proof, real payment — and its
  // 10-token amount exceeds a deliberately lowered 5-token cap.
  let buyer_key = #"dd"
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, 0, salt)
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(DvClaim, 0),
      wallet_cap: 5,
      dv_allocation_root: leaf,
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 985,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      claimed_bits: #"80",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
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
      extra_signatories: [buyer_key],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      buyer_key_hash: buyer_key,
      leaf_index: 0,
      current_timestamp: 1000,
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// BatchTrades — N orders applied against one curve UTXO
// ----------------------------------------------------------------------------

/// Drives a batch of buy orders. Each owner gets their OWN token output, which
/// is the thing a batch has to get right and a single trade never exercises.
fn run_buy_batch(
  datum: BondingCurveTierBDatum,
  orders: List<BatchOrder>,
  owner_outputs: List<Output>,
  gross_total: Int,
) -> Bool {
  run_buy_batch_signed(datum, orders, owner_outputs, gross_total, #"ba")
}

/// Same, but the redeemer names `batcher` while the transaction is still signed
/// by #"ba" — so an unauthorised batcher key can be tested without hand-rolling
/// a transaction that has no curve input at all (which aborts the validator
/// rather than failing it).
fn run_buy_batch_signed(
  datum: BondingCurveTierBDatum,
  orders: List<BatchOrder>,
  owner_outputs: List<Output>,
  gross_total: Int,
  batcher: VerificationKeyHash,
) -> Bool {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let base = 5_000_000
  let sold_total =
    list.foldl(orders, 0, fn(o, acc) { acc + o.amount })
  let creator_total =
    list.foldl(
      orders,
      0,
      fn(o, fees) {
        fees + fee_slice(uniform_buy_share(datum, orders, o.amount), creator_bps)
      },
    )
  let platform_total =
    list.foldl(
      orders,
      0,
      fn(o, fees) {
        fees + fee_slice(uniform_buy_share(datum, orders, o.amount), platform_bps)
      },
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
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
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base + gross_total),
        assets.from_asset(#"33", "tok", 1000 - sold_total),
      )),
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
  bonding_curve_tier_b.spend(
    Some(datum),
    BatchTrades { orders: orders, batcher_key_hash: batcher },
    own_ref,
    self,
  )
}

/// The accepted batch with its continuing value varied by one delta. A datum
/// is a record of what a batch claims; these are the curve's own UTXO failing
/// to move by it.
/// What one buy order of `amount` pays under uniform pricing: its pro-rata
/// slice of the batch's single range, rounded UP exactly as the validator
/// rounds it. Defined once so a fixture cannot quietly price differently from
/// the redeemer it is meant to be checking.
fn two_buy_uniform_total(datum: BondingCurveTierBDatum) -> Int {
  uniform_buy_share(datum, two_buy_orders(), 400) + uniform_buy_share(
    datum,
    two_buy_orders(),
    300,
  )
}

fn uniform_buy_share(
  datum: BondingCurveTierBDatum,
  orders: List<BatchOrder>,
  amount: Int,
) -> Int {
  let batch_amount = list.foldl(orders, 0, fn(o, acc) { acc + o.amount })
  let batch_gross = buy_cost(datum, datum.tokens_sold, batch_amount)
  ( batch_gross * amount + batch_amount - 1 ) / batch_amount
}

fn run_buy_batch_drained(
  datum: BondingCurveTierBDatum,
  orders: List<BatchOrder>,
  owner_outputs: List<Output>,
  gross_total: Int,
  lovelace_delta: Int,
  token_delta: Int,
) -> Bool {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let base = 5_000_000
  let sold_total =
    list.foldl(orders, 0, fn(o, acc) { acc + o.amount })
  let creator_total =
    list.foldl(
      orders,
      0,
      fn(o, fees) {
        fees + fee_slice(uniform_buy_share(datum, orders, o.amount), creator_bps)
      },
    )
  let platform_total =
    list.foldl(
      orders,
      0,
      fn(o, fees) {
        fees + fee_slice(uniform_buy_share(datum, orders, o.amount), platform_bps)
      },
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base),
          assets.from_asset(#"33", "tok", 1000),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
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
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base + gross_total + lovelace_delta),
        assets.from_asset(#"33", "tok", 1000 - sold_total + token_delta),
      )),
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
  bonding_curve_tier_b.spend(
    Some(datum),
    BatchTrades { orders: orders, batcher_key_hash: #"ba" },
    own_ref,
    self,
  )
}

test batch_accepts_the_shape_the_rejections_vary() {
  let d = mock_datum(Active, 0)
  run_buy_batch_drained(
    d,
    two_buy_orders(),
    [tok_out(0, #"de", 400), tok_out(1, #"df", 300)],
    two_buy_uniform_total(d),
    0,
    0,
  )
}

test batch_rejects_keeping_the_payment() {
  let d = mock_datum(Active, 0)
  let gross = two_buy_uniform_total(d)
  !run_buy_batch_drained(
    d,
    two_buy_orders(),
    [tok_out(0, #"de", 400), tok_out(1, #"df", 300)],
    gross,
    -gross,
    0,
  )
}

test batch_rejects_leaving_the_reserve_intact() {
  let d = mock_datum(Active, 0)
  let gross = two_buy_uniform_total(d)
  !run_buy_batch_drained(
    d,
    two_buy_orders(),
    [tok_out(0, #"de", 400), tok_out(1, #"df", 300)],
    gross,
    0,
    700,
  )
}


/// A fill for the order at `index`, tagged with that order's own reference.
/// The index matters: it is what makes one owner's two fills distinguishable,
/// so a helper that ignored it would build fixtures unable to fail.
fn tok_out(index: Int, owner: VerificationKeyHash, amount: Int) -> Output {
  Output {
    address: from_verification_key(owner),
    value: assets.from_asset(#"33", "tok", amount),
    datum: InlineDatum(order_ref_at(index)),
    reference_script: None,
  }
}

/// The property the whole design rests on: every order in a batch pays the
/// batch average, so position within the batch is worth nothing.
/// 400 then 300 rather than 10 then 5, deliberately. On this fixture's curve
/// a 5-token order costs exactly 500 at position 0 AND at position 10 — the
/// quadratic term floors away — so small amounts make the position test
/// unfalsifiable. These are large enough for position to change the price and
/// still inside the 500 wallet cap.
fn two_buy_orders() -> List<BatchOrder> {
  batch_orders([(#"de", True, 400, 400), (#"df", True, 300, 300)])
}

/// POSITIVE half, with the figures pinned rather than recomputed.
///
/// 400 tokens then 300, on this fixture's curve from position 0. Sequentially
/// they pay 59,129 and 113,552 — 147.82 and 378.51 per token, a 156% spread
/// bought purely by being first. Uniformly they pay 98,675 and 74,006, which
/// is 246.69 per token for both.
///
/// THE CURVE RECEIVES 172,681 EITHER WAY. That is the additivity property the
/// decision rests on, and it is why uniform pricing costs the protocol
/// nothing — asserted here against literals so it stays a measured fact.
test batch_prices_every_order_at_the_batch_average() {
  let d = mock_datum(Active, 0)
  and {
    uniform_buy_share(d, two_buy_orders(), 400) == 98_675,
    uniform_buy_share(d, two_buy_orders(), 300) == 74_006,
    // Identical totals, so the total alone cannot tell the two models apart.
    two_buy_uniform_total(d) == 172_681,
    buy_cost(d, 0, 400) + buy_cost(d, 400, 300) == 172_681,
    run_buy_batch(
      d,
      two_buy_orders(),
      [tok_out(0, #"de", 400), tok_out(1, #"df", 300)],
      two_buy_uniform_total(d),
    ),
  }
}

/// What actually separates the two models, and therefore what would catch a
/// silent regression to sequential: the FEE. Each order is charged its own
/// floored slice, so a different split of the same total yields a different
/// creator fee — 863 under uniform against 862 under sequential. The curve
/// total is identical, so without this the fixtures above would pass under
/// either model.
test batch_fee_total_distinguishes_uniform_from_sequential() {
  let d = mock_datum(Active, 0)
  let uniform_creator =
    fee_slice(uniform_buy_share(d, two_buy_orders(), 400), creator_bps) + fee_slice(
      uniform_buy_share(d, two_buy_orders(), 300),
      creator_bps,
    )
  let sequential_creator =
    fee_slice(buy_cost(d, 0, 400), creator_bps) + fee_slice(
      buy_cost(d, 400, 300),
      creator_bps,
    )
  and {
    uniform_creator == 863,
    sequential_creator == 862,
    uniform_creator != sequential_creator,
  }
}

/// NEGATIVE half: pricing BOTH orders from position 0 is strictly cheaper, so
/// it must not satisfy the validator.
test batch_rejects_pricing_every_order_from_the_batch_start() {
  let d = mock_datum(Active, 0)
  !run_buy_batch(
    d,
    two_buy_orders(),
    [tok_out(0, #"de", 400), tok_out(1, #"df", 300)],
    buy_cost(d, 0, 400) + buy_cost(d, 0, 300),
  )
}

/// The gap found while writing the redeemer: "some output holds the tokens" is
/// enough for one buyer and wrong for N. One owner's output must not satisfy
/// another owner's entitlement.
test batch_requires_each_owner_to_be_paid_individually() {
  let d = mock_datum(Active, 0)
  let orders = two_buy_orders()
  let gross = two_buy_uniform_total(d)
  and {
    // Both owners paid — accepted.
    run_buy_batch(d, orders, [tok_out(0, #"de", 400), tok_out(1, #"df", 300)], gross),
    // Only the first owner paid, for the whole batch. The token count leaving
    // the curve is right; the second owner gets nothing.
    !run_buy_batch(d, orders, [tok_out(0, #"de", 700)], gross),
    // Paid, but to the wrong wallet.
    !run_buy_batch(d, orders, [tok_out(0, #"de", 400), tok_out(1, #"ff", 300)], gross),
  }
}

/// Ten orders, the batch size the pricing decision was argued about at. Kept as a
/// measurement fixture: `aiken check -m batch_ten_order_cost` reports the
/// ExUnits the redeemer really uses at that size, which is the only way to
/// compare the two pricing models honestly rather than by argument.
test batch_ten_order_cost() {
  let d = mock_datum(Active, 0)
  let orders =
    batch_orders(
      [
        (#"aa00", True, 40, 40), (#"aa01", True, 40, 40), (#"aa02", True, 40, 40),
        (#"aa03", True, 40, 40), (#"aa04", True, 40, 40), (#"aa05", True, 40, 40),
        (#"aa06", True, 40, 40), (#"aa07", True, 40, 40), (#"aa08", True, 40, 40),
        (#"aa09", True, 40, 40),
      ],
    )
  let outs =
    [
      tok_out(0, #"aa00", 40), tok_out(1, #"aa01", 40), tok_out(2, #"aa02", 40),
      tok_out(3, #"aa03", 40), tok_out(4, #"aa04", 40), tok_out(5, #"aa05", 40),
      tok_out(6, #"aa06", 40), tok_out(7, #"aa07", 40), tok_out(8, #"aa08", 40),
      tok_out(9, #"aa09", 40),
    ]
  let total =
    list.foldl(
      orders,
      0,
      fn(o, acc) { acc + uniform_buy_share(d, orders, o.amount) },
    )
  run_buy_batch(d, orders, outs, total)
}

test batch_enforces_each_orders_own_min_received() {
  let d = mock_datum(Active, 0)
  let orders =
    // The second asks for more tokens than the order buys.
    batch_orders([(#"de", True, 10, 10), (#"df", True, 5, 6)])
  !run_buy_batch(
    d,
    orders,
    [tok_out(0, #"de", 400), tok_out(1, #"df", 300)],
    two_buy_uniform_total(d),
  )
}

test batch_rejects_an_unsigned_batcher_and_an_empty_batch() {
  let d = mock_datum(Active, 0)
  let orders = batch_orders([(#"de", True, 10, 10)])
  let gross = buy_cost(d, 0, 10)
  and {
    run_buy_batch(d, orders, [tok_out(0, #"de", 10)], gross),
    // An empty batch would let a caller move the curve datum for nothing.
    !run_buy_batch(d, [], [], 0),
    // A batcher key nobody signed for.
    !run_buy_batch_signed(d, orders, [tok_out(0, #"de", 10)], gross, #"ff"),
  }
}

test batch_still_blocks_the_creator_and_the_per_order_cap() {
  let d = mock_datum(Active, 0)
  let creator_order = batch_orders([(#"11", True, 10, 10)])
  let over_cap = batch_orders([(#"de", True, 600, 600)])
  and {
    // #"11" is mock_datum's creator.
    !run_buy_batch(d, creator_order, [tok_out(0, #"11", 10)], buy_cost(d, 0, 10)),
    // wallet_cap is 500.
    !run_buy_batch(d, over_cap, [tok_out(0, #"de", 600)], buy_cost(d, 0, 600)),
  }
}

/// The batch path must not be the way around the cumulative cap. Splitting one
/// wallet's purchase into two orders that are each individually under the cap
/// is exactly the move a per-order check would wave through — and the reason
/// the fold threads the root rather than checking each order against the
/// batch's starting state.
test batch_rejects_splitting_one_wallet_across_orders_to_beat_the_cap() {
  let d = mock_datum(Active, 0)
  let under = batch_orders([(#"de", True, 200, 200), (#"de", True, 200, 200)])
  let over = batch_orders([(#"de", True, 300, 300), (#"de", True, 300, 300)])
  and {
    // 200 + 200 = 400, inside the 500 cap. Two orders, so two fills: each
    // names the order it settles even though both belong to one wallet.
    run_buy_batch(
      d,
      under,
      [tok_out(0, #"de", 200), tok_out(1, #"de", 200)],
      buy_cost(d, 0, 200) + buy_cost(d, 200, 200),
    ),
    // 300 + 300 = 600. Each order is under the cap on its own; together they
    // are not.
    !run_buy_batch(
      d,
      over,
      [tok_out(0, #"de", 300), tok_out(1, #"de", 300)],
      buy_cost(d, 0, 300) + buy_cost(d, 300, 300),
    ),
  }
}

/// One owner's two orders are two obligations. Before each fill named the
/// order it settles, a single payment sized for ONE of them answered both —
/// the curve advanced by 400 tokens and the owner received 200.
test batch_rejects_one_payment_for_two_of_one_owners_orders() {
  let d = mock_datum(Active, 0)
  let two = batch_orders([(#"de", True, 200, 200), (#"de", True, 200, 200)])
  let gross = buy_cost(d, 0, 200) + buy_cost(d, 200, 200)
  and {
    // The control: paid properly, it is accepted.
    run_buy_batch(d, two, [tok_out(0, #"de", 200), tok_out(1, #"de", 200)], gross),
    // One fill, tagged for the first order only.
    !run_buy_batch(d, two, [tok_out(0, #"de", 200)], gross),
    // One output large enough for both, but naming only one of them.
    !run_buy_batch(d, two, [tok_out(0, #"de", 400)], gross),
  }
}

/// A sell has to RELEASE headroom, or a trader who buys their full 5% and
/// exits is barred from the launch for the rest of its life. Same numbers as
/// the round-trip test below, with the accumulator actually carrying the
/// buyer's 10 beforehand.
test sell_tokens_returns_the_wallets_headroom() {
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 10),
      cap_root: cap_root([(#"dd", 10)]),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -1000,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      // Back to the genesis root — the slot is free, so this wallet can buy
      // its full cap again.
      cap_root: cap_root([]),
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [
        Output {
          address: own_address,
          value: assets.merge(mock_curve_nft(), assets.merge(
            assets.from_lovelace(base_lovelace + 1000 - 985),
            assets.from_asset(#"33", "tok", 1000),
          )),
          datum: InlineDatum(new_datum),
          reference_script: None,
        },
        Output {
          address: from_verification_key(#"dd"),
          value: assets.from_lovelace(985),
          datum: InlineDatum(own_ref),
          reference_script: None,
        },
      ],
      extra_signatories: [#"dd"],
    }
  and {
    bonding_curve_tier_b.spend(
      Some(datum),
      SellTokens {
        token_amount: 10,
        seller_key_hash: #"dd",
        cap_committed_before: 10,
        cap_proof: cap_proof(#"dd", [(#"dd", 10)]),
      },
      own_ref,
      self,
    ),
    // The same sell claiming the slot was empty cannot reach the root, so a
    // seller cannot leave their headroom spent by understating it either.
    !bonding_curve_tier_b.spend(
      Some(datum),
      SellTokens {
        token_amount: 10,
        seller_key_hash: #"dd",
        cap_committed_before: 0,
        cap_proof: cap_proof(#"dd", [(#"dd", 10)]),
      },
      own_ref,
      self,
    ),
  }
}

test sell_tokens_succeeds_symmetric_round_trip() {
  // Wallet #"dd" previously bought 10 tokens (tokens_sold 0->10, same
  // numbers as buy_tokens_succeeds_for_buyer_who_already_claimed_darkveil's
  // base case). Selling all 10 back vacates positions 0..9 — the SAME range
  // the original buy paid for, by design (see this redeemer's own doc comment
  // in the type definition above). That range is worth 1000.2565 lovelace,
  // rounded DOWN to 1000 for a seller against the buyer's 1001, so the round
  // trip costs one lovelace before fees. fee_total = 15 (creator 5 + platform 10),
  // net_proceeds = 980 paid to the seller.
  let datum = mock_datum(Active, 10)
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
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 0,
      // 0 - 1000 = -1000 (this fixture starts total_raised at 0, unlike
      // The linear curve's sold_state_datum() which pre-seeds it at 980) — the sign
      // itself is what this test demonstrates: legitimately negative after
      // a round trip, per the redeemer's own doc comment, never a
      // fund-safety issue since lovelace_paid_from_curve already bounds
      // real payouts to the curve's actual balance.
      total_raised: -1000,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000 - 985),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(985),
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

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_succeeds_for_a_darkveil_claimed_amount() {
  // Wallet #"dd" never bought publicly — their tracked total came entirely
  // from a prior ClaimDarkVeilTokens call (seeded
  // directly, same as this file's own claim_darkveil-then-buy tests do it
  // the other way around). Confirms SellTokens doesn't distinguish DV-
  // sourced vs public-sourced tracked purchases — see the redeemer's own
  // doc comment for why that's deliberate, not an oversight.
  let datum = mock_datum(Active, 10)
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
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -1000,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace - 985),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(985),
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

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_selling_more_than_ever_bought() {
  // Wallet #"dd" only ever bought/claimed 10 — attempting to sell 11 (as
  // though tokens were topped up via a secondary transfer) must be
  // rejected, per this redeemer's own documented scope limit.
  let datum = mock_datum(Active, 10)
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
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: -1,
      total_raised: -1210,
      creator_fees_accrued: 13,
      platform_fees_accrued: 12,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000 - 1185),
        assets.from_asset(#"33", "tok", 1001),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(1185),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_creator_selling_own_curve() {
  // The creator is permanently blocked from BuyTokens/ClaimDarkVeilTokens,
  // sell_tokens_rejects_selling_more_than_ever_bought's own logic
  // the explicit creator check covers this with no separate
  // check needed. This test confirms that fallout is real, not just
  // theorized, same as the linear curve's identical test.
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
  let new_datum = BondingCurveTierBDatum { ..datum, tokens_sold: 0 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(5_000_000 - 980),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: creator_address,
      value: assets.from_lovelace(980),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_unauthenticated_seller_key_hash() {
  let datum = mock_datum(Active, 10)
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
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -1000,
      creator_fees_accrued: 10,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 20),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(980),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_a_payout_larger_than_the_range_is_worth() {
  let datum = mock_datum(Active, 10)
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
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Attempts to draw the proceeds of the top of the curve (price 1000, the
  // sold=1000 spot) for a range that actually sits at the bottom.
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -10000,
      creator_fees_accrued: 100,
      platform_fees_accrued: 100,
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_padded_continuing_output() {
  // Sell direction: identical to a normal successful sell, except the
  // curve's own continuing output carries one extra, unrelated junk asset.
  // curve_own_output_clean must reject this exactly as it already does for
  // BuyTokens (buy_tokens_rejects_padded_continuing_output) — no dedicated
  // test previously proved this redeemer branch actually wires that check
  // in, only that the shared helper itself works.
  let datum = mock_datum(Active, 10)
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
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -1000,
      creator_fees_accrued: 10,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.merge(
          assets.from_lovelace(base_lovelace + 1000 - 980),
          assets.from_asset(#"33", "tok", 1000),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(980),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_proceeds_not_actually_paid() {
  // Datum and delivered tokens look exactly like a valid sell, but the
  // curve's own lovelace balance never actually decreases — the seller is
  // never really paid. lovelace_paid_from_curve must reject this; no
  // dedicated test previously proved SellTokens wires that check in.
  let datum = mock_datum(Active, 10)
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
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -1000,
      creator_fees_accrued: 10,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      // No decrease — claims 980 net_proceeds were paid out but weren't.
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 1000),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      // Seller receives nothing, despite the redeemer claiming 980.
      value: assets.from_lovelace(0),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_tokens_not_actually_returned() {
  // Datum and lovelace payout look exactly like a valid sell, but the
  // curve's own token reserve never actually grows — the seller's tokens
  // never really arrived. tokens_returned_to_curve must reject this; no
  // dedicated test previously proved SellTokens wires that check in
  // (mirrors buy_tokens_rejects_tokens_not_sourced_from_curve_reserve's
  // coverage, in the opposite direction).
  let datum = mock_datum(Active, 10)
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
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -1000,
      creator_fees_accrued: 10,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      // Token balance stays at 990 — claims 10 tokens were returned but
      // weren't. Lovelace side pays out correctly, isolating this check.
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1000 - 980),
        assets.from_asset(#"33", "tok", 990),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(980),
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_without_buyer_signature() {
  // Same as a valid buy, but the buyer never signed — proves cap
  // enforcement is bound to a real signature, not just a claimed key hash
  // in the redeemer.
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 986,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace + 1001),
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
      // no extra_signatories — buyer never signed
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      buyer_key_hash: #"dd",
      cap_committed_before: 0,
      cap_proof: cap_proof(#"dd", []),
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_payment_not_actually_received() {
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
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 986,
      creator_fees_accrued: 5,
      platform_fees_accrued: 10,
      }
  let continuing_output =
    Output {
      address: own_address,
      // No increase — claimed 1000 lovelace but didn't pay it.
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

/// End of the claim window, and end of the dead window that follows it, for a
/// launch whose `dv_claim_opened_at` is 0 (as `mock_datum`'s is).
const test_claim_closes = 86_400_000

const test_curve_opens = 88_200_000

/// Drives ActivateCurve at `now` against a datum in `state`, returning whether
/// the validator accepted. Deliberately signs with nobody: activation is
/// permissionless once the deadline passes, and every one of these cases must
/// hold without a governor signature.
fn run_activate(
  datum: BondingCurveTierBDatum,
  now: Int,
) -> Bool {
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
    BondingCurveTierBDatum {
      ..datum,
      curve_state: Active,
      phase_started_at: now,
      claimed_bits: #"",
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
      validity_range: interval.between(now - 100, now + 100),
    }
  bonding_curve_tier_b.spend(
    Some(datum),
    ActivateCurve { current_timestamp: now },
    own_ref,
    self,
  )
}

fn dv_claim_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    ..mock_datum(DvClaim, 0),
    dv_settled: True,
    claimed_bits: #"80",
  }
}

test activate_curve_succeeds_once_claim_and_dead_windows_have_passed() {
  // No signature anywhere in run_activate: the deadline is the authorization.
  run_activate(dv_claim_datum(), test_curve_opens)
}

test activate_curve_rejects_inside_the_claim_window() {
  !run_activate(dv_claim_datum(), test_claim_closes - 1)
}

// The dead window is the point of the whole arrangement: DarkVeil settlement
// has to be final before the first public trade, not merely likely to be.
test activate_curve_rejects_inside_the_dead_window() {
  and {
    !run_activate(dv_claim_datum(), test_claim_closes + 1),
    !run_activate(dv_claim_datum(), test_curve_opens - 1),
  }
}

test activate_curve_rejects_skipping_the_claim_window_entirely() {
  // Still Inactive, but this launch has a DarkVeil allocation to settle.
  let datum = BondingCurveTierBDatum { ..mock_datum(Inactive, 0), dv_settled: True }
  !run_activate(datum, test_curve_opens)
}

// A launch with no DarkVeil phase (cancelled below MIN_DV_PARTICIPANTS) has no
// window to wait out and opens straight from Inactive.
test activate_curve_succeeds_from_inactive_when_no_darkveil() {
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Inactive, 0),
      dv_settled: True,
      dv_reserve_tokens: 0,
      claimed_bits: #"",
    }
  run_activate(datum, 500)
}

// The nullifier has done its whole job by the time the curve opens; carrying it
// into public trading would put participation-sized state in the datum of every
// subsequent transaction.
test activate_curve_clears_the_claim_bitmap() {
  let datum =
    BondingCurveTierBDatum { ..dv_claim_datum(), claimed_bits: #"ffff" }
  and {
    run_activate(datum, test_curve_opens),
    // ...and will not accept an activation that keeps it.
    !{
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
      let kept =
        BondingCurveTierBDatum {
          ..datum,
          curve_state: Active,
          phase_started_at: test_curve_opens,
        }
      let self =
        Transaction {
          ..transaction.placeholder,
          inputs: [own_input],
          outputs: [
            Output {
              address: own_address,
              value: mock_curve_nft(),
              datum: InlineDatum(kept),
              reference_script: None,
            },
          ],
          validity_range: interval.between(
            test_curve_opens - 100,
            test_curve_opens + 100,
          ),
        }
      bonding_curve_tier_b.spend(
        Some(datum),
        ActivateCurve { current_timestamp: test_curve_opens },
        own_ref,
        self,
      )
    },
  }
}

// DarkVeil settlement not anchored yet — real launches must not be
// able to open public trading with dv_allocation_root still at its
// placeholder (ClaimDarkVeilTokens would then be permanently unusable for
// this launch, with no on-chain signal anything is wrong).
test activate_curve_rejects_when_dv_not_settled() {
  // Everything else about this activation is valid — right state, past both
  // windows — so the rejection can only be the unsettled root.
  !run_activate(
    BondingCurveTierBDatum { ..dv_claim_datum(), dv_settled: False },
    test_curve_opens,
  )
}

test activate_curve_rejects_when_dv_not_settled_from_inactive() {
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
    BondingCurveTierBDatum { ..datum, curve_state: Active, phase_started_at: 500 }
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

// The core fix — governor anchors the real, off-chain-computed
// allocation root while the curve is still Inactive.
test anchor_dv_allocation_root_succeeds_for_governor() {
  let datum = mock_datum(Inactive, 0)
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
  let real_root = #"deadbeef"
  let new_datum =
    BondingCurveTierBDatum { ..datum, dv_allocation_root: real_root, dv_settled: True }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
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

  bonding_curve_tier_b.spend(
    Some(datum),
    AnchorDvAllocationRoot { dv_allocation_root: real_root },
    own_ref,
    self,
  )
}

test anchor_dv_allocation_root_rejects_non_governor() {
  let datum = mock_datum(Inactive, 0)
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
  let real_root = #"deadbeef"
  let new_datum =
    BondingCurveTierBDatum { ..datum, dv_allocation_root: real_root, dv_settled: True }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // stranger, not the governor
      extra_signatories: [#"99"],
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    AnchorDvAllocationRoot { dv_allocation_root: real_root },
    own_ref,
    self,
  )
}

// Once public trading has opened, the root is permanently frozen —
// ClaimDarkVeilTokens's own curve_state == Active requirement means any
// claim already made was validated against whatever root was anchored
// before activation; letting the governor rewrite it afterward would let
// an already-settled claim's proof retroactively become invalid, or a new
// forged tree validate claims that were never real.
test anchor_dv_allocation_root_rejects_after_curve_active() {
  let datum = BondingCurveTierBDatum { ..mock_datum(Active, 0), dv_settled: True }
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
  let forged_root = #"cafebabe"
  let new_datum =
    BondingCurveTierBDatum { ..datum, dv_allocation_root: forged_root, dv_settled: True }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    AnchorDvAllocationRoot { dv_allocation_root: forged_root },
    own_ref,
    self,
  )
}

test expire_curve_succeeds_after_deadline_with_no_signature() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
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

  bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test expire_curve_rejects_padded_continuing_output() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "tok", 500),
        ),
        assets.from_asset(#"deadbeef", "spam", 1),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

// Same finding/fix as the linear curve's bonding_curve.ak — see that file's
// own `expire_curve_rejects_wide_validity_range` test for the full
// explanation.
test expire_curve_rejects_wide_validity_range() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
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
      validity_range: interval.between(0, past_deadline + 100),
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test expire_curve_rejects_before_deadline() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // ms-scale, matches max_curve_duration's real unit
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: before_deadline },
    own_ref,
    self,
  )
}

test cancel_curve_fails_after_graduation() {
  let datum = mock_datum(Graduated, 1000)
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: mock_curve_funded(),
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

  !bonding_curve_tier_b.spend(Some(datum), CancelCurve, own_ref, self)
}

// ----------------------------------------------------------------------------
// CTO fee-redirect fix (2026-07-12): TriggerCTO/DissolveCTO + redirected
// ClaimCreatorFees — same tests as the linear curve's bonding_curve.ak.
// ----------------------------------------------------------------------------

test tier_b_trigger_cto_succeeds_with_real_anchored_vote() {
  let datum = mock_datum(Active, 0)
  let cto_address = from_verification_key(#"dd")
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
    BondingCurveTierBDatum {
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

  bonding_curve_tier_b.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

// Regression (2026-07-23 audit): a UTXO planted at
// cto_governance_credential with a fully forged "Passed / Executed" datum but
// WITHOUT the genuine governance thread NFT must NOT satisfy
// cto_vote_verified. Cleanly returns False (ref input exists, lacks the NFT),
// so a plain `!spend(...)` assertion works.
test tier_b_trigger_cto_rejects_forged_governance_utxo_without_nft() {
  let datum = mock_datum(Active, 0)
  let cto_address = from_verification_key(#"dd")
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
    BondingCurveTierBDatum {
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

// Enforcement: cto_vote_verified's `expect Some(cto_ref_input) = ...`
// panics rather than returning False when no matching reference input
// exists, so this needs the `fail` test annotation — same reasoning as
// The linear curve's identically-named test.
test tier_b_trigger_cto_rejects_without_reference_input() fail {
  let datum = mock_datum(Active, 0)
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
    BondingCurveTierBDatum {
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
      extra_signatories: [#"22"],
    }

  bonding_curve_tier_b.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

test tier_b_dissolve_cto_succeeds_with_real_anchored_vote() {
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 0),
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let cto_address = from_verification_key(#"dd")
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
    BondingCurveTierBDatum {
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

  bonding_curve_tier_b.spend(Some(datum), DissolveCTO, own_ref, self)
}

/// Shared shape for the ClaimCreatorFees success-path tests
/// below — same as the linear curve's claim_creator_fees_tx. Curve holds 1,000,000
/// lovelace going in; claimer takes `amount` (200) out and pays
/// `platform_claim_fee` (exactly the floor, 200,000) in, so the curve's
/// continuing output must show 1,000,000 - 200 + 200,000 = 1,199,800.
fn tier_b_claim_creator_fees_tx(
  datum: BondingCurveTierBDatum,
  new_datum: BondingCurveTierBDatum,
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

test tier_b_claim_creator_fees_succeeds_via_creator_when_no_cto() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  let (own_ref, self) = tier_b_claim_creator_fees_tx(datum, new_datum, #"11", #"11")

  bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

/// One delta from tier_b_claim_creator_fees_succeeds_via_creator_when_no_cto
/// above: the payout no longer names the spend it settles. Everything else is
/// byte-for-byte the accepted transaction, so this can only be refused by the
/// tag.
test tier_b_claim_creator_fees_rejects_untagged_payout() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  let (own_ref, self) = tier_b_claim_creator_fees_tx(datum, new_datum, #"11", #"11")
  expect [continuing, payout] = self.outputs
  let untagged =
    Transaction {
      ..self,
      outputs: [continuing, Output { ..payout, datum: transaction.NoDatum }],
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    untagged,
  )
}

test tier_b_claim_creator_fees_rejects_creator_once_cto_triggered() {
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 0),
      creator_fees_accrued: 500,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  // Original creator (#"11") signs, not the community wallet — must now be
  // rejected.
  let (own_ref, self) = tier_b_claim_creator_fees_tx(datum, new_datum, #"11", #"11")

  !bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test tier_b_claim_creator_fees_succeeds_via_community_wallet_once_cto_triggered() {
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 0),
      creator_fees_accrued: 500,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 200_000,
    }
  let (own_ref, self) = tier_b_claim_creator_fees_tx(datum, new_datum, #"ee", #"ee")

  bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test tier_b_claim_creator_fees_rejects_platform_fee_below_floor() {
  // Fix regression: platform_claim_fee below the 200,000 floor must
  // be rejected, same as the linear curve's identical test.
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      platform_fees_accrued: 10,
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 10 },
    own_ref,
    self,
  )
}

test tier_b_claim_creator_fees_rejects_value_drain_attempt() {
  // Fix regression: the datum decrements amount correctly but the
  // curve's real lovelace balance is untouched (no real payout, no real
  // platform fee collected) — must be rejected now.
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum = BondingCurveTierBDatum { ..datum, creator_fees_accrued: 300 }
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
      value: assets.merge(mock_curve_nft(), assets.from_lovelace(1_000_000)),
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test tier_b_claim_platform_fees_rejects_without_real_payout() {
  // Fix: same gap as ClaimCreatorFees, applied to the governor's
  // treasury claim — datum shows the right decrement, but no output ever
  // pays the governor. No prior test coverage existed for this redeemer
  // at all before this fix.
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0), platform_fees_accrued: 500 }
  let new_datum = BondingCurveTierBDatum { ..datum, platform_fees_accrued: 300 }
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

  !bonding_curve_tier_b.spend(Some(datum), ClaimPlatformFees { amount: 200 }, own_ref, self)
}

test tier_b_claim_platform_fees_succeeds_with_real_payout() {
  // No prior test coverage existed for this redeemer at all before this fix.
  let datum = BondingCurveTierBDatum { ..mock_datum(Active, 0), platform_fees_accrued: 500 }
  let new_datum = BondingCurveTierBDatum { ..datum, platform_fees_accrued: 300 }
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

  bonding_curve_tier_b.spend(Some(datum), ClaimPlatformFees { amount: 200 }, own_ref, self)
}

/// Fix (2026-07-22) regression: same real-base-address proof as
/// The linear curve's identical test — see that file's own comment for why this
/// matters more than a cosmetic UX gap (the governor's real production
/// wallet is always a base address, so this redeemer's real payout was
/// silently broken before this fix, not just inconvenient).
test tier_b_claim_platform_fees_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = BondingCurveTierBDatum { ..mock_datum(Active, 0), platform_fees_accrued: 500 }
  let new_datum = BondingCurveTierBDatum { ..datum, platform_fees_accrued: 300 }
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

  bonding_curve_tier_b.spend(Some(datum), ClaimPlatformFees { amount: 200 }, own_ref, self)
}

fn buyback_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    ..mock_datum(Cancelled, 100),
    total_raised: 1000,
  }
}

test tier_b_claim_buyback_succeeds_with_correct_pro_rata_share() {
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
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test tier_b_claim_buyback_rejects_padded_continuing_output() {
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
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

/// Fix (2026-07-22) regression: same real-base-address proof as
/// The linear curve's identical test.
test tier_b_claim_buyback_succeeds_paying_a_real_base_address_not_just_enterprise() {
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
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test tier_b_claim_buyback_rejects_before_curve_cancelled() {
  let datum = BondingCurveTierBDatum { ..buyback_datum(), curve_state: Active }
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
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test tier_b_claim_buyback_rejects_unauthenticated_buyer() {
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
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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
      // deliberately no extra_signatories
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

fn graduation_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    ..mock_datum(Graduated, 1000),
    total_raised: 98_000,
  }
}

test tier_b_graduate_succeeds_with_correct_lp_seeding() {
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
    BondingCurveTierBDatum {
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

  bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

/// Identical to the passing graduation above, except the LP escrow output
/// carries a STAKING CREDENTIAL. Everything else is right — correct script,
/// correct ada, correct tokens, correct thread NFT.
///
/// `Graduate` is permissionless, so whoever submits it picks that credential.
/// It would delegate the locked LP to their own pool for the whole 365-day
/// lock, and `lp_escrow.ak` matches its continuing output by full address, so
/// every later spend would preserve it rather than notice it.
test tier_b_graduate_rejects_lp_output_carrying_a_staking_credential() {
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff") |> with_delegation_key(#"5a")
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
    BondingCurveTierBDatum {
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

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_rejects_padded_lp_output() {
  // Identical to tier_b_graduate_succeeds_with_correct_lp_seeding,
  // except the new lp_escrow genesis output carries one extra, unrelated
  // junk asset. Graduate is permissionless, so ANYONE could otherwise pad
  // the newly-seeded lp_escrow UTXO this way before the fix.
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
    BondingCurveTierBDatum {
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

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_rejects_before_graduated() {
  let datum = BondingCurveTierBDatum { ..graduation_datum(), curve_state: Active }
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
    BondingCurveTierBDatum {
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

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_rejects_if_already_seeded() {
  let datum =
    BondingCurveTierBDatum { ..graduation_datum(), lp_seeded: True }
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
    BondingCurveTierBDatum {
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

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

// Graduate + staking rewards pool seeding


/// The one datum a graduation may open this launch's pool with — derived, not
/// written, so a fixture cannot quietly disagree with what the validator
/// derives for itself.
fn staking_genesis(
  datum: BondingCurveTierBDatum,
  opened_at: Int,
) -> staking_pool_datum.StakingPoolDatum {
  staking_pool_datum.genesis(
    datum.launch_id,
    datum.creator_pub_key_hash,
    datum.token_policy_id,
    datum.token_asset_name,
    datum.thread_nft_policy,
    datum.staking_reserve_tokens,
    datum.staking_duration_days,
    opened_at,
  )
}

/// When these graduations happen. Any value works; it only has to sit inside
/// the transaction's own validity range.
const graduation_time = 1_700_000_000_000

fn staking_graduation_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    ..graduation_datum(),
    staking_enabled: True,
    staking_reserve_tokens: 250,
    // 250 over 10 days = 25 a day.
    staking_duration_days: 10,
  }
}

test tier_b_graduate_succeeds_with_lp_and_staking_seeding() {
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
        value: assets.merge(mock_curve_nft(), assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 400),
        )),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
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

  bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

// ============================================================================
// Thread-NFT forge rejection (Cardano Launch)
// ============================================================================
// Mirrors the same five tests in the linear curve's bonding_curve.ak. Kept in step
// deliberately: the strongest pattern in the 2026-08 audit was fixes landing
// on one member of a twin pair and not the other.

/// The core state-authentication property — see the linear curve's equivalent for the full reasoning.
test tier_b_spend_rejects_curve_utxo_without_thread_nft() {
  let datum = graduation_datum()
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
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

/// A the linear curve curve thread NFT must not satisfy the Cardano Launch curve's check for
/// the same launch — this is the whole reason the two curves get distinct
/// role tags rather than sharing one.
test tier_b_spend_rejects_tier_a_role_thread_nft() {
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let tier_a_nft =
    assets.from_asset(
      #"c0ffee",
      thread_nft.thread_asset_name(thread_nft.role_bonding_curve, #"01"),
      1,
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: tier_a_nft,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: tier_a_nft,
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

/// Identical to tier_b_graduate_succeeds_with_lp_and_staking_seeding except
/// the lp_escrow destination carries no thread NFT.
test tier_b_graduate_rejects_lp_output_without_thread_nft() {
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
    BondingCurveTierBDatum {
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

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

/// Same requirement for the staking destination.
test tier_b_graduate_rejects_staking_output_without_thread_nft() {
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
    BondingCurveTierBDatum {
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

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_rejects_missing_staking_output_when_enabled() {
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
    BondingCurveTierBDatum {
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

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_succeeds_without_staking_output_when_disabled() {
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
    BondingCurveTierBDatum {
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

  bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

// QueryState previously authorized ANY spend unconditionally
// (`QueryState -> True`, zero checks) — an unconditional authorization
// path. Proves the fix.
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

  !bonding_curve_tier_b.spend(Some(datum), QueryState, own_ref, self)
}

// A state-only redeemer must carry the curve's whole value into its continuing
// output. Both of these build a transaction that writes the correct new datum
// and keeps the thread NFT, while moving the raised lovelace and the unsold
// token reserve to a third party — and both must be rejected.

test tier_b_expire_curve_rejects_value_drain() {
  let datum = BondingCurveTierBDatum { ..mock_datum(Active, 100), phase_started_at: 0 }
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test tier_b_cancel_curve_rejects_value_drain() {
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
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

  !bonding_curve_tier_b.spend(Some(datum), CancelCurve, own_ref, self)
}

// Inactive is the state a Cardano Launch curve can be stranded in: both ways out of
// it (AnchorDvAllocationRoot, OpenDvClaim) are governor-signed, so a governor
// who stops answering leaves the whole supply sitting here.
test tier_b_expire_curve_succeeds_from_inactive_after_deadline() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Inactive, 0), phase_started_at: 0 }
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
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

  bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test tier_b_expire_curve_rejects_from_inactive_before_deadline() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Inactive, 0), phase_started_at: 0 }
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: before_deadline },
    own_ref,
    self,
  )
}

// The state deliberately left out. Registrants inside the claim window have
// paid bonds against allocations they can still settle, and ActivateCurve out
// of DvClaim is already permissionless once the windows pass — so there is
// nothing to rescue here and something real to destroy.
test tier_b_expire_curve_rejects_from_dv_claim_even_past_the_deadline() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(DvClaim, 0), phase_started_at: 0 }
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
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
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

  !bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

/// The passing graduation above with ONE difference: nothing was actually
/// raised. Enough SellTokens activity before the final buy can leave
/// total_raised at zero while tokens_sold still reaches curve_supply, and at
/// zero both value checks stop meaning anything — the curve need only not
/// decrease, and the LP need only receive at least nothing. What lands is a
/// launch labelled Graduated behind an LP with no ada in it, locked for a
/// year. The linear curve has refused this since the same audit; this tier reaches the
/// state by the same route and now refuses it too.
test tier_b_graduate_rejects_non_positive_total_raised() {
  let datum = BondingCurveTierBDatum { ..graduation_datum(), total_raised: 0 }
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
    BondingCurveTierBDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  // Nothing moves, because there is nothing to move — which is exactly why
  // every other check here is satisfied and only the new one is not.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_curve_nft(), assets.merge(
        assets.from_lovelace(base_lovelace),
        assets.from_asset(#"33", "tok", 0),
      )),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(mock_lp_escrow_nft(), assets.merge(
        assets.from_lovelace(0),
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

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

/// The linear curve's own claim_buyback_rejects_refunding_the_buyer_with_their_own_ada,
/// on this tier. The buyer signs this path here too, so the transaction can
/// spend their utxos and return their own ada as the "refund" while the
/// curve's ada goes elsewhere. Written out rather than assumed from the other
/// tier: the two validators have diverged before.
test tier_b_claim_buyback_rejects_refunding_the_buyer_with_their_own_ada() {
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
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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
  let buyer_change =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(1_900_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
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

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}
