// ============================================================================
// Noctis Zone — Curve order (the linear curve + Cardano Launch)
// ============================================================================
// One UTXO per order. This is what removes contention from the bonding curve:
// a launch's curve is a single UTXO, so trades against it serialise at one per
// block. An order writes only to its OWN new UTXO, so any number of users can
// place orders in the same block, and the curve is touched once afterwards by
// whoever batches them.
//
// The order holds the funds being spent — ADA for a buy, tokens for a sell —
// and this validator's whole job is to make sure they can only leave in ways
// the owner would accept:
//
//   ApplyOrder         the curve is being spent in the same transaction, and
//                      the owner receives at least min_received
//   CancelOrderByOwner the owner signs and takes their funds back, any time
//   CancelExpiredOrder anyone may return the funds TO THE OWNER once the
//                      deadline has passed
//
// **A batch is checked once, not once per order.** An order spent under
// ApplyOrder asks only that the transaction withdraws zero from this script's
// own reward address. The withdrawal runs this same script's `withdraw`
// handler, and that handler checks EVERY order the transaction spends: that
// the curve's `BatchTrades` lists it on the terms its own datum sets, and that
// its owner is paid what those terms promise. The curve's batch, with a cap
// proof per order, is decoded there once, so a batch's cost grows with the
// number of orders rather than with its square.
//
// The reward address has to be registered on each network before the first
// batch. Until it is, the ledger refuses the withdrawal, no batch can be
// built, and every order can still be cancelled.
//
// The last two are what make the arrangement non-custodial. A batcher that
// stalls, censors, or turns hostile is a LIVENESS problem — orders come back —
// rather than a fund-loss one. Nothing here lets a batcher choose where funds
// go; it can only satisfy an order on the terms the owner already set.
//
// Pricing lives in the curve validator, not here. This one never computes a
// price: it checks the outcome the owner was promised, which is the only part
// the owner needs guaranteed.
// ============================================================================

use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Interval, IntervalBoundType}
use bonding_curve_tier_b.{
  BatchOrder, BatchTrades, BondingCurveTierBDatum, BondingCurveTierBRedeemer,
}
use cardano/address.{Address, Credential, Inline, Script, from_verification_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Spend, Transaction,
}
use noctis/clock
use noctis/settlement
use noctis/thread_nft

/// Same bound, and the same reason, as the curve validators': a caller must not
/// be able to widen the validity range far enough to invent a "now".
fn validity_range_is_narrow(range: Interval, max_width: Int) -> Bool {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      hi >= lo && hi - lo <= max_width
    _ -> False
  }
}

const max_validity_range_width = 600_000

pub type OrderDatum {
  /// Who receives the proceeds, and the only party who may cancel early.
  owner: VerificationKeyHash,
  /// The owner's stake credential, when their address has one.
  ///
  /// Recorded because a payout must go to an address the owner can actually
  /// SPEND FROM. Matching on the payment credential alone accepts the bare
  /// enterprise address, and an ordinary wallet derived from a seed phrase
  /// uses its BASE address — so a fill paid that way is the owner's and
  /// unspendable by their wallet, which was the state of every batched fill
  /// before this field existed.
  ///
  /// It also closes a second thing: the payout address is now fixed exactly,
  /// so a batcher cannot attach a stake credential of its own and collect the
  /// delegation on money it is merely passing through.
  ///
  /// `None` means the owner really does want an enterprise address, and the
  /// payout must then have no stake credential — not "any credential will do".
  owner_stake: Option<Credential>,
  /// Binds the order to one launch, so an order cannot be applied against a
  /// different launch's curve even at the same script address.
  launch_id: ByteArray,
  /// The curve script this order may be applied against. Checked as a real
  /// input credential, so ApplyOrder cannot succeed without the curve
  /// validator running in the same transaction and doing its own checks.
  curve_credential: Credential,
  /// True buys tokens with the ADA held here; False sells the tokens held here.
  is_buy: Bool,
  /// Tokens to buy, or tokens to sell.
  amount: Int,
  /// The owner's slippage bound: tokens for a buy, lovelace for a sell. This is
  /// the promise the batcher has to keep.
  min_received: Int,
  /// The most of what this order HOLDS that may leave it — lovelace for a buy,
  /// tokens for a sell. Everything above it comes back to the owner.
  ///
  /// The other half of the bound, and it has to be set by the owner rather
  /// than derived. This validator never computes a price, deliberately, so it
  /// cannot know what the curve was owed and cannot tell a fair fill from one
  /// that paid the curve correctly and kept the rest. `min_received` bounds
  /// what arrives; this bounds what leaves, and together they are the whole
  /// promise: at most this much of mine is spent, at least that much comes
  /// back.
  ///
  /// It is also where the batcher is paid from, which is why the platform
  /// describes that fee as a ceiling rather than a rate: an order names the
  /// most it will tolerate, and a batcher takes its real cost or less because
  /// anything it does not take goes back to the owner.
  max_spend: Int,
  /// Posix ms. After this, anyone may return the funds to the owner.
  deadline: Int,
  /// The launch's token, needed to check a sell order's own refund.
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
}

pub type OrderRedeemer {
  /// Applied by a batcher alongside the curve. Declared first so its
  /// constructor index is stable; see the curve validators' own notes on why
  /// index order is load-bearing.
  ApplyOrder
  CancelOrderByOwner
  CancelExpiredOrder { current_timestamp: Int }
}

/// What an order's owner was handed: (the launch's tokens, lovelace).
///
/// Two independent reasons for the shape. Summed rather than "any output holds
/// at least X", because an owner may legitimately be paid across several
/// outputs. And restricted to outputs carrying THIS order's own reference,
/// because an owner with two orders in one batch is owed twice — and a check
/// that only knows about the owner reads one payment as satisfying both. An
/// OutputReference is unique across the chain, so one output cannot answer two
/// orders however similar they are.
///
/// Both assets in one pass over the outputs, since every caller wants both.
fn returned_to(
  self: Transaction,
  own_ref: OutputReference,
  owner: Address,
  datum: OrderDatum,
) -> (Int, Int) {
  list.foldl(
    self.outputs,
    (0, 0),
    fn(output: Output, acc: (Int, Int)) {
      if settlement.settles(output, own_ref) && output.address == owner {
        let (tokens, lovelace) = acc
        (
          tokens + assets.quantity_of(
            output.value,
            datum.token_policy_id,
            datum.token_asset_name,
          ),
          lovelace + assets.lovelace_of(output.value),
        )
      } else {
        acc
      }
    },
  )
}

/// The exact address the owner can spend from — payment credential AND stake
/// credential, so a payout cannot be redirected to a variant of it.
fn owner_address_of(datum: OrderDatum) -> Address {
  Address {
    payment_credential: from_verification_key(datum.owner).payment_credential,
    stake_credential: when datum.owner_stake is {
      Some(cred) -> Some(Inline(cred))
      None -> None
    },
  }
}

/// The order's own UTXO, and what it holds. A cancel has to return exactly
/// this, so it is read from the real input rather than trusted from the datum.
fn own_input(self: Transaction, own_ref: OutputReference) -> Output {
  expect Some(input) = list.find(
    self.inputs,
    fn(input: Input) { input.output_reference == own_ref },
  )
  input.output
}

validator curve_order {
  spend(
    datum_opt: Option<OrderDatum>,
    redeemer: OrderRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    let held = own_input(self, own_ref)

    when redeemer is {
      ApplyOrder ->
        // This script's own withdrawal, which runs `withdraw` below: the check
        // every order in the batch is held to, run once for all of them. The
        // withdrawal is keyed by the credential the order sits at, so no other
        // script's withdrawal can stand in for it.
        pairs.has_key(self.withdrawals, held.address.payment_credential)

      CancelOrderByOwner ->
        // No deadline, no batcher, no conditions beyond the owner's own
        // signature. An owner is never locked into a queue.
        and {
          list.has(self.extra_signatories, datum.owner),
          order_funds_returned(self, own_ref, datum, held),
        }

      CancelExpiredOrder { current_timestamp } ->
        // Permissionless, and pays the OWNER rather than the caller — so a
        // stalled batcher costs the owner time, never funds, and clearing the
        // order confers nothing on whoever does it.
        and {
          current_timestamp > datum.deadline,
          // Expired for every moment this transaction is valid in, not only
          // for the moment the canceller named inside the range.
          clock.strictly_past(self.validity_range, datum.deadline),
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(
            self.validity_range,
            max_validity_range_width,
          ),
          order_funds_returned(self, own_ref, datum, held),
        }
    }
  }

  /// The batch's check. `account` is this script's own credential, the one
  /// every order it guards sits at.
  withdraw(_redeemer: Data, account: Credential, self: Transaction) {
    batch_honours_every_order(self, account)
  }

  else(_) {
    fail
  }
}

/// A cancelled order returns what it actually held: the tokens for a sell, the
/// lovelace for a buy. Read from the real input, so a datum that lies about the
/// amount cannot shrink the refund. Tagged with this order's own reference for
/// the same reason a fill is — two of one owner's orders cancelled together are
/// two refunds, and an untagged check would let one output stand for both.
fn order_funds_returned(
  self: Transaction,
  own_ref: OutputReference,
  datum: OrderDatum,
  held: Output,
) -> Bool {
  let (tokens_returned, lovelace_returned) = returned_to(
    self,
    own_ref,
    owner_address_of(datum),
    datum,
  )
  and {
    // A sell order's UTxO also carries its min-ADA deposit, so every refund
    // returns the lovelace the order held, not only a buy's.
    lovelace_returned >= assets.lovelace_of(held.value),
    tokens_returned >= assets.quantity_of(
      held.value,
      datum.token_policy_id,
      datum.token_asset_name,
    ),
  }
}

/// Every order this transaction spends, held to its owner's terms in one pass.
///
/// The orders are the inputs at `order_credential`, which is this script's
/// own, so the set checked is exactly the set whose spends rely on this check:
/// an order cannot be spent under `ApplyOrder` and left out of it. The first
/// order names the curve; every order must name the same one.
fn batch_honours_every_order(
  self: Transaction,
  order_credential: Credential,
) -> Bool {
  let orders_spent = list.filter(
    self.inputs,
    fn(input: Input) {
      input.output.address.payment_credential == order_credential
    },
  )
  when orders_spent is {
    [] -> False
    [first, ..] -> {
      let curve_credential = order_datum(first).curve_credential
      when curve_batch(self, curve_credential) is {
        Some((curve, listing)) -> and {
            // Each order spent is found in the listing below, and no two
            // orders share a reference, so equal counts make the two sets
            // correspond exactly: nothing listed is left unspent, and the
            // curve cannot count a trade no order here paid for.
            list.length(listing) == list.length(orders_spent),
            list.all(
              orders_spent,
              fn(input) {
                order_honoured(self, input, curve, curve_credential, listing)
              },
            ),
          }
        None -> False
      }
    }
  }
}

fn order_datum(input: Input) -> OrderDatum {
  expect InlineDatum(raw) = input.output.datum
  expect datum: OrderDatum = raw
  datum
}

/// This launch's curve, spent in this transaction under `BatchTrades`, and the
/// orders that batch lists. The curve is the input at the orders' curve
/// credential whose value carries the launch's curve thread NFT under the
/// policy the curve's own datum names; its redeemer is read from the
/// transaction, so the two validators name each other — the batch lists the
/// orders, the orders require the batch.
fn curve_batch(
  self: Transaction,
  curve_credential: Credential,
) -> Option<(BondingCurveTierBDatum, List<BatchOrder>)> {
  when
    list.find(
      self.inputs,
      fn(input: Input) {
        input.output.address.payment_credential == curve_credential
      },
    )
  is {
    Some(curve_in) -> {
      expect InlineDatum(raw_curve) = curve_in.output.datum
      expect curve: BondingCurveTierBDatum = raw_curve
      let threaded = assets.quantity_of(
        curve_in.output.value,
        curve.thread_nft_policy,
        thread_nft.thread_asset_name(
          thread_nft.role_bonding_curve_tier_b,
          curve.launch_id,
        ),
      ) == 1
      when
        pairs.get_first(self.redeemers, Spend(curve_in.output_reference))
      is {
        Some(raw_redeemer) -> {
          expect curve_redeemer: BondingCurveTierBRedeemer = raw_redeemer
          when curve_redeemer is {
            BatchTrades { orders, .. } ->
              if threaded {
                Some((curve, orders))
              } else {
                None
              }
            _ -> None
          }
        }
        None -> None
      }
    }
    None -> None
  }
}

/// One order, on the terms its owner set.
///
/// The curve prices and caps what the batch LISTS, not what the order says,
/// so the listing has to carry the order's own owner, side, amount and bound.
/// A listing that differed would have the curve price one trade and charge a
/// wallet cap for it while this order paid for another.
fn order_honoured(
  self: Transaction,
  input: Input,
  curve: BondingCurveTierBDatum,
  curve_credential: Credential,
  listing: List<BatchOrder>,
) -> Bool {
  let datum = order_datum(input)
  let own_ref = input.output_reference
  let held = input.output
  // A buy is owed tokens and gets its unspent lovelace back; a sell is owed
  // lovelace and gets its unsold tokens back. Both directions are read off the
  // same tagged outputs.
  let (tokens_returned, lovelace_returned) = returned_to(
    self,
    own_ref,
    owner_address_of(datum),
    datum,
  )
  let received = if datum.is_buy {
    tokens_returned
  } else {
    // NET of the lovelace the order's own UTxO brought: its min-ADA deposit
    // comes back with the proceeds and is not proceeds.
    lovelace_returned - assets.lovelace_of(held.value)
  }
  // What the order actually holds, read from the real input — a datum that
  // lied about it could otherwise licence a larger spend than the owner
  // funded.
  let held_amount = if datum.is_buy {
    assets.lovelace_of(held.value)
  } else {
    assets.quantity_of(
      held.value,
      datum.token_policy_id,
      datum.token_asset_name,
    )
  }
  let change_returned = if datum.is_buy {
    lovelace_returned
  } else {
    tokens_returned
  }
  and {
    list.any(
      listing,
      fn(order: BatchOrder) {
        and {
          order.order_ref == own_ref,
          order.owner == datum.owner,
          order.is_buy == datum.is_buy,
          order.amount == datum.amount,
          order.min_received == datum.min_received,
        }
      },
    ),
    datum.curve_credential == curve_credential,
    datum.launch_id == curve.launch_id,
    datum.amount > 0,
    received >= datum.min_received,
    // Everything above `max_spend` comes back. Without this the order's funds
    // are bounded only by what it happened to hold, and whoever builds the
    // transaction decides where the difference goes.
    change_returned >= held_amount - datum.max_spend,
  }
}

// ============================================================================
// TESTS
// ============================================================================

const owner_key: VerificationKeyHash = #"de"

const curve_cred: Credential = from_verification_key(#"cc").payment_credential

const tok_policy: PolicyId = #"33"

/// A stake credential, for the owner whose wallet is an ordinary one.
const owner_stake_cred: Credential =
  from_verification_key(#"5a").payment_credential

/// Somebody else's stake credential — a batcher's, in the case that matters.
const other_stake_cred: Credential =
  from_verification_key(#"5b").payment_credential

/// The address a seed-phrase wallet actually derives and can spend from.
fn owner_base_address() -> Address {
  Address {
    payment_credential: from_verification_key(owner_key).payment_credential,
    stake_credential: Some(Inline(owner_stake_cred)),
  }
}

fn order_ref() -> OutputReference {
  OutputReference { transaction_id: #"01", output_index: 0 }
}

fn mock_order(is_buy: Bool, min_received: Int, deadline: Int) -> OrderDatum {
  OrderDatum {
    owner: owner_key,
    owner_stake: None,
    launch_id: #"01",
    curve_credential: curve_cred,
    is_buy,
    amount: 100,
    min_received,
    // A buy fixture holds 50 ADA and may spend 45 of it, so a correct fill
    // returns 5 ADA or more. A sell holds 100 tokens and may spend all 100.
    max_spend: if is_buy {
      45_000_000
    } else {
      100
    },
    deadline,
    token_policy_id: tok_policy,
    token_asset_name: "tok",
  }
}

/// This script's own credential in these tests: where every order sits, and
/// the reward credential a batch withdraws zero from.
const order_cred: Credential = Script(#"0c")

/// An order UTXO as it sits on chain: at this script, its datum inline. A buy
/// holds 50 ADA, a sell 100 tokens.
fn order_at(ref: OutputReference, datum: OrderDatum) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: Address {
        payment_credential: order_cred,
        stake_credential: None,
      },
      value: if datum.is_buy {
        assets.from_lovelace(50_000_000)
      } else {
        assets.from_asset(tok_policy, "tok", 100)
      },
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

/// The order UTXO itself: a buy holds ADA, a sell holds tokens.
fn order_input(is_buy: Bool) -> Input {
  order_at(order_ref(), mock_order(is_buy, 100, 9_999))
}

const thread_policy: PolicyId = #"c0ffee"

fn curve_ref() -> OutputReference {
  OutputReference { transaction_id: #"02", output_index: 0 }
}

/// This launch's curve as it stands when a batch fills orders: the same
/// launch id and token as the order, the curve's thread NFT in its value.
fn mock_curve_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    launch_id: #"01",
    creator_pub_key_hash: #"11",
    governor_pub_key_hash: #"22",
    base_price: 100,
    max_price: 1000,
    curve_supply: 1000,
    curve_state: bonding_curve_tier_b.Active,
    phase_started_at: 0,
    tokens_sold: 0,
    total_raised: 0,
    creator_fees_accrued: 0,
    platform_fees_accrued: 0,
    wallet_cap: 500,
    dv_allocation_root: #"00",
    dv_reserve_tokens: 150,
    dv_claim_opened_at: 0,
    claimed_bits: #"00",
    dv_settled: False,
    token_policy_id: tok_policy,
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
    thread_nft_policy: thread_policy,
    cap_root: #"00",
    dv_claim_window: 86_400_000,
    dv_settlement_window: 1_800_000,
    batcher_allowlist: [],
    pool_nft_policy: #"0f",
    staking_unstake_lock_ms: 604_800_000,
  }
}

fn curve_input() -> Input {
  Input {
    output_reference: curve_ref(),
    output: Output {
      address: from_verification_key(#"cc"),
      value: assets.merge(
        assets.from_lovelace(5_000_000),
        assets.from_asset(
          thread_policy,
          thread_nft.thread_asset_name(
            thread_nft.role_bonding_curve_tier_b,
            #"01",
          ),
          1,
        ),
      ),
      datum: InlineDatum(mock_curve_datum()),
      reference_script: None,
    },
  }
}

/// How the curve's batch lists an order: on the order's own terms.
fn listed(ref: OutputReference, datum: OrderDatum) -> BatchOrder {
  BatchOrder {
    owner: datum.owner,
    order_ref: ref,
    is_buy: datum.is_buy,
    amount: datum.amount,
    min_received: datum.min_received,
    cap_committed_before: 0,
    cap_proof: [],
  }
}

/// The curve spent under a `BatchTrades` listing exactly these.
fn batch_listing(
  orders: List<BatchOrder>,
) -> Pairs<transaction.ScriptPurpose, Data> {
  let batch: Data = BatchTrades { orders, batcher_key_hash: #"ba" }
  [Pair(Spend(curve_ref()), batch)]
}

/// A batch as a batcher builds it: the orders given, the curve spent under a
/// `BatchTrades` that lists them on their own terms, and this script's zero
/// withdrawal.
fn batch_tx(
  orders: List<(OutputReference, OrderDatum)>,
  outputs: List<Output>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: list.concat(
      list.map(
        orders,
        fn(order) {
          let (ref, datum) = order
          order_at(ref, datum)
        },
      ),
      [curve_input()],
    ),
    redeemers: batch_listing(
      list.map(
        orders,
        fn(order) {
          let (ref, datum) = order
          listed(ref, datum)
        },
      ),
    ),
    outputs,
    withdrawals: [Pair(order_cred, 0)],
  }
}

/// The batch's check, as the ledger runs it: once, for this script's own
/// credential.
fn batch_passes(self: Transaction) -> Bool {
  let unit: Data = Void
  curve_order.withdraw(unit, order_cred, self)
}

fn one_buy() -> List<(OutputReference, OrderDatum)> {
  [(order_ref(), mock_order(True, 100, 9_999))]
}

fn two_buys() -> List<(OutputReference, OrderDatum)> {
  [
    (order_ref(), mock_order(True, 100, 9_999)),
    (second_order_ref(), mock_order(True, 100, 9_999)),
  ]
}

/// The first order filled correctly: the tokens it asked for, and the 5 ADA
/// it was not allowed to spend.
fn first_filled() -> List<Output> {
  [to_owner_tokens(100), to_owner_ada(5_000_000)]
}

/// The second order's fill and change in one output, naming that order.
fn second_filled() -> Output {
  Output {
    address: from_verification_key(owner_key),
    value: assets.merge(
      assets.from_asset(tok_policy, "tok", 100),
      assets.from_lovelace(5_000_000),
    ),
    datum: InlineDatum(second_order_ref()),
    reference_script: None,
  }
}

/// A payment that NAMES the order it settles — what a real fill or refund
/// carries, since an owner may hold several orders and is owed for each.
/// `order_ref()` is the reference every fixture here spends.
fn to_owner_tokens(amount: Int) -> Output {
  Output {
    address: from_verification_key(owner_key),
    value: assets.from_asset(tok_policy, "tok", amount),
    datum: InlineDatum(order_ref()),
    reference_script: None,
  }
}

fn to_owner_ada(lovelace: Int) -> Output {
  Output {
    address: from_verification_key(owner_key),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(order_ref()),
    reference_script: None,
  }
}

fn to_other(is_ada: Bool, amount: Int) -> Output {
  Output {
    address: from_verification_key(#"ff"),
    value: if is_ada {
      assets.from_lovelace(amount)
    } else {
      assets.from_asset(tok_policy, "tok", amount)
    },
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

// -- ApplyOrder: the order's own spend ----------------------------------------

/// An order spent into a batch asks for one thing: this script's own
/// withdrawal, which is what runs the batch's check over every order.
test apply_order_requires_this_scripts_own_withdrawal() {
  let datum = mock_order(True, 100, 9_999)
  let self = batch_tx(one_buy(), first_filled())
  let without = Transaction { ..self, withdrawals: [] }
  // Another script's withdrawal runs that script's check, which says nothing
  // about this order.
  let another = Transaction { ..self, withdrawals: [Pair(Script(#"0d"), 0)] }
  and {
    curve_order.spend(Some(datum), ApplyOrder, order_ref(), self),
    !curve_order.spend(Some(datum), ApplyOrder, order_ref(), without),
    !curve_order.spend(Some(datum), ApplyOrder, order_ref(), another),
  }
}

// -- ApplyOrder: the batch's check --------------------------------------------

test apply_order_accepts_a_fill_at_min_received() {
  batch_passes(batch_tx(one_buy(), first_filled()))
}

/// An order placed from an ordinary wallet, which has a stake credential.
fn staked_order(is_buy: Bool, min_received: Int) -> OrderDatum {
  OrderDatum {
    ..mock_order(is_buy, min_received, 9_999),
    owner_stake: Some(owner_stake_cred),
  }
}

/// A fill paid to `addr`, tagged with the order it settles.
fn fill_to(addr: Address, amount: Int) -> Output {
  Output {
    address: addr,
    value: assets.from_asset(tok_policy, "tok", amount),
    datum: InlineDatum(order_ref()),
    reference_script: None,
  }
}

fn staked_change() -> Output {
  Output {
    address: owner_base_address(),
    value: assets.from_lovelace(5_000_000),
    datum: InlineDatum(order_ref()),
    reference_script: None,
  }
}

fn one_staked_buy() -> List<(OutputReference, OrderDatum)> {
  [(order_ref(), staked_order(True, 100))]
}

/// The control the three below vary. An owner with an ordinary wallet is paid
/// at the address that wallet actually derives, and the fill is accepted.
test apply_order_accepts_a_fill_at_the_owners_own_address() {
  batch_passes(
    batch_tx(
      one_staked_buy(),
      [fill_to(owner_base_address(), 100), staked_change()],
    ),
  )
}

/// The whole reason `owner_stake` exists. Everything about this payment is
/// right except the address it went to: same payment credential, right amount,
/// right tag — but no stake credential, so it is the bare ENTERPRISE address.
///
/// A wallet derived from a seed phrase uses its BASE address and never sees
/// that UTXO. The tokens are the owner's and no ordinary wallet can spend
/// them, which is what every batched fill did before this field existed.
test apply_order_rejects_a_fill_paid_to_the_bare_enterprise_address() {
  // to_owner_tokens/to_owner_ada pay from_verification_key(owner_key), which
  // has no stake credential at all.
  !batch_passes(batch_tx(one_staked_buy(), first_filled()))
}

/// The second thing the field closes. The owner is paid the right tokens at
/// their own payment credential, but with somebody else's stake credential
/// attached — a batcher's. The owner can still spend it; the batcher collects
/// the delegation on money it is only passing through.
test apply_order_rejects_a_fill_carrying_someone_elses_stake_credential() {
  let hijacked = Address {
    payment_credential: from_verification_key(owner_key).payment_credential,
    stake_credential: Some(Inline(other_stake_cred)),
  }
  !batch_passes(
    batch_tx(one_staked_buy(), [fill_to(hijacked, 100), staked_change()]),
  )
}

/// A second order, identical to the first in everything a payment can be
/// matched on — same owner, same amount, same bound — differing only in which
/// UTXO it is. That is the case a fill has to be able to tell apart.
fn second_order_ref() -> OutputReference {
  OutputReference { transaction_id: #"01", output_index: 1 }
}

/// One owner, two orders, one payment. Both orders are owed 100 tokens and the
/// batcher hands over 100 once: a check keyed on the owner alone reads that as
/// satisfying both, so the second order is spent for nothing.
test apply_order_rejects_a_payment_that_settles_a_different_order() {
  and {
    // The control: the order the payment names, alone, is filled.
    batch_passes(batch_tx(one_buy(), first_filled())),
    // Spend the second as well and the same payment does not cover it.
    !batch_passes(batch_tx(two_buys(), first_filled())),
  }
}

/// Two orders, two payments, each naming its own. The batcher's real job.
test apply_order_accepts_two_of_one_owners_orders_paid_separately() {
  batch_passes(
    batch_tx(two_buys(), list.concat(first_filled(), [second_filled()])),
  )
}

/// The order holds 50 ADA and may spend 45. Handing the owner their tokens
/// and letting the other 50 walk is not a fill — `min_received` says what must
/// arrive, and only `max_spend` says what may leave.
test apply_order_rejects_spending_more_of_the_order_than_allowed() {
  !batch_passes(
    batch_tx(one_buy(), [to_owner_tokens(100), to_other(True, 50_000_000)]),
  )
}

/// The same fill with the change returned: 45 ADA spent, 5 back to the owner.
/// The control for the rejection above — without it that test would pass
/// against a validator that refused every fill.
test apply_order_accepts_a_fill_that_returns_the_change() {
  batch_passes(
    batch_tx(
      one_buy(),
      [
        to_owner_tokens(100),
        to_owner_ada(5_000_000),
        to_other(True, 45_000_000),
      ],
    ),
  )
}

/// One lovelace short of the change is still short.
test apply_order_rejects_change_one_short() {
  !batch_passes(
    batch_tx(
      one_buy(),
      [
        to_owner_tokens(100),
        to_owner_ada(4_999_999),
        to_other(True, 45_000_001),
      ],
    ),
  )
}

/// The slippage bound is the whole promise to the owner. One short is a fail.
test apply_order_rejects_a_fill_below_min_received() {
  !batch_passes(
    batch_tx(one_buy(), [to_owner_tokens(99), to_owner_ada(5_000_000)]),
  )
}

/// Without the curve in the transaction nothing has priced this order, so a
/// batcher could hand over any amount it liked and keep the difference.
test apply_order_rejects_a_fill_without_the_curve_being_spent() {
  let self = batch_tx(one_buy(), first_filled())
  !batch_passes(Transaction { ..self, inputs: [order_input(True)] })
}

/// Paying somebody else does not satisfy the owner, however large the payment.
test apply_order_rejects_payment_to_anyone_but_the_owner() {
  !batch_passes(batch_tx(one_buy(), [to_other(False, 1000)]))
}

/// The failure the withdrawal pattern is known for. An order's own spend asks
/// only for the withdrawal, so the check it runs has to cover EVERY order the
/// transaction spends, not only the orders the batch chose to list. Here two
/// are spent and paid, and the batch lists one, or one plus an order that is
/// not in the transaction at all.
test apply_order_rejects_an_order_spent_but_not_listed() {
  let both_paid = batch_tx(
    two_buys(),
    list.concat(first_filled(), [second_filled()]),
  )
  let first = listed(order_ref(), mock_order(True, 100, 9_999))
  let elsewhere = listed(
    OutputReference { transaction_id: #"09", output_index: 0 },
    mock_order(True, 100, 9_999),
  )
  and {
    // The control: both listed, both honoured.
    batch_passes(both_paid),
    !batch_passes(
      Transaction { ..both_paid, redeemers: batch_listing([first]) },
    ),
    !batch_passes(
      Transaction { ..both_paid, redeemers: batch_listing([first, elsewhere]) },
    ),
  }
}

/// The other direction. Every order the batch lists is one this transaction
/// spends here, so the curve cannot count a trade no order of this script
/// paid for.
test apply_order_rejects_a_listing_of_an_order_not_spent() {
  let self = batch_tx(one_buy(), first_filled())
  let elsewhere = listed(
    OutputReference { transaction_id: #"09", output_index: 0 },
    mock_order(True, 100, 9_999),
  )
  !batch_passes(
    Transaction {
      ..self,
      redeemers: batch_listing(
        [listed(order_ref(), mock_order(True, 100, 9_999)), elsewhere],
      ),
    },
  )
}

/// The curve prices, and charges a wallet cap for, what the batch LISTS. A
/// listing that differs from the order in owner, side, amount or bound would
/// have the curve settle a different trade from the one this order pays for.
test apply_order_rejects_a_listing_on_other_terms() {
  let honest = listed(order_ref(), mock_order(True, 100, 9_999))
  let listing_it = fn(order: BatchOrder) {
    Transaction {
      ..batch_tx(one_buy(), first_filled()),
      redeemers: batch_listing([order]),
    }
  }
  and {
    batch_passes(listing_it(honest)),
    !batch_passes(listing_it(BatchOrder { ..honest, owner: #"ab" })),
    !batch_passes(listing_it(BatchOrder { ..honest, is_buy: False })),
    !batch_passes(listing_it(BatchOrder { ..honest, amount: 99 })),
    !batch_passes(listing_it(BatchOrder { ..honest, min_received: 99 })),
  }
}

/// Every order in a batch names the same curve: the one spent. An order meant
/// for another launch's curve cannot ride along in this one's batch.
test apply_order_rejects_an_order_for_another_curve_in_the_batch() {
  let foreign = OrderDatum {
    ..mock_order(True, 100, 9_999),
    curve_credential: from_verification_key(#"cd").payment_credential,
  }
  let outputs = list.concat(first_filled(), [second_filled()])
  and {
    !batch_passes(
      batch_tx(
        [
          (order_ref(), mock_order(True, 100, 9_999)),
          (second_order_ref(), foreign),
        ],
        outputs,
      ),
    ),
    // Listed first, it names a curve the transaction does not spend.
    !batch_passes(
      batch_tx(
        [
          (second_order_ref(), foreign),
          (order_ref(), mock_order(True, 100, 9_999)),
        ],
        outputs,
      ),
    ),
  }
}

/// A curve UTXO without the launch's thread NFT is not the launch's curve,
/// whatever its datum says.
test apply_order_rejects_a_curve_without_its_thread_nft() {
  let base = curve_input()
  let bare = Input {
    ..base,
    output: Output { ..base.output, value: assets.from_lovelace(5_000_000) },
  }
  let self = batch_tx(one_buy(), first_filled())
  !batch_passes(Transaction { ..self, inputs: [order_input(True), bare] })
}

/// The check approves orders; with none spent there is nothing to approve.
test the_batch_check_refuses_a_transaction_spending_no_order() {
  let self = batch_tx([], [])
  !batch_passes(self)
}

/// Six orders, one check. The budget this reports is the point: the batch's
/// check is paid once, not once per order.
test a_batch_of_six_is_checked_once() {
  let refs = list.map(
    list.range(0, 5),
    fn(i) { OutputReference { transaction_id: #"01", output_index: i } },
  )
  let datum = mock_order(True, 100, 9_999)
  batch_passes(
    batch_tx(
      list.map(refs, fn(ref) { (ref, datum) }),
      list.map(
        refs,
        fn(ref) {
          Output {
            address: from_verification_key(owner_key),
            value: assets.merge(
              assets.from_asset(tok_policy, "tok", 100),
              assets.from_lovelace(5_000_000),
            ),
            datum: InlineDatum(ref),
            reference_script: None,
          }
        },
      ),
    ),
  )
}

// -- CancelOrderByOwner ------------------------------------------------------

test cancel_by_owner_returns_funds_and_requires_the_signature() {
  let datum = mock_order(True, 100, 9_999)
  let ok = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(True)],
    outputs: [to_owner_ada(50_000_000)],
    extra_signatories: [owner_key],
  }
  let unsigned = Transaction { ..ok, extra_signatories: [] }
  and {
    curve_order.spend(Some(datum), CancelOrderByOwner, order_ref(), ok),
    // Without this gate anyone could cancel an owner out of their position.
    !curve_order.spend(Some(datum), CancelOrderByOwner, order_ref(), unsigned),
  }
}

/// Returning less than the order held is a partial confiscation.
test cancel_by_owner_rejects_a_short_refund() {
  let datum = mock_order(True, 100, 9_999)
  let self = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(True)],
    outputs: [to_owner_ada(49_999_999)],
    extra_signatories: [owner_key],
  }
  !curve_order.spend(Some(datum), CancelOrderByOwner, order_ref(), self)
}

/// A sell order holds tokens, not ADA, so its refund is in tokens.
test cancel_by_owner_returns_tokens_for_a_sell_order() {
  let datum = mock_order(False, 1_000, 9_999)
  let ok = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(False)],
    outputs: [to_owner_tokens(100)],
    extra_signatories: [owner_key],
  }
  let short = Transaction { ..ok, outputs: [to_owner_tokens(99)] }
  and {
    curve_order.spend(Some(datum), CancelOrderByOwner, order_ref(), ok),
    !curve_order.spend(Some(datum), CancelOrderByOwner, order_ref(), short),
  }
}

// -- CancelExpiredOrder ------------------------------------------------------

/// This is what makes a stalled batcher a liveness problem rather than a
/// fund-loss one: anyone may clear the order, and the funds go to the OWNER.
test cancel_expired_is_permissionless_and_pays_the_owner() {
  let datum = mock_order(True, 100, 1_000)
  let self = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(True)],
    outputs: [to_owner_ada(50_000_000)],
    validity_range: interval.between(1_900, 2_100),
  }
  // Signed by nobody, and it still succeeds.
  curve_order.spend(
    Some(datum),
    CancelExpiredOrder { current_timestamp: 2_000 },
    order_ref(),
    self,
  )
}

test cancel_expired_rejects_before_the_deadline() {
  let datum = mock_order(True, 100, 5_000)
  let self = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(True)],
    outputs: [to_owner_ada(50_000_000)],
    validity_range: interval.between(1_900, 2_100),
  }
  !curve_order.spend(
    Some(datum),
    CancelExpiredOrder { current_timestamp: 2_000 },
    order_ref(),
    self,
  )
}

/// The caller must not be able to take the funds by clearing an expired order,
/// which would make withholding a batch profitable.
test cancel_expired_rejects_paying_the_caller_instead_of_the_owner() {
  let datum = mock_order(True, 100, 1_000)
  let self = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(True)],
    outputs: [to_other(True, 50_000_000)],
    validity_range: interval.between(1_900, 2_100),
  }
  !curve_order.spend(
    Some(datum),
    CancelExpiredOrder { current_timestamp: 2_000 },
    order_ref(),
    self,
  )
}

/// A wide validity range would let a caller claim any "now" it liked and expire
/// an order early. Same bound, same reason, as the curve validators use.
test cancel_expired_rejects_a_wide_validity_range() {
  let datum = mock_order(True, 100, 1_000)
  let self = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(True)],
    outputs: [to_owner_ada(50_000_000)],
    validity_range: interval.between(0, 10_000_000),
  }
  !curve_order.spend(
    Some(datum),
    CancelExpiredOrder { current_timestamp: 2_000 },
    order_ref(),
    self,
  )
}

// ============================================================================
// The clock, the counterparty, and what a sell is owed — pinned 2026-09
// ============================================================================

/// The timestamp a canceller names must sit inside the transaction's own range.
test cancel_expired_rejects_a_timestamp_outside_the_range() {
  let datum = mock_order(True, 100, 1_000)
  let self = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(True)],
    outputs: [to_owner_ada(50_000_000)],
    validity_range: interval.between(1_900, 2_100),
  }
  !curve_order.spend(
    Some(datum),
    CancelExpiredOrder { current_timestamp: 3_000 },
    order_ref(),
    self,
  )
}

/// Expired means expired for every moment the transaction is valid in: a
/// range that begins before the deadline is refused even when the named
/// timestamp is past it.
test cancel_expired_rejects_a_range_that_starts_before_the_deadline() {
  let datum = mock_order(True, 100, 1_000)
  let self = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(True)],
    outputs: [to_owner_ada(50_000_000)],
    validity_range: interval.between(900, 1_100),
  }
  !curve_order.spend(
    Some(datum),
    CancelExpiredOrder { current_timestamp: 1_001 },
    order_ref(),
    self,
  )
}

/// A sell order as it really sits on chain: its tokens AND the min-ADA that
/// carries them.
fn with_deposit(input: Input) -> Input {
  Input {
    ..input,
    output: Output {
      ..input.output,
      value: assets.merge(input.output.value, assets.from_lovelace(2_000_000)),
    },
  }
}

fn sell_order_input_with_deposit() -> Input {
  with_deposit(order_input(False))
}

/// An expired sell is refunded whole: returning the tokens but keeping the
/// deposit is refused; returning both is accepted.
test cancel_expired_sell_must_return_the_deposit_too() {
  let datum = mock_order(False, 100, 1_000)
  let tokens_only = Transaction {
    ..transaction.placeholder,
    inputs: [sell_order_input_with_deposit()],
    outputs: [to_owner_tokens(100)],
    validity_range: interval.between(1_900, 2_100),
  }
  let whole = Transaction {
    ..tokens_only,
    outputs: [
      Output {
        address: from_verification_key(owner_key),
        value: assets.merge(
          assets.from_asset(tok_policy, "tok", 100),
          assets.from_lovelace(2_000_000),
        ),
        datum: InlineDatum(order_ref()),
        reference_script: None,
      },
    ],
  }
  and {
    !curve_order.spend(
      Some(datum),
      CancelExpiredOrder { current_timestamp: 2_000 },
      order_ref(),
      tokens_only,
    ),
    curve_order.spend(
      Some(datum),
      CancelExpiredOrder { current_timestamp: 2_000 },
      order_ref(),
      whole,
    ),
  }
}

/// A sell is owed its floor in NEW lovelace: the deposit that came back with
/// the proceeds is not proceeds. Paying exactly the floor, deposit included,
/// is refused; the floor on top of the deposit is accepted.
test sell_fill_is_measured_net_of_the_deposit() {
  let datum = mock_order(False, 10_000_000, 9_999)
  let base = batch_tx([(order_ref(), datum)], [to_owner_ada(10_000_000)])
  let short = Transaction {
    ..base,
    inputs: [with_deposit(order_at(order_ref(), datum)), curve_input()],
  }
  let full = Transaction { ..short, outputs: [to_owner_ada(12_000_000)] }
  and {
    !batch_passes(short),
    batch_passes(full),
  }
}

/// The counterparty must be the curve spent under `BatchTrades`: the same
/// curve spent under any other arm is no counterparty.
test apply_order_rejects_a_curve_spent_under_another_arm() {
  let other_arm: Data = bonding_curve_tier_b.ActivateCurve {
    current_timestamp: 0,
  }
  let self = batch_tx(one_buy(), first_filled())
  !batch_passes(
    Transaction { ..self, redeemers: [Pair(Spend(curve_ref()), other_arm)] },
  )
}

/// A batch that does not list this order does not fill it.
test apply_order_rejects_a_batch_that_omits_it() {
  let self = batch_tx(one_buy(), first_filled())
  !batch_passes(
    Transaction {
      ..self,
      redeemers: batch_listing(
        [listed(second_order_ref(), mock_order(True, 100, 9_999))],
      ),
    },
  )
}

/// Another launch's curve is no counterparty either, even carrying its own
/// launch's thread NFT.
test apply_order_rejects_another_launches_curve() {
  let base = curve_input()
  let other_launch = Input {
    ..base,
    output: Output {
      ..base.output,
      value: assets.merge(
        assets.from_lovelace(5_000_000),
        assets.from_asset(
          thread_policy,
          thread_nft.thread_asset_name(
            thread_nft.role_bonding_curve_tier_b,
            #"02",
          ),
          1,
        ),
      ),
      datum: InlineDatum(
        BondingCurveTierBDatum { ..mock_curve_datum(), launch_id: #"02" },
      ),
    },
  }
  let self = batch_tx(one_buy(), first_filled())
  !batch_passes(
    Transaction { ..self, inputs: [order_input(True), other_launch] },
  )
}
