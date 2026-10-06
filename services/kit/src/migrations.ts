/**
 * Postgres schema. The first eleven tables are exactly PRD 17.1 (`trees`, `nodes`, `node_events`,
 * `agents`, `quotes`, `plans`, `verdicts`, `gate_logs`, `x402_claims`, `reputation`, `artefacts`)
 * with their key columns; extra columns needed for exact reconciliation and rollback are listed after
 * a `-- indexer` marker. `chain_points`, `node_utxos` and `reputation_snapshots` are auxiliary: the
 * follower's intersection points, the per-UTxO history that makes rollbacks exact, and published
 * reputation snapshots.
 *
 * Every row that describes chain state carries the tx id and slot that produced it (PRD 17), so the
 * database can be rebuilt from chain.
 *
 * Migrations are append-only. Never edit a released entry; add a new one.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "prd_17_1_core_tables",
    sql: `
CREATE TABLE trees (
  tree_id        text PRIMARY KEY CHECK (tree_id ~ '^[0-9a-f]{56}$'),
  buyer_vkh      text NOT NULL CHECK (buyer_vkh ~ '^[0-9a-f]{56}$'),
  asset          text NOT NULL,
  root_budget    numeric(39,0) NOT NULL CHECK (root_budget >= 0),
  plan_root      text NOT NULL CHECK (plan_root ~ '^[0-9a-f]{64}$'),
  config_utxo    text NOT NULL,
  state          text NOT NULL CHECK (state IN ('open', 'closed', 'cancelled')),
  frozen         boolean NOT NULL DEFAULT false,
  created_slot   bigint NOT NULL,
  closed_slot    bigint,
  -- indexer
  config         jsonb NOT NULL,
  created_tx     text NOT NULL,
  closed_tx      text,
  updated_slot   bigint NOT NULL
);

CREATE TABLE nodes (
  node_id          text PRIMARY KEY CHECK (node_id ~ '^[0-9a-f]{56}$'),
  tree_id          text NOT NULL REFERENCES trees (tree_id) ON DELETE CASCADE,
  parent_id        text,
  depth            integer NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('Native', 'MasumiReceipt', 'MeteredReceipt')),
  operator_vkh     text NOT NULL,
  payee            text NOT NULL,
  agent_asset_id   text,
  budget           numeric(39,0) NOT NULL,
  fee              numeric(39,0) NOT NULL,
  committed        numeric(39,0) NOT NULL,
  children_open    integer NOT NULL,
  spec_hash        text NOT NULL,
  input_hash       text NOT NULL,
  result_hash      text,
  acceptance       jsonb NOT NULL,
  submit_by        bigint NOT NULL,
  challenge_until  bigint NOT NULL,
  refund_after     bigint NOT NULL,
  dispute_until    bigint NOT NULL,
  state            text NOT NULL CHECK (state IN ('Funded', 'Submitted', 'Challenged', 'Disputed', 'Accepted', 'Refunded', 'Settled')),
  current_utxo     text,
  external_ref     text,
  -- indexer
  next_child       integer NOT NULL,
  structural       numeric(39,0) NOT NULL,
  external_lovelace numeric(39,0) NOT NULL,
  frozen           boolean NOT NULL DEFAULT false,
  created_tx       text NOT NULL,
  created_slot     bigint NOT NULL,
  last_tx          text NOT NULL,
  updated_slot     bigint NOT NULL
);
CREATE INDEX nodes_tree_idx ON nodes (tree_id);
CREATE INDEX nodes_state_idx ON nodes (state) WHERE current_utxo IS NOT NULL;
CREATE INDEX nodes_operator_idx ON nodes (operator_vkh);

CREATE TABLE node_events (
  event_id      bigserial PRIMARY KEY,
  node_id       text NOT NULL,
  type          text NOT NULL,
  tx_id         text NOT NULL,
  slot          bigint NOT NULL,
  block_hash    text NOT NULL,
  value_delta   jsonb NOT NULL,
  payload       jsonb NOT NULL,
  rolled_back   boolean NOT NULL DEFAULT false,
  -- indexer
  tree_id       text NOT NULL,
  block_height  bigint NOT NULL,
  emitted_at    bigint NOT NULL
);
CREATE INDEX node_events_tree_idx ON node_events (tree_id, event_id);
CREATE INDEX node_events_slot_idx ON node_events (slot) WHERE NOT rolled_back;
CREATE INDEX node_events_node_idx ON node_events (node_id, event_id);

CREATE TABLE agents (
  agent_asset_id  text PRIMARY KEY,
  name            text NOT NULL,
  api_url         text NOT NULL,
  payment_vkh     text NOT NULL,
  categories      text[] NOT NULL DEFAULT '{}',
  rails           text[] NOT NULL DEFAULT '{}',
  capabilities    jsonb NOT NULL DEFAULT '{}'::jsonb,
  availability    text NOT NULL DEFAULT 'unknown' CHECK (availability IN ('available', 'unavailable', 'unknown')),
  last_seen       bigint NOT NULL DEFAULT 0,
  -- indexer
  allowlisted     boolean NOT NULL DEFAULT false
);

CREATE TABLE quotes (
  quote_id        text PRIMARY KEY,
  agent_asset_id  text NOT NULL,
  spec_hash       text NOT NULL,
  price           numeric(39,0) NOT NULL,
  asset           text NOT NULL,
  eta_ms          bigint NOT NULL,
  expires_at      bigint NOT NULL,
  signature       text NOT NULL,
  status          text NOT NULL,
  -- indexer
  quote           jsonb NOT NULL,
  received_at     bigint NOT NULL
);
CREATE INDEX quotes_spec_idx ON quotes (spec_hash);

CREATE TABLE plans (
  plan_id          text PRIMARY KEY,
  tree_id          text,
  plan_root        text NOT NULL,
  json             jsonb NOT NULL,
  buyer_signature  text,
  version          integer NOT NULL DEFAULT 1
);
CREATE INDEX plans_tree_idx ON plans (tree_id);
CREATE INDEX plans_root_idx ON plans (plan_root);

CREATE TABLE verdicts (
  verdict_id         text PRIMARY KEY,
  node_id            text NOT NULL,
  verifier_asset_id  text NOT NULL,
  verdict            text NOT NULL CHECK (verdict IN ('accept', 'reject')),
  score              double precision NOT NULL,
  evidence_hash      text NOT NULL,
  signature          text NOT NULL
);
CREATE INDEX verdicts_node_idx ON verdicts (node_id);

CREATE TABLE gate_logs (
  log_id        bigserial PRIMARY KEY,
  node_id       text,
  tx_body_hash  text NOT NULL,
  gates         jsonb NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('allow', 'deny')),
  signature     text NOT NULL,
  -- signer
  tree_id       text,
  role          text NOT NULL,
  key           text NOT NULL,
  policy_hash   text NOT NULL,
  body          jsonb NOT NULL,
  created_at    bigint NOT NULL
);
CREATE INDEX gate_logs_node_idx ON gate_logs (node_id);
CREATE INDEX gate_logs_tree_idx ON gate_logs (tree_id, created_at);

CREATE TABLE x402_claims (
  terms_digest  text UNIQUE,
  tx_id         text PRIMARY KEY,
  status        text NOT NULL CHECK (status IN ('in-flight', 'submitted', 'rejected', 'confirmed')),
  requirements  jsonb NOT NULL,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  -- facilitator
  owner_token   text NOT NULL,
  network       text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reputation (
  agent_asset_id     text NOT NULL,
  category           text NOT NULL,
  delivery_rate      double precision NOT NULL,
  on_time_rate       double precision NOT NULL,
  dispute_loss_rate  double precision NOT NULL,
  verifier_accuracy  double precision,
  volume             numeric(39,0) NOT NULL,
  buyer_diversity    integer NOT NULL,
  score              double precision NOT NULL,
  confidence         double precision NOT NULL,
  snapshot_root      text,
  -- indexer
  nodes_counted      integer NOT NULL,
  computed_at        bigint NOT NULL,
  PRIMARY KEY (agent_asset_id, category)
);

CREATE TABLE artefacts (
  sha256       text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime         text NOT NULL,
  size         bigint NOT NULL CHECK (size >= 0),
  storage_uri  text NOT NULL,
  encryption   jsonb
);

CREATE TABLE chain_points (
  slot          bigint PRIMARY KEY,
  block_hash    text NOT NULL,
  block_height  bigint NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE node_utxos (
  out_ref      text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('node', 'config')),
  node_id      text NOT NULL,
  tree_id      text NOT NULL,
  tx_id        text NOT NULL,
  slot         bigint NOT NULL,
  seq          bigint NOT NULL,
  datum        jsonb NOT NULL,
  datum_cbor   text NOT NULL,
  lovelace     numeric(39,0) NOT NULL,
  assets       jsonb NOT NULL,
  spent_tx     text,
  spent_slot   bigint,
  terminal_state text CHECK (terminal_state IN ('Refunded', 'Settled'))
);
CREATE INDEX node_utxos_node_idx ON node_utxos (node_id, slot, seq);
CREATE INDEX node_utxos_unspent_idx ON node_utxos (out_ref) WHERE spent_tx IS NULL;
CREATE INDEX node_utxos_slot_idx ON node_utxos (slot);
CREATE INDEX node_utxos_spent_slot_idx ON node_utxos (spent_slot);

CREATE TABLE service_state (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

CREATE TABLE reputation_snapshots (
  snapshot_root  text PRIMARY KEY,
  tx_id          text,
  slot           bigint,
  body           jsonb NOT NULL,
  key            text NOT NULL,
  signature      text NOT NULL,
  created_at     bigint NOT NULL
);
`,
  },
  {
    id: 2,
    name: "plans_buyer_policy",
    sql: `
-- The buyer's signer policy (packages/policy BuyerPolicySchema), approved with the plan (PRD 13.2).
ALTER TABLE plans ADD COLUMN policy jsonb;
CREATE INDEX gate_logs_role_idx ON gate_logs (role, created_at);
`,
  },
  {
    id: 3,
    name: "watchtower_cranks",
    sql: `
-- Watchtower attempts, keyed by the UTxO a crank spends, so a crank runs once per node state.
CREATE TABLE watchtower_cranks (
  utxo_ref    text PRIMARY KEY,
  kind        text NOT NULL,
  node_id     text NOT NULL,
  tree_id     text NOT NULL,
  status      text NOT NULL CHECK (status IN ('building', 'submitted', 'failed', 'unsupported')),
  tx_id       text,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  updated_at  bigint NOT NULL
);
`,
  },
  {
    id: 4,
    name: "ops_and_provider_views",
    sql: `
-- Execution units observed on chain per Cascade transaction (ops view, PRD 18.4).
CREATE TABLE redeemer_budgets (
  tx_id    text PRIMARY KEY,
  action   text NOT NULL,
  memory   bigint NOT NULL,
  steps    bigint NOT NULL,
  slot     bigint NOT NULL
);
CREATE INDEX redeemer_budgets_slot_idx ON redeemer_budgets (slot);

-- Quote requests fanned out to each agent (provider inbox).
CREATE TABLE quote_requests (
  id              bigserial PRIMARY KEY,
  agent_asset_id  text NOT NULL,
  spec_hash       text NOT NULL,
  request         jsonb NOT NULL,
  received_at     bigint NOT NULL
);
CREATE INDEX quote_requests_agent_idx ON quote_requests (agent_asset_id, received_at);
`,
  },
  {
    id: 5,
    name: "bond_utxos",
    sql: `
-- Governed bonds (datum authority = cascade_node hash, ADR 1.3) are tracked like nodes.
ALTER TABLE node_utxos DROP CONSTRAINT node_utxos_kind_check;
ALTER TABLE node_utxos ADD CONSTRAINT node_utxos_kind_check CHECK (kind IN ('node', 'config', 'bond'));
ALTER TABLE node_utxos ADD COLUMN owner text;
CREATE INDEX node_utxos_bond_owner_idx ON node_utxos (owner) WHERE kind = 'bond' AND spent_tx IS NULL;
`,
  },
  {
    id: 6,
    name: "channel_utxos",
    sql: `
-- Governed metered channels (token 6b ++ receipt node id, ADR 1.4) are tracked like nodes; each
-- row records the redeemed total after the transaction that created it.
ALTER TABLE node_utxos DROP CONSTRAINT node_utxos_kind_check;
ALTER TABLE node_utxos ADD CONSTRAINT node_utxos_kind_check CHECK (kind IN ('node', 'config', 'bond', 'channel'));
`,
  },
  {
    id: 7,
    name: "nodes_spent",
    sql: `
-- ADR 0001 section 1.5: value that left the tree from this node; held = budget - committed - spent.
ALTER TABLE nodes ADD COLUMN spent numeric(39,0) NOT NULL DEFAULT 0;
`,
  },
  {
    id: 8,
    name: "dispute_alerts",
    sql: `
-- Watchtower alerts for Disputed nodes nearing dispute_until (a lapse pays the worker its fee).
CREATE TABLE dispute_alerts (
  utxo_ref       text PRIMARY KEY,
  node_id        text NOT NULL,
  tree_id        text NOT NULL,
  dispute_until  bigint NOT NULL,
  ms_left        bigint NOT NULL,
  raised_at      bigint NOT NULL
);
CREATE INDEX dispute_alerts_node_idx ON dispute_alerts (node_id);
`,
  },
  {
    id: 9,
    name: "x402_claims_payer",
    sql: `
-- The payer and confirmation depth are stored at first settlement, so a retry after the nonce is
-- spent answers from the claim instead of re-resolving inputs (PRD 8.4).
ALTER TABLE x402_claims ADD COLUMN payer text;
ALTER TABLE x402_claims ADD COLUMN confirmations integer;
`,
  },
  {
    id: 10,
    name: "masumi_identifier",
    sql: `
-- Masumi blockchainIdentifier rebuilt from the vested_pay lock datum and escrow address (A3).
ALTER TABLE nodes ADD COLUMN masumi_identifier text;
`,
  },
  {
    id: 11,
    name: "masumi_leaves",
    sql: `
-- ADR 0001 8.1: a Masumi leaf is an AddressPayment to the purchase wallet P ('payment'), P's
-- vested_pay lock made from it and its continuations ('masumi_lock'), all keyed by leaf_ref (the
-- payment out ref). terminal_state on the last lock records the outcome: Refunded to
-- buyer_return_address, or Settled (seller withdrawal). Rollback reuses node_utxos history.
ALTER TABLE node_utxos DROP CONSTRAINT node_utxos_kind_check;
ALTER TABLE node_utxos ADD CONSTRAINT node_utxos_kind_check CHECK (kind IN ('node', 'config', 'bond', 'channel', 'payment', 'masumi_lock'));
ALTER TABLE node_utxos ADD COLUMN leaf_ref text;
ALTER TABLE node_utxos ADD COLUMN address text;
ALTER TABLE node_utxos ADD COLUMN blockchain_identifier text;
CREATE INDEX node_utxos_leaf_idx ON node_utxos (leaf_ref) WHERE leaf_ref IS NOT NULL;
`,
  },
  {
    id: 12,
    name: "masumi_slot_failures",
    sql: `
-- ADR 0001 8.1 exit: a Masumi slot marked failed lets P return the AddressPayment it received (and
-- never locked) to buyer_refund at once instead of after the work window. The mark can only send
-- funds back to the buyer sooner, never anywhere else.
CREATE TABLE masumi_slot_failures (
  payment_out_ref  text PRIMARY KEY CHECK (payment_out_ref ~ '^[0-9a-f]{64}#[0-9]+$'),
  reason           text NOT NULL,
  marked_at        bigint NOT NULL
);
`,
  },
  {
    id: 13,
    name: "tree_funded_payload",
    sql: `
-- Every tree.funded carries the strict PRD 17.3 payload {plan_root, config_utxo}; top-ups were
-- stored with {top_up: true}. Ledger flows (_flows) are kept.
UPDATE node_events e
   SET payload = (e.payload - 'top_up') || jsonb_build_object('plan_root', t.plan_root, 'config_utxo', t.config_utxo)
  FROM trees t
 WHERE e.tree_id = t.tree_id AND e.type = 'tree.funded' AND NOT (e.payload ? 'plan_root');
`,
  },
  {
    id: 14,
    name: "read_indexes",
    sql: `
-- Indexes for the public read routes (tree list by buyer and recency, per-tree UTxO history, agent
-- names by payment key) and for the projector's and signer's lookups by transaction id.
CREATE INDEX IF NOT EXISTS trees_buyer_created_idx ON trees (buyer_vkh, created_slot DESC);
CREATE INDEX IF NOT EXISTS trees_created_idx ON trees (created_slot DESC);
CREATE INDEX IF NOT EXISTS node_utxos_tree_idx ON node_utxos (tree_id, kind);
CREATE INDEX IF NOT EXISTS node_utxos_tx_idx ON node_utxos (tx_id);
CREATE INDEX IF NOT EXISTS node_utxos_spent_tx_idx ON node_utxos (spent_tx) WHERE spent_tx IS NOT NULL;
CREATE INDEX IF NOT EXISTS agents_payment_vkh_idx ON agents (payment_vkh);
CREATE INDEX IF NOT EXISTS node_events_tx_idx ON node_events (tx_id);
CREATE INDEX IF NOT EXISTS node_events_tree_type_idx ON node_events (tree_id, type) WHERE NOT rolled_back;
`,
  },
  {
    id: 15,
    name: "snapshot_inputs",
    sql: `
-- PRD 12.4: every reputation snapshot publishes what it was computed from (specs, agent map,
-- verdicts, parameters, node outcomes), so anyone can recompute the root from chain history.
ALTER TABLE reputation_snapshots ADD COLUMN inputs jsonb;
-- The transaction that registered an agent's registry asset (from the deployments registry file).
ALTER TABLE agents ADD COLUMN registry_tx text;
`,
  },
  {
    id: 16,
    name: "plan_specs",
    sql: `
-- Per-plan spec summaries (spec_hash, task, category), so the public tree list aggregates by
-- category in SQL instead of shipping and hashing whole plans on every read.
CREATE TABLE plan_specs (
  plan_root  text NOT NULL,
  spec_hash  text NOT NULL,
  task       text NOT NULL,
  category   text NOT NULL,
  is_root    boolean NOT NULL,
  PRIMARY KEY (plan_root, spec_hash)
);
`,
  },
  {
    id: 17,
    name: "receipt_close_structural",
    sql: `
-- A receipt close books as structural outflow only what left the tree: the receipt's reserve plus
-- its external lovelace, less what the parent's reserve regained in that close. Metered closes
-- return the channel's min-ADA to the parent, so they were double counted. Rewrites stored events
-- from the recorded UTxO history; other flows are kept.
WITH c AS (
  SELECT e.event_id, e.node_id, e.payload,
         (r.datum->>'structural')::numeric + (r.datum->>'external_lovelace')::numeric
           - ((pa.datum->>'structural')::numeric - (pb.datum->>'structural')::numeric) AS left_amt,
         coalesce((SELECT f->>'to' FROM jsonb_array_elements(e.payload->'_flows') f WHERE f->>'kind' = 'structural_out' LIMIT 1), 'escrow:') AS dest
    FROM node_events e
    JOIN node_utxos r ON r.node_id = e.node_id AND r.kind = 'node' AND r.spent_tx = e.tx_id
    JOIN node_utxos pb ON pb.node_id = r.datum->>'parent_id' AND pb.kind = 'node' AND pb.spent_tx = e.tx_id
    JOIN node_utxos pa ON pa.node_id = r.datum->>'parent_id' AND pa.kind = 'node' AND pa.tx_id = e.tx_id
   WHERE e.type = 'receipt.closed' AND jsonb_typeof(e.payload->'_flows') = 'array'
)
UPDATE node_events e
   SET payload = jsonb_set(c.payload, '{_flows}',
         coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(c.payload->'_flows') f WHERE f->>'kind' <> 'structural_out'), '[]'::jsonb)
         || CASE WHEN c.left_amt > 0
                 THEN jsonb_build_array(jsonb_build_object('kind', 'structural_out', 'node_id', c.node_id, 'to', c.dest, 'asset', 'lovelace', 'amount', c.left_amt::text))
                 ELSE '[]'::jsonb END)
  FROM c
 WHERE e.event_id = c.event_id;
`,
  },
  {
    id: 18,
    name: "offchain_results_and_challenge_reasons",
    sql: `
-- The x402 PAYMENT-RESPONSE a third-party endpoint returned for a Draw that paid it (A5), as the
-- orchestrator reported it. Keyed by the Draw, so it is shown only while that Draw is on chain.
CREATE TABLE x402_results (
  draw_tx           text NOT NULL CHECK (draw_tx ~ '^[0-9a-f]{64}$'),
  node_id           text NOT NULL CHECK (node_id ~ '^[0-9a-f]{56}$'),
  tree_id           text NOT NULL CHECK (tree_id ~ '^[0-9a-f]{56}$'),
  payment_response  jsonb NOT NULL,
  recorded_at       bigint NOT NULL,
  PRIMARY KEY (draw_tx, node_id)
);
CREATE INDEX x402_results_tree_idx ON x402_results (tree_id);
-- The off-chain reason document behind a Challenge's reason_hash (A8). Stored only when its JCS
-- SHA-256 is that hash; it is matched to the on-chain challenge by (node_id, reason_hash).
CREATE TABLE challenge_reasons (
  node_id       text NOT NULL CHECK (node_id ~ '^[0-9a-f]{56}$'),
  reason_hash   text NOT NULL CHECK (reason_hash ~ '^[0-9a-f]{64}$'),
  tree_id       text NOT NULL CHECK (tree_id ~ '^[0-9a-f]{56}$'),
  challenge_tx  text NOT NULL CHECK (challenge_tx ~ '^[0-9a-f]{64}$'),
  reason        jsonb NOT NULL,
  recorded_at   bigint NOT NULL,
  PRIMARY KEY (node_id, reason_hash)
);
-- One live L0 verdict event per challenge reason, whether the projector or the admin call wrote it first.
CREATE UNIQUE INDEX node_events_verified_once ON node_events (node_id, (payload->>'evidence_hash'))
  WHERE type = 'node.verified' AND NOT rolled_back;
`,
  },
];
