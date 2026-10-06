//// Validity range normalisation (ADR 5.1, T6).
////
//// "Before T": the validity upper bound is finite and every instant in the
//// range is <= T. "After T": the lower bound is finite and every instant in
//// the range is > T. The two can never hold together for the same T.

use aiken/interval
use aiken_design_patterns/validity_range_normalization.{
  ClosedRange, FromNegInf, ToPosInf, normalize_time_range,
}
use cardano/transaction.{ValidityRange}

pub fn is_before(range: ValidityRange, t: Int) -> Bool {
  when normalize_time_range(range) is {
    ClosedRange { upper, .. } -> upper <= t
    FromNegInf { upper } -> upper <= t
    _ -> False
  }
}

pub fn is_after(range: ValidityRange, t: Int) -> Bool {
  when normalize_time_range(range) is {
    ClosedRange { lower, .. } -> lower > t
    ToPosInf { lower } -> lower > t
    _ -> False
  }
}

test before_is_inclusive_of_deadline() {
  and {
    is_before(interval.before(100), 100),
    !is_before(interval.before(101), 100),
    // Ledger ranges are [lower, upper): upper 101 exclusive means last instant 100.
    is_before(interval.entirely_before(101), 100),
    !is_before(interval.everything, 100),
    !is_before(interval.after(0), 100),
  }
}

test after_is_strict() {
  and {
    is_after(interval.after(101), 100),
    !is_after(interval.after(100), 100),
    is_after(interval.entirely_after(100), 100),
    !is_after(interval.everything, 100),
    !is_after(interval.before(1_000), 100),
  }
}

test before_and_after_are_disjoint() {
  let r = interval.between(50, 150)
  and {
    !is_before(r, 100),
    !is_after(r, 100),
  }
}

test empty_range_is_neither() {
  let r = interval.between(10, 5)
  !is_before(r, 100) && !is_after(r, 0)
}
