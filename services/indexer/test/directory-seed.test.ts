/**
 * Directory seeding from W6's registry file: an entry's own `paymentVkh` wins (a Masumi seller is
 * paid at its payment-service selling wallet), the same-named wallet role is only a fallback, and a
 * fallback never overwrites a key already stored. Rows the file no longer lists leave the allowlist,
 * and availability checks get through an ngrok-style browser interstitial.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { delistUnregistered, refreshAvailability, seedsFromDeployment, upsertAgent } from "../src/directory.js";

const LISAN_ID = `${"67".repeat(28)}aa`;
const LISAN_B_ID = `${"67".repeat(28)}bb`;
const SCOUT_ID = `${"67".repeat(28)}cc`;
const SELLING = "12dabe85656d609706d3a3d3d3e0c7fc95ab0b42d16afae5fc5be6b8";
const LISAN_B = "7959810edb73aa1659a96f6b31a2b7fc266b87601c5fcc38716de873";
const ROLE_LISAN = "6a".repeat(28);
const ROLE_SCOUT = "a2".repeat(28);

const registry = {
  registrations: [
    { agent: "lisan", name: "Lisan", agentIdentifier: LISAN_ID, apiBaseUrl: "https://lisan.example", paymentVkh: SELLING },
    { agent: "lisan-b", name: "Lisan-B", agentIdentifier: LISAN_B_ID, apiBaseUrl: "https://lisan-b.example", paymentVkh: LISAN_B },
    { agent: "scout", name: "Scout", agentIdentifier: SCOUT_ID, apiBaseUrl: "https://scout.example" },
  ],
};
const wallets = [
  { role: "lisan", paymentKeyHash: ROLE_LISAN },
  { role: "scout", paymentKeyHash: ROLE_SCOUT },
];

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("directory seeding from the registry file", () => {
  it("uses each entry's paymentVkh, falling back to the same-named wallet role", () => {
    const seeds = seedsFromDeployment(registry, wallets, null);
    expect(seeds.map((s) => [s.seed.name, s.seed.payment_vkh, s.fallbackVkh])).toEqual([
      ["Lisan", SELLING, false],
      ["Lisan-B", LISAN_B, false],
      ["Scout", ROLE_SCOUT, true],
    ]);
  });

  it("replaces a wrongly stored key with an explicit one but never with a fallback", async () => {
    await upsertAgent(db.pool, { agent_asset_id: LISAN_ID, name: "Lisan", api_url: "https://lisan.example", payment_vkh: ROLE_LISAN, categories: [], rails: [] });
    await upsertAgent(db.pool, { agent_asset_id: SCOUT_ID, name: "Scout", api_url: "https://scout.example", payment_vkh: "5c".repeat(28), categories: [], rails: [] });
    for (const s of seedsFromDeployment(registry, wallets, null)) await upsertAgent(db.pool, s.seed, { keepPaymentVkh: s.fallbackVkh });
    const { rows } = await db.pool.query<{ agent_asset_id: string; payment_vkh: string }>("SELECT agent_asset_id, payment_vkh FROM agents ORDER BY agent_asset_id");
    expect(Object.fromEntries(rows.map((r) => [r.agent_asset_id, r.payment_vkh]))).toEqual({
      [LISAN_ID]: SELLING,
      [LISAN_B_ID]: LISAN_B,
      [SCOUT_ID]: "5c".repeat(28),
    });
  });
});

describe("directory upkeep", () => {
  it("delists rows whose asset id the registry file no longer lists", async () => {
    const stale = `${"67".repeat(28)}dd`;
    await upsertAgent(db.pool, { agent_asset_id: stale, name: "Lisan (old)", api_url: "https://old.example", payment_vkh: ROLE_LISAN, categories: [], rails: [] });
    expect(await delistUnregistered(db.pool, seedsFromDeployment(registry, wallets, null).map((s) => s.seed.agent_asset_id))).toBe(1);
    const { rows } = await db.pool.query<{ agent_asset_id: string }>("SELECT agent_asset_id FROM agents WHERE allowlisted ORDER BY agent_asset_id");
    expect(rows.map((r) => r.agent_asset_id)).toEqual([LISAN_ID, LISAN_B_ID, SCOUT_ID]);
  });

  it("sends the ngrok skip header and a non-browser User-Agent, so the interstitial does not mask the agent", async () => {
    const seen: IncomingHttpHeaders[] = [];
    // Behaves like the ngrok free domain: an HTML warning page unless the request opts out of it.
    const server: Server = createServer((req, res) => {
      seen.push(req.headers);
      if (req.headers["ngrok-skip-browser-warning"] === undefined || /Mozilla/.test(req.headers["user-agent"] ?? "")) {
        res.writeHead(200, { "content-type": "text/html" }).end("<html>You are about to visit...</html>");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(req.url === "/availability" ? JSON.stringify({ status: "available" }) : JSON.stringify({ rails: ["masumi"] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await db.pool.query("UPDATE agents SET api_url = $2 WHERE agent_asset_id = $1", [LISAN_ID, url]);
      await db.pool.query("UPDATE agents SET allowlisted = false WHERE agent_asset_id <> $1", [LISAN_ID]);
      await refreshAvailability(db.pool, pino({ level: "silent" }), 2_000);
      const { rows } = await db.pool.query<{ availability: string; rails: string[] }>("SELECT availability, rails FROM agents WHERE agent_asset_id = $1", [LISAN_ID]);
      expect(rows[0]).toEqual({ availability: "available", rails: ["masumi"] });
      expect(seen.length).toBeGreaterThanOrEqual(2);
      for (const h of seen) expect([h["ngrok-skip-browser-warning"], h["user-agent"]]).toEqual(["1", "cascade-indexer/0.1"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
