//// The transaction's validity range is the clock.
////
//// A deadline that has to be PAST when a transaction runs is compared against
//// the range's LOWER bound, so no slot the transaction is valid in can precede
//// it. A redeemer's own timestamp, held inside the range by
//// `interval.contains`, then says where in the range the builder believed the
//// clock stood; it is not by itself the proof that the deadline has passed,
//// because a range may begin up to its whole permitted width before that
//// timestamp.

use aiken/interval.{Finite, Interval}

/// The earliest moment this transaction can be valid. An unbounded lower end
/// is refused outright: nothing can be shown past against a range that starts
/// at the beginning of time.
pub fn lower_bound(range: Interval) -> Int {
  expect Finite(t) = range.lower_bound.bound_type
  t
}

/// The deadline is past for the WHOLE range, not merely for the timestamp the
/// builder chose inside it.
pub fn past(range: Interval, deadline: Int) -> Bool {
  lower_bound(range) >= deadline
}

/// Strictly past: every valid moment is later than the deadline.
pub fn strictly_past(range: Interval, deadline: Int) -> Bool {
  lower_bound(range) > deadline
}

test lower_bound_is_the_range_start() {
  lower_bound(interval.between(1_000, 1_600)) == 1_000
}

test past_holds_only_when_the_whole_range_is_past() {
  and {
    past(interval.between(1_000, 1_600), 1_000),
    !past(interval.between(999, 1_600), 1_000),
    strictly_past(interval.between(1_001, 1_600), 1_000),
    !strictly_past(interval.between(1_000, 1_600), 1_000),
  }
}

test an_unbounded_start_is_refused() fail {
  lower_bound(interval.before(1_600)) == 0
}
