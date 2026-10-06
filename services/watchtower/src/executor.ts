/**
 * Crank executor on the @cascade/sdk transaction builders. For tree cranks the watchtower wallet
 * only pays fees; they are permissionless, so no other key signs (ADR 5.1). Builders evaluate
 * through the provider before returning, so a crank that would fail on chain fails here instead.
 *
 * Purchase-wallet cranks (ADR 0001 8.1) are P's own transactions: P pays the fee and the signer's
 * masumi-purchaser fence signs them, which only allows the refund or return to buyer_refund.
 */
import { CascadeClient, returnUnlockedToBuyer, withdrawMasumiRefundViaPurchaser, type BuiltTx, type Purchaser } from "@cascade/sdk";
import type { FeeWallet } from "./fee-wallet.js";
import type { Crank, CrankExecutor, CrankKind, CrankResult } from "./selection.js";

const SUPPORTED: ReadonlySet<CrankKind> = new Set(["SettleChild", "Accept", "CloseRoot", "Resolve", "Refund"]);
const PURCHASER_KINDS: ReadonlySet<CrankKind> = new Set(["MasumiRefund", "MasumiReturn"]);

/** The SDK's CloseReceipt builder, once W2 ships it; detected at runtime so the watchtower needs no change. */
interface CloseReceiptBuilder {
  closeReceipt(nodeId: string, by: "deadline"): Promise<BuiltTx>;
}
const hasCloseReceipt = (c: object): c is CloseReceiptBuilder => typeof (c as Partial<CloseReceiptBuilder>).closeReceipt === "function";

export class SdkCrankExecutor implements CrankExecutor {
  constructor(
    private readonly client: CascadeClient,
    private readonly purchaser: Purchaser | null = null,
    private readonly wallet: Pick<FeeWallet, "prepare" | "record"> | null = null,
  ) {}

  /** Tree cranks wait while the fee wallet has no UTxO that is not already spent by its own transactions. */
  async ready(kind: CrankKind): Promise<boolean> {
    if (PURCHASER_KINDS.has(kind) || this.wallet === null) return true;
    return this.wallet.prepare();
  }

  supports(kind: CrankKind): boolean {
    if (PURCHASER_KINDS.has(kind)) return this.purchaser !== null;
    return SUPPORTED.has(kind) || (kind === "CloseReceipt" && hasCloseReceipt(this.client));
  }

  /** P's refund or return: the SDK driver builds, has the signer sign as P, submits and checks the destination. */
  private async purchaserCrank(c: Crank, purchaser: Purchaser): Promise<CrankResult> {
    const m = c.masumi;
    if (c.kind === "MasumiRefund" && m !== undefined && "escrowAddress" in m) {
      return { txId: await withdrawMasumiRefundViaPurchaser(this.client, { purchaser, escrowAddress: m.escrowAddress, referenceSignature: m.referenceSignature }) };
    }
    if (c.kind === "MasumiReturn" && m !== undefined && "drawTx" in m) {
      return { txId: (await returnUnlockedToBuyer(this.client, { drawTx: m.drawTx, treeId: c.treeId, purchaser })).txHash };
    }
    throw new Error(`crank ${c.kind} lacks its Masumi reference`);
  }

  private build(c: Crank): Promise<BuiltTx> {
    switch (c.kind) {
      case "SettleChild":
        return this.client.settleChild(c.nodeId);
      case "Accept":
        return this.client.accept(c.nodeId);
      case "CloseRoot":
        return this.client.closeRoot(c.treeId, { byBuyer: false });
      case "Resolve":
        return this.client.resolve({ nodeId: c.nodeId, mode: "deadline" });
      case "Refund":
        return this.client.refund(c.nodeId);
      case "CloseReceipt":
        if (!hasCloseReceipt(this.client)) throw new Error("the SDK has no closeReceipt builder yet");
        // Selection offers it only after the receipt's dispute_until, when the close needs no
        // operator signature; the default ("operator") would demand the receipt operator's key.
        return this.client.closeReceipt(c.nodeId, "deadline");
      case "MasumiRefund":
      case "MasumiReturn":
        throw new Error(`${c.kind} is P's transaction, not a tree crank`);
    }
  }

  async execute(c: Crank): Promise<CrankResult> {
    if (PURCHASER_KINDS.has(c.kind)) {
      if (this.purchaser === null) throw new Error("no purchase wallet signer is configured");
      return this.purchaserCrank(c, this.purchaser);
    }
    const built = await this.build(c);
    if (built.signers.length > 0) throw new Error(`crank ${c.kind} unexpectedly needs signatures from ${built.signers.join(", ")}`);
    const signed = await built.tx.sign.withWallet().complete();
    const txId = await signed.submit();
    this.wallet?.record(txId, signed.toCBOR());
    return { txId };
  }
}
