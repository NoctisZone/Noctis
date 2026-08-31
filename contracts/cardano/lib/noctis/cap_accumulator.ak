//// The cumulative wallet cap, held as one 32-byte root.
////
//// WHY THIS MODULE EXISTS
//// A per-wallet cap has to be CUMULATIVE to mean anything: a limit that
//// resets every transaction stops one trade swallowing a curve and stops
//// nothing else. The obvious way to make it cumulative is a running total per
//// wallet in the curve's datum — and that list grows with participation until
//// the datum every trade carries no longer fits in a transaction, bricking a
//// curve at exactly the moment a launch is succeeding.
////
//// So the totals live OUTSIDE the datum, behind a Merkle root that commits to
//// all of them. The datum carries 32 bytes whether one wallet trades or a
//// million; each trade carries the one proof for its own slot. Nothing is
//// registered in advance and no allowlist exists — a wallet that has never
//// traded proves an empty slot, which is why the curve stays open to anyone.
////
//// THE UPDATE, IN ONE LINE
//// One path, walked twice: against the old root to establish what a wallet's
//// total IS, and again with the new leaf to derive what the root BECOMES.
//// Only the leaf on that path changed, so the siblings are the same both
//// times, which is what makes a read-only membership proof into an updatable
//// accumulator.
////
//// SHARED DELIBERATELY
//// Both curve validators use this module rather than each carrying a copy.
//// One off-chain tree builder serves both tiers, and it can only do that if
//// the leaf layout, the node hash and the slot derivation agree bit for bit —
//// two hand-maintained copies is precisely how that stops being true.
////
//// WHAT IT DOES NOT DO
//// One WALLET KEY cannot exceed the cap. One PERSON still can, by trading
//// from separate keys: no on-chain mechanism can tell two keys apart from two
//// people. Sybil resistance is DarkVeil's eligibility checks and the N-hop
//// challenge; this is not a substitute for either.

use aiken/builtin.{blake2b_256}
use aiken/collection/list
use aiken/primitive/bytearray

/// One sibling on a Merkle path. `goes_left` means the SIBLING is the left
/// child — i.e. the node being proved is the right one, i.e. the slot bit is 1.
pub type CapProofStep {
  sibling: ByteArray,
  goes_left: Bool,
}

/// Every proof is exactly this long, so the tree has one fixed shape and a
/// slot is the leading 32 bits of `blake2b_256(key)`.
///
/// Depth is pinned rather than inferred from whatever proof a caller supplies,
/// for two reasons. A collision puts two wallets on one running total — they
/// spend each other's headroom — so it is a correctness fault, not wasted
/// space; at depth 32 that is a ~0.01% event across a thousand buyers, and at
/// depth 20 it is about even money. And a caller free to pick the depth is a
/// caller free to pick a different tree.
pub const tree_depth = 32

/// The value at a slot no wallet has taken tokens through yet.
///
/// A distinct constant rather than `hash_leaf(key, 0)`, because the empty tree
/// has to be computable without knowing any key — which is what lets all
/// 2^32 slots exist as a single root at genesis with nothing materialised.
pub const empty_leaf: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000000"

/// 2^64 — what an 8-byte big-endian total can hold. Real totals are bounded by
/// the curve's own `wallet_cap` (5% of a 1B supply), so this guards against an
/// encoding abort rather than expressing a business limit.
pub const total_ceiling = 18_446_744_073_709_551_616

/// Internal node hash: `blake2b_256(left || right)`.
pub fn hash_node(left: ByteArray, right: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(left, right))
}

/// A leaf: a wallet key and what it has taken from the curve so far.
///
/// The key is IN the leaf, so a proof cannot be replayed for anyone else, and
/// the total is big-endian over a fixed 8 bytes, so no two totals can hash
/// alike through length ambiguity.
pub fn hash_leaf(key: ByteArray, total: Int) -> ByteArray {
  blake2b_256(
    bytearray.concat(key, bytearray.from_int_big_endian(total, 8)),
  )
}

/// Canonical leaf for a total: zero is ALWAYS the empty leaf, never
/// `hash_leaf(key, 0)`. One representation per value, so a wallet that sells
/// everything back returns its slot to exactly the state it started in.
pub fn leaf_for(key: ByteArray, total: Int) -> ByteArray {
  if total == 0 {
    empty_leaf
  } else {
    hash_leaf(key, total)
  }
}

/// Walks a path bottom-up and returns the root it implies.
pub fn recompute_root(leaf: ByteArray, proof: List<CapProofStep>) -> ByteArray {
  list.foldl(
    proof,
    leaf,
    fn(step, acc) {
      if step.goes_left {
        hash_node(step.sibling, acc)
      } else {
        hash_node(acc, step.sibling)
      }
    },
  )
}

/// Binds a proof's SHAPE to whose leaf it is.
///
/// Without this the accumulator is decorative. The spender authors the new
/// root, so if only the two root transitions were checked they could write a
/// root that ALSO inserts a second leaf for their own key at some other slot,
/// prove against that fresh slot next time, and start from zero again.
/// Requiring the path's direction bits to equal the leading bits of
/// `blake2b_256(key)` gives every key exactly ONE reachable slot, so a
/// duplicate is unreachable even if one exists.
///
/// Walked bottom-up, so step `j` carries bit `tree_depth - 1 - j`;
/// `test_bit` is MSB-first.
pub fn path_matches_key(key: ByteArray, proof: List<CapProofStep>) -> Bool {
  let slot = blake2b_256(key)
  let depth = list.length(proof)
  let (_, matches) =
    list.foldl(
      proof,
      (0, True),
      fn(step, acc) {
        let (j, ok) = acc
        (j + 1, ok && step.goes_left == bytearray.test_bit(slot, depth - 1 - j))
      },
    )
  matches
}

/// Reads `before` as `key`'s committed total under `root`, and returns the root
/// that total becomes once it is `after`.
///
/// The first walk is what makes `before` TRUE rather than merely claimed — a
/// caller who understates their total cannot reach `root` with it, and one who
/// overstates it only shrinks their own headroom.
///
/// `bytearray.from_int_big_endian` aborts on a negative value or one too wide
/// for its 8 bytes, and both leaves are evaluated before any caller's `and`
/// block runs — so the range guard lives here rather than at the call site.
pub fn transition(
  root: ByteArray,
  key: ByteArray,
  before: Int,
  after: Int,
  proof: List<CapProofStep>,
) -> (Bool, ByteArray) {
  if and {
    before >= 0,
    after >= 0,
    before < total_ceiling,
    after < total_ceiling,
  } {
    let ok = and {
        list.length(proof) == tree_depth,
        path_matches_key(key, proof),
        recompute_root(leaf_for(key, before), proof) == root,
      }
    (ok, recompute_root(leaf_for(key, after), proof))
  } else {
    (False, root)
  }
}

// ============================================================================
// TREE CONSTRUCTION
// ============================================================================
// The off-chain batcher maintains the real tree; these are the same
// construction expressed on-chain so fixtures can be DERIVED rather than
// written as literal roots. A hard-coded root would keep every test passing if
// the leaf layout, the node hash or the depth changed — which is the one blind
// spot those tests exist to cover.
//
// Nothing below is reachable from any validator, so none of it is compiled
// into a script.

/// Bit `i` of a key's slot, MSB-first — `i = 0` is the choice made at the root.
pub fn slot_bit(key: ByteArray, i: Int) -> Bool {
  bytearray.test_bit(blake2b_256(key), i)
}

/// Root of an all-empty subtree of height `h`.
pub fn empty_subtree(h: Int) -> ByteArray {
  if h == 0 {
    empty_leaf
  } else {
    let below = empty_subtree(h - 1)
    hash_node(below, below)
  }
}

/// Root of a subtree of height `h` holding exactly `entries`, where every
/// entry's slot agrees on the `tree_depth - h` bits above it.
///
/// Generic over what a slot holds, and over how a leaf is hashed from it, so
/// `noctis/stake_accumulator` builds its own three-field positions through
/// this same construction rather than keeping a second copy of it. The tree
/// shape, the slot derivation and the empty subtree are what must not drift;
/// only the leaf differs between the two.
pub fn generic_subtree_root(
  entries: List<(ByteArray, a)>,
  h: Int,
  leaf: fn(ByteArray, a) -> ByteArray,
) -> ByteArray {
  when entries is {
    [] -> empty_subtree(h)
    [(key, value)] ->
      // One entry in an otherwise empty subtree: fold its leaf up past `h`
      // empty siblings.
      list.foldl(
        list.range(1, h),
        leaf(key, value),
        fn(level, acc) {
          if slot_bit(key, tree_depth - level) {
            hash_node(empty_subtree(level - 1), acc)
          } else {
            hash_node(acc, empty_subtree(level - 1))
          }
        },
      )
    _ -> {
      let bit_ix = tree_depth - h
      let (ones, zeros) = list.partition(entries, fn(e) { slot_bit(e.1st, bit_ix) })
      hash_node(
        generic_subtree_root(zeros, h - 1, leaf),
        generic_subtree_root(ones, h - 1, leaf),
      )
    }
  }
}

/// `key`'s proof against `generic_root_of(entries, leaf)`. `key` need not be
/// in `entries` — an absent key proves its empty slot.
pub fn generic_proof_in(
  key: ByteArray,
  entries: List<(ByteArray, a)>,
  leaf: fn(ByteArray, a) -> ByteArray,
) -> List<CapProofStep> {
  proof_walk(key, entries, 0, [], leaf)
}

/// Descends from the root taking `key`'s side each level, recording the
/// subtree left behind. Steps are pushed in increasing bit order onto the
/// front, so the list comes out bottom-up — the order `recompute_root` folds.
fn proof_walk(
  key: ByteArray,
  entries: List<(ByteArray, a)>,
  i: Int,
  acc: List<CapProofStep>,
  leaf: fn(ByteArray, a) -> ByteArray,
) -> List<CapProofStep> {
  if i == tree_depth {
    acc
  } else {
    let goes_right = slot_bit(key, i)
    let (ones, zeros) = list.partition(entries, fn(e) { slot_bit(e.1st, i) })
    let (mine, theirs) =
      if goes_right {
        (ones, zeros)
      } else {
        (zeros, ones)
      }
    let step =
      CapProofStep {
        sibling: generic_subtree_root(theirs, tree_depth - i - 1, leaf),
        goes_left: goes_right,
      }
    proof_walk(key, mine, i + 1, list.push(acc, step), leaf)
  }
}

/// Root of a subtree of height `h` holding exactly `entries`.
pub fn subtree_root(entries: List<(ByteArray, Int)>, h: Int) -> ByteArray {
  generic_subtree_root(entries, h, leaf_for)
}

/// The root of a whole tree holding `entries` and nothing else.
pub fn root_of(entries: List<(ByteArray, Int)>) -> ByteArray {
  subtree_root(entries, tree_depth)
}

/// `key`'s proof against `root_of(entries)`. `key` need not be in `entries` —
/// an absent key proves its empty slot, which is what a first-time buyer does.
pub fn proof_in(
  key: ByteArray,
  entries: List<(ByteArray, Int)>,
) -> List<CapProofStep> {
  generic_proof_in(key, entries, leaf_for)
}

// ============================================================================
// TESTS
// ============================================================================

const alice: ByteArray = #"de"

const bob: ByteArray = #"df"

/// Cross-implementation ground truth, shared with
/// `integration/cap-accumulator-tree.ts`'s test of the same five values.
///
/// The off-chain builder serves every proof this validator will ever accept,
/// so the two must agree byte for byte or no trade verifies. Pinning the same
/// literals in BOTH places is what makes a silent drift between them
/// impossible — the same discipline `hash_dv_leaf` already gets.
test ground_truth_for_the_offchain_tree_builder() {
  and {
    hash_leaf(#"aa", 100) == #"d918ee9e60a917366d5fcb9a51106951125e21198515649a6c68bcab7ec275b7",
    hash_leaf(#"bb", 200) == #"15a32591eeb6865ef0b14a0679458e06912d856974fdc9655b124138f4446bba",
    // The root genesis writes, for every launch on both tiers.
    root_of([]) == #"441508bfe8c5ba1bf1c2c0f8af3e4243a66cb6a9c76988e76ee62b197ba7369a",
    root_of([(#"aa", 100)]) == #"e8f1be97fed35a91795869599ceea6dbd72d6ded7017eaf396cb8084fc6ac29e",
    root_of([(#"aa", 100), (#"bb", 200)]) == #"fc22d119891d02ced6418691c2c3d2b0511cb1df57c56cef4065a2c18f56182f",
  }
}

test leaf_separates_two_totals_for_one_key() {
  hash_leaf(alice, 100) != hash_leaf(alice, 101)
}

test leaf_separates_two_keys_at_one_total() {
  hash_leaf(alice, 100) != hash_leaf(bob, 100)
}

test zero_is_the_empty_leaf_whoever_holds_it() {
  and {
    leaf_for(alice, 0) == empty_leaf,
    leaf_for(bob, 0) == empty_leaf,
    leaf_for(alice, 1) != empty_leaf,
  }
}

/// The construction agrees with itself: a derived proof reaches the derived
/// root. Everything below leans on this, so it is asserted before anything is
/// built on top of it.
test a_derived_proof_reaches_the_derived_root() {
  let entries = [(alice, 100), (bob, 250)]
  and {
    recompute_root(leaf_for(alice, 100), proof_in(alice, entries)) == root_of(
      entries,
    ),
    recompute_root(leaf_for(bob, 250), proof_in(bob, entries)) == root_of(
      entries,
    ),
  }
}

/// A wallet that has never traded proves an empty slot against the same root
/// everyone else uses. This is what "no allowlist, anyone can buy" means
/// mechanically.
test a_key_absent_from_the_tree_proves_an_empty_slot() {
  let entries = [(alice, 100)]
  recompute_root(empty_leaf, proof_in(bob, entries)) == root_of(entries)
}

test the_empty_root_is_the_same_whichever_path_derives_it() {
  recompute_root(empty_leaf, proof_in(alice, [])) == recompute_root(
    empty_leaf,
    proof_in(bob, []),
  )
}

// -- transition ---------------------------------------------------------------

test transition_accepts_a_true_total_and_moves_the_root() {
  let entries = [(alice, 100)]
  let (ok, next) =
    transition(root_of(entries), alice, 100, 150, proof_in(alice, entries))
  and {
    ok,
    next == root_of([(alice, 150)]),
  }
}

/// The whole point of the first walk. A wallet claiming a smaller total than
/// it holds would otherwise mint itself headroom it already spent.
test transition_rejects_an_understated_total() {
  let entries = [(alice, 100)]
  let (ok, _) =
    transition(root_of(entries), alice, 40, 90, proof_in(alice, entries))
  !ok
}

test transition_rejects_another_wallets_proof() {
  let entries = [(alice, 100), (bob, 250)]
  // Bob's own path, presented as if it were Alice's slot.
  let (ok, _) =
    transition(root_of(entries), alice, 250, 300, proof_in(bob, entries))
  !ok
}

/// The duplicate-slot defence. A spender authors the new root, so a path other
/// than their own must be unusable — otherwise they could seed a second leaf
/// for themselves and prove against it next time from zero.
test transition_rejects_a_flipped_direction_bit() {
  let entries = [(alice, 100)]
  let proof = proof_in(alice, entries)
  expect [first, ..rest] = proof
  let flipped =
    list.push(rest, CapProofStep { ..first, goes_left: !first.goes_left })
  let (ok, _) = transition(root_of(entries), alice, 100, 150, flipped)
  !ok
}

/// A caller free to choose the depth is a caller free to choose a different
/// tree, so the length is pinned rather than inferred.
test transition_rejects_a_proof_of_the_wrong_depth() {
  let entries = [(alice, 100)]
  let short = list.take(proof_in(alice, entries), tree_depth - 1)
  let (ok, _) = transition(root_of(entries), alice, 100, 150, short)
  !ok
}

test transition_rejects_a_negative_total() {
  let (ok, _) = transition(root_of([]), alice, -1, 10, proof_in(alice, []))
  !ok
}

/// A first buy and a full exit are the two ends of the same path: an empty
/// slot fills, and a slot emptied again is byte-for-byte the state it started
/// in, so the wallet can re-enter the launch.
test a_wallet_that_sells_everything_back_frees_its_slot() {
  let start = root_of([])
  let (open_ok, after_buy) = transition(start, alice, 0, 100, proof_in(alice, []))
  let (close_ok, after_sell) =
    transition(after_buy, alice, 100, 0, proof_in(alice, [(alice, 100)]))
  and {
    open_ok,
    close_ok,
    after_buy != start,
    after_sell == start,
  }
}

/// Two wallets share one root without sharing headroom — the property that
/// makes a single 32-byte field stand in for a per-wallet list.
test two_wallets_update_the_same_root_independently() {
  let (a_ok, after_a) = transition(root_of([]), alice, 0, 100, proof_in(alice, []))
  let (b_ok, after_b) =
    transition(after_a, bob, 0, 250, proof_in(bob, [(alice, 100)]))
  and {
    a_ok,
    b_ok,
    after_b == root_of([(alice, 100), (bob, 250)]),
    // Alice's total survived Bob's update, so her next proof still works.
    transition(after_b, alice, 100, 120, proof_in(alice, [(alice, 100), (bob, 250)])).1st,
  }
}

/// A proof taken against a stale root fails, which is what forces a batcher to
/// build each order's proof against the root the previous order left.
test a_proof_against_a_stale_root_is_rejected() {
  let start = root_of([])
  let (_, after_a) = transition(start, alice, 0, 100, proof_in(alice, []))
  // Bob's proof built against the pre-Alice tree, presented after Alice moved.
  let (ok, _) = transition(after_a, bob, 0, 250, proof_in(bob, []))
  !ok
}
