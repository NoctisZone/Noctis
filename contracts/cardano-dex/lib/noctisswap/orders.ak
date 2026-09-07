//// Order types shared by the NoctisSwap order validators. (c) Noctis Zone,
//// Apache-2.0. The deposit and redeem request layouts follow Splash's Plutarch
//// `DepositConfig` and `RedeemConfig` (splash-core, CC0-1.0) field for field;
//// the action carries its indices inside the constructor rather than beside
//// it, which is the one departure from their `OrderRedeemer`.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address, Inline, VerificationKey}
use cardano/assets.{Value, ada_policy_id}
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

/// An order UTxO holds only the assets its own type names, plus ADA — which
/// every order carries for the executor's fee and its own minimum, and which
/// each validator accounts for in its own arithmetic.
///
/// Every value rule in these validators is an inequality over a named set: the
/// request's assets, its LQ, the pool's NFT. This rule is what makes that set
/// the whole of the order, so every asset an order holds is measured by one of
/// them. A request assembled with anything else can only be refunded, which
/// puts the discipline where the order is built: our own front end and
/// batcher.
pub fn only_named_assets(value: Value, named: List<Asset>) -> Bool {
  list.all(
    assets.flatten(value),
    fn(entry) {
      let (policy, name, _quantity) = entry
      policy == ada_policy_id || list.any(
        named,
        fn(a) { a.policy == policy && a.name == name },
      )
    },
  )
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

test an_order_holding_only_what_it_names_is_accepted() {
  let named = Asset { policy: #"bb", name: #"746f6b656e" }
  let v = assets.from_lovelace(3_000_000) |> assets.add(#"bb", #"746f6b656e", 5)
  only_named_assets(v, [named])
}

test an_order_carrying_a_stray_asset_is_refused() {
  let named = Asset { policy: #"bb", name: #"746f6b656e" }
  let v = assets.from_lovelace(3_000_000)
    |> assets.add(#"bb", #"746f6b656e", 5)
    |> assets.add(#"99", #"7374726179", 1)
  !only_named_assets(v, [named])
}

/// Two assets under one policy are two different names, so naming one does not
/// admit the other.
test a_sibling_asset_name_under_a_named_policy_is_refused() {
  let named = Asset { policy: #"bb", name: #"746f6b656e" }
  let v = assets.from_lovelace(3_000_000) |> assets.add(#"bb", #"6f74686572", 5)
  !only_named_assets(v, [named])
}

/// ADA is never a stray: every order holds it for the fee and the minimum.
test ada_alone_satisfies_an_order_that_names_no_asset() {
  only_named_assets(assets.from_lovelace(3_000_000), [])
}
