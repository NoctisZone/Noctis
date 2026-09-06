//// Noctis venue: constant-product pool with a creator (royalty) fee slot and a
//// platform (treasury) fee slot.
////
//// This is an Aiken port of Splash's `PRoyaltyPool.hs` (Plutarch, splash-core,
//// CC0-1.0). The datum layout is `SingleRoyaltyPoolConfig`, vendored unchanged
//// from `validators_v3`, so Splash's own royalty-withdraw validator applies to a
//// pool this script guards without modification. See NOTICE.
////
//// What the pool guarantees, per action (`PoolRedeemer.action`):
////
////   0 Deposit / 1 Redeem — the datum is byte-identical before and after; the
////     liquidity token moves in proportion to both reserves
////     (`dlq * rx0 <= dx * lq0` and `dlq * ry0 <= dy * lq0`).
////   2 Swap — liquidity is untouched; the constant-product invariant holds after
////     the pool fee, the treasury slice and the royalty slice are taken off the
////     input; the treasury and royalty counters in the datum grow by exactly the
////     slice the swap owes (rounded down), and only for the input side; every
////     other datum field is unchanged.
////   3 DAOAction — a withdrawal from the first `dao_policy` credential is present
////     in the transaction; the DAO script decides the rest.
////   4 WithdrawRoyalty — a withdrawal from the royalty-withdraw script is present;
////     that script decides the rest (it permits only `royalty_x/y` and `nonce`
////     to change).
////   5 RedirectRoyalty (Noctis addition) — a withdrawal from the CTO governance
////     credential is present; the successor datum equals the current one except
////     `royalty_pub_key` (replaced) and `nonce` (+1); the pool value is unchanged.
////     Splash's DAO action deliberately cannot change the royalty key. A passed
////     community-takeover vote has to, so this arm exists.
////
//// Every action also requires: the spent input is the one the redeemer names,
//// the successor output carries the pool NFT, sits at the same address, holds
//// the same number of distinct assets, and keeps the same lovelace when neither
//// side of the pool is ADA.

use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Address, Credential, Inline, Script}
use cardano/assets.{Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of, v_len}

/// Fee numerators are expressed over this denominator (Splash convention).
pub const fee_den: Int = 100_000

/// The pool keeps `max_lq_cap - liquidity` of its own LQ token, so the
/// circulating liquidity is derived rather than stored.
pub const max_lq_cap: Int = 0x7fffffffffffffff

pub const action_deposit: Int = 0

pub const action_redeem: Int = 1

pub const action_swap: Int = 2

pub const action_dao: Int = 3

pub const action_withdraw_royalty: Int = 4

pub const action_redirect_royalty: Int = 5

pub type PoolRedeemer {
  action: Int,
  self_ix: Int,
}

pub type PoolState {
  reserves_x: Int,
  reserves_y: Int,
  liquidity: Int,
  /// In a token-to-token pool, the lovelace carried alongside; 0 otherwise.
  lovelace_t2t: Int,
}

pub fn is_ada(asset: Asset) -> Bool {
  asset.policy == ada_policy_id && asset.name == ada_asset_name
}

/// Reserves net of the two fee slots, liquidity from the LQ balance.
pub fn read_pool_state(cfg: SingleRoyaltyPoolConfig, value: Value) -> PoolState {
  let x = asset_quantity_of(value, cfg.pool_x)
  let y = asset_quantity_of(value, cfg.pool_y)
  let lq_neg = asset_quantity_of(value, cfg.pool_lq)
  let lovelace_t2t = if is_ada(cfg.pool_x) || is_ada(cfg.pool_y) {
    0
  } else {
    assets.lovelace_of(value)
  }
  PoolState {
    reserves_x: x - cfg.treasury_x - cfg.royalty_x,
    reserves_y: y - cfg.treasury_y - cfg.royalty_y,
    liquidity: max_lq_cap - lq_neg,
    lovelace_t2t,
  }
}

/// Constant product after fees: the output side may shrink by at most what the
/// fee-reduced input buys. `dx`/`dy` are reserve deltas (input side positive).
pub fn swap_ok(
  rx0: Int,
  ry0: Int,
  dx: Int,
  dy: Int,
  fee_num: Int,
  treasury_fee: Int,
  royalty_fee: Int,
) -> Bool {
  let net = fee_num - treasury_fee - royalty_fee
  if dx > 0 {
    let dxf = dx * net
    -dy * ( rx0 * fee_den + dxf ) <= ry0 * dxf
  } else {
    let dyf = dy * net
    -dx * ( ry0 * fee_den + dyf ) <= rx0 * dyf
  }
}

/// The counter must grow by exactly floor(input * fee / fee_den).
pub fn slice_ok(delta: Int, input: Int, fee: Int) -> Bool {
  let owed = input * fee
  fee_den * delta <= owed && owed < fee_den * ( delta + 1 )
}

/// After a swap the datum equals the old one except the treasury and royalty
/// counters on the input side, which grew by exactly their slices.
pub fn swap_config_ok(
  prev: SingleRoyaltyPoolConfig,
  next: SingleRoyaltyPoolConfig,
  dx: Int,
  dy: Int,
) -> Bool {
  let x_in = dx > 0
  let dt = if x_in {
    next.treasury_x - prev.treasury_x
  } else {
    next.treasury_y - prev.treasury_y
  }
  let dr = if x_in {
    next.royalty_x - prev.royalty_x
  } else {
    next.royalty_y - prev.royalty_y
  }
  let input = if x_in {
    dx
  } else {
    dy
  }
  let other_side_untouched = if x_in {
    prev.treasury_y == next.treasury_y && prev.royalty_y == next.royalty_y
  } else {
    prev.treasury_x == next.treasury_x && prev.royalty_x == next.royalty_x
  }
  let expected = SingleRoyaltyPoolConfig {
    ..prev,
    treasury_x: next.treasury_x,
    treasury_y: next.treasury_y,
    royalty_x: next.royalty_x,
    royalty_y: next.royalty_y,
  }
  and {
    expected == next,
    slice_ok(dt, input, prev.treasury_fee),
    slice_ok(dr, input, prev.royalty_fee),
    other_side_untouched,
  }
}

/// Deposit and redeem move LQ in proportion to both reserves.
pub fn deposit_redeem_ok(
  rx0: Int,
  ry0: Int,
  lq0: Int,
  dx: Int,
  dy: Int,
  dlq: Int,
) -> Bool {
  dlq * rx0 <= dx * lq0 && dlq * ry0 <= dy * lq0
}

/// The Noctis arm: only the royalty key and the nonce change.
pub fn redirect_config_ok(
  prev: SingleRoyaltyPoolConfig,
  next: SingleRoyaltyPoolConfig,
) -> Bool {
  let expected = SingleRoyaltyPoolConfig {
    ..prev,
    royalty_pub_key: next.royalty_pub_key,
    nonce: prev.nonce + 1,
  }
  expected == next && next.royalty_pub_key != prev.royalty_pub_key
}

fn find_pool_output(nft: Asset, outputs: List<Output>) -> Output {
  expect Some(out) = list.find(
    outputs,
    fn(o) { asset_quantity_of(o.value, nft) == 1 },
  )
  out
}

fn has_withdrawal(self: Transaction, cred: Credential) -> Bool {
  pairs.has_key(self.withdrawals, cred)
}

/// `royalty_withdraw_vh`: script hash of the royalty-withdraw validator, which
/// Splash hardcodes and Noctis parameterises. `redirect_cred`: the
/// credential whose withdrawal authorises a royalty redirect.
validator pool(royalty_withdraw_vh: ByteArray, redirect_cred: Credential) {
  spend(
    datum: Option<SingleRoyaltyPoolConfig>,
    redeemer: PoolRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(cfg) = datum
    expect Some(self_in) = list.at(self.inputs, redeemer.self_ix)
    let Input { output_reference: self_in_ref, output: self_out } = self_in
    let self_identity = self_in_ref == own_ref

    let successor = find_pool_output(cfg.pool_nft, self.outputs)
    let s0 = read_pool_state(cfg, self_out.value)
    let s1 = read_pool_state(cfg, successor.value)
    let dx = s1.reserves_x - s0.reserves_x
    let dy = s1.reserves_y - s0.reserves_y
    let dlq = s1.liquidity - s0.liquidity

    expect InlineDatum(succ_datum_raw) = successor.datum
    expect succ_cfg: SingleRoyaltyPoolConfig = succ_datum_raw

    let no_more_tokens = v_len(self_out.value) == v_len(successor.value)
    let script_preserved = successor.address == self_out.address
    let lovelace_t2t_preserved = s1.lovelace_t2t == s0.lovelace_t2t

    let valid = if redeemer.action == action_swap {
      and {
        dlq == 0,
        swap_ok(
          s0.reserves_x,
          s0.reserves_y,
          dx,
          dy,
          cfg.fee_num,
          cfg.treasury_fee,
          cfg.royalty_fee,
        ),
        swap_config_ok(cfg, succ_cfg, dx, dy),
      }
    } else if redeemer.action == action_dao {
      expect Some(Inline(dao_cred)) = list.head(cfg.dao_policy)
      has_withdrawal(self, dao_cred)
    } else if redeemer.action == action_withdraw_royalty {
      has_withdrawal(self, Script(royalty_withdraw_vh))
    } else if redeemer.action == action_redirect_royalty {
      and {
        has_withdrawal(self, redirect_cred),
        redirect_config_ok(cfg, succ_cfg),
        successor.value == self_out.value,
      }
    } else if redeemer.action == action_deposit || redeemer.action == action_redeem {
      and {
        succ_cfg == cfg,
        deposit_redeem_ok(
          s0.reserves_x,
          s0.reserves_y,
          s0.liquidity,
          dx,
          dy,
          dlq,
        ),
      }
    } else {
      False
    }

    and {
      self_identity,
      no_more_tokens,
      script_preserved,
      lovelace_t2t_preserved,
      valid,
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests. Vectors are hand-derived from the Plutarch formulas this file ports.
// ---------------------------------------------------------------------------

const fee_num_030: Int = 99_700

// 0.30% pool fee: fee_num = fee_den - 300

const t_fee_010: Int = 100

// 0.10% platform slice

const r_fee_100: Int = 1_000

// 1.00% creator slice

/// 1,000,000 X in against reserves 100M/100M. Net fee 98,600/100,000.
/// dxf = 98,600,000,000. Max output: ry0*dxf / (rx0*fee_den + dxf)
/// = 9.86e18 / (1.0e13 + 9.86e10) = 976,372.96…, so 976,372 out passes and
/// 976,373 fails.
test swap_at_the_bound() {
  swap_ok(
    100_000_000,
    100_000_000,
    1_000_000,
    -976_372,
    fee_num_030,
    t_fee_010,
    r_fee_100,
  )
}

test swap_one_past_the_bound_fails() {
  !swap_ok(
    100_000_000,
    100_000_000,
    1_000_000,
    -976_373,
    fee_num_030,
    t_fee_010,
    r_fee_100,
  )
}

/// Same trade in the Y direction uses the mirrored inequality.
test swap_y_direction_at_the_bound() {
  swap_ok(
    100_000_000,
    100_000_000,
    -976_372,
    1_000_000,
    fee_num_030,
    t_fee_010,
    r_fee_100,
  )
}

/// 1,000,000 in at 1.00% owes exactly 10,000 to the royalty counter.
test royalty_slice_exact() {
  slice_ok(10_000, 1_000_000, r_fee_100)
}

test royalty_slice_short_by_one_fails() {
  !slice_ok(9_999, 1_000_000, r_fee_100)
}

test royalty_slice_over_by_one_fails() {
  !slice_ok(10_001, 1_000_000, r_fee_100)
}

/// 999,999 in at 0.10% owes 999.999, so the counter grows by 999 (floor).
test treasury_slice_rounds_down() {
  slice_ok(999, 999_999, t_fee_010) && !slice_ok(1_000, 999_999, t_fee_010)
}

fn sample_cfg() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: Asset { policy: #"aa", name: #"6e6674" },
    pool_x: Asset { policy: ada_policy_id, name: ada_asset_name },
    pool_y: Asset { policy: #"bb", name: #"746f6b656e" },
    pool_lq: Asset { policy: #"cc", name: #"6c71" },
    fee_num: fee_num_030,
    treasury_fee: t_fee_010,
    royalty_fee: r_fee_100,
    treasury_x: 0,
    treasury_y: 0,
    royalty_x: 0,
    royalty_y: 0,
    dao_policy: [Inline(Script(#"dd"))],
    treasury_address: #"ee",
    royalty_pub_key: #"ff",
    nonce: 0,
  }
}

test swap_config_grows_both_input_side_counters() {
  let prev = sample_cfg()
  let next = SingleRoyaltyPoolConfig {
    ..prev,
    treasury_x: 1_000,
    royalty_x: 10_000,
  }
  swap_config_ok(prev, next, 1_000_000, -976_372)
}

test swap_config_skimmed_royalty_fails() {
  let prev = sample_cfg()
  let next = SingleRoyaltyPoolConfig {
    ..prev,
    treasury_x: 1_000,
    royalty_x: 9_999,
  }
  !swap_config_ok(prev, next, 1_000_000, -976_372)
}

test swap_config_touching_other_side_fails() {
  let prev = sample_cfg()
  let next = SingleRoyaltyPoolConfig {
    ..prev,
    treasury_x: 1_000,
    royalty_x: 10_000,
    royalty_y: 1,
  }
  !swap_config_ok(prev, next, 1_000_000, -976_372)
}

test swap_config_changing_royalty_key_fails() {
  let prev = sample_cfg()
  let next = SingleRoyaltyPoolConfig {
    ..prev,
    treasury_x: 1_000,
    royalty_x: 10_000,
    royalty_pub_key: #"01",
  }
  !swap_config_ok(prev, next, 1_000_000, -976_372)
}

/// Deposit 1% of each reserve mints 1% of the liquidity, no more.
test deposit_proportional() {
  deposit_redeem_ok(
    100_000_000,
    100_000_000,
    50_000_000,
    1_000_000,
    1_000_000,
    500_000,
  )
}

test deposit_over_minted_fails() {
  !deposit_redeem_ok(
    100_000_000,
    100_000_000,
    50_000_000,
    1_000_000,
    1_000_000,
    500_001,
  )
}

/// A lopsided deposit is capped by the smaller side.
test deposit_lopsided_capped_by_smaller_side() {
  !deposit_redeem_ok(
    100_000_000,
    100_000_000,
    50_000_000,
    2_000_000,
    1_000_000,
    1_000_000,
  )
}

test redirect_changes_only_key_and_nonce() {
  let prev = sample_cfg()
  let next = SingleRoyaltyPoolConfig {
    ..prev,
    royalty_pub_key: #"01",
    nonce: 1,
  }
  redirect_config_ok(prev, next)
}

test redirect_without_nonce_bump_fails() {
  let prev = sample_cfg()
  let next = SingleRoyaltyPoolConfig { ..prev, royalty_pub_key: #"01" }
  !redirect_config_ok(prev, next)
}

test redirect_that_also_moves_a_counter_fails() {
  let prev = sample_cfg()
  let next = SingleRoyaltyPoolConfig {
    ..prev,
    royalty_pub_key: #"01",
    nonce: 1,
    royalty_x: 5,
  }
  !redirect_config_ok(prev, next)
}

test redirect_to_same_key_fails() {
  let prev = sample_cfg()
  let next = SingleRoyaltyPoolConfig { ..prev, nonce: 1 }
  !redirect_config_ok(prev, next)
}

/// Reserves exclude both fee slots; liquidity is the complement of the LQ held.
test read_state_nets_out_fee_slots() {
  let cfg = SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    treasury_x: 1_000,
    royalty_x: 10_000,
    treasury_y: 7,
    royalty_y: 3,
  }
  let value = assets.from_lovelace(100_011_000)
    |> assets.add(#"bb", #"746f6b656e", 100_000_010)
    |> assets.add(#"cc", #"6c71", max_lq_cap - 50_000_000)
  let s = read_pool_state(cfg, value)
  and {
    s.reserves_x == 100_000_000,
    s.reserves_y == 100_000_000,
    s.liquidity == 50_000_000,
    s.lovelace_t2t == 0,
  }
}

// -- Transaction-level: one passing swap, then single-delta rejections. --------

fn pool_address() -> Address {
  Address { payment_credential: Script(#"0a"), stake_credential: None }
}

/// Raw pool value: `x`/`y` are the gross totals held, counters included.
/// Both states are read under the input datum, so a swap's `dx` is the gross
/// amount the trader sent and the fee slices are carved out of it.
fn pool_value(cfg: SingleRoyaltyPoolConfig, x: Int, y: Int, lq: Int) -> Value {
  assets.from_lovelace(x)
    |> assets.add(cfg.pool_y.policy, cfg.pool_y.name, y)
    |> assets.add(cfg.pool_lq.policy, cfg.pool_lq.name, max_lq_cap - lq)
    |> assets.add(cfg.pool_nft.policy, cfg.pool_nft.name, 1)
}

fn own_ref() -> OutputReference {
  OutputReference { transaction_id: #"01", output_index: 0 }
}

fn swap_tx(next: SingleRoyaltyPoolConfig, y_out: Int) -> Transaction {
  let prev = sample_cfg()
  let pool_in = Input {
    output_reference: own_ref(),
    output: Output {
      address: pool_address(),
      value: pool_value(prev, 100_000_000, 100_000_000, 50_000_000),
      datum: InlineDatum(prev),
      reference_script: None,
    },
  }
  let pool_out = Output {
    address: pool_address(),
    value: pool_value(prev, 101_000_000, 100_000_000 - y_out, 50_000_000),
    datum: InlineDatum(next),
    reference_script: None,
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_in],
    outputs: [pool_out],
  }
}

fn swapped_cfg() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    treasury_x: 1_000,
    royalty_x: 10_000,
  }
}

test tx_swap_at_the_bound_passes() {
  pool.spend(
    #"0b",
    Script(#"0c"),
    Some(sample_cfg()),
    PoolRedeemer { action: action_swap, self_ix: 0 },
    own_ref(),
    swap_tx(swapped_cfg(), 976_372),
  )
}

test tx_swap_one_past_the_bound_fails() fail {
  pool.spend(
    #"0b",
    Script(#"0c"),
    Some(sample_cfg()),
    PoolRedeemer { action: action_swap, self_ix: 0 },
    own_ref(),
    swap_tx(swapped_cfg(), 976_373),
  )
}

test tx_swap_skimming_the_creator_fails() fail {
  let next = SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    treasury_x: 1_000,
    royalty_x: 9_999,
  }
  pool.spend(
    #"0b",
    Script(#"0c"),
    Some(sample_cfg()),
    PoolRedeemer { action: action_swap, self_ix: 0 },
    own_ref(),
    swap_tx(next, 976_372),
  )
}

test tx_swap_that_rewrites_the_royalty_key_fails() fail {
  let next = SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    treasury_x: 1_000,
    royalty_x: 10_000,
    royalty_pub_key: #"01",
  }
  pool.spend(
    #"0b",
    Script(#"0c"),
    Some(sample_cfg()),
    PoolRedeemer { action: action_swap, self_ix: 0 },
    own_ref(),
    swap_tx(next, 976_372),
  )
}

fn redirect_tx(next: SingleRoyaltyPoolConfig, cred: Credential) -> Transaction {
  let prev = sample_cfg()
  let value = pool_value(prev, 100_000_000, 100_000_000, 50_000_000)
  let pool_in = Input {
    output_reference: own_ref(),
    output: Output {
      address: pool_address(),
      value,
      datum: InlineDatum(prev),
      reference_script: None,
    },
  }
  let pool_out = Output {
    address: pool_address(),
    value,
    datum: InlineDatum(next),
    reference_script: None,
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_in],
    outputs: [pool_out],
    withdrawals: [Pair(cred, 0)],
  }
}

test tx_redirect_with_governance_withdrawal_passes() {
  let next = SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    royalty_pub_key: #"01",
    nonce: 1,
  }
  pool.spend(
    #"0b",
    Script(#"0c"),
    Some(sample_cfg()),
    PoolRedeemer { action: action_redirect_royalty, self_ix: 0 },
    own_ref(),
    redirect_tx(next, Script(#"0c")),
  )
}

test tx_redirect_without_governance_withdrawal_fails() fail {
  let next = SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    royalty_pub_key: #"01",
    nonce: 1,
  }
  pool.spend(
    #"0b",
    Script(#"0c"),
    Some(sample_cfg()),
    PoolRedeemer { action: action_redirect_royalty, self_ix: 0 },
    own_ref(),
    redirect_tx(next, Script(#"0d")),
  )
}

test tx_redirect_dressed_as_a_swap_fails() fail {
  let next = SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    royalty_pub_key: #"01",
    nonce: 1,
  }
  pool.spend(
    #"0b",
    Script(#"0c"),
    Some(sample_cfg()),
    PoolRedeemer { action: action_swap, self_ix: 0 },
    own_ref(),
    redirect_tx(next, Script(#"0c")),
  )
}
