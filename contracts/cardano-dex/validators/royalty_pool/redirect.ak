//// NoctisSwap: the governance-side script that grants a pool's royalty redirect.
////
//// The pool's action 5 (RedirectRoyalty) runs only when a withdrawal from this
//// script's credential is in the transaction, and the pool itself holds the
//// change to `royalty_pub_key` plus a nonce bump. This script decides whether
//// the change is allowed and where the key may point, by reading the launch's
//// own records as reference inputs:
////
////   Takeover — the CTO governance record's state is CTOTriggered and the pool's
////     new royalty key hashes to the community wallet the record names. That
////     state is written only by the governance validator's ExecuteProposal, on
////     a passed vote that survived its challenge window, so the state is the
////     evidence. An emergency freeze clears the community wallet without
////     changing the state; no key hashes to the empty string, so a redirect is
////     impossible while frozen.
////   Dissolve — the record's state is CTODissolved and the new key hashes to
////     the creator's fee-recipient key as the launch's LP escrow records it,
////     read from a second reference input.
////
//// Binding the pool to the launch: the pool NFT is minted by the factory policy
//// with the pool role tag and the launch id in its name, and the governance
//// and escrow records carry their own role's NFT under the platform's thread
//// NFT policy. A record of another launch, a record at the right address with
//// a home-made datum, or a pool whose NFT is not the factory's, cannot pass.
////
//// One pool per transaction: exactly one input sits at the redirected pool's
//// payment credential, so this one withdrawal cannot cover a second pool.

use aiken/collection/list
use aiken/crypto.{blake2b_224}
use cardano/address.{Address, Credential, Script}
use cardano/assets.{PolicyId, ada_asset_name, ada_policy_id}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use noctisswap/launch_records.{
  CTODissolved, CTOTriggered, CtoAnchorState, CtoGovernanceDatum, Locked,
  LpEscrowDatum, PreCTO, role_cto_governance, role_lp_escrow, role_pool,
  thread_asset_name,
}
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of}

pub type RedirectAction {
  Takeover { pool_in_ix: Int }
  Dissolve { pool_in_ix: Int }
}

fn record_at(reference_inputs: List<Input>, cred: Credential) -> Input {
  expect Some(record) = list.find(
    reference_inputs,
    fn(input) { input.output.address.payment_credential == cred },
  )
  record
}

/// `thread_nft_policy`: the platform's thread NFT policy, under which every
/// launch record's NFT is minted. `pool_nft_policy`: the factory policy that
/// mints pool NFTs. `cto_governance_cred` and `lp_escrow_cred`: the launch
/// package's governance and escrow validators.
validator redirect(
  thread_nft_policy: PolicyId,
  pool_nft_policy: PolicyId,
  cto_governance_cred: Credential,
  lp_escrow_cred: Credential,
) {
  withdraw(redeemer: RedirectAction, _account: Credential, self: Transaction) {
    let pool_in_ix = when redeemer is {
      Takeover { pool_in_ix } -> pool_in_ix
      Dissolve { pool_in_ix } -> pool_in_ix
    }
    expect Some(pool_in) = list.at(self.inputs, pool_in_ix)
    expect InlineDatum(prev_raw) = pool_in.output.datum
    expect prev: SingleRoyaltyPoolConfig = prev_raw
    expect Some(successor) = list.find(
      self.outputs,
      fn(o) { asset_quantity_of(o.value, prev.pool_nft) == 1 },
    )
    expect InlineDatum(next_raw) = successor.datum
    expect next: SingleRoyaltyPoolConfig = next_raw
    let new_key_hash = blake2b_224(next.royalty_pub_key)

    let pool_cred = pool_in.output.address.payment_credential
    let one_pool = list.count(
      self.inputs,
      fn(i) { i.output.address.payment_credential == pool_cred },
    ) == 1

    let cto_ref = record_at(self.reference_inputs, cto_governance_cred)
    expect InlineDatum(cto_raw) = cto_ref.output.datum
    expect cto: CtoGovernanceDatum = cto_raw
    let launch_id = cto.launch_id
    let bound = and {
      prev.pool_nft.policy == pool_nft_policy,
      prev.pool_nft.name == thread_asset_name(role_pool, launch_id),
      assets.quantity_of(
        cto_ref.output.value,
        thread_nft_policy,
        thread_asset_name(role_cto_governance, launch_id),
      ) == 1,
    }

    when redeemer is {
      Takeover { .. } -> and {
          one_pool,
          bound,
          cto.cto_state == CTOTriggered,
          new_key_hash == cto.community_wallet_hash,
        }
      Dissolve { .. } -> {
        let lp_ref = record_at(self.reference_inputs, lp_escrow_cred)
        expect InlineDatum(lp_raw) = lp_ref.output.datum
        expect lp: LpEscrowDatum = lp_raw
        and {
          one_pool,
          bound,
          cto.cto_state == CTODissolved,
          assets.quantity_of(
            lp_ref.output.value,
            thread_nft_policy,
            thread_asset_name(role_lp_escrow, launch_id),
          ) == 1,
          lp.launch_id == launch_id,
          new_key_hash == lp.fee_recipient_pub_key_hash,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const thread_policy: PolicyId = #"7e"

const factory_policy: PolicyId = #"7c"

const launch: ByteArray =
  #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

const other_launch: ByteArray =
  #"ff02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

const creator_key: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

const community_key: ByteArray =
  #"c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"

const stranger_key: ByteArray =
  #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"

fn cto_cred() -> Credential {
  Script(#"60")
}

fn lp_cred() -> Credential {
  Script(#"61")
}

fn at(cred: Credential) -> Address {
  Address { payment_credential: cred, stake_credential: None }
}

fn pool_nft(policy: PolicyId, id: ByteArray) -> Asset {
  Asset { policy, name: thread_asset_name(role_pool, id) }
}

fn pool_cfg(nft: Asset, key: ByteArray, nonce: Int) -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: nft,
    pool_x: Asset { policy: ada_policy_id, name: ada_asset_name },
    pool_y: Asset { policy: #"bb", name: #"746f6b656e" },
    pool_lq: Asset { policy: #"cc", name: #"6c71" },
    fee_num: 99_700,
    treasury_fee: 100,
    royalty_fee: 1_000,
    treasury_x: 0,
    treasury_y: 0,
    royalty_x: 0,
    royalty_y: 0,
    dao_policy: [],
    treasury_address: #"ee",
    royalty_pub_key: key,
    nonce,
  }
}

fn pool_value(nft: Asset) -> assets.Value {
  assets.from_lovelace(100_000_000)
    |> assets.add(#"bb", #"746f6b656e", 100_000_000)
    |> assets.add(nft.policy, nft.name, 1)
}

fn cto_datum(state: CtoAnchorState, community: ByteArray) -> CtoGovernanceDatum {
  CtoGovernanceDatum {
    launch_id: launch,
    cto_state: state,
    community_wallet_hash: community,
    governor_credential_hash: #"90",
    total_supply: 1_000_000_000,
    quorum_bps: 500,
    creator_vote_cap_bps: 100,
    min_voter_count: 15,
    active_proposal: None,
    proposal_count: 1,
    last_executed_proposal: None,
    pending_relayer_bond: 0,
    pending_relayer_key_hash: #"",
    payout_pub_key_hash: #"91",
    thread_nft_policy: thread_policy,
    ballot_duration: 259_200_000,
    last_ballot_end_timestamp: 0,
  }
}

fn lp_datum(id: ByteArray) -> LpEscrowDatum {
  LpEscrowDatum {
    launch_id: id,
    lock_timestamp: 0,
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
    lp_token_policy_id: #"",
    lp_token_name: #"",
    lp_token_amount: 0,
    cto_governance_credential: cto_cred(),
    thread_nft_policy: thread_policy,
    last_migration_timestamp: 0,
  }
}

fn record(cred: Credential, value: assets.Value, datum: Data) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"cd", output_index: 0 },
    output: Output {
      address: at(cred),
      value,
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

fn with_nft(role: ByteArray, id: ByteArray) -> assets.Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(thread_policy, thread_asset_name(role, id), 1)
}

fn cto_record(state: CtoAnchorState, community: ByteArray) -> Input {
  record(
    cto_cred(),
    with_nft(role_cto_governance, launch),
    cto_datum(state, community),
  )
}

fn lp_record() -> Input {
  record(lp_cred(), with_nft(role_lp_escrow, launch), lp_datum(launch))
}

fn pool_input(nft: Asset, key: ByteArray, tx_id: ByteArray) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: tx_id, output_index: 0 },
    output: Output {
      address: at(Script(#"0a")),
      value: pool_value(nft),
      datum: InlineDatum(pool_cfg(nft, key, 3)),
      reference_script: None,
    },
  }
}

fn pool_output(nft: Asset, new_key: ByteArray) -> Output {
  Output {
    address: at(Script(#"0a")),
    value: pool_value(nft),
    datum: InlineDatum(pool_cfg(nft, new_key, 4)),
    reference_script: None,
  }
}

fn tx(
  nft: Asset,
  old_key: ByteArray,
  new_key: ByteArray,
  refs: List<Input>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_input(nft, old_key, #"01")],
    outputs: [pool_output(nft, new_key)],
    reference_inputs: refs,
  }
}

fn run(redeemer: RedirectAction, t: Transaction) -> Bool {
  redirect.withdraw(
    thread_policy,
    factory_policy,
    cto_cred(),
    lp_cred(),
    redeemer,
    Script(#"99"),
    t,
  )
}

fn our_pool() -> Asset {
  pool_nft(factory_policy, launch)
}

fn triggered() -> Input {
  cto_record(CTOTriggered, blake2b_224(community_key))
}

fn dissolved() -> Input {
  cto_record(CTODissolved, #"")
}

test takeover_moves_the_key_to_the_community_wallet() {
  run(
    Takeover { pool_in_ix: 0 },
    tx(our_pool(), creator_key, community_key, [triggered()]),
  )
}

test dissolve_moves_the_key_back_to_the_creator() {
  run(
    Dissolve { pool_in_ix: 0 },
    tx(our_pool(), community_key, creator_key, [dissolved(), lp_record()]),
  )
}

/// The wallet field is set here on purpose: with the state alone wrong, the
/// state check is the only thing that rejects.
test takeover_before_any_vote_fails() fail {
  run(
    Takeover { pool_in_ix: 0 },
    tx(
      our_pool(),
      creator_key,
      community_key,
      [cto_record(PreCTO, blake2b_224(community_key))],
    ),
  )
}

test takeover_to_a_key_other_than_the_community_wallet_fails() fail {
  run(
    Takeover { pool_in_ix: 0 },
    tx(our_pool(), creator_key, stranger_key, [triggered()]),
  )
}

test takeover_after_a_dissolve_fails() fail {
  run(
    Takeover { pool_in_ix: 0 },
    tx(
      our_pool(),
      creator_key,
      community_key,
      [cto_record(CTODissolved, blake2b_224(community_key))],
    ),
  )
}

test takeover_while_the_community_wallet_is_frozen_fails() fail {
  run(
    Takeover { pool_in_ix: 0 },
    tx(our_pool(), creator_key, community_key, [cto_record(CTOTriggered, #"")]),
  )
}

test takeover_from_a_record_without_the_thread_nft_fails() fail {
  let forged = record(
    cto_cred(),
    assets.from_lovelace(2_000_000),
    cto_datum(CTOTriggered, blake2b_224(community_key)),
  )
  run(
    Takeover { pool_in_ix: 0 },
    tx(our_pool(), creator_key, community_key, [forged]),
  )
}

test takeover_of_a_pool_of_another_launch_fails() fail {
  run(
    Takeover { pool_in_ix: 0 },
    tx(
      pool_nft(factory_policy, other_launch),
      creator_key,
      community_key,
      [triggered()],
    ),
  )
}

/// A pool whose NFT is named exactly right but minted under a policy that is
/// not the factory's, presented against the genuine governance record, so
/// only the policy comparison rejects it.
test takeover_under_a_foreign_policy_fails() fail {
  run(
    Takeover { pool_in_ix: 0 },
    tx(pool_nft(#"7f", launch), creator_key, community_key, [triggered()]),
  )
}

test takeover_with_two_pools_in_one_transaction_fails() fail {
  let second = pool_input(
    pool_nft(factory_policy, other_launch),
    creator_key,
    #"02",
  )
  let base = tx(our_pool(), creator_key, community_key, [triggered()])
  run(
    Takeover { pool_in_ix: 0 },
    Transaction {
      ..base,
      inputs: [pool_input(our_pool(), creator_key, #"01"), second],
    },
  )
}

test dissolve_to_the_community_key_fails() fail {
  run(
    Dissolve { pool_in_ix: 0 },
    tx(our_pool(), community_key, stranger_key, [dissolved(), lp_record()]),
  )
}

test dissolve_while_still_triggered_fails() fail {
  run(
    Dissolve { pool_in_ix: 0 },
    tx(our_pool(), community_key, creator_key, [triggered(), lp_record()]),
  )
}

test dissolve_with_an_escrow_without_the_thread_nft_fails() fail {
  let forged = record(
    lp_cred(),
    assets.from_lovelace(2_000_000),
    lp_datum(launch),
  )
  run(
    Dissolve { pool_in_ix: 0 },
    tx(our_pool(), community_key, creator_key, [dissolved(), forged]),
  )
}

/// Carries our launch's escrow NFT with another launch's datum, so only the
/// launch id comparison rejects it.
test dissolve_with_the_escrow_of_another_launch_fails() fail {
  let other = record(
    lp_cred(),
    with_nft(role_lp_escrow, launch),
    lp_datum(other_launch),
  )
  run(
    Dissolve { pool_in_ix: 0 },
    tx(our_pool(), community_key, creator_key, [dissolved(), other]),
  )
}
