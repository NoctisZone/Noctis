//// The pool datum's field positions the launch package reads.
////
//// The launch package's LP escrow reads a pool's datum by position
//// (`noctis/venue_pool_view` in `contracts/cardano`) when a takeover's vote
//// pairs a creator's tokens into the launch's pool: the launch token, the LP
//// token and the four fee slots the pool nets out of its reserves. It cannot
//// import this package's types, so the positions are pinned here, against the
//// real type, and reordering `SingleRoyaltyPoolConfig` fails here first.

use aiken/builtin
use splash/plutus.{Asset}
use splash/royalty_pool/single_royalty_pool.{SingleRoyaltyPoolConfig}

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

/// Every field distinct, so a wrong position cannot match by coincidence.
fn distinct_config() -> SingleRoyaltyPoolConfig {
  SingleRoyaltyPoolConfig {
    pool_nft: Asset { policy: #"a0", name: #"a1" },
    pool_x: Asset { policy: #"", name: #"" },
    pool_y: Asset { policy: #"a2", name: #"a3" },
    pool_lq: Asset { policy: #"a4", name: #"a5" },
    fee_num: 4,
    treasury_fee: 5,
    royalty_fee: 6,
    treasury_x: 7,
    treasury_y: 8,
    royalty_x: 9,
    royalty_y: 10,
    dao_policy: [],
    treasury_address: #"ac",
    royalty_pub_key: #"ad",
    nonce: 14,
  }
}

test the_positions_the_launch_escrow_reads_are_the_real_ones() {
  let config: Data = distinct_config()
  let pool_y: Data = Asset { policy: #"a2", name: #"a3" }
  let pool_lq: Data = Asset { policy: #"a4", name: #"a5" }
  and {
    field(config, 2) == pool_y,
    field(config, 3) == pool_lq,
    builtin.un_i_data(field(config, 7)) == 7,
    builtin.un_i_data(field(config, 8)) == 8,
    builtin.un_i_data(field(config, 9)) == 9,
    builtin.un_i_data(field(config, 10)) == 10,
  }
}
