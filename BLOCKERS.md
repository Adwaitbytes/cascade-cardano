# BLOCKERS

Append only. Format: id, what is blocked, exact human action needed, workaround applied, last retry.

## B1 Preprod test ADA for the treasury
- Blocked: every preprod transaction (Wave 4 onward, acceptance A1 to A20 on preprod).
- Human action: open https://docs.cardano.org/cardano-testnets/tools/faucet, pick Preprod, paste the treasury address `addr_test1qqcqa99kakye65dlf46fuuqe9klfjx49356ll3ptq93psddm96ck0jea0e5wleqm8afe6j9eu89yp7xr26gxg4pdurhsnamdsz`, solve the captcha, request 10,000 tADA. Repeat daily if acceptance runs drain it.
- Workaround applied: no `CASCADE_TREASURY_MNEMONIC` was provided, so the build generated a fresh preprod-only mnemonic into the git-ignored `.env` (never printed). All development runs on local Yaci DevKit until the address holds funds. The faucet has a captcha, which the agent will not bypass. A browser attempt at 2026-10-01 got no response from Chrome.
- Last retry: 2026-10-01

## B2 ANTHROPIC_API_KEY missing
- Blocked: real LLM calls in the planner, reference agents and Checker A (PRD 10, 21.1).
- Human action: add `ANTHROPIC_API_KEY=...` to `.env`. Optionally add `SECOND_LLM_API_KEY` for Checker B.
- Workaround applied: agents call the Anthropic Messages API when the key exists. Without it they use a deterministic fallback that is labelled "deterministic fallback, no LLM" in results, UI and evidence (MASTER_PROMPT 11). Chain behaviour is identical either way.
- Last retry: 2026-10-01

## B3 BLOCKFROST_PROJECT_ID_PREPROD missing
- Blocked: Blockfrost as the second provider (PRD 16.2 T17).
- Human action: create a free preprod project at https://blockfrost.io and add `BLOCKFROST_PROJECT_ID_PREPROD` to `.env`.
- Workaround applied: preprod chain access uses Koios (https://preprod.koios.rest, free, no key) for queries, evaluation and submission. The second-provider cross-check uses Koios against the indexer until a Blockfrost key exists.
- Last retry: 2026-10-01

## B4 GIT_REMOTE_URL and GITHUB_TOKEN missing
- Blocked: nothing.
- Human action: none required. Run `gh repo edit Adwaitbytes/cascade --visibility public` before submission if judges need public access.
- Workaround applied: `gh` is authenticated on this machine, so the build created the private repo https://github.com/Adwaitbytes/cascade and pushes there.
- Last retry: 2026-10-01

## B3 update (2026-10-01)
- The Masumi Payment Service and Registry Service support only Blockfrost as chain provider (docs/research/masumi-payment-service.md section 6). A3 and A4 on preprod need `BLOCKFROST_PROJECT_ID_PREPROD` (free account at blockfrost.io, create a Preprod project, copy its project id into `.env`).
- Workaround while missing: Cascade reads the registry through Koios and can mint V2 registry entries directly with the funded treasury (the registry policy lets any wallet mint). The Lisan leaf still needs a running payment service to submit its result, so A3 and A4 stay blocked on this key.

## Resolved (2026-10-01)
- B1 resolved: the operator funded the treasury from the faucet (tx 99b6e524e77c7a6b45bc827cf63fa1b9b8cdd8ab3c48cc2423cf19f8437ff2b3). Koios shows 10,000 tADA.
- B3 resolved: Blockfrost preprod project `cascade-preprod` created in the operator's workspace; key stored in `.env` as `BLOCKFROST_PROJECT_ID_PREPROD` and verified against /blocks/latest.
- B2 partly resolved: no Anthropic key, but the operator provided an OpenRouter key (`OPENROUTER_API_KEY`, 3 USD credit cap). All product LLM calls go through OpenRouter with low-cost models and a hard spend guard.
- Hosted Postgres: operator provided a Neon database (`DATABASE_URL_PREPROD` in `.env`) for the preprod indexer and facilitator store.

## B5 Public agent URLs are ephemeral (Cloudflare quick tunnels)
- Blocked: stable public `api_base_url` values for the preprod agents in the Masumi registry.
- Why: no `DEPLOY_HOST` or tunnel account was provided. `cloudflared tunnel --url` quick tunnels need no account but give a random `*.trycloudflare.com` URL that changes every time `scripts/agents-tunnel.ts` restarts, and they carry no uptime guarantee.
- Human action for a stable URL: create a free Cloudflare account, add a domain, run `cloudflared tunnel login`, create a named tunnel with one hostname per agent port (24001 to 24009), and put the hostnames in `deployments/agents.preprod.json`. Or provide a host (`DEPLOY_HOST`) that serves the agents behind HTTPS.
- Workaround applied: `scripts/agents-tunnel.ts` starts one quick tunnel per agent and records the URLs. After any tunnel restart, run `scripts/register-agents.ts`, which updates each registry entry through the payment service `POST /registry/update` (the V2 contract burns the old NFT and mints a new one, so the agent id changes and `.env` is rewritten), then restart the agents with `scripts/run-preprod-agents.sh`.
- Last retry: 2026-10-01

## B5 update (lead, 2026-10-01): stable public URL for agents
- Blocked: stable `api_base_url` for the nine registered agents. Quick tunnels change URL on restart, forcing re-registration with new registry asset ids (fragile for A3 and the demo).
- Human action: create a free account at https://ngrok.com, then (1) copy the authtoken from https://dashboard.ngrok.com/get-started/your-authtoken, (2) claim the free static domain at https://dashboard.ngrok.com/domains. Add `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` to `.env` (or paste them to the agent).
- Workaround applied: Cloudflare quick tunnels plus re-registration on URL change. `scripts/agents-gateway.ts` (one reverse proxy, `/<agent>/*` per agent) is ready: once `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` are set it serves all nine agents on the static domain, and one `register-agents.ts --update-urls` run moves the registry to `https://<domain>/<agent>`. Re-registration is on hold until then.
- Last retry: 2026-10-01
- B5 resolved (2026-10-01): operator provided an ngrok account; `NGROK_AUTHTOKEN` and the free static dev domain `caenogenetic-varnishy-shaunte.ngrok-free.dev` are in `.env`; ngrok installed. All agents move behind one gateway on that domain.
- Resolved: ngrok static domain `caenogenetic-varnishy-shaunte.ngrok-free.dev` behind `scripts/agents-gateway.ts`; all ten agents re-registered once at `https://<domain>/<agent>` and answer `/availability` with 200. Quick tunnels removed.

## B6 Masumi Payment Service ignores script-created locks (2026-10-02)
- Blocked: the trustless MasumiReceipt Draw path (ADR 8) for unmodified Masumi sellers.
- Cause: upstream masumi-payment-service `extractOnChainTransactionData` treats any lock transaction with redeemers as Invalid.
- Human action (optional): report upstream to masumi-network/masumi-payment-service (an issue proposing to accept locks whose transaction has redeemers but no inputs from the contract address). The agent will not open public issues without the operator's approval.
- Workaround applied: ADR 0001 section 8.1 purchase-wallet path, no contract change.

## B7 Vercel CLI cannot reach the team that owns the `cascade` project (2026-10-02)
The CLI is logged in as `adwaitbytes-projects`; `.vercel/project.json` points to another team. Workaround: production keeps serving the previous deploy (all recorded URLs 200); the demo recording runs against a local `next start` of HEAD. Fix: operator runs `vercel login` with the owning account, then `npx tsx scripts/web-deploy.ts`. Retrying each wave.
Resolved 2026-10-02: operator logged in to the owning account; b18fe37 deployed, all URLs 200.
