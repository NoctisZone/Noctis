// ============================================================================
// Noctis Zone — fixed-size claim nullifiers
// ============================================================================
// A "has this already been claimed?" record kept as a list of who claimed
// grows one entry per claimant, forever. It is traversed on every spend and
// compared by full structural equality against the continuing datum, so the
// UTXO it lives in gets steadily more expensive to spend and eventually
// cannot be spent at all — the more successful the launch, the sooner it
// bricks.
//
// A bitmap does the same job in a fixed number of bytes. Each claimant is
// assigned an index when the roster is published, and claiming sets their
// bit. 400 claimants cost 50 bytes here against roughly 11 KB as a list, and
// the cost never changes with how many have claimed.
//
// Bit ordering is MSB-first — bit 0 is the high bit of byte 0 — matching
// `bytearray.test_bit`, which is what reads these back.

use aiken/math
use aiken/primitive/bytearray

/// `bits` with bit `ix` set.
///
/// IDEMPOTENT ON PURPOSE. Setting an already-set bit returns the map
/// unchanged rather than carrying out of the byte and aborting.
///
/// That matters more than it looks. An aborting `set_bit` refuses a second
/// claim all by itself, which sounds like a bonus and is really a hazard: the
/// explicit "this bit is still clear" check a caller writes next to it then
/// carries no weight, its test passes for a reason unrelated to what it
/// names, and the protection silently disappears the day somebody makes this
/// helper total. Being total here forces the real check to be the one doing
/// the work, where it can be seen and tested.
///
/// Rebuilt by slicing rather than with `or_bytes` so the result is a plain
/// value comparison against the continuing datum, with no dependence on how
/// the builtin pads operands of differing length. Length is preserved, so a
/// datum cannot grow by claiming.
pub fn set_bit(bits: ByteArray, ix: Int) -> ByteArray {
  let byte_ix = ix / 8
  let byte = bytearray.at(bits, byte_ix)
  let mask = math.pow2(7 - ix % 8)
  let updated_byte = if byte / mask % 2 == 1 {
    byte
  } else {
    byte + mask
  }
  bytearray.concat(
    bytearray.concat(
      bytearray.take(bits, byte_ix),
      bytearray.from_int_big_endian(updated_byte, 1),
    ),
    bytearray.drop(bits, byte_ix + 1),
  )
}

/// True when `ix` addresses a real bit of `bits`.
///
/// Worth its own function because both `set_bit` and any leaf hash built from
/// the index abort on an out-of-range one, and in Aiken a `let` binding is
/// evaluated before the `and { }` block that would have guarded it. Callers
/// bind this first and branch on it.
pub fn index_in_range(bits: ByteArray, ix: Int) -> Bool {
  ix >= 0 && ix < bytearray.length(bits) * 8
}

/// A nullifier of `size` bytes with every bit clear.
///
/// Used to check a freshly-published roster starts with nobody's claim
/// already spent: whoever publishes it must not be able to burn a claimant's
/// entitlement by handing out a map with their bit set.
pub fn cleared(size: Int) -> ByteArray {
  bytearray.from_int_big_endian(0, size)
}

// ============================================================================
// TESTS
// ============================================================================

test set_bit_sets_the_high_bit_of_the_first_byte() {
  set_bit(#"0000", 0) == #"8000"
}

test set_bit_sets_the_low_bit_of_the_first_byte() {
  set_bit(#"0000", 7) == #"0100"
}

/// The boundary a byte-indexed map is most likely to get wrong.
test set_bit_crosses_into_the_second_byte() {
  set_bit(#"0000", 8) == #"0080"
}

test set_bit_preserves_length() {
  bytearray.length(set_bit(#"000000", 17)) == 3
}

/// The property the double-claim check depends on being able to test.
/// If this aborted instead, a second claim would be refused by the arithmetic
/// and the explicit check next to it would never be exercised.
test set_bit_is_idempotent() {
  set_bit(#"8000", 0) == #"8000"
}

test set_bit_is_idempotent_mid_byte() {
  set_bit(#"2000", 2) == #"2000"
}

test set_bit_leaves_other_bits_alone() {
  set_bit(#"8000", 15) == #"8001"
}

test test_bit_reads_back_what_set_bit_wrote() {
  let bits = set_bit(set_bit(#"0000", 3), 11)
  and {
    bytearray.test_bit(bits, 3),
    bytearray.test_bit(bits, 11),
    !bytearray.test_bit(bits, 4),
    !bytearray.test_bit(bits, 10),
  }
}

test index_in_range_rejects_negative() {
  !index_in_range(#"00", -1)
}

test index_in_range_accepts_the_last_bit() {
  index_in_range(#"0000", 15)
}

test index_in_range_rejects_one_past_the_last_bit() {
  !index_in_range(#"0000", 16)
}

test cleared_is_all_zero_bytes() {
  cleared(4) == #"00000000"
}

test cleared_of_the_same_size_matches_an_untouched_map() {
  cleared(2) == #"0000"
}
