//// NoctisSwap: the pool factory, as the LQ minting policy.
////
//// A pool comes into being in a launch's graduation transaction and nowhere
//// else. This policy mints both the pool NFT and the pool's LQ token, named
//// with the pool and LQ role tags and the launch id, and its authority is the
//// launch's own LP escrow: the escrow's thread NFT is minted once at genesis,
//// and the escrow can be spent from its unsealed state only once. So the
//// graduation stays permissionless, as the curve's own Graduate is, and no
//// platform signature can withhold a pool.
////
////   Create — exactly one pool NFT and `max_lq_cap` LQ of the launch's names
////     are minted and nothing else under this policy; one output at the pool
////     script's bare address (no stake part: whoever submits the graduation
////     must not delegate the pool's ADA for the pool's whole life) carries
////     the NFT, keeps `max_lq_cap - initial_lq` LQ, holds ADA
////     and one launch token and nothing else, and its datum is the platform
////     schedule exactly: the two fees and the pool fee, empty counters, the
////     treasury script as the DAO, the platform's treasury address, a nonce of
////     zero, and a royalty key that hashes to the creator's fee recipient as
////     the launch's LP escrow records it. The escrow is spent in the same
////     transaction from its unsealed state and comes back holding `initial_lq`
////     LQ, with its datum naming that position. That is the whole of the LP
////     lock: the escrow holds the position from the first block of the pool.
////   Burn — only burning.
////
//// Splash mints its LQ under policies served from its own infrastructure; this
//// is the Noctis replacement.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash, blake2b_224}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{PolicyId, Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use noctisswap/launch_records.{
  Locked, LpEscrowDatum, role_bonding_curve, role_lp_escrow, role_lq, role_pool,
  thread_asset_name,
}
use noctisswap/pool_state.{is_ada, max_lq_cap}
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of, v_len}

pub type MintAction {
  Create { launch_id: ByteArray, pool_out_ix: Int, escrow_out_ix: Int }
  Burn
}

const ada: Asset = Asset { policy: ada_policy_id, name: ada_asset_name }

/// `thread_nft_policy`: the platform's thread NFT policy, under which the
/// escrow's NFT was minted at genesis. `pool_vh`: the pool validator. `treasury_cred`, `treasury_address`: the platform's treasury
/// script and wallet. The three fee numerators are the platform schedule.
/// `initial_lq`: the size of the escrowed position every pool opens with.
validator pool_mint(
  thread_nft_policy: PolicyId,
  pool_vh: ScriptHash,
  treasury_cred: Credential,
  treasury_address: ByteArray,
  fee_num: Int,
  treasury_fee: Int,
  royalty_fee: Int,
  initial_lq: Int,
) {
  mint(redeemer: MintAction, own_policy: PolicyId, self: Transaction) {
    let own_minted = assets.tokens(self.mint, own_policy) |> dict.to_pairs
    when redeemer is {
      Burn -> list.all(own_minted, fn(p) { p.2nd < 0 })
      Create { launch_id, pool_out_ix, escrow_out_ix } -> {
        let nft_name = thread_asset_name(role_pool, launch_id)
        let lq_name = thread_asset_name(role_lq, launch_id)
        let nft = Asset { policy: own_policy, name: nft_name }
        let lq = Asset { policy: own_policy, name: lq_name }
        let escrow_nft_name = thread_asset_name(role_lp_escrow, launch_id)

        expect Some(pool_out) = list.at(self.outputs, pool_out_ix)
        expect InlineDatum(pool_raw) = pool_out.datum
        expect cfg: SingleRoyaltyPoolConfig = pool_raw

        expect Some(escrow_out) = list.at(self.outputs, escrow_out_ix)
        expect InlineDatum(escrow_raw) = escrow_out.datum
        expect escrow: LpEscrowDatum = escrow_raw
        expect Some(escrow_in) = list.find(
          self.inputs,
          fn(i) {
            assets.quantity_of(
              i.output.value,
              thread_nft_policy,
              escrow_nft_name,
            ) == 1
          },
        )
        expect InlineDatum(escrow_in_raw) = escrow_in.output.datum
        expect escrow_before: LpEscrowDatum = escrow_in_raw

        // A pool opens only in the launch's own graduation transaction. The
        // curve's record must be spent here, which is what makes the curve's
        // validator run alongside this policy and hold the pool output to the
        // whole raise and the reserve it is owed. Without this the escrow's
        // seal would authorise itself: the position it seals is minted here,
        // so nothing else would tie either to the launch actually graduating.
        let curve_spent =
          list.any(
            self.inputs,
            fn(i) {
              assets.quantity_of(
                i.output.value,
                thread_nft_policy,
                thread_asset_name(role_bonding_curve, launch_id),
              ) == 1
            },
          )

        let expected = SingleRoyaltyPoolConfig {
          pool_nft: nft,
          pool_x: ada,
          pool_y: cfg.pool_y,
          pool_lq: lq,
          fee_num,
          treasury_fee,
          royalty_fee,
          treasury_x: 0,
          treasury_y: 0,
          royalty_x: 0,
          royalty_y: 0,
          dao_policy: [Inline(treasury_cred)],
          treasury_address,
          royalty_pub_key: cfg.royalty_pub_key,
          nonce: 0,
        }

        and {
          own_minted == [Pair(nft_name, 1), Pair(lq_name, max_lq_cap)],
          curve_spent,
          pool_out.address == Address {
            payment_credential: Script(pool_vh),
            stake_credential: None,
          },
          // The escrow comes back to the address it was spent from, so this
          // policy does not lean on the launch package's seal to keep the
          // position where it belongs.
          escrow_out.address == escrow_in.output.address,
          cfg == expected,
          !is_ada(cfg.pool_y),
          // Read from the record that was spent, not from the datum written
          // in this transaction, so the creator's key comes from the launch's
          // own escrow rather than from whoever submits the graduation.
          blake2b_224(cfg.royalty_pub_key) == escrow_before.fee_recipient_pub_key_hash,
          asset_quantity_of(pool_out.value, nft) == 1,
          asset_quantity_of(pool_out.value, lq) == max_lq_cap - initial_lq,
          assets.lovelace_of(pool_out.value) > 0,
          asset_quantity_of(pool_out.value, cfg.pool_y) > 0,
          v_len(pool_out.value) == 4,
          assets.quantity_of(
            escrow_out.value,
            thread_nft_policy,
            escrow_nft_name,
          ) == 1,
          escrow.launch_id == launch_id,
          escrow_before.lock_timestamp == 0,
          escrow.lock_timestamp > 0,
          escrow.lp_token_policy_id == own_policy,
          escrow.lp_token_name == lq_name,
          escrow.lp_token_amount == initial_lq,
          asset_quantity_of(escrow_out.value, lq) == initial_lq,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests: a graduation-shaped transaction. 20,000 ADA and 200M launch tokens go
// into the pool; the escrow comes back sealed with the whole initial position.
// ---------------------------------------------------------------------------

const thread_policy: PolicyId = #"7e"

const lq_policy: PolicyId = #"7c"

const pool_hash: ScriptHash = #"0a"

const launch: ByteArray =
  #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

const other_launch: ByteArray =
  #"ff02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

const creator_key: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

const token: Asset = Asset { policy: #"bb", name: #"746f6b656e" }

const initial: Int = 1_000_000_000

fn treasury() -> Credential {
  Script(#"0c")
}

fn nft_name() -> ByteArray {
  thread_asset_name(role_pool, launch)
}

fn name() -> ByteArray {
  thread_asset_name(role_lq, launch)
}

fn nft() -> Asset {
  Asset { policy: lq_policy, name: nft_name() }
}

fn lq() -> Asset {
  Asset { policy: lq_policy, name: name() }
}

fn pool_cfg() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: nft(),
    pool_x: ada,
    pool_y: token,
    pool_lq: lq(),
    fee_num: 99_700,
    treasury_fee: 100,
    royalty_fee: 1_000,
    treasury_x: 0,
    treasury_y: 0,
    royalty_x: 0,
    royalty_y: 0,
    dao_policy: [Inline(treasury())],
    treasury_address: #"ee",
    royalty_pub_key: creator_key,
    nonce: 0,
  }
}

fn pool_value() -> Value {
  assets.from_lovelace(20_000_000_000)
    |> assets.add(token.policy, token.name, 200_000_000)
    |> assets.add(lq_policy, name(), max_lq_cap - initial)
    |> assets.add(lq_policy, nft_name(), 1)
}

fn pool_out(
  cfg: SingleRoyaltyPoolConfig,
  value: Value,
  at: Credential,
) -> Output {
  Output {
    address: Address { payment_credential: at, stake_credential: None },
    value,
    datum: InlineDatum(cfg),
    reference_script: None,
  }
}

fn escrow_datum(lock_timestamp: Int) -> LpEscrowDatum {
  LpEscrowDatum {
    launch_id: launch,
    lock_timestamp,
    lock_duration: 31_536_000_000,
    lp_state: Locked,
    governor_pub_key_hash: #"90",
    community_wallet_hash: #"",
    cto_triggered: False,
    fee_recipient_pub_key_hash: blake2b_224(creator_key),
    dex_whitelist: [],
    multisig_signers: [],
    multisig_threshold: 0,
    pending_dex_change: None,
    lp_token_policy_id: lq_policy,
    lp_token_name: name(),
    lp_token_amount: initial,
    cto_governance_credential: Script(#"60"),
    thread_nft_policy: thread_policy,
    last_migration_timestamp: 0,
  }
}

fn escrow_value(lq_amount: Int) -> Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(thread_policy, thread_asset_name(role_lp_escrow, launch), 1)
    |> assets.add(lq_policy, name(), lq_amount)
}

fn escrow_address() -> Address {
  Address { payment_credential: Script(#"0b"), stake_credential: None }
}

fn escrow_in(datum: LpEscrowDatum) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"e5", output_index: 0 },
    output: Output {
      address: escrow_address(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(
            thread_policy,
            thread_asset_name(role_lp_escrow, launch),
            1,
          ),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn escrow_out(datum: LpEscrowDatum, value: Value) -> Output {
  Output {
    address: escrow_address(),
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn mint_value() -> Value {
  assets.from_asset(lq_policy, name(), max_lq_cap)
    |> assets.add(lq_policy, nft_name(), 1)
}

/// The launch's bonding curve, spent in the same transaction. Its own
/// validator holds the pool output to the raise and the reserve; here it is
/// only the record that proves the graduation is real.
fn curve_in() -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"c0", output_index: 0 },
    output: Output {
      address: Address {
        payment_credential: Script(#"0c"),
        stake_credential: None,
      },
      value: assets.from_lovelace(20_000_000_000)
        |> assets.add(
            thread_policy,
            thread_asset_name(role_bonding_curve, launch),
            1,
          ),
      datum: transaction.NoDatum,
      reference_script: None,
    },
  }
}

fn tx(
  pool: Output,
  escrow: Output,
  escrow_before: Input,
  mint: Value,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [escrow_before, curve_in()],
    outputs: [pool, escrow],
    mint,
  }
}

fn create() -> MintAction {
  Create { launch_id: launch, pool_out_ix: 0, escrow_out_ix: 1 }
}

fn run(redeemer: MintAction, t: Transaction) -> Bool {
  pool_mint.mint(
    thread_policy,
    pool_hash,
    treasury(),
    #"ee",
    99_700,
    100,
    1_000,
    initial,
    redeemer,
    lq_policy,
    t,
  )
}

fn good() -> Transaction {
  tx(
    pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
    escrow_out(escrow_datum(1_000), escrow_value(initial)),
    escrow_in(escrow_datum(0)),
    mint_value(),
  )
}

test graduation_mints_the_pool() {
  run(create(), good())
}

test minting_without_the_pool_nft_fails() fail {
  run(
    create(),
    Transaction {
      ..good(),
      mint: assets.from_asset(lq_policy, name(), max_lq_cap),
    },
  )
}

test minting_a_second_name_fails() fail {
  let mint = mint_value()
    |> assets.add(
        lq_policy,
        thread_asset_name(role_pool, other_launch),
        max_lq_cap,
      )
  run(create(), Transaction { ..good(), mint })
}

test minting_less_than_the_cap_fails() fail {
  let mint = assets.from_asset(lq_policy, name(), max_lq_cap - 1)
    |> assets.add(lq_policy, nft_name(), 1)
  let pool = pool_out(
    pool_cfg(),
    pool_value() |> assets.add(lq_policy, name(), -1),
    Script(pool_hash),
  )
  run(
    create(),
    Transaction {
      ..good(),
      mint,
      outputs: [pool, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

test pool_at_another_script_fails() fail {
  let pool = pool_out(pool_cfg(), pool_value(), Script(#"0f"))
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [pool, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

/// The pool validator preserves its address on every spend, so a stake part
/// attached here would delegate the reserves to the submitter for good.
test pool_at_a_staked_address_fails() fail {
  let staked = Output {
    ..pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
    address: Address {
      payment_credential: Script(pool_hash),
      stake_credential: Some(Inline(Script(#"5a"))),
    },
  }
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [staked, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

test pool_off_the_fee_schedule_fails() fail {
  let pool = pool_out(
    SingleRoyaltyPoolConfig { ..pool_cfg(), royalty_fee: 999 },
    pool_value(),
    Script(pool_hash),
  )
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [pool, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

test pool_with_a_counter_already_set_fails() fail {
  let pool = pool_out(
    SingleRoyaltyPoolConfig { ..pool_cfg(), royalty_x: 1 },
    pool_value(),
    Script(pool_hash),
  )
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [pool, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

test pool_with_another_dao_fails() fail {
  let pool = pool_out(
    SingleRoyaltyPoolConfig {
      ..pool_cfg(),
      dao_policy: [Inline(Script(#"0d"))],
    },
    pool_value(),
    Script(pool_hash),
  )
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [pool, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

test pool_with_ada_on_both_sides_fails() fail {
  let cfg = SingleRoyaltyPoolConfig { ..pool_cfg(), pool_y: ada }
  let value = assets.from_lovelace(20_000_000_000)
    |> assets.add(token.policy, token.name, 200_000_000)
    |> assets.add(lq_policy, name(), max_lq_cap - initial)
    |> assets.add(lq_policy, nft_name(), 1)
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(cfg, value, Script(pool_hash)),
        escrow_out(escrow_datum(1_000), escrow_value(initial)),
      ],
    },
  )
}

test royalty_key_that_is_not_the_creators_fails() fail {
  let stranger = #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"
  let pool = pool_out(
    SingleRoyaltyPoolConfig { ..pool_cfg(), royalty_pub_key: stranger },
    pool_value(),
    Script(pool_hash),
  )
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [pool, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

/// The mint and the escrow both still add up; only the pool's LQ balance
/// rule rejects the extra unit.
test pool_keeping_part_of_the_position_fails() fail {
  let pool = pool_out(
    pool_cfg(),
    pool_value() |> assets.add(lq_policy, name(), 1),
    Script(pool_hash),
  )
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [pool, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

/// Junk in the place of the pool NFT keeps the asset count at four, so only
/// the NFT rule rejects.
test pool_without_the_nft_fails() fail {
  let value = assets.from_lovelace(20_000_000_000)
    |> assets.add(token.policy, token.name, 200_000_000)
    |> assets.add(lq_policy, name(), max_lq_cap - initial)
    |> assets.add(#"dd", #"6a756e6b", 1)
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), value, Script(pool_hash)),
        escrow_out(escrow_datum(1_000), escrow_value(initial)),
      ],
    },
  )
}

test pool_with_an_extra_asset_fails() fail {
  let pool = pool_out(
    pool_cfg(),
    pool_value() |> assets.add(#"dd", #"6a756e6b", 1),
    Script(pool_hash),
  )
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [pool, escrow_out(escrow_datum(1_000), escrow_value(initial))],
    },
  )
}

test escrow_without_its_thread_nft_fails() fail {
  let bare = assets.from_lovelace(2_000_000)
    |> assets.add(lq_policy, name(), initial)
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
        escrow_out(escrow_datum(1_000), bare),
      ],
    },
  )
}

/// Carries our launch's escrow NFT with another launch's datum, so only the
/// launch id comparison rejects.
test escrow_of_another_launch_fails() fail {
  let other = LpEscrowDatum { ..escrow_datum(1_000), launch_id: other_launch }
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
        escrow_out(other, escrow_value(initial)),
      ],
    },
  )
}

test escrow_recording_another_position_fails() fail {
  let wrong = LpEscrowDatum {
    ..escrow_datum(1_000),
    lp_token_amount: initial - 1,
  }
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
        escrow_out(wrong, escrow_value(initial)),
      ],
    },
  )
}

test escrow_recording_another_token_fails() fail {
  let wrong = LpEscrowDatum { ..escrow_datum(1_000), lp_token_policy_id: #"7d" }
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
        escrow_out(wrong, escrow_value(initial)),
      ],
    },
  )
}

/// The mint and the pool both still add up; only the escrow's LQ balance
/// rule rejects (the missing unit is nowhere).
test escrow_holding_less_lq_fails() fail {
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
        escrow_out(escrow_datum(1_000), escrow_value(initial - 1)),
      ],
    },
  )
}

test escrow_left_unsealed_fails() fail {
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
        escrow_out(escrow_datum(0), escrow_value(initial)),
      ],
    },
  )
}

test escrow_that_was_already_sealed_fails() fail {
  run(
    create(),
    Transaction { ..good(), inputs: [escrow_in(escrow_datum(500)), curve_in()] },
  )
}

/// A pool opens only alongside the launch's own graduation. Without the
/// curve's record among the inputs the escrow's seal would be authorising
/// itself, since the position it seals is minted in this same transaction.
test graduation_without_the_curve_fails() fail {
  run(create(), Transaction { ..good(), inputs: [escrow_in(escrow_datum(0))] })
}

/// The curve of another launch does not stand in for this one's.
test graduation_with_another_launchs_curve_fails() fail {
  let other_curve =
    Input {
      ..curve_in(),
      output: Output {
        ..curve_in().output,
        value: assets.from_lovelace(20_000_000_000)
          |> assets.add(
              thread_policy,
              thread_asset_name(role_bonding_curve, other_launch),
              1,
            ),
      },
    }
  run(
    create(),
    Transaction { ..good(), inputs: [escrow_in(escrow_datum(0)), other_curve] },
  )
}

/// The sealed position must come back to the escrow it was spent from.
test escrow_returning_to_another_address_fails() fail {
  let elsewhere =
    Output {
      ..escrow_out(escrow_datum(1_000), escrow_value(initial)),
      address: Address {
        payment_credential: VerificationKey(#"a7"),
        stake_credential: None,
      },
    }
  run(
    create(),
    tx(
      pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
      elsewhere,
      escrow_in(escrow_datum(0)),
      mint_value(),
    ),
  )
}

/// The creator's key is read from the record that was spent, so rewriting the
/// fee recipient in the datum this transaction authors changes nothing.
test royalty_key_taken_from_the_written_datum_fails() fail {
  let stranger_key = #"a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7"
  let hijacked =
    SingleRoyaltyPoolConfig { ..pool_cfg(), royalty_pub_key: stranger_key }
  let rewritten =
    LpEscrowDatum {
      ..escrow_datum(1_000),
      fee_recipient_pub_key_hash: blake2b_224(stranger_key),
    }
  run(
    create(),
    tx(
      pool_out(hijacked, pool_value(), Script(pool_hash)),
      escrow_out(rewritten, escrow_value(initial)),
      escrow_in(escrow_datum(0)),
      mint_value(),
    ),
  )
}

/// Junk in the place of ADA keeps the asset count at four, so only the
/// lovelace rule rejects.
test pool_without_ada_fails() fail {
  let value = assets.from_asset(token.policy, token.name, 200_000_000)
    |> assets.add(#"dd", #"6a756e6b", 1)
    |> assets.add(lq_policy, name(), max_lq_cap - initial)
    |> assets.add(lq_policy, nft_name(), 1)
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), value, Script(pool_hash)),
        escrow_out(escrow_datum(1_000), escrow_value(initial)),
      ],
    },
  )
}

/// Junk in the place of the launch token, same reasoning.
test pool_without_the_token_fails() fail {
  let value = assets.from_lovelace(20_000_000_000)
    |> assets.add(#"dd", #"6a756e6b", 1)
    |> assets.add(lq_policy, name(), max_lq_cap - initial)
    |> assets.add(lq_policy, nft_name(), 1)
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), value, Script(pool_hash)),
        escrow_out(escrow_datum(1_000), escrow_value(initial)),
      ],
    },
  )
}

test escrow_recording_another_name_fails() fail {
  let wrong = LpEscrowDatum {
    ..escrow_datum(1_000),
    lp_token_name: thread_asset_name(role_pool, other_launch),
  }
  run(
    create(),
    Transaction {
      ..good(),
      outputs: [
        pool_out(pool_cfg(), pool_value(), Script(pool_hash)),
        escrow_out(wrong, escrow_value(initial)),
      ],
    },
  )
}

test burn_passes() {
  run(
    Burn,
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(lq_policy, name(), -5),
    },
  )
}

test burn_that_mints_fails() fail {
  run(
    Burn,
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(lq_policy, name(), 5),
    },
  )
}
