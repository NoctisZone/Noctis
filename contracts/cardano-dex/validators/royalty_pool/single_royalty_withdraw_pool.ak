//// WHY THIS SCRIPT DOES NOT PIN THE POOL'S ADDRESS, unlike `treasury.ak` and
//// `redirect.ak`, which both take `pool_vh` and check it.
////
//// It cannot: `pool` already takes THIS script's hash as its parameter, so
//// taking the pool's hash here would make each script's hash depend on the
//// other's and neither could be compiled. That cycle is a real one that was
//// hit and removed once already; do not close the asymmetry by reintroducing
//// it.
////
//// What carries the weight instead, and every part is load-bearing:
////
////   * The input this script names must itself hold the NFT its own datum
////     names. Identity comes from the pool's own token rather than from its
////     address, which needs no parameter and so no cycle — the same thing
////     `redirect.ak` requires of the input it names.
////   * Exactly two inputs. The pool and the request, nothing else — so no
////     decoy can absorb this script's validation while a second pool moves.
////   * The NFT named in the datum must be the one the creator signed over,
////     and the continuing output must hold it. A pool-shaped UTxO carrying a
////     look-alike token therefore fails against the signature, which no
////     attacker can produce for a different pool.
////
//// The pool's own validator independently checks the NFT on the input it
//// spends, and its action 4 is what summons this script, so on a real pool
//// the two run together on the same input. That is a second reading of the
//// same fact, not a substitute for the first rule above: this script names
//// its input by index, and only the first rule ties that index to a pool.

use aiken/builtin
use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{blake2b_224}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ScriptPurpose, Spend, Transaction,
}
use noctisswap/orders.{apply_redeemer_index}
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

    // The INPUT named by `pool_in_ix`, not only the continuing output, has to
    // be the pool its datum claims to be. Without this the index is tied to a
    // pool only by there being nowhere else for a second input to sit.
    let prev_pool_identity = asset_quantity_of(prev_value, prev_pool_nft) == 1

    let royalty_withdraw_ok = withdraw_x >= 0 && withdraw_y >= 0 && withdraw_x <= prev_rx && withdraw_y <= prev_ry && new_rx == prev_rx - withdraw_x && new_ry == prev_ry - withdraw_y && prev_lq_val == new_lq_val && prev_x_val - withdraw_x == new_x_val && prev_y_val - withdraw_y == new_y_val

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

    // The payout is derived from the pool rather than declared by the request:
    // the value a claim draws must reach the key `royalty_pub_key` hashes to.
    //
    // This rule lives here because this script runs on EVERY royalty claim —
    // the pool's own action 4 defers to it, and the signature it checks covers
    // the amounts and the nonce, so the signature itself can carry no
    // destination. Holding the destination anywhere else would make the
    // guarantee true of one way of completing a claim rather than of a claim.
    let creator = VerificationKey(blake2b_224(prev_pk))
    // The whole payout rule, not half of it. The reward reaches the creator's
    // key, and reaches it undelegated or delegated by the creator. A stake
    // part is as much a part of an address as the payment part — staking
    // rewards accrue to whoever it names, and it chooses the pool the balance
    // is delegated to — so an address carrying the creator's payment key and
    // someone else's stake key is not the creator's address. Both halves are
    // held in this script, which runs on every royalty claim, so the guarantee
    // is about a claim rather than about one way of completing one.
    let delegated_by_the_creator = fn(o: Output) -> Bool {
      when o.address.stake_credential is {
        None -> True
        Some(Inline(c)) -> c == creator
        _ -> False
      }
    }
    let creator_is_paid = list.any(
      outputs,
      fn(o) {
        and {
          o.address.payment_credential == creator,
          delegated_by_the_creator(o),
          asset_quantity_of(o.value, prev_pool_x) >= withdraw_x,
          asset_quantity_of(o.value, prev_pool_y) >= withdraw_y,
        }
      },
    )

    // ...and the request is being SETTLED, not merely present. Its validator
    // has one arm that completes a claim and one that returns the request to
    // whoever placed it, and only the first is a settlement. Without this,
    // every rule living in that arm would hold of one route to completing a
    // claim rather than of a claim — and a request at this script can be
    // reproduced by anyone, since its datum is public once placed.
    let order_is_being_applied = when
      pairs.get_first(self.redeemers, Spend(order_input.output_reference))
    is {
      Some(r) -> builtin.un_constr_data(r).1st == apply_redeemer_index
      None -> False
    }

    creator_is_paid && order_is_being_applied && prev_pool_identity && correct_order_input_address && correct_final_pool_address && correct_tokens_qty_in_pool && pool_identity && royalty_withdraw_ok && signature_is_correct && strict_inputs && final_pool_config_is_correct && correct_pool && correct_lovelace_token2token
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

fn request_signed(at: Credential, wd: WithdrawData, sig: ByteArray) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"01", output_index: 0 },
    output: Output {
      address: Address { payment_credential: at, stake_credential: None },
      value: assets.from_lovelace(4_000_000),
      datum: InlineDatum(
        RoyaltyWithdrawConfig {
          withdraw_data: wd,
          signature: sig,
          additional_bytes: #"",
          owner: #"c0",
        },
      ),
      reference_script: None,
    },
  }
}

fn request(at: Credential) -> Input {
  request_signed(at, claim(), creator_signature)
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

/// Where a claim's value has to land: the key the pool's `royalty_pub_key`
/// hashes to, holding at least what the claim draws from each side.
fn creator_reward() -> Output {
  Output {
    address: Address {
      payment_credential: VerificationKey(blake2b_224(creator_pub_key)),
      stake_credential: None,
    },
    value: assets.from_lovelace(1_000_000)
      |> assets.add(token.policy, token.name, 200),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

/// The request spent under `Apply`, which is what a settlement carries. Only
/// the constructor is read, so the fields are not modelled.
fn applied() -> Pairs<ScriptPurpose, Data> {
  [
    Pair(
      Spend(OutputReference { transaction_id: #"01", output_index: 0 }),
      builtin.constr_data(apply_redeemer_index, []),
    ),
  ]
}

fn claim_tx_paying(at: Credential, nonce: Int, reward: Output) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    redeemers: applied(),
    inputs: [request(at), pool_in(nonce)],
    outputs: [pool_out(nonce), reward],
  }
}

fn claim_tx(at: Credential, nonce: Int) -> Transaction {
  claim_tx_paying(at, nonce, creator_reward())
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

// ---------------------------------------------------------------------------
// A claim cannot run backwards.
//
// Both payloads below came out of the compiler the same way the first one did,
// and are signed from the same fixed, fake seed. Each transaction builds the
// pool transition its claim actually asks for — a negative amount raises the
// counter and pays INTO the pool — so every delta rule is satisfied and the
// lower bound is the only thing left that can reject it.
// ---------------------------------------------------------------------------

/// Over the payload for a claim of −1 on the ADA side.
const negative_x_signature: ByteArray =
  #"dc531aee8e137c7616661a76529eded7627a9917b62fa5bd2647c7b1297a2a59c0ecfa60be6ef184a6f1b9969fcf47a4106e0ed838b0c4610ca93c962a966a07"

/// Over the payload for a claim of −1 on the token side.
const negative_y_signature: ByteArray =
  #"cbfb5831936e724fd6aff9af7f024b722dc94887df4004ccabf3112be8d035b3d8b5921b303316784f1dd850f0b375e5d54e34f22f8da7f3126fda8a8175ef0a"

fn backwards_claim_tx(
  wd: WithdrawData,
  sig: ByteArray,
  rx: Int,
  ry: Int,
  lovelace: Int,
  y: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    redeemers: applied(),
    inputs: [request_signed(Script(request_vh), wd, sig), pool_in(3)],
    outputs: [
      creator_reward(),
      Output {
        address: pool_address(),
        value: pool_value(lovelace, y),
        datum: InlineDatum(
          SingleRoyaltyPoolConfig {
            ..pool_cfg(3),
            royalty_x: rx,
            royalty_y: ry,
            nonce: 4,
          },
        ),
        reference_script: None,
      },
    ],
  }
}

fn run_tx(t: Transaction) -> Bool {
  royalty_withdraw_pool.withdraw(
    request_vh,
    RoyaltyWithdrawRedeemer { pool_in_ix: 1, order_in_ix: 0, hash: False },
    Script(#"0b"),
    t,
  )
}

test claim_for_a_negative_ada_amount_fails() fail {
  run_tx(
    backwards_claim_tx(
      WithdrawData { ..claim(), withdraw_royalty_x: -1 },
      negative_x_signature,
      5_000_001,
      500,
      100_000_001,
      100_000_000 - 200,
    ),
  )
}

test claim_for_a_negative_token_amount_fails() fail {
  run_tx(
    backwards_claim_tx(
      WithdrawData { ..claim(), withdraw_royalty_y: -1 },
      negative_y_signature,
      4_000_000,
      701,
      100_000_000 - 1_000_000,
      100_000_001,
    ),
  )
}

/// The claim redirected. Every delta, both counters, the nonce and the
/// creator's signature are byte-for-byte the passing case; the only difference
/// is who the value reaches. A signature that covers the amounts and the nonce
/// cannot cover a destination, so nothing but this rule can refuse it.
test claim_paid_to_someone_elses_address_fails() fail {
  let elsewhere = Output {
    address: Address {
      payment_credential: VerificationKey(#"a7"),
      stake_credential: None,
    },
    value: assets.from_lovelace(1_000_000)
      |> assets.add(token.policy, token.name, 200),
    datum: transaction.NoDatum,
    reference_script: None,
  }
  royalty_withdraw_pool.withdraw(
    request_vh,
    RoyaltyWithdrawRedeemer { pool_in_ix: 1, order_in_ix: 0, hash: False },
    Script(#"0b"),
    claim_tx_paying(Script(request_vh), 3, elsewhere),
  )
}

/// The creator's own key, but short on the token side. A payout that reaches
/// the right address for less than the claim drew is not the claim being paid.
test claim_paying_the_creator_short_fails() fail {
  let short = Output {
    ..creator_reward(),
    value: assets.from_lovelace(1_000_000)
      |> assets.add(token.policy, token.name, 199),
  }
  royalty_withdraw_pool.withdraw(
    request_vh,
    RoyaltyWithdrawRedeemer { pool_in_ix: 1, order_in_ix: 0, hash: False },
    Script(#"0b"),
    claim_tx_paying(Script(request_vh), 3, short),
  )
}

/// And with no payout output at all — the shape every fixture in this file
/// had before the rule existed.
test claim_that_pays_nobody_fails() fail {
  royalty_withdraw_pool.withdraw(
    request_vh,
    RoyaltyWithdrawRedeemer { pool_in_ix: 1, order_in_ix: 0, hash: False },
    Script(#"0b"),
    Transaction {
      ..transaction.placeholder,
      redeemers: applied(),
      inputs: [request(Script(request_vh)), pool_in(3)],
      outputs: [pool_out(3)],
    },
  )
}

/// Same claim as `creator_claim_at_the_parameterised_request_script_passes`,
/// reached through a shaper that can restate the pool input's value, so the
/// rejection below differs from a valid claim by that value alone.
fn claim_tx_with_pool_value(v: assets.Value) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    redeemers: applied(),
    inputs: [
      request(Script(request_vh)),
      Input { ..pool_in(3), output: Output { ..pool_in(3).output, value: v } },
    ],
    outputs: [pool_out(3), creator_reward()],
  }
}

fn run_claim(t: Transaction) -> Bool {
  royalty_withdraw_pool.withdraw(
    request_vh,
    RoyaltyWithdrawRedeemer { pool_in_ix: 1, order_in_ix: 0, hash: False },
    Script(#"0b"),
    t,
  )
}

test claim_through_the_pool_value_shaper_passes() {
  run_claim(claim_tx_with_pool_value(pool_value(100_000_000, 100_000_000)))
}

/// A look-alike under the NFT's own policy, so the value still holds four
/// assets and the reserves are untouched: the claim is refused because the
/// input is not the pool, not because anything else about it is wrong.
test claim_naming_an_input_without_the_pool_nft_fails() fail {
  let impostor = assets.from_lovelace(100_000_000)
    |> assets.add(token.policy, token.name, 100_000_000)
    |> assets.add(#"cc", #"6c71", 1_000)
    |> assets.add(nft.policy, #"6f74686572", 1)
  run_claim(claim_tx_with_pool_value(impostor))
}

fn creator_reward_delegated(stake: Credential) -> Output {
  Output {
    ..creator_reward(),
    address: Address {
      payment_credential: VerificationKey(blake2b_224(creator_pub_key)),
      stake_credential: Some(Inline(stake)),
    },
  }
}

/// A reward the creator delegated themselves is what a creator would build,
/// so the rejection below differs from it in whose key the stake part names.
test claim_paid_to_a_reward_the_creator_delegated_passes() {
  run_claim(
    claim_tx_paying(
      Script(request_vh),
      3,
      creator_reward_delegated(VerificationKey(blake2b_224(creator_pub_key))),
    ),
  )
}

/// The payment part reaches the creator and the stake part does not, so the
/// staking rewards on the creator's own royalty, and the choice of where that
/// balance is delegated, would belong to whoever set it.
test claim_delegating_the_creators_payout_to_a_stranger_fails() fail {
  run_claim(
    claim_tx_paying(
      Script(request_vh),
      3,
      creator_reward_delegated(VerificationKey(#"a7")),
    ),
  )
}

/// A request present but not being settled — spent under the arm that returns
/// it to whoever placed it, which asks only for that placer's signature.
test claim_whose_request_is_not_being_applied_fails() fail {
  let t = claim_tx(Script(request_vh), 3)
  royalty_withdraw_pool.withdraw(
    request_vh,
    RoyaltyWithdrawRedeemer { pool_in_ix: 1, order_in_ix: 0, hash: False },
    Script(#"0b"),
    Transaction {
      ..t,
      redeemers: [
        Pair(
          Spend(OutputReference { transaction_id: #"01", output_index: 0 }),
          builtin.constr_data(apply_redeemer_index + 1, []),
        ),
      ],
    },
  )
}

/// And with no redeemer entry for the request at all.
test claim_whose_request_has_no_redeemer_fails() fail {
  let t = claim_tx(Script(request_vh), 3)
  royalty_withdraw_pool.withdraw(
    request_vh,
    RoyaltyWithdrawRedeemer { pool_in_ix: 1, order_in_ix: 0, hash: False },
    Script(#"0b"),
    Transaction { ..t, redeemers: [] },
  )
}
