//// NoctisSwap: a request to remove liquidity from a pool.
////
//// Ported from Splash's `PRoyaltyRedeem.hs` (Plutarch, splash-core, CC0-1.0).
//// The order holds LQ; an executor spends it together with the pool under the
//// pool's action 1 and pays the placer both assets. The pool validator holds
//// the proportionality of the withdrawal; this validator holds the placer's
//// side:
////
////   Apply — this is the request the redeemer names; exactly two inputs (pool
////     and request); the pool input carries the NFT the request names and its
////     assets are the request's; the reward goes to exactly the placer's
////     address; each asset in the reward is at least the LQ's share of the
////     pool's net reserves; and the ADA the request held beyond the executor's
////     fee comes back on top of any ADA the pool pays out; and the request
////     holds nothing but its LQ and ADA.
////   Refund — signed by the placer.
////
//// The assets-are-the-pool's rule and the holds-nothing-else rule are Noctis
//// additions to the Plutarch source.

use aiken/collection/list
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use noctisswap/orders.{
  Apply, OrderAction, RedeemConfig, Refund, only_named_assets, reward_address_ok,
}
use noctisswap/pool_state.{is_ada, max_lq_cap, read_pool_state}
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of}

/// The share of one net reserve that `in_lq` of `liquidity` is worth.
pub fn min_return(in_lq: Int, reserves: Int, liquidity: Int) -> Int {
  in_lq * reserves / liquidity
}

/// What the reward pays out of the pool per side, and how much of its ADA is
/// pool payout rather than returned collateral: on an ADA pair the collateral
/// sits inside the ADA side, so it is taken off that side's figure.
pub fn payout(
  reward: Value,
  x: Asset,
  y: Asset,
  collateral_ada: Int,
) -> (Int, Int, Int) {
  let rx = asset_quantity_of(reward, x)
  let ry = asset_quantity_of(reward, y)
  if is_ada(x) {
    (rx - collateral_ada, ry, rx - collateral_ada)
  } else if is_ada(y) {
    (rx, ry - collateral_ada, ry - collateral_ada)
  } else {
    (rx, ry, 0)
  }
}

validator redeem_order {
  spend(
    datum: Option<RedeemConfig>,
    redeemer: OrderAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(cfg) = datum
    when redeemer is {
      Refund -> list.has(self.extra_signatories, cfg.reward_pkh)
      Apply { pool_in_ix, order_in_ix, reward_out_ix } -> {
        expect Some(order_in) = list.at(self.inputs, order_in_ix)
        expect Some(pool_in) = list.at(self.inputs, pool_in_ix)
        expect Some(reward_out) = list.at(self.outputs, reward_out_ix)
        expect InlineDatum(pool_raw) = pool_in.output.datum
        expect pool_cfg: SingleRoyaltyPoolConfig = pool_raw
        let pool = read_pool_state(pool_cfg, pool_in.output.value)
        let order_value = order_in.output.value
        let reward = reward_out.value

        let collateral_ada = assets.lovelace_of(order_value) - cfg.ex_fee
        let in_lq = asset_quantity_of(order_value, cfg.lq)
        let (out_x, out_y, pool_ada) = payout(
          reward,
          cfg.x,
          cfg.y,
          collateral_ada,
        )

        and {
          order_in.output_reference == own_ref,
          list.length(self.inputs) == 2,
          asset_quantity_of(pool_in.output.value, cfg.pool_nft) == 1,
          cfg.x == pool_cfg.pool_x,
          cfg.y == pool_cfg.pool_y,
          cfg.lq == pool_cfg.pool_lq,
          only_named_assets(order_value, [cfg.lq]),
          reward_address_ok(reward_out.address, cfg.reward_pkh, cfg.stake_pkh),
          min_return(in_lq, pool.reserves_x, pool.liquidity) <= out_x,
          min_return(in_lq, pool.reserves_y, pool.liquidity) <= out_y,
          pool_ada + collateral_ada <= assets.lovelace_of(reward),
        }
      }
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests. Pool: 100M ADA / 100M Y net reserves, 1,000,000 LQ in circulation.
// Order: 100,000 LQ + 3 ADA (1 ADA executor fee, so 2 ADA collateral).
// 100,000 LQ is worth 10M of each side.
// ---------------------------------------------------------------------------

const ada: Asset = Asset { policy: ada_policy_id, name: ada_asset_name }

const tok: Asset = Asset { policy: #"bb", name: #"746f6b656e" }

const lq: Asset = Asset { policy: #"cc", name: #"6c71" }

const nft: Asset = Asset { policy: #"aa", name: #"6e6674" }

const placer: ByteArray = #"0d"

const liquidity: Int = 1_000_000

fn pool_cfg() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: nft,
    pool_x: ada,
    pool_y: tok,
    pool_lq: lq,
    fee_num: 99_700,
    treasury_fee: 100,
    royalty_fee: 1_000,
    treasury_x: 500_000,
    treasury_y: 0,
    royalty_x: 500_000,
    royalty_y: 250_000,
    dao_policy: [],
    treasury_address: #"ee",
    royalty_pub_key: #"ff",
    nonce: 3,
  }
}

fn pool_value() -> Value {
  assets.from_lovelace(101_000_000)
    |> assets.add(tok.policy, tok.name, 100_250_000)
    |> assets.add(lq.policy, lq.name, max_lq_cap - liquidity)
    |> assets.add(nft.policy, nft.name, 1)
}

fn cfg() -> RedeemConfig {
  RedeemConfig {
    pool_nft: nft,
    x: ada,
    y: tok,
    lq,
    ex_fee: 1_000_000,
    reward_pkh: placer,
    stake_pkh: None,
  }
}

fn placer_address() -> Address {
  Address {
    payment_credential: VerificationKey(placer),
    stake_credential: None,
  }
}

fn own_ref() -> OutputReference {
  OutputReference { transaction_id: #"02", output_index: 0 }
}

fn order_input() -> Input {
  Input {
    output_reference: own_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(#"0b"),
        stake_credential: None,
      },
      value: assets.from_lovelace(3_000_000)
        |> assets.add(lq.policy, lq.name, 100_000),
      datum: InlineDatum(cfg()),
      reference_script: None,
    },
  }
}

fn pool_input(value: Value) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"01", output_index: 0 },
    output: Output {
      address: Address {
        payment_credential: Script(#"0a"),
        stake_credential: None,
      },
      value,
      datum: InlineDatum(pool_cfg()),
      reference_script: None,
    },
  }
}

fn reward(to: Address, value: Value) -> Output {
  Output {
    address: to,
    value,
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

fn tx(pool: Input, reward_out: Output, extra: Bool) -> Transaction {
  let inputs = if extra {
    [order_input(), pool, order_input()]
  } else {
    [order_input(), pool]
  }
  Transaction { ..transaction.placeholder, inputs, outputs: [reward_out] }
}

fn apply() -> OrderAction {
  Apply { pool_in_ix: 1, order_in_ix: 0, reward_out_ix: 0 }
}

fn run(redeemer: OrderAction, t: Transaction) -> Bool {
  redeem_order.spend(Some(cfg()), redeemer, own_ref(), t)
}

/// 10M ADA from the pool plus the 2 ADA collateral, and 10M Y.
fn fair_reward() -> Value {
  assets.from_lovelace(12_000_000)
    |> assets.add(tok.policy, tok.name, 10_000_000)
}

test fair_redeem_passes() {
  run(
    apply(),
    tx(pool_input(pool_value()), reward(placer_address(), fair_reward()), False),
  )
}

test short_on_the_ada_side_fails() fail {
  let value = assets.from_lovelace(11_999_999)
    |> assets.add(tok.policy, tok.name, 10_000_000)
  run(
    apply(),
    tx(pool_input(pool_value()), reward(placer_address(), value), False),
  )
}

test short_on_the_token_side_fails() fail {
  let value = assets.from_lovelace(12_000_000)
    |> assets.add(tok.policy, tok.name, 9_999_999)
  run(
    apply(),
    tx(pool_input(pool_value()), reward(placer_address(), value), False),
  )
}

test reward_to_another_key_fails() fail {
  let elsewhere = Address {
    ..placer_address(),
    payment_credential: VerificationKey(#"0c"),
  }
  run(
    apply(),
    tx(pool_input(pool_value()), reward(elsewhere, fair_reward()), False),
  )
}

test reward_with_an_unexpected_stake_key_fails() fail {
  let staked = Address {
    ..placer_address(),
    stake_credential: Some(Inline(VerificationKey(#"0e"))),
  }
  run(
    apply(),
    tx(pool_input(pool_value()), reward(staked, fair_reward()), False),
  )
}

test third_input_fails() fail {
  run(
    apply(),
    tx(pool_input(pool_value()), reward(placer_address(), fair_reward()), True),
  )
}

test pool_without_the_nft_fails() fail {
  let bare = pool_value() |> assets.add(nft.policy, nft.name, -1)
  run(
    apply(),
    tx(pool_input(bare), reward(placer_address(), fair_reward()), False),
  )
}

test naming_the_wrong_input_as_self_fails() fail {
  let renamed = Input {
    ..order_input(),
    output_reference: OutputReference { transaction_id: #"03", output_index: 0 },
  }
  run(
    apply(),
    Transaction {
      ..tx(
        pool_input(pool_value()),
        reward(placer_address(), fair_reward()),
        False,
      ),
      inputs: [renamed, pool_input(pool_value())],
    },
  )
}

/// The reward carries the second asset in a matching amount, so the share
/// checks still pass and only the assets check rejects.
test request_for_another_pair_fails() fail {
  let other_asset = Asset { policy: #"bd", name: #"6f74686572" }
  let other = RedeemConfig { ..cfg(), y: other_asset }
  let value = fair_reward()
    |> assets.add(other_asset.policy, other_asset.name, 10_000_000)
  redeem_order.spend(
    Some(other),
    apply(),
    own_ref(),
    tx(pool_input(pool_value()), reward(placer_address(), value), False),
  )
}

/// Token-to-token pair: no ADA leaves the pool, so the reward's ADA is the
/// collateral alone and the two shares are checked on the tokens.
test token_pair_redeem_returns_the_collateral() {
  let x = Asset { policy: #"b1", name: #"78" }
  let t2t_cfg = RedeemConfig { ..cfg(), x }
  let t2t_pool_cfg = SingleRoyaltyPoolConfig {
    ..pool_cfg(),
    pool_x: x,
    treasury_x: 0,
    royalty_x: 0,
  }
  let t2t_pool_value = assets.from_lovelace(2_000_000)
    |> assets.add(x.policy, x.name, 100_000_000)
    |> assets.add(tok.policy, tok.name, 100_250_000)
    |> assets.add(lq.policy, lq.name, max_lq_cap - liquidity)
    |> assets.add(nft.policy, nft.name, 1)
  let pool = Input {
    ..pool_input(t2t_pool_value),
    output: Output {
      ..pool_input(t2t_pool_value).output,
      datum: InlineDatum(t2t_pool_cfg),
    },
  }
  let value = assets.from_lovelace(2_000_000)
    |> assets.add(x.policy, x.name, 10_000_000)
    |> assets.add(tok.policy, tok.name, 10_000_000)
  redeem_order.spend(
    Some(t2t_cfg),
    apply(),
    own_ref(),
    tx(pool, reward(placer_address(), value), False),
  )
}

/// On an ADA pair the collateral is part of the ADA share, so this rule only
/// bites on a token pair: the collateral must still come back on its own.
test token_pair_redeem_keeping_the_collateral_fails() fail {
  let x = Asset { policy: #"b1", name: #"78" }
  let t2t_cfg = RedeemConfig { ..cfg(), x }
  let t2t_pool_cfg = SingleRoyaltyPoolConfig {
    ..pool_cfg(),
    pool_x: x,
    treasury_x: 0,
    royalty_x: 0,
  }
  let t2t_pool_value = assets.from_lovelace(2_000_000)
    |> assets.add(x.policy, x.name, 100_000_000)
    |> assets.add(tok.policy, tok.name, 100_250_000)
    |> assets.add(lq.policy, lq.name, max_lq_cap - liquidity)
    |> assets.add(nft.policy, nft.name, 1)
  let pool = Input {
    ..pool_input(t2t_pool_value),
    output: Output {
      ..pool_input(t2t_pool_value).output,
      datum: InlineDatum(t2t_pool_cfg),
    },
  }
  let value = assets.from_lovelace(1_999_999)
    |> assets.add(x.policy, x.name, 10_000_000)
    |> assets.add(tok.policy, tok.name, 10_000_000)
  redeem_order.spend(
    Some(t2t_cfg),
    apply(),
    own_ref(),
    tx(pool, reward(placer_address(), value), False),
  )
}

test refund_signed_by_the_placer_passes() {
  run(
    Refund,
    Transaction { ..transaction.placeholder, extra_signatories: [placer] },
  )
}

test refund_without_the_placer_fails() fail {
  run(
    Refund,
    Transaction { ..transaction.placeholder, extra_signatories: [#"0c"] },
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

test redeem_carrying_an_asset_it_does_not_name_fails() fail {
  run(
    apply(),
    with_a_stray_in_the_request(
      tx(
        pool_input(pool_value()),
        reward(placer_address(), fair_reward()),
        False,
      ),
    ),
  )
}
