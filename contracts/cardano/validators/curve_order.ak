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
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Credential, Inline, from_verification_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use noctis/settlement

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

/// What this ORDER was filled with, for one asset.
///
/// Two independent reasons for the shape. Summed rather than "any output holds
/// at least X", because an owner may legitimately be paid across several
/// outputs. And restricted to outputs carrying THIS order's own reference,
/// because an owner with two orders in one batch is owed twice — and a check
/// that only knows about the owner reads one payment as satisfying both. An
/// OutputReference is unique across the chain, so one output cannot answer two
/// orders however similar they are.
fn paid_to(
  self: Transaction,
  own_ref: OutputReference,
  owner: Address,
  policy: PolicyId,
  name: AssetName,
) -> Int {
  list.foldl(
    self.outputs,
    0,
    fn(output: Output, acc: Int) {
      if output.address == owner && settlement.settles(
        output,
        own_ref,
      ) {
        acc + assets.quantity_of(output.value, policy, name)
      } else {
        acc
      }
    },
  )
}

fn lovelace_to(self: Transaction, own_ref: OutputReference, owner: Address) -> Int {
  list.foldl(
    self.outputs,
    0,
    fn(output: Output, acc: Int) {
      if output.address == owner && settlement.settles(
        output,
        own_ref,
      ) {
        acc + assets.lovelace_of(output.value)
      } else {
        acc
      }
    },
  )
}

/// The order's own UTXO, and what it holds. A cancel has to return exactly
/// this, so it is read from the real input rather than trusted from the datum.
fn own_input(self: Transaction, own_ref: OutputReference) -> Output {
  expect Some(input) =
    list.find(self.inputs, fn(input: Input) { input.output_reference == own_ref })
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
    // The exact address the owner can spend from — payment credential AND
    // stake credential, so a payout cannot be redirected to a variant of it.
    let owner_address =
      Address {
        payment_credential: from_verification_key(datum.owner).payment_credential,
        stake_credential: when datum.owner_stake is {
          Some(cred) -> Some(Inline(cred))
          None -> None
        },
      }

    when redeemer is {
      ApplyOrder -> {
        // The curve validator must be running in this transaction. That is what
        // makes the pricing trustworthy: this validator deliberately does not
        // recompute a price, it only holds the batcher to the owner's terms,
        // and the curve enforces the arithmetic.
        let curve_spent =
          list.any(
            self.inputs,
            fn(input: Input) {
              input.output.address.payment_credential == datum.curve_credential
            },
          )
        // A buy is owed tokens and gets its unspent lovelace back; a sell is
        // owed lovelace and gets its unsold tokens back. Both directions are
        // read off the same tagged outputs.
        let tokens_returned =
          paid_to(
            self,
            own_ref,
            owner_address,
            datum.token_policy_id,
            datum.token_asset_name,
          )
        let lovelace_returned = lovelace_to(self, own_ref, owner_address)
        let received =
          if datum.is_buy {
            tokens_returned
          } else {
            lovelace_returned
          }
        // What the order actually holds, read from the real input — a datum
        // that lied about it could otherwise licence a larger spend than the
        // owner funded.
        let held_amount =
          if datum.is_buy {
            assets.lovelace_of(held.value)
          } else {
            assets.quantity_of(
              held.value,
              datum.token_policy_id,
              datum.token_asset_name,
            )
          }
        let change_returned =
          if datum.is_buy {
            lovelace_returned
          } else {
            tokens_returned
          }
        and {
          curve_spent,
          datum.amount > 0,
          received >= datum.min_received,
          // Everything above `max_spend` comes back. Without this the order's
          // funds are bounded only by what it happened to hold, and whoever
          // builds the transaction decides where the difference goes.
          change_returned >= held_amount - datum.max_spend,
        }
      }

      CancelOrderByOwner -> {
        // No deadline, no batcher, no conditions beyond the owner's own
        // signature. An owner is never locked into a queue.
        and {
          list.has(self.extra_signatories, datum.owner),
          order_funds_returned(self, own_ref, datum, held, owner_address),
        }
      }

      CancelExpiredOrder { current_timestamp } ->
        // Permissionless, and pays the OWNER rather than the caller — so a
        // stalled batcher costs the owner time, never funds, and clearing the
        // order confers nothing on whoever does it.
        and {
          current_timestamp > datum.deadline,
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          order_funds_returned(self, own_ref, datum, held, owner_address),
        }
    }
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
  owner_address: Address,
) -> Bool {
  if datum.is_buy {
    lovelace_to(self, own_ref, owner_address) >= assets.lovelace_of(held.value)
  } else {
    paid_to(self, own_ref, owner_address, datum.token_policy_id, datum.token_asset_name) >= assets.quantity_of(
      held.value,
      datum.token_policy_id,
      datum.token_asset_name,
    )
  }
}

// ============================================================================
// TESTS
// ============================================================================

const owner_key: VerificationKeyHash = #"de"

const curve_cred: Credential = from_verification_key(#"cc").payment_credential

const tok_policy: PolicyId = #"33"

/// A stake credential, for the owner whose wallet is an ordinary one.
const owner_stake_cred: Credential = from_verification_key(#"5a").payment_credential

/// Somebody else's stake credential — a batcher's, in the case that matters.
const other_stake_cred: Credential = from_verification_key(#"5b").payment_credential

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
    is_buy: is_buy,
    amount: 100,
    min_received: min_received,
    // A buy fixture holds 50 ADA and may spend 45 of it, so a correct fill
    // returns 5 ADA or more. A sell holds 100 tokens and may spend all 100.
    max_spend: if is_buy {
      45_000_000
    } else {
      100
    },
    deadline: deadline,
    token_policy_id: tok_policy,
    token_asset_name: "tok",
  }
}

/// The order UTXO itself: a buy holds ADA, a sell holds tokens.
fn order_input(is_buy: Bool) -> Input {
  Input {
    output_reference: order_ref(),
    output: Output {
      address: from_verification_key(#"07"),
      value: if is_buy {
        assets.from_lovelace(50_000_000)
      } else {
        assets.from_asset(tok_policy, "tok", 100)
      },
      datum: transaction.NoDatum,
      reference_script: None,
    },
  }
}

fn curve_input() -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"02", output_index: 0 },
    output: Output {
      address: from_verification_key(#"cc"),
      value: assets.from_lovelace(5_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    },
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

// -- ApplyOrder --------------------------------------------------------------

test apply_order_accepts_a_fill_at_min_received() {
  let datum = mock_order(True, 100, 9_999)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      // The tokens asked for, and the 5 ADA the order was not allowed to spend.
      outputs: [to_owner_tokens(100), to_owner_ada(5_000_000)],
    }
  curve_order.spend(Some(datum), ApplyOrder, order_ref(), self)
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

/// The control the three below vary. An owner with an ordinary wallet is paid
/// at the address that wallet actually derives, and the fill is accepted.
test apply_order_accepts_a_fill_at_the_owners_own_address() {
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      outputs: [fill_to(owner_base_address(), 100), staked_change()],
    }
  curve_order.spend(Some(staked_order(True, 100)), ApplyOrder, order_ref(), self)
}

/// The whole reason `owner_stake` exists. Everything about this payment is
/// right except the address it went to: same payment credential, right amount,
/// right tag — but no stake credential, so it is the bare ENTERPRISE address.
///
/// A wallet derived from a seed phrase uses its BASE address and never sees
/// that UTXO. The tokens are the owner's and no ordinary wallet can spend
/// them, which is what every batched fill did before this field existed.
test apply_order_rejects_a_fill_paid_to_the_bare_enterprise_address() {
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      // to_owner_tokens/to_owner_ada pay from_verification_key(owner_key),
      // which has no stake credential at all.
      outputs: [to_owner_tokens(100), to_owner_ada(5_000_000)],
    }
  !curve_order.spend(Some(staked_order(True, 100)), ApplyOrder, order_ref(), self)
}

/// The second thing the field closes. The owner is paid the right tokens at
/// their own payment credential, but with somebody else's stake credential
/// attached — a batcher's. The owner can still spend it; the batcher collects
/// the delegation on money it is only passing through.
test apply_order_rejects_a_fill_carrying_someone_elses_stake_credential() {
  let hijacked =
    Address {
      payment_credential: from_verification_key(owner_key).payment_credential,
      stake_credential: Some(Inline(other_stake_cred)),
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      outputs: [fill_to(hijacked, 100), staked_change()],
    }
  !curve_order.spend(Some(staked_order(True, 100)), ApplyOrder, order_ref(), self)
}

/// A second order, identical to the first in everything a payment can be
/// matched on — same owner, same amount, same bound — differing only in which
/// UTXO it is. That is the case a fill has to be able to tell apart.
fn second_order_ref() -> OutputReference {
  OutputReference { transaction_id: #"01", output_index: 1 }
}

fn second_order_input(is_buy: Bool) -> Input {
  Input { ..order_input(is_buy), output_reference: second_order_ref() }
}

/// One owner, two orders, one payment. Both orders are owed 100 tokens and the
/// batcher hands over 100 once: a check keyed on the owner alone reads that as
/// satisfying both, so the second order is spent for nothing.
///
/// Asked from the SECOND order's point of view, since the payment carries the
/// first one's reference — the first order really was filled.
test apply_order_rejects_a_payment_that_settles_a_different_order() {
  let datum = mock_order(True, 100, 9_999)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), second_order_input(True), curve_input()],
      outputs: [to_owner_tokens(100), to_owner_ada(5_000_000)],
    }
  and {
    // The control: the order the payment names IS filled.
    curve_order.spend(Some(datum), ApplyOrder, order_ref(), self),
    // The one it does not name is not.
    !curve_order.spend(Some(datum), ApplyOrder, second_order_ref(), self),
  }
}

/// Two orders, two payments, each naming its own. The batcher's real job.
test apply_order_accepts_two_of_one_owners_orders_paid_separately() {
  let datum = mock_order(True, 100, 9_999)
  // Two fills and two lots of change, each naming its own order.
  let second_fill =
    Output {
      address: from_verification_key(owner_key),
      value: assets.merge(
        assets.from_asset(tok_policy, "tok", 100),
        assets.from_lovelace(5_000_000),
      ),
      datum: InlineDatum(second_order_ref()),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), second_order_input(True), curve_input()],
      outputs: [to_owner_tokens(100), to_owner_ada(5_000_000), second_fill],
    }
  and {
    curve_order.spend(Some(datum), ApplyOrder, order_ref(), self),
    curve_order.spend(Some(datum), ApplyOrder, second_order_ref(), self),
  }
}

/// The order holds 50 ADA and may spend 45. Handing the owner their tokens
/// and letting the other 50 walk is not a fill — `min_received` says what must
/// arrive, and only `max_spend` says what may leave.
test apply_order_rejects_spending_more_of_the_order_than_allowed() {
  let datum = mock_order(True, 100, 9_999)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      outputs: [to_owner_tokens(100), to_other(True, 50_000_000)],
    }
  !curve_order.spend(Some(datum), ApplyOrder, order_ref(), self)
}

/// The same fill with the change returned: 45 ADA spent, 5 back to the owner.
/// The control for the rejection above — without it that test would pass
/// against a validator that refused every fill.
test apply_order_accepts_a_fill_that_returns_the_change() {
  let datum = mock_order(True, 100, 9_999)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      outputs: [to_owner_tokens(100), to_owner_ada(5_000_000), to_other(True, 45_000_000)],
    }
  curve_order.spend(Some(datum), ApplyOrder, order_ref(), self)
}

/// One lovelace short of the change is still short.
test apply_order_rejects_change_one_short() {
  let datum = mock_order(True, 100, 9_999)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      outputs: [to_owner_tokens(100), to_owner_ada(4_999_999), to_other(True, 45_000_001)],
    }
  !curve_order.spend(Some(datum), ApplyOrder, order_ref(), self)
}

/// The slippage bound is the whole promise to the owner. One short is a fail.
test apply_order_rejects_a_fill_below_min_received() {
  let datum = mock_order(True, 100, 9_999)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      outputs: [to_owner_tokens(99)],
    }
  !curve_order.spend(Some(datum), ApplyOrder, order_ref(), self)
}

/// Without the curve in the transaction nothing has priced this order, so a
/// batcher could hand over any amount it liked and keep the difference.
test apply_order_rejects_a_fill_without_the_curve_being_spent() {
  let datum = mock_order(True, 100, 9_999)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True)],
      outputs: [to_owner_tokens(100)],
    }
  !curve_order.spend(Some(datum), ApplyOrder, order_ref(), self)
}

/// Paying somebody else does not satisfy the owner, however large the payment.
test apply_order_rejects_payment_to_anyone_but_the_owner() {
  let datum = mock_order(True, 100, 9_999)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [order_input(True), curve_input()],
      outputs: [to_other(False, 1000)],
    }
  !curve_order.spend(Some(datum), ApplyOrder, order_ref(), self)
}

// -- CancelOrderByOwner ------------------------------------------------------

test cancel_by_owner_returns_funds_and_requires_the_signature() {
  let datum = mock_order(True, 100, 9_999)
  let ok =
    Transaction {
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
  let self =
    Transaction {
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
  let ok =
    Transaction {
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
  let self =
    Transaction {
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
  let self =
    Transaction {
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
  let self =
    Transaction {
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
  let self =
    Transaction {
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
