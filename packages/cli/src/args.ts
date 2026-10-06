/**
 * Argument parsing for `cascade`. Each command parses into one variant of `Command`, so the
 * dispatcher and the tests work on typed values instead of raw argv.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";
import { RISK_LEVELS } from "@cascade/mcp/client";

export const TEMPLATES = ["ts", "crewai"] as const;
export type Template = (typeof TEMPLATES)[number];

export const RAILS = ["native", "masumi", "metered", "address"] as const;
export type Rail = (typeof RAILS)[number];

export type Risk = (typeof RISK_LEVELS)[number];

export type Command =
  | { kind: "help"; topic?: string }
  | { kind: "init-agent"; template: Template; dir: string; name: string }
  | { kind: "register"; registryAsset: string; apiUrl: string; name: string; paymentVkh: string; categories: string[]; rails: Rail[] }
  | {
      kind: "job-plan";
      goal: string;
      budget: string;
      asset: string;
      deadline: string;
      maxDepth: number;
      risk: Risk;
      minRep: number;
      json: boolean;
      out: string | null;
    }
  | { kind: "job-fund"; plan: string; changeAddress: string | null; utxosFile: string | null; yes: boolean; json: boolean }
  | { kind: "tree-watch"; treeId: string }
  | { kind: "crank"; all: true }
  | { kind: "receipt"; treeId: string; json: boolean };

export class UsageError extends Error {
  override name = "UsageError";
}

export const USAGE = `cascade <command>

  init agent --template crewai|ts [--dir <path>] [--name <name>]
  register --registry-asset <id> --api-url <url> --name <name> --payment-vkh <hex> [--category <c>]... [--rail <r>]...
  job plan "<goal>" --budget <amount> --asset ada|lovelace|usdm|<policy>.<name> [--deadline 2h] [--max-depth 3]
           [--risk balanced] [--min-rep 50] [--json] [--out plan.json]
  job fund <plan.json|plan_id> [--change-address <addr> --utxos <file>] [--yes] [--json]
  tree watch <tree_id>
  crank --all
  receipt <tree_id> [--json]

Environment: CASCADE_NETWORK (local | preprod), CASCADE_CONSOLE_URL, CASCADE_INDEXER_URL,
CASCADE_SIGNER_URL + CASCADE_SIGNER_TOKEN + CASCADE_AGENT_ROLE (agent-key signing),
CASCADE_INDEXER_ADMIN_TOKEN (register), CASCADE_TREASURY_MNEMONIC (crank).`;

const HEX28 = /^[0-9a-f]{56}$/;

function parse(args: string[], options: ParseArgsConfig["options"]) {
  try {
    return parseArgs({ args, options: options ?? {}, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function required(v: unknown, flag: string): string {
  const s = str(v);
  if (s === undefined || s === "") throw new UsageError(`${flag} is required`);
  return s;
}

function int(v: unknown, flag: string, fallback: number, min: number, max: number): number {
  const s = str(v);
  if (s === undefined) return fallback;
  if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) throw new UsageError(`${flag} must be an integer from ${min} to ${max}`);
  return Number(s);
}

function oneOf<T extends string>(v: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new UsageError(`${flag} must be one of ${allowed.join(", ")}`);
}

function treeId(v: string | undefined): string {
  if (v === undefined || !HEX28.test(v)) throw new UsageError("tree_id must be 28 bytes of lowercase hex");
  return v;
}

export function parseCommand(argv: readonly string[]): Command {
  const [first, second, ...rest] = argv;
  if (first === undefined || first === "help" || first === "--help" || first === "-h") return { kind: "help" };

  switch (first) {
    case "init": {
      if (second !== "agent") throw new UsageError("usage: cascade init agent --template crewai|ts");
      const { values } = parse(rest, { template: { type: "string" }, dir: { type: "string" }, name: { type: "string" } });
      const template = oneOf(required(values.template, "--template"), TEMPLATES, "--template");
      const name = str(values.name) ?? "my-cascade-agent";
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new UsageError("--name must be lowercase letters, digits and dashes");
      return { kind: "init-agent", template, name, dir: str(values.dir) ?? name };
    }
    case "register": {
      const { values } = parse([second, ...rest].filter((x): x is string => x !== undefined), {
        "registry-asset": { type: "string" },
        "api-url": { type: "string" },
        name: { type: "string" },
        "payment-vkh": { type: "string" },
        category: { type: "string", multiple: true },
        rail: { type: "string", multiple: true },
      });
      const registryAsset = required(values["registry-asset"], "--registry-asset");
      if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(registryAsset)) throw new UsageError("--registry-asset must be a registry asset id (hex)");
      const paymentVkh = required(values["payment-vkh"], "--payment-vkh");
      if (!HEX28.test(paymentVkh)) throw new UsageError("--payment-vkh must be 28 bytes of hex");
      const rails = strs(values.rail).map((r) => oneOf(r, RAILS, "--rail"));
      return {
        kind: "register",
        registryAsset,
        apiUrl: required(values["api-url"], "--api-url"),
        name: required(values.name, "--name"),
        paymentVkh,
        categories: strs(values.category),
        rails: rails.length === 0 ? ["native"] : rails,
      };
    }
    case "job": {
      if (second === "plan") {
        const { values, positionals } = parse(rest, {
          budget: { type: "string" },
          asset: { type: "string" },
          deadline: { type: "string" },
          "max-depth": { type: "string" },
          risk: { type: "string" },
          "min-rep": { type: "string" },
          json: { type: "boolean" },
          out: { type: "string" },
        });
        const goal = positionals.join(" ").trim();
        if (goal.length < 10) throw new UsageError("the goal must be at least 10 characters");
        return {
          kind: "job-plan",
          goal,
          budget: required(values.budget, "--budget"),
          asset: required(values.asset, "--asset"),
          deadline: str(values.deadline) ?? "2h",
          maxDepth: int(values["max-depth"], "--max-depth", 3, 1, 6),
          risk: oneOf(str(values.risk) ?? "balanced", RISK_LEVELS, "--risk"),
          minRep: int(values["min-rep"], "--min-rep", 50, 0, 100),
          json: values.json === true,
          out: str(values.out) ?? null,
        };
      }
      if (second === "fund") {
        const { values, positionals } = parse(rest, {
          "change-address": { type: "string" },
          utxos: { type: "string" },
          yes: { type: "boolean", short: "y" },
          json: { type: "boolean" },
        });
        const plan = positionals[0];
        if (plan === undefined || positionals.length > 1) throw new UsageError("usage: cascade job fund <plan.json|plan_id>");
        const changeAddress = str(values["change-address"]) ?? null;
        const utxosFile = str(values.utxos) ?? null;
        if ((changeAddress === null) !== (utxosFile === null)) throw new UsageError("pass --change-address and --utxos together");
        return { kind: "job-fund", plan, changeAddress, utxosFile, yes: values.yes === true, json: values.json === true };
      }
      throw new UsageError("usage: cascade job plan|fund ...");
    }
    case "tree": {
      if (second !== "watch") throw new UsageError("usage: cascade tree watch <tree_id>");
      const { positionals } = parse(rest, {});
      return { kind: "tree-watch", treeId: treeId(positionals[0]) };
    }
    case "crank": {
      const { values } = parse([second, ...rest].filter((x): x is string => x !== undefined), { all: { type: "boolean" } });
      if (values.all !== true) throw new UsageError("usage: cascade crank --all");
      return { kind: "crank", all: true };
    }
    case "receipt": {
      const { values, positionals } = parse([second, ...rest].filter((x): x is string => x !== undefined), { json: { type: "boolean" } });
      return { kind: "receipt", treeId: treeId(positionals[0]), json: values.json === true };
    }
    default:
      throw new UsageError(`unknown command "${first}"`);
  }
}
