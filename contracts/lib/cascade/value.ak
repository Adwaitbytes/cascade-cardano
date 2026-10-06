//// Value arithmetic. Every node value check is exact equality (ADR 4.3).

use aiken/crypto.{ScriptHash}
use cardano/address.{Address, VerificationKey}
use cardano/assets.{Assets}
use cascade/types.{AssetClass, Native, NodeDatum}

pub const lovelace: AssetClass = AssetClass { policy: #"", name: #"" }

pub fn of_asset(asset: AssetClass, quantity: Int) -> Assets {
  assets.from_asset(asset.policy, asset.name, quantity)
}

/// `from_asset(asset, q) + from_lovelace(l)`, merged so lovelace budgets add up.
pub fn asset_plus_lovelace(asset: AssetClass, quantity: Int, l: Int) -> Assets {
  of_asset(asset, quantity) |> assets.add(#"", #"", l)
}

pub fn quantity(value: Assets, asset: AssetClass) -> Int {
  assets.quantity_of(value, asset.policy, asset.name)
}

/// The escrowed part of a node: native nodes hold their budget minus what is
/// drawn into open children and what has left the tree (ADR 1.5); receipts
/// hold nothing (the budget sits in the external escrow, ADR 8).
pub fn escrow(d: NodeDatum) -> Int {
  if d.kind == Native {
    d.budget - d.committed - d.spent
  } else {
    0
  }
}

/// `from_asset(asset, budget - committed - spent) + from_lovelace(structural) + token`.
pub fn expected_value(
  asset: AssetClass,
  own_hash: ScriptHash,
  d: NodeDatum,
) -> Assets {
  asset_plus_lovelace(asset, escrow(d), d.structural)
    |> assets.add(own_hash, d.node_id, 1)
}

/// Subtracts one token of `own_hash` named `name`.
pub fn without_token(
  value: Assets,
  own_hash: ScriptHash,
  name: ByteArray,
) -> Assets {
  assets.add(value, own_hash, name, -1)
}

pub fn is_key_address(address: Address) -> Bool {
  when address.payment_credential is {
    VerificationKey(_) -> True
    _ -> False
  }
}

test expected_value_merges_lovelace_budgets() {
  let d = NodeDatum {
    tree_id: #"",
    node_id: #"aa",
    parent_id: None,
    depth: 0,
    next_child: 0,
    operator: #"",
    payee: address.from_verification_key(#"01"),
    kind: Native,
    budget: 10,
    fee: 1,
    committed: 4,
    children_open: 1,
    structural: 2_000_000,
    external_lovelace: 0,
    spec_hash: #"",
    input_hash: #"",
    result_hash: None,
    acceptance: types.AutoAfterWindow,
    submit_by: 0,
    challenge_until: 0,
    refund_after: 0,
    dispute_until: 0,
    external_ref: None,
    frozen: False,
    state: types.Funded,
    spent: 0,
  }
  and {
    expected_value(lovelace, #"ff", d) == (
      assets.from_lovelace(2_000_006) |> assets.add(#"ff", #"aa", 1)
    ),
    expected_value(AssetClass { policy: #"cc", name: #"01" }, #"ff", d) == (
      assets.from_lovelace(2_000_000)
        |> assets.add(#"cc", #"01", 6)
        |> assets.add(#"ff", #"aa", 1)
    ),
    expected_value(
      lovelace,
      #"ff",
      NodeDatum { ..d, kind: types.MasumiReceipt },
    ) == ( assets.from_lovelace(2_000_000) |> assets.add(#"ff", #"aa", 1) ),
  }
}

test fully_committed_node_holds_no_asset() {
  expect of_asset(AssetClass { policy: #"cc", name: #"01" }, 0) == assets.zero
  asset_plus_lovelace(AssetClass { policy: #"cc", name: #"01" }, 0, 5) == assets.from_lovelace(
    5,
  )
}
