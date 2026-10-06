/**
 * Command implementations. Every side effect (terminal, files, chain, WebSocket) comes in through
 * `Deps`, so tests drive the commands with a fake fetch and an in-memory terminal.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ApiError, type CascadeApi, type CascadeNetwork, type TxPreview } from "@cascade/mcp/client";
import type { Command } from "./args.js";
import { UsageError } from "./args.js";
import { parseDeadline, resolveAsset, toBaseUnits } from "./budget.js";
import { readLocalTestToken } from "./deployments.js";
import { renderPlan, renderPreview, renderReceipt, renderTree } from "./render.js";
import { templateFiles } from "./templates.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  isTty: boolean;
  confirm(question: string): Promise<boolean>;
  /** Clears the terminal before a redraw (TTY only). */
  clear(): void;
}

/** Chain access for agent-key funding: wallet UTxOs as CIP-30 hex, and submission. */
export interface Chain {
  walletUtxos(address: string): Promise<string[]>;
  submit(signedTxCbor: string): Promise<string>;
}

export interface CrankOutcome {
  selected: number;
  ran: { kind: string; nodeId: string; txId?: string; error?: string }[];
}

export interface Deps {
  api: CascadeApi;
  network: CascadeNetwork;
  root: string;
  cwd: string;
  io: Io;
  now: () => number;
  chain: () => Promise<Chain>;
  crank: () => Promise<CrankOutcome>;
  /** Opens the indexer event stream; returns a closer. */
  subscribe: (url: string, onEvent: () => void, onClose: (reason: string) => void) => () => void;
  /** Resolves when the user stops a long-running command (Ctrl-C). */
  untilInterrupted: () => Promise<void>;
}

export class CommandError extends Error {
  override name = "CommandError";
}

const HEX28 = /^[0-9a-f]{56}$/;

function decimalsFor(deps: Deps): (asset: string) => number {
  const token = deps.network === "local" ? readLocalTestToken(deps.root) : null;
  return (asset) => (token !== null && asset === `${token.policyId}.${token.assetNameHex}` ? token.decimals : asset === "lovelace" ? 6 : 0);
}

async function initAgent(cmd: Extract<Command, { kind: "init-agent" }>, deps: Deps): Promise<void> {
  const dir = isAbsolute(cmd.dir) ? cmd.dir : resolve(deps.cwd, cmd.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new CommandError(`${dir} is not empty; choose another --dir`);
  const files = templateFiles(cmd.template, cmd.name);
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: "wx" });
  }
  deps.io.out(`Created ${cmd.template} agent "${cmd.name}" in ${dir}:`);
  for (const path of Object.keys(files)) deps.io.out(`  ${path}`);
}

async function register(cmd: Extract<Command, { kind: "register" }>, deps: Deps): Promise<void> {
  const checks = await deps.api.checkAgentEndpoints(cmd.apiUrl);
  for (const c of checks) deps.io.out(`  ${c.ok ? "ok  " : "FAIL"} GET ${c.path} ${c.status ?? "no answer"}`);
  if (checks.some((c) => !c.ok)) throw new CommandError("the agent's MIP-003 endpoints did not answer; fix them before registering");
  await deps.api.registerAgent({
    agent_asset_id: cmd.registryAsset,
    name: cmd.name,
    api_url: cmd.apiUrl,
    payment_vkh: cmd.paymentVkh,
    categories: cmd.categories,
    rails: cmd.rails,
  });
  deps.io.out(`Listed ${cmd.name} (${cmd.registryAsset}) in the Cascade Directory.`);
}

async function jobPlan(cmd: Extract<Command, { kind: "job-plan" }>, deps: Deps): Promise<void> {
  const token = deps.network === "local" ? readLocalTestToken(deps.root) : null;
  const asset = resolveAsset(cmd.asset, deps.network, token);
  const budget = toBaseUnits(cmd.budget, asset.decimals);
  const { plan_id } = await deps.api.createJob({
    goal: cmd.goal,
    asset: asset.assetId,
    budget,
    deadline: parseDeadline(cmd.deadline, deps.now()),
    max_depth: cmd.maxDepth,
    min_reputation: cmd.minRep,
    risk: cmd.risk,
    acceptance: "buyer_review",
    allow_agents: [],
    block_agents: [],
  });
  const envelope = await deps.api.getPlan(plan_id);
  if (cmd.out !== null) {
    writeFileSync(resolve(deps.cwd, cmd.out), `${JSON.stringify(envelope, null, 2)}\n`);
  }
  if (cmd.json) deps.io.out(JSON.stringify(envelope, null, 2));
  else {
    deps.io.out(renderPlan(envelope, decimalsFor(deps)));
    deps.io.out(`\nNext: cascade job fund ${cmd.out ?? plan_id}`);
  }
}

function planIdFrom(arg: string, cwd: string): string {
  const path = resolve(cwd, arg);
  if (!arg.endsWith(".json") || !existsSync(path)) return arg;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as { plan_id?: unknown; plan?: { plan_id?: unknown } };
  const id = typeof obj.plan_id === "string" ? obj.plan_id : obj.plan?.plan_id;
  if (typeof id !== "string") throw new CommandError(`${arg} has no plan_id`);
  return id;
}

function readUtxos(path: string): string[] {
  const text = readFileSync(path, "utf8").trim();
  const list: unknown = text.startsWith("[") ? JSON.parse(text) : text.split(/\s+/);
  if (!Array.isArray(list) || list.length === 0 || !list.every((u) => typeof u === "string" && /^[0-9a-f]+$/.test(u))) {
    throw new CommandError("--utxos must hold CIP-30 getUtxos() hex strings (JSON array or one per line)");
  }
  return list as string[];
}

async function previewOrNull(api: CascadeApi, txCbor: string): Promise<TxPreview | null> {
  try {
    return await api.previewTx(txCbor);
  } catch (e) {
    if (e instanceof ApiError) return null;
    throw e;
  }
}

async function jobFund(cmd: Extract<Command, { kind: "job-fund" }>, deps: Deps): Promise<void> {
  const planId = planIdFrom(cmd.plan, deps.cwd);
  const agentMode = cmd.changeAddress === null;
  if (agentMode && !deps.api.canSign) {
    throw new UsageError("pass --change-address and --utxos for your wallet, or set CASCADE_SIGNER_TOKEN and CASCADE_AGENT_ROLE to fund with an agent key");
  }
  let wallet: { change_address: string; utxos: string[] };
  if (agentMode) {
    const address = await deps.api.agentAddress();
    wallet = { change_address: address, utxos: await (await deps.chain()).walletUtxos(address) };
  } else {
    wallet = { change_address: cmd.changeAddress ?? "", utxos: readUtxos(resolve(deps.cwd, cmd.utxosFile ?? "")) };
  }

  const { tx_cbor, tree_id } = await deps.api.fundTx(planId, wallet);
  const preview = await previewOrNull(deps.api, tx_cbor);

  if (!agentMode) {
    if (cmd.json) deps.io.out(JSON.stringify({ tree_id, tx_cbor, preview }, null, 2));
    else {
      deps.io.out(preview === null ? `FundRoot for tree ${tree_id} (${tx_cbor.length / 2} bytes; indexer preview unavailable)` : renderPreview(preview));
      deps.io.out(`\nUnsigned transaction (sign and submit with your wallet):\n${tx_cbor}`);
    }
    return;
  }

  deps.io.out(preview === null ? `FundRoot for tree ${tree_id} (${tx_cbor.length / 2} bytes; indexer preview unavailable)` : renderPreview(preview));
  if (!cmd.yes) {
    if (!deps.io.isTty) throw new CommandError("refusing to sign without confirmation; rerun on a terminal or pass --yes");
    if (!(await deps.io.confirm("Sign with the agent key and submit?"))) {
      deps.io.out("Not signed.");
      return;
    }
  }
  const { signedTx } = await deps.api.sign(tx_cbor);
  const txId = await (await deps.chain()).submit(signedTx);
  if (cmd.json) deps.io.out(JSON.stringify({ tree_id, tx_id: txId, preview }, null, 2));
  else deps.io.out(`Submitted ${txId}. Watch it: cascade tree watch ${tree_id}`);
}

async function treeWatch(cmd: Extract<Command, { kind: "tree-watch" }>, deps: Deps): Promise<void> {
  const decimals = decimalsFor(deps);
  let drawing: Promise<void> = Promise.resolve();
  const draw = (note: string): void => {
    drawing = drawing.then(async () => {
      try {
        const tree = await deps.api.tree(cmd.treeId);
        deps.io.clear();
        deps.io.out(renderTree(tree, decimals, deps.now()));
        deps.io.out(`\n${note}  (Ctrl-C to stop)`);
      } catch (e) {
        deps.io.err(e instanceof Error ? e.message : String(e));
      }
    });
  };
  const wsUrl = `${deps.api.endpoints.indexerUrl.replace(/^http/, "ws")}/v1/ws?tree_id=${cmd.treeId}`;
  draw("connecting…");
  let close = (): void => undefined;
  let stopped = false;
  const connect = (): void => {
    close = deps.subscribe(
      wsUrl,
      () => draw(`updated ${new Date(deps.now()).toISOString()}`),
      (reason) => {
        if (stopped) return;
        deps.io.err(`event stream closed (${reason}); reconnecting in 3 s`);
        setTimeout(() => {
          if (!stopped) connect();
        }, 3000);
      },
    );
  };
  connect();
  await deps.untilInterrupted();
  stopped = true;
  close();
  await drawing;
}

async function crank(deps: Deps): Promise<void> {
  const outcome = await deps.crank();
  if (outcome.selected === 0) {
    deps.io.out("No cranks due.");
    return;
  }
  deps.io.out(`${outcome.selected} crank(s) due, ${outcome.ran.length} attempted:`);
  for (const r of outcome.ran) {
    deps.io.out(`  ${r.kind.padEnd(12)} node ${r.nodeId.slice(0, 8)}… ${r.txId !== undefined ? `tx ${r.txId}` : `failed: ${r.error ?? "unknown"}`}`);
  }
  if (outcome.ran.some((r) => r.txId === undefined)) throw new CommandError("some cranks failed");
}

async function receipt(cmd: Extract<Command, { kind: "receipt" }>, deps: Deps): Promise<void> {
  if (!HEX28.test(cmd.treeId)) throw new UsageError("tree_id must be 28 bytes of hex");
  const r = await deps.api.receipt(cmd.treeId);
  deps.io.out(cmd.json ? JSON.stringify(r, null, 2) : renderReceipt(r, decimalsFor(deps)));
}

export async function run(cmd: Command, deps: Deps, usage: string): Promise<void> {
  switch (cmd.kind) {
    case "help":
      deps.io.out(usage);
      return;
    case "init-agent":
      return initAgent(cmd, deps);
    case "register":
      return register(cmd, deps);
    case "job-plan":
      return jobPlan(cmd, deps);
    case "job-fund":
      return jobFund(cmd, deps);
    case "tree-watch":
      return treeWatch(cmd, deps);
    case "crank":
      return crank(deps);
    case "receipt":
      return receipt(cmd, deps);
  }
}
