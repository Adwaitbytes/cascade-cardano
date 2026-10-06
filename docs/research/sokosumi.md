# Sokosumi (digest)

## Sources

| Source | Pin |
|---|---|
| `https://docs.sokosumi.com` | **DNS does not resolve** (`getaddrinfo ENOTFOUND`, 2026-10-01). The docs are served at `https://www.masumi.network/dev/sokosumi` (307 → `/dev/sokosumi/documentation`). |
| `masumi-network/sokosumi-docs` (docs source: `content/docs/{documentation/index.mdx, api-reference/index.mdx, mcp/index.mdx}`) | commit `454751d279ca343b2e2b88d538a9f79dccd89131` |
| `masumi-network/masumi-docs` `content/docs/documentation/how-to-guides/list-agent-on-sokosumi.mdx`, `documentation/get-started/register-agent.mdx` | commit `020c3b47153bc110b9d1c6f60cf957aadac25c8c` |
| `masumi-network/sokosumi` (the marketplace app: `apps/core/src/services/agent-sync.service.ts`, `apps/core/src/config/env.ts`, `apps/core/.env.example`, `packages/masumi/src/clients/masumi-registry.client.ts`) | commit `6f7e7c98593cf7617637d3dca8b73121fad2ad22` |
| `masumi-network/Sokosumi-MCP` | commit `6b710a0f5aa34dbd18275091c082ac15f5255bda` |
| Live: `GET https://api.sokosumi.com/v1/agents?status=VERIFIED&limit=1` (200, JSON) and `GET https://api.preprod.sokosumi.com/v1/agents?limit=1` (200) | 2026-10-01 |

## How an agent gets listed

The mechanism, from the app source (`agent-sync.service.ts`), works like this:

1. Sokosumi does **not** take listings directly on-chain.
2. It polls the **Masumi Registry Service** with `POST /registry-diff` (`getAgentsDiff(statusUpdatedAfter, cursorId, limit)`) for one `network` (`"Preprod"` or `"Mainnet"`).
   - The default registry is `REGISTRY_API_URL="https://registry.masumi.network/api/v1"`, with `REGISTRY_API_KEY` (`apps/core/.env.example`).
3. Each new registry identity becomes a new `Agent` row with `isShown: getEnv().SHOW_AGENTS_BY_DEFAULT`.
   - In `env.ts`, `SHOW_AGENTS_BY_DEFAULT` defaults to `"false"`. `.env.example` sets it to `"true"`.
   - The live preprod and mainnet values are **not visible in source**.
4. Re-registrations are treated as **new** agents. From the code comment: "an admin re-reviews a re-registered agent".
5. A promoted endpoint move sets `isShown: false`, and "an admin re-publishes after review".

The documented process (`masumi-docs`):

**Requirements** (`list-agent-on-sokosumi.mdx`):

- "Working agent registered on Masumi Network"
- "MIP-003 compliant API"
- "Sokosumi agents must settle transactions in the USDM stablecoin on their target network."

The payment unit (`PAYMENT_UNIT` / pricing asset) is `policyId+assetName`, with 6 decimals:

| Network | Token | Unit |
|---|---|---|
| Preprod | tUSDM | `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d` |
| Mainnet | USDM | `c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d` |

**Preprod** (`register-agent.mdx`, "Sokosumi Visibility"): "If all is done correctly and you used USDM on Preprod, your agent will automatically appear in the Sokosumi preprod gallery: https://preprod.sokosumi.com/agents".

**Mainnet**: "on mainnet, Sokosumi requires team approval through a whitelisting form". The form is `https://tally.so/r/nPLBaV` ("Submit to Sokosumi →").

The `sokosumi-docs` "List Your Agent" steps give a different flow:

1. Build.
2. Deploy.
3. "Register on Sokosumi: Sign up at app.sokosumi.com; Add your agent's endpoint, description, and pricing; Define input schemas and access policies".
4. Integrate the Masumi Protocol.
5. Go live.

This conflicts with the registry-sync mechanism in the app source. The source and the masumi-docs agree that listing comes from Masumi registry entries plus review. No self-serve "add agent" API was found (see the API section).

### Does listing need a human account or approval?

- **Preprod:** per the docs it is automatic once the agent is registered on the Masumi registry with tUSDM pricing, with no Sokosumi account needed to be listed. The code makes visibility depend on the deployment's `SHOW_AGENTS_BY_DEFAULT`, which cannot be verified from source. **Treat automatic preprod visibility as documented but unverified.**
- **Mainnet:** human approval is required. The Tally whitelisting form is submitted by a human, and the Sokosumi team approves.
- **Using** Sokosumi (hiring agents, the API, MCP) needs a Sokosumi account. Jobs consume Sokosumi **credits** (subscription or extra credits). For preprod testing the docs say: "Use the Stripe test card `4242 4242 4242 4242`".

## Sokosumi API

- Base URLs: `https://api.sokosumi.com` (mainnet) and `https://api.preprod.sokosumi.com` (preprod, used by Sokosumi-MCP `server.py` and `oauth.py`).
- Auth: `Authorization: Bearer <API key>`. Keys are generated at `https://app.sokosumi.com/connections` (the MCP docs also say `app.sokosumi.com/account → API Keys`).
- **Public, no-auth, rate-limited** endpoints:
  - `GET /v1/agents`, with `status` = `PENDING` \| `VERIFIED` \| `REVOKED` \| `EXPIRED` (default `VERIFIED`), `category` (repeatable; `uncategorized`), `page`, `limit`. Verified live: it returns `{data:[{id, name, image, icon, credits, summary, description, …}]}`.
  - `GET /v1/agents/{id}`.
  - `GET /v1/openapi`.
- The API reference sections are agents, jobs, tasks, projects, coworkers, conversations, chat, organizations, users, categories, credit-costs, and share. **None of them documents an endpoint for registering or listing an agent.**

## Sokosumi MCP

- Hosted server: `https://mcp.sokosumi.com/mcp`. It uses OAuth sign-in with a Sokosumi account, and no API key is copied into the client.
- Local: `git clone https://github.com/masumi-network/Sokosumi-MCP`, then `pip install -r requirements.txt`. Set `SOKOSUMI_API_KEY` and `SOKOSUMI_NETWORK=mainnet|preprod`, and run `python server.py`.
- Claude Code plugin:

  ```
  /plugin marketplace add masumi-network/Sokosumi-MCP
  /plugin install sokosumi@sokosumi
  ```

  It provides the skills `/sokosumi:hannah`, `:elena`, `:research`, `:market`, and `:watch`.
- Tools include `list_agents()`, `get_agent(agent_id)`, job creation and status, tasks, and coworkers. They are consumer-side (hiring agents), not for listing.
