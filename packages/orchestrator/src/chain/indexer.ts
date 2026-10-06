/** Indexer (W3) HTTP helpers the orchestrator needs: plan, payment-response and challenge-reason registration, and "has this tx been applied". */
import type { BuyerPolicy } from "@cascade/policy";
import type { Plan } from "@cascade/shared";
import type { ChallengeReasonRecord, PaymentResponseRecord } from "../activities.js";
import { IndexerRefused } from "./indexer-error.js";

export { IndexerRefused };

export interface IndexerClientOptions {
  baseUrl: string;
  /** Bearer token for `/v1/admin/*`. */
  adminToken: string | null;
  fetch?: typeof fetch;
}

export class IndexerClient {
  private readonly fetch: typeof fetch;
  constructor(private readonly o: IndexerClientOptions) {
    this.fetch = o.fetch ?? fetch;
  }

  private url(path: string): string {
    return `${this.o.baseUrl.replace(/\/$/, "")}${path}`;
  }

  /**
   * Records a buyer-approved plan so the signer's gates can read it (`POST /v1/admin/plans`), with
   * the buyer's policy when known; without one the signer applies its default policy.
   */
  async registerPlan(plan: Plan, treeId: string | null, policy?: BuyerPolicy): Promise<void> {
    const res = await this.fetch(this.url("/v1/admin/plans"), {
      method: "POST",
      headers: this.adminHeaders(),
      body: JSON.stringify({ plan, tree_id: treeId, ...(policy === undefined ? {} : { policy }) }),
    });
    if (!res.ok) throw new Error(`indexer refused the plan: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  /** Records an x402 purchase's PAYMENT-RESPONSE next to the Draw that paid it (`POST /v1/admin/results`, A5). */
  recordPaymentResponse = async (record: PaymentResponseRecord): Promise<void> => {
    const res = await this.fetch(this.url("/v1/admin/results"), {
      method: "POST",
      headers: this.adminHeaders(),
      body: JSON.stringify(record),
    });
    if (!res.ok) throw new IndexerRefused(res.status, "payment response", await res.text());
  };

  /**
   * Records the reason document behind a Challenge's on-chain reason_hash (`POST /v1/admin/challenges`,
   * A8). The indexer checks the hash; 202 means the Challenge tx is not indexed yet and the reason is held.
   */
  recordChallengeReason = async (record: ChallengeReasonRecord): Promise<void> => {
    const res = await this.fetch(this.url("/v1/admin/challenges"), {
      method: "POST",
      headers: this.adminHeaders(),
      body: JSON.stringify(record),
    });
    if (!res.ok) throw new IndexerRefused(res.status, "challenge reason", await res.text());
  };

  private adminHeaders(): Record<string, string> {
    return { "content-type": "application/json", ...(this.o.adminToken === null ? {} : { authorization: `Bearer ${this.o.adminToken}` }) };
  }

  /** True once the indexer knows the tree (its FundRoot was applied). */
  async hasTree(treeId: string): Promise<boolean> {
    const res = await this.fetch(this.url(`/v1/trees/${treeId}`));
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`indexer tree answered ${res.status}`);
    return true;
  }

  /** True once the tree's event stream names `txId`. */
  async hasApplied(treeId: string, txId: string): Promise<boolean> {
    let since: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query: string = since === null ? "?limit=1000" : `?limit=1000&since=${encodeURIComponent(since)}`;
      const res = await this.fetch(this.url(`/v1/trees/${treeId}/events${query}`));
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`indexer events answered ${res.status}`);
      const body = (await res.json()) as { events: { tx_id: string }[]; next: string | null };
      if (body.events.some((e) => e.tx_id === txId)) return true;
      if (body.next === null) return false;
      since = body.next;
    }
    return false;
  }

  /** `waitIndexed` hook for `SdkChainActions`. */
  waitIndexed = async (txId: string, treeId: string): Promise<void> => {
    for (let i = 0; i < 240; i++) {
      if (await this.hasApplied(treeId, txId)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`indexer did not apply ${txId} within 120 s`);
  };
}
