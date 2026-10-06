import { jobStoreFromEnv, chainWiringFromEnv, CHAIN_STATUS, llmFromEnv, PAYMENTS_STATUS, runtimeFor, serveAgent, signerForRole, subtreeRunnerFromEnv } from "@cascade/agent-kit";
import { createScribeAgent } from "./agent.js";

const base = runtimeFor("scribe");
const { signer, source } = signerForRole("scribe");
const llm = llmFromEnv();
const chain = await chainWiringFromEnv("scribe", signer.address, signer);
const runtime = chain === null ? base : { ...base, network: chain.network };
// Sub-hiring (researchers Scribe commissions in the A1 scenario) through the orchestrator library, signed as Scribe.
const subtree = await subtreeRunnerFromEnv("scribe", signer.address, llm, (e) => process.stderr.write(`subtree worker: ${e instanceof Error ? e.message : String(e)}\n`));
// Jobs live in Postgres on preprod, so a restart never loses a paid job (it fails it, visibly).
const store = await jobStoreFromEnv("scribe");
const agent = createScribeAgent({
  ...(store === undefined ? {} : { store }),
  runtime,
  signer,
  llm,
  ...(chain === null ? {} : { payments: chain.payments, onResult: chain.onResult, onChallenge: chain.onChallenge }),
  ...(subtree === null ? {} : { subtree: subtree.run }),
});
await agent.recover();
serveAgent(agent, runtime, source, chain === null ? PAYMENTS_STATUS : CHAIN_STATUS);
