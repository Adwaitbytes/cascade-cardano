# Preprod deployment

Preprod hosting is split (DECISIONS.md, "Preprod hosting"):

- **Web (public):** `apps/web` on Vercel, project `cascade` (account adwaitpro). It reads the
  operator's Neon Postgres through Next.js server routes under `/api/v1/*`, which mirror the
  indexer REST API.
- **Services (operator machine):** indexer, facilitator, watchtower, signer, orchestrator, reference
  agents and the two Masumi Payment Service instances. They write to the same Neon database.

## Vercel project

| Setting | Value |
| --- | --- |
| Linked from | repo root (`.vercel/`, git-ignored) |
| Root directory | `apps/web` |
| Framework | Next.js, Node 24.x |
| Function region | `sin1` (project setting `serverlessFunctionRegion`, next to Neon `ap-southeast-1`). `apps/web/vercel.json` is not read because deploys run from the repo root, so the region is set on the project: `vercel api /v9/projects/<id> -X PATCH` with `{"serverlessFunctionRegion":"sin1"}` |
| Install | `cd ../.. && pnpm install --frozen-lockfile` (pnpm 12 through corepack, `ENABLE_EXPERIMENTAL_COREPACK=1`) |
| Build | `cd ../.. && pnpm exec turbo run build --filter=@cascade/web...` (builds workspace dependencies first) |

## Environment (production)

Set with `npx tsx scripts/vercel-env.ts`. Values go to `vercel env add` on stdin, never on the
command line and never printed.

| Variable | Source | Kind |
| --- | --- | --- |
| `DATABASE_URL` | `.env` `DATABASE_URL_PREPROD` (Neon) | secret |
| `CASCADE_ORACLE_SKEY` | payment key of the oracle account (index 15) only, derived from `CASCADE_TREASURY_MNEMONIC`; signs receipts | secret |
| `BLOCKFROST_PROJECT_ID_PREPROD` | `.env` | secret |
| `CASCADE_NETWORK` | `preprod` | config |
| `NEXT_PUBLIC_CASCADE_NETWORK` | `preprod` | config |
| `NEXT_PUBLIC_CARDANOSCAN_URL` | `https://preprod.cardanoscan.io` | config |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | config |

The web host gets only the oracle account's key. A leak of the Vercel environment exposes that
account (about 100 tADA), never the treasury.

## Deploy

```bash
npx tsx scripts/web-deploy.ts          # production deploy of HEAD, records urls in deployments/preprod.json, checks 200
npx tsx scripts/web-deploy.ts --check  # re-check the recorded urls
```

`vercel deploy` uploads the working tree, which in this repo holds other agents' uncommitted files.
The script therefore deploys a clean `git worktree` of `HEAD`, so production is always exactly one
commit (recorded as `urls.commit`).

`deployments/preprod.json` `urls`: `origin`, `console`, `explorer_demo_tree` (set once a real tree
exists), `receipt`, `directory_api`, `deployment`, `commit`.

## Masumi Payment Services

See `infra/README.md` (Masumi section). Hot wallets are funded with `npx tsx scripts/fund-masumi.ts`;
tx hashes are in `deployments/funding.preprod.json`.

## Public agent URLs

`npx tsx scripts/agents-gateway.ts [--port 24100] [--local]` runs one reverse proxy that routes
`/<agent>/<path>` to the agent's local port (prefix stripped), so one domain serves all nine agents and
each registry `api_base_url` is `https://<domain>/<agent>`.

- With `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` in `.env`, it runs `ngrok http --url=$NGROK_DOMAIN <port>`
  (the token reaches ngrok through its environment, not argv). The domain is stable across restarts.
- Otherwise it opens one Cloudflare quick tunnel to the gateway. That URL changes on restart (BLOCKERS B5).
- Live URLs and availability go to the git-ignored `deployments/agents.preprod.runtime.json` every 60 s.
  The committed `deployments/agents.preprod.json` holds registry facts only.
- `scripts/register-agents.ts` registers agents at the runtime URLs. A changed URL is re-registered only
  with `--update-urls`, because the V2 registry burns and re-mints the NFT (new agent id).
- `scripts/run-preprod-agents.sh` starts the agents with their public base URLs from the runtime file.

The first registration round used one quick tunnel per agent; those tunnels still run as orphaned
`cloudflared` processes so the registered URLs keep answering until the switch to the gateway domain.

## Preprod database

`npx tsx scripts/migrate-preprod.ts` applies the `services/kit` migrations to Neon
(`DATABASE_URL_PREPROD`). Run it after any commit that adds a migration; the web `/api/v1` routes fail
with `relation ... does not exist` until it has run.
