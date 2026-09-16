//// NoctisSwap: the creator's fee-claim request.
////
//// Ported from Splash's `PRoyaltyWithdrawOrder.hs` (Plutarch, CC0-1.0) with one
//// change of design. Splash's request names a payout address in the signed
//// data. Here the payout address is derived from the pool's own
//// `royalty_pub_key`, the Ed25519 key that signs the request: the creator's
//// accrued fees can only ever reach the creator's key, and when a passed CTO
//// vote replaces that key the payout follows it with no other change.
////
//// The request is spent together with the pool under the pool's action 4. The
//// pool-side withdraw validator (vendored) checks the signature and the value
//// deltas on the pool; this validator checks the other half:
////
////   Apply — this is the request the redeemer names; exactly two inputs (pool
////     and request, so a second request cannot satisfy the same pool spend);
////     the pool input carries the NFT the request names; the reward output goes
////     to the creator's key — delegated by the creator or not at all —
////     holds at least the requested amounts, and leaves the executor exactly
////     `ex_fee` of the request's ADA. The amounts claimed are non-negative,
////     and a claim request carries ADA and nothing else.
////   Refund — signed by the key that placed the request.

use aiken/collection/list
use aiken/crypto.{blake2b_224}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use noctisswap/orders.{Apply, OrderAction, Refund, only_named_assets}
use noctisswap/pool_state.{is_ada}
use splash/orders/royalty_withdraw.{RoyaltyWithdrawConfig, WithdrawData}
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of}

validator withdraw_order {
  spend(
    datum: Option<RoyaltyWithdrawConfig>,
    redeemer: OrderAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(cfg) = datum
    when redeemer is {
      Refund -> list.has(self.extra_signatories, cfg.owner)
      Apply { pool_in_ix, order_in_ix, reward_out_ix } -> {
        let  
            WithdrawData {
              pool_nft,
              withdraw_royalty_x,
              withdraw_royalty_y,
              ex_fee,
            }
          = cfg.withdraw_data
        expect Some(order_in) = list.at(self.inputs, order_in_ix)
        expect Some(pool_in) = list.at(self.inputs, pool_in_ix)
        expect Some(reward_out) = list.at(self.outputs, reward_out_ix)
        let Input { output_reference: order_ref, output: order_out } = order_in

        expect InlineDatum(pool_datum_raw) = pool_in.output.datum
        expect pool_cfg: SingleRoyaltyPoolConfig = pool_datum_raw

        let creator = VerificationKey(blake2b_224(pool_cfg.royalty_pub_key))
        // The creator may delegate their own payout; nobody else may choose
        // where it is delegated. Nothing in the pool datum names a stake key,
        // so the only credential this can be held to is the one already
        // derived from `royalty_pub_key`: in practice the payout goes to an
        // address with no stake part at all.
        let stake_ok = when reward_out.address.stake_credential is {
          None -> True
          Some(Inline(c)) -> c == creator
          _ -> False
        }
        let x_out = asset_quantity_of(reward_out.value, pool_cfg.pool_x)
        let y_out = asset_quantity_of(reward_out.value, pool_cfg.pool_y)
        let non_withdraw_ada = if is_ada(pool_cfg.pool_x) {
          x_out - withdraw_royalty_x
        } else if is_ada(pool_cfg.pool_y) {
          y_out - withdraw_royalty_y
        } else {
          assets.lovelace_of(reward_out.value)
        }
        and {
          order_ref == own_ref,
          list.length(self.inputs) == 2,
          asset_quantity_of(pool_in.output.value, pool_nft) == 1,
          pool_cfg.pool_nft == pool_nft,
          only_named_assets(order_out.value, []),
          reward_out.address.payment_credential == creator,
          stake_ok,
          withdraw_royalty_x >= 0,
          withdraw_royalty_y >= 0,
          withdraw_royalty_x <= x_out,
          withdraw_royalty_y <= y_out,
          assets.lovelace_of(order_out.value) - non_withdraw_ada == ex_fee,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const creator_key: ByteArray = #"ff"

fn pool_cfg() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: Asset { policy: #"aa", name: #"6e6674" },
    pool_x: Asset { policy: ada_policy_id, name: ada_asset_name },
    pool_y: Asset { policy: #"bb", name: #"746f6b656e" },
    pool_lq: Asset { policy: #"cc", name: #"6c71" },
    fee_num: 99_700,
    treasury_fee: 100,
    royalty_fee: 1_000,
    treasury_x: 1_000,
    treasury_y: 0,
    royalty_x: 10_000_000,
    royalty_y: 0,
    dao_policy: [],
    treasury_address: #"ee",
    royalty_pub_key: creator_key,
    nonce: 3,
  }
}

fn request_for(ex_fee: Int, x: Int, y: Int) -> RoyaltyWithdrawConfig {
  RoyaltyWithdrawConfig {
    withdraw_data: WithdrawData {
      pool_nft: Asset { policy: #"aa", name: #"6e6674" },
      withdraw_royalty_x: x,
      withdraw_royalty_y: y,
      ex_fee,
    },
    signature: #"",
    additional_bytes: #"",
    owner: #"0d",
  }
}

fn request(ex_fee: Int) -> RoyaltyWithdrawConfig {
  request_for(ex_fee, 10_000_000, 0)
}

fn own_ref() -> OutputReference {
  OutputReference { transaction_id: #"02", output_index: 0 }
}

fn creator_address() -> Address {
  Address {
    payment_credential: VerificationKey(blake2b_224(creator_key)),
    stake_credential: None,
  }
}

/// The request carries 3 ADA; the executor keeps 1 ADA as `ex_fee`, so the
/// reward output must carry the 10 ADA withdrawn plus the other 2 ADA.
fn apply_tx(
  reward_to: Address,
  reward_lovelace: Int,
  extra_input: Bool,
) -> Transaction {
  let cfg = pool_cfg()
  let order_in = Input {
    output_reference: own_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(#"0b"),
        stake_credential: None,
      },
      value: assets.from_lovelace(3_000_000),
      datum: InlineDatum(request(1_000_000)),
      reference_script: None,
    },
  }
  let pool_in = Input {
    output_reference: OutputReference { transaction_id: #"01", output_index: 0 },
    output: Output {
      address: Address {
        payment_credential: Script(#"0a"),
        stake_credential: None,
      },
      value: assets.from_lovelace(110_001_000)
        |> assets.add(#"bb", #"746f6b656e", 100_000_000)
        |> assets.add(#"aa", #"6e6674", 1),
      datum: InlineDatum(cfg),
      reference_script: None,
    },
  }
  let reward_out = Output {
    address: reward_to,
    value: assets.from_lovelace(reward_lovelace),
    datum: transaction.NoDatum,
    reference_script: None,
  }
  let inputs = if extra_input {
    [order_in, pool_in, order_in]
  } else {
    [order_in, pool_in]
  }
  Transaction { ..transaction.placeholder, inputs, outputs: [reward_out] }
}

fn apply() -> OrderAction {
  Apply { pool_in_ix: 1, order_in_ix: 0, reward_out_ix: 0 }
}

test apply_pays_the_creator_and_leaves_the_executor_its_fee() {
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    apply_tx(creator_address(), 12_000_000, False),
  )
}

test apply_to_another_address_fails() fail {
  let elsewhere = Address {
    payment_credential: VerificationKey(#"0d"),
    stake_credential: None,
  }
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    apply_tx(elsewhere, 12_000_000, False),
  )
}

test apply_short_of_the_withdrawn_amount_fails() fail {
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    apply_tx(creator_address(), 9_999_999, False),
  )
}

test apply_executor_over_collecting_fails() fail {
  // 11 ADA out: the executor kept 2 ADA against an ex_fee of 1 ADA.
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    apply_tx(creator_address(), 11_000_000, False),
  )
}

test apply_with_a_third_input_fails() fail {
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    apply_tx(creator_address(), 12_000_000, True),
  )
}

/// Same transaction, but the spent output reference is not the one the
/// redeemer's order index points at.
test apply_naming_the_wrong_input_as_self_fails() fail {
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    OutputReference { transaction_id: #"03", output_index: 0 },
    apply_tx(creator_address(), 12_000_000, False),
  )
}

test refund_signed_by_the_owner_passes() {
  withdraw_order.spend(
    Some(request(1_000_000)),
    Refund,
    own_ref(),
    Transaction { ..transaction.placeholder, extra_signatories: [#"0d"] },
  )
}

test refund_without_the_owner_fails() fail {
  withdraw_order.spend(
    Some(request(1_000_000)),
    Refund,
    own_ref(),
    Transaction { ..transaction.placeholder, extra_signatories: [#"0e"] },
  )
}

/// The passing transaction with one token nobody named added to the request.
/// Every other figure is the passing case, so only the residual rule can
/// reject it — the point of building it this way rather than by hand.
fn with_a_stray_in_the_request(t: Transaction) -> Transaction {
  expect [order_in, ..rest] = t.inputs
  let out = order_in.output
  Transaction {
    ..t,
    inputs: [
      Input {
        ..order_in,
        output: Output {
          ..out,
          value: out.value |> assets.add(#"99", #"7374726179", 1),
        },
      },
      ..rest
    ],
  }
}

test claim_request_carrying_an_asset_it_does_not_name_fails() fail {
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    with_a_stray_in_the_request(apply_tx(creator_address(), 12_000_000, False)),
  )
}

/// The creator's payout address with a stake part put on it by whoever
/// assembled the transaction.
fn creator_address_with_stake(c: Credential) -> Address {
  Address {
    payment_credential: VerificationKey(blake2b_224(creator_key)),
    stake_credential: Some(Inline(c)),
  }
}

/// The payment key is still the creator's, so the money is theirs either way;
/// only the delegation is someone else's choice. That is the whole delta from
/// the passing case.
test claim_delegated_to_another_partys_stake_key_fails() fail {
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    apply_tx(
      creator_address_with_stake(VerificationKey(#"e0")),
      12_000_000,
      False,
    ),
  )
}

/// A script stake part is refused by the same rule.
test claim_delegated_to_a_script_fails() fail {
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    apply_tx(creator_address_with_stake(Script(#"e1")), 12_000_000, False),
  )
}

/// The one stake credential the pool datum can hold a payout to: the creator's
/// own, derived from the same key the payment side is.
test claim_delegated_by_the_creator_passes() {
  withdraw_order.spend(
    Some(request(1_000_000)),
    apply(),
    own_ref(),
    apply_tx(
      creator_address_with_stake(VerificationKey(blake2b_224(creator_key))),
      12_000_000,
      False,
    ),
  )
}

/// A claim for a negative amount on the ADA side. The reward is sized so the
/// executor's fee still comes out exactly right — 1,999,999 − (−1) is the
/// 2,000,000 of non-withdrawn ADA a 3 ADA request with a 1 ADA fee needs — so
/// every other rule is satisfied and only the lower bound is left to reject
/// it.
test claim_for_a_negative_ada_amount_fails() fail {
  withdraw_order.spend(
    Some(request_for(1_000_000, -1, 0)),
    apply(),
    own_ref(),
    apply_tx(creator_address(), 1_999_999, False),
  )
}

/// The same on the token side, where the fee arithmetic is untouched.
test claim_for_a_negative_token_amount_fails() fail {
  withdraw_order.spend(
    Some(request_for(1_000_000, 10_000_000, -1)),
    apply(),
    own_ref(),
    apply_tx(creator_address(), 12_000_000, False),
  )
}
