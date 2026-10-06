# ADR 0001: On-chain design (frozen interface)

Status: accepted, frozen at Wave 0. Changes need a `DECISIONS.md` entry and a message to W1, W2, W3, W4.
Scope: PRD sections 7, 8.5, 8.6, 11.3, 11.4, 13.1, 16.2.

This record turns PRD section 7 into exact types, byte encodings and rules. Where the PRD is silent or
contradicts itself, the resolution is stated here with its reason.

## 1. Scripts and parameters

| Script | Parameters | Handlers | Role |
| --- | --- | --- | --- |
| `cascade_config` | none | `spend`, `else` fails | Holds one Tree Config UTxO per tree. Spend succeeds only when the transaction burns every non-ADA token in the spent input and the input holds at least one. So the config UTxO cannot move and can only be consumed at close, when `cascade_node` burns its token. |
| `cascade_bond` | none | `spend`, `else` fails | Holds bonds. Two paths: (a) the tx mints or burns under policy `datum.authority` (the `cascade_node` hash; see 1.3), so the node shell and its logic decide the payout, or (b) after `datum.release_after`, signed by `datum.owner` (owner reclaim; liveness). |
| `cascade_channel` | none | `spend`, `else` fails | Metered leaf voucher channel (see section 9). Provider redeem path, plus close path delegated to `Script(datum.authority)` withdrawal. |
| `cascade_node` | `config_hash`, `bond_hash`, `channel_hash` | `mint`, `spend`, `withdraw`, `publish` | Thread tokens, node UTxOs and all tree logic. |

Why this shape:
- PRD 7.1 lists `cascade_config` with `spend (always fails), mint`, yet `CloseRoot` and `Cancel` burn the config token, which needs the config UTxO spent. A literal always-fail spend makes that impossible. Resolution: the config token is minted under the `cascade_node` policy (one policy for the whole tree) and `cascade_config` spend allows consumption only together with a burn of its tokens. `cascade_config` has no mint handler. Logged in `DECISIONS.md`.
- `cascade_bond` and `cascade_channel` must defer to `cascade_node`, and `cascade_node` must know their addresses. Parameterising both sides would be circular. Resolution: bond and channel scripts are unparameterised and name their authority in the datum. `cascade_node` is parameterised by their hashes. A bond or channel whose datum names another authority is simply not governed by Cascade.

`cascade_receipt` from PRD 7.1 is not a separate script: receipt nodes are `cascade_node` UTxOs with `kind = MasumiReceipt | MeteredReceipt`, exactly as the PRD's "part of `cascade_node`" says.

### 1.1 Withdraw-zero structure (PRD 7.1, stake validator pattern)

- `spend` for a node UTxO: passes only if `self.withdrawals` contains `Script(own_hash)` with amount 0, where `own_hash` is the payment credential of the spent input. All logic lives in `withdraw`.
- `mint`: passes only if `self.withdrawals` contains `Script(policy_id)` with amount 0.
- `withdraw(redeemer: List<Action>, credential, self)`: requires own withdrawal amount 0 (T18), then validates every action, then the global checks in 1.2.
- `publish(_, certificate, _)`: passes only for `RegisterCredential` (T18). Every other certificate fails.

### 1.3 Script size split (amendment, Wave 1)

Measured: a single `cascade_node` with all logic compiled to 23,286 bytes, above `maxTxSize` 16,384 on Yaci and preprod, so it could not be deployed even as a reference script. Resolution:

| Script | Parameters | Handlers | Role |
| --- | --- | --- | --- |
| `cascade_node` | `config_hash`, `bond_hash`, `channel_hash`, `logic_core_hash`, `logic_draw_hash` | `mint`, `spend`, `else` fails | Thread-token policy and node address. `spend` and `mint` pass only if exactly one of the two logic credentials appears in `self.withdrawals` with amount 0, and that withdrawal's redeemer (read from `self.redeemers`) is a `LogicRedeemer` whose `node_hash` equals this script's own hash. |
| `cascade_logic_core` | `config_hash`, `bond_hash`, `channel_hash` | `withdraw`, `publish` | FundRoot, TopUp, Submit, Accept, Challenge, Escalate, Refund, SettleChild, CloseRoot, Cancel, Freeze, Unfreeze |
| `cascade_logic_draw` | `config_hash`, `bond_hash`, `channel_hash` | `withdraw`, `publish` | Draw (all kinds), CloseReceipt, Resolve |

```
LogicRedeemer { node_hash: ByteArray, actions: List<Action> }
```

- Each logic `withdraw` handler reads `node_hash` from its own redeemer and uses it as the node address and policy for every check in 1.2 and 5.1. This is safe because `cascade_node` only accepts a logic withdrawal whose declared `node_hash` equals its own hash; a logic run with any other `node_hash` cannot authorise a real node input or mint.
- Each logic script rejects actions outside its set, and still enforces full input coverage (1.2), so two logic scripts can never split one transaction between them (the node also requires exactly one).
- Bond and channel datums name the `cascade_node` hash as `authority`, and their authority path requires the transaction to mint or burn under that policy (`tokens(self.mint, authority)` non-empty), not merely a withdrawal. A logic withdrawal alone is not enough: a logic script trusts the `node_hash` in its redeemer, and only the node shell checks it, so without a forced node run an attacker could run the logic with a fake `node_hash`, fake config and fake arbiters, and slash a real bond. Resolve burns the node token and CloseReceipt burns the receipt token, so both always run the node shell. Found by W1 (test `bond_rejects_logic_withdrawal_alone`).
- Both logic stake credentials are registered at deploy (T18); `publish` accepts only `RegisterCredential`. `cascade_node` needs no stake registration.
- Each script must compile under 15,500 bytes with traces silent; `contracts/BUDGET.md` records sizes.

### 1.4 Third logic script and channel thread token (amendment, Wave 1)

- `cascade_logic_draw` reached 15,131 bytes with Masumi receipts. `CloseReceipt` and `Resolve` move to a third withdraw validator `cascade_logic_ext` (parameters `config_hash`, `bond_hash`, `channel_hash`; same rules as 1.3). `cascade_logic_draw` keeps `Draw` (all kinds). `cascade_node` takes a third logic hash and accepts exactly one of the three logic withdrawals. Parameter order for `cascade_node`: `config_hash`, `bond_hash`, `channel_hash`, `logic_core_hash`, `logic_draw_hash`, `logic_ext_hash`.
- Channel identity: a Metered Draw mints one channel token under the node policy named `#"6b" ++ receipt_node_id` (29 bytes, ASCII `k` prefix; distinct from 28-byte node names and the `c`-prefixed config name) into the channel output. Every provider Redeem must keep the token in the continuing output. CloseReceipt requires the channel input to hold the token matching the receipt's `node_id` and burns it. Without the token a look-alike UTxO at the channel address could be closed against the receipt and strand the real deposit (finding by W1).
- `ChannelRedeemer = Redeem { amount: Int, signature: ByteArray, out: Int } | Close` (constructors 0, 1).

### 1.5 Audit fixes (amendment, Wave 1, independent audit of 21f7228)

- F1 (critical, liveness): a parent subtracted a child's current `budget` from `committed`, but a child's budget shrank when it paid out, so `committed` never returned to 0 and the tree locked. Fix: `NodeDatum` gains field 25 `spent: Int` (asset units that have left the tree from this node: AddressPayment amounts, settled children's fees and spent, Resolve worker shares, Masumi receipt budgets, redeemed channel amounts). `budget` never decreases (only TopUp raises it at the root). `committed` means only value drawn into open children and returns to 0 when `children_open` reaches 0. Held value is `budget - committed - spent`; `expected_value` uses it. Closing a child `d` into parent `p`: `p.committed -= d.budget`, and `p.spent += d.spent + paid_out`, where `paid_out` is `d.fee` (SettleChild), `split.worker` (Resolve), 0 (Refund), `d.budget` (Masumi CloseReceipt) or `redeemed` (Metered CloseReceipt). Draw requires `sum(child.budget) + p.fee <= p.budget - p.committed - p.spent`; AddressPayment adds to `p.spent`. New fields start at 0.
- F2 (critical): a logic credential's reward balance can be made non-zero by anyone (retired pool deposit or governance deposit refund), and the ledger forces a withdrawal to equal the balance. Fix: the node shell and the logic scripts require only that the logic credential is present in `withdrawals`, any amount.
- F3 (medium): the protocol-fee output could not meet min-UTxO. Fix: CloseRoot carries `protocol_lovelace` (capped like `payee_lovelace`, taken from `structural`); the protocol output is `from_asset(asset, protocol_fee) + from_lovelace(protocol_lovelace)`.
- F4 (medium): a Metered CloseReceipt is allowed only after the channel `timeout` or when the channel `provider` signs; the receipt operator alone cannot close it early.
- F5 (medium, T7): FundRoot requires `arbiter_threshold >= 1` when `Native` is an allowed leaf kind. The deadline exit after `dispute_until` gives the parent the full value when the node is Challenged (the worker never escalated) and gives the worker `fee` with the rest to the parent when the node is Disputed (arbiters were silent). Bonds stay with their owners on the deadline exit.
- Low findings (self-hire through leaf reuse, sub-min-UTxO slash shares) stay mitigated off chain by the signer gates and plan review, as ADR section 3 states.

### 1.6 Evaluator fixes (amendment, end of Waves 1 and 2)

- E1 (critical, cross-script double satisfaction): Masumi `WithdrawRefund` accepts any output to `buyer_return_address` tagged with an inline datum equal to its own output reference, and Cascade root exits pay the same `buyer_refund` address. One tagged output could satisfy both scripts. Fix: every output Cascade pays to a key address (`payee_out`, `protocol_out`, `refund_out`, bond `ReturnBond` and `SlashBond` outputs, AddressPayment outputs) must have `datum == NoDatum` and no reference script. A Masumi-tagged output can then never satisfy a Cascade check.
- E6 (T7): `TreeConfig` gains field 20 `min_dispute_window: Int` (ms). FundRoot and Draw require `dispute_until - challenge_until >= min_dispute_window` for the root and every child, so a worker always has time to escalate. FundRoot requires `min_dispute_window > 0`. An unescalated challenge stands by design: the worker accepted it by not escalating.
- E7 (T8): `PlanLeaf` gains field 6 `acceptance_hash` (32 bytes), appended to `leaf_bytes`. `acceptance_bytes`: ParentAccept `#"00"`; VerifierQuorum `#"01" ++ be8(k) ++ key_1 ++ ... ++ key_n` in datum order; AutoAfterWindow `#"02"`; BuyerAccept `#"03"`. `acceptance_hash = sha2_256(acceptance_bytes)`. Draw requires `sha2_256(acceptance_bytes(child.acceptance)) == leaf.acceptance_hash`, so verifier keys are buyer-approved in the plan.
- E8 (T5): of the 19 Masumi fields, 14 are constrained on chain. `seller_return_address` must have a VerificationKey payment credential; `reference_key`, `seller_nonce`, `buyer_nonce` and `agent_identifier` come from the seller's signed terms and are checked off chain by the SDK and signer before signing (they cannot be verified on chain without the seller's signature). The threat model states this exactly.
- E12: the Resolve deadline exit requires `payee_lovelace == 0` for lovelace trees and for Challenged nodes. When a Disputed node pays the worker its fee in a native asset, the payee output may carry up to the usual 2 ADA cap of lovelace from `structural`, because a token-only output cannot meet min-UTxO and the node could otherwise never close (refined by W1).
- E13 (low, accepted): AddressPayment and the signer change rule match the payment key hash; a different stake credential cannot move the payee's funds, it only affects delegation. Documented, not enforced.
- E14: `protocol_fee_address` and `arbiter_fee_address` must have VerificationKey payment credentials; a Metered channel's `timeout` must be at least the receipt's `submit_by`.

### 1.2 Global checks in `withdraw` (T1, T2, invariant 8)

1. Input coverage. Every transaction input that is (a) at a payment credential `Script(own_hash)`, (b) at `Script(config_hash)`, (c) at `Script(bond_hash)` with `datum.authority == own_hash`, or (d) at `Script(channel_hash)` with `datum.authority == own_hash` and spent through the close path, is claimed by exactly one action. Claimed input indices, collected across all actions in order, are strictly increasing.
2. Output uniqueness. Output indices named by all actions, collected in order, are strictly increasing. So no output satisfies two checks.
3. Mint exactness. `tokens(self.mint, own_hash)` equals exactly the sum of the mint deltas declared by the actions.
4. Every node input and output is checked to hold exactly one token of `own_hash`, whose name equals `datum.node_id`, and no other token of `own_hash` (T1).

## 2. Identity and byte encodings (PRD 7.2)

All integers in hashed byte strings are unsigned big-endian of fixed width.

| Item | Encoding |
| --- | --- |
| Root token name, `tree_id` | `blake2b_224(seed.transaction_id ++ be16(seed.output_index))` |
| Child token name | `blake2b_224(parent.node_id ++ be32(child_index))`, where `child_index = parent.next_child + i` for the i-th child in a Draw, counting from 0 |
| Config token name | `#"63" ++ tree_id` (29 bytes, ASCII `c` prefix). 29 bytes, so it can never equal a 28-byte node name |
| Node UTxO | Exactly one token of the Cascade policy, name 28 bytes, equal to `datum.node_id` |

## 3. Plan membership (PRD 7.3 `plan_root`, 10.1 step 6, A11)

The on-chain plan leaf binds the fields the validator can check. It is hashed from fixed-width bytes, never from CBOR, so TypeScript, Python and Aiken agree byte for byte.

```
PlanLeaf {
  spec_hash:        ByteArray  -- 32 bytes, SHA-256 of JCS(node spec)
  parent_spec_hash: ByteArray  -- 32 bytes; spec_hash of the parent node. Root children use the root's spec_hash
  kind:             NodeKind   -- Native = 0, MasumiReceipt = 1, MeteredReceipt = 2, AddressPayment = 3
  max_budget:       Int        -- in the tree asset's base units
  max_fee:          Int
  payee_hash:       ByteArray  -- 28 bytes: the only key hash an AddressPayment may pay; 28 zero bytes for other kinds
}
leaf_bytes = spec_hash ++ parent_spec_hash ++ be8_1(kind_index) ++ be64(max_budget) ++ be64(max_fee) ++ payee_hash
leaf_hash  = sha2_256(#"00" ++ leaf_bytes)
node_hash  = sha2_256(#"01" ++ left ++ right)
```

- A proof is `List<ProofStep>`, `ProofStep { sibling: ByteArray, sibling_on_left: Bool }`, folded from the leaf to the root.
- Odd levels: the last node is paired with itself. So `[a,b,c]` and `[a,b,c,c]` share a root; this does not weaken membership proofs, and the planner rejects duplicate spec hashes in a Plan.
- Leaves are ordered as the Plan lists them. The root node itself is also a leaf, with `parent_spec_hash` = 32 zero bytes.
- A replacement hire after a refund reuses the same spec leaf. The leaf binds the task, the position in the tree, the rail and the price ceiling, not the agent. The buyer approves the fallback agents off chain in the Plan; the signer's plan-match gate enforces them.

## 4. Datums

### 4.1 Common types

```
AssetClass { policy: ByteArray, name: ByteArray }   -- lovelace is policy #"" and name #""
NodeKind   = Native | MasumiReceipt | MeteredReceipt | AddressPayment   -- constructor 0, 1, 2, 3
             -- AddressPayment never appears in a NodeDatum; it exists only as a PlanLeaf kind and a Draw child
NodeState  = Funded | Submitted | Challenged | Disputed | Accepted | Refunded   -- 0 to 5
Acceptance = ParentAccept { key: VerificationKeyHash }         -- 0
           | VerifierQuorum { keys: List<VerificationKeyHash>, k: Int }   -- 1
           | AutoAfterWindow                                   -- 2
           | BuyerAccept { key: VerificationKeyHash }          -- 3
```

The acceptance keys are resolved at Draw time and checked: `ParentAccept.key == parent.operator`, `BuyerAccept.key == config.buyer`, `1 <= k <= length(keys)`. Carrying keys in the datum lets `Accept` run without reading the parent or the config.

### 4.2 `TreeConfig` (inline datum at `cascade_config`)

Field order is the Plutus constructor field order.

| # | Field | Type | Notes |
| --- | --- | --- | --- |
| 0 | `tree_id` | ByteArray | 28 bytes |
| 1 | `buyer` | VerificationKeyHash | |
| 2 | `buyer_refund` | Address | payment credential must be `VerificationKey` |
| 3 | `asset` | AssetClass | tUSDM on preprod, a local test token on Yaci, or lovelace |
| 4 | `arbiters` | List<VerificationKeyHash> | |
| 5 | `arbiter_threshold` | Int | `1 <= t <= length(arbiters)`, or 0 arbiters and t = 0 (no arbitration) |
| 6 | `arbiter_fee_address` | Address | receives the arbiter share of slashed bonds |
| 7 | `max_depth` | Int | root depth is 0 |
| 8 | `max_fanout` | Int | cap on `children_open` of any node |
| 9 | `max_child_share_bps` | Int | `child.budget * 10000 <= parent.budget * max_child_share_bps` |
| 10 | `min_challenge_window` | Int | ms |
| 11 | `min_safety_margin` | Int | ms |
| 12 | `allowed_leaf_kinds` | List<NodeKind> | |
| 13 | `masumi_script_hash` | ByteArray | 28 bytes; Masumi `vested_pay` V2 |
| 14 | `channel_script_hash` | ByteArray | must equal the `channel_hash` parameter |
| 15 | `plan_root` | ByteArray | 32 bytes |
| 16 | `protocol_fee_bps` | Int | 0 on the hackathon deployment |
| 17 | `protocol_fee_address` | Address | |
| 18 | `challenge_bond` | Int | minimum challenger bond, lovelace |
| 19 | `slash_wronged_bps` | Int | share of a slashed bond paid to the wronged side; the rest goes to `arbiter_fee_address` |

Fields 5, 6, 18 and 19 split out what PRD 7.3 and 11.3 describe in words ("threshold", "split ratios live in Tree Config").

### 4.3 `NodeDatum` (inline datum at `cascade_node`)

| # | Field | Type | Notes |
| --- | --- | --- | --- |
| 0 | `tree_id` | ByteArray | |
| 1 | `node_id` | ByteArray | token name |
| 2 | `parent_id` | Option<ByteArray> | None at the root |
| 3 | `depth` | Int | |
| 4 | `next_child` | Int | |
| 5 | `operator` | VerificationKeyHash | |
| 6 | `payee` | Address | payment credential must be `VerificationKey` |
| 7 | `kind` | NodeKind | |
| 8 | `budget` | Int | asset units; includes fee and children |
| 9 | `fee` | Int | |
| 10 | `committed` | Int | budget drawn into open children |
| 11 | `children_open` | Int | |
| 12 | `structural` | Int | lovelace structural reserve held by this node (PRD 7.8) |
| 13 | `external_lovelace` | Int | receipts only: lovelace locked beside the budget in the external escrow; 0 for native |
| 14 | `spec_hash` | ByteArray | 32 bytes |
| 15 | `input_hash` | ByteArray | 32 bytes |
| 16 | `result_hash` | Option<ByteArray> | |
| 17 | `acceptance` | Acceptance | |
| 18 | `submit_by` | Int | ms |
| 19 | `challenge_until` | Int | ms |
| 20 | `refund_after` | Int | ms |
| 21 | `dispute_until` | Int | ms |
| 22 | `external_ref` | Option<OutputReference> | receipts only |
| 23 | `frozen` | Bool | meaningful at the root only |
| 24 | `state` | NodeState | |

Fields 12 and 13 are additions to PRD 7.4. They make value checks exact. Without them the validator cannot tell the structural lovelace from the budget when the asset is lovelace.

Value rule, checked for every node input and output:

```
expected_value(d) = from_asset(asset, d.budget - d.committed)   -- merged, so lovelace budgets add up
                  + from_lovelace(d.structural)
                  + from_asset(own_hash, d.node_id, 1)
```

Node outputs must equal `expected_value` exactly. Transaction fees are always paid from wallet inputs, never from escrow, so reconciliation is exact to the lovelace (PRD 4.4, invariant 1).

Deadline rules, checked at FundRoot for the root and at Draw for every child:

```
submit_by <= refund_after
submit_by + min_challenge_window <= challenge_until
challenge_until < dispute_until
child.dispute_until + min_safety_margin <= parent.submit_by        -- Draw only (invariant 4, A12)
```

PRD 7.5 says Submit "sets `challenge_until` from config". Resolution: `challenge_until` is fixed at Draw time, at least `min_challenge_window` after `submit_by`, so every deadline is known and nested before any money moves. Logged in `DECISIONS.md`.

### 4.4 `BondDatum` (inline datum at `cascade_bond`)

```
BondDatum {
  authority: ScriptHash         -- cascade_node hash
  tree_id: ByteArray
  node_id: ByteArray            -- the node whose dispute can move this bond
  owner: VerificationKeyHash
  owner_address: Address        -- VerificationKey payment credential
  role: BondRole                -- Challenger = 0 | Verifier = 1 | Specialist = 2
  release_after: Int            -- ms; equals the node's dispute_until
}
```

Bonds are lovelace. A bond's value is whatever the output holds; payouts are computed from the input's lovelace.

## 5. Redeemers

- `spend` redeemer: ignored (`Data`). Logic is in `withdraw`.
- `mint` redeemer: ignored (`Data`).
- `withdraw` redeemer: `List<Action>`.
- `publish` redeemer: ignored.

Every PRD 7.5 redeemer is an `Action` constructor. Index fields refer to `self.inputs`, `self.reference_inputs` and `self.outputs` positions in ledger order (inputs sorted by output reference).

```
Action =
  FundRoot     { seed: OutputReference, root_out: Int, config_out: Int }                               -- 0
  TopUp        { node_in: Int, node_out: Int, amount: Int }                                            -- 1
  Draw         { node_in: Int, node_out: Int, config_ref: Int, root_ref: Option<Int>,
                 children: List<ChildDraw> }                                                            -- 2
  Submit       { node_in: Int, node_out: Int, result_hash: ByteArray }                                 -- 3
  Accept       { node_in: Int, node_out: Int }                                                         -- 4
  Challenge    { node_in: Int, node_out: Int, reason_hash: ByteArray, challenger: VerificationKeyHash,
                 challenger_address: Address, bond_out: Int, config_ref: Int,
                 parent_ref: Option<Int> }                                                             -- 5
  Escalate     { node_in: Int, node_out: Int }                                                         -- 6
  Resolve      { node_in: Int, parent: ParentLink, config_ref: Int, split: Split, payee_out: Int,
                 payee_lovelace: Int, bonds: List<BondRuling> }                                        -- 7
  Refund       { node_in: Int, parent: ParentLink }                                                    -- 8
  SettleChild  { node_in: Int, parent_in: Int, parent_out: Int, payee_out: Int, payee_lovelace: Int }  -- 9
  CloseReceipt { node_in: Int, parent_in: Int, parent_out: Int, channel_in: Option<Int> }              -- 10
  CloseRoot    { node_in: Int, config_in: Int, payee_out: Int, payee_lovelace: Int,
                 protocol_out: Option<Int>, refund_out: Int }                                          -- 11
  Cancel       { node_in: Int, config_in: Int, refund_out: Int }                                       -- 12
  Freeze       { node_in: Int, node_out: Int }                                                         -- 13
  Unfreeze     { node_in: Int, node_out: Int }                                                         -- 14

ChildDraw {
  out: Int                      -- the child node (native) or receipt node output
  external_out: Option<Int>     -- Masumi or channel output; None for native
  leaf: PlanLeaf
  proof: List<ProofStep>
}

ParentLink =
  ParentNode { parent_in: Int, parent_out: Int }               -- non-root: value flows into the parent
  RootExit   { config_in: Int, refund_out: Int }               -- root: value leaves to buyer_refund, tokens burn

Split      { worker: Int, parent: Int }
BondRuling { bond_in: Int, ruling: Ruling, outs: List<Int> }
Ruling     = ReturnBond | SlashBond                              -- 0, 1
```

### 5.1 Rules per action

"Signed by X" means X is in `extra_signatories`. "Before T" means the validity upper bound is finite and `<= T`. "After T" means the validity lower bound is finite and `> T` (T6, validity range normalisation).

- **FundRoot** (buyer; mints root and config token). Spends `seed`. Root output at the node address holds the root datum: `node_id = tree_id` from 2, `parent_id = None`, `depth 0`, `next_child 0`, `committed 0`, `children_open 0`, `kind Native`, `state Funded`, `frozen False`, `result_hash None`, `external_ref None`, acceptance `BuyerAccept(config.buyer)`, deadlines valid. Config output at `Script(config_hash)` holds exactly min lovelace plus the config token, with `config.tree_id == tree_id`, `config.channel_script_hash == channel_hash`, `plan_root` 32 bytes, bps values in 0..=10000, arbiter threshold valid, `buyer_refund` and `payee` key addresses. Signed by `config.buyer`. Mint delta: `+1 tree_id`, `+1 config name`.
- **TopUp** (buyer, root only, Funded). Output datum equals input datum except `budget + amount`, `amount > 0`. Signed by the buyer, which is the root's `acceptance` key (`BuyerAccept(buyer)` is forced at FundRoot), so no config read is needed.
- **Draw** (operator, Funded). Signed by `parent.operator`; before `parent.submit_by`. Tree not frozen: the root input itself when drawing at the root, else `root_ref` holds the root token `tree_id` at the node address with `frozen = False`. `config_ref` holds the config token. For each child i: `child_index = parent.next_child + i`; child datum is exact (fresh counters, `state Funded`, `depth = parent.depth + 1 <= max_depth`, kind in `allowed_leaf_kinds` and equal to `leaf.kind`, `spec_hash = leaf.spec_hash`, `leaf.parent_spec_hash = parent.spec_hash`, `budget <= leaf.max_budget`, `fee <= leaf.max_fee`, `fee <= budget`, share cap, deadlines per 4.3, acceptance keys valid, `payee` a key address, output address equal to the parent input's address); Merkle proof of `leaf` against `plan_root`. Native children mint `+1 child_name`. Receipts: see sections 8 and 9. Totals: `sum(child.budget) + parent.fee <= parent.budget - parent.committed`, `children_open + n <= max_fanout`, `n >= 1`. Parent output: same datum except `committed += sum(budget)`, `children_open += n`, `next_child += n`, `structural -= sum(child.structural + child.external_lovelace)`. No output named by Draw is at a key address (invariant 2, A10).
- **Submit** (operator, Funded). Before `submit_by`; `children_open == 0`; `result_hash` 32 bytes; output sets `result_hash = Some(h)`, `state Submitted`.
- **Accept** (Submitted). Either the acceptance rule's signatures are present (`ParentAccept`: key; `VerifierQuorum`: at least k of keys; `BuyerAccept`: key; `AutoAfterWindow`: never early), or after `challenge_until`. Output sets `state Accepted`.
- **Challenge** (parent operator or buyer; Submitted). Before `challenge_until`. `challenger` signs and is either `config.buyer` (from `config_ref`) or the parent's operator: `parent_ref` is a reference input at the node address holding the token `parent_id` whose datum `operator == challenger`. At the root only the buyer may challenge. Bond output at `Script(bond_hash)` with `BondDatum { authority own, tree_id, node_id, owner challenger, owner_address challenger_address, role Challenger, release_after dispute_until }` and at least `config.challenge_bond` lovelace. Output sets `state Challenged`; nothing else changes. One challenge per node follows from the state machine.
- **Escalate** (node operator; Challenged). Before `dispute_until`. Output sets `state Disputed`.
- **Resolve** (Challenged or Disputed). Before `dispute_until`: Challenged may be resolved by k-of-n verifier quorum signatures (only when acceptance is `VerifierQuorum`) or by the arbiter threshold; Disputed only by the arbiter threshold. After `dispute_until`: anyone, and the split must be `{ worker: 0, parent: all }`, with no bond rulings. `split.worker + split.parent == budget` (children are settled, so `committed == 0`). Payee output holds exactly `from_asset(asset, split.worker) + from_lovelace(payee_lovelace)`, skipped when both are 0. Parent side: `ParentNode` adds `split.parent` and `structural - payee_lovelace` to the parent, lowers the parent's `budget` by `split.worker`, `committed` by `budget`, `children_open` by 1; `RootExit` pays everything else to `buyer_refund` and burns root and config tokens. Burns the node token. Bond rulings: each bond input with `authority == own` and `node_id == this node`; `ReturnBond` pays its full lovelace to `owner_address` (one output); `SlashBond` pays `floor(v * slash_wronged_bps / 10000)` to the wronged side (the payee when `split.worker > 0`, else `config.buyer_refund`) and the rest to `arbiter_fee_address` (two outputs, a zero share is skipped).
- **Refund** (anyone; Native, Funded). After `refund_after`; `children_open == 0`. `ParentNode`: parent output gains the whole child value (`budget` and `structural`), parent `committed -= child.budget`, `children_open -= 1`. `RootExit`: whole root value and config input value go to `buyer_refund`, both tokens burn. Burns the child token.
- **SettleChild** (anyone; child Accepted, or Submitted and after `challenge_until`). Child `children_open == 0`. Payee output exactly `from_asset(asset, fee) + from_lovelace(payee_lovelace)`, `payee_lovelace <= child.structural`. Parent output: `budget -= fee`, `committed -= child.budget`, `children_open -= 1`, `structural += child.structural - payee_lovelace`. Burns the child token. Parent state must be Funded.
- **CloseReceipt** (receipt node). Signed by the receipt's `operator`, or after the receipt's `dispute_until`. Masumi: parent `budget -= receipt.budget`, `committed -= receipt.budget`, `children_open -= 1`, `structural += receipt.structural`. Metered: `channel_in` is claimed and its remaining deposit returns into the parent: parent `budget -= (receipt.budget - remaining)`, `committed -= receipt.budget`, `structural += receipt.structural + channel lovelace`. Burns the receipt token.
- **CloseRoot** (buyer, or anyone after root `challenge_until`; root Accepted, or Submitted after `challenge_until`). Payee output `from_asset(asset, fee) + from_lovelace(payee_lovelace)`; protocol fee `floor((budget - fee) * protocol_fee_bps / 10000)` to `protocol_fee_address` when non-zero; everything else in the root and config inputs, minus the two tokens, to `buyer_refund` in `refund_out`. Burns root and config tokens.
- **Cancel** (buyer; root Funded, `committed == 0`). Whole root and config value, minus tokens, to `buyer_refund`. Burns both tokens.
- **Freeze / Unfreeze** (buyer; root, any live state). Output equals input except `frozen`.

## 5.2 AddressPayment children (PRD 8.1 address rail, A5)

PRD 8.1 defines an address-payment rail (x402 `default`) and A5 requires paying a third-party x402 endpoint from the tree budget, while invariant 2 forbids Draw outputs to key addresses. Resolution: a Draw child with `leaf.kind = AddressPayment` may pay a key address only when all of these hold:
- the output's payment credential is `VerificationKey(leaf.payee_hash)`, bound in the buyer-approved `plan_root`;
- `leaf.payee_hash != parent.operator` (A10 still fails: the orchestrator cannot pay its own key, even through the plan);
- the output holds only the tree asset and lovelace; `amount = quantity_of(out, asset)` with `0 < amount <= leaf.max_budget`; for token assets the output's lovelace comes from the parent's `structural`;
- `external_out` is None and no token is minted.

Parent accounting: `budget -= amount`, `structural -= extra lovelace` (token assets only), `committed` and `children_open` unchanged, `next_child` unchanged. The payment is final (no refund), as PRD 8.1 states for this rail. Invariant 2 is restated as: no Draw output pays a key address except a plan-bound, non-operator `AddressPayment` payee. Logged in `DECISIONS.md`.

## 6. Verifiers (PRD 5.5, 11.1 L1, 21.1)

PRD 5.5 says a verifier is "hired as its own child node under the node it checks". A child of the checked node blocks that node's Submit (invariant 5: `children_open == 0`), while the verifier needs the submitted result. That is a deadlock. Resolution: verifiers are native children of the checked node's parent, siblings of the node they check. The checked node's acceptance is `VerifierQuorum(keys, k)` with the verifiers' operator keys. Verifier bonds are `cascade_bond` UTxOs with `node_id` = the checked node and `role Verifier`, moved by that node's `Resolve`. Logged in `DECISIONS.md`.

## 7. Deadline algebra (PRD 7.7)

Off-chain planner: `child.dispute_until + m_safety <= parent.submit_by - t_compose` and `W_masumi >= t_work + 5 + 15 + 15 minutes`. On chain only the first inequality without `t_compose` is enforced (it is a planner choice).

## 8. Masumi receipt (PRD 8.5)

Draw with `leaf.kind = MasumiReceipt`: `external_out` pays `Script(config.masumi_script_hash)` with value `from_asset(asset, child.budget) + from_lovelace(child.external_lovelace)` and a well-formed 19-field `vested_pay` V2 inline datum. The receipt node output holds `from_lovelace(structural) + token`, `budget` = the amount locked in Masumi, `fee 0`, `committed 0`, `external_ref = None` (see the amendment below). The datum mapping and field checks follow `docs/research/x402-cardano-spec.md` and `docs/research/masumi-payment-service.md`; W1 writes the exact type in `contracts/lib/cascade/masumi.ak` from those digests.

Amendment (Wave 1, found by W2): a datum cannot contain the id of the transaction that creates it, because that id is the hash of a body containing the datum. So Draw writes `external_ref = None` for every receipt. A Metered receipt's channel is identified on chain by the channel token `#"6b" ++ node_id`; a Masumi receipt's lock is identified off chain as `OutputReference(draw_tx_id, external_out)`, recorded by the SDK and the indexer. Masumi CloseReceipt never co-spends the external escrow, so no on-chain check needs the reference. The field stays in the datum for future linking.

`config.masumi_script_hash` is the parameter-applied `vested_pay` V2 hash (preprod `a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad`), never the unapplied blueprint hash. The locked lovelace equals `external_lovelace` exactly, and `collateral_return_lovelace` is 0 or at least 1,435,230.

Unmodified Masumi agents are paid through their native MIP-003 purchase flow: the orchestrator calls `/start_job`, receives the `blockchainIdentifier` and deadlines, and the Draw writes the lock exactly as Masumi's own purchase flow would, so the agent's Masumi Payment Service recognises it and can submit, withdraw, refund and dispute with unchanged tooling. The x402 `masumi` method is used only on Cascade's own sell side (A6), because an x402 `masumi` lock signs x402 terms that Masumi's payment service does not accept (docs/research/x402-cardano-spec.md).

### 8.1 Masumi leaves through a purchase wallet (amendment, Wave 4)

Measured on preprod (W6): the Masumi Payment Service (upstream `69297f30`, `src/services/transactions/tx-sync/util/index.ts`, `extractOnChainTransactionData`) classifies a new `vested_pay` lock as `Initial` only when the creating transaction has no value inputs from the contract and no redeemers; any lock created in a transaction with redeemers is classified `Invalid` and skipped. A Cascade Draw always carries redeemers, so an unmodified Masumi seller never sees a lock made by a MasumiReceipt Draw (A3 lock `79f5fcf7...` was skipped this way).

Resolution, with no contract change:
1. The Masumi hire is a Draw child of kind `AddressPayment` (section 5.2) that pays exactly the lock value (price plus collateral) to the tree's Masumi purchase wallet `P`, a dedicated key (wallet role `masumi-purchaser`), bound in the buyer-approved plan leaf as `payee_hash`. `P` is never the operator key, so A10 still holds.
2. A plain key-signed transaction from `P` (no scripts, no redeemers) creates the `vested_pay` lock with the field mapping of section 8: `buyer` = `P`'s key address, `buyer_return_address` = `Some(config.buyer_refund)`, seller fields and identifiers from the seller's `/start_job` and signed terms. Deadlines are not nested inside the parent node's window: the leaf has no tree node, the AddressPayment is final for the tree, and refunds always go to `buyer_refund` whatever the tree's state, so the tree may close before the Masumi escrow resolves. The only time requirement is that `pay_by_time` is still in the future when `P` locks; the orchestrator waits for the seller's result up to its own compose deadline and otherwise treats the leaf as failed and requests the Masumi refund after `submit_result_time`. The seller's payment service accepts it as `Initial`.
3. Refunds: `P` signs `SetRefundRequested` and `WithdrawRefund`; the refund output goes to `buyer_return_address`, i.e. `buyer_refund`, never to `P` or the operator.
4. Off-chain fence: the signer holds `P` and signs for it only (a) a lock transaction whose single non-change output is a `vested_pay` lock at the approved script hash matching a plan-approved Masumi spec and the amount just received in step 1, or (b) refund actions on such a lock. `P`'s custody window is one transaction.
4a. Return path (evaluator finding, 2026-10-01): if `P` receives a Draw payment it cannot lock (seller offline, `pay_by_time` passed, lock failure), the signer may sign one more action for `P`: return exactly the received amount to that tree's `buyer_refund` (only change from `P`'s own fee inputs may go elsewhere), allowed after the slot's work window plus margin or once the slot is marked failed. The orchestrator runs it automatically; the watchtower runs it too if the orchestrator is offline. So `P` can only lock, refund or return; it never pays any other destination.
4b. Liveness (evaluator finding): a Cascade watchtower crank requests `SetRefundRequested` and, once allowed, `WithdrawRefund` for every `P` lock that has no result after `submit_result_time`, through the signer's `P` role. Failed Masumi leaves therefore refund to the buyer without the Conductor. Trust assumption, stated in the README and threat model: the signer and watchtower are Cascade services; a compromised signer could take in-flight Masumi payments held by `P` (custody lasts from the Draw to the lock, normally one block, or until the return action), while locked funds can only go to the seller (on delivery) or `buyer_refund` (enforced by `vested_pay`).
5. The tree's receipt line for the leaf links the AddressPayment Draw, the lock transaction, the `blockchainIdentifier`, and the outcome (seller withdrawal or refund to `buyer_refund`); the indexer links them off chain by `P` and the lock datum.

The on-chain `MasumiReceipt` kind and its checks stay in the contracts and are used if Masumi's service later accepts script-created locks. This is a known interoperability gap in the Masumi Payment Service, recorded in BLOCKERS.md and the final report.

## 9. Metered receipt and voucher channel (PRD 8.6)

Subbit cannot be used as published (docs/research/subbit.md): its Aiken project is in a subfolder, needs stdlib v3.1.0, requires a key-controlled channel owner, and its close and refund paths do not constrain outputs, so a refund could leave the tree. Cascade builds its own `cascade_channel`, keeping Subbit's cumulative-voucher model, with: datum `{ authority, tree_id, node_id, payer_vkey (32 bytes), provider: VerificationKeyHash, provider_address, asset, deposit, redeemed, timeout }`; `Redeem { amount, signature, out }` by the provider before `timeout`, where `signature` is Ed25519 by `payer_vkey` over `channel_tag ++ be64(amount)` and `channel_tag = blake2b_256(tree_id ++ node_id)`, paying `amount - redeemed` to the provider and continuing with `redeemed = amount`; close through the authority. Batch redeem is several channel inputs in one tx, each paired to its own continuing output by index.

## 10. Failure evidence for negative acceptance tests (A10, A11, A12, A13, A19)

"Fails on chain" is proven by building the transaction with the real validators and submitting it to the preprod node through the submit API with evaluation. The node rejects it with a script failure. Evidence records the tx body hash, the node's error, and the same scenario's positive control that succeeds.

## Hackathon redeploy (2026-10-06)

Problem: every on-chain artefact of the TOKEN2049 Origins submission must be created inside the hackathon window. `cascade_config`, `cascade_bond` and `cascade_channel` took no parameters, so rebuilding the same sources gives the same hashes as the Oct 1 deployment; the logic scripts and `cascade_node` take only those hashes, so all seven addresses, the node policy and the logic stake credentials would equal the old ones, and trees from Oct 1 to 5 would sit at the new deployment's addresses.

Decision: each leaf validator takes one unused parameter, `_deployment_tag: ByteArray`. `contracts/scripts/build.sh` runs `aiken build --trace-level silent` and then `aiken blueprint apply` with the bytes in `contracts/deployment-tag` (`cascade/token2049/2026-10-06`) on the three leaves. The committed `plutus.json` therefore lists them with no parameters, so the deploy script, the SDK and every other loader apply parameters exactly as before. The new leaf hashes feed the hash parameters of the logic scripts and `cascade_node`, so all seven hashes change.

Not changed: validator logic, the logic scripts' and `cascade_node`'s compiled code before parameter application (byte-identical to the Oct 1 blueprint), datums, redeemers and execution units in `contracts/BUDGET.md`. Each leaf grows by 39 bytes (the applied tag). `aiken check`: 6,972 checks, 0 errors, 0 warnings.

Alternatives rejected: a seed-UTxO or config-token parameter needs new validator logic (a one-shot check) and changes the off-chain parameter order everywhere; a code edit that only perturbs bytes (a constant in an `else` handler) is optimised away or alters behaviour; wrapping UPLC off chain would make `plutus.json` disagree with the sources. A tag is the smallest reproducible change: anyone can rebuild `plutus.json` from the tagged sources and get the deployed hashes.

Next redeploy: change `contracts/deployment-tag`, run `pnpm aiken:build`, then `pnpm -C scripts exec tsx deploy-scripts.ts --network preprod --supersede-reason "<why>"`.
