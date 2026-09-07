//// NoctisSwap: a swap request against one pool.
////
//// Ours, informed by two Splash designs (splash-core, CC0-1.0 / Apache-2.0):
//// the Plutarch `PSwap.hs`, which fills one order per pool spend and hands the
//// placer the pool's whole output, and the Aiken `limit_order.ak`, which adds
//// a price floor, partial fills, pro-rata executor fees and permitted
//// executors. NoctisSwap keeps the first design's guarantee and takes the
//// second's features:
////
////   One order per pool spend. Exactly two inputs, so every order meets the
////     pool alone and the pool's fee slices are taken on the order's whole
////     input. Orders that could net against each other inside one
////     transaction would pay the creator and the platform on the difference
////     only; here that cannot happen. Throughput comes from chaining
////     transactions, which is how Splash's own executor runs.
////   No skim. What leaves the pool on the output side reaches the placer in
////     full, and what enters the pool on the input side is exactly the part
////     of the order being traded. The executor earns the agreed fee and
////     nothing else.
////   Price floor. The output the placer receives for the input traded is at
////     least `base_price`.
////   Partial fills. The order may continue at its own address with a smaller
////     `tradable_input` and a fee reduced no more than pro rata, every other
////     field unchanged, and no fill smaller than `min_marginal_output`.
////   Nothing unmeasured. The order holds only the two assets it trades and
////     ADA, and a continuation may hold no more than the order it came from,
////     so no asset rides along that none of the rules above measures and the
////     next fill is never jammed by a token left behind.
////   Executors. If the order names any, one of them signs.
////   Cancel. Signed by the placer.
////
//// The pool validator holds the constant-product bound and the fee slices;
//// this validator holds the placer's side.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use noctisswap/orders.{
  Cancel, Fill, SwapAction, SwapConfig, only_named_assets, reward_address_ok,
}
use noctisswap/pool_state.{PoolState, is_ada, max_lq_cap, read_pool_state}
use splash/plutus.{Asset}
use splash/rational.{Rational}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of}

/// The pool's reserve of one of its two assets, from a state read.
fn reserve_of(
  cfg: SingleRoyaltyPoolConfig,
  state: PoolState,
  asset: Asset,
) -> Int {
  if asset == cfg.pool_x {
    state.reserves_x
  } else {
    state.reserves_y
  }
}

fn executor_ok(
  permitted: List<VerificationKeyHash>,
  signatories: List<VerificationKeyHash>,
) -> Bool {
  when permitted is {
    [] -> True
    _ -> list.any(permitted, fn(e) { list.has(signatories, e) })
  }
}

validator swap_order {
  spend(
    datum: Option<SwapConfig>,
    redeemer: SwapAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(cfg) = datum
    when redeemer is {
      Cancel -> list.has(self.extra_signatories, cfg.reward_pkh)
      Fill { pool_in_ix, order_in_ix, successor_ix } -> {
        expect Some(order_in) = list.at(self.inputs, order_in_ix)
        expect Some(pool_in) = list.at(self.inputs, pool_in_ix)
        expect Some(successor) = list.at(self.outputs, successor_ix)
        expect InlineDatum(pool_raw) = pool_in.output.datum
        expect pool_cfg: SingleRoyaltyPoolConfig = pool_raw
        expect Some(pool_out) = list.find(
          self.outputs,
          fn(o) { asset_quantity_of(o.value, pool_cfg.pool_nft) == 1 },
        )
        let s0 = read_pool_state(pool_cfg, pool_in.output.value)
        let s1 = read_pool_state(pool_cfg, pool_out.value)
        let pool_took = reserve_of(pool_cfg, s1, cfg.input) - reserve_of(
          pool_cfg,
          s0,
          cfg.input,
        )
        let pool_gave = reserve_of(pool_cfg, s0, cfg.output) - reserve_of(
          pool_cfg,
          s1,
          cfg.output,
        )

        let self_value = order_in.output.value
        let next_value = successor.value
        let input_removed = asset_quantity_of(self_value, cfg.input) - asset_quantity_of(
          next_value,
          cfg.input,
        )
        let output_delta = asset_quantity_of(next_value, cfg.output) - asset_quantity_of(
          self_value,
          cfg.output,
        )
        let lovelace_delta = assets.lovelace_of(next_value) - assets.lovelace_of(
          self_value,
        )

        let direction_ok = cfg.input == pool_cfg.pool_x && cfg.output == pool_cfg.pool_y || cfg.input == pool_cfg.pool_y && cfg.output == pool_cfg.pool_x

        let terminated = reward_address_ok(
          successor.address,
          cfg.reward_pkh,
          cfg.stake_pkh,
        )
        let (traded, fee_removed, continuation_ok) = if terminated {
          (cfg.tradable_input, cfg.ex_fee, True)
        } else {
          expect InlineDatum(next_raw) = successor.datum
          expect next: SwapConfig = next_raw
          let traded = cfg.tradable_input - next.tradable_input
          let fee_removed = cfg.ex_fee - next.ex_fee
          let expected = SwapConfig {
            ..cfg,
            tradable_input: next.tradable_input,
            ex_fee: next.ex_fee,
          }
          let ok = and {
            successor.address == order_in.output.address,
            next == expected,
            next.tradable_input > 0,
            next.ex_fee >= 0,
            only_named_assets(next_value, [cfg.input, cfg.output]),
            fee_removed * cfg.tradable_input <= traded * cfg.ex_fee,
            output_delta + lovelace_fee_adjust(cfg.output, fee_removed) >= cfg.min_marginal_output,
          }
          (traded, fee_removed, ok)
        }
        let output_added = output_delta + lovelace_fee_adjust(
          cfg.output,
          fee_removed,
        )
        let integrity = if is_ada(cfg.input) {
          input_removed <= traded + fee_removed
        } else {
          input_removed <= traded && -lovelace_delta <= fee_removed
        }

        and {
          order_in.output_reference == own_ref,
          list.length(self.inputs) == 2,
          asset_quantity_of(pool_in.output.value, cfg.pool_nft) == 1,
          only_named_assets(self_value, [cfg.input, cfg.output]),
          direction_ok,
          executor_ok(cfg.permitted_executors, self.extra_signatories),
          traded > 0,
          pool_took == traded,
          output_added >= pool_gave,
          output_added * cfg.base_price.denom >= traded * cfg.base_price.num,
          integrity,
          continuation_ok,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

/// When the output asset is ADA the executor's fee leaves the same lovelace
/// balance the output arrives in, so it is added back to see what the pool
/// really paid.
fn lovelace_fee_adjust(output: Asset, fee_removed: Int) -> Int {
  if is_ada(output) {
    fee_removed
  } else {
    0
  }
}

// ---------------------------------------------------------------------------
// Tests. Pool 100M ADA / 100M token at 99,700 / 100 / 1,000. A 1,000,000
// lovelace buy is worth 976,372 tokens at most (the pool's own bound).
// ---------------------------------------------------------------------------

const ada: Asset = Asset { policy: ada_policy_id, name: ada_asset_name }

const tok: Asset = Asset { policy: #"bb", name: #"746f6b656e" }

const lq: Asset = Asset { policy: #"cc", name: #"6c71" }

const nft: Asset = Asset { policy: #"aa", name: #"6e6674" }

const placer: ByteArray = #"0d"

const executor: ByteArray = #"e0"

fn pool_cfg() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: nft,
    pool_x: ada,
    pool_y: tok,
    pool_lq: lq,
    fee_num: 99_700,
    treasury_fee: 100,
    royalty_fee: 1_000,
    treasury_x: 0,
    treasury_y: 0,
    royalty_x: 0,
    royalty_y: 0,
    dao_policy: [],
    treasury_address: #"ee",
    royalty_pub_key: #"ff",
    nonce: 3,
  }
}

fn pool_value(lovelace: Int, tokens: Int) -> Value {
  assets.from_lovelace(lovelace)
    |> assets.add(tok.policy, tok.name, tokens)
    |> assets.add(lq.policy, lq.name, max_lq_cap - 1_000_000)
    |> assets.add(nft.policy, nft.name, 1)
}

fn pool_address() -> Address {
  Address { payment_credential: Script(#"0a"), stake_credential: None }
}

fn order_address() -> Address {
  Address { payment_credential: Script(#"0b"), stake_credential: None }
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

/// Buy: 1,000,000 lovelace traded, 1,000,000 fee, 1,000,000 kept for the reward
/// output; floor 0.9 tokens per lovelace; anyone may fill.
fn buy() -> SwapConfig {
  SwapConfig {
    pool_nft: nft,
    input: ada,
    output: tok,
    tradable_input: 1_000_000,
    base_price: Rational { num: 9, denom: 10 },
    min_marginal_output: 100_000,
    ex_fee: 1_000_000,
    reward_pkh: placer,
    stake_pkh: None,
    permitted_executors: [],
  }
}

/// Sell: 1,000,000 tokens traded for lovelace; 1,000,000 fee and 1,000,000
/// kept, both in lovelace.
fn sell() -> SwapConfig {
  SwapConfig { ..buy(), input: tok, output: ada }
}

fn order_input(cfg: SwapConfig, value: Value) -> Input {
  Input {
    output_reference: own_ref(),
    output: Output {
      address: order_address(),
      value,
      datum: InlineDatum(cfg),
      reference_script: None,
    },
  }
}

fn pool_input(value: Value) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"01", output_index: 0 },
    output: Output {
      address: pool_address(),
      value,
      datum: InlineDatum(pool_cfg()),
      reference_script: None,
    },
  }
}

fn pool_output(value: Value) -> Output {
  Output {
    address: pool_address(),
    value,
    datum: InlineDatum(pool_cfg()),
    reference_script: None,
  }
}

fn out(to: Address, value: Value, datum: transaction.Datum) -> Output {
  Output { address: to, value, datum, reference_script: None }
}

fn buy_order_value() -> Value {
  assets.from_lovelace(3_000_000)
}

fn sell_order_value() -> Value {
  assets.from_lovelace(2_000_000) |> assets.add(tok.policy, tok.name, 1_000_000)
}

fn fill() -> SwapAction {
  Fill { pool_in_ix: 1, order_in_ix: 0, successor_ix: 1 }
}

/// Inputs [order, pool]; outputs [pool successor, order successor].
fn tx(
  order: Input,
  pool_after: Value,
  successor: Output,
  signers: List<VerificationKeyHash>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [order, pool_input(pool_value(100_000_000, 100_000_000))],
    outputs: [pool_output(pool_after), successor],
    extra_signatories: signers,
  }
}

fn run(cfg: SwapConfig, redeemer: SwapAction, t: Transaction) -> Bool {
  swap_order.spend(Some(cfg), redeemer, own_ref(), t)
}

/// The pool takes the 1,000,000 lovelace and gives 976,372 tokens; the placer
/// gets those tokens plus the 1,000,000 lovelace kept back.
fn full_buy(tokens_to_placer: Int, lovelace_to_placer: Int) -> Transaction {
  tx(
    order_input(buy(), buy_order_value()),
    pool_value(101_000_000, 100_000_000 - 976_372),
    out(
      placer_address(),
      assets.from_lovelace(lovelace_to_placer)
        |> assets.add(tok.policy, tok.name, tokens_to_placer),
      transaction.NoDatum,
    ),
    [],
  )
}

test full_buy_passes() {
  run(buy(), fill(), full_buy(976_372, 1_000_000))
}

test full_sell_passes() {
  let t = tx(
    order_input(sell(), sell_order_value()),
    pool_value(100_000_000 - 976_372, 101_000_000),
    out(placer_address(), assets.from_lovelace(1_976_372), transaction.NoDatum),
    [],
  )
  run(sell(), fill(), t)
}

/// 400,000 of the 1,000,000 traded: the pool gives 394,000 tokens, the fee
/// drops by 400,000, and the order continues with 600,000 to trade.
fn partial_buy(
  next_tradable: Int,
  next_fee: Int,
  tokens: Int,
  lovelace: Int,
  at: Address,
) -> Transaction {
  let next = SwapConfig {
    ..buy(),
    tradable_input: next_tradable,
    ex_fee: next_fee,
  }
  tx(
    order_input(buy(), buy_order_value()),
    pool_value(100_400_000, 100_000_000 - 394_000),
    out(
      at,
      assets.from_lovelace(lovelace) |> assets.add(tok.policy, tok.name, tokens),
      InlineDatum(next),
    ),
    [],
  )
}

test partial_buy_passes() {
  run(
    buy(),
    fill(),
    partial_buy(600_000, 600_000, 394_000, 2_200_000, order_address()),
  )
}

test partial_buy_with_a_fee_over_pro_rata_fails() fail {
  // 400,001 of fee taken for 400,000 of the 1,000,000 traded.
  run(
    buy(),
    fill(),
    partial_buy(600_000, 599_999, 394_000, 2_199_999, order_address()),
  )
}

/// The continuation carries the same floor, so only the marginal rule rejects.
test partial_buy_below_the_marginal_output_fails() fail {
  let small = SwapConfig { ..buy(), min_marginal_output: 394_001 }
  let next = SwapConfig { ..small, tradable_input: 600_000, ex_fee: 600_000 }
  let t = tx(
    order_input(small, buy_order_value()),
    pool_value(100_400_000, 100_000_000 - 394_000),
    out(
      order_address(),
      assets.from_lovelace(2_200_000)
        |> assets.add(tok.policy, tok.name, 394_000),
      InlineDatum(next),
    ),
    [],
  )
  run(small, fill(), t)
}

test partial_buy_moving_the_order_fails() fail {
  let elsewhere = Address {
    payment_credential: Script(#"0c"),
    stake_credential: None,
  }
  run(
    buy(),
    fill(),
    partial_buy(600_000, 600_000, 394_000, 2_200_000, elsewhere),
  )
}

test partial_buy_rewriting_the_floor_fails() fail {
  let next = SwapConfig {
    ..buy(),
    tradable_input: 600_000,
    ex_fee: 600_000,
    base_price: Rational { num: 1, denom: 10 },
  }
  let t = tx(
    order_input(buy(), buy_order_value()),
    pool_value(100_400_000, 100_000_000 - 394_000),
    out(
      order_address(),
      assets.from_lovelace(2_200_000)
        |> assets.add(tok.policy, tok.name, 394_000),
      InlineDatum(next),
    ),
    [],
  )
  run(buy(), fill(), t)
}

test buy_below_the_price_floor_fails() fail {
  // 899,999 tokens for 1,000,000 lovelace is under 0.9; the pool gives the same.
  let t = tx(
    order_input(buy(), buy_order_value()),
    pool_value(101_000_000, 100_000_000 - 899_999),
    out(
      placer_address(),
      assets.from_lovelace(1_000_000)
        |> assets.add(tok.policy, tok.name, 899_999),
      transaction.NoDatum,
    ),
    [],
  )
  run(buy(), fill(), t)
}

/// The pool gave 976,372 but the placer sees 950,000, still above the floor:
/// only the no-skim rule rejects.
test executor_skimming_the_output_fails() fail {
  run(buy(), fill(), full_buy(950_000, 1_000_000))
}

/// The pool took 1,000,001 lovelace for the same output while the placer's
/// side is untouched, so only the pool-took rule rejects.
test executor_routing_more_than_the_trade_into_the_pool_fails() fail {
  let t = tx(
    order_input(buy(), buy_order_value()),
    pool_value(101_000_001, 100_000_000 - 976_372),
    out(
      placer_address(),
      assets.from_lovelace(1_000_000)
        |> assets.add(tok.policy, tok.name, 976_372),
      transaction.NoDatum,
    ),
    [],
  )
  run(buy(), fill(), t)
}

test executor_over_collecting_the_reserve_fails() fail {
  run(buy(), fill(), full_buy(976_372, 999_999))
}

/// A reward to another key is not a termination, and it cannot pass as a
/// continuation either: the order's address is not that key's.
test reward_to_another_key_fails() fail {
  let elsewhere = Address {
    payment_credential: VerificationKey(#"0c"),
    stake_credential: None,
  }
  let t = tx(
    order_input(buy(), buy_order_value()),
    pool_value(101_000_000, 100_000_000 - 976_372),
    out(
      elsewhere,
      assets.from_lovelace(1_000_000)
        |> assets.add(tok.policy, tok.name, 976_372),
      InlineDatum(buy()),
    ),
    [],
  )
  run(buy(), fill(), t)
}

/// A continuation that trades nothing, with no marginal floor to catch it:
/// only the traded-amount rule rejects.
test fill_that_trades_nothing_fails() fail {
  let idle = SwapConfig { ..buy(), min_marginal_output: 0 }
  let t = tx(
    order_input(idle, buy_order_value()),
    pool_value(100_000_000, 100_000_000),
    out(order_address(), buy_order_value(), InlineDatum(idle)),
    [],
  )
  run(idle, fill(), t)
}

/// A continuation with nothing left to trade must instead have terminated.
test partial_that_empties_the_order_fails() fail {
  let next = SwapConfig { ..buy(), tradable_input: 0, ex_fee: 0 }
  let t = tx(
    order_input(buy(), buy_order_value()),
    pool_value(101_000_000, 100_000_000 - 976_372),
    out(
      order_address(),
      assets.from_lovelace(1_000_000)
        |> assets.add(tok.policy, tok.name, 976_372),
      InlineDatum(next),
    ),
    [],
  )
  run(buy(), fill(), t)
}

test permitted_executor_signing_passes() {
  let gated = SwapConfig { ..buy(), permitted_executors: [executor] }
  let t = Transaction {
    ..full_buy(976_372, 1_000_000),
    extra_signatories: [executor],
  }
  run(gated, fill(), t)
}

test unlisted_executor_fails() fail {
  let gated = SwapConfig { ..buy(), permitted_executors: [executor] }
  let t = Transaction {
    ..full_buy(976_372, 1_000_000),
    extra_signatories: [#"e1"],
  }
  run(gated, fill(), t)
}

test third_input_fails() fail {
  let base = full_buy(976_372, 1_000_000)
  run(
    buy(),
    fill(),
    Transaction {
      ..base,
      inputs: list.concat(base.inputs, [order_input(buy(), buy_order_value())]),
    },
  )
}

test naming_the_wrong_input_as_self_fails() fail {
  let renamed = Input {
    ..order_input(buy(), buy_order_value()),
    output_reference: OutputReference { transaction_id: #"03", output_index: 0 },
  }
  let base = full_buy(976_372, 1_000_000)
  run(
    buy(),
    fill(),
    Transaction {
      ..base,
      inputs: [renamed, pool_input(pool_value(100_000_000, 100_000_000))],
    },
  )
}

test order_against_another_pool_fails() fail {
  let other = SwapConfig {
    ..buy(),
    pool_nft: Asset { policy: #"aa", name: #"6f74686572" },
  }
  run(other, fill(), full_buy(976_372, 1_000_000))
}

test order_for_an_asset_the_pool_lacks_fails() fail {
  let other = SwapConfig {
    ..buy(),
    output: Asset { policy: #"bd", name: #"6f74686572" },
  }
  let t = tx(
    order_input(other, buy_order_value()),
    pool_value(101_000_000, 100_000_000 - 976_372),
    out(
      placer_address(),
      assets.from_lovelace(1_000_000)
        |> assets.add(#"bd", #"6f74686572", 976_372),
      transaction.NoDatum,
    ),
    [],
  )
  run(other, fill(), t)
}

test cancel_signed_by_the_placer_passes() {
  run(
    buy(),
    Cancel,
    Transaction { ..transaction.placeholder, extra_signatories: [placer] },
  )
}

test cancel_without_the_placer_fails() fail {
  run(
    buy(),
    Cancel,
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

/// The same shaper on the other side: a stray on the continuation the order
/// leaves behind. Nothing else moves, so only the successor's residual rule
/// can reject it — and without that rule an executor could park a token on the
/// continuation, either to collect on the next fill or to jam it.
fn with_a_stray_on_the_successor(t: Transaction) -> Transaction {
  expect [pool_out, successor] = t.outputs
  Transaction {
    ..t,
    outputs: [
      pool_out,
      Output {
        ..successor,
        value: successor.value |> assets.add(#"99", #"7374726179", 1),
      },
    ],
  }
}

test swap_carrying_an_asset_it_does_not_name_fails() fail {
  run(buy(), fill(), with_a_stray_in_the_request(full_buy(976_372, 1_000_000)))
}

test partial_fill_leaving_a_stray_on_the_continuation_fails() fail {
  run(
    buy(),
    fill(),
    with_a_stray_on_the_successor(
      partial_buy(600_000, 600_000, 394_000, 2_200_000, order_address()),
    ),
  )
}
