import { HttpFacilitatorVerifier } from "@cascade/agent";
import { jobStoreFromEnv, chainContextFromEnv, CHAIN_STATUS, PAYMENTS_STATUS, privateKeyTxSigner, providerChannelOps, roleWalletPrivateKey, runtimeFor, serveAgent, signerForRole } from "@cascade/agent-kit";
import { createLookupApiAgent } from "./agent.js";

const base = runtimeFor("lookup-api");
const { signer, source } = signerForRole("lookup-api");
const ctx = await chainContextFromEnv();
const runtime = ctx === null ? base : { ...base, network: ctx.network };
// Jobs live in Postgres on preprod, so a restart never loses a paid job (it fails it, visibly).
const store = await jobStoreFromEnv("lookup-api");
const agent = createLookupApiAgent({
  ...(store === undefined ? {} : { store }),
  runtime,
  signer,
  onError: (where, e) => process.stderr.write(`${where}: ${e instanceof Error ? e.message : String(e)}\n`),
  ...(ctx === null
    ? {}
    : {
        verifier: new HttpFacilitatorVerifier(ctx.facilitatorUrl),
        // Third-party provider: its channel redeem is signed with its own wallet key, held only in this process.
        channels: providerChannelOps({
          lucid: ctx.lucid,
          scripts: ctx.scripts,
          refs: ctx.refs,
          signer: ctx.signer,
          role: "lookup-api",
          providerAddress: signer.address,
          redeemSigner: privateKeyTxSigner(ctx.lucid, roleWalletPrivateKey("lookup-api")),
        }),
      }),
});
await agent.recover();
serveAgent(agent, runtime, source, ctx === null ? PAYMENTS_STATUS : `${CHAIN_STATUS}; per-call x402 default payments and metered vouchers`);
