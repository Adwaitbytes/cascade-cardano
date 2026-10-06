#!/usr/bin/env python3
"""Turns packages/shared/test/vectors.json (written by W2's TypeScript) into
Aiken tests in lib/cascade/tests/vectors.ak, so both languages are checked
against the same bytes. Re-run after the vectors change:

    python3 scripts/gen_vectors.py && aiken check -m vectors
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "..", "packages", "shared", "test", "vectors.json")
OUT = os.path.join(ROOT, "lib", "cascade", "tests", "vectors.ak")

TYPES = {
    "tree_config": "TreeConfig",
    "node_datum_root": "NodeDatum",
    "node_datum_receipt": "NodeDatum",
    "bond_datum": "BondDatum",
    "withdraw_redeemer_all_actions": "List<Action>",
    "logic_redeemer_core": "LogicRedeemer",
    "logic_redeemer_draw": "LogicRedeemer",
    "logic_redeemer_ext": "LogicRedeemer",
    "channel_datum": "ChannelDatum",
    "channel_redeemer": "ChannelRedeemer",
    "channel_redeemer_redeem": "ChannelRedeemer",
    "channel_redeemer_close": "ChannelRedeemer",
}


def b(hex_str):
    return f'#"{hex_str}"'


def leaf_expr(leaf):
    return (
        "PlanLeaf { "
        f"spec_hash: {b(leaf['spec_hash'])}, "
        f"parent_spec_hash: {b(leaf['parent_spec_hash'])}, "
        f"kind: {leaf['kind']}, "
        f"max_budget: {int(leaf['max_budget'])}, "
        f"max_fee: {int(leaf['max_fee'])}, "
        f"payee_hash: {b(leaf['payee_hash'])}, "
        f"acceptance_hash: {b(leaf['acceptance_hash'])} }}"
    )


def proof_expr(proof):
    steps = ", ".join(
        f"ProofStep {{ sibling: {b(s['sibling'])}, sibling_on_left: {'True' if s['sibling_on_left'] else 'False'} }}"
        for s in proof
    )
    return f"[{steps}]"


def imports(body):
    """Only the modules and names the generated tests use."""
    import re

    lines = ["use aiken/cbor", "use aiken/crypto.{blake2b_224}", "use cardano/transaction.{OutputReference}"]
    channel = [t for t in ("ChannelDatum", "ChannelRedeemer") if re.search(rf"\b{t}\b", body)]
    if channel:
        lines.append("use cascade/channel.{" + ", ".join(channel) + "}")
    for module in ("fixtures", "ids", "merkle"):
        if f"{module}." in body:
            lines.append(f"use cascade/{module}")
    names = [
        t
        for t in (
            "Action", "AddressPayment", "BondDatum", "LogicRedeemer", "MasumiReceipt",
            "MeteredReceipt", "Native", "NodeDatum", "PlanLeaf", "ProofStep", "TreeConfig",
        )
        if re.search(rf"\b{t}\b", body)
    ]
    if names:
        lines.append("use cascade/types.{" + ", ".join(names) + "}")
    return "\n".join(lines) + "\n"


def channel_import(v):
    used = sorted({TYPES[k] for k in v["plutus_data"] if TYPES[k].startswith("Channel")})
    return f"use cascade/channel.{{{', '.join(used)}}}\n" if used else ""


# Sections whose encoding depends on PlanLeaf.acceptance_hash or
# TreeConfig.min_dispute_window (ADR 1.6). Vectors written before W2 adopted
# 1.6 lack them; those sections are left out, loudly, until regenerated.
LEAF_DEPENDENT = {"tree_config", "withdraw_redeemer_all_actions", "logic_redeemer_draw"}


def main():
    with open(SRC) as f:
        v = json.load(f)
    current = all("acceptance_hash" in l["leaf"] for l in v["plan_leaves"])
    if not current:
        print(
            "WARNING: vectors.json predates ADR 1.6 (no acceptance_hash); "
            "skipping plan_leaves, merkle and " + ", ".join(sorted(LEAF_DEPENDENT))
        )
        v["plan_leaves"] = []
        v["merkle"] = []
        v["plutus_data"] = {k: x for k, x in v["plutus_data"].items() if k not in LEAF_DEPENDENT}
    tests = []
    names = v["token_names"]
    for i, r in enumerate(names["root"]):
        tests.append(
            f"test vector_root_id_{i}() {{\n"
            f"  let seed = OutputReference {{ transaction_id: {b(r['transaction_id'])}, output_index: {int(r['output_index'])} }}\n"
            f"  ids.root_id(seed) == {b(r['tree_id'])} && blake2b_224({b(r['preimage'])}) == {b(r['tree_id'])}\n}}"
        )
    for i, c in enumerate(names["child"]):
        tests.append(
            f"test vector_child_id_{i}() {{\n"
            f"  ids.child_id({b(c['parent_id'])}, {int(c['child_index'])}) == {b(c['node_id'])}\n}}"
        )
    for i, c in enumerate(names["config"]):
        tests.append(
            f"test vector_config_name_{i}() {{\n"
            f"  ids.config_name({b(c['tree_id'])}) == {b(c['config_name'])}\n}}"
        )
    leaves = v["plan_leaves"]
    for i, l in enumerate(leaves):
        tests.append(
            f"test vector_plan_leaf_{i}() {{\n"
            f"  let leaf = {leaf_expr(l['leaf'])}\n"
            "  and {\n"
            f"    merkle.leaf_bytes(leaf) == {b(l['leaf_bytes'])},\n"
            f"    merkle.leaf_hash(leaf) == {b(l['leaf_hash'])},\n"
            f"    cbor.serialise(leaf) == {b(l['leaf_cbor'])},\n"
            "  }\n}"
        )
    for m in v["merkle"]:
        n = int(m["leaf_count"])
        hashes = ", ".join(b(l["leaf_hash"]) for l in leaves[:n])
        checks = [f"fixtures.merkle_root([{hashes}]) == {b(m['root'])}"]
        for p in m["proofs"]:
            idx = int(p["index"])
            checks.append(
                f"merkle.root_from({b(leaves[idx]['leaf_hash'])}, {proof_expr(p['proof'])}) == {b(m['root'])}"
            )
            checks.append(
                f"fixtures.merkle_proof([{hashes}], {idx}) == {proof_expr(p['proof'])}"
            )
        body = ",\n    ".join(checks)
        tests.append(f"test vector_merkle_{n}_leaves() {{\n  and {{\n    {body},\n  }}\n}}")
    for key, hex_str in v["plutus_data"].items():
        ty = TYPES[key]
        tests.append(
            f"test vector_data_{key}() {{\n"
            f"  let bytes = {b(hex_str)}\n"
            "  expect Some(data) = cbor.deserialise(bytes)\n"
            f"  expect typed: {ty} = data\n"
            "  cbor.serialise(typed) == bytes\n}"
        )
    body = "\n\n".join(tests)
    header = (
        "//// GENERATED by scripts/gen_vectors.py from packages/shared/test/vectors.json.\n"
        "//// Do not edit by hand. Token names, plan leaves, Merkle roots and proofs,\n"
        "//// and the typed Plutus Data encodings shared with the TypeScript codecs.\n\n"
        + imports(body)
        + "\n"
    )
    with open(OUT, "w") as f:
        f.write(header + body + "\n")
    print(f"wrote {OUT} ({len(tests)} tests)")


if __name__ == "__main__":
    main()
