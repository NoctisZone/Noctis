//// The staking pool's datum, and the exact shape it must open in.
////
//// This lives here rather than in the validator that owns it because the
//// bonding curves have to WRITE it. `Graduate` is permissionless — the
//// conditions are the authorization — so whoever submits a graduation authors
//// the pool's first datum, and a validator module may not import another
//// validator module. A shared module is how two validators agree on a shape
//// without either depending on the other, the same reason
//// `noctis/lp_escrow_datum` exists.
////
//// WHY THE OPENING DATUM IS CHECKED AT ALL
//// Every field below decides something the pool can never revisit. Left
//// unchecked, a graduation could open a pool whose emission rate empties it in
//// an afternoon, or whose budget is already zero, or — the one that actually
//// takes the money — whose `stake_root` already credits its author with the
//// whole reserve, ready to be unstaked. `genesis` is the one datum a
//// graduation may write, derived entirely from terms the creator committed to
//// at launch creation.
////
//// Nothing here is validator logic. The rules that maintain these fields stay
//// in `staking_pool.ak`; this is only the shape they are written in.

use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{AssetName, PolicyId}
use noctis/stake_accumulator

/// ONE per launch. Its own UTXO value holds every staked token AND the reward
/// budget; the fields say which is which. See `staking_pool.ak` for what each
/// one means and what may move it.
pub type StakingPoolDatum {
  launch_id: ByteArray,
  creator_pub_key_hash: VerificationKeyHash,
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  thread_nft_policy: PolicyId,
  emission_per_day: Int,
  stake_root: ByteArray,
  acc_reward_per_token: Int,
  total_staked: Int,
  unallocated: Int,
  last_update_ms: Int,
  exhausted_at: Option<Int>,
  /// Who the flat claim charge is paid to. The same key the curve pays its
  /// own platform fees to, carried here so the pool can charge without
  /// consulting the curve that opened it.
  ///
  /// Declared LAST on purpose. Every redeemer rewrites the five fields above
  /// it and none rewrites this one, and a record update walks the field list
  /// to reach what it replaces — so appending leaves those five at the index
  /// they already had. This datum groups its immutable terms first and its
  /// moving state last, which is the opposite of the curve datum's ordering
  /// rule; the reason is the same in both, and it is the update sites that
  /// decide it, not the reading order.
  governor_pub_key_hash: VerificationKeyHash,
}

/// The pool as the launch's mint transaction creates it: real, identified,
/// carrying its thread NFT and its rate — and holding no budget at all.
///
/// It exists this early because the thread NFT that authenticates it is minted
/// once, with the launch. Graduation then tops it up rather than creating it,
/// which is why `Stake` refuses a pool with nothing to pay: a stake landing
/// before the budget arrives would move `total_staked` and `stake_root` off
/// their opening values, and the seeding check below — which is what pins
/// those values — could never pass again. One griefing stake would strand a
/// launch's whole staking reserve.
pub fn unfunded(
  launch_id: ByteArray,
  creator_pub_key_hash: VerificationKeyHash,
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  thread_nft_policy: PolicyId,
  reserve_tokens: Int,
  duration_days: Int,
  minted_at: Int,
  governor_pub_key_hash: VerificationKeyHash,
) -> StakingPoolDatum {
  StakingPoolDatum {
    ..genesis(
      launch_id,
      creator_pub_key_hash,
      token_policy_id,
      token_asset_name,
      thread_nft_policy,
      reserve_tokens,
      duration_days,
      minted_at,
      governor_pub_key_hash,
    ),
    unallocated: 0,
  }
}

/// The only datum a graduation may open a pool with.
///
/// `emission_per_day` is derived, not supplied: the reserve the creator carved
/// out, spread across the runway they committed to. That is what makes the
/// runway a promise made at launch creation rather than a number chosen by
/// whoever happens to submit the graduation.
///
/// Everything else is the empty state — no accumulated reward, nobody staked,
/// the whole reserve unallocated, and an empty position tree.
pub fn genesis(
  launch_id: ByteArray,
  creator_pub_key_hash: VerificationKeyHash,
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  thread_nft_policy: PolicyId,
  reserve_tokens: Int,
  duration_days: Int,
  opened_at: Int,
  governor_pub_key_hash: VerificationKeyHash,
) -> StakingPoolDatum {
  StakingPoolDatum {
    launch_id,
    creator_pub_key_hash,
    token_policy_id,
    token_asset_name,
    thread_nft_policy,
    emission_per_day: reserve_tokens / duration_days,
    stake_root: stake_accumulator.root_of([]),
    acc_reward_per_token: 0,
    total_staked: 0,
    unallocated: reserve_tokens,
    last_update_ms: opened_at,
    exhausted_at: None,
    governor_pub_key_hash,
  }
}

/// Terms a pool can actually run on.
///
/// A zero runway would divide by zero deriving the rate, and a zero reserve
/// would open a pool with nothing to pay — so a launch that opted into staking
/// has to have really carved something out over a real period. Checked by the
/// curve before `genesis` is ever evaluated.
pub fn terms_are_real(reserve_tokens: Int, duration_days: Int) -> Bool {
  and {
    reserve_tokens > 0,
    duration_days > 0,
    // A rate that floors to nothing is a pool that never pays out and can
    // never be closed, since closing needs the budget exhausted.
    reserve_tokens / duration_days > 0,
  }
}
