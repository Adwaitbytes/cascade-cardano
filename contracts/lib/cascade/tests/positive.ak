//// Every honest scenario passes and conserves value exactly.

use cascade/fixtures.{conserves_value, run}
use cascade/scenarios

test fund_root_ok() {
  run(scenarios.fund_root())
}

test top_up_ok() {
  run(scenarios.top_up())
}

test draw_root_ok() {
  run(scenarios.draw_root())
}

test draw_child_ok() {
  run(scenarios.draw_child())
}

test submit_ok() {
  run(scenarios.submit())
}

test accept_ok() {
  run(scenarios.accept())
}

test challenge_ok() {
  run(scenarios.challenge())
}

test escalate_ok() {
  run(scenarios.escalate())
}

test resolve_ok() {
  run(scenarios.resolve())
}

test resolve_root_ok() {
  run(scenarios.resolve_root())
}

test refund_ok() {
  run(scenarios.refund())
}

test refund_root_ok() {
  run(scenarios.refund_root())
}

test settle_child_ok() {
  run(scenarios.settle_child())
}

test close_root_ok() {
  run(scenarios.close_root())
}

test cancel_ok() {
  run(scenarios.cancel())
}

test freeze_ok() {
  run(scenarios.freeze())
}

test unfreeze_ok() {
  run(scenarios.unfreeze())
}

// Invariant 1 at the transaction level: every escrow-moving scenario puts
// back exactly what it took, net of minted and burnt thread tokens.

test conservation_holds_in_every_value_moving_scenario() {
  and {
    conserves_value(scenarios.draw_root()),
    conserves_value(scenarios.draw_child()),
    conserves_value(scenarios.resolve()),
    conserves_value(scenarios.resolve_root()),
    conserves_value(scenarios.refund()),
    conserves_value(scenarios.refund_root()),
    conserves_value(scenarios.settle_child()),
    conserves_value(scenarios.close_root()),
    conserves_value(scenarios.cancel()),
  }
}
