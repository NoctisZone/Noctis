//// Per-launch thread NFTs — the one place the naming scheme is defined.
////
//// WHY THIS MODULE EXISTS
//// Every validator in this project is unparameterized, so all launches of a
//// tier share ONE script address and a UTXO's legitimacy would otherwise rest
//// entirely on a datum that anyone can author. Paying to a script address
//// never runs its validator, so an attacker can create a UTXO at any of these
//// addresses carrying whatever datum they like.
////
//// The fix is a per-launch state token minted at genesis under a
//// governor-signature policy. It is required on the spent input AND on the
//// continuing output of every state validator, so only the genuine UTXO can
//// ever be spent through the validator, and the token can never be stripped
//// mid-life.
////
//// NAMING SCHEME
//// `launch_id` is blake2b_256 (32 bytes) and Cardano's maximum asset name is
//// also 32 bytes, so `launch_id ++ role` does not fit. The name is therefore
//// a one-byte role tag followed by the first 31 bytes of the launch id:
////
////     asset_name = role_tag ++ take(launch_id, 31)
////
//// 31 bytes of blake2b is 248 bits — collision-safe well beyond any practical
//// concern — and keeping the launch id in the clear (rather than hashing the
//// pair) means an NFT can still be traced back to its launch by eye on a
//// block explorer.
////
//// Distinct tags for the two Cardano curves are deliberate: they are
//// different scripts at different addresses and a launch is only ever one of
//// the two, so a shared tag would buy nothing and would let a linear-curve token be
//// replanted at a Cardano Launch address.

use aiken/primitive/bytearray

/// Role tags. Each state validator owns exactly one.
pub const role_cto_governance: ByteArray = #"00"

pub const role_bonding_curve: ByteArray = #"01"

pub const role_bonding_curve_tier_b: ByteArray = #"02"

pub const role_lp_escrow: ByteArray = #"03"

pub const role_vesting: ByteArray = #"04"

pub const role_staking_pool: ByteArray = #"05"

pub const role_zk_anchor: ByteArray = #"06"

/// The asset name this launch's thread NFT carries for a given role.
///
/// Truncating to 31 bytes is what makes room for the role tag inside
/// Cardano's 32-byte asset-name limit. `bytearray.take` on an input shorter
/// than 31 bytes returns it whole, which only arises in test fixtures using
/// short mock launch ids — real launch ids are always the full 32 bytes from
/// blake2b_256, so the result is always exactly 32 bytes in production.
pub fn thread_asset_name(role: ByteArray, launch_id: ByteArray) -> ByteArray {
  bytearray.concat(role, bytearray.take(launch_id, 31))
}

test thread_asset_name_is_32_bytes() {
  let launch_id =
    #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  bytearray.length(thread_asset_name(role_bonding_curve, launch_id)) == 32
}

test thread_asset_name_differs_per_role() {
  let launch_id =
    #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  thread_asset_name(role_bonding_curve, launch_id) != thread_asset_name(
    role_lp_escrow,
    launch_id,
  )
}

/// Differs at byte 0, i.e. inside the retained 31-byte prefix. Two ids that
/// differ only at byte 32 deliberately collide — see truncation_is_31_bytes.
test thread_asset_name_differs_per_launch() {
  let a = #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  let b = #"ff02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  thread_asset_name(role_bonding_curve, a) != thread_asset_name(
    role_bonding_curve,
    b,
  )
}

/// The two curve tags must never collide — a linear-curve token must not satisfy a
/// Cardano Launch check for the same launch.
test curve_roles_do_not_collide() {
  let launch_id =
    #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  thread_asset_name(role_bonding_curve, launch_id) != thread_asset_name(
    role_bonding_curve_tier_b,
    launch_id,
  )
}

/// Cross-implementation pin. The genesis mint builds these names in
/// TypeScript (integration/tier-a-schemas.ts, threadNftAssetName) while the
/// validators derive them here; if the two ever disagree, every launch mints
/// tokens its own validators reject and the failure only shows up at spend
/// time, long after the mint succeeded.
///
/// The expected values below were produced by running the real genesis
/// builder, not written by hand — regenerate them the same way if the scheme
/// changes, and never "fix" a failure here by editing only one side.
test matches_typescript_implementation() {
  let launch_id =
    #"aebfbc87161850827e5620fa667e98c533a419298bbed1a8fff960f1b9e2fa14"
  and {
    thread_asset_name(role_cto_governance, launch_id) == #"00aebfbc87161850827e5620fa667e98c533a419298bbed1a8fff960f1b9e2fa",
    thread_asset_name(role_bonding_curve, launch_id) == #"01aebfbc87161850827e5620fa667e98c533a419298bbed1a8fff960f1b9e2fa",
    thread_asset_name(role_bonding_curve_tier_b, launch_id) == #"02aebfbc87161850827e5620fa667e98c533a419298bbed1a8fff960f1b9e2fa",
    thread_asset_name(role_lp_escrow, launch_id) == #"03aebfbc87161850827e5620fa667e98c533a419298bbed1a8fff960f1b9e2fa",
    thread_asset_name(role_vesting, launch_id) == #"04aebfbc87161850827e5620fa667e98c533a419298bbed1a8fff960f1b9e2fa",
    thread_asset_name(role_staking_pool, launch_id) == #"05aebfbc87161850827e5620fa667e98c533a419298bbed1a8fff960f1b9e2fa",
    thread_asset_name(role_zk_anchor, launch_id) == #"06aebfbc87161850827e5620fa667e98c533a419298bbed1a8fff960f1b9e2fa",
  }
}

/// Two launch ids that differ only beyond byte 31 collide by construction —
/// documented here so the truncation is a stated, tested property rather than
/// an unnoticed edge. Real launch ids are blake2b_256 outputs, so reaching
/// this case means finding a 248-bit prefix collision.
test truncation_is_31_bytes() {
  let a = #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  let b = #"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f99"
  thread_asset_name(role_vesting, a) == thread_asset_name(role_vesting, b)
}
