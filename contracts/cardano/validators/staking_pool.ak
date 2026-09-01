// ============================================================================
// Noctis Zone — Staking Rewards Pool
// ============================================================================
// Optional per-launch feature on a Cardano launch. A creator allocates a fixed
// STAKING_ALLOC_PCT of supply at launch creation and commits to a runway;
// `Graduate` seeds this pool on exactly those terms, alongside LP.
//
// ONE POOL, ONE ADDRESS, EVERY CARDANO LAUNCH
// This validator is unparameterized and takes no per-launch arguments, so
// every Cardano launch's pool is the same script at the same address, told
// apart only by its thread NFT. A launch that runs a DarkVeil phase and one
// that does not stake, claim, exit and close through exactly this code — the
// private phase changes how a launch sells, not how it rewards.
//
// Both curve validators seed it, and that is a fact about the curves rather
// than about staking: they price differently (see each one's own header), so
// they are separate scripts, and each calls the same seeding check to open the
// same shared pool.
//
// WHAT THIS CONTRACT PROMISES
// Once seeded, nobody decides anything. There is no governor here, no
// published snapshot, no privileged signature on any reward path, and no field
// anybody may set by hand. What a staker is owed is computed by this validator
// from elapsed time and the stake that was actually present, and the only
// writer of any state below is this validator's own arithmetic.
//
// THE ACCUMULATOR
// Rewards accrue continuously, not in daily buckets, at a rate fixed when the
// pool opened. Any spend advances the pool to the present first:
//
//   elapsed = now - last_update_ms
//   emitted = min(emission_per_day * elapsed / ms_per_day, unallocated)
//   acc     = acc + emitted * acc_scale / total_staked
//
// `acc` is "reward per token staked, ever" — monotonic, scaled so integer
// division does not lose it. A position records that figure when it last
// moved, as `debt`; what it is owed now is `amount * acc / acc_scale - debt`.
//
// Two properties fall out of the shape rather than being enforced separately.
// With `total_staked == 0` nothing is emitted at all, so a stretch with no
// stakers costs the budget nothing and moves the end date later — the runway
// is a budget of emission, not a deadline. And `unallocated` is the only
// stopping condition, so a top-up buys more days at the same rate rather than
// a faster rate.
//
// WHY POSITIONS ARE NOT UTXOs
// They used to be, and that was safe only while rewards were computed off
// chain: the datum was a hint, and the real weight came from tokens the output
// actually held. Once this validator computes the payout, `debt` is what
// decides it — and paying a UTXO to a script address runs no validator, so any
// stranger could author a position with a large stake and a zero debt.
// Requiring the output to really hold its stake does not help, because `debt`
// is not a quantity of anything.
//
// So positions live behind one 32-byte root in this datum, written only here.
// See noctis/stake_accumulator. Staked tokens sit in the pool UTXO with the
// reward budget; `total_staked` says how much of the balance is whose.
//
// ONE UTXO, AND WHAT THAT COSTS
// Every stake, claim, exit and top-up spends the one pool UTXO, so they
// serialise. That is the same shape the bonding curve has, and it has the same
// answer: an order/batcher front (see curve_order.ak) folds many actions into
// one spend without being able to redirect any of them.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, from_verification_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use noctis/cap_accumulator.{CapProofStep}
use noctis/settlement
use noctis/stake_accumulator.{Position, no_position}
use noctis/staking_pool_datum.{StakingPoolDatum}
use noctis/thread_nft

// ============================================================================
// CONSTANTS
// ============================================================================

/// Fixed-point scale for `acc_reward_per_token`.
///
/// `acc` grows by `emitted * acc_scale / total_staked`, and that division is
/// what would otherwise floor a small emission against a large stake to
/// nothing at all. At 1e12 an emission is lost only if it is smaller than a
/// trillionth of the total staked, which a 1B-token supply cannot reach.
pub const acc_scale = 1_000_000_000_000

pub const ms_per_day = 86_400_000

/// STAKING_BONDING_PERIOD_DAYS, as a lock on LEAVING rather than on earning.
///
/// Under a daily snapshot it had to be a gap in earning, because the thing to
/// prevent was staking just before a snapshot and leaving just after. Accrual
/// is continuous now — a second staked earns a second's worth — so there is no
/// snapshot to arrive just before, and that reason is gone. Kept as a real
/// minimum commitment, which is what it now is: adding to a position restarts
/// it, claiming does not touch it.
pub const unstake_lock_ms = 604_800_000

/// STAKING_CLAIM_FEE_USD, as a floor rather than a peg.
///
/// Aiken has no in-circuit oracle, so a contract cannot know what a dollar is
/// worth. This is the same deliberately conservative sanity floor both bonding
/// curves already charge on a fee claim, at the same value: the real
/// dollar-equivalent is computed off-chain from `integration/ada-usd-price.ts`
/// and paid with margin above it in the normal case, while this refuses a
/// claim that pays nothing at all.
///
/// It has to live on chain rather than in the submitter, because `ClaimRewards`
/// takes no signature — see `platform_fee_paid`. A charge only the submitter
/// applies is a charge anyone can decline by building their own transaction.
pub const min_platform_claim_fee_lovelace = 200_000

/// How long an exhausted pool waits for a top-up before it can be retired.
pub const close_cooldown_ms = 7_776_000_000

/// Max validity-range width for any spend here. Every redeemer reads the
/// clock, so all of them carry it — same bound and same reason as the curve
/// validators': the range's lower bound is taken as "now", and a transaction
/// free to declare a wide range is free to declare a favourable one.
pub const max_validity_range_width = 600_000

// ============================================================================
// TYPES
// ============================================================================

// The datum itself lives in `noctis/staking_pool_datum`, because the bonding
// curves have to WRITE it: `Graduate` is permissionless, so whoever submits a
// graduation authors this pool's first datum, and a validator module may not
// import another validator module. That module's `genesis` is the only shape a
// graduation may open a pool in, and its doc comment says why each field is
// pinned. The field-by-field meaning is below.
//
//   launch_id, creator_pub_key_hash, token_policy_id, token_asset_name,
//   thread_nft_policy — this launch's identity. `creator_pub_key_hash` is
//     where the residue goes when an exhausted pool is finally retired, and is
//     not an authority over anything: no redeemer here checks its signature.
//   emission_per_day — set once, at seeding, from the runway the creator
//     committed to at launch creation. No redeemer changes it, TopUpPool
//     included, which is exactly what makes a top-up extend the runway rather
//     than accelerate it.
//   stake_root — every staker's position, behind one root. See
//     noctis/stake_accumulator.
//   acc_reward_per_token — reward per token staked, ever, scaled by
//     `acc_scale`. Monotonic.
//   total_staked — sum of every open position's `amount`. The rest of the
//     token balance is reward budget.
//   unallocated — reward tokens not yet credited to anyone. The only stopping
//     condition.
//   last_update_ms — when the accumulator was last advanced.
//   exhausted_at — when `unallocated` first reached zero. A top-up clears it.

pub type StakingPoolRedeemer {
  /// Open or add to a position. Anything already owed is COMPOUNDED into the
  /// stake rather than paid out — those tokens are already in this UTXO, so
  /// nothing has to move for it. Restarts the unstake lock.
  Stake {
    staker_vkh: VerificationKeyHash,
    before: Position,
    proof: List<CapProofStep>,
    add_amount: Int,
  }
  /// Close a position: the stake and everything owed on it, out. Staker-signed,
  /// and only once the lock has elapsed.
  Unstake {
    staker_vkh: VerificationKeyHash,
    before: Position,
    proof: List<CapProofStep>,
  }
  /// Take what is owed and leave the position open. Permissionless — the
  /// payout can only reach `staker_vkh`'s own address, so submitting somebody
  /// else's claim gains nothing and costs a fee.
  ClaimRewards {
    staker_vkh: VerificationKeyHash,
    before: Position,
    proof: List<CapProofStep>,
  }
  /// Add to the reward budget. Permissionless: a pool anyone may top up is
  /// strictly better than one only its creator may, and there is nothing to
  /// gain by giving a pool tokens.
  TopUpPool { amount: Int }
  /// Retire an exhausted pool nobody topped up. Permissionless — the
  /// conditions are the authorization, same idiom as the curve's Graduate.
  ClosePool
}

// ============================================================================
// HELPERS
// ============================================================================

/// "Now", as the validity range's lower bound, once the range is narrow enough
/// for that to mean anything.
///
/// The lower bound rather than the upper: accrual grows with elapsed time, so
/// reading the far end of a range would let a spender accrue against time that
/// has not passed. Bounding the width then closes the opposite trick, pinning
/// `last_update_ms` in the past to stall everyone's accrual.
fn range_now(range: Interval) -> Option<Int> {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      if hi >= lo && hi - lo <= max_validity_range_width {
        Some(lo)
      } else {
        None
      }
    _ -> None
  }
}

/// Advance the pool to `now`: what `acc_reward_per_token` and `unallocated`
/// become. Pure, and the only place emission is ever computed.
pub fn advance(pool: StakingPoolDatum, now: Int) -> (Int, Int) {
  let elapsed = now - pool.last_update_ms
  if or {
    elapsed <= 0,
    pool.total_staked <= 0,
    pool.unallocated <= 0,
  } {
    // Nothing to emit, or nobody to emit to. In the second case the budget is
    // deliberately untouched: a quiet stretch moves the end date later rather
    // than burning tokens nobody received.
    (pool.acc_reward_per_token, pool.unallocated)
  } else {
    let raw = pool.emission_per_day * elapsed / ms_per_day
    let emitted =
      if raw > pool.unallocated {
        pool.unallocated
      } else {
        raw
      }
    (
      pool.acc_reward_per_token + emitted * acc_scale / pool.total_staked,
      pool.unallocated - emitted,
    )
  }
}

/// What a position is owed at `acc`.
///
/// Never negative: `acc` only rises, `debt` was this same expression at some
/// earlier `acc`, and `amount` has not changed since — every change to
/// `amount` rewrites `debt` in the same breath.
pub fn owed_at(pos: Position, acc: Int) -> Int {
  pos.amount * acc / acc_scale - pos.debt
}

/// The debt a position of `amount` carries from `acc` onward.
pub fn debt_at(amount: Int, acc: Int) -> Int {
  amount * acc / acc_scale
}

/// `exhausted_at` after this spend: stamped the first time the budget empties,
/// and never re-stamped while it stays empty.
fn exhausted_after(
  pool: StakingPoolDatum,
  unallocated: Int,
  now: Int,
) -> Option<Int> {
  when (unallocated, pool.exhausted_at) is {
    (0, None) -> Some(now)
    _ -> pool.exhausted_at
  }
}

/// The pool's thread NFT is on the spent input, and on the continuing output
/// when there is one.
fn thread_nft_ok(
  own_input: Input,
  own_outputs: List<Output>,
  pool: StakingPoolDatum,
) -> Bool {
  let name =
    thread_nft.thread_asset_name(thread_nft.role_staking_pool, pool.launch_id)
  let held =
    assets.quantity_of(own_input.output.value, pool.thread_nft_policy, name)
  when own_outputs is {
    [] -> held == 1
    [out] -> and {
        held == 1,
        assets.quantity_of(out.value, pool.thread_nft_policy, name) == 1,
      }
    _ -> False
  }
}

/// Lovelace, the launch token, and the thread NFT. Nothing else may be parked
/// in a long-lived UTXO that permissionless redeemers can spend.
fn output_value_clean(output: Output) -> Bool {
  list.length(assets.flatten(output.value)) <= 3
}

fn tokens_in(value: assets.Value, pool: StakingPoolDatum) -> Int {
  assets.quantity_of(value, pool.token_policy_id, pool.token_asset_name)
}

/// Pay `amount` of the launch token to `staker_vkh`, settled against this
/// input.
///
/// Two checks, not one. The tag says WHICH obligation an output discharges, so
/// one payment cannot answer two. The netting says the staker is genuinely
/// better off, since an output at their own credential is also what their
/// CHANGE looks like. See noctis/settlement for both in full.
/// The flat charge on a claim, paid to the governor the pool was opened with.
///
/// Netted, not merely tagged, for exactly the reason `staker_paid` nets: an
/// output addressed to the governor proves nothing on its own, because a
/// builder can spend a UTXO the governor already holds and hand it straight
/// back tagged. Only lovelace that really arrived from elsewhere counts.
///
/// A consequence worth stating: a transaction the governor itself funds cannot
/// satisfy this, since its own fee outlay nets against what it receives. The
/// claimer pays the charge, which is who it is a charge on.
fn platform_fee_paid(
  self: Transaction,
  own_ref: OutputReference,
  governor_vkh: VerificationKeyHash,
) -> Bool {
  let credential = from_verification_key(governor_vkh).payment_credential
  and {
    list.any(
      self.outputs,
      fn(output) {
        and {
          settlement.settles(output, own_ref),
          output.address.payment_credential == credential,
        }
      },
    ),
    settlement.net_lovelace_gain(self, credential) >= min_platform_claim_fee_lovelace,
  }
}

fn staker_paid(
  self: Transaction,
  own_ref: OutputReference,
  pool: StakingPoolDatum,
  staker_vkh: VerificationKeyHash,
  amount: Int,
) -> Bool {
  let credential = from_verification_key(staker_vkh).payment_credential
  and {
    list.any(
      self.outputs,
      fn(output) {
        and {
          settlement.settles(output, own_ref),
          output.address.payment_credential == credential,
          tokens_in(output.value, pool) >= amount,
        }
      },
    ),
    settlement.net_asset_gain(
      self,
      credential,
      pool.token_policy_id,
      pool.token_asset_name,
    ) >= amount,
  }
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator staking_pool {
  spend(
    datum_opt: Option<StakingPoolDatum>,
    redeemer: StakingPoolRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(pool) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    // Compared by PAYMENT credential, never by the full Address: the staking
    // part is chosen freely by whoever builds an output, so two UTXOs at this
    // same script can carry different delegation keys while being equally ours.
    let own_payment = own_input.output.address.payment_credential
    let own_inputs =
      list.filter(
        self.inputs,
        fn(input) { input.output.address.payment_credential == own_payment },
      )
    let own_outputs =
      list.filter(
        self.outputs,
        fn(output) { output.address.payment_credential == own_payment },
      )

    when range_now(self.validity_range) is {
      None -> False
      Some(now) -> and {
          // Exactly one pool UTXO in, and never two. Positions are not UTXOs
          // any more, so there is nothing else of ours a transaction could
          // legitimately spend — and two state UTXOs in one transaction is the
          // shape that lets one output satisfy two obligations at once.
          list.length(own_inputs) == 1,
          thread_nft_ok(own_input, own_outputs, pool),
          // Time only moves forward, so no spend can rewind the accumulator.
          now >= pool.last_update_ms,
          when redeemer is {
            Stake { staker_vkh, before, proof, add_amount } -> {
              let (acc, unallocated) = advance(pool, now)
              let owed = owed_at(before, acc)
              let amount = before.amount + add_amount + owed
              let after =
                Position { amount, debt: debt_at(amount, acc), since: now }
              let (proof_ok, stake_root) =
                stake_accumulator.transition(
                  pool.stake_root,
                  staker_vkh,
                  before,
                  after,
                  proof,
                )
              let expected =
                StakingPoolDatum {
                  ..pool,
                  stake_root: stake_root,
                  acc_reward_per_token: acc,
                  total_staked: pool.total_staked + add_amount + owed,
                  unallocated: unallocated,
                  last_update_ms: now,
                  exhausted_at: exhausted_after(pool, unallocated, now),
                }

              when own_outputs is {
                [own_output] -> and {
                    add_amount > 0,
                    // Nothing to earn, so nothing to stake for — and, before
                    // graduation tops the pool up, a stake here would move
                    // `total_staked` and `stake_root` off the opening values
                    // the curve's seeding check pins. One griefing stake would
                    // otherwise strand the launch's whole staking reserve.
                    // After exhaustion it says the same thing for the same
                    // reason: there is no budget left to earn from.
                    pool.unallocated > 0,
                    // The staker's own decision, and the one thing here that
                    // needs their consent: it restarts their lock.
                    list.has(self.extra_signatories, staker_vkh),
                    proof_ok,
                    // Only the stake arrives. Anything owed was already in
                    // this UTXO as budget and merely changes which side of
                    // `total_staked` it sits on, so no reward token moves.
                    tokens_in(own_output.value, pool) == tokens_in(
                      own_input.output.value,
                      pool,
                    ) + add_amount,
                    own_output.datum == InlineDatum(expected),
                    output_value_clean(own_output),
                  }
                _ -> False
              }
            }

            Unstake { staker_vkh, before, proof } -> {
              let (acc, unallocated) = advance(pool, now)
              let owed = owed_at(before, acc)
              let payout = before.amount + owed
              let (proof_ok, stake_root) =
                stake_accumulator.transition(
                  pool.stake_root,
                  staker_vkh,
                  before,
                  no_position,
                  proof,
                )
              let expected =
                StakingPoolDatum {
                  ..pool,
                  stake_root: stake_root,
                  acc_reward_per_token: acc,
                  total_staked: pool.total_staked - before.amount,
                  unallocated: unallocated,
                  last_update_ms: now,
                  exhausted_at: exhausted_after(pool, unallocated, now),
                }

              when own_outputs is {
                [own_output] -> and {
                    before.amount > 0,
                    list.has(self.extra_signatories, staker_vkh),
                    now >= before.since + unstake_lock_ms,
                    proof_ok,
                    tokens_in(own_output.value, pool) == tokens_in(
                      own_input.output.value,
                      pool,
                    ) - payout,
                    staker_paid(self, own_ref, pool, staker_vkh, payout),
                    own_output.datum == InlineDatum(expected),
                    output_value_clean(own_output),
                  }
                _ -> False
              }
            }

            ClaimRewards { staker_vkh, before, proof } -> {
              let (acc, unallocated) = advance(pool, now)
              let owed = owed_at(before, acc)
              let after =
                Position {
                  amount: before.amount,
                  debt: debt_at(before.amount, acc),
                  // Untouched: taking rewards is not a new commitment, so it
                  // neither restarts the lock nor extends it.
                  since: before.since,
                }
              let (proof_ok, stake_root) =
                stake_accumulator.transition(
                  pool.stake_root,
                  staker_vkh,
                  before,
                  after,
                  proof,
                )
              let expected =
                StakingPoolDatum {
                  ..pool,
                  stake_root: stake_root,
                  acc_reward_per_token: acc,
                  unallocated: unallocated,
                  last_update_ms: now,
                  exhausted_at: exhausted_after(pool, unallocated, now),
                }

              when own_outputs is {
                [own_output] -> and {
                    before.amount > 0,
                    // Nothing owed is nothing to do. Without this, anyone
                    // could spend the pool UTXO repeatedly to no effect.
                    owed > 0,
                    proof_ok,
                    tokens_in(own_output.value, pool) == tokens_in(
                      own_input.output.value,
                      pool,
                    ) - owed,
                    staker_paid(self, own_ref, pool, staker_vkh, owed),
                    platform_fee_paid(self, own_ref, pool.governor_pub_key_hash),
                    own_output.datum == InlineDatum(expected),
                    output_value_clean(own_output),
                  }
                _ -> False
              }
            }

            TopUpPool { amount } -> {
              // Advanced FIRST, so arriving tokens are not retroactively
              // emitted across time that passed before they were here.
              let (acc, unallocated) = advance(pool, now)
              let expected =
                StakingPoolDatum {
                  ..pool,
                  acc_reward_per_token: acc,
                  unallocated: unallocated + amount,
                  last_update_ms: now,
                  // Revived. If this budget is exhausted in turn, the cooldown
                  // starts again from scratch.
                  exhausted_at: None,
                }

              when own_outputs is {
                [own_output] -> and {
                    amount > 0,
                    tokens_in(own_output.value, pool) == tokens_in(
                      own_input.output.value,
                      pool,
                    ) + amount,
                    own_output.datum == InlineDatum(expected),
                    output_value_clean(own_output),
                  }
                _ -> False
              }
            }

            ClosePool -> {
              let cooled_down =
                when pool.exhausted_at is {
                  Some(at) -> now >= at + close_cooldown_ms
                  None -> False
                }
              let creator =
                from_verification_key(pool.creator_pub_key_hash).payment_credential

              and {
                cooled_down,
                // Every position closed, and closing one pays out everything
                // it was owed — so nothing here belongs to a staker. One who
                // has not come back simply keeps the pool open, which costs
                // nobody anything.
                pool.total_staked == 0,
                // No reward token left either: the budget is spent and every
                // credited reward claimed. What remains is the min-ADA and the
                // thread NFT.
                tokens_in(own_input.output.value, pool) == 0,
                // The pool stops existing rather than continuing empty.
                list.length(own_outputs) == 0,
                list.any(
                  self.outputs,
                  fn(output) {
                    and {
                      settlement.settles(output, own_ref),
                      output.address.payment_credential == creator,
                      assets.without_lovelace(output.value) == assets.without_lovelace(
                        own_input.output.value,
                      ),
                    }
                  },
                ),
              }
            }
          },
        }
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

const staker: VerificationKeyHash = #"dd"

const other: VerificationKeyHash = #"ee"

const creator: VerificationKeyHash = #"11"

const governor: VerificationKeyHash = #"9f"

const token_policy: PolicyId = #"33"

const token_name: AssetName = "tok"

const nft_policy: PolicyId = #"c0ffee"

const launch: ByteArray = #"01"

const opened_at: Int = 1_700_000_000_000

fn pool_nft() -> assets.Value {
  assets.from_asset(
    nft_policy,
    thread_nft.thread_asset_name(thread_nft.role_staking_pool, launch),
    1,
  )
}

/// A pool value holding `tokens` of the launch token, plus min-ADA and the
/// thread NFT.
fn pool_value(tokens: Int) -> assets.Value {
  let base = assets.merge(pool_nft(), assets.from_lovelace(2_000_000))
  if tokens == 0 {
    base
  } else {
    assets.merge(base, assets.from_asset(token_policy, token_name, tokens))
  }
}

/// A budget of 3,650,000 over 1,000 days — 3,650 a day, so a day of elapsed
/// time is a round number at every stake size used below.
/// A stake into a pool with no budget is refused — see the redeemer's own
/// comment. Before graduation that is what protects the seeding check; after
/// exhaustion it is simply true.
test stake_is_refused_while_the_pool_holds_no_budget() {
  let pool = StakingPoolDatum { ..mock_pool(), unallocated: 0 }
  !run_stake(pool, 0, no_position, [], 1_000, opened_at, [staker])
}

fn mock_pool() -> StakingPoolDatum {
  StakingPoolDatum {
    launch_id: launch,
    creator_pub_key_hash: creator,
    token_policy_id: token_policy,
    token_asset_name: token_name,
    thread_nft_policy: nft_policy,
    emission_per_day: 3_650,
    stake_root: stake_accumulator.root_of([]),
    acc_reward_per_token: 0,
    total_staked: 0,
    unallocated: 3_650_000,
    last_update_ms: opened_at,
    exhausted_at: None,
    governor_pub_key_hash: governor,
  }
}

fn pos(amount: Int, debt: Int, since: Int) -> Position {
  Position { amount, debt, since }
}

fn own_ref() -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: 0 }
}

fn script_address() -> Address {
  from_verification_key(#"cc")
}

fn pool_input(pool: StakingPoolDatum, tokens: Int) -> Input {
  Input {
    output_reference: own_ref(),
    output: Output {
      address: script_address(),
      value: pool_value(tokens),
      datum: InlineDatum(pool),
      reference_script: None,
    },
  }
}

fn pool_output(pool: StakingPoolDatum, tokens: Int) -> Output {
  Output {
    address: script_address(),
    value: pool_value(tokens),
    datum: InlineDatum(pool),
    reference_script: None,
  }
}

/// A payout to `vkh`, tagged as settling the pool input.
fn payout_output(vkh: VerificationKeyHash, tokens: Int) -> Output {
  Output {
    address: from_verification_key(vkh),
    value: assets.from_asset(token_policy, token_name, tokens),
    datum: InlineDatum(own_ref()),
    reference_script: None,
  }
}

/// The claim charge, tagged as settling the pool input like any other payout.
fn fee_output(lovelace: Int) -> Output {
  Output {
    address: from_verification_key(governor),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(own_ref()),
    reference_script: None,
  }
}

fn tx(
  inputs: List<Input>,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
  now: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: inputs,
    outputs: outputs,
    extra_signatories: signers,
    validity_range: interval.between(now, now + 1_000),
  }
}

// -- the accumulator ----------------------------------------------------------

/// The property the whole runway rests on: a quiet stretch costs the budget
/// nothing, so it moves the end date later instead of burning tokens nobody
/// received.
test advance_emits_nothing_when_nobody_is_staked() {
  let (acc, unallocated) = advance(mock_pool(), opened_at + 100 * ms_per_day)
  and {
    acc == 0,
    unallocated == 3_650_000,
  }
}

test advance_emits_a_days_worth_per_day() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let (acc, unallocated) = advance(pool, opened_at + ms_per_day)
  and {
    acc == 3_650 * acc_scale / 1_000,
    unallocated == 3_650_000 - 3_650,
  }
}

/// Half a day emits half a day's worth. There is no bucket to sit inside, so
/// there is no snapshot to arrive just before — which is why the bonding
/// period became a lock on leaving rather than a gap in earning.
test advance_is_continuous_not_daily() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let (acc, _) = advance(pool, opened_at + ms_per_day / 2)
  acc == 1_825 * acc_scale / 1_000
}

/// 2,000 days elapsed against a 1,000-day budget. Real time keeps passing; the
/// budget does not.
test advance_never_emits_more_than_the_budget_holds() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let (_, unallocated) = advance(pool, opened_at + 2_000 * ms_per_day)
  unallocated == 0
}

/// Doubling the budget doubles the runway at the SAME rate — a top-up buys
/// days, it does not accelerate payouts.
test the_budget_is_the_only_stopping_condition() {
  let pool =
    StakingPoolDatum {
      ..mock_pool(),
      total_staked: 1_000,
      unallocated: 7_300_000,
    }
  let (acc_1000, un_1000) = advance(pool, opened_at + 1_000 * ms_per_day)
  let (_, un_2000) = advance(pool, opened_at + 2_000 * ms_per_day)
  and {
    acc_1000 == 3_650_000 * acc_scale / 1_000,
    un_1000 == 3_650_000,
    un_2000 == 0,
  }
}

test owed_is_zero_for_a_position_that_just_moved() {
  let acc = 5 * acc_scale
  owed_at(pos(1_000, debt_at(1_000, acc), opened_at), acc) == 0
}

// -- Stake --------------------------------------------------------------------

/// A Stake transaction with everything the happy path needs, so a rejection
/// can only come from what the caller varied.
fn run_stake(
  pool: StakingPoolDatum,
  pool_tokens: Int,
  before: Position,
  entries: List<(ByteArray, Position)>,
  add: Int,
  now: Int,
  signers: List<VerificationKeyHash>,
) -> Bool {
  let proof = stake_accumulator.proof_in(staker, entries)
  let (acc, unallocated) = advance(pool, now)
  let owed = owed_at(before, acc)
  let amount = before.amount + add + owed
  let after = Position { amount, debt: debt_at(amount, acc), since: now }
  let (_, stake_root) =
    stake_accumulator.transition(pool.stake_root, staker, before, after, proof)
  let next =
    StakingPoolDatum {
      ..pool,
      stake_root: stake_root,
      acc_reward_per_token: acc,
      total_staked: pool.total_staked + add + owed,
      unallocated: unallocated,
      last_update_ms: now,
      exhausted_at: exhausted_after(pool, unallocated, now),
    }
  staking_pool.spend(
    Some(pool),
    Stake { staker_vkh: staker, before, proof, add_amount: add },
    own_ref(),
    tx(
      [pool_input(pool, pool_tokens)],
      [pool_output(next, pool_tokens + add)],
      signers,
      now,
    ),
  )
}

test stake_opens_a_first_position() {
  run_stake(mock_pool(), 3_650_000, no_position, [], 1_000, opened_at, [staker])
}

test stake_requires_the_stakers_signature() {
  !run_stake(mock_pool(), 3_650_000, no_position, [], 1_000, opened_at, [other])
}

test stake_rejects_a_zero_amount() {
  !run_stake(mock_pool(), 3_650_000, no_position, [], 0, opened_at, [staker])
}

/// The forgery the position root exists to stop. `debt` is what decides a
/// payout, so a staker claiming a smaller one than they carry would mint
/// themselves rewards they already drew — and the first Merkle walk is what
/// makes the claimed `before` true rather than merely asserted.
test stake_rejects_an_understated_debt() {
  let real = pos(1_000, 500, opened_at)
  let pool =
    StakingPoolDatum {
      ..mock_pool(),
      total_staked: 1_000,
      stake_root: stake_accumulator.root_of([(staker, real)]),
    }
  !run_stake(
    pool,
    3_650_000,
    pos(1_000, 0, opened_at),
    [(staker, real)],
    100,
    opened_at,
    [staker],
  )
}

// -- Unstake ------------------------------------------------------------------

fn run_unstake(
  pool: StakingPoolDatum,
  pool_tokens: Int,
  before: Position,
  now: Int,
  signers: List<VerificationKeyHash>,
  payout_to: VerificationKeyHash,
) -> Bool {
  let entries = [(staker, before)]
  let proof = stake_accumulator.proof_in(staker, entries)
  let (acc, unallocated) = advance(pool, now)
  let owed = owed_at(before, acc)
  let payout = before.amount + owed
  let (_, stake_root) =
    stake_accumulator.transition(
      pool.stake_root,
      staker,
      before,
      no_position,
      proof,
    )
  let next =
    StakingPoolDatum {
      ..pool,
      stake_root: stake_root,
      acc_reward_per_token: acc,
      total_staked: pool.total_staked - before.amount,
      unallocated: unallocated,
      last_update_ms: now,
      exhausted_at: exhausted_after(pool, unallocated, now),
    }
  staking_pool.spend(
    Some(pool),
    Unstake { staker_vkh: staker, before, proof },
    own_ref(),
    tx(
      [pool_input(pool, pool_tokens)],
      [pool_output(next, pool_tokens - payout), payout_output(payout_to, payout)],
      signers,
      now,
    ),
  )
}

/// A pool with one staker, in from the start.
fn staked_pool() -> (StakingPoolDatum, Position) {
  let before = pos(1_000, 0, opened_at)
  (
    StakingPoolDatum {
      ..mock_pool(),
      total_staked: 1_000,
      stake_root: stake_accumulator.root_of([(staker, before)]),
    },
    before,
  )
}

test unstake_returns_the_stake_and_everything_owed() {
  let (pool, before) = staked_pool()
  run_unstake(pool, 3_651_000, before, opened_at + 8 * ms_per_day, [staker], staker)
}

test unstake_is_refused_before_the_lock_elapses() {
  let (pool, before) = staked_pool()
  !run_unstake(pool, 3_651_000, before, opened_at + 6 * ms_per_day, [staker], staker)
}

test unstake_requires_the_stakers_signature() {
  let (pool, before) = staked_pool()
  !run_unstake(pool, 3_651_000, before, opened_at + 8 * ms_per_day, [other], staker)
}

/// The payout may only reach the staker's own address, whoever built the
/// transaction.
test unstake_cannot_be_redirected() {
  let (pool, before) = staked_pool()
  !run_unstake(pool, 3_651_000, before, opened_at + 8 * ms_per_day, [staker], other)
}

// -- ClaimRewards -------------------------------------------------------------

fn run_claim(
  pool: StakingPoolDatum,
  pool_tokens: Int,
  before: Position,
  now: Int,
  payout_to: VerificationKeyHash,
  extra_inputs: List<Input>,
  extra_outputs: List<Output>,
) -> Bool {
  run_claim_paying(
    pool,
    pool_tokens,
    before,
    now,
    payout_to,
    min_platform_claim_fee_lovelace,
    extra_inputs,
    extra_outputs,
  )
}

/// The same claim with the charge varied. `fee == 0` omits the output
/// entirely, which is the transaction a claimer building their own would
/// produce.
fn run_claim_paying(
  pool: StakingPoolDatum,
  pool_tokens: Int,
  before: Position,
  now: Int,
  payout_to: VerificationKeyHash,
  fee: Int,
  extra_inputs: List<Input>,
  extra_outputs: List<Output>,
) -> Bool {
  let entries = [(staker, before)]
  let proof = stake_accumulator.proof_in(staker, entries)
  let (acc, unallocated) = advance(pool, now)
  let owed = owed_at(before, acc)
  let after =
    Position {
      amount: before.amount,
      debt: debt_at(before.amount, acc),
      since: before.since,
    }
  let (_, stake_root) =
    stake_accumulator.transition(pool.stake_root, staker, before, after, proof)
  let next =
    StakingPoolDatum {
      ..pool,
      stake_root: stake_root,
      acc_reward_per_token: acc,
      unallocated: unallocated,
      last_update_ms: now,
      exhausted_at: exhausted_after(pool, unallocated, now),
    }
  staking_pool.spend(
    Some(pool),
    ClaimRewards { staker_vkh: staker, before, proof },
    own_ref(),
    tx(
      list.concat([pool_input(pool, pool_tokens)], extra_inputs),
      list.concat(
        list.concat(
          [pool_output(next, pool_tokens - owed), payout_output(payout_to, owed)],
          if fee == 0 {
            []
          } else {
            [fee_output(fee)]
          },
        ),
        extra_outputs,
      ),
      [],
      now,
    ),
  )
}

/// Permissionless, and with no signature in the transaction at all — the
/// payout is pinned to the staker by credential, tag and netting.
test claim_pays_a_days_rewards_without_any_signature() {
  let (pool, before) = staked_pool()
  run_claim(pool, 3_651_000, before, opened_at + ms_per_day, staker, [], [])
}

test claim_cannot_be_redirected() {
  let (pool, before) = staked_pool()
  !run_claim(pool, 3_651_000, before, opened_at + ms_per_day, other, [], [])
}

/// The charge is enforced here rather than in the submitter for one reason:
/// this redeemer takes no signature, so a claimer can always build the
/// transaction themselves. A charge only our own client applies is a charge
/// anyone can decline.
test claim_refuses_a_transaction_that_pays_no_charge() {
  let (pool, before) = staked_pool()
  !run_claim_paying(pool, 3_651_000, before, opened_at + ms_per_day, staker, 0, [], [])
}

test claim_refuses_a_charge_below_the_floor() {
  let (pool, before) = staked_pool()
  !run_claim_paying(
    pool,
    3_651_000,
    before,
    opened_at + ms_per_day,
    staker,
    min_platform_claim_fee_lovelace - 1,
    [],
    [],
  )
}

/// The floor is a minimum, not a target: paying exactly it is a valid claim.
/// Without this the two tests above would still pass if the check were an
/// impossible one, and the charge would simply have closed claiming.
test claim_accepts_a_charge_exactly_at_the_floor() {
  let (pool, before) = staked_pool()
  run_claim_paying(
    pool,
    3_651_000,
    before,
    opened_at + ms_per_day,
    staker,
    min_platform_claim_fee_lovelace,
    [],
    [],
  )
}

/// The change trick again, aimed at the charge rather than the payout: the
/// governor's own lovelace, spent into the transaction and handed back tagged.
/// Every balance is honest and the governor is no better off, which is what
/// netting refuses and tagging alone would not.
test claim_refuses_a_charge_that_is_only_the_governors_own_change() {
  let (pool, before) = staked_pool()
  let governor_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"88",
        output_index: 0,
      },
      output: Output {
        address: from_verification_key(governor),
        value: assets.from_lovelace(min_platform_claim_fee_lovelace),
        datum: transaction.NoDatum,
        reference_script: None,
      },
    }
  !run_claim(
    pool,
    3_651_000,
    before,
    opened_at + ms_per_day,
    staker,
    [governor_input],
    [],
  )
}

/// The change trick: a builder who can get the staker's signature spends a
/// UTXO the staker already holds, hands it back tagged, and sends the pool's
/// real payment elsewhere. Every balance is honest and the staker gains
/// nothing — which is what netting, rather than tagging alone, refuses.
test claim_refuses_a_payout_that_is_only_the_stakers_own_change() {
  let (pool, before) = staked_pool()
  let now = opened_at + ms_per_day
  let (acc, _) = advance(pool, now)
  let owed = owed_at(before, acc)
  let staker_input =
    Input {
      output_reference: OutputReference {
        transaction_id: #"77",
        output_index: 0,
      },
      output: Output {
        address: from_verification_key(staker),
        value: assets.from_asset(token_policy, token_name, owed),
        datum: transaction.NoDatum,
        reference_script: None,
      },
    }
  let diverted =
    Output {
      address: from_verification_key(other),
      value: assets.from_asset(token_policy, token_name, owed),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  !run_claim(
    pool,
    3_651_000,
    before,
    now,
    staker,
    [staker_input],
    [diverted],
  )
}

/// Claiming twice at the same instant owes nothing the second time, because
/// the first claim rewrote the debt. This is the double-pay the off-chain
/// ledger used to be responsible for, now closed by arithmetic.
test a_second_claim_at_the_same_moment_is_owed_nothing() {
  let (pool, before) = staked_pool()
  let now = opened_at + ms_per_day
  let (acc, _) = advance(pool, now)
  and {
    run_claim(pool, 3_651_000, before, now, staker, [], []),
    owed_at(pos(1_000, debt_at(1_000, acc), opened_at), acc) == 0,
  }
}

/// Taking rewards is not a new commitment, so `since` is untouched — a staker
/// who claims on day 3 can still leave on day 7.
test claim_leaves_the_unstake_lock_alone() {
  let (pool, before) = staked_pool()
  let (acc, _) = advance(pool, opened_at + 3 * ms_per_day)
  let after =
    Position {
      amount: before.amount,
      debt: debt_at(before.amount, acc),
      since: before.since,
    }
  after.since == opened_at
}

// -- TopUpPool ----------------------------------------------------------------

fn run_top_up(pool: StakingPoolDatum, next: StakingPoolDatum, amount: Int, now: Int) -> Bool {
  staking_pool.spend(
    Some(pool),
    TopUpPool { amount },
    own_ref(),
    tx(
      [pool_input(pool, 3_650_000)],
      [pool_output(next, 3_650_000 + amount)],
      [],
      now,
    ),
  )
}

fn topped_up(pool: StakingPoolDatum, amount: Int, now: Int) -> StakingPoolDatum {
  let (acc, unallocated) = advance(pool, now)
  StakingPoolDatum {
    ..pool,
    acc_reward_per_token: acc,
    unallocated: unallocated + amount,
    last_update_ms: now,
    exhausted_at: None,
  }
}

test top_up_is_permissionless_and_extends_the_budget() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let now = opened_at + ms_per_day
  run_top_up(pool, topped_up(pool, 500_000, now), 500_000, now)
}

/// The field a top-up must not touch. Raising it would turn a top-up into an
/// acceleration, which is the opposite of what it is for.
test top_up_cannot_change_the_emission_rate() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let now = opened_at + ms_per_day
  let next =
    StakingPoolDatum { ..topped_up(pool, 500_000, now), emission_per_day: 36_500 }
  !run_top_up(pool, next, 500_000, now)
}

// -- ClosePool ----------------------------------------------------------------

fn exhausted_pool() -> StakingPoolDatum {
  StakingPoolDatum {
    ..mock_pool(),
    unallocated: 0,
    total_staked: 0,
    exhausted_at: Some(opened_at),
  }
}

fn run_close(pool: StakingPoolDatum, pool_tokens: Int, now: Int) -> Bool {
  staking_pool.spend(
    Some(pool),
    ClosePool,
    own_ref(),
    tx(
      [pool_input(pool, pool_tokens)],
      [
        Output {
          address: from_verification_key(creator),
          value: pool_value(pool_tokens),
          datum: InlineDatum(own_ref()),
          reference_script: None,
        },
      ],
      [],
      now,
    ),
  )
}

test close_retires_an_exhausted_pool_after_the_cooldown() {
  run_close(exhausted_pool(), 0, opened_at + close_cooldown_ms)
}

test close_is_refused_during_the_cooldown() {
  !run_close(exhausted_pool(), 0, opened_at + close_cooldown_ms - 1)
}

/// A staker who never came back keeps the pool open, and keeps their tokens.
/// The cooldown is a window for a top-up, not a forfeiture clock.
test close_is_refused_while_anyone_is_still_staked() {
  let pool = StakingPoolDatum { ..exhausted_pool(), total_staked: 1_000 }
  !run_close(pool, 1_000, opened_at + close_cooldown_ms)
}

/// And refused while any reward token remains, which is what an unclaimed
/// reward looks like from outside.
test close_is_refused_while_any_reward_is_unclaimed() {
  !run_close(exhausted_pool(), 5_000, opened_at + close_cooldown_ms)
}

test close_is_refused_on_a_pool_that_was_never_exhausted() {
  !run_close(mock_pool(), 0, opened_at + close_cooldown_ms)
}

// -- shared guards ------------------------------------------------------------

/// State authentication: a pool UTXO not carrying this launch's thread NFT
/// cannot be spent, however well-formed its datum. This validator is
/// unparameterized, so every launch's pool shares one address.
test a_pool_without_its_thread_nft_cannot_be_spent() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let now = opened_at + ms_per_day
  let bare =
    assets.merge(
      assets.from_lovelace(2_000_000),
      assets.from_asset(token_policy, token_name, 3_650_000),
    )
  !staking_pool.spend(
    Some(pool),
    TopUpPool { amount: 500_000 },
    own_ref(),
    tx(
      [
        Input {
          output_reference: own_ref(),
          output: Output {
            address: script_address(),
            value: bare,
            datum: InlineDatum(pool),
            reference_script: None,
          },
        },
      ],
      [
        Output {
          address: script_address(),
          value: assets.merge(
            bare,
            assets.from_asset(token_policy, token_name, 500_000),
          ),
          datum: InlineDatum(topped_up(pool, 500_000, now)),
          reference_script: None,
        },
      ],
      [],
      now,
    ),
  )
}

/// An open-ended validity range would let a spender read whatever "now" suits
/// them, and every redeemer here reads the clock.
test an_unbounded_validity_range_is_refused() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let now = opened_at + ms_per_day
  !staking_pool.spend(
    Some(pool),
    TopUpPool { amount: 500_000 },
    own_ref(),
    Transaction {
      ..transaction.placeholder,
      inputs: [pool_input(pool, 3_650_000)],
      outputs: [pool_output(topped_up(pool, 500_000, now), 4_150_000)],
      validity_range: interval.after(now),
    },
  )
}

/// A wide range is the same trick with an upper bound attached.
test a_wide_validity_range_is_refused() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let now = opened_at + ms_per_day
  !staking_pool.spend(
    Some(pool),
    TopUpPool { amount: 500_000 },
    own_ref(),
    Transaction {
      ..transaction.placeholder,
      inputs: [pool_input(pool, 3_650_000)],
      outputs: [pool_output(topped_up(pool, 500_000, now), 4_150_000)],
      validity_range: interval.between(
        now,
        now + max_validity_range_width + 1,
      ),
    },
  )
}

/// Permissionless redeemers spend this long-lived UTXO, so its continuing
/// output must not be paddable with junk.
test a_padded_pool_output_is_refused() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let now = opened_at + ms_per_day
  !staking_pool.spend(
    Some(pool),
    TopUpPool { amount: 500_000 },
    own_ref(),
    tx(
      [pool_input(pool, 3_650_000)],
      [
        Output {
          address: script_address(),
          value: assets.merge(
            pool_value(4_150_000),
            assets.from_asset(#"deadbeef", "spam", 1),
          ),
          datum: InlineDatum(topped_up(pool, 500_000, now)),
          reference_script: None,
        },
      ],
      [],
      now,
    ),
  )
}

/// Two pool UTXOs in one transaction is the shape that lets a single output
/// satisfy two obligations at once.
test two_pool_utxos_in_one_transaction_are_refused() {
  let pool = StakingPoolDatum { ..mock_pool(), total_staked: 1_000 }
  let now = opened_at + ms_per_day
  let second =
    Input {
      output_reference: OutputReference {
        transaction_id: #"99",
        output_index: 0,
      },
      output: Output {
        // A delegation key makes this UTXO's full Address differ from the
        // pool's while the script is identical — the two must still count as
        // one another's company.
        address: script_address() |> address.with_delegation_key(#"de1e"),
        value: pool_value(1_000),
        datum: InlineDatum(pool),
        reference_script: None,
      },
    }
  !staking_pool.spend(
    Some(pool),
    TopUpPool { amount: 500_000 },
    own_ref(),
    tx(
      [pool_input(pool, 3_650_000), second],
      [pool_output(topped_up(pool, 500_000, now), 4_150_000)],
      [],
      now,
    ),
  )
}
