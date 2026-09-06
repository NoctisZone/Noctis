//// NoctisSwap: the platform's fee slot. (c) Noctis Zone, Apache-2.0.
////
//// Splash moves its treasury through a Plutarch DAO action under a multisig.
//// Noctis's platform slice goes to one wallet, so this is a smaller script that
//// the pool's action 3 defers to: the pool requires a withdrawal from the first
//// `dao_policy` credential, and that credential is this script.
////
//// Two actions, both authorised by `authority` (a key: its signature; a
//// script: its withdrawal), both bumping the pool nonce and changing nothing
//// else in the datum:
////
////   Withdraw — the treasury counters go down by exactly what leaves the pool
////     value, never below zero; an output at `treasury_address` receives
////     exactly that; liquidity, the token count and any token-to-token lovelace
////     are unchanged.
////   SetTreasuryFee — `treasury_fee` becomes `new_fee`, within
////     `[0, max_treasury_fee]`; the pool value is unchanged. This is the
////     "DAO-adjustable within a published band" of the fee decision.

use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use noctisswap/pool_state.{lovelace_t2t}
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

fn credential_hash(cred: Credential) -> ByteArray {
  when cred is {
    VerificationKey(h) -> h
    Script(h) -> h
  }
}

validator treasury(authority: Credential, max_treasury_fee: Int) {
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
          nonce: prev.nonce + 1,
        }
        expect Some(t_out) = list.at(self.outputs, treasury_out_ix)
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
          credential_hash(t_out.address.payment_credential) == prev.treasury_address,
          asset_quantity_of(t_out.value, prev.pool_x) == -dx,
          asset_quantity_of(t_out.value, prev.pool_y) == -dy,
        }
      }
      SetTreasuryFee { new_fee, .. } -> {
        let expected = SingleRoyaltyPoolConfig {
          ..prev,
          treasury_fee: new_fee,
          nonce: prev.nonce + 1,
        }
        and {
          new_fee >= 0,
          new_fee <= max_treasury_fee,
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

fn pool_value(x: Int, y: Int) -> Value {
  assets.from_lovelace(x)
    |> assets.add(#"bb", #"746f6b656e", y)
    |> assets.add(#"cc", #"6c71", 1_000)
    |> assets.add(#"aa", #"6e6674", 1)
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

fn payout(to: ByteArray, x: Int, y: Int) -> Output {
  Output {
    address: Address {
      payment_credential: VerificationKey(to),
      stake_credential: None,
    },
    value: assets.from_lovelace(x) |> assets.add(#"bb", #"746f6b656e", y),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

fn signed_by(tx: Transaction, key: ByteArray) -> Transaction {
  Transaction { ..tx, extra_signatories: [key] }
}

/// Withdraw the whole ADA treasury (5 ADA) and 700 of the token.
fn withdraw_tx(
  next: SingleRoyaltyPoolConfig,
  to: ByteArray,
  x_paid: Int,
  y_paid: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_input(cfg(), 100_000_000, 100_000_000)],
    outputs: [
      pool_output(next, 100_000_000 - 5_000_000, 100_000_000 - 700),
      payout(to, x_paid, y_paid),
    ],
  }
}

fn drained() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig { ..cfg(), treasury_x: 0, treasury_y: 0, nonce: 10 }
}

fn withdraw() -> TreasuryAction {
  Withdraw { pool_in_ix: 0, treasury_out_ix: 1 }
}

test withdraw_to_the_platform_wallet_passes() {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
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
    withdraw(),
    Script(#"0c"),
    withdraw_tx(drained(), platform_key, 5_000_000, 700),
  )
}

test withdraw_to_another_wallet_fails() fail {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    withdraw(),
    Script(#"0c"),
    signed_by(withdraw_tx(drained(), #"0d", 5_000_000, 700), platform_key),
  )
}

test withdraw_that_pays_less_than_it_takes_fails() fail {
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    withdraw(),
    Script(#"0c"),
    signed_by(
      withdraw_tx(drained(), platform_key, 4_999_999, 700),
      platform_key,
    ),
  )
}

test withdraw_below_zero_fails() fail {
  let over = SingleRoyaltyPoolConfig {
    ..cfg(),
    treasury_x: -1,
    treasury_y: 0,
    nonce: 10,
  }
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
    withdraw(),
    Script(#"0c"),
    signed_by(tx, platform_key),
  )
}

test withdraw_without_the_nonce_bump_fails() fail {
  let stale = SingleRoyaltyPoolConfig { ..cfg(), treasury_x: 0, treasury_y: 0 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    withdraw(),
    Script(#"0c"),
    signed_by(withdraw_tx(stale, platform_key, 5_000_000, 700), platform_key),
  )
}

test withdraw_that_also_touches_the_royalty_counter_fails() fail {
  let bad = SingleRoyaltyPoolConfig { ..drained(), royalty_x: 1 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    withdraw(),
    Script(#"0c"),
    signed_by(withdraw_tx(bad, platform_key, 5_000_000, 700), platform_key),
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
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 300, nonce: 10 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    SetTreasuryFee { pool_in_ix: 0, new_fee: 300 },
    Script(#"0c"),
    signed_by(set_fee_tx(next), platform_key),
  )
}

test set_fee_above_the_band_fails() fail {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 501, nonce: 10 }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    SetTreasuryFee { pool_in_ix: 0, new_fee: 501 },
    Script(#"0c"),
    signed_by(set_fee_tx(next), platform_key),
  )
}

test set_fee_that_moves_value_fails() fail {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 300, nonce: 10 }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_input(cfg(), 100_000_000, 100_000_000)],
    outputs: [pool_output(next, 99_000_000, 100_000_000)],
  }
  treasury.withdraw(
    VerificationKey(platform_key),
    500,
    SetTreasuryFee { pool_in_ix: 0, new_fee: 300 },
    Script(#"0c"),
    signed_by(tx, platform_key),
  )
}

test set_fee_by_a_script_authority_needs_its_withdrawal() {
  let next = SingleRoyaltyPoolConfig { ..cfg(), treasury_fee: 300, nonce: 10 }
  let tx = Transaction {
    ..set_fee_tx(next),
    withdrawals: [Pair(Script(#"0e"), 0)],
  }
  treasury.withdraw(
    Script(#"0e"),
    500,
    SetTreasuryFee { pool_in_ix: 0, new_fee: 300 },
    Script(#"0c"),
    tx,
  )
}
