import { describe, expect, it } from "vitest";
import { FIXTURE_PLAN } from "@/lib/fixtures/plan";
import { FIXTURE_DEPLOYMENT } from "@/lib/fixtures/source";
import { TUSDM_ASSET_ID } from "@/lib/assets";
import { TxPreviewSchema, type TxPreview } from "@/lib/api/schemas";
import adaPreviewJson from "./fixtures/fund-preview-ada.json";
import { CONFIG_MAX_LOVELACE, checkFundPreview, configLovelace, isConfigToken, isThreadToken } from "./fund-check";

// Indexer preview of a FundRoot on preprod: root at the cascade_node script address (with a
// stake part), config at the cascade_config address, change to the buyer.
const adaPreview: TxPreview = TxPreviewSchema.parse(adaPreviewJson);
const adaPlan = { ...FIXTURE_PLAN, asset: "lovelace", totals: { ...FIXTURE_PLAN.totals, budget: "150000000", structural_lovelace: "21000000" } };
const ROOT_ADDR = adaPreview.moves[0]?.to ?? "";
const CONFIG_ADDR = adaPreview.moves[2]?.to ?? "";

const withMoves = (moves: TxPreview["moves"]): TxPreview => ({ ...adaPreview, moves });
const replaceAmount = (preview: TxPreview, index: number, amount: string): TxPreview =>
  withMoves(preview.moves.map((m, i) => (i === index ? { ...m, value: { ...m.value, amount } } : m)));

describe("checkFundPreview, ADA tree", () => {
  it("accepts budget plus structural on the cascade_node output and a min-UTxO config", () => {
    expect(checkFundPreview(adaPlan, adaPreview, FIXTURE_DEPLOYMENT)).toEqual([]);
    expect(configLovelace(adaPreview, FIXTURE_DEPLOYMENT)).toBe(2_133_150n);
  });

  it("matches outputs by payment credential, not by any text in the address", () => {
    expect(ROOT_ADDR).toMatch(/^addr_test1xp043wsr6d/);
    expect(ROOT_ADDR.toLowerCase()).not.toContain("cascade");
  });

  it("blocks a root that differs by one lovelace", () => {
    const problems = checkFundPreview(adaPlan, replaceAmount(adaPreview, 0, "170999999"), FIXTURE_DEPLOYMENT);
    expect(problems).toEqual(["The root output holds 170.999999 ADA; the plan says 171.00 ADA (budget plus structural reserve)."]);
  });

  it("blocks an oversized config output and a missing config token", () => {
    expect(checkFundPreview(adaPlan, replaceAmount(adaPreview, 2, (CONFIG_MAX_LOVELACE + 1n).toString()), FIXTURE_DEPLOYMENT)[0]).toMatch(/config output holds 5.000001 ADA/);
    expect(checkFundPreview(adaPlan, withMoves(adaPreview.moves.filter((_, i) => i !== 3)), FIXTURE_DEPLOYMENT)).toContain("The config output must carry exactly one config token and nothing else.");
  });

  it("blocks a transaction against another deployment's scripts", () => {
    const other = { ...FIXTURE_DEPLOYMENT, scripts: { node: "bf52236b6b12b0582e0412e3324d03b3042573da11a163d8eb85800e", config: FIXTURE_DEPLOYMENT.scripts.config } };
    const problems = checkFundPreview(adaPlan, adaPreview, other);
    expect(problems).toContain("The transaction creates no Cascade root output.");
    expect(problems).toContain("The transaction pays a script that is not part of this Cascade deployment.");
  });

  it("blocks extra actions", () => {
    const preview = { ...adaPreview, actions: [...adaPreview.actions, { type: "Draw" as const, text: "" }] };
    expect(checkFundPreview(adaPlan, preview, FIXTURE_DEPLOYMENT)).toContain("The transaction also runs Draw.");
  });
});

describe("checkFundPreview, token tree", () => {
  const tokenPreview = withMoves([
    { to: ROOT_ADDR, value: { asset: "lovelace", amount: "14000000" } },
    { to: ROOT_ADDR, value: { asset: TUSDM_ASSET_ID, amount: "150000000" } },
    ...adaPreview.moves.slice(1),
  ]);

  it("checks the token budget and the structural lovelace separately", () => {
    expect(checkFundPreview(FIXTURE_PLAN, tokenPreview, FIXTURE_DEPLOYMENT)).toEqual([]);
    const short = withMoves(tokenPreview.moves.map((m, i) => (i === 0 ? { ...m, value: { ...m.value, amount: "13999999" } } : m)));
    expect(checkFundPreview(FIXTURE_PLAN, short, FIXTURE_DEPLOYMENT)).toEqual(["The root output holds 13.999999 ADA structural reserve; the plan says 14.00 ADA."]);
  });

  it("ignores the buyer's change and the config address when sizing the root", () => {
    expect(CONFIG_ADDR).toMatch(/^addr_test1w/);
    const moreChange = withMoves([...tokenPreview.moves, { to: adaPreview.moves[4]?.to ?? "", value: { asset: TUSDM_ASSET_ID, amount: "5" } }]);
    expect(checkFundPreview(FIXTURE_PLAN, moreChange, FIXTURE_DEPLOYMENT)).toEqual([]);
  });
});

describe("token identification", () => {
  const node = FIXTURE_DEPLOYMENT.scripts.node;
  it("tells the 29-byte config token from a 28-byte thread token that starts with 63", () => {
    const thread = `${node}.63${"ab".repeat(27)}`;
    const config = `${node}.63${"ab".repeat(28)}`;
    expect(isThreadToken(thread, node)).toBe(true);
    expect(isConfigToken(thread, node)).toBe(false);
    expect(isConfigToken(config, node)).toBe(true);
    expect(isThreadToken(config, node)).toBe(false);
  });
});
