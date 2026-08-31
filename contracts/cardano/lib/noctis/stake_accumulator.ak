//// Staking positions, held as one 32-byte root.
////
//// WHY THIS MODULE EXISTS
//// Reward accounting moved on-chain, and that changes what a position has to
//// be. While the governor computed rewards off-chain, a position could be its
//// own UTXO carrying its own datum: the datum was only a hint, and the real
//// weight came from the tokens the output actually held.
////
//// Once the validator computes what a position is owed, a datum anyone can
//// author becomes an authorization. Paying a UTXO to a script address runs no
//// validator, so anybody could write a position claiming a large stake and a
//// zero reward debt, and claim against it immediately. Requiring the output to
//// really hold its stake does not close that — the debt is the field that
//// decides the payout, and it would still be whatever its author typed.
////
//// So positions stop being separate UTXOs. They live behind one root in the
//// pool's own datum, and the only thing that can write that root is this
//// validator's own arithmetic. Staked tokens sit in the pool UTXO alongside
//// the reward budget; `total_staked` says how much of the balance is stake and
//// how much is rewards.
////
//// WHAT A LEAF HOLDS
//// Three fields, not one, which is the only difference from
//// `noctis/cap_accumulator`:
////   - `amount` — tokens staked.
////   - `debt`   — `amount * acc_reward_per_token / acc_scale` as of the
////     staker's last interaction. What they are owed is what that expression
////     comes to NOW, minus this. See the pool validator for the accumulator.
////   - `since`  — when the position last grew, for the unstake lock.
////
//// The tree shape, the slot derivation, the node hash and the empty subtree
//// are `cap_accumulator`'s, reached through its generic constructors rather
//// than copied. Only the leaf differs, and the leaf is the one thing that has
//// to differ.

use aiken/builtin.{blake2b_256}
use aiken/collection/list
use aiken/primitive/bytearray
use noctis/cap_accumulator.{
  CapProofStep, empty_leaf, generic_proof_in, generic_subtree_root,
  path_matches_key, recompute_root, tree_depth,
}

/// One staker's slot.
pub type Position {
  amount: Int,
  debt: Int,
  since: Int,
}

/// The value at a slot nobody has staked through yet.
pub const no_position: Position = Position { amount: 0, debt: 0, since: 0 }

/// 2^64 — what an 8-byte big-endian field can hold.
///
/// Real values sit far below it: `amount` is bounded by a launch's 1B supply,
/// `debt` by the pool's whole reward budget, and `since` is milliseconds. This
/// guards against an encoding abort, not a business limit.
pub const field_ceiling = 18_446_744_073_709_551_616

/// A leaf: whose position it is, and all three of its fields.
///
/// The key is IN the leaf, so a proof cannot be replayed for anyone else, and
/// every field is big-endian over a fixed 8 bytes, so no two positions can
/// hash alike through length ambiguity.
pub fn hash_position(key: ByteArray, pos: Position) -> ByteArray {
  blake2b_256(
    bytearray.concat(
      key,
      bytearray.concat(
        bytearray.from_int_big_endian(pos.amount, 8),
        bytearray.concat(
          bytearray.from_int_big_endian(pos.debt, 8),
          bytearray.from_int_big_endian(pos.since, 8),
        ),
      ),
    ),
  )
}

/// Canonical leaf: an empty position is ALWAYS the empty leaf. One
/// representation per value, so a staker who exits returns their slot to
/// exactly the state it started in and can stake again later.
pub fn leaf_for(key: ByteArray, pos: Position) -> ByteArray {
  if pos.amount == 0 {
    empty_leaf
  } else {
    hash_position(key, pos)
  }
}

/// Every field in range, and an empty position genuinely empty.
///
/// The second half is load-bearing rather than tidiness. `leaf_for` collapses
/// any zero-amount position to the empty leaf, so `{amount: 0, debt: 500}`
/// would prove against an untouched slot just as `no_position` does — and the
/// payout is computed as `amount * acc / scale - debt`, which for that
/// position is negative. Requiring the zero to be a real zero leaves one
/// meaning per leaf.
pub fn is_canonical(pos: Position) -> Bool {
  and {
    pos.amount >= 0,
    pos.debt >= 0,
    pos.since >= 0,
    pos.amount < field_ceiling,
    pos.debt < field_ceiling,
    pos.since < field_ceiling,
    pos.amount != 0 || and {
      pos.debt == 0,
      pos.since == 0,
    },
  }
}

/// Reads `before` as `key`'s committed position under `root`, and returns the
/// root it becomes at `after`.
///
/// The first walk is what makes `before` TRUE rather than merely claimed. A
/// staker who understates their debt cannot reach `root` with it, so the one
/// field that decides their payout is the one field they cannot choose.
pub fn transition(
  root: ByteArray,
  key: ByteArray,
  before: Position,
  after: Position,
  proof: List<CapProofStep>,
) -> (Bool, ByteArray) {
  if and {
    is_canonical(before),
    is_canonical(after),
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
// The same construction expressed on-chain so fixtures can be DERIVED rather
// than written as literal roots — see cap_accumulator's own note. Nothing
// below is reachable from a validator.

/// The root of a whole tree holding `entries` and nothing else.
pub fn root_of(entries: List<(ByteArray, Position)>) -> ByteArray {
  generic_subtree_root(entries, tree_depth, leaf_for)
}

/// `key`'s proof against `root_of(entries)`. `key` need not be in `entries` —
/// an absent key proves its empty slot, which is what a first-time staker does.
pub fn proof_in(
  key: ByteArray,
  entries: List<(ByteArray, Position)>,
) -> List<CapProofStep> {
  generic_proof_in(key, entries, leaf_for)
}

// ============================================================================
// TESTS
// ============================================================================

const alice: ByteArray = #"de"

const bob: ByteArray = #"df"

fn pos(amount: Int, debt: Int, since: Int) -> Position {
  Position { amount, debt, since }
}

/// Cross-implementation ground truth, shared with
/// `integration/stake-accumulator-tree.ts`'s test of the same values.
///
/// The off-chain builder serves every proof this validator will ever accept,
/// so the two must agree byte for byte or no stake, claim or exit verifies.
/// Pinning the same literals in BOTH places is what makes a silent drift
/// impossible — the same discipline cap_accumulator's own ground truth gets.
test ground_truth_for_the_offchain_tree_builder() {
  and {
    hash_position(#"aa", pos(100, 5, 1_700_000_000_000)) == #"b4c3f70d252a7638af39026652ad34d10dfe98dd3e3de69928795bf292390916",
    root_of([]) == #"441508bfe8c5ba1bf1c2c0f8af3e4243a66cb6a9c76988e76ee62b197ba7369a",
    root_of([(#"aa", pos(100, 5, 1_700_000_000_000))]) == #"a803d95c5e6d771d5bd32b12af0a829ad67adb45f6c4f00bc82a90fb4b8bae20",
  }
}

/// The empty tree is the SAME root the cap accumulator's empty tree has, since
/// both are all-empty-leaf trees of the same depth. Asserted so that a change
/// to either module's shape shows up here rather than only in production.
test the_empty_tree_matches_the_shared_construction() {
  root_of([]) == cap_accumulator.root_of([])
}

test a_leaf_separates_every_field() {
  let base = pos(100, 5, 7)
  and {
    leaf_for(alice, base) != leaf_for(alice, pos(101, 5, 7)),
    leaf_for(alice, base) != leaf_for(alice, pos(100, 6, 7)),
    leaf_for(alice, base) != leaf_for(alice, pos(100, 5, 8)),
    leaf_for(alice, base) != leaf_for(bob, base),
  }
}

test an_empty_position_is_the_empty_leaf_whoever_holds_it() {
  and {
    leaf_for(alice, no_position) == empty_leaf,
    leaf_for(bob, no_position) == empty_leaf,
    leaf_for(alice, pos(1, 0, 0)) != empty_leaf,
  }
}

/// The reason `is_canonical` exists. A zero-amount position carrying a debt
/// hashes to the empty leaf, so it would prove against a slot nobody has
/// touched — and its payout, `0 * acc / scale - debt`, is negative.
test a_zero_amount_position_may_not_carry_a_debt() {
  and {
    !is_canonical(pos(0, 500, 0)),
    !is_canonical(pos(0, 0, 1_700_000_000_000)),
    is_canonical(no_position),
    is_canonical(pos(0, 0, 0)),
  }
}

test negative_fields_are_refused_before_they_can_abort_an_encoding() {
  and {
    !is_canonical(pos(-1, 0, 0)),
    !is_canonical(pos(100, -1, 0)),
    !is_canonical(pos(100, 0, -1)),
  }
}

test a_derived_proof_reaches_the_derived_root() {
  let entries = [(alice, pos(100, 5, 7)), (bob, pos(250, 9, 11))]
  and {
    recompute_root(leaf_for(alice, pos(100, 5, 7)), proof_in(alice, entries)) == root_of(
      entries,
    ),
    recompute_root(leaf_for(bob, pos(250, 9, 11)), proof_in(bob, entries)) == root_of(
      entries,
    ),
  }
}

/// A staker who has never staked proves an empty slot against the same root
/// everyone else uses. This is what "no registration, anyone can stake" means
/// mechanically.
test a_key_absent_from_the_tree_proves_an_empty_slot() {
  let entries = [(alice, pos(100, 5, 7))]
  recompute_root(empty_leaf, proof_in(bob, entries)) == root_of(entries)
}

// -- transition ---------------------------------------------------------------

test transition_accepts_a_true_position_and_moves_the_root() {
  let entries = [(alice, pos(100, 5, 7))]
  let (ok, next) =
    transition(
      root_of(entries),
      alice,
      pos(100, 5, 7),
      pos(150, 9, 20),
      proof_in(alice, entries),
    )
  and {
    ok,
    next == root_of([(alice, pos(150, 9, 20))]),
  }
}

/// The whole point of the first walk. `debt` is what decides a payout, so a
/// staker understating it would mint themselves rewards they already drew.
test transition_rejects_an_understated_debt() {
  let entries = [(alice, pos(100, 500, 7))]
  let (ok, _) =
    transition(
      root_of(entries),
      alice,
      pos(100, 0, 7),
      pos(100, 600, 7),
      proof_in(alice, entries),
    )
  !ok
}

test transition_rejects_another_stakers_proof() {
  let entries = [(alice, pos(100, 5, 7)), (bob, pos(250, 9, 11))]
  let (ok, _) =
    transition(
      root_of(entries),
      alice,
      pos(250, 9, 11),
      pos(300, 9, 11),
      proof_in(bob, entries),
    )
  !ok
}

/// The duplicate-slot defence. A spender authors the new root, so a path other
/// than their own must be unusable — otherwise they could seed a second slot
/// for themselves and prove against it next time with a zero debt.
test transition_rejects_a_flipped_direction_bit() {
  let entries = [(alice, pos(100, 5, 7))]
  let proof = proof_in(alice, entries)
  expect [first, ..rest] = proof
  let flipped =
    list.push(rest, CapProofStep { ..first, goes_left: !first.goes_left })
  let (ok, _) =
    transition(root_of(entries), alice, pos(100, 5, 7), pos(150, 5, 7), flipped)
  !ok
}

test transition_rejects_a_proof_of_the_wrong_depth() {
  let entries = [(alice, pos(100, 5, 7))]
  let short = list.take(proof_in(alice, entries), tree_depth - 1)
  let (ok, _) =
    transition(root_of(entries), alice, pos(100, 5, 7), pos(150, 5, 7), short)
  !ok
}

/// A first stake and a full exit are the two ends of the same path: an empty
/// slot fills, and a slot emptied again is byte-for-byte the state it started
/// in, so the staker can re-enter later.
test a_staker_who_exits_frees_their_slot() {
  let start = root_of([])
  let (open_ok, after_stake) =
    transition(start, alice, no_position, pos(100, 0, 7), proof_in(alice, []))
  let (exit_ok, after_exit) =
    transition(
      after_stake,
      alice,
      pos(100, 0, 7),
      no_position,
      proof_in(alice, [(alice, pos(100, 0, 7))]),
    )
  and {
    open_ok,
    exit_ok,
    after_stake != start,
    after_exit == start,
  }
}

/// Two stakers share one root without sharing anything else — the property
/// that makes a single 32-byte field stand in for a per-staker list.
test two_stakers_update_the_same_root_independently() {
  let (a_ok, after_a) =
    transition(root_of([]), alice, no_position, pos(100, 0, 7), proof_in(alice, []))
  let (b_ok, after_b) =
    transition(
      after_a,
      bob,
      no_position,
      pos(250, 0, 9),
      proof_in(bob, [(alice, pos(100, 0, 7))]),
    )
  and {
    a_ok,
    b_ok,
    after_b == root_of([(alice, pos(100, 0, 7)), (bob, pos(250, 0, 9))]),
  }
}

/// A proof taken against a stale root fails, which is what forces a batcher to
/// build each action's proof against the root the previous one left.
test a_proof_against_a_stale_root_is_rejected() {
  let start = root_of([])
  let (_, after_a) =
    transition(start, alice, no_position, pos(100, 0, 7), proof_in(alice, []))
  let (ok, _) =
    transition(after_a, bob, no_position, pos(250, 0, 9), proof_in(bob, []))
  !ok
}
