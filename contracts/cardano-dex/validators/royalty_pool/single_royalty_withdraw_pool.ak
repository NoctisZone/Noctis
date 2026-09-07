use aiken/builtin
use aiken/collection/list
use aiken/crypto.{blake2b_224}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use splash/orders/royalty_withdraw.{
  RoyaltyWithdrawConfig, RoyaltyWithdrawRedeemer, WithdrawData,
  WithdrawRoyaltyDataToSign,
}
use splash/plutus
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of, v_len}

// Single Royalty Withdrawal Contract (Aiken)
//
// Purpose
// - Securely process royalty withdrawals from a pool with a single royalty slot.
//   Enforces correctness, immutability, and authorization.
//
// Enforced rules
// 1) Restricted Field Modifications
//    - Only these fields may change:
//        • royalty_x, royalty_y
//        • nonce (must increase by exactly +1)
//    - All other fields (pool_x, pool_y, pool_lq, fees, dao_policy,
//      treasury_address, royalty_pub_key, etc.) must be unchanged.
//
// 2) Withdrawal Limits
//    - Requested withdraw_x/withdraw_y must not exceed the current
//      royalty_x/royalty_y in the input datum.
//
// 3) Input Structure
//    - Exactly two inputs: (1) the withdraw-request UTxO and (2) the pool UTxO.
//    - The withdraw-request input must be locked by the script hash given as
//      this validator's parameter (withdraw_request_vh), to prevent spoofed
//      requests. Splash compiles that hash in; Noctis passes it as a parameter,
//      because our request script is our own and its hash is not theirs.
//
// 4) Pool Identity, Address & Output Selection
//    - The pool output is identified by pool_nft quantity == 1.
//    - The pool address (input → output) must remain the same.
//
// 5) Value Deltas (outputs vs inputs)
//    - pool_x and pool_y quantities in the pool output value must be reduced
//      exactly by withdraw_x / withdraw_y.
//    - pool_lq quantity must remain unchanged.
//
// 6) ADA Invariant for Token-to-Token Pools
//    - If both pool_x and pool_y are non-ADA (policy != ada_policy_id),
//      the lovelace amount in the pool output must equal the input’s.
//    - The “shape” of the value (token entry count) should remain unchanged.
//
// 7) Signature Verification
//    - Message = additional_bytes || CBOR(WithdrawRoyaltyDataToSign
//      { withdraw_data, pool_nonce = old.nonce }).
//    - The signature must verify against royalty_pub_key.
//
// 8) Final Datum Check
//    - The new RoyaltyPoolConfig must equal the previous one except for:
//        • royalty_x / royalty_y updated by the withdrawal amounts, and
//        • nonce = old.nonce + 1.

/// `withdraw_request_vh`: the script the creator's claim request must sit at.
/// Splash hardcodes their own deployed request script here; ours is
/// `withdraw_order`, so this is a parameter and the two hashes are applied at
/// deployment rather than compiled in.
validator royalty_withdraw_pool(withdraw_request_vh: ByteArray) {
  withdraw(
    redeemer: RoyaltyWithdrawRedeemer,
    _account: Credential,
    self: Transaction,
  ) {
    let inputs = self.inputs
    let outputs = self.outputs

    let order_in_ix = redeemer.order_in_ix
    let pool_in_ix = redeemer.pool_in_ix
    let hash = redeemer.hash

    expect Some(order_input) = list.at(inputs, order_in_ix)
    let Input { output: order_input_out, .. } = order_input

    expect  
        Output {
          address: Address { payment_credential: order_pc, .. },
          datum: InlineDatum(order_datum),
          ..
        }
      = order_input_out

    let correct_order_input_address = when order_pc is {
      Script(vh) -> vh == withdraw_request_vh && list.length(inputs) == 2
      _ -> False
    }

    expect order_conf: RoyaltyWithdrawConfig = order_datum
    let  
        RoyaltyWithdrawConfig {
          withdraw_data: wd,
          signature,
          additional_bytes,
          ..
        }
      = order_conf

    let  
        WithdrawData {
          pool_nft: pool_nft_req,
          withdraw_royalty_x: withdraw_x,
          withdraw_royalty_y: withdraw_y,
          ..
        }
      = wd

    expect Some(pool_input) = list.at(inputs, pool_in_ix)
    let Input { output: pool_in_output, .. } = pool_input

    expect  
        Output {
          value: prev_value,
          address: prev_addr,
          datum: InlineDatum(pool_in_datum),
          ..
        }
      = pool_in_output

    expect prev_cfg: SingleRoyaltyPoolConfig = pool_in_datum

    let  
        SingleRoyaltyPoolConfig {
          pool_nft: prev_pool_nft,
          pool_x: prev_pool_x,
          pool_y: prev_pool_y,
          pool_lq: prev_pool_lq,
          fee_num: prev_fee_num,
          treasury_fee: prev_treasury_fee,
          royalty_fee: prev_royalty_fee,
          treasury_x: prev_treasury_x,
          treasury_y: prev_treasury_y,
          royalty_x: prev_rx,
          royalty_y: prev_ry,
          dao_policy: prev_dao_policy,
          treasury_address: prev_treasury_address,
          royalty_pub_key: prev_pk,
          nonce: prev_nonce,
        }
      = prev_cfg

    let prev_x_val = asset_quantity_of(prev_value, prev_pool_x)
    let prev_y_val = asset_quantity_of(prev_value, prev_pool_y)
    let prev_lq_val = asset_quantity_of(prev_value, prev_pool_lq)

    let prev_lovelace_token2token = if prev_pool_x.policy == ada_policy_id || prev_pool_y.policy == ada_policy_id {
      0
    } else {
      assets.lovelace_of(prev_value)
    }

    let prev_len = v_len(prev_value)
    let correct_pool = prev_pool_nft == pool_nft_req

    expect Some(pool_out_output) = list.find(
      outputs,
      fn(o) { asset_quantity_of(o.value, prev_pool_nft) == 1 },
    )

    expect  
        Output {
          value: new_value,
          address: new_addr,
          datum: InlineDatum(pool_out_datum),
          ..
        }
      = pool_out_output

    expect new_cfg: SingleRoyaltyPoolConfig = pool_out_datum

    let SingleRoyaltyPoolConfig { royalty_x: new_rx, royalty_y: new_ry, .. } = new_cfg

    let new_x_val = asset_quantity_of(new_value, prev_pool_x)
    let new_y_val = asset_quantity_of(new_value, prev_pool_y)
    let new_lq_val = asset_quantity_of(new_value, prev_pool_lq)

    let new_lovelace_token2token = if prev_pool_x.policy == ada_policy_id || prev_pool_y.policy == ada_policy_id {
      0
    } else {
      assets.lovelace_of(new_value)
    }

    let new_len = v_len(new_value)

    let correct_final_pool_address = prev_addr == new_addr
    let correct_tokens_qty_in_pool = prev_len == new_len
    let pool_identity = asset_quantity_of(new_value, prev_pool_nft) == 1

    let royalty_withdraw_ok = withdraw_x <= prev_rx && withdraw_y <= prev_ry && new_rx == prev_rx - withdraw_x && new_ry == prev_ry - withdraw_y && prev_lq_val == new_lq_val && prev_x_val - withdraw_x == new_x_val && prev_y_val - withdraw_y == new_y_val

    let correct_lovelace_token2token = prev_lovelace_token2token == new_lovelace_token2token

    let payload: WithdrawRoyaltyDataToSign = WithdrawRoyaltyDataToSign {
      withdraw_data: wd,
      pool_nonce: prev_nonce,
    }
    let payload_raw = builtin.serialise_data(payload)
    let payload_to_sign = if hash {
      blake2b_224(payload_raw)
    } else {
      payload_raw
    }
    let message = bytearray.concat(additional_bytes, payload_to_sign)
    let signature_is_correct = crypto.verify_ed25519_signature(
      prev_pk,
      message,
      signature,
    )

    let expected_new_cfg: SingleRoyaltyPoolConfig = SingleRoyaltyPoolConfig {
      pool_nft: prev_pool_nft,
      pool_x: prev_pool_x,
      pool_y: prev_pool_y,
      pool_lq: prev_pool_lq,
      fee_num: prev_fee_num,
      treasury_fee: prev_treasury_fee,
      royalty_fee: prev_royalty_fee,
      treasury_x: prev_treasury_x,
      treasury_y: prev_treasury_y,
      royalty_x: new_rx,
      royalty_y: new_ry,
      dao_policy: prev_dao_policy,
      treasury_address: prev_treasury_address,
      royalty_pub_key: prev_pk,
      nonce: prev_nonce + 1,
    }

    let final_pool_config_is_correct = expected_new_cfg == new_cfg

    let strict_inputs = list.length(inputs) == 2

    correct_order_input_address && correct_final_pool_address && correct_tokens_qty_in_pool && pool_identity && royalty_withdraw_ok && signature_is_correct && strict_inputs && final_pool_config_is_correct && correct_pool && correct_lovelace_token2token
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests
//
// This file had none. It is the creator's own claim path, and it was
// unreachable as vendored, so the first thing worth proving is that a real
// claim validates at all.
//
// The signing vector below is generated, not invented. The message is exactly
// what this validator builds — `serialise_data` of
// `WithdrawRoyaltyDataToSign { withdraw_data, pool_nonce }`, captured from the
// compiler rather than hand-encoded as CBOR — and it is signed with an Ed25519
// key derived from the seed `a1` repeated 32 times. That seed is written here
// on purpose: the vector protects nothing (it authorises one withdrawal from a
// pool that has never existed) and anyone can regenerate it. Only the public
// key and the signature appear below.
// ---------------------------------------------------------------------------

const request_vh: ByteArray = #"3e871c9758511a17"

const creator_pub_key: ByteArray =
  #"bc7cbcb5636375fa1d82434d466724d92377f53b980695dd49d26d0ce12205a5"

/// Over `serialise_data(WithdrawRoyaltyDataToSign { claim(), 3 })`, which is
/// `D8799FD8799FD8799F41AA436E6674FF1A000F424018C81A001E8480FF03FF`.
const creator_signature: ByteArray =
  #"a2ee06e3a3a0f536d3cd267c10526269017b3d0a1b541403523ed846ae859e80f57ee15c4ad1cedec0edcbbba6e785207df66c2be35bbd1925c2bdf3305d3d06"

const nft: plutus.Asset = plutus.Asset { policy: #"aa", name: #"6e6674" }

const token: plutus.Asset = plutus.Asset { policy: #"bb", name: #"746f6b656e" }

fn claim() -> WithdrawData {
  WithdrawData {
    pool_nft: nft,
    withdraw_royalty_x: 1_000_000,
    withdraw_royalty_y: 200,
    ex_fee: 2_000_000,
  }
}

fn pool_cfg(nonce: Int) -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: nft,
    pool_x: plutus.Asset { policy: ada_policy_id, name: ada_asset_name },
    pool_y: token,
    pool_lq: plutus.Asset { policy: #"cc", name: #"6c71" },
    fee_num: 99_700,
    treasury_fee: 100,
    royalty_fee: 1_000,
    treasury_x: 0,
    treasury_y: 0,
    royalty_x: 5_000_000,
    royalty_y: 700,
    dao_policy: [Inline(Script(#"dd")), Inline(Script(#"0c"))],
    treasury_address: #"ee",
    royalty_pub_key: creator_pub_key,
    nonce,
  }
}

/// The datum the claim leaves behind: both royalty counters down by what was
/// taken, the nonce up by one, nothing else moved.
fn paid_cfg(nonce: Int) -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    ..pool_cfg(nonce),
    royalty_x: 4_000_000,
    royalty_y: 500,
    nonce: nonce + 1,
  }
}

fn pool_value(lovelace: Int, y: Int) -> assets.Value {
  assets.from_lovelace(lovelace)
    |> assets.add(token.policy, token.name, y)
    |> assets.add(#"cc", #"6c71", 1_000)
    |> assets.add(nft.policy, nft.name, 1)
}

fn pool_address() -> Address {
  Address { payment_credential: Script(#"0a"), stake_credential: None }
}

fn request(at: Credential) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"01", output_index: 0 },
    output: Output {
      address: Address { payment_credential: at, stake_credential: None },
      value: assets.from_lovelace(4_000_000),
      datum: InlineDatum(
        RoyaltyWithdrawConfig {
          withdraw_data: claim(),
          signature: creator_signature,
          additional_bytes: #"",
          owner: #"c0",
        },
      ),
      reference_script: None,
    },
  }
}

fn pool_in(nonce: Int) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"02", output_index: 0 },
    output: Output {
      address: pool_address(),
      value: pool_value(100_000_000, 100_000_000),
      datum: InlineDatum(pool_cfg(nonce)),
      reference_script: None,
    },
  }
}

fn pool_out(nonce: Int) -> Output {
  Output {
    address: pool_address(),
    value: pool_value(100_000_000 - 1_000_000, 100_000_000 - 200),
    datum: InlineDatum(paid_cfg(nonce)),
    reference_script: None,
  }
}

fn claim_tx(at: Credential, nonce: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [request(at), pool_in(nonce)],
    outputs: [pool_out(nonce)],
  }
}

fn run(vh: ByteArray, at: Credential, nonce: Int) -> Bool {
  royalty_withdraw_pool.withdraw(
    vh,
    RoyaltyWithdrawRedeemer { pool_in_ix: 1, order_in_ix: 0, hash: False },
    Script(#"0b"),
    claim_tx(at, nonce),
  )
}

/// The claim the creator can actually make. Splash's own hash sat here as a
/// constant, so this transaction could not validate at all.
test creator_claim_at_the_parameterised_request_script_passes() {
  run(request_vh, Script(request_vh), 3)
}

/// The same claim, presented from some other script. Only the request script
/// differs from the passing case.
test claim_from_a_request_at_another_script_fails() fail {
  run(request_vh, Script(#"99"), 3)
}

/// Splash's own deployed request hash, which is what this validator used to
/// insist on. Nothing else changes, so this is the finding itself: with their
/// hash compiled in, our request script could never answer.
test claim_measured_against_another_deployments_hash_fails() fail {
  run(
    #"92c094b90cf3637a96a13e9bc9a04ce8bb7e48c7ed0b5d1cc5ca7332",
    Script(request_vh),
    3,
  )
}

/// A request whose signature was made over a different pool nonce. The datum
/// transition is still exactly right — the nonce still rises by one — so only
/// the signature can reject it, which is what proves the signature check is
/// doing work rather than being satisfied by shape alone.
test claim_signed_over_another_nonce_fails() fail {
  run(request_vh, Script(request_vh), 99)
}

/// The request must sit at a script at all; a key address cannot hold one.
test claim_from_a_key_address_fails() fail {
  run(request_vh, VerificationKey(#"a7"), 3)
}
