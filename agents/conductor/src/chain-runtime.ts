/**
 * Conductor's chain runtime, from the environment: SDK buyer transactions for the console, the
 * Temporal worker that runs funded trees with `SdkChainActions` (signatures only through the signer
 * service), and the watcher that starts a tree when its FundRoot is indexed.
 *
 * Env: CASCADE_NETWORK (local|preprod), CASCADE_SIGNER_URL, CASCADE_SIGNER_TOKEN,
 * CASCADE_INDEXER_URL, CASCADE_INDEXER_ADMIN_TOKEN, CASCADE_TEMPORAL_ADDRESS (default
 * 127.0.0.1:27233), CASCADE_TEMPORAL_NAMESPACE (default cascade), CASCADE_ORCHESTRATOR_DATABASE_URL
 * (plans and hire records; without it they live in memory and a restart loses drafted plans),
 * CASCADE_SIGNER_HOLDS_ARBITERS=1 (testnet only: resolve-tx collects arbiter signatures from the signer).
 * A second Conductor next to the running one (acceptance tests A14, A15; see README) sets its own
 * CASCADE_TASK_QUEUE and CASCADE_ORCHESTRATOR_STATE_PREFIX so neither takes the other's trees.
 */
import { Client, Connection } from "@temporalio/client";
import pg from "pg";
import { guardPool } from "@cascade/agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CascadeClient, loadMasumiScript, loadReferenceScripts } from "@cascade/sdk";
import { DEFAULT_BUYER_POLICY } from "@cascade/policy";
import { paymentKeyHash } from "@cascade/shared";
import {
  cascadeScripts,
  composeByMerge,
  createActivities,
  createWorker,
  DEFAULT_TASK_QUEUE,
  HttpTxSigner,
  IndexerClient,
  InMemoryHireLedger,
  InMemoryPlanStore,
  migrateOrchestratorState,
  PostgresHireLedger,
  PostgresPlanStore,
  type HireLedger,
  type PlanStore,
  MASUMI_VESTED_PAY_V2_HASH,
  openLucid,
  referenceRefs,
  REPO_ROOT,
  SdkBuyerTxBuilder,
  drawSlackMs,
  planPolicyFor,
  SdkChainActions,
  watchFunding,
  witnessSigner,
  signerMarkMasumiFailed,
  sdkStructuralSizer,
  type StructuralSizer,
} from "@cascade/orchestrator";
import type { LlmClient } from "@cascade/orchestrator/llm";
import { cascadeNetworkFromEnv, env, referenceDirectory, runtimeFor, walletAddressOf } from "@cascade/agent-kit";

const ADA = 1_000_000n;

export interface ChainRuntime {
  txBuilder: SdkBuyerTxBuilder;
  /** Exact structural reserve for plans, from the SDK's min-UTxO sizing at live protocol parameters. */
  structural: StructuralSizer;
  store: PlanStore;
  stop(): void;
}

/** Null when the signer or indexer is not configured: the console then answers 503 for tx routes. */
export async function chainRuntimeFromEnv(llm: LlmClient, onError: (where: string, e: unknown) => void): Promise<ChainRuntime | null> {
  const signerUrl = env("CASCADE_SIGNER_URL");
  const indexerUrl = env("CASCADE_INDEXER_URL");
  if (signerUrl === undefined || indexerUrl === undefined) return null;
  const network = cascadeNetworkFromEnv();
  const addressOf = walletAddressOf(network);
  const operatorAddress = addressOf("conductor");
  const purchaserAddress = addressOf("masumi-purchaser");
  const scripts = cascadeScripts();
  const buyerLucid = await openLucid(network);
  const refs = await loadReferenceScripts(buyerLucid, referenceRefs(network));
  const indexer = new IndexerClient({ baseUrl: indexerUrl, adminToken: env("CASCADE_INDEXER_ADMIN_TOKEN") ?? null });
  const signer = new HttpTxSigner(signerUrl, env("CASCADE_SIGNER_TOKEN") ?? null);
  // On preprod the plans live in the preprod database (DATABASE_URL_PREPROD in .env) unless set explicitly.
  const dbUrl = env("CASCADE_ORCHESTRATOR_DATABASE_URL") ?? (network === "preprod" ? env("DATABASE_URL_PREPROD") : undefined);
  let store: PlanStore;
  let ledger: HireLedger;
  if (dbUrl === undefined) {
    store = new InMemoryPlanStore();
    ledger = new InMemoryHireLedger();
  } else {
    const pool = guardPool(new pg.Pool({ connectionString: dbUrl, max: 5, keepAlive: true }));
    const prefix = env("CASCADE_ORCHESTRATOR_STATE_PREFIX") ?? "orchestrator";
    await migrateOrchestratorState(pool, prefix);
    store = new PostgresPlanStore(pool, prefix);
    ledger = new PostgresHireLedger(pool, prefix);
  }

  const txBuilder = new SdkBuyerTxBuilder({
    lucid: buyerLucid,
    scripts,
    refs,
    operatorAddress,
    defaults: {
      arbiters: ["arbiter-1", "arbiter-2", "arbiter-3"].map((r) => paymentKeyHash(addressOf(r))),
      arbiterThreshold: 2n,
      arbiterFeeAddress: addressOf("arbiter-1"),
      masumiScriptHash: MASUMI_VESTED_PAY_V2_HASH,
      protocolFeeBps: 0n,
      protocolFeeAddress: operatorAddress,
      challengeBondLovelace: 5n * ADA,
      slashWrongedBps: 7_000n,
    },
    registerPlan: (plan, treeId, policy) => indexer.registerPlan(plan, treeId, policy),
    basePolicy: DEFAULT_BUYER_POLICY,
    // Testnet demo only (label): the signer service also holds arbiter-1..3, so resolve-tx carries
    // the threshold's signatures. Set CASCADE_SIGNER_HOLDS_ARBITERS=1 only on Yaci or preprod.
    ...(env("CASCADE_SIGNER_HOLDS_ARBITERS") === "1"
      ? { arbiterSigner: { signer, roles: new Map(["arbiter-1", "arbiter-2", "arbiter-3"].map((r) => [paymentKeyHash(addressOf(r)), r])) } }
      : {}),
  });

  const directory = referenceDirectory(network);
  const chain = new SdkChainActions({
    lucid: await openLucid(network),
    // The plan's root deadline counts on this Draw slack (`tight_submit_by` in the Yaci plan policy).
    slackMs: drawSlackMs(planPolicyFor(network)),
    scripts,
    refs,
    operatorAddress,
    role: "conductor",
    signer,
    directory,
    plans: async (treeId) => {
      const p = await store.byTree(treeId);
      if (p === null) throw new Error(`no plan is recorded for tree ${treeId}`);
      return p.built.plan;
    },
    waitIndexed: indexer.waitIndexed,
    // ADR 0001 section 8.1: Masumi sellers are paid through the purchase wallet P, whose key only the signer holds.
    masumi: {
      purchaser: { address: purchaserAddress, sign: witnessSigner(signer, "masumi-purchaser", paymentKeyHash(purchaserAddress)) },
      script: loadMasumiScript(JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/sdk/vendor/masumi-payment-v2.plutus.json"), "utf8"))).script,
      markFailed: signerMarkMasumiFailed(signerUrl, env("CASCADE_SIGNER_TOKEN") ?? null),
    },
  });
  const address = env("CASCADE_TEMPORAL_ADDRESS") ?? "127.0.0.1:27233";
  const namespace = env("CASCADE_TEMPORAL_NAMESPACE") ?? "cascade";
  const taskQueue = env("CASCADE_TASK_QUEUE") ?? DEFAULT_TASK_QUEUE;
  const worker = await createWorker({ address, namespace, taskQueue, activities: createActivities({ chain, directory, compose: composeByMerge, llm, ledger, recordPaymentResponse: indexer.recordPaymentResponse, recordChallengeReason: indexer.recordChallengeReason }) });
  void worker.run().catch((e: unknown) => onError("temporal worker", e));
  const client = new Client({ connection: await Connection.connect({ address }), namespace });
  const stopWatch = watchFunding({ store, indexer, client, plansApi: runtimeFor("conductor").baseUrl, taskQueue, onError: (e) => onError("funding watcher", e) });
  return {
    txBuilder,
    structural: sdkStructuralSizer(new CascadeClient(buyerLucid, scripts, refs)),
    store,
    stop() {
      stopWatch();
      worker.shutdown();
    },
  };
}
