import type { CascadeEvent } from "@cascade/shared/browser";
import type {
  AgentProfile,
  AgentSummary,
  CreateJobRequest,
  Deployment,
  Dispute,
  FundTxRequest,
  FundTxResponse,
  NodeDetail,
  OpsStatus,
  PlanEnvelope,
  ProviderWork,
  Receipt,
  Tree,
  TreeActionRequest,
  TreeListItem,
  TxPreview,
} from "./schemas";
import type { ParsedEvents } from "./events";
import type { LandingData } from "@/lib/landing/data";

export type LiveStatus = "connecting" | "live" | "polling" | "offline" | "sample";

export interface EventSubscription {
  close(): void;
}

export interface SubscriptionHandlers {
  onEvent: (event: CascadeEvent) => void;
  onStatus: (status: LiveStatus) => void;
  /** A frame failed validation; the stream stays open and the caller may refetch. */
  onError: (message: string) => void;
}

/** Everything the UI reads or asks of the backend. One HTTP implementation, one dev-only fixture. */
export interface DataSource {
  readonly kind: "http" | "fixture";
  /** Script hashes of the current deployment, always from this site. */
  getDeployment(): Promise<Deployment>;
  getTree(treeId: string): Promise<Tree>;
  getTreeEvents(treeId: string): Promise<ParsedEvents>;
  getReceipt(treeId: string): Promise<Receipt>;
  getNodeDetail(treeId: string, nodeId: string): Promise<NodeDetail>;
  getAgent(assetId: string): Promise<AgentProfile>;
  searchAgents(query: { category?: string; min_rep?: number; rail?: string }): Promise<AgentSummary[]>;
  previewTx(txCbor: string): Promise<TxPreview>;
  createJob(request: CreateJobRequest): Promise<{ plan_id: string }>;
  getPlan(planId: string): Promise<PlanEnvelope>;
  requestFundTx(planId: string, request: FundTxRequest): Promise<FundTxResponse>;
  buildTreeActionTx(treeId: string, request: TreeActionRequest): Promise<{ tx_cbor: string }>;
  listTrees(buyerVkh: string | null, limit?: number): Promise<TreeListItem[]>;
  /** Network totals by outcome, the hero tree, recent jobs and the agent bench (`GET /v1/landing`). */
  getLanding(): Promise<LandingData>;
  listDisputes(): Promise<Dispute[]>;
  buildResolveTx(treeId: string, nodeId: string, request: { worker: string; parent: string; change_address: string; utxos: string[] }): Promise<{ tx_cbor: string }>;
  getOpsStatus(): Promise<OpsStatus>;
  getProviderWork(assetId: string): Promise<ProviderWork>;
  subscribeTree(
    treeId: string,
    sinceEventId: string | null,
    handlers: SubscriptionHandlers,
  ): EventSubscription;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly route: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

/** The Conductor is not configured or did not answer; plans and signing need it, reading does not. */
export class ConductorOfflineError extends Error {
  constructor(readonly url: string | null) {
    super(url === null ? "No orchestrator is configured for this site." : `The orchestrator at ${url} did not respond.`);
    this.name = "ConductorOfflineError";
  }
}

