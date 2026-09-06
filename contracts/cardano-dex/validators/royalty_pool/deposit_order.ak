//// NoctisSwap: a request to add liquidity to a pool.
////
//// Ported from Splash's `PRoyaltyDeposit.hs` (Plutarch, splash-core, CC0-1.0).
//// The order holds both assets; an executor spends it together with the pool
//// under the pool's action 0 and pays the placer LQ. The pool validator holds
//// the proportionality of the deposit; this validator holds the placer's side:
////
////   Apply — this is the request the redeemer names; exactly two inputs (pool
////     and request); the pool input carries the NFT the request names and its
////     assets are the request's; the reward goes to exactly the placer's
////     address; it carries at least the LQ the smaller side of the deposit
////     buys at the pool's current ratio; when the two sides are unequal, the
////     surplus of the larger side comes back in the reward; and the ADA the
////     placer set aside for the reward output comes back with it.
////   Refund — signed by the placer.
////
//// The last two of Apply's rules are Noctis additions to the Plutarch source:
//// the request's assets must be the pool's own, and the collateral is checked
//// on every deposit rather than only when ADA is the surplus side.

use aiken/collection/list
use aiken/math
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use noctisswap/orders.{
  Apply, DepositConfig, OrderAction, Refund, reward_address_ok,
}
use noctisswap/pool_state.{is_ada, max_lq_cap, read_pool_state}
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of}

/// The LQ one side of the deposit buys at the pool's ratio. On the ADA side the
/// executor's fee and the placer's collateral are not part of the deposit.
pub fn min_asset_reward(
  order_value: Value,
  asset: Asset,
  reserves: Int,
  liquidity: Int,
  ex_fee: Int,
  collateral_ada: Int,
) -> Int {
  let held = asset_quantity_of(order_value, asset)
  let deposited = if is_ada(asset) {
    held - ex_fee - collateral_ada
  } else {
    held
  }
  deposited * liquidity / reserves
}

/// The larger side's surplus, priced back into that asset, must be in the
/// reward.
pub fn change_ok(
  reward: Value,
  surplus_asset: Asset,
  surplus_side_lq: Int,
  other_side_lq: Int,
  surplus_reserves: Int,
  liquidity: Int,
) -> Bool {
  let excess = ( surplus_side_lq - other_side_lq ) * surplus_reserves / liquidity
  excess <= asset_quantity_of(reward, surplus_asset)
}

validator deposit_order {
  spend(
    datum: Option<DepositConfig>,
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

        let min_x = min_asset_reward(
          order_value,
          cfg.x,
          pool.reserves_x,
          pool.liquidity,
          cfg.ex_fee,
          cfg.collateral_ada,
        )
        let min_y = min_asset_reward(
          order_value,
          cfg.y,
          pool.reserves_y,
          pool.liquidity,
          cfg.ex_fee,
          cfg.collateral_ada,
        )
        let surplus_returned = if min_x == min_y {
          True
        } else if min_x < min_y {
          change_ok(
            reward,
            cfg.y,
            min_y,
            min_x,
            pool.reserves_y,
            pool.liquidity,
          )
        } else {
          change_ok(
            reward,
            cfg.x,
            min_x,
            min_y,
            pool.reserves_x,
            pool.liquidity,
          )
        }

        and {
          order_in.output_reference == own_ref,
          list.length(self.inputs) == 2,
          asset_quantity_of(pool_in.output.value, cfg.pool_nft) == 1,
          cfg.x == pool_cfg.pool_x,
          cfg.y == pool_cfg.pool_y,
          cfg.lq == pool_cfg.pool_lq,
          reward_address_ok(reward_out.address, cfg.reward_pkh, cfg.stake_pkh),
          math.min(min_x, min_y) <= asset_quantity_of(reward, cfg.lq),
          surplus_returned,
          assets.lovelace_of(reward) >= cfg.collateral_ada,
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
// Order: 10 ADA deposit + 1 ADA executor fee + 2 ADA collateral, 10M Y.
// Each side buys 10M × 1M / 100M = 100,000 LQ.
// ---------------------------------------------------------------------------

const ada: Asset = Asset { policy: ada_policy_id, name: ada_asset_name }

const tok: Asset = Asset { policy: #"bb", name: #"746f6b656e" }

const lq: Asset = Asset { policy: #"cc", name: #"6c71" }

const nft: Asset = Asset { policy: #"aa", name: #"6e6674" }

const placer: ByteArray = #"0d"

const stake: ByteArray = #"0e"

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
    // Counters are non-zero so the tests exercise the netting of reserves.
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

/// Reserves 100M / 100M once the counters are netted out.
fn pool_value() -> Value {
  assets.from_lovelace(101_000_000)
    |> assets.add(tok.policy, tok.name, 100_250_000)
    |> assets.add(lq.policy, lq.name, max_lq_cap - liquidity)
    |> assets.add(nft.policy, nft.name, 1)
}

fn cfg() -> DepositConfig {
  DepositConfig {
    pool_nft: nft,
    x: ada,
    y: tok,
    lq,
    ex_fee: 1_000_000,
    reward_pkh: placer,
    stake_pkh: Some(stake),
    collateral_ada: 2_000_000,
  }
}

fn placer_address() -> Address {
  Address {
    payment_credential: VerificationKey(placer),
    stake_credential: Some(Inline(VerificationKey(stake))),
  }
}

fn own_ref() -> OutputReference {
  OutputReference { transaction_id: #"02", output_index: 0 }
}

fn order_input(y_amount: Int) -> Input {
  Input {
    output_reference: own_ref(),
    output: Output {
      address: Address {
        payment_credential: Script(#"0b"),
        stake_credential: None,
      },
      value: assets.from_lovelace(13_000_000)
        |> assets.add(tok.policy, tok.name, y_amount),
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

fn tx(order: Input, pool: Input, reward_out: Output, extra: Bool) -> Transaction {
  let inputs = if extra {
    [order, pool, order]
  } else {
    [order, pool]
  }
  Transaction { ..transaction.placeholder, inputs, outputs: [reward_out] }
}

fn apply() -> OrderAction {
  Apply { pool_in_ix: 1, order_in_ix: 0, reward_out_ix: 0 }
}

fn run(redeemer: OrderAction, t: Transaction) -> Bool {
  deposit_order.spend(Some(cfg()), redeemer, own_ref(), t)
}

/// 100,000 LQ and the 2 ADA collateral back to the placer.
fn balanced_reward() -> Value {
  assets.from_lovelace(2_000_000) |> assets.add(lq.policy, lq.name, 100_000)
}

test balanced_deposit_passes() {
  run(
    apply(),
    tx(
      order_input(10_000_000),
      pool_input(pool_value()),
      reward(placer_address(), balanced_reward()),
      False,
    ),
  )
}

/// 12M Y against 10 ADA: Y buys 120,000, ADA buys 100,000, so 20,000 LQ worth
/// of Y at the pool ratio (2,000,000 Y) must come back.
test lopsided_deposit_returns_the_surplus() {
  let value = balanced_reward() |> assets.add(tok.policy, tok.name, 2_000_000)
  run(
    apply(),
    tx(
      order_input(12_000_000),
      pool_input(pool_value()),
      reward(placer_address(), value),
      False,
    ),
  )
}

test lopsided_deposit_keeping_the_surplus_fails() fail {
  let value = balanced_reward() |> assets.add(tok.policy, tok.name, 1_999_999)
  run(
    apply(),
    tx(
      order_input(12_000_000),
      pool_input(pool_value()),
      reward(placer_address(), value),
      False,
    ),
  )
}

test short_lq_fails() fail {
  let value = assets.from_lovelace(2_000_000)
    |> assets.add(lq.policy, lq.name, 99_999)
  run(
    apply(),
    tx(
      order_input(10_000_000),
      pool_input(pool_value()),
      reward(placer_address(), value),
      False,
    ),
  )
}

test collateral_kept_by_the_executor_fails() fail {
  let value = assets.from_lovelace(1_999_999)
    |> assets.add(lq.policy, lq.name, 100_000)
  run(
    apply(),
    tx(
      order_input(10_000_000),
      pool_input(pool_value()),
      reward(placer_address(), value),
      False,
    ),
  )
}

test reward_to_another_key_fails() fail {
  let elsewhere = Address {
    ..placer_address(),
    payment_credential: VerificationKey(#"0c"),
  }
  run(
    apply(),
    tx(
      order_input(10_000_000),
      pool_input(pool_value()),
      reward(elsewhere, balanced_reward()),
      False,
    ),
  )
}

test reward_without_the_stake_key_fails() fail {
  let unstaked = Address { ..placer_address(), stake_credential: None }
  run(
    apply(),
    tx(
      order_input(10_000_000),
      pool_input(pool_value()),
      reward(unstaked, balanced_reward()),
      False,
    ),
  )
}

test third_input_fails() fail {
  run(
    apply(),
    tx(
      order_input(10_000_000),
      pool_input(pool_value()),
      reward(placer_address(), balanced_reward()),
      True,
    ),
  )
}

test pool_without_the_nft_fails() fail {
  let bare = pool_value() |> assets.add(nft.policy, nft.name, -1)
  run(
    apply(),
    tx(
      order_input(10_000_000),
      pool_input(bare),
      reward(placer_address(), balanced_reward()),
      False,
    ),
  )
}

test naming_the_wrong_input_as_self_fails() fail {
  run(
    Apply { pool_in_ix: 1, order_in_ix: 0, reward_out_ix: 0 },
    Transaction {
      ..tx(
        order_input(10_000_000),
        pool_input(pool_value()),
        reward(placer_address(), balanced_reward()),
        False,
      ),
      inputs: [
        Input {
          ..order_input(10_000_000),
          output_reference: OutputReference {
            transaction_id: #"03",
            output_index: 0,
          },
        },
        pool_input(pool_value()),
      ],
    },
  )
}

/// The request names a second asset the order also holds in a matching
/// amount, so every figure still adds up and only the assets check rejects.
test request_for_another_pair_fails() fail {
  let other_asset = Asset { policy: #"bd", name: #"6f74686572" }
  let other = DepositConfig { ..cfg(), y: other_asset }
  let base = order_input(10_000_000)
  let order = Input {
    ..base,
    output: Output {
      ..base.output,
      value: base.output.value
        |> assets.add(other_asset.policy, other_asset.name, 10_000_000),
    },
  }
  deposit_order.spend(
    Some(other),
    apply(),
    own_ref(),
    tx(
      order,
      pool_input(pool_value()),
      reward(placer_address(), balanced_reward()),
      False,
    ),
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
