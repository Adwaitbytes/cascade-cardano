import { plutusAddressFromBech32, type Plan } from "@cascade/shared/browser";
import type { Deployment, TxPreview } from "@/lib/api/schemas";
import { formatAmount } from "@/lib/assets";
import { planTotals } from "./summary";

/**
 * The config output holds the immutable Tree Config and its token at min-UTxO. Its exact size
 * depends on the encoded config datum, which the plan does not carry, so it is bounded, not
 * matched exactly. 5 ADA is several times the largest config datum's min-UTxO.
 */
export const CONFIG_MAX_LOVELACE = 5_000_000n;

type Holdings = Map<string, bigint>;

export interface FundOutputs {
  /** Value sent to `cascade_node` addresses (the root), by asset id. */
  root: Holdings;
  /** Value sent to `cascade_config` addresses, by asset id. */
  config: Holdings;
  /** Script addresses that are neither, which a FundRoot must never pay. */
  otherScripts: string[];
}

function scriptHashOf(address: string): string | null {
  try {
    const credential = plutusAddressFromBech32(address).payment_credential;
    return credential.type === "Script" ? credential.hash : null;
  } catch {
    return null;
  }
}

/** Which deployed Cascade script an address pays, by its payment credential. */
export function addressRole(address: string, scripts: Deployment["scripts"]): "root" | "config" | "other-script" | null {
  const hash = scriptHashOf(address);
  if (hash === null) return null;
  return hash === scripts.node ? "root" : hash === scripts.config ? "config" : "other-script";
}

/** Groups the decoded moves by the script they pay, using each address's payment credential. */
export function fundOutputs(preview: TxPreview, scripts: Deployment["scripts"]): FundOutputs {
  const root: Holdings = new Map();
  const config: Holdings = new Map();
  const otherScripts = new Set<string>();
  for (const move of preview.moves) {
    const role = addressRole(move.to, scripts);
    if (role === "other-script") otherScripts.add(move.to);
    const target = role === "root" ? root : role === "config" ? config : null;
    if (target === null) continue;
    target.set(move.value.asset, (target.get(move.value.asset) ?? 0n) + BigInt(move.value.amount));
  }
  return { root, config, otherScripts: [...otherScripts] };
}

/** Config token: `63 ++ tree_id`, 29 bytes, under the node policy (ADR 0001 2). Thread tokens are 28 bytes. */
export const isConfigToken = (asset: string, nodePolicy: string): boolean => new RegExp(`^${nodePolicy}\\.63[0-9a-f]{56}$`).test(asset);
export const isThreadToken = (asset: string, nodePolicy: string): boolean => new RegExp(`^${nodePolicy}\\.[0-9a-f]{56}$`).test(asset);

const tokensUnder = (holdings: Holdings, policy: string): [string, bigint][] =>
  [...holdings.entries()].filter(([asset]) => asset.startsWith(`${policy}.`));

/**
 * Compares the indexer's decoding of the unsigned funding transaction with the plan the buyer
 * reviewed. Any problem blocks signing: the wallet would otherwise lock something the buyer did
 * not approve. Outputs are identified by the payment credential of their address against the
 * deployed `cascade_node` and `cascade_config` hashes.
 */
export function checkFundPreview(plan: Plan, preview: TxPreview, deployment: Deployment): string[] {
  const problems: string[] = [];
  const totals = planTotals(plan);
  const { scripts } = deployment;

  if (!preview.actions.some((a) => a.type === "FundRoot")) problems.push("The transaction does not fund a Cascade root.");
  const other = preview.actions.filter((a) => a.type !== "FundRoot");
  if (other.length > 0) problems.push(`The transaction also runs ${other.map((a) => a.type).join(", ")}.`);

  const outputs = fundOutputs(preview, scripts);
  if (outputs.otherScripts.length > 0) problems.push("The transaction pays a script that is not part of this Cascade deployment.");

  if (outputs.root.size === 0) {
    problems.push("The transaction creates no Cascade root output.");
  } else {
    const lovelace = outputs.root.get("lovelace") ?? 0n;
    if (plan.asset === "lovelace") {
      const expected = totals.budget + totals.structuralLovelace;
      if (lovelace !== expected) problems.push(`The root output holds ${formatAmount(lovelace, "lovelace")}; the plan says ${formatAmount(expected, "lovelace")} (budget plus structural reserve).`);
    } else {
      const budget = outputs.root.get(plan.asset) ?? 0n;
      if (budget !== totals.budget) problems.push(`The root output holds ${formatAmount(budget, plan.asset)}; the plan says ${formatAmount(totals.budget, plan.asset)}.`);
      if (lovelace !== totals.structuralLovelace) problems.push(`The root output holds ${formatAmount(lovelace, "lovelace")} structural reserve; the plan says ${formatAmount(totals.structuralLovelace, "lovelace")}.`);
    }
    const threads = tokensUnder(outputs.root, scripts.node).filter(([asset]) => isThreadToken(asset, scripts.node));
    if (threads.length !== 1 || threads[0]?.[1] !== 1n) problems.push("The root output must carry exactly one Cascade thread token.");
    const unexpected = [...outputs.root.keys()].filter((a) => a !== "lovelace" && a !== plan.asset && !a.startsWith(`${scripts.node}.`));
    if (unexpected.length > 0) problems.push("The root output carries tokens the plan does not name.");
  }

  if (outputs.config.size === 0) {
    problems.push("The transaction creates no tree config output.");
  } else {
    const lovelace = outputs.config.get("lovelace") ?? 0n;
    if (lovelace <= 0n || lovelace > CONFIG_MAX_LOVELACE) problems.push(`The config output holds ${formatAmount(lovelace, "lovelace")}; a config needs only its min-UTxO, at most ${formatAmount(CONFIG_MAX_LOVELACE, "lovelace")}.`);
    const tokens = [...outputs.config.entries()].filter(([a]) => a !== "lovelace");
    const configToken = tokens.length === 1 && tokens[0] !== undefined && isConfigToken(tokens[0][0], scripts.node) && tokens[0][1] === 1n;
    if (!configToken) problems.push("The config output must carry exactly one config token and nothing else.");
  }
  return problems;
}

/** Lovelace the config output holds, shown to the buyer next to the plain-language preview. */
export const configLovelace = (preview: TxPreview, deployment: Deployment): bigint => fundOutputs(preview, deployment.scripts).config.get("lovelace") ?? 0n;
