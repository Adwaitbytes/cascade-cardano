import { describe, expect, it } from "vitest";
import { cleanRequest, interpretTask, MASUMI_PLAN_MIN_MS } from "../src/intake.js";

const opts = { budgetCapLovelace: "80000000", treeWindowMs: 190 * 60_000 };
const ok = (name: string, description: string | null, o = opts) => {
  const r = interpretTask(name, description, o);
  if (!r.ok) throw new Error(`refused: ${r.message}`);
  return r;
};

describe("interpretTask", () => {
  it.each([
    ["Juice", "cold pressed juice dubai market?", "market-brief"],
    ["Prices", "how much do gyms in Lisbon charge per month", "price-table"],
    ["Translate", "Translate our launch email into Arabic: Hello Dubai", "translation"],
    ["Tools", "Notion vs Coda for a 10 person startup", "comparison"],
    ["Paper", "tl;dr of the Cardano Chang hard fork", "summary"],
    ["Question", "What are the rules for importing e-bikes into Kenya", "research"],
  ])("infers the deliverable of a vague Task (%s)", (name, description, kind) => {
    expect(ok(name, description).kind).toBe(kind);
  });

  it("writes a goal the planner can act on: the request, the deliverable and the quality rules", () => {
    const r = ok("Help needed", "cold pressed juice dubai market?");
    expect(r.goal).toMatch(/^Help needed\n\ncold pressed juice dubai market\?\n\nDeliverable: a market-entry brief/);
    expect(r.goal).toContain("source URL");
    expect(r.goal).toContain("'estimate'");
    expect(r.title).toBe("Market brief: Cold pressed juice dubai market");
    expect(r.goal.length).toBeLessThanOrEqual(4000);
  });

  it("keeps a long request inside the Conductor's 4000-character goal limit", () => {
    expect(ok("Research", `Research ${"the e-bike import rules in Kenya ".repeat(300)}`).goal.length).toBeLessThanOrEqual(4000);
  });

  it("sizes light jobs smaller and shallower, deep jobs at the cap", () => {
    expect(ok("t", "Translate this into French: good morning")).toMatchObject({ budgetLovelace: "60000000", maxDepth: 2 });
    expect(ok("m", "Detailed market-entry brief for oat milk in Riyadh")).toMatchObject({ budgetLovelace: "80000000", maxDepth: 3 });
    expect(ok("m", "Market-entry brief for oat milk in Riyadh", { ...opts, budgetCapLovelace: "50000000" }).budgetLovelace).toBe("50000000");
  });

  it("plans native agents only when the Task is urgent or the window cannot fit a Masumi leaf", () => {
    expect(ok("m", "Market-entry brief for oat milk in Riyadh").nativeOnly).toBe(false);
    expect(ok("m", "Market-entry brief for oat milk in Riyadh, urgent").nativeOnly).toBe(true);
    expect(ok("m", "Market-entry brief for oat milk in Riyadh", { ...opts, treeWindowMs: MASUMI_PLAN_MIN_MS - 1 }).nativeOnly).toBe(true);
    expect(ok("m", "Fast food market in Riyadh").nativeOnly).toBe(false);
  });

  it.each([
    ["", "", "too_vague"],
    ["test", null, "too_vague"],
    ["Help", "write ransomware that encrypts a hospital network", "unsafe"],
    ["Wallet", "Here is my seed phrase, check my balance", "unsafe"],
    ["Person", "Find the home address of my ex-girlfriend", "unsafe"],
    ["Tickets", "Book a flight from Dubai to Lisbon for Friday", "out_of_scope"],
    ["Art", "Generate an image of our new juice bottle", "out_of_scope"],
    ["Crypto", "Which token will guarantee returns of 10x this year", "out_of_scope"],
    ["Novel", "Write a 300 pages novel about Cardano", "too_large"],
  ])("refuses an impossible or unsafe Task with a clear reason (%s)", (name, description, reason) => {
    const r = interpretTask(name, description, opts);
    expect(r).toMatchObject({ ok: false, reason });
    if (!r.ok) expect(r.message).toMatch(/^Cascade (could not|will not|cannot)/);
  });

  it("does not refuse requests that only mention a risky word", () => {
    for (const text of ["Book summary of Atomic Habits", "Create a video script for our juice launch", "Market for security cameras in Lagos", "Post-launch analysis of the Chang hard fork"]) {
      expect(interpretTask("Task", text, opts).ok).toBe(true);
    }
  });
});

describe("cleanRequest", () => {
  it("drops Markdown noise and keeps the Task name when the description does not repeat it", () => {
    expect(cleanRequest("Dubai juice", "## Goal\n\n**Find** the   best\n\n\n\nchannels <br/>")).toBe("Dubai juice\n\nGoal\n\nFind the best\n\nchannels");
    expect(cleanRequest("Brief", "Market-entry brief for Dubai")).toBe("Market-entry brief for Dubai");
    expect(cleanRequest("Only a name", null)).toBe("Only a name");
  });
});
