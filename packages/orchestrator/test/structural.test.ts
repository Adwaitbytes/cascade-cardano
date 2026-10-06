import { describe, expect, it } from "vitest";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { CascadeClient, type ReferenceScripts } from "@cascade/sdk";
import { buildPlan, DEFAULT_POLICY, type JobIntake } from "../src/build-plan.js";
import { cascadeScripts } from "../src/chain/deployment.js";
import { sdkStructuralSizer, subtreeReserve } from "../src/chain/structural.js";
import { demoDraft } from "../src/draft.js";
import { scenarioDraft } from "../src/test-scenarios.js";

/** Only what min-UTxO sizing reads: the network and preprod's live coinsPerUtxoByte. */
const lucid = { config: () => ({ network: "Preprod", protocolParameters: { coinsPerUtxoByte: 4_310n } }) } as unknown as LucidEvolution;
const client = new CascadeClient(lucid, cascadeScripts(), {} as ReferenceScripts);
const LOVELACE = { policy: "", name: "" };
const agents = () => ({ primary: { agent_id: `${"67".repeat(28)}01`, quote_id: null, price: "0" }, fallbacks: [] });
const intake = (over: Partial<JobIntake> = {}): JobIntake => ({ goal: "Market entry brief for cold-pressed juice in Dubai", asset: "lovelace", budget: "150000000", fund_by: 1_790_000_000_000, submit_by: 1_790_000_000_000 + 6 * 3_600_000, max_depth: 3, reputation_floor: 0, risk: "balanced", ...over });
const keyOf = (t: { id: string }) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28);

describe("exact structural reserve from the SDK's min-UTxO sizing (PRD 7.8)", () => {
  it("sizes a metered subtree so the receipt and its drained channel fit, and the plan totals use it", () => {
    const res = buildPlan(scenarioDraft("a7-metered", { lookupApi: "ab".repeat(28) }), intake({ budget: "20000000", max_depth: 2 }), agents, DEFAULT_POLICY, keyOf, { structural: sdkStructuralSizer(client) });
    if (!res.ok) throw new Error(res.errors.join("; "));
    const { plan } = res.built;
    const pricer = plan.root.children[0]!;
    const lookup = pricer.children[0]!;
    const pricerReserve = subtreeReserve(client, LOVELACE, pricer, 1);
    const pricerOnly = subtreeReserve(client, LOVELACE, { ...pricer, children: [] }, 1);
    const meteredTake = pricerReserve - pricerOnly;
    // The Metered child takes its own node reserve plus the channel lovelace: well over a bare min-UTxO.
    expect(lookup.spec.rail).toBe("metered");
    expect(meteredTake).toBeGreaterThan(2_000_000n);
    // Pricer keeps its own min-UTxO after drawing the receipt (the Draw's shortfall check).
    expect(pricerReserve - meteredTake).toBe(pricerOnly);
    // The root holds itself plus Pricer's whole subtree, and that is what the buyer funds.
    const rootOnly = subtreeReserve(client, LOVELACE, { ...plan.root, children: [] }, 0);
    expect(BigInt(plan.totals.structural_lovelace)).toBe(rootOnly + pricerReserve);
  });

  it("covers the PRD 21.2 demo tree (Pricer's channel under Scout) and charges nothing for address payments", () => {
    const res = buildPlan(demoDraft(), intake(), agents, DEFAULT_POLICY, keyOf, { masumiPurchaserHash: "9f".repeat(28), structural: sdkStructuralSizer(client) });
    if (!res.ok) throw new Error(res.errors.join("; "));
    const { plan } = res.built;
    const scout = plan.root.children.find((c) => c.spec.id === "scout")!;
    const pricer = scout.children[0]!;
    expect(subtreeReserve(client, LOVELACE, scout, 1)).toBe(subtreeReserve(client, LOVELACE, { ...scout, children: [] }, 1) + subtreeReserve(client, LOVELACE, pricer, 2));
    const masumi = plan.root.children.find((c) => c.spec.masumi_followup !== undefined)!;
    const withoutMasumi = { ...plan.root, children: plan.root.children.filter((c) => c !== masumi) };
    expect(subtreeReserve(client, LOVELACE, plan.root, 0)).toBe(subtreeReserve(client, LOVELACE, withoutMasumi, 0));
    expect(BigInt(plan.totals.structural_lovelace)).toBe(subtreeReserve(client, LOVELACE, plan.root, 0));
  });
});
