// ============================================================================
// Noctis Zone — cross-contract settlement tests
// ============================================================================
// This module declares no validator. It exists because a validator module may
// not import another validator module, so no single contract's own test suite
// can hand ONE transaction to TWO validators and see what both make of it.
//
// Every check a validator performs is scoped to that validator. A payout
// check that asks only "does some output in this transaction pay R at least
// N?" is answered by the whole transaction, and two contracts that happen to
// owe the same wallet the same amount both read the same answer from the same
// output. No per-contract restriction can see that — each is looking only at
// its own inputs — so it has to be tested from outside both, which is what
// this module is for.
//
// The rule these pin: a settlement output NAMES the input it settles, by
// carrying that input's own OutputReference as its datum. An OutputReference
// is unique across the chain by construction, so two settlements can never
// ask for the same tag and one output can never answer both.

use aiken/collection/list
use aiken/interval
use cardano/address.{from_verification_key}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use noctis/stake_accumulator
use noctis/staking_pool_datum
use noctis/thread_nft
use staking_pool
use vesting

// ============================================================================
// SHARED FIXTURE
// ============================================================================

const launch_id = #"01"

const token_policy = #"33"

const nft_policy = #"c0ffee"

/// The creator of this launch also stakes in it — one wallet, two
/// entitlements, which is ordinary and expected rather than contrived.
const creator = #"11"

const pool_script = #"cc"

const vesting_script = #"ce"

/// Both contracts pay out the SAME launch token: the staking pool is seeded
/// from the launch's own supply at graduation, and the creator's vesting
/// allocation is carved from that same supply.
const settled_amount = 100

fn pool_nft() -> assets.Value {
  assets.from_asset(
    nft_policy,
    thread_nft.thread_asset_name(thread_nft.role_staking_pool, launch_id),
    1,
  )
}

fn vesting_nft() -> assets.Value {
  assets.from_asset(
    nft_policy,
    thread_nft.thread_asset_name(thread_nft.role_vesting, launch_id),
    1,
  )
}

/// Chosen so the creator's position is owed exactly `settled_amount`:
/// `1_000 * acc / acc_scale == 100` with a zero debt.
const pool_acc = 100_000_000_000

const pool_stake = 1_000

fn creator_position() -> stake_accumulator.Position {
  stake_accumulator.Position { amount: pool_stake, debt: 0, since: 0 }
}

/// An EXHAUSTED pool, deliberately: with nothing left to emit, `advance` is a
/// no-op and the accumulator holds still across the transaction. What is being
/// tested here is the payout, so the emission arithmetic is kept out of it.
fn pool_datum() -> staking_pool_datum.StakingPoolDatum {
  staking_pool_datum.StakingPoolDatum {
    launch_id: launch_id,
    creator_pub_key_hash: creator,
    token_policy_id: token_policy,
    token_asset_name: "tok",
    thread_nft_policy: nft_policy,
    emission_per_day: 3_650,
    stake_root: stake_accumulator.root_of([(creator, creator_position())]),
    acc_reward_per_token: pool_acc,
    total_staked: pool_stake,
    unallocated: 0,
    last_update_ms: 0,
    exhausted_at: Some(0),
  }
}

fn vesting_datum() -> vesting.VestingDatum {
  vesting.VestingDatum {
    launch_id: launch_id,
    creator_pub_key_hash: creator,
    governor_pub_key_hash: #"22",
    token_allocation: 100_000_000,
    vest_days: 90,
    vesting_state: vesting.Vesting,
    claimed_tokens: 0,
    vest_start_timestamp: 0,
    cto_triggered: False,
    community_treasury_wallet: #"",
    token_policy_id: token_policy,
    token_asset_name: "tok",
    cto_governance_credential: from_verification_key(#"aa").payment_credential,
    last_claimed_allocation_timestamp: 0,
    thread_nft_policy: nft_policy,
  }
}

const pool_ref = OutputReference { transaction_id: #"00", output_index: 0 }

const vesting_ref = OutputReference { transaction_id: #"00", output_index: 1 }

/// 45 days into a 90-day vest: half the allocation is vested, so a
/// `settled_amount` claim is well within schedule and nothing about this
/// transaction is unusual apart from the two spends sharing a payout.
const claim_time = 45 * 86_400_000

/// One transaction spending BOTH contracts' state UTXOs, with the payout
/// outputs the caller supplies. Everything else — both continuing outputs,
/// both thread NFTs, the signature, the validity range — is exactly what each
/// contract's own happy path requires, so any rejection comes from the payout
/// and from nothing else.
fn settlement_tx(payouts: List<Output>) -> Transaction {
  let pool_address = from_verification_key(pool_script)
  let vesting_address = from_verification_key(vesting_script)

  let pool_input =
    Input {
      output_reference: pool_ref,
      output: Output {
        address: pool_address,
        value: assets.merge(
          pool_nft(),
          assets.merge(
            assets.from_lovelace(2_000_000),
            assets.from_asset(token_policy, "tok", 1_000),
          ),
        ),
        datum: InlineDatum(pool_datum()),
        reference_script: None,
      },
    }
  let vesting_input =
    Input {
      output_reference: vesting_ref,
      output: Output {
        address: vesting_address,
        value: assets.merge(
          vesting_nft(),
          assets.from_asset(token_policy, "tok", 100_000_000),
        ),
        datum: InlineDatum(vesting_datum()),
        reference_script: None,
      },
    }
  let pool_continuing =
    Output {
      address: pool_address,
      value: assets.merge(
        pool_nft(),
        assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(token_policy, "tok", 1_000 - settled_amount),
        ),
      ),
      datum: InlineDatum(pool_after_claim()),
      reference_script: None,
    }
  let vesting_continuing =
    Output {
      address: vesting_address,
      value: assets.merge(
        vesting_nft(),
        assets.from_asset(
          token_policy,
          "tok",
          100_000_000 - settled_amount,
        ),
      ),
      datum: InlineDatum(
        vesting.VestingDatum { ..vesting_datum(), claimed_tokens: settled_amount },
      ),
      reference_script: None,
    }

  Transaction {
    ..placeholder,
    inputs: [pool_input, vesting_input],
    outputs: list.concat([pool_continuing, vesting_continuing], payouts),
    extra_signatories: [creator],
    validity_range: interval.between(claim_time - 100, claim_time + 100),
  }
}

/// A settlement output paying the creator, naming `settles`.
fn payout(settles: Data) -> Output {
  Output {
    address: from_verification_key(creator),
    value: assets.from_asset(token_policy, "tok", settled_amount),
    datum: InlineDatum(settles),
    reference_script: None,
  }
}

/// The pool as this claim leaves it: the position's debt rewritten to the
/// accumulator it was just settled at, and the clock moved to `now`.
fn pool_after_claim() -> staking_pool_datum.StakingPoolDatum {
  let entries = [(creator, creator_position())]
  let settled =
    stake_accumulator.Position {
      ..creator_position(),
      debt: staking_pool.debt_at(pool_stake, pool_acc),
    }
  let (_, stake_root) =
    stake_accumulator.transition(
      pool_datum().stake_root,
      creator,
      creator_position(),
      settled,
      stake_accumulator.proof_in(creator, entries),
    )
  staking_pool_datum.StakingPoolDatum {
    ..pool_datum(),
    stake_root: stake_root,
    last_update_ms: claim_time - 100,
  }
}

fn claim_rewards() -> staking_pool.StakingPoolRedeemer {
  staking_pool.ClaimRewards {
    staker_vkh: creator,
    before: creator_position(),
    proof: stake_accumulator.proof_in(creator, [(creator, creator_position())]),
  }
}

fn claim_vested() -> vesting.VestingRedeemer {
  vesting.ClaimVested {
    claim_amount: settled_amount,
    current_timestamp: claim_time,
  }
}

fn pool_accepts(self: Transaction) -> Bool {
  staking_pool.staking_pool.spend(
    Some(pool_datum()),
    claim_rewards(),
    pool_ref,
    self,
  )
}

fn vesting_accepts(self: Transaction) -> Bool {
  vesting.vesting.spend(
    Some(vesting_datum()),
    claim_vested(),
    vesting_ref,
    self,
  )
}

// ============================================================================
// TESTS
// ============================================================================

/// The shape this module exists for. ONE payout output, correctly addressed
/// and correctly sized, offered to two contracts that each owe the creator
/// `settled_amount`. Both scripts release their tokens; only one payment is
/// made; the difference is free. At most one contract may read this output as
/// its own settlement.
test one_output_cannot_settle_two_contracts() {
  let self = settlement_tx([payout(pool_ref)])
  !and {
    pool_accepts(self),
    vesting_accepts(self),
  }
}

/// The same transaction from the other side: a payout naming the vesting
/// input must not also answer the staking pool.
test one_output_cannot_settle_two_contracts_either_way() {
  let self = settlement_tx([payout(vesting_ref)])
  !and {
    pool_accepts(self),
    vesting_accepts(self),
  }
}

/// Both settled properly — two payouts, each naming its own input — is
/// accepted by both. Without this, the tests above would pass just as well
/// against a validator that refused everything.
test two_named_outputs_settle_both_contracts() {
  let self = settlement_tx([payout(pool_ref), payout(vesting_ref)])
  and {
    pool_accepts(self),
    vesting_accepts(self),
  }
}

/// A payout that is real, correctly addressed and correctly sized but names
/// neither input settles neither.
test an_untagged_payout_settles_nothing() {
  let self =
    settlement_tx(
      [
        Output {
          address: from_verification_key(creator),
          value: assets.from_asset(token_policy, "tok", settled_amount),
          datum: NoDatum,
          reference_script: None,
        },
      ],
    )
  !or {
    pool_accepts(self),
    vesting_accepts(self),
  }
}
