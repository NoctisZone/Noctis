//// Shared readers for the NoctisSwap pool datum and value. (c) Noctis Zone,
//// Apache-2.0. The datum type itself is Splash's, vendored unchanged.

use cardano/assets.{Value, ada_asset_name, ada_policy_id}
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}
use splash/value_ext.{asset_quantity_of}

/// Fee numerators are expressed over this denominator (Splash convention).
pub const fee_den: Int = 100_000

/// The pool keeps `max_lq_cap - liquidity` of its own LQ token, so the
/// circulating liquidity is derived rather than stored.
pub const max_lq_cap: Int = 0x7fffffffffffffff

pub fn is_ada(asset: Asset) -> Bool {
  asset.policy == ada_policy_id && asset.name == ada_asset_name
}

/// In a token-to-token pool the lovelace carried alongside must not move; in an
/// ADA pool it is one of the reserves and this reads as 0.
pub fn lovelace_t2t(cfg: SingleRoyaltyPoolConfig, value: Value) -> Int {
  if is_ada(cfg.pool_x) || is_ada(cfg.pool_y) {
    0
  } else {
    assets.lovelace_of(value)
  }
}

pub type PoolState {
  reserves_x: Int,
  reserves_y: Int,
  liquidity: Int,
  lovelace_t2t: Int,
}

/// Reserves net of the two fee slots, liquidity from the LQ balance.
pub fn read_pool_state(cfg: SingleRoyaltyPoolConfig, value: Value) -> PoolState {
  let x = asset_quantity_of(value, cfg.pool_x)
  let y = asset_quantity_of(value, cfg.pool_y)
  let lq_neg = asset_quantity_of(value, cfg.pool_lq)
  PoolState {
    reserves_x: x - cfg.treasury_x - cfg.royalty_x,
    reserves_y: y - cfg.treasury_y - cfg.royalty_y,
    liquidity: max_lq_cap - lq_neg,
    lovelace_t2t: lovelace_t2t(cfg, value),
  }
}
