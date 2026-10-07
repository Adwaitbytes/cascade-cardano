import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS_TREE_ID, COWORKER, CONTRACT_ACTIONS } from "./proof";

const repo = resolve(__dirname, "../../../../..");
const readme = readFileSync(resolve(repo, "README.md"), "utf8");
const coworkerDoc = readFileSync(resolve(repo, "docs/sokosumi-coworker.md"), "utf8");
const TX = /^[0-9a-f]{64}$/;

describe("landing proof", () => {
  it("lists the 17 contract actions, each a distinct preprod tx recorded in the README", () => {
    expect(CONTRACT_ACTIONS).toHaveLength(17);
    expect(new Set(CONTRACT_ACTIONS.map((a) => a.tx)).size).toBe(17);
    for (const a of CONTRACT_ACTIONS) {
      expect(a.tx).toMatch(TX);
      expect(readme).toContain(`https://preprod.cardanoscan.io/transaction/${a.tx}`);
    }
    expect(ACTIONS_TREE_ID).toMatch(/^[0-9a-f]{56}$/);
  });

  it("takes every Coworker id and paid Task tx from docs/sokosumi-coworker.md", () => {
    expect(coworkerDoc).toContain(COWORKER.id);
    expect(coworkerDoc).toContain(COWORKER.registrationTx);
    expect(coworkerDoc).toContain(COWORKER.command);
    for (const t of COWORKER.tasks) {
      expect(coworkerDoc).toContain(t.task);
      for (const tx of [t.lock, t.resultHash, t.collection, t.treeFunding]) {
        expect(tx).toMatch(TX);
        expect(coworkerDoc).toContain(tx);
      }
    }
  });
});
