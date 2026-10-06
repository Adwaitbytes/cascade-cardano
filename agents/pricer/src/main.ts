import { CascadeClient } from "@cascade/sdk";
import { jobStoreFromEnv, chainContextFromEnv, chainWiringFromEnv, CHAIN_STATUS, meteredPlanResolver, PAYMENTS_STATUS, runtimeFor, serveAgent, signerForRole, VoucherChannel } from "@cascade/agent-kit";
import { METERED_PER_CALL_LOVELACE } from "@cascade/agent-lookup-api";
import { createPricerAgent, type MeteredLookups } from "./agent.js";

const base = runtimeFor("pricer");
const { signer, source } = signerForRole("pricer");
const chain = await chainWiringFromEnv("pricer", signer.address);
const ctx = await chainContextFromEnv();
const runtime = chain === null ? base : { ...base, network: chain.network };
// Metered rail (PRD 8.6): a voucher channel to the Lookup API, opened under Pricer's own node.
const lookupApi = runtimeFor("lookup-api");
const metered: MeteredLookups | undefined =
  ctx === null
    ? undefined
    : {
        planFor: meteredPlanResolver(new CascadeClient(ctx.lucid, ctx.scripts, ctx.refs)),
        open: (p) => VoucherChannel.open({ lucid: ctx.lucid, scripts: ctx.scripts, refs: ctx.refs, signer: ctx.signer, role: "pricer", payerAddress: signer.address }, { ...p, providerAddress: lookupApiAddress() }),
        lookupBaseUrl: lookupApi.baseUrl,
        perCall: METERED_PER_CALL_LOVELACE,
      };
// Jobs live in Postgres on preprod, so a restart never loses a paid job (it fails it, visibly).
const store = await jobStoreFromEnv("pricer");
const agent = createPricerAgent({ ...(store === undefined ? {} : { store }), runtime, signer, ...(chain === null ? {} : { payments: chain.payments, onResult: chain.onResult, onChallenge: chain.onChallenge }), ...(metered === undefined ? {} : { metered }) });
await agent.recover();
serveAgent(agent, runtime, source, chain === null ? PAYMENTS_STATUS : `${CHAIN_STATUS}; Lookup API calls paid with metered vouchers`);

function lookupApiAddress(): string {
  const address = process.env["CASCADE_LOOKUP_API_ADDRESS"];
  if (address !== undefined && address !== "") return address;
  return signerForRole("lookup-api").signer.address;
}
