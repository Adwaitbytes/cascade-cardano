import { jobStoreFromEnv, chainWiringFromEnv, CHAIN_STATUS, llmFromEnv, PAYMENTS_STATUS, runtimeFor, serveAgent, signerForRole, subtreeRunnerFromEnv } from "@cascade/agent-kit";
import { createScoutAgent } from "./agent.js";

const base = runtimeFor("scout");
const { signer, source } = signerForRole("scout");
const llm = llmFromEnv();
const chain = await chainWiringFromEnv("scout", signer.address);
const runtime = chain === null ? base : { ...base, network: chain.network };
// Sub-hiring (Pricer in the demo plan) through the orchestrator library, signed as Scout.
const subtree = await subtreeRunnerFromEnv("scout", signer.address, llm, (e) => process.stderr.write(`subtree worker: ${e instanceof Error ? e.message : String(e)}\n`));
// Jobs live in Postgres on preprod, so a restart never loses a paid job (it fails it, visibly).
const store = await jobStoreFromEnv("scout");
const agent = createScoutAgent({
  ...(store === undefined ? {} : { store }),
  runtime,
  signer,
  llm,
  ...(chain === null ? {} : { payments: chain.payments, onResult: chain.onResult, onChallenge: chain.onChallenge }),
  ...(subtree === null ? {} : { subtree: subtree.run }),
});
await agent.recover();
serveAgent(agent, runtime, source, chain === null ? PAYMENTS_STATUS : CHAIN_STATUS);
