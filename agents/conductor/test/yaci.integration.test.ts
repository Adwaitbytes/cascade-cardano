/**
 * The orchestrator driving a real tree on Yaci DevKit with the deployed validators:
 * the buyer funds the root through the console's SDK builder; a Temporal `nodeWorkflow` hires
 * Scribe (real @cascade/agent server) and Flaky Lisan (the test agent that fails on purpose) as
 * native children; each Draw is signed by the signer service after its eight gates and settled by
 * the Cascade facilitator as the agent's x402 `script` payment; Scribe submits on chain through
 * the signer; the orchestrator verifies, accepts and settles it; Flaky Lisan misses `submit_by`
 * and is refunded back into the root; the root submits; the buyer accepts and closes.
 *
 * Needs `pnpm local:up` (Yaci, Postgres, Temporal) with scripts deployed.
 */
import { NativeConnection, Worker } from "@temporalio/worker";
import { Client, Connection } from "@temporalio/client";
import { generatePrivateKey, utxoToCore, walletFromSeed, CML, type LucidEvolution } from "@lucid-evolution/lucid";
import { deployReferenceScripts, loadMasumiScript, loadReferenceScripts, registerLogicCredentials, CascadeClient, type ReferenceScripts, type CascadeScripts } from "@cascade/sdk";
import { blake2b_224, bytesToHex, decodeMasumiDatum, decodeNodeDatum, encodeMasumiIdentifier, plutusAddressToBech32, signCose1, type JsonValue, type Plan } from "@cascade/shared";
import { createHash } from "node:crypto";
import { OgmiosClient, deriveRoleKey, loadNetworkConfig, ogmiosResolver, withTransaction } from "@cascade/service-kit";
import { createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { Follower, ensureScriptsFingerprint, reconcile, type FlowRecord } from "@cascade/indexer";
import { Signer } from "@cascade/signer";
import { DEFAULT_BUYER_POLICY } from "@cascade/policy";
import { CascadeCardanoFacilitator, OgmiosChain, PgClaimStore, LOCAL_NETWORK } from "@cascade/facilitator";
import { coseSigner, type PaymentVerifier, type CascadeAgent } from "@cascade/agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createSubtreeRunner, privateKeyTxSigner, testScenarioOf, chainEscalator, chainSubmitter, meteredPlanResolver, nativeChildPayments, providerChannelOps, VoucherChannel, type AgentRuntime } from "@cascade/agent-kit";
import { createScribeAgent } from "@cascade/agent-scribe";
import { createScoutAgent } from "@cascade/agent-scout";
import { createPricerAgent } from "@cascade/agent-pricer";
import { createLookupApiAgent, METERED_PER_CALL_LOVELACE } from "@cascade/agent-lookup-api";
import { createFlakyLisanAgent } from "@cascade/agent-flaky-lisan";
import { createCheckerAAgent } from "@cascade/agent-checker-a";
import { createCheckerBAgent } from "@cascade/agent-checker-b";
import { createCheckerCAgent } from "@cascade/agent-checker-c";
import { fakeOpenRouter } from "@cascade/agent-kit/testing";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MODELS, LlmClient } from "@cascade/orchestrator/llm";
import {
  buildPlan,
  cascadeScripts,
  composeByMerge,
  createActivities,
  DEFAULT_POLICY,
  inProcessSigner,
  InMemoryHireLedger,
  MASUMI_VESTED_PAY_V2_HASH,
  openLucid,
  REPO_ROOT,
  SdkBuyerTxBuilder,
  SdkChainActions,
  tsExtensionAlias,
  workflowsPath,
  witnessSigner,
  sdkStructuralSizer,
  scenarioDraft,
  scenarioInput,
  demoDraft,
  type BuiltPlan,
  type JobIntake,
  type NodeOutcome,
  type PlanDraft,
  type AgentDirectory,
  type TxSigner,
} from "@cascade/orchestrator";

const YACI_MNEMONIC = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ADA = 1_000_000n;
const ROLES = { conductor: 40, scribe: 41, "flaky-lisan": 42, "checker-a": 44, "checker-b": 45, "checker-c": 46, pricer: 49, scout: 51, "lookup-api": 52 } as const;
type AgentRole = Exclude<keyof typeof ROLES, "conductor">;
const AGENT_ROLE_LIST: AgentRole[] = ["scribe", "flaky-lisan", "checker-a", "checker-b", "checker-c", "pricer", "scout", "lookup-api"];
const AGENT_IDS: Record<keyof typeof ROLES, string> = {
  conductor: `${"67".repeat(28)}c0`,
  scribe: `${"67".repeat(28)}c1`,
  "flaky-lisan": `${"67".repeat(28)}c2`,
  "checker-a": `${"67".repeat(28)}c3`,
  "checker-b": `${"67".repeat(28)}c4`,
  "checker-c": `${"67".repeat(28)}c5`,
  pricer: `${"67".repeat(28)}c6`,
  "lookup-api": `${"67".repeat(28)}c7`,
  scout: `${"67".repeat(28)}c8`,
};
const roleOfAgent = (id: string): AgentRole => {
  const role = AGENT_ROLE_LIST.find((r) => AGENT_IDS[r] === id);
  if (role === undefined) throw new Error(`unknown agent ${id}`);
  return role;
};
const log = pino({ level: process.env["E2E_LOG"] === "1" ? "info" : "silent" });
const cfg = loadNetworkConfig("local");
const ogmios = new OgmiosClient(cfg.ogmiosHttp);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: TestDatabase;
let follower: Follower;
let lucid: LucidEvolution;
let scripts: CascadeScripts;
let refs: ReferenceScripts;
const plans = new Map<string, Plan>();
let signer: TxSigner;
const endpoints = (JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/local.json"), "utf8")) as { endpoints: { adminTopup: string; adminDevnetInfo: string } }).endpoints;
const agents = new Map<string, CascadeAgent>();
const factories = new Map<string, () => CascadeAgent>();

/** Simulates an agent process restart: a new instance whose in-memory job store is empty. */
async function restartAgent(role: AgentRole): Promise<void> {
  const make = factories.get(role);
  if (make === undefined) throw new Error(`no factory for ${role}`);
  agents.get(role)?.close();
  const fresh = make();
  await fresh.recover();
  agents.set(role, fresh);
}

async function waitIndexed(txId: string, _treeId?: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const { rows } = await db.pool.query("SELECT 1 FROM node_utxos WHERE tx_id = $1 OR spent_tx = $1 LIMIT 1", [txId]);
    if (rows.length > 0) return;
    await sleep(500);
  }
  throw new Error(`indexer did not apply ${txId}`);
}

async function followerAtTip(): Promise<void> {
  const res = await fetch(cfg.ogmiosHttp, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "queryNetwork/tip" }) });
  const tip = BigInt(((await res.json()) as { result: { slot: number } }).result.slot);
  for (let i = 0; i < 1_000; i++) {
    const { rows } = await db.pool.query<{ slot: string | null }>("SELECT max(slot)::text AS slot FROM chain_points");
    if (rows[0]?.slot != null && BigInt(rows[0].slot) >= tip) return;
    await sleep(500);
  }
  throw new Error(`the indexer follower did not reach slot ${tip}`);
}

async function topUp(address: string, ada: number): Promise<void> {
  // The Yaci faucet is shared with other suites; a busy faucet answers 500, so retry briefly.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(endpoints.adminTopup, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, adaAmount: ada }),
    });
    if (res.ok) return;
    if (attempt >= 5) throw new Error(`topup failed: HTTP ${res.status}`);
    await sleep(2_000 * attempt);
  }
}

function buyerParty() {
  const privateKey = generatePrivateKey();
  const vkh = bytesToHex(blake2b_224(CML.PrivateKey.from_bech32(privateKey).to_public().to_raw_bytes()));
  return { privateKey, vkh, address: plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null }, 0) };
}

const keys = Object.fromEntries(Object.entries(ROLES).map(([role, account]) => [role, deriveRoleKey(YACI_MNEMONIC, account, "local")])) as Record<keyof typeof ROLES, ReturnType<typeof deriveRoleKey>>;
const runtimeOf = (role: AgentRole): AgentRuntime => ({ role, port: 0, baseUrl: `http://${role}.test`, network: LOCAL_NETWORK as AgentRuntime["network"], registryAsset: AGENT_IDS[role], registered: true, asset: "lovelace" });

/** Agent id -> in-process base URL and payment address (the Cascade Directory in production). */
const testDirectory: AgentDirectory = {
  resolve: async (id: string) => {
    if (id === SELLER_ID) return { base_url: "http://masumi-seller.test", payment_address: sellerAddress, masumi_price_lovelace: "10000000" };
    if (id === BAD_SELLER_ID) return { base_url: "http://masumi-bad.test", payment_address: sellerAddress, masumi_price_lovelace: "10000000" };
    const role = roleOfAgent(id);
    return { base_url: `http://${role}.test`, payment_address: keys[role].address, signer_role: role };
  },
};
const subtrees: { stop(): Promise<void> }[] = [];
/** The chain actions of the last root run (the A3 return case drives P's return with them). */
let lastChain: SdkChainActions | undefined;
/** What `POST /v1/masumi/failed` on the signer service does: record the failed slot for the fence. */
const markFailed = async (paymentOutRef: string, reason: string): Promise<void> => {
  await db.pool.query("INSERT INTO masumi_slot_failures (payment_out_ref, reason, marked_at) VALUES ($1, $2, $3) ON CONFLICT (payment_out_ref) DO NOTHING", [paymentOutRef, reason, Date.now()]);
};

/** Routes `http://<role>.test/...` to the in-process agent servers. */
const agentFetch: typeof fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname === "conductor.test") {
    const id = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    const plan = [...plans.values()].find((p) => p.plan_id === id);
    return plan === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ plan }), { headers: { "content-type": "application/json" } });
  }
  if (u.hostname === "masumi-seller.test") return masumiSeller(new Request(u, init));
  if (u.hostname === "masumi-bad.test") return masumiSeller(new Request(u, init), BAD_SELLER_ID, 700_000);
  const agent = agents.get(u.hostname.replace(/\.test$/, ""));
  if (agent === undefined) throw new Error(`no agent at ${u.hostname}`);
  return agent.fetch(new Request(u, init));
};

beforeAll(async () => {
  db = await createTestDatabase();
  lucid = await openLucid("local");
  scripts = cascadeScripts();
  for (const k of Object.values(keys)) await topUp(k.address, 300);
  await topUp(PURCHASER.address, 20);
  // Deploy this test's own reference scripts from the current blueprint, so the run never depends
  // on whichever contracts the shared local deployment last published.
  const deployer = deriveRoleKey(YACI_MNEMONIC, 43, "local");
  await topUp(deployer.address, 2_000);
  await sleep(3_000);
  const deployLucid = await openLucid("local");
  deployLucid.selectWallet.fromSeed(YACI_MNEMONIC, { addressType: "Base", accountIndex: 43 });
  refs = await loadReferenceScripts(deployLucid, await deployReferenceScripts(deployLucid, scripts));
  await registerLogicCredentials(deployLucid, scripts, refs);

  const hashes = { node: scripts.nodeHash, config: scripts.configHash, logicCore: scripts.logicCoreHash, logicDraw: scripts.logicDrawHash, bond: scripts.bondHash };
  await withTransaction(db.pool, (c) => ensureScriptsFingerprint(c, JSON.stringify(hashes)));
  follower = new Follower({ pool: db.pool, ogmiosWs: cfg.ogmiosWs, scripts: hashes, log, keepPoints: 300, publish: () => undefined });
  follower.start();
  for (const role of AGENT_ROLE_LIST) {
    await db.pool.query("INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, allowlisted, last_seen) VALUES ($1, $2, $3, $4, true, 1)", [AGENT_IDS[role], role, `http://${role}.test`, keys[role].paymentKeyHash]);
  }
  const signerService = new Signer({
    pool: db.pool,
    scripts: { ...hashes, logicExt: scripts.logicExtHash },
    keys: new Map([...Object.entries(keys), ...Object.entries(ARBITERS), ["masumi-purchaser", PURCHASER]]),
    logKey: deriveRoleKey(YACI_MNEMONIC, 21, "local"),
    simulator: {
      async evaluate(cbor) {
        const r = await ogmios.evaluate(cbor);
        return { memory: r.reduce((a, x) => a + x.budget.memory, 0n), cpu: r.reduce((a, x) => a + x.budget.cpu, 0n) };
      },
    },
    resolveInputs: ogmiosResolver(ogmios),
    abuseList: [],
    log,
  });
  signer = inProcessSigner(signerService as never);
  const info = (await (await fetch(endpoints.adminDevnetInfo)).json()) as { startTime: number };
  const facilitator = new CascadeCardanoFacilitator({
    profile: { network: LOCAL_NETWORK, slotConfig: { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: 1000 }, masumi: false },
    chain: new OgmiosChain(ogmios, { url: cfg.blockfrostUrl ?? "", projectId: null }),
    claims: new PgClaimStore(db.pool),
    log,
    nodeScriptHash: scripts.nodeHash,
    confirmationWaitMs: 2_000,
    confirmationPollMs: 500,
  });
  const facilitatorVerifier = facilitator as unknown as PaymentVerifier;
  const nodeAddress = new CascadeClient(lucid, scripts, refs).addresses.node;
  for (const role of AGENT_ROLE_LIST) {
    const agentLucid = await openLucid("local");
    const payments = nativeChildPayments({ network: LOCAL_NETWORK as AgentRuntime["network"], nodeAddress, nodeScriptHash: scripts.nodeHash, facilitator: facilitatorVerifier, agentAddress: keys[role].address });
    const onResult = chainSubmitter({ lucid: agentLucid, scripts, refs, agentAddress: keys[role].address, role, signer });
    const k = keys[role];
    const signerForAgent = coseSigner({ address: k.address, publicKey: Uint8Array.from(Buffer.from(k.publicKey, "hex")), sign: (m) => k.sign(m) });
    const runtime = runtimeOf(role);
    const deps = { runtime, signer: signerForAgent, payments, onResult };
    // Scribe and Scout sub-hire through the orchestrator library on their own task queues, signed as themselves (A1).
    const subtree =
      role === "scribe" || role === "scout"
        ? await createSubtreeRunner({
            role,
            operatorAddress: k.address,
            lucid: await openLucid("local"),
            scripts,
            refs,
            signer,
            directory: testDirectory,
            waitIndexed,
            ledger: new InMemoryHireLedger(),
            llm: new LlmClient({}),
            temporal: { address: "127.0.0.1:27233", namespace: "cascade" },
            taskQueue: `yaci-${role}-${Date.now()}`,
            fetch: agentFetch,
            onError: (e) => process.stdout.write(`SUBTREE-ERROR ${role}: ${e instanceof Error ? e.message : String(e)}\n`),
          })
        : null;
    if (subtree !== null) subtrees.push(subtree);
    const sub = subtree === null ? {} : { subtree: subtree.run };
    // Checkers A and B judge deterministically (L0 only, labelled); Checker C's model is scripted to reject (A9).
    const rejecting = new LlmClient({ apiKey: "scripted", fetch: fakeOpenRouter([JSON.stringify({ verdict: "reject", score: 0.1, reasons: ["scripted dissent for the 2-of-3 quorum test"] })], DEFAULT_MODELS.checkerC) });
    // `restartAgent(role)` builds a fresh instance (new in-memory job store), as a process restart does.
    const make = (): CascadeAgent =>
      role === "scribe"
        ? createScribeAgent({ ...deps, ...sub, llm: new LlmClient({}), onChallenge: chainEscalator({ lucid: agentLucid, scripts, refs, agentAddress: keys[role].address, role, signer, shouldEscalate: (job) => testScenarioOf(job) !== "a8-schema-fail" }) })
        : role === "flaky-lisan"
          ? createFlakyLisanAgent({ runtime, signer: signerForAgent, payments })
          : role === "pricer"
            ? createPricerAgent({
                runtime,
                signer: signerForAgent,
                payments,
                onResult,
                metered: {
                  planFor: meteredPlanResolver(new CascadeClient(agentLucid, scripts, refs), agentFetch),
                  open: (o) => VoucherChannel.open({ lucid: agentLucid, scripts, refs, signer, role, payerAddress: keys.pricer.address, slackMs: 20_000 }, { ...o, providerAddress: keys["lookup-api"].address }),
                  lookupBaseUrl: "http://lookup-api.test",
                  perCall: METERED_PER_CALL_LOVELACE,
                  fetch: agentFetch,
                },
              })
          : role === "scout"
            ? createScoutAgent({ ...deps, ...sub, llm: new LlmClient({}) })
          : role === "lookup-api"
            ? createLookupApiAgent({ runtime, signer: signerForAgent, verifier: facilitatorVerifier, onError: (where, e) => process.stdout.write(`LOOKUP-ERROR ${where}: ${e instanceof Error ? e.message.slice(0, 600) : String(e)}\n`), channels: providerChannelOps({
                lucid: agentLucid,
                scripts,
                refs,
                signer,
                role,
                providerAddress: keys["lookup-api"].address,
                // Third-party provider: redeems with its own wallet key (the Yaci devnet account it owns).
                redeemSigner: privateKeyTxSigner(agentLucid, walletFromSeed(YACI_MNEMONIC, { addressType: "Base", accountIndex: ROLES["lookup-api"], network: "Custom" }).paymentKey),
              }) })
          : role === "checker-a"
            ? createCheckerAAgent({ ...deps, llm: new LlmClient({}) })
            : role === "checker-b"
              ? createCheckerBAgent({ ...deps, llm: new LlmClient({}) })
              : createCheckerCAgent({ ...deps, llm: rejecting });
    factories.set(role, make);
    agents.set(role, make());
  }
  // The follower replays the devnet from origin; tests start once it has reached the current tip.
  await followerAtTip();
}, 600_000);

afterEach(async (ctx) => {
  if (process.env["E2E_LOG"] !== "1" || ctx.task.result?.state !== "fail") return;
  for (const [role, agent] of agents) {
    const failed = await agent.store.listByStatus(["failed"]);
    if (failed.length > 0) process.stdout.write(`JOBS ${role} ${JSON.stringify(failed.map((j) => j.error))}\n`);
  }
});

afterAll(async () => {
  for (const a of agents.values()) a.close();
  for (const t of subtrees) await t.stop();
  await follower?.stop();
  await db?.drop();
});

function demoPlan(tasks?: PlanDraft["tasks"], budgetAda = 60n, maxDepth = 2): BuiltPlan {
  const now = Date.now();
  const draft: PlanDraft = {
    summary: "Scribe writes; Flaky Lisan (test agent) fails on purpose.",
    tasks: tasks ?? [
      { id: "scribe", parent: "root", title: "Write the market-entry brief", category: "writing", rail: "native", output_fields: [{ name: "brief", type: "string", description: "brief" }, { name: "summary", type: "string", description: "summary" }], acceptance: "VerifierQuorum", effort_minutes: 1, may_sub_hire: false, budget_weight: 50, verifies: "", contingency_for: "", after: [] },
      ...(["a", "b", "c"] as const).map((x) => ({
        id: `check-${x}`,
        parent: "root",
        title: `Verify the brief (Checker ${x.toUpperCase()})`,
        category: "verification" as const,
        rail: "native" as const,
        output_fields: [{ name: "verdict", type: "object" as const, description: "Signed verdict" }, { name: "reasons", type: "array" as const, description: "Reasons" }],
        acceptance: "ParentAccept" as const,
        effort_minutes: 1,
        may_sub_hire: false,
        budget_weight: 5,
        verifies: "scribe",
        contingency_for: "",
        after: ["scribe"],
      })),
      { id: "translate-ar", parent: "root", title: "Translate the summary into Arabic", category: "translation", rail: "native", output_fields: [{ name: "arabic_summary", type: "string", description: "Arabic" }], acceptance: "ParentAccept", effort_minutes: 1, may_sub_hire: false, budget_weight: 30, verifies: "", contingency_for: "", after: [] },
    ],
  };
  const intake: JobIntake = { goal: "Market entry brief for cold-pressed juice in Dubai", asset: "lovelace", budget: (budgetAda * ADA).toString(), fund_by: now + 30 * 60_000, submit_by: now + 3 * 3_600_000, max_depth: maxDepth, reputation_floor: 0, risk: "balanced" };
  const agentFor = (id: string): string =>
    id === "translate-masumi" || id === "translate-ar-masumi" ? SELLER_ID : id === "scout" ? AGENT_IDS.scout : id === "translate-masumi-bad" ? BAD_SELLER_ID : id === "scribe" || id === "summarise" || id === "brief" || id.startsWith("digest-") ? AGENT_IDS.scribe : id === "market" || id.startsWith("research-") ? AGENT_IDS.scout : id === "pricer" ? AGENT_IDS.pricer : id === "lookup" || id === "lookup-pay" ? AGENT_IDS["lookup-api"] : id === "translate-ar" ? AGENT_IDS["flaky-lisan"] : AGENT_IDS[`checker-${id.slice(-1)}` as AgentRole];
  const built = buildPlan(draft, intake, (task) => ({ primary: { agent_id: task === "root" ? AGENT_IDS.conductor : agentFor(task.id), quote_id: null, price: task !== "root" && task.rail === "metered" ? METERED_PER_CALL_LOVELACE.toString() : "0" }, fallbacks: [] }), {
    ...DEFAULT_POLICY,
    min_challenge_window_ms: 60_000,
    min_safety_margin_ms: 5_000,
    dispute_window_ms: 180_000,
  }, (t) => keys[`checker-${t.id.slice(-1)}` as "checker-a"].paymentKeyHash, { masumiPurchaserHash: PURCHASER.paymentKeyHash, structural: sdkStructuralSizer(new CascadeClient(lucid, scripts, refs)) });
  if (!built.ok) throw new Error(built.errors.join("; "));
  return built.built;
}


/** The tree's Masumi purchase wallet P (ADR 0001 section 8.1); only the signer holds its key. */
const PURCHASER = deriveRoleKey(YACI_MNEMONIC, 19, "local");
/** A stand-in Masumi seller (MIP-003 /start_job and /status): its own key signs the identifier, as Masumi's payment service does. */
const SELLER_ID = `${"67".repeat(28)}d0`;
const sellerKey = new Uint8Array(32).fill(7);
const sellerVkh = CML.PrivateKey.from_normal_bytes(sellerKey).to_public().hash().to_hex();
const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());
const sellerAddress = plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: sellerVkh }, stake_credential: null }, 0);

/** A seller whose deadlines break Masumi's minimum gaps: the signer refuses P's lock (gate 6). */
const BAD_SELLER_ID = `${"67".repeat(28)}d1`;

async function masumiSeller(req: Request, agentId = SELLER_ID, gapMs = 960_000): Promise<Response> {
  const u = new URL(req.url);
  if (u.pathname === "/start_job" && req.method === "POST") {
    const body = (await req.json()) as { identifier_from_purchaser: string };
    const identifier = body.identifier_from_purchaser;
    const escrow = plutusAddressToBech32({ payment_credential: { type: "Script", hash: MASUMI_VESTED_PAY_V2_HASH }, stake_credential: null }, 0);
    const signed = signCose1({ payload: sha256(new TextEncoder().encode(`terms-${identifier}`)), secretKey: sellerKey, address: sellerAddress });
    const t = Date.now();
    const job = `masumi-${identifier}`;
    // Masumi's ordering (signer gate 6): payBy + 5 min <= submitResult, then 15 min to unlock and to the external dispute unlock.
    return Response.json({
      job_id: job,
      blockchainIdentifier: encodeMasumiIdentifier({ sellerNonce: bytesToHex(sha256(new TextEncoder().encode(`nonce-${identifier}`))), agentIdentifier: agentId, buyerNonce: identifier, referenceSignature: signed.signature, referenceKey: signed.key, contractAddress: escrow }),
      payByTime: t + 600_000,
      submitResultTime: t + gapMs,
      unlockTime: t + 2 * gapMs,
      externalDisputeUnlockTime: t + 3 * gapMs,
      agentIdentifier: agentId,
      sellerVKey: sellerVkh,
      input_hash: bytesToHex(sha256(new TextEncoder().encode(`input-${identifier}`))),
      amounts: [{ unit: "lovelace", amount: "10000000" }],
    });
  }
  if (u.pathname === "/status") return Response.json({ job_id: u.searchParams.get("job_id"), status: "completed", result: "ملخص تنفيذي" });
  return new Response("not found", { status: 404 });
}

const ARBITERS = { "arbiter-1": deriveRoleKey(YACI_MNEMONIC, 47, "local"), "arbiter-2": deriveRoleKey(YACI_MNEMONIC, 48, "local") };

function makeBuilder(buyer: { address: string }) {
  return new SdkBuyerTxBuilder({
    lucid,
    scripts,
    refs,
    operatorAddress: keys.conductor.address,
    defaults: {
      arbiters: Object.values(ARBITERS).map((k) => k.paymentKeyHash),
      arbiterThreshold: 2n,
      arbiterFeeAddress: buyer.address,
      masumiScriptHash: MASUMI_VESTED_PAY_V2_HASH,
      protocolFeeBps: 0n,
      protocolFeeAddress: buyer.address,
      challengeBondLovelace: 5n * ADA,
      slashWrongedBps: 7000n,
    },
    registerPlan: async (p, treeId, policy) => {
      plans.set(treeId, p);
      await db.pool.query("INSERT INTO plans (plan_id, tree_id, plan_root, json, version, policy) VALUES ($1, $2, $3, $4, 1, $5)", [p.plan_id, treeId, p.plan_root, JSON.stringify(p), JSON.stringify(policy)]);
    },
    basePolicy: DEFAULT_BUYER_POLICY,
    // Testnet only: the signer holds both arbiter keys, so resolve-tx carries the 2-of-2 threshold.
    arbiterSigner: { signer, roles: new Map(Object.entries(ARBITERS).map(([role, k]) => [k.paymentKeyHash, role])) },
  });
}

/** What the console sends: no reputation floor, nobody blocked. */
const BUYER_TERMS = { min_reputation: 0, block_agents: [] };

async function walletOf(address: string) {
  return { change_address: address, utxos: (await lucid.utxosAt(address)).map((u) => utxoToCore(u).to_cbor_hex()) };
}

async function submitAs(privateKey: string, txCbor: string): Promise<string> {
  const signed = await lucid.fromTx(txCbor).sign.withPrivateKey(privateKey).complete();
  const txId = await signed.submit();
  expect(await lucid.awaitTx(txId, 1_000)).toBe(true);
  return txId;
}

async function fundTree(builder: SdkBuyerTxBuilder, buyer: { address: string; privateKey: string }, plan: Plan): Promise<string> {
  const fund = await builder.fundRoot(plan, await walletOf(buyer.address), BUYER_TERMS);
  await waitIndexed(await submitAs(buyer.privateKey, fund.tx_cbor));
  return fund.tree_id;
}

async function runRoot(built: BuiltPlan, treeId: string, extraInput: Record<string, JsonValue> = {}): Promise<{ outcome: NodeOutcome; chainLucid: LucidEvolution }> {
  const plan = built.plan;
  const chainLucid = await openLucid("local");
  const directory = testDirectory;
  const chain = new SdkChainActions({
    lucid: chainLucid,
    scripts,
    refs,
    operatorAddress: keys.conductor.address,
    role: "conductor",
    signer,
    directory,
    plans: async (t) => {
      const p = plans.get(t);
      if (p === undefined) throw new Error(`no plan for ${t}`);
      return p;
    },
    slackMs: 20_000,
    waitIndexed,
    masumi: {
      purchaser: { address: PURCHASER.address, sign: witnessSigner(signer, "masumi-purchaser", PURCHASER.paymentKeyHash) },
      script: loadMasumiScript(JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/sdk/vendor/masumi-payment-v2.plutus.json"), "utf8"))).script,
      markFailed,
    },
  });
  lastChain = chain;
  const activities = createActivities({ chain, directory, compose: composeByMerge, llm: new LlmClient({}), fetch: agentFetch });
  const connection = await NativeConnection.connect({ address: "127.0.0.1:27233" });
  const taskQueue = `yaci-${Date.now()}`;
  const worker = await Worker.create({ connection, namespace: "cascade", taskQueue, workflowsPath: workflowsPath(), activities, bundlerOptions: { webpackConfigHook: tsExtensionAlias } });
  const client = new Client({ connection: await Connection.connect({ address: "127.0.0.1:27233" }), namespace: "cascade" });
  const outcome = (await worker.runUntil(
    client.workflow.execute("nodeWorkflow", {
      taskQueue,
      workflowId: `yaci-root-${treeId}`,
      args: [
        {
          tree_id: treeId,
          node_id: treeId,
          spec: plan.root.spec,
          children: plan.root.children.map((c) => ({ spec: c.spec, candidates: [c.agents.primary] })),
          contingencies: built.contingencies,
          after: built.after,
          verifiers: built.verifiers,
          input: { goal: "Market entry brief for cold-pressed juice in Dubai", plan_id: plan.plan_id, plans_api: "http://conductor.test", brands: "Sample Brand A,Sample Brand B,Sample Brand C,Sample Brand D,Sample Brand E", ...extraInput },
          reserve: "0",
          poll_ms: 5_000,
        },
      ],
    }),
  )) as NodeOutcome;
  return { outcome, chainLucid };
}

describe("orchestrator on Yaci with real agents", () => {
  it("funds, hires, refunds Flaky Lisan, settles Scribe, submits the root, and closes", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    const built = demoPlan();
    const plan = built.plan;
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, plan);
    const { outcome, chainLucid } = await runRoot(built, treeId);

    if (process.env["E2E_LOG"] === "1") process.stdout.write(`OUTCOME ${JSON.stringify(outcome.children.map((c) => ({ id: c.spec_id, status: c.status, actions: c.actions })))}\n`);
    const byId = Object.fromEntries(outcome.children.map((c) => [c.spec_id, c]));
    expect(byId["scribe"]?.status).toBe("accepted");
    expect(byId["translate-ar"]?.status).toBe("partial");
    expect(outcome.partial).toBe(true);
    const actions = byId["translate-ar"]?.actions ?? [];
    expect(actions).toContain("event missed_submit_by");
    expect(actions).toContain("action crank_refund");

    // Chain state: Flaky Lisan's node burned by Refund, Scribe paid, root Submitted with the composed hash.
    const reader = new CascadeClient(chainLucid, scripts, refs);
    const root = await reader.node(treeId);
    expect(root.datum.state).toBe("Submitted");
    expect(root.datum.result_hash).toBe(outcome.result_hash);
    expect(root.datum.children_open).toBe(0n);
    expect(root.datum.committed).toBe(0n);
    const feeOf = (id: string) => BigInt(plan.root.children.find((c) => c.spec.id === id)!.spec.price.max_fee);
    const scribeFee = feeOf("scribe");
    // ADR 1.5: budget never decreases; value that left the tree is tracked in `spent`.
    expect(root.datum.budget).toBe(60n * ADA);
    expect(root.datum.spent).toBe(scribeFee + feeOf("check-a") + feeOf("check-b") + feeOf("check-c"));
    const scribePaid = (await chainLucid.utxosAt(keys.scribe.address)).some((u) => u.assets.lovelace === scribeFee);
    expect(scribePaid, "Scribe's payee output holds exactly its fee").toBe(true);

    // A9: Checker C rejected, A and B accepted; the VerifierQuorum(2 of 3) Accept carries A's and B's signatures.
    const scribeHire = byId["scribe"];
    if (scribeHire?.status !== "accepted") throw new Error("scribe not accepted");
    expect(scribeHire.actions.filter((a) => a.startsWith("hired"))).toHaveLength(1);
    const scribeLogs = await db.pool.query("SELECT DISTINCT role FROM gate_logs WHERE node_id = $1 AND decision = 'allow'", [scribeHire.hire.node_id]);
    const roles = scribeLogs.rows.map((r: { role: string }) => r.role).sort();
    expect(roles).toEqual(expect.arrayContaining(["checker-a", "checker-b", "conductor"]));
    expect(roles).not.toContain("checker-c");

    // The buyer accepts through the console builder and closes the root.
    const acceptTx = await builder.treeAction(treeId, "Accept", treeId, await walletOf(buyer.address));
    await submitAs(buyer.privateKey, acceptTx.tx_cbor);
    await sleep(2_000);
    lucid.selectWallet.fromPrivateKey(buyer.privateKey);
    const close = await new CascadeClient(lucid, scripts, refs).closeRoot(treeId);
    const signedClose = await close.tx.sign.withWallet().complete();
    expect(await lucid.awaitTx(await signedClose.submit(), 1_000)).toBe(true);
    await sleep(2_000);
    await expect(reader.node(treeId)).rejects.toThrow();
    const gateLogs = await db.pool.query("SELECT decision, role FROM gate_logs WHERE tree_id = $1", [treeId]);
    expect(gateLogs.rows.length).toBeGreaterThan(0);
    expect(gateLogs.rows.filter((r: { decision: string }) => r.decision !== "allow"), "every signature the run asked for passed the gates").toEqual([]);
  });
  it("challenges a result that fails its schema; the worker escalates; two arbiters rule for the parent and the challenger bond returns (A9 second run)", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    // The console's labelled A9 scenario: Scribe returns { brief, summary }; the spec asks for { summary, sources }, so L0 fails.
    const built = demoPlan(scenarioDraft("a9-escalation", { lookupApi: keys["lookup-api"].paymentKeyHash }).tasks);
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, built.plan);
    const reader = new CascadeClient(lucid, scripts, refs);

    const running = runRoot(built, treeId, { test_scenario: "a9-escalation" });
    // The arbiter console: wait for the Disputed child, then rule for the parent with both arbiters.
    let disputedId: string | null = null;
    for (let i = 0; i < 300 && disputedId === null; i++) {
      for (const u of await lucid.utxosAt(reader.addresses.node)) {
        if (u.datum === undefined || u.datum === null) continue;
        const d = decodeNodeDatum(u.datum);
        if (d.tree_id === treeId && d.parent_id === treeId && d.state === "Disputed") disputedId = d.node_id;
      }
      if (disputedId === null) await sleep(1_000);
    }
    if (disputedId === null) throw new Error("the child never reached Disputed");
    const child = await reader.node(disputedId);
    const ruling = await builder.resolve(treeId, disputedId, { worker: 0n, parent: child.datum.budget }, await walletOf(buyer.address));
    await submitAs(buyer.privateKey, ruling.tx_cbor);

    const { outcome } = await running;
    const slot = outcome.children[0];
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`DISPUTE ${JSON.stringify(slot)}\n`);
    expect(slot?.status).toBe("partial");
    expect(slot?.actions).toEqual(expect.arrayContaining(["event schema_failed", "action challenge", "event challenge_rebutted", "action escalate_to_arbiters", "event dispute_resolved"]));
    await expect(reader.node(disputedId)).rejects.toThrow();
    const root = await reader.node(treeId);
    expect(root.datum.committed).toBe(0n);
    expect(root.datum.spent).toBe(0n);
    const roles = (await db.pool.query("SELECT DISTINCT role FROM gate_logs WHERE node_id = $1 AND decision = 'allow'", [disputedId])).rows.map((r: { role: string }) => r.role);
    expect(roles).toEqual(expect.arrayContaining(["conductor", "scribe", "arbiter-1", "arbiter-2"]));
    // ReturnBond: the challenger (Conductor) got its 5 ADA bond back in the Resolve.
    expect((await lucid.utxosAt(keys.conductor.address)).some((u) => u.assets.lovelace === 5n * ADA)).toBe(true);
  });
  it("Pricer buys 210 metered lookups from the Lookup API in 3 L1 transactions (PRD 8.6)", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    // The console's labelled A7 scenario: Pricer under the root, its metered channel to the Lookup API under Pricer.
    const built = demoPlan(scenarioDraft("a7-metered", { lookupApi: keys["lookup-api"].paymentKeyHash }).tasks);
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, built.plan);
    const lookupBefore = (await lucid.utxosAt(keys["lookup-api"].address)).length;
    const { outcome } = await runRoot(built, treeId, { test_scenario: "a7-metered", ...scenarioInput("a7-metered") });
    const slot = outcome.children[0];
    if (process.env["E2E_LOG"] === "1") {
      process.stdout.write(`METERED ${JSON.stringify(slot)}\n`);
      for (const role of ["pricer", "lookup-api"] as const) {
        const failed = await agents.get(role)?.store.listByStatus(["failed"]);
        process.stdout.write(`JOBS ${role} ${JSON.stringify((failed ?? []).map((j) => j.error))}\n`);
      }
    }
    expect(slot?.status).toBe("accepted");
    if (slot?.status !== "accepted") return;
    const result = slot.result as { lookups: number; notes: string[]; price_table: unknown[] };
    expect(result.lookups).toBe(210);
    expect(result.notes[0]).toMatch(/210 calls, 4200000 lovelace in 3 L1 transactions/);
    const reader = new CascadeClient(lucid, scripts, refs);
    const root = await reader.node(treeId);
    expect(root.datum.committed).toBe(0n);
    expect(root.datum.children_open).toBe(0n);
    // Unspent deposit came back up the tree: the only value that left is Pricer's fee plus the 210
    // redeemed calls; the rest of the deposit is held by the root again (ADR 1.5 accounting).
    const pricerFee = BigInt(built.plan.root.children[0]!.spec.price.max_fee);
    const deposit = BigInt(built.plan.root.children[0]!.children[0]!.spec.price.max_budget);
    const redeemed = 210n * METERED_PER_CALL_LOVELACE;
    expect(deposit).toBeGreaterThan(redeemed);
    expect(root.datum.spent).toBe(pricerFee + redeemed);
    // Exactly three L1 transactions touched the channel: the Draw that opened it, one batch redeem, the close.
    const l1 = (result.notes[0]?.match(/\(([0-9a-f, ]+)\)$/)?.[1] ?? "").split(", ");
    expect(l1).toHaveLength(3);
    expect(new Set(l1).size).toBe(3);
    // One batch redeem paid the provider every voucher at once.
    expect((await lucid.utxosAt(keys["lookup-api"].address)).some((u) => u.assets.lovelace === 210n * METERED_PER_CALL_LOVELACE)).toBe(true);
    expect((await lucid.utxosAt(keys["lookup-api"].address)).length).toBeGreaterThan(lookupBefore);
  });
  it("A5: buys one Lookup API call with an x402 default payment straight from the tree budget, PAYMENT-RESPONSE recorded", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    const draft = scenarioDraft("a5-address-payment", { lookupApi: keys["lookup-api"].paymentKeyHash });
    const built = demoPlan(draft.tasks.map((t) => (t.id === "lookup-pay" ? { ...t, budget_weight: 10 } : t)));
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, built.plan);
    const { outcome } = await runRoot(built, treeId, { test_scenario: "a5-address-payment", x402_query: { brand: "Sample Brand A" } });
    const pay = outcome.children.find((c) => c.spec_id === "lookup-pay");
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`A5 ${JSON.stringify(pay)}\n`);
    expect(pay?.status).toBe("accepted");
    if (pay?.status !== "accepted") return;
    const result = pay.result as { rows: unknown[]; payment_response: { success: boolean; transaction: string } };
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.payment_response).toMatchObject({ success: true, transaction: pay.hire.draw_tx_id });
    // The Lookup API's own address received the call price from the tree (no node: the payment is final).
    expect((await lucid.utxosAt(keys["lookup-api"].address)).some((u) => u.txHash === pay.hire.draw_tx_id)).toBe(true);
  });

  it("A1: a 3-level, 7-node tree where Scribe and Scout each sub-hire two agents; every node is accepted and settled", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    const built = demoPlan(scenarioDraft("a1-happy-path", { lookupApi: keys["lookup-api"].paymentKeyHash }).tasks, 80n);
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, built.plan);
    const { outcome } = await runRoot(built, treeId, { test_scenario: "a1-happy-path" });
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`A1 ${JSON.stringify(outcome.children.map((c) => ({ id: c.spec_id, status: c.status, actions: c.actions })))}\n`);
    expect(outcome.partial).toBe(false);
    expect(outcome.children.map((c) => [c.spec_id, c.status])).toEqual([
      ["brief", "accepted"],
      ["market", "accepted"],
    ]);
    // Every drawn node (2 children, 4 grandchildren) settled; the grandchildren were drawn by Scribe and Scout.
    await waitIndexed((await new CascadeClient(lucid, scripts, refs).node(treeId)).utxo.txHash);
    const { rows } = await db.pool.query<{ depth: number; state: string; operator_vkh: string; parent_id: string }>("SELECT depth, state, operator_vkh, parent_id FROM nodes WHERE tree_id = $1 AND node_id <> $1", [treeId]);
    expect(rows.map((r) => r.depth).sort()).toEqual([1, 1, 2, 2, 2, 2]);
    expect(rows.every((r) => r.state === "Settled")).toBe(true);
    const mids = new Map(rows.filter((r) => r.depth === 1).map((r) => [r.operator_vkh, r]));
    expect([...mids.keys()].sort()).toEqual([keys.scout.paymentKeyHash, keys.scribe.paymentKeyHash].sort());
    const root = await new CascadeClient(lucid, scripts, refs).node(treeId);
    expect(root.datum.state).toBe("Submitted");
    expect(root.datum.children_open).toBe(0n);
  });

  it("PRD 21.2 demo end to end: metered Pricer under Scout, 2-of-3 quorum, Flaky Lisan refunded and Lisan re-hired through P, Scribe, buyer Accept, CloseRoot, exact receipt", async () => {
    const t0 = Date.now();
    const at = (label: string) => process.stdout.write(`DEMO ${label} +${((Date.now() - t0) / 60_000).toFixed(1)} min\n`);
    const buyer = buyerParty();
    await topUp(buyer.address, 800);
    await sleep(3_000);
    const built = demoPlan(demoDraft().tasks, 150n, 3);
    const plan = built.plan;
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, plan);
    at("funded");
    const { outcome } = await runRoot(built, treeId);
    at("root submitted");
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`DEMO-OUTCOME ${JSON.stringify(outcome.children.map((c) => ({ id: c.spec_id, status: c.status, actions: c.actions })))}\n`);
    const byId = Object.fromEntries(outcome.children.map((c) => [c.spec_id, c]));
    expect(byId["scout"]?.status).toBe("accepted");
    expect(byId["scribe"]?.status).toBe("accepted");
    // Flaky Lisan missed submit_by and was refunded; its contingency, the Masumi seller, was paid through P.
    const translate = byId["translate-ar-masumi"];
    expect(translate?.status).toBe("accepted");
    if (translate?.status === "accepted") expect(translate.hire.masumi?.lock_tx).toMatch(/^[0-9a-f]{64}$/);
    const refunded = await db.pool.query<{ state: string }>("SELECT state FROM nodes WHERE tree_id = $1 AND parent_id = $1 AND state = 'Refunded'", [treeId]);
    expect(refunded.rows).toHaveLength(1);
    expect(outcome.partial).toBe(false);
    // Pricer's metered channel under Scout: 200+ calls.
    const scout = byId["scout"];
    if (scout?.status !== "accepted") throw new Error("scout not accepted");
    const priced = scout.result as { price_table: unknown[]; notes: string[] };
    expect(priced.price_table.length).toBeGreaterThan(0);

    // Buyer Accept, then CloseRoot.
    const acceptTx = await builder.treeAction(treeId, "Accept", treeId, await walletOf(buyer.address));
    await waitIndexed(await submitAs(buyer.privateKey, acceptTx.tx_cbor));
    at("buyer accepted");
    lucid.selectWallet.fromPrivateKey(buyer.privateKey);
    const close = await new CascadeClient(lucid, scripts, refs).closeRoot(treeId);
    const closeTx = await (await close.tx.sign.withWallet().complete()).submit();
    expect(await lucid.awaitTx(closeTx, 1_000)).toBe(true);
    await waitIndexed(closeTx);
    at("closed");

    // The receipt reconciles exactly (value and structural ADA) once the tree is closed.
    const tree = (await db.pool.query<{ asset: string; state: string }>("SELECT asset, state FROM trees WHERE tree_id = $1", [treeId])).rows[0];
    const events = await db.pool.query<{ tx_id: string; payload: { _flows?: { kind: string; node_id: string; to: string; asset: string; amount: string }[] } }>("SELECT tx_id, payload FROM node_events WHERE tree_id = $1 AND NOT rolled_back ORDER BY event_id", [treeId]);
    const flows = events.rows.flatMap((r) => (r.payload._flows ?? []).map((f) => ({ txId: r.tx_id, flow: { ...f, amount: BigInt(f.amount) } }) as FlowRecord));
    const { receipt, totals } = reconcile({ treeId, asset: tree?.asset ?? "lovelace", closed: tree?.state !== "open", flows });
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`DEMO-RECEIPT ${JSON.stringify({ ...receipt, lines: receipt.lines.length }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))} ${JSON.stringify(totals, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
    expect(receipt.balanced).toBe(true);
    expect(receipt.lines.some((l) => l.kind === "masumi")).toBe(true);
    const gateLogs = await db.pool.query("SELECT decision FROM gate_logs WHERE tree_id = $1 AND decision <> 'allow'", [treeId]);
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`DEMO-DENIALS ${gateLogs.rows.length}\n`);
  }, 3_600_000);

  it("A3 (ADR 8.1): pays a Masumi seller through the purchase wallet P; P's plain lock reproduces the seller's blockchainIdentifier", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    expect(loadMasumiScript(JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/sdk/vendor/masumi-payment-v2.plutus.json"), "utf8"))).hash).toBe(MASUMI_VESTED_PAY_V2_HASH);
    const built = demoPlan([
      { id: "translate-masumi", parent: "root", title: "Translate the summary into Arabic (Masumi agent)", category: "translation", rail: "masumi", output_fields: [{ name: "arabic_summary", type: "string", description: "Arabic" }], acceptance: "ParentAccept", effort_minutes: 2, may_sub_hire: false, budget_weight: 100, verifies: "", contingency_for: "", after: [] },
    ]);
    const spec = built.plan.root.children[0]!.spec;
    expect([spec.rail, spec.payee_hash, spec.masumi_followup]).toEqual(["address", PURCHASER.paymentKeyHash, { agent_identifier: SELLER_ID }]);
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, built.plan);
    const { outcome } = await runRoot(built, treeId);
    const slot = outcome.children[0];
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`A3 ${JSON.stringify(slot)}\n`);
    expect(slot?.status).toBe("accepted");
    if (slot?.status !== "accepted") return;
    expect(slot.result).toEqual({ arabic_summary: "ملخص تنفيذي" });
    const lock = slot.hire.masumi;
    if (lock === undefined) throw new Error("no Masumi lock recorded");
    // The lock P made: a plain key transaction, buyer = P, refunds to the tree's buyer_refund.
    const escrow = plutusAddressToBech32({ payment_credential: { type: "Script", hash: MASUMI_VESTED_PAY_V2_HASH }, stake_credential: null }, 0);
    const [out] = await lucid.utxosByOutRef([{ txHash: lock.lock_tx, outputIndex: 0 }]);
    expect(out?.address).toBe(escrow);
    const datum = decodeMasumiDatum(out?.datum ?? "");
    expect(datum.buyer.payment_credential).toEqual({ type: "VerificationKey", hash: PURCHASER.paymentKeyHash });
    expect(datum.seller.payment_credential).toEqual({ type: "VerificationKey", hash: sellerVkh });
    const cfg = await new CascadeClient(lucid, scripts, refs).config(treeId);
    expect(datum.buyer_return_address).toEqual(cfg.config.buyer_refund);
    // The tree paid exactly the lock value to P and drew no node.
    const root = await new CascadeClient(lucid, scripts, refs).node(treeId);
    expect(root.datum.spent).toBe(out?.assets.lovelace);
    expect(root.datum.children_open).toBe(0n);
  });

  it("A3 (ADR 8.1 4a): a payment P cannot lock goes back to buyer_refund, exactly, through the signer's fence", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    const built = demoPlan([
      { id: "translate-masumi-bad", parent: "root", title: "Translate (a Masumi seller whose terms P may not lock)", category: "translation", rail: "masumi", output_fields: [{ name: "arabic_summary", type: "string", description: "Arabic" }], acceptance: "ParentAccept", effort_minutes: 2, may_sub_hire: false, budget_weight: 100, verifies: "", contingency_for: "", after: [] },
    ]);
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, built.plan);
    const { outcome } = await runRoot(built, treeId);
    const slot = outcome.children[0];
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`A3-RETURN ${JSON.stringify(slot)}\n`);
    expect(slot?.status).toBe("partial");
    const note = slot?.actions.find((a) => a.includes("returning it to buyer_refund")) ?? "";
    const drawTx = /Masumi payment ([0-9a-f]{64})/.exec(note)?.[1];
    if (drawTx === undefined || lastChain === undefined) throw new Error(`no unlocked Masumi payment in ${JSON.stringify(slot?.actions)}`);
    // What the detached return workflow does after its wait: mark the slot failed, P returns the payment.
    const held = (await lucid.utxosAt(PURCHASER.address)).filter((u) => u.txHash === drawTx);
    expect(held).toHaveLength(1);
    const returned = await lastChain.returnToBuyer({ tree_id: treeId, draw_tx_id: drawTx, reason: "test: lock refused" });
    if (returned.tx_id === null) throw new Error("nothing was returned");
    const cfg = await new CascadeClient(lucid, scripts, refs).config(treeId);
    const buyerRefund = plutusAddressToBech32(cfg.config.buyer_refund, 0);
    const [out] = (await lucid.utxosByOutRef([{ txHash: returned.tx_id, outputIndex: 0 }, { txHash: returned.tx_id, outputIndex: 1 }])).filter((u) => u.address === buyerRefund);
    expect(out?.assets.lovelace).toBe(held[0]?.assets.lovelace);
    expect((await lucid.utxosAt(PURCHASER.address)).some((u) => u.txHash === drawTx)).toBe(false);
    // Idempotent: a second return finds nothing left with P.
    expect(await lastChain.returnToBuyer({ tree_id: treeId, draw_tx_id: drawTx, reason: "again" })).toEqual({ tx_id: null });
  });

  it("an agent that loses a paid job on restart: the orchestrator stops polling (job_not_found), refunds the child at its deadline and records it", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    const built = demoPlan([
      { id: "translate-ar", parent: "root", title: "Translate the summary into Arabic", category: "translation", rail: "native", output_fields: [{ name: "arabic_summary", type: "string", description: "Arabic" }], acceptance: "ParentAccept", effort_minutes: 1, may_sub_hire: false, budget_weight: 50, verifies: "", contingency_for: "", after: [] },
    ]);
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, built.plan);
    const running = runRoot(built, treeId);
    // Once Flaky Lisan holds the paid job, restart it: its in-memory store forgets the job.
    for (let i = 0; i < 120; i++) {
      if ((await agents.get("flaky-lisan")?.store.listByStatus(["running", "completed", "failed"]))?.length) break;
      await sleep(1_000);
    }
    await restartAgent("flaky-lisan");
    const { outcome } = await running;
    const slot = outcome.children[0];
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`LOST ${JSON.stringify(slot)}\n`);
    expect(slot?.status).toBe("partial");
    expect(slot?.actions).toEqual(expect.arrayContaining(["event job_lost", "event missed_submit_by", "action crank_refund"]));
    const refunded = await db.pool.query("SELECT 1 FROM nodes WHERE tree_id = $1 AND parent_id = $1 AND state = 'Refunded'", [treeId]);
    expect(refunded.rows).toHaveLength(1);
  });

  it("A8: a schema-failing result is challenged; the worker does not escalate; the challenge resolves for the parent after the window", async () => {
    const buyer = buyerParty();
    await topUp(buyer.address, 500);
    await sleep(3_000);
    const built = demoPlan(scenarioDraft("a8-schema-fail", { lookupApi: keys["lookup-api"].paymentKeyHash }).tasks);
    const builder = makeBuilder(buyer);
    const treeId = await fundTree(builder, buyer, built.plan);
    const { outcome } = await runRoot(built, treeId, { test_scenario: "a8-schema-fail" });
    const slot = outcome.children[0];
    if (process.env["E2E_LOG"] === "1") process.stdout.write(`A8 ${JSON.stringify(slot)}\n`);
    expect(slot?.status).toBe("partial");
    expect(slot?.actions).toEqual(expect.arrayContaining(["event schema_failed", "action challenge", "event challenge_unanswered"]));
    expect(slot?.actions).not.toContain("event challenge_rebutted");
    const root = await new CascadeClient(lucid, scripts, refs).node(treeId);
    expect(root.datum.committed).toBe(0n);
    expect(root.datum.spent).toBe(0n);
  });
});
