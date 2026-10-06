/**
 * The agent's Submit path: the signer client already waited out `input_not_indexed` for its whole
 * budget, so the fresh-wallet loop must not multiply that wait; it still retries other failures.
 */
import { describe, expect, it } from "vitest";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { INPUT_NOT_INDEXED, InputsStillListedError, SignerDeniedError } from "@cascade/orchestrator";
import { withFreshWallet, type ChainSubmitterOptions } from "../src/chain.js";

let walletReads = 0;
const lucid = { selectWallet: { fromAddress: () => undefined }, utxosAt: async () => (walletReads++, []) } as unknown as LucidEvolution;
const o = { lucid, agentAddress: "addr_test1agent" } as unknown as ChainSubmitterOptions;

describe("withFreshWallet", () => {
  it("does not retry a signer refusal that already exhausted the input_not_indexed budget", async () => {
    let calls = 0;
    const err = await withFreshWallet(o, async () => {
      calls++;
      throw new SignerDeniedError("ab", [], [INPUT_NOT_INDEXED], INPUT_NOT_INDEXED);
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerDeniedError);
    expect(calls).toBe(1);
  });

  it("returns the step's value", async () => {
    expect(await withFreshWallet(o, async () => "tx-id")).toBe("tx-id");
  });

  it("re-reads the wallet and rebuilds after a stale listing names an input already spent", async () => {
    walletReads = 0;
    let calls = 0;
    const txId = await withFreshWallet(o, async () => {
      if (++calls === 1) throw new Error('EvaluateTransaction fails: Unknown transaction input (missing from UTxO set): d60440cb#2');
      return "submit-tx";
    }, 4, 1);
    expect(txId).toBe("submit-tx");
    expect(calls).toBe(2);
    expect(walletReads).toBe(2);
  });

  it("does not rebuild a confirmed transaction whose inputs the provider still lists", async () => {
    let calls = 0;
    const err = await withFreshWallet(o, async () => {
      calls++;
      throw new InputsStillListedError("close-tx", ["d60440cb#2"], 90_000);
    }, 4, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputsStillListedError);
    expect(calls).toBe(1);
  });
});
