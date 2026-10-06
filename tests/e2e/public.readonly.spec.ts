/**
 * Read-only flows against the deployed web app. Write flows (signing) run only on the local stack.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { repoPath } from "../lib/repo.js";

function origin(): string {
  const d = JSON.parse(readFileSync(repoPath("deployments", "preprod.json"), "utf8")) as { urls?: { origin?: unknown } };
  if (typeof d.urls?.origin !== "string") throw new Error("not yet implemented: deployments/preprod.json urls.origin (W6 web deploy)");
  return d.urls.origin;
}

for (const [name, path, landmark] of [
  ["buyer console", "/console", /new job|plan/i],
  ["provider portal", "/provider", /provider|agent/i],
  ["arbiter console", "/arbiter", /arbiter|dispute/i],
  ["ops", "/ops", /ops|status/i],
] as const) {
  test(`${name} loads on the public deployment without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const res = await page.goto(origin() + path);
    expect(res?.status(), `${path} final status`).toBe(200);
    await expect(page.locator("main")).toContainText(landmark);
    expect(errors, "browser errors").toEqual([]);
  });
}
