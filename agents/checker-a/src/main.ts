import { jobStoreFromEnv, chainWiringFromEnv, CHAIN_STATUS, llmFromEnv, PAYMENTS_STATUS, runtimeFor, serveAgent, signerForRole } from "@cascade/agent-kit";
import { createCheckerAAgent } from "./agent.js";

const base = runtimeFor("checker-a");
const { signer, source } = signerForRole("checker-a");
const chain = await chainWiringFromEnv("checker-a", signer.address);
const runtime = chain === null ? base : { ...base, network: chain.network };
// Jobs live in Postgres on preprod, so a restart never loses a paid job (it fails it, visibly).
const store = await jobStoreFromEnv("checker-a");
const agent = createCheckerAAgent({ ...(store === undefined ? {} : { store }), runtime, signer, llm: llmFromEnv(), ...(chain === null ? {} : { payments: chain.payments, onResult: chain.onResult }) });
await agent.recover();
serveAgent(agent, runtime, source, chain === null ? PAYMENTS_STATUS : CHAIN_STATUS);
