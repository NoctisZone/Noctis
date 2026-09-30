//// The fields of a NoctisSwap pool's datum that the LP escrow consults when a
//// takeover's vote pairs a creator's tokens into the launch's pool, read by
//// position.
////
//// The pool's datum type lives in the venue package (`contracts/cardano-dex`,
//// `splash/royalty_pool/single_royalty_pool.SingleRoyaltyPoolConfig`), which
//// this package does not depend on. The escrow proves the pool genuine by its
//// NFT, which the venue factory mints under the same policy as the escrow's own
//// LP token, and only the pool validator's typed check ever writes a genuine
//// pool's datum. A test in the venue package pins every position read here
//// against the real type; `lp_escrow.ak` pins these readers against that
//// layout.

use aiken/builtin

/// The venue mints its LP token up to this cap and keeps the uncirculated
/// remainder in the pool, so a pool's liquidity is this less what it holds.
pub const max_lq_cap: Int = 0x7fffffffffffffff

fn nth(xs: List<Data>, n: Int) -> Data {
  if n == 0 {
    builtin.head_list(xs)
  } else {
    nth(builtin.tail_list(xs), n - 1)
  }
}

fn field(config: Data, n: Int) -> Data {
  nth(builtin.un_constr_data(config).2nd, n)
}

/// An `Asset { policy, name }` as a pair.
fn asset(value: Data) -> (ByteArray, ByteArray) {
  let fields = builtin.un_constr_data(value).2nd
  (
    builtin.un_b_data(builtin.head_list(fields)),
    builtin.un_b_data(builtin.head_list(builtin.tail_list(fields))),
  )
}

/// `pool_y`: the launch token the pool trades against ADA.
pub fn pool_y(config: Data) -> (ByteArray, ByteArray) {
  asset(field(config, 2))
}

/// `pool_lq`: the pool's LP token.
pub fn pool_lq(config: Data) -> (ByteArray, ByteArray) {
  asset(field(config, 3))
}

/// `treasury_x`: the platform's accrued slice in ADA.
pub fn treasury_x(config: Data) -> Int {
  builtin.un_i_data(field(config, 7))
}

/// `treasury_y`: the platform's accrued slice in the launch token.
pub fn treasury_y(config: Data) -> Int {
  builtin.un_i_data(field(config, 8))
}

/// `royalty_x`: the creator's accrued slice in ADA.
pub fn royalty_x(config: Data) -> Int {
  builtin.un_i_data(field(config, 9))
}

/// `royalty_y`: the creator's accrued slice in the launch token.
pub fn royalty_y(config: Data) -> Int {
  builtin.un_i_data(field(config, 10))
}
