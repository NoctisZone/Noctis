//// Order types shared by the NoctisSwap order validators. (c) Noctis Zone,
//// Apache-2.0. The deposit and redeem request layouts follow Splash's Plutarch
//// `DepositConfig` and `RedeemConfig` (splash-core, CC0-1.0) field for field;
//// the action carries its indices inside the constructor rather than beside
//// it, which is the one departure from their `OrderRedeemer`.

use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address, Inline, VerificationKey}
use splash/plutus.{Asset}
use splash/rational.{Rational}

/// Apply is what an executor does; Refund is what the placer does.
pub type OrderAction {
  Apply { pool_in_ix: Int, order_in_ix: Int, reward_out_ix: Int }
  Refund
}

/// A request to add liquidity: both assets in, LQ out to the placer.
/// `collateral_ada` is ADA the placer set aside so the reward output can
/// exist; it must come back to them.
pub type DepositConfig {
  pool_nft: Asset,
  x: Asset,
  y: Asset,
  lq: Asset,
  ex_fee: Int,
  reward_pkh: VerificationKeyHash,
  stake_pkh: Option<VerificationKeyHash>,
  collateral_ada: Int,
}

/// A request to remove liquidity: LQ in, both assets out to the placer.
pub type RedeemConfig {
  pool_nft: Asset,
  x: Asset,
  y: Asset,
  lq: Asset,
  ex_fee: Int,
  reward_pkh: VerificationKeyHash,
  stake_pkh: Option<VerificationKeyHash>,
}

/// A swap request against one pool. The placer trades `tradable_input` of
/// `input` for `output` at no worse than `base_price` (output per input),
/// pays the executor `ex_fee` lovelace for the whole order, pro rata on a
/// partial fill, and accepts no partial fill smaller than
/// `min_marginal_output`. An empty `permitted_executors` means anyone may fill.
pub type SwapConfig {
  pool_nft: Asset,
  input: Asset,
  output: Asset,
  tradable_input: Int,
  base_price: Rational,
  min_marginal_output: Int,
  ex_fee: Int,
  reward_pkh: VerificationKeyHash,
  stake_pkh: Option<VerificationKeyHash>,
  permitted_executors: List<VerificationKeyHash>,
}

/// Fill names the pool, the order and the order's successor: the placer's
/// reward output when the order completes, or the continuing order when it
/// fills in part.
pub type SwapAction {
  Fill { pool_in_ix: Int, order_in_ix: Int, successor_ix: Int }
  Cancel
}

/// The reward must go to exactly the address the placer named: their payment
/// key, and their stake key or none. A script or pointer stake part never
/// matches.
pub fn reward_address_ok(
  addr: Address,
  reward_pkh: VerificationKeyHash,
  stake_pkh: Option<VerificationKeyHash>,
) -> Bool {
  let stake_ok = when addr.stake_credential is {
    None -> stake_pkh == None
    Some(Inline(VerificationKey(s))) -> stake_pkh == Some(s)
    _ -> False
  }
  addr.payment_credential == VerificationKey(reward_pkh) && stake_ok
}

test reward_address_accepts_the_named_keys() {
  let addr = Address {
    payment_credential: VerificationKey(#"01"),
    stake_credential: Some(Inline(VerificationKey(#"02"))),
  }
  reward_address_ok(addr, #"01", Some(#"02"))
}

test reward_address_refuses_a_missing_stake_key() {
  let addr = Address {
    payment_credential: VerificationKey(#"01"),
    stake_credential: None,
  }
  !reward_address_ok(addr, #"01", Some(#"02"))
}

test reward_address_refuses_an_unexpected_stake_key() {
  let addr = Address {
    payment_credential: VerificationKey(#"01"),
    stake_credential: Some(Inline(VerificationKey(#"02"))),
  }
  !reward_address_ok(addr, #"01", None)
}
