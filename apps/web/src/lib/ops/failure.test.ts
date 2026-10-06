import { describe, expect, it } from "vitest";
import { explainFailure } from "./failure";

const LEDGER =
  'Error: {"contents":{"contents":{"contents":{"era":"ShelleyBasedEraConway","error":["ConwayUtxowFailure (UtxoFailure (InsufficientCollateral (DeltaCoin (-123022141)) (Coin 799110)))","ConwayUtxowFailure (UtxoFailure NoCollateralInputs)","ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (NonEmptySet (fromList [TxIn (TxId {unTxId = SafeHash \\"d224\\"})]))))"]}}}}';

describe("explainFailure", () => {
  it("explains a node that was already settled", () => {
    const r = explainFailure("node 7ecc5bcc51158d4739de9c0db1fb2636709707aee87600c05ce45270 not found");
    expect(r.cause).toMatch(/already settled or refunded/);
    expect(r.detail).toContain("7ecc5bcc");
  });

  it("puts spent inputs ahead of the collateral errors they cause", () => {
    const r = explainFailure(LEDGER);
    expect(r.cause).toMatch(/input was spent/);
    expect(r.cause).not.toMatch(/ShelleyBasedEraConway/);
    expect(r.detail).toBe(LEDGER);
  });

  it("explains collateral failures on their own", () => {
    expect(explainFailure("ConwayUtxowFailure (UtxoFailure NoCollateralInputs)").cause).toMatch(/collateral/);
  });

  it("never prints a raw JavaScript exception as the cause", () => {
    const r = explainFailure("Cannot read properties of undefined (reading 'address')");
    expect(r.cause).toBe("The watchtower hit an internal error while building the transaction.");
    expect(r.cause).not.toMatch(/undefined/);
    expect(r.detail).toContain("reading 'address'");
  });

  it("explains a missing signer", () => {
    expect(explainFailure("crank CloseReceipt unexpectedly needs signatures from d895").cause).toMatch(/signature the watchtower does not hold/);
  });

  it("keeps a short readable unknown error as a sentence without a disclosure", () => {
    expect(explainFailure("plan was withdrawn")).toEqual({ cause: "Plan was withdrawn.", detail: null });
  });

  it("hides unreadable unknown errors behind the disclosure", () => {
    const r = explainFailure('{"code":42,"payload":[1,2,3]}');
    expect(r.cause).toBe("The transaction was rejected. The raw error is below.");
    expect(r.detail).toBe('{"code":42,"payload":[1,2,3]}');
  });

  it("handles an empty error", () => expect(explainFailure("  ")).toEqual({ cause: "No reason was recorded.", detail: null }));
});
