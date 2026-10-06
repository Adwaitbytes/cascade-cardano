import { jobStoreFromEnv, chainWiringFromEnv, CHAIN_STATUS, FLAKY_NOTICE, PAYMENTS_STATUS, runtimeFor, serveAgent, signerForRole } from "@cascade/agent-kit";
import { createFlakyLisanAgent } from "./agent.js";

const base = runtimeFor("flaky-lisan");
const { signer, source } = signerForRole("flaky-lisan");
const chain = await chainWiringFromEnv("flaky-lisan", signer.address);
const runtime = chain === null ? base : { ...base, network: chain.network };
// Jobs live in Postgres on preprod, so a restart never loses a paid job (it fails it, visibly).
const store = await jobStoreFromEnv("flaky-lisan");
const agent = createFlakyLisanAgent({ ...(store === undefined ? {} : { store }), runtime, signer, ...(chain === null ? {} : { payments: chain.payments }) });
await agent.recover();
serveAgent(agent, runtime, source, `${FLAKY_NOTICE} ${chain === null ? PAYMENTS_STATUS : CHAIN_STATUS}`);
