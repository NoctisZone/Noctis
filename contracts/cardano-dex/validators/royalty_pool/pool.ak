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
////   3 DAOAction — a withdrawal from the first `dao_policy` credential is
////     present in the transaction, and the DAO script decides how much moves.
////     That entry must be a SCRIPT credential: a withdrawal at a script runs
////     it, so requiring the script form is what makes the delegation real.
////     What it may never do is decided here: liquidity is untouched, only the
////     treasury counters and the treasury fee may change in the datum — the
////     nonce included, since it is the creator's replay protection and not the
////     platform's — neither counter ends below zero, and whatever leaves the
////     pool comes out of a treasury counter rather than out of the reserves or
////     the creator's slot.
////   4 WithdrawRoyalty — a withdrawal from the royalty-withdraw script is present;
////     that script decides the rest (it permits only `royalty_x/y` and `nonce`
////     to change).
////   5 RedirectRoyalty (Noctis addition) — a withdrawal from the governance
////     credential is present, the second `dao_policy` entry, which the factory
////     writes at creation and which must likewise be a script; the successor
////     datum equals the current one except `royalty_pub_key` (replaced) and
////     `nonce` (+1); the pool value is unchanged.
////     Splash's DAO action deliberately cannot change the royalty key. A passed
////     community-takeover vote has to, so this arm exists.
////
//// Every action also requires: the spent input is the one the redeemer names
//// AND carries the pool NFT its own datum names, so a UTxO that merely sits at
//// this address is not a pool; the successor output carries that NFT, sits at
//// the same address, holds the same number of distinct assets, and keeps the
//// same lovelace when neither side of the pool is ADA.

use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
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
  and {
    // The schedule must leave something after both slices, and the pool must
    // hold a reserve on each side to price against. These three are what keep
    // the bracket below a sum of positive terms: the comparison is then always
    // a ceiling on what may leave, it can never turn into a floor, and the
    // output it permits is strictly less than the reserve. A separate rule
    // holding each side above zero would be redundant for that reason, so
    // there isn't one.
    net > 0,
    rx0 > 0,
    ry0 > 0,
    // A swap has an input side and an output side. The branch is chosen by
    // which side is the input, not by the sign of one delta, so a move that
    // takes from both sides has no branch to fall into.
    if dx > 0 {
      let dxf = dx * net
      dy <= 0 && -dy * ( rx0 * fee_den + dxf ) <= ry0 * dxf
    } else if dy > 0 {
      let dyf = dy * net
      -dx * ( ry0 * fee_den + dyf ) <= rx0 * dyf
    } else {
      False
    },
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

/// Deposit and redeem move LQ in proportion to both reserves. The pool must
/// already have liquidity for that to mean anything: in a pool holding none,
/// with no reserves to price it against, every product here is zero and any
/// quantity of LQ satisfies the proportion equally.
pub fn deposit_redeem_ok(
  rx0: Int,
  ry0: Int,
  lq0: Int,
  dx: Int,
  dy: Int,
  dlq: Int,
) -> Bool {
  lq0 > 0 && dlq * rx0 <= dx * lq0 && dlq * ry0 <= dy * lq0
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

/// Presence of a withdrawal at `cred`. Every caller passes a script
/// credential, which is what gives this its force: a withdrawal at a script
/// runs that script, so the presence of one is evidence the script approved.
fn has_withdrawal(self: Transaction, cred: Credential) -> Bool {
  pairs.has_key(self.withdrawals, cred)
}

/// `royalty_withdraw_vh`: script hash of the royalty-withdraw validator, which
/// Splash hardcodes and Noctis parameterises. The credential whose withdrawal
/// authorises a royalty redirect is not a parameter: it is the second
/// `dao_policy` entry of the datum, written by the factory, so the pool's hash
/// does not depend on the redirect script's and the three venue scripts can
/// be applied in order — the pool, then the redirect script, then the factory.
validator pool(royalty_withdraw_vh: ByteArray) {
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

    // A count on its own admits a foreign asset whenever a named one leaves
    // entirely. Holding the successor to a real balance of each named asset is
    // what makes the count mean what it appears to: with both still present
    // and the total unchanged, there is no room for anything else. The NFT is
    // already found by search, and `pool_x` is ADA on every Noctis pool.
    let no_more_tokens = and {
      v_len(self_out.value) == v_len(successor.value),
      asset_quantity_of(successor.value, cfg.pool_y) > 0,
      asset_quantity_of(successor.value, cfg.pool_lq) > 0,
    }
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
      expect Some(Inline(Script(dao_vh))) = list.head(cfg.dao_policy)
      // The DAO script decides how much the platform takes. These are the
      // things no treasury action may do, held here so that a pool spent under
      // this action keeps its own shape whatever runs at that credential.
      let expected = SingleRoyaltyPoolConfig {
        ..cfg,
        treasury_x: succ_cfg.treasury_x,
        treasury_y: succ_cfg.treasury_y,
        treasury_fee: succ_cfg.treasury_fee,
      }
      and {
        has_withdrawal(self, Script(dao_vh)),
        expected == succ_cfg,
        dlq == 0,
        // Both states are read under the OLD datum, so a reserve delta is
        // exactly the value that moved. Requiring it to equal the counter's
        // own delta is what keeps a treasury action inside the treasury's
        // slot: the reserves and the creator's counters are not its to spend.
        dx == succ_cfg.treasury_x - cfg.treasury_x,
        dy == succ_cfg.treasury_y - cfg.treasury_y,
        succ_cfg.treasury_x >= 0,
        succ_cfg.treasury_y >= 0,
      }
    } else if redeemer.action == action_withdraw_royalty {
      has_withdrawal(self, Script(royalty_withdraw_vh))
    } else if redeemer.action == action_redirect_royalty {
      expect Some(Inline(Script(redirect_vh))) = list.at(cfg.dao_policy, 1)
      and {
        has_withdrawal(self, Script(redirect_vh)),
        redirect_config_ok(cfg, succ_cfg),
        successor.value == self_out.value,
      }
    } else if redeemer.action == action_deposit {
      and {
        succ_cfg == cfg,
        // A deposit adds liquidity and a redeem removes it. Each action states
        // its own direction, so a spend that moves no liquidity at all is
        // neither of them.
        dlq > 0,
        deposit_redeem_ok(
          s0.reserves_x,
          s0.reserves_y,
          s0.liquidity,
          dx,
          dy,
          dlq,
        ),
      }
    } else if redeemer.action == action_redeem {
      and {
        succ_cfg == cfg,
        dlq < 0,
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
      // The input being spent is the pool, not merely something parked at the
      // pool's address. Without this, a UTxO carrying a copy of a live pool's
      // datum resolves its successor to that live pool's own continuing output
      // — which is unchanged, so every rule below is satisfied by a transaction
      // that never touches the pool at all.
      asset_quantity_of(self_out.value, cfg.pool_nft) == 1,
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

/// A pool holding 100M a side of which 55M a side is earmarked as uncollected
/// fees, so the net reserves are 45M. The same value movement an undrifted
/// pool refuses must be refused here too: it takes from both sides and gives
/// nothing, which is not a swap however the reserves are netted.
test swap_taking_from_both_sides_on_a_drifted_pool_fails() {
  !swap_ok(
    45_000_000,
    45_000_000,
    -82_779_852,
    -99_999_999,
    fee_num_030,
    t_fee_010,
    r_fee_100,
  )
}

/// A trade with no input side at all takes without giving.
test swap_with_no_input_side_fails() {
  !swap_ok(100_000_000, 100_000_000, 0, 0, fee_num_030, t_fee_010, r_fee_100)
}

/// A move that adds to both sides has no output side, so it is not a swap.
test swap_adding_to_both_sides_fails() {
  !swap_ok(
    100_000_000,
    100_000_000,
    1_000_000,
    1_000_000,
    fee_num_030,
    t_fee_010,
    r_fee_100,
  )
}

/// A pool whose net reserve on the input side has reached zero cannot price a
/// trade: one unit would otherwise buy the whole of the other side.
test swap_from_an_empty_reserve_fails() {
  !swap_ok(0, 100_000_000, 1, -100_000_000, fee_num_030, t_fee_010, r_fee_100)
}

/// Nor can a pool whose net reserve has gone below zero.
test swap_from_a_negative_reserve_fails() {
  !swap_ok(100_000_000, -1, -100_000_000, 1, fee_num_030, t_fee_010, r_fee_100)
}

/// A schedule whose slices leave nothing has no price to quote, and the
/// comparison stops bounding the output by the reserve. Here a treasury slice
/// of 99,000 leaves the net numerator negative, and 150 of the Y side would
/// leave a pool holding only 100 of it.
test swap_on_an_inverted_schedule_fails() {
  !swap_ok(100, 100, 100_000, -150, fee_num_030, 99_000, r_fee_100)
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
    dao_policy: [Inline(Script(#"dd")), Inline(Script(#"0c"))],
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
    Some(sample_cfg()),
    PoolRedeemer { action: action_swap, self_ix: 0 },
    own_ref(),
    swap_tx(swapped_cfg(), 976_372),
  )
}

test tx_swap_one_past_the_bound_fails() fail {
  pool.spend(
    #"0b",
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
    Some(sample_cfg()),
    PoolRedeemer { action: action_swap, self_ix: 0 },
    own_ref(),
    swap_tx(next, 976_372),
  )
}

/// A UTxO parked at the pool's address carrying a copy of the live pool's
/// datum, and a junk asset where the NFT would be so the asset counts still
/// match. Its successor resolves to the LIVE pool's continuing output, so the
/// spend reads as a redeem of the difference between the two — which the redeem
/// arm accepts in full, since burning liquidity while taking no reserves is
/// only a gift to the pool. The missing NFT is the single delta, and the only
/// thing that says this is not a pool.
test tx_spending_a_look_alike_at_the_pool_address_fails() fail {
  let cfg = sample_cfg()
  let stray_ref = OutputReference { transaction_id: #"07", output_index: 0 }
  let stray_value = assets.from_lovelace(100_000_000)
    |> assets.add(cfg.pool_y.policy, cfg.pool_y.name, 100_000_000)
    |> assets.add(cfg.pool_lq.policy, cfg.pool_lq.name, max_lq_cap - 51_000_000)
    |> assets.add(#"99", #"6a756e6b", 1)
  let stray = Input {
    output_reference: stray_ref,
    output: Output {
      address: pool_address(),
      value: stray_value,
      datum: InlineDatum(cfg),
      reference_script: None,
    },
  }
  let live = Output {
    address: pool_address(),
    value: pool_value(cfg, 100_000_000, 100_000_000, 50_000_000),
    datum: InlineDatum(cfg),
    reference_script: None,
  }
  pool.spend(
    #"0b",
    Some(cfg),
    PoolRedeemer { action: action_redeem, self_ix: 0 },
    stray_ref,
    Transaction { ..transaction.placeholder, inputs: [stray], outputs: [live] },
  )
}

/// A pool with something in both treasury slots, so a withdrawal has
/// something to take.
fn dao_cfg() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    treasury_x: 5_000_000,
    treasury_y: 700,
  }
}

fn dao_tx(next: SingleRoyaltyPoolConfig, x: Int, y: Int, lq: Int) -> Transaction {
  let prev = dao_cfg()
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
    value: pool_value(prev, x, y, lq),
    datum: InlineDatum(next),
    reference_script: None,
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_in],
    outputs: [pool_out],
    withdrawals: [Pair(Script(#"dd"), 0)],
  }
}

fn run_dao(next: SingleRoyaltyPoolConfig, x: Int, y: Int, lq: Int) -> Bool {
  pool.spend(
    #"0b",
    Some(dao_cfg()),
    PoolRedeemer { action: action_dao, self_ix: 0 },
    own_ref(),
    dao_tx(next, x, y, lq),
  )
}

/// Both slots emptied: the pool's holdings fall by exactly what the counters
/// give up.
fn dao_drained() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig { ..dao_cfg(), treasury_x: 0, treasury_y: 0 }
}

test tx_dao_withdrawal_of_the_treasury_passes() {
  run_dao(dao_drained(), 95_000_000, 99_999_300, 50_000_000)
}

test tx_dao_without_the_withdrawal_fails() fail {
  let t = dao_tx(dao_drained(), 95_000_000, 99_999_300, 50_000_000)
  pool.spend(
    #"0b",
    Some(dao_cfg()),
    PoolRedeemer { action: action_dao, self_ix: 0 },
    own_ref(),
    Transaction { ..t, withdrawals: [Pair(Script(#"0d"), 0)] },
  )
}

/// Ten ADA leaves while the counter gives up five, so the difference comes out
/// of the reserves the traders own.
test tx_dao_that_drains_the_reserves_fails() fail {
  run_dao(dao_drained(), 90_000_000, 99_999_300, 50_000_000)
}

test tx_dao_that_drains_the_token_reserve_fails() fail {
  run_dao(dao_drained(), 95_000_000, 99_998_600, 50_000_000)
}

/// The counter and the holding fall together, so the arithmetic is consistent
/// — but the counter ends below zero, which means the pool paid out more than
/// the platform had ever accrued.
test tx_dao_that_drives_a_counter_below_zero_fails() fail {
  let over = SingleRoyaltyPoolConfig {
    ..dao_cfg(),
    treasury_x: -1_000_000,
    treasury_y: 0,
  }
  run_dao(over, 94_000_000, 99_999_300, 50_000_000)
}

/// The same on the token side, which has its own counter and its own floor.
test tx_dao_that_drives_the_token_counter_below_zero_fails() fail {
  let over = SingleRoyaltyPoolConfig {
    ..dao_cfg(),
    treasury_x: 0,
    treasury_y: -300,
  }
  run_dao(over, 95_000_000, 99_999_000, 50_000_000)
}

/// The nonce is what the creator's royalty signature is bound to, so a
/// treasury action that moved it would cancel a claim already signed. The
/// redirect arm still bumps it, and must: a replaced key's old signatures have
/// to die with it.
test tx_dao_that_bumps_the_nonce_fails() fail {
  let bumped = SingleRoyaltyPoolConfig {
    ..dao_drained(),
    nonce: dao_cfg().nonce + 1,
  }
  run_dao(bumped, 95_000_000, 99_999_300, 50_000_000)
}

test tx_dao_that_moves_liquidity_fails() fail {
  run_dao(dao_drained(), 95_000_000, 99_999_300, 50_000_001)
}

/// Splash's DAO action deliberately cannot reach the royalty key, and neither
/// can this one.
test tx_dao_that_rewrites_the_royalty_key_fails() fail {
  let hijack = SingleRoyaltyPoolConfig {
    ..dao_drained(),
    royalty_pub_key: #"01",
  }
  run_dao(hijack, 95_000_000, 99_999_300, 50_000_000)
}

fn redirect_tx(next: SingleRoyaltyPoolConfig, cred: Credential) -> Transaction {
  redirect_tx_from(sample_cfg(), next, cred)
}

fn redirect_tx_from(
  prev: SingleRoyaltyPoolConfig,
  next: SingleRoyaltyPoolConfig,
  cred: Credential,
) -> Transaction {
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
    Some(sample_cfg()),
    PoolRedeemer { action: action_swap, self_ix: 0 },
    own_ref(),
    redirect_tx(next, Script(#"0c")),
  )
}

/// Only the datum differs from the passing redirect: it carries a single
/// `dao_policy` entry, so there is no governance credential to look for.
test tx_redirect_on_a_pool_without_a_governance_entry_fails() fail {
  let prev = SingleRoyaltyPoolConfig {
    ..sample_cfg(),
    dao_policy: [Inline(Script(#"dd"))],
  }
  let next = SingleRoyaltyPoolConfig {
    ..prev,
    royalty_pub_key: #"01",
    nonce: 1,
  }
  pool.spend(
    #"0b",
    Some(prev),
    PoolRedeemer { action: action_redirect_royalty, self_ix: 0 },
    own_ref(),
    redirect_tx_from(prev, next, Script(#"0c")),
  )
}

// ---------------------------------------------------------------------------
// Liquidity has a direction, and a pool keeps its own two assets.
// ---------------------------------------------------------------------------

/// An emptied pool: no reserves, and no liquidity to price against them. Every
/// product in the proportion is zero, so on the proportion alone any quantity
/// of LQ is as well-founded as any other.
test minting_liquidity_from_an_empty_pool_fails() {
  !deposit_redeem_ok(0, 0, 0, 0, 0, 1_000_000)
}

/// One pool spend, stated as gross holdings on each side. Reserves and
/// liquidity are the only things that move.
fn liquidity_tx(
  x_in: Int,
  y_in: Int,
  lq_in: Int,
  x_out: Int,
  y_out: Int,
  lq_out: Int,
) -> Transaction {
  let cfg = sample_cfg()
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: own_ref(),
        output: Output {
          address: pool_address(),
          value: pool_value(cfg, x_in, y_in, lq_in),
          datum: InlineDatum(cfg),
          reference_script: None,
        },
      },
    ],
    outputs: [
      Output {
        address: pool_address(),
        value: pool_value(cfg, x_out, y_out, lq_out),
        datum: InlineDatum(cfg),
        reference_script: None,
      },
    ],
  }
}

fn run_pool(action: Int, t: Transaction) -> Bool {
  pool.spend(
    #"0b",
    Some(sample_cfg()),
    PoolRedeemer { action, self_ix: 0 },
    own_ref(),
    t,
  )
}

/// 2% more of each reserve for 2% more liquidity, exactly at the bound.
test tx_deposit_at_the_bound_passes() {
  run_pool(
    action_deposit,
    liquidity_tx(
      100_000_000,
      100_000_000,
      50_000_000,
      102_000_000,
      102_000_000,
      51_000_000,
    ),
  )
}

/// And the same in reverse.
test tx_redeem_at_the_bound_passes() {
  run_pool(
    action_redeem,
    liquidity_tx(
      100_000_000,
      100_000_000,
      50_000_000,
      98_000_000,
      98_000_000,
      49_000_000,
    ),
  )
}

/// A spend that moves no liquidity at all, offered as a deposit. The
/// proportion is satisfied by every delta being zero, so the direction is the
/// only thing it fails.
test tx_deposit_that_moves_no_liquidity_fails() fail {
  run_pool(
    action_deposit,
    liquidity_tx(
      100_000_000,
      100_000_000,
      50_000_000,
      100_000_000,
      100_000_000,
      50_000_000,
    ),
  )
}

/// The redeem above, presented under the deposit action. It is a valid redeem,
/// which is the point: the proportion cannot tell the two apart.
test tx_redeem_presented_as_a_deposit_fails() fail {
  run_pool(
    action_deposit,
    liquidity_tx(
      100_000_000,
      100_000_000,
      50_000_000,
      98_000_000,
      98_000_000,
      49_000_000,
    ),
  )
}

/// And the deposit under the redeem action.
test tx_deposit_presented_as_a_redeem_fails() fail {
  run_pool(
    action_redeem,
    liquidity_tx(
      100_000_000,
      100_000_000,
      50_000_000,
      102_000_000,
      102_000_000,
      51_000_000,
    ),
  )
}

/// A successor holding a foreign token where the pool's own should be, so the
/// asset count is unchanged. Dressed as a redeem of the whole token side: the
/// proportion accepts it, since burning all the liquidity for all of one
/// reserve is exactly at the bound, and every other rule is met. Whether the
/// pool still holds its own token is the single thing left to decide it.
test tx_successor_holding_a_foreign_token_in_place_of_the_pools_fails() fail {
  let cfg = sample_cfg()
  let successor = Output {
    address: pool_address(),
    value: assets.from_lovelace(100_000_000)
      |> assets.add(#"99", #"666f726569676e", 100_000_000)
      |> assets.add(cfg.pool_lq.policy, cfg.pool_lq.name, max_lq_cap)
      |> assets.add(cfg.pool_nft.policy, cfg.pool_nft.name, 1),
    datum: InlineDatum(cfg),
    reference_script: None,
  }
  pool.spend(
    #"0b",
    Some(cfg),
    PoolRedeemer { action: action_redeem, self_ix: 0 },
    own_ref(),
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: own_ref(),
          output: Output {
            address: pool_address(),
            value: pool_value(cfg, 100_000_000, 100_000_000, 50_000_000),
            datum: InlineDatum(cfg),
            reference_script: None,
          },
        },
      ],
      outputs: [successor],
    },
  )
}

/// The same shape on the LQ token: a successor holding none of it reads as a
/// pool that has minted every unit of liquidity there is, with a foreign token
/// keeping the count. The reserves are grown far enough that the proportion
/// itself is satisfied.
test tx_successor_holding_no_lq_token_fails() fail {
  let cfg = sample_cfg()
  let minted = max_lq_cap - 50_000_000
  let grown = 100_000_000 + 2 * minted
  let successor = Output {
    address: pool_address(),
    value: assets.from_lovelace(grown)
      |> assets.add(cfg.pool_y.policy, cfg.pool_y.name, grown)
      |> assets.add(#"99", #"666f726569676e", 1)
      |> assets.add(cfg.pool_nft.policy, cfg.pool_nft.name, 1),
    datum: InlineDatum(cfg),
    reference_script: None,
  }
  pool.spend(
    #"0b",
    Some(cfg),
    PoolRedeemer { action: action_deposit, self_ix: 0 },
    own_ref(),
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: own_ref(),
          output: Output {
            address: pool_address(),
            value: pool_value(cfg, 100_000_000, 100_000_000, 50_000_000),
            datum: InlineDatum(cfg),
            reference_script: None,
          },
        },
      ],
      outputs: [successor],
    },
  )
}


fn key_cred() -> Credential {
  VerificationKey(#"c0")
}

fn dao_tx_shaped(
  prev: SingleRoyaltyPoolConfig,
  next: SingleRoyaltyPoolConfig,
  x: Int,
  y: Int,
  lq: Int,
  cred: Credential,
) -> Transaction {
  let pool_in =
    Input {
      output_reference: own_ref(),
      output: Output {
        address: pool_address(),
        value: pool_value(prev, 100_000_000, 100_000_000, 50_000_000),
        datum: InlineDatum(prev),
        reference_script: None,
      },
    }
  let pool_out =
    Output {
      address: pool_address(),
      value: pool_value(prev, x, y, lq),
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

/// The shaper reproduces the passing DAO transition, so the two rejections
/// below differ from a valid one by the credential alone.
test dao_through_the_shaper_passes() {
  let prev = dao_cfg()
  let next = SingleRoyaltyPoolConfig { ..prev, treasury_x: 0, treasury_y: 0 }
  pool.spend(
    #"0b",
    Some(prev),
    PoolRedeemer { action: action_dao, self_ix: 0 },
    own_ref(),
    dao_tx_shaped(prev, next, 95_000_000, 99_999_300, 50_000_000, Script(#"dd")),
  )
}

/// A withdrawal at a payment key runs no script, so it is no evidence that
/// anything approved the transition. Both delegating arms require the script
/// form of the credential they read.
test dao_authorised_by_a_payment_key_withdrawal_fails() fail {
  let prev =
    SingleRoyaltyPoolConfig {
      ..dao_cfg(),
      dao_policy: [Inline(key_cred()), Inline(Script(#"0c"))],
    }
  let next = SingleRoyaltyPoolConfig { ..prev, treasury_x: 0, treasury_y: 0 }
  pool.spend(
    #"0b",
    Some(prev),
    PoolRedeemer { action: action_dao, self_ix: 0 },
    own_ref(),
    dao_tx_shaped(prev, next, 95_000_000, 99_999_300, 50_000_000, key_cred()),
  )
}

test redirect_authorised_by_a_payment_key_withdrawal_fails() fail {
  let prev =
    SingleRoyaltyPoolConfig {
      ..sample_cfg(),
      dao_policy: [Inline(Script(#"dd")), Inline(key_cred())],
    }
  let next =
    SingleRoyaltyPoolConfig { ..prev, royalty_pub_key: #"01", nonce: 1 }
  pool.spend(
    #"0b",
    Some(prev),
    PoolRedeemer { action: action_redirect_royalty, self_ix: 0 },
    own_ref(),
    redirect_tx_from(prev, next, key_cred()),
  )
}
