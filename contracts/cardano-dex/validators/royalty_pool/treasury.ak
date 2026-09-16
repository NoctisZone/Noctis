//// NoctisSwap: the platform's fee slot. (c) Noctis Zone, Apache-2.0.
////
//// Splash moves its treasury through a Plutarch DAO action under a multisig.
//// Noctis's platform slice goes to one wallet, so this is a smaller script that
//// the pool's action 3 defers to: the pool requires a withdrawal from the first
//// `dao_policy` credential, and that credential is this script.
////
//// The pool this acts on is the input at `pool_in_ix`, and it must sit at the
//// pool validator's own address, holding the NFT its datum names, with exactly
//// one input at that address in the whole transaction. So a withdrawal from
//// this script speaks for one real pool and no other.
////
//// Two actions, both authorised by `authority` (a key: its signature; a
//// script: its withdrawal), and neither touching the pool nonce. That nonce is
//// replay protection for the creator's signed royalty claim, whose signature
//// covers it: a treasury action consumes no such signature, so it has nothing
//// to replay-guard, and moving it would only cancel a claim the creator had
//// already signed. Both actions change nothing else in the datum:
////
////   Withdraw — the treasury counters go down by exactly what leaves the pool
////     value, never below zero; an output at the key `treasury_address` names
////     receives it — exactly, except on the ADA side, where the payout may
////     carry more than the pool paid so that a token-only withdrawal can meet
////     its own minimum out of the platform's inputs; liquidity, the token
////     count and any token-to-token lovelace are unchanged.
////   SetTreasuryFee — `treasury_fee` becomes `new_fee`, which must differ from
////     the current one, sit within `[0, max_treasury_fee]`, and leave the pool
////     fee something to work with: `new_fee + royalty_fee < fee_num`, read from
////     the pool's own datum. The deployed ceiling is one flat number shared by
////     every pool and knows nothing of a given pool's schedule, so the datum is
////     the second and tighter bound. The pool value is unchanged. This is the
////     "DAO-adjustable within a published band" of the fee decision.

use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{ScriptHash}
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use noctisswap/pool_state.{is_ada, lovelace_t2t}
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of, v_len}

pub type TreasuryAction {
  Withdraw { pool_in_ix: Int, treasury_out_ix: Int }
  SetTreasuryFee { pool_in_ix: Int, new_fee: Int }
}

fn authorised(self: Transaction, authority: Credential) -> Bool {
  when authority is {
    VerificationKey(h) -> list.has(self.extra_signatories, h)
    Script(_) -> pairs.has_key(self.withdrawals, authority)
  }
}

validator treasury(
  authority: Credential,
  max_treasury_fee: Int,
  pool_vh: ScriptHash,
) {
  withdraw(redeemer: TreasuryAction, _account: Credential, self: Transaction) {
    let pool_in_ix = when redeemer is {
      Withdraw { pool_in_ix, .. } -> pool_in_ix
      SetTreasuryFee { pool_in_ix, .. } -> pool_in_ix
    }
    expect Some(pool_in) = list.at(self.inputs, pool_in_ix)
    let pool_out_in = pool_in.output
    expect InlineDatum(prev_raw) = pool_out_in.datum
    expect prev: SingleRoyaltyPoolConfig = prev_raw
    expect Some(successor) = list.find(
      self.outputs,
      fn(o) { asset_quantity_of(o.value, prev.pool_nft) == 1 },
    )
    expect InlineDatum(next_raw) = successor.datum
    expect next: SingleRoyaltyPoolConfig = next_raw

    let shape_ok = and {
      // The input this names is a pool: it lives at the pool validator, and it
      // really holds the NFT its own datum claims. Without the address, any
      // UTxO carrying a token of the caller's own minting would answer.
      pool_out_in.address.payment_credential == Script(pool_vh),
      // And it is the only pool here, so one withdrawal cannot speak for a
      // second pool that this script never looked at.
      list.count(
        self.inputs,
        fn(i) { i.output.address.payment_credential == Script(pool_vh) },
      ) == 1,
      asset_quantity_of(pool_out_in.value, prev.pool_nft) == 1,
      successor.address == pool_out_in.address,
      v_len(successor.value) == v_len(pool_out_in.value),
      lovelace_t2t(prev, successor.value) == lovelace_t2t(
        prev,
        pool_out_in.value,
      ),
      asset_quantity_of(successor.value, prev.pool_lq) == asset_quantity_of(
        pool_out_in.value,
        prev.pool_lq,
      ),
    }

    let action_ok = when redeemer is {
      Withdraw { treasury_out_ix, .. } -> {
        let dx = next.treasury_x - prev.treasury_x
        let dy = next.treasury_y - prev.treasury_y
        let expected = SingleRoyaltyPoolConfig {
          ..prev,
          treasury_x: next.treasury_x,
          treasury_y: next.treasury_y,
        }
        expect Some(t_out) = list.at(self.outputs, treasury_out_ix)
        // The payout's ADA side is a floor, not an exact figure. A withdrawal
        // that draws only the token side moves no ADA out of the pool, but its
        // output still needs the minimum ADA to exist at all, and that comes
        // from the platform's own inputs. The pool's own delta is exact either
        // way, just above, so whatever exceeds the delta here came from the
        // platform rather than the pool. The other side stays exact: nothing
        // makes a token surplus necessary.
        let paid_ok = fn(asset: Asset, delta: Int) -> Bool {
          let paid = asset_quantity_of(t_out.value, asset)
          if is_ada(asset) {
            paid >= -delta
          } else {
            paid == -delta
          }
        }
        and {
          expected == next,
          next.treasury_x >= 0,
          next.treasury_y >= 0,
          dx <= 0,
          dy <= 0,
          dx < 0 || dy < 0,
          asset_quantity_of(successor.value, prev.pool_x) - asset_quantity_of(
            pool_out_in.value,
            prev.pool_x,
          ) == dx,
          asset_quantity_of(successor.value, prev.pool_y) - asset_quantity_of(
            pool_out_in.value,
            prev.pool_y,
          ) == dy,
          t_out.address.payment_credential == VerificationKey(
            prev.treasury_address,
          ),
          paid_ok(prev.pool_x, dx),
          paid_ok(prev.pool_y, dy),
        }
      }
      SetTreasuryFee { new_fee, .. } -> {
        let expected = SingleRoyaltyPoolConfig { ..prev, treasury_fee: new_fee }
        and {
          new_fee >= 0,
          new_fee <= max_treasury_fee,
          // The schedule must still leave the pool a fee to price against.
          // Read from the datum, because the deployed ceiling is one number
          // shared by every pool and knows nothing of this pool's numerators.
          new_fee + prev.royalty_fee < prev.fee_num,
          // A fee set that changes no fee is not an administrative act.
          new_fee != prev.treasury_fee,
          expected == next,
          successor.value == pool_out_in.value,
        }
      }
    }

    and {
      authorised(self, authority),
      shape_ok,
      action_ok,
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const platform_key: ByteArray = #"ee"

fn cfg() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: Asset { policy: #"aa", name: #"6e6674" },
    pool_x: Asset { policy: ada_policy_id, name: ada_asset_name },
    pool_y: Asset { policy: #"bb", name: #"746f6b656e" },
    pool_lq: Asset { policy: #"cc", name: #"6c71" },
    fee_num: 99_700,
    treasury_fee: 100,
    royalty_fee: 1_000,
    treasury_x: 5_000_000,
    treasury_y: 700,
    royalty_x: 0,
    royalty_y: 0,
    dao_policy: [],
    treasury_address: platform_key,
    royalty_pub_key: #"ff",
    nonce: 9,
  }
}

/// A pool-shaped value whose NFT sits under `policy`, so a test can build one
/// the factory never minted.
fn value_with_nft(policy: PolicyId, x: Int, y: Int) -> Value {
  assets.from_lovelace(x)
    |> assets.add(#"bb", #"746f6b656e", y)
    |> assets.add(#"cc", #"6c71", 1_000)
    |> assets.add(policy, #"6e6674", 1)
}

fn pool_value(x: Int, y: Int) -> Value {
  value_with_nft(#"aa", x, y)
}

fn pool_address() -> Address {
  Address { payment_credential: Script(#"0a"), stake_credential: None }
}

fn pool_input(c: SingleRoyaltyPoolConfig, x: Int, y: Int) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"01", output_index: 0 },
    output: Output {
      address: pool_address(),
      value: pool_value(x, y),
      datum: InlineDatum(c),
      reference_script: None,
    },
  }
}

fn pool_output(c: SingleRoyaltyPoolConfig, x: Int, y: Int) -> Output {
  Output {
    address: pool_address(),
    value: pool_value(x, y),
    datum: InlineDatum(c),
    reference_script: None,
  }
}

fn payout_at(c: Credential, x: Int, y: Int) -> Output {
  Output {
    address: Address { payment_credential: c, stake_credential: None },
    value: assets.from_lovelace(x) |> assets.add(#"bb", #"746f6b656e", y),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

fn payout(to: ByteArray, x: Int, y: Int) -> Output {
  payout_at(VerificationKey(to), x, y)
}

fn signed_by(tx: Transaction, key: ByteArray) -> Transaction {
  Transaction { ..tx, extra_signatories: [key] }
}

/// Withdraw the whole ADA treasury (5 ADA) and 700 of the token.
fn withdraw_tx_shaped(
  next: SingleRoyaltyPoolConfig,
  pool_x: Int,
  pool_y: Int,
  out: Output,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_input(cfg(), 100_000_000, 100_000_000)],
    outputs: [pool_output(next, pool_x, pool_y), out],
  }
}

fn withdraw_tx(
  next: SingleRoyaltyPoolConfig,
  to: ByteArray,
  x_paid: Int,
  y_paid: Int,
) -> Transaction {
  withdraw_tx_shaped(
    next,
    100_000_000 - 5_000_000,
    100_000_000 - 700,
    payout(to, x_paid, y_paid),
  )
}

fn drained() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig { ..cfg(), treasury_x: 0, treasury_y: 0 }
}

fn withdraw() -> TreasuryAction {
  Withdraw { pool_in_ix: 0, treasury_out_ix: 1 }
}

test withdraw_to_the_platform_wallet_passes() {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(
      withdraw_tx(drained(), platform_key, 5_000_000, 700),
      platform_key,
    ),
  )
}

test withdraw_without_authority_fails() fail {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    withdraw_tx(drained(), platform_key, 5_000_000, 700),
  )
}

test withdraw_to_another_wallet_fails() fail {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(withdraw_tx(drained(), #"0d", 5_000_000, 700), platform_key),
  )
}

test withdraw_that_pays_less_than_it_takes_fails() fail {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(
      withdraw_tx(drained(), platform_key, 4_999_999, 700),
      platform_key,
    ),
  )
}

test withdraw_below_zero_fails() fail {
  let over = SingleRoyaltyPoolConfig { ..cfg(), treasury_x: -1, treasury_y: 0 }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_input(cfg(), 100_000_000, 100_000_000)],
    outputs: [
      pool_output(over, 100_000_000 - 5_000_001, 100_000_000 - 700),
      payout(platform_key, 5_000_001, 700),
    ],
  }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(tx, platform_key),
  )
}

/// The nonce belongs to the creator's signed claim, not to the platform's
/// housekeeping: moving it here would cancel a claim already signed, for the
/// price of a transaction fee.
test withdraw_that_bumps_the_nonce_fails() fail {
  let bumped = SingleRoyaltyPoolConfig { ..drained(), nonce: cfg().nonce + 1 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(withdraw_tx(bumped, platform_key, 5_000_000, 700), platform_key),
  )
}

test withdraw_that_also_touches_the_royalty_counter_fails() fail {
  let bad = SingleRoyaltyPoolConfig { ..drained(), royalty_x: 1 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(withdraw_tx(bad, platform_key, 5_000_000, 700), platform_key),
  )
}

/// The attack the address pin refuses. The redeemer names an ordinary UTxO at
/// the attacker's own key address, carrying a datum they wrote and a token they
/// minted that the datum calls its pool NFT, and naming themselves as the
/// treasury address. A genuine pool sits at the pool script, so the one-pool
/// count is satisfied and the address is the single delta.
///
/// Every rule the script applies to that input holds against the attacker's own
/// pair: the NFT is in its value, its successor is found by that NFT, the
/// counters fall by what the payout receives. Only the address says no.
test withdraw_from_a_pool_at_a_key_address_fails() fail {
  let attacker = #"a7"
  let their_address = Address {
    payment_credential: VerificationKey(attacker),
    stake_credential: None,
  }
  let theirs = SingleRoyaltyPoolConfig {
    ..cfg(),
    pool_nft: Asset { policy: #"a9", name: #"6e6674" },
    treasury_address: attacker,
  }
  let theirs_drained = SingleRoyaltyPoolConfig {
    ..theirs,
    treasury_x: 0,
    treasury_y: 0,
  }
  let decoy = Input {
    output_reference: OutputReference { transaction_id: #"03", output_index: 0 },
    output: Output {
      address: their_address,
      value: value_with_nft(#"a9", 100_000_000, 100_000_000),
      datum: InlineDatum(theirs),
      reference_script: None,
    },
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [decoy, pool_input(cfg(), 100_000_000, 100_000_000)],
    outputs: [
      Output {
        address: their_address,
        value: value_with_nft(#"a9", 100_000_000 - 5_000_000, 100_000_000 - 700),
        datum: InlineDatum(theirs_drained),
        reference_script: None,
      },
      payout(attacker, 5_000_000, 700),
    ],
  }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(tx, platform_key),
  )
}

/// A second pool at the pool script, which this withdrawal never validates.
/// Everything about the first pool is exactly the passing case.
test withdraw_with_two_pools_in_one_transaction_fails() fail {
  let second = Input {
    ..pool_input(cfg(), 100_000_000, 100_000_000),
    output_reference: OutputReference { transaction_id: #"02", output_index: 0 },
  }
  let base = withdraw_tx(drained(), platform_key, 5_000_000, 700)
  let tx = Transaction {
    ..base,
    inputs: [pool_input(cfg(), 100_000_000, 100_000_000), second],
  }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(tx, platform_key),
  )
}

fn set_fee_tx(next: SingleRoyaltyPoolConfig) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_input(cfg(), 100_000_000, 100_000_000)],
    outputs: [pool_output(next, 100_000_000, 100_000_000)],
  }
}

test set_fee_within_the_band_passes() {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 300 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    SetTreasuryFee { pool_in_ix: 0, new_fee: 300 },
    Script(#"0c"),
    signed_by(set_fee_tx(next), platform_key),
  )
}

test set_fee_above_the_band_fails() fail {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 501 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    SetTreasuryFee { pool_in_ix: 0, new_fee: 501 },
    Script(#"0c"),
    signed_by(set_fee_tx(next), platform_key),
  )
}

test set_fee_that_moves_value_fails() fail {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 300 }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_input(cfg(), 100_000_000, 100_000_000)],
    outputs: [pool_output(next, 99_000_000, 100_000_000)],
  }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    SetTreasuryFee { pool_in_ix: 0, new_fee: 300 },
    Script(#"0c"),
    signed_by(tx, platform_key),
  )
}

/// The deployed ceiling is set above the schedule on purpose here, so only the
/// datum's own numerators can decide. One below the bound.
test set_fee_just_inside_the_schedule_passes() {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 98_699 }
  treasury.withdraw(
    VerificationKey(platform_key),
    99_000,
    #"0a",
    SetTreasuryFee { pool_in_ix: 0, new_fee: 98_699 },
    Script(#"0c"),
    signed_by(set_fee_tx(next), platform_key),
  )
}

/// One further and the schedule leaves the pool nothing to price a swap
/// against. Inside the deployed ceiling, so the datum band is the only thing
/// that refuses it.
test set_fee_that_leaves_the_pool_no_fee_fails() fail {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 98_700 }
  treasury.withdraw(
    VerificationKey(platform_key),
    99_000,
    #"0a",
    SetTreasuryFee { pool_in_ix: 0, new_fee: 98_700 },
    Script(#"0c"),
    signed_by(set_fee_tx(next), platform_key),
  )
}

/// Setting the fee to what it already is satisfied every other rule.
test set_fee_to_its_current_value_fails() fail {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 100 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    SetTreasuryFee { pool_in_ix: 0, new_fee: 100 },
    Script(#"0c"),
    signed_by(set_fee_tx(next), platform_key),
  )
}

test set_fee_by_a_script_authority_needs_its_withdrawal() {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 300 }
  let tx = Transaction {
    ..set_fee_tx(next),
    withdrawals: [Pair(Script(#"0e"), 0)],
  }
  treasury.withdraw(
    Script(#"0e"),
    500,
    #"0a",
    SetTreasuryFee { pool_in_ix: 0, new_fee: 300 },
    Script(#"0c"),
    tx,
  )
}

/// A script whose hash is the platform's key hash. A payout address is a
/// credential, not a bare hash, and the two are different addresses however
/// the bytes compare.
test withdraw_to_a_script_sharing_the_platform_key_hash_fails() fail {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(
      withdraw_tx_shaped(
        drained(),
        100_000_000 - 5_000_000,
        100_000_000 - 700,
        payout_at(Script(platform_key), 5_000_000, 700),
      ),
      platform_key,
    ),
  )
}

/// Only the token counter moves, so the pool pays no ADA at all — and the
/// payout still needs its own minimum to exist as a UTxO. The pool's ADA side
/// is untouched here, which is what makes the surplus provably the platform's
/// rather than the pool's.
test token_only_withdrawal_carrying_its_own_minimum_ada_passes() {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(
      withdraw_tx_shaped(
        SingleRoyaltyPoolConfig { ..cfg(), treasury_y: 0 },
        100_000_000,
        100_000_000 - 700,
        payout(platform_key, 2_000_000, 700),
      ),
      platform_key,
    ),
  )
}

/// The token side is exact, so a payout one token short of the counter it
/// settles is refused — the ADA side's floor is not a general licence.
test withdraw_short_on_the_token_side_fails() fail {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(
      withdraw_tx(drained(), platform_key, 5_000_000, 699),
      platform_key,
    ),
  )
}

/// And a token surplus is refused too: nothing makes one necessary.
test withdraw_paying_more_tokens_than_it_takes_fails() fail {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    #"0a",
    withdraw(),
    Script(#"0c"),
    signed_by(
      withdraw_tx(drained(), platform_key, 5_000_000, 701),
      platform_key,
    ),
  )
}
