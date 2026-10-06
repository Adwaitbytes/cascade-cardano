# THIRD_PARTY

| Repository | Commit | Licence | What we use | Where |
| --- | --- | --- | --- | --- |
| https://github.com/Anastasia-Labs/lucid-evolution | npm `@lucid-evolution/lucid` 0.6.5 | MIT | Plutus Data `Data`/`Constr`, CBOR, CML output sizing, address helpers; tx building, providers (Kupmios, Blockfrost) | packages/shared, packages/sdk |
| https://github.com/colinhacks/zod | npm `zod` 4.6.5 | MIT | Runtime schemas for datums, plans, quotes, verdicts, events, blueprint | packages/shared, packages/sdk |
| https://github.com/paulmillr/noble-hashes | npm `@noble/hashes` 2.4.0 | MIT | Blake2b-224, Blake2b-256, SHA-256 | packages/shared |
| https://github.com/paulmillr/noble-curves | npm `@noble/curves` 2.4.0 | MIT | Ed25519 sign and verify for CIP-8 COSE | packages/shared |
| https://github.com/paulmillr/scure-base | npm `@scure/base` 2.4.0 | MIT | Bech32 address encoding and decoding | packages/shared |
| https://github.com/erdtman/canonicalize | npm `canonicalize` 5.1.0 | Apache-2.0 | RFC 8785 JSON canonicalization | packages/shared |
| https://github.com/kriszyp/cbor-x | npm `cbor-x` 1.6.6 | MIT | CBOR for COSE_Sign1 and COSE_Key | packages/shared |
| https://github.com/APIDevTools/swagger-parser | npm `@apidevtools/swagger-parser` 13.1.0 (dev) | MIT | OpenAPI 3.1 validation in tests | packages/shared |
| motdotla/dotenv (npm dotenv) | 18.0.5 | BSD-2-Clause | Load `.env` in scripts and services | scripts/lib/env.ts |
| bloxbean/yaci-devkit (Docker image) | v0.12.0-beta5 | MIT | Local devnet with Ogmios, Kupo, Yaci Store | infra/docker-compose.local.yml |
| temporalio/cli (Docker image, dev server) | pinned in compose | MIT | Local Temporal | infra/docker-compose.local.yml |
| cgr.dev/chainguard/minio (Docker image) | pinned by digest | AGPL-3.0 (MinIO server, run as a separate service, not vendored) | Local S3-compatible artefact store | infra/docker-compose.local.yml |
| postgres (Docker image) | 16 | PostgreSQL License | Local database | infra/docker-compose.local.yml |
| https://github.com/vercel/next.js | npm `next` 16.3.8 | MIT | App Router web apps | apps/web |
| https://github.com/xyflow/xyflow | npm `@xyflow/react` | MIT | Tree Explorer canvas | apps/web |
| https://github.com/dagrejs/dagre | npm `@dagrejs/dagre` | MIT | Tree layout | apps/web |
| https://github.com/d3/d3-sankey | npm `d3-sankey` | BSD-3-Clause | Money flow view | apps/web |
| https://github.com/TanStack/query | npm `@tanstack/react-query` | MIT | Data cache | apps/web |
| https://github.com/MeshJS/mesh | npm `@meshsdk/core` 1.9.1 | Apache-2.0 | CIP-30 wallet connect and signing | apps/web |
| https://github.com/radix-ui/primitives | npm `radix-ui` | MIT | Accessible UI primitives (shadcn/ui base) | apps/web |
| https://github.com/lucide-icons/lucide | npm `lucide-react` | ISC | Icons | apps/web |
| https://github.com/fontsource/fontsource | npm `@fontsource-variable/inter` 5.3.0, `@fontsource/dm-mono` 5.3.0 | OFL-1.1 | Self-hosted fonts (body, mono) | apps/web |
| https://github.com/vercel/geist-font | npm `geist` 1.7.2 (`geist/font/pixel`, Geist Pixel Square) | OFL-1.1 | Self-hosted display face for headings | apps/web |
| https://github.com/tailwindlabs/tailwindcss | npm `tailwindcss` | MIT | Styling | apps/web |
| https://github.com/honojs/hono | npm `hono` 4.13.12 | MIT | HTTP servers for agents and services | packages/agent, services |
| https://github.com/brianc/node-postgres | npm `pg` 8.23.1 | MIT | Postgres driver | services |
| https://github.com/masumi-network/masumi-payment-service | upstream main `69297f30` (built from source) | MIT | Masumi Payment Service instances | infra/masumi |
| https://github.com/masumi-network/crewai-masumi-quickstart-template | `0d13f37` (fetched, unmodified, verified by agents/lisan-masumi/verify.sh) | see upstream LICENSE | Lisan, the unmodified Masumi agent | agents/lisan-masumi |
| https://github.com/temporalio/sdk-typescript | npm `@temporalio/*` 1.24.0 | MIT | Durable orchestrator workflows | packages/orchestrator |
| https://github.com/ajv-validator/ajv | npm `ajv` | MIT | L0 JSON Schema verification of results | packages/agent, packages/orchestrator |
| https://github.com/agronholm/cbor2 | pip `cbor2` | MIT | CBOR for COSE in cascade-py | python/cascade-py |
| https://github.com/trailofbits/rfc8785.py | pip `rfc8785` | Apache-2.0 | JCS canonicalization in cascade-py | python/cascade-py |
| https://github.com/pyca/cryptography | pip `cryptography` | Apache-2.0 OR BSD-3-Clause | Ed25519 in cascade-py | python/cascade-py |
| https://github.com/cedar-policy/cedar | npm `@cedar-policy/cedar-wasm` 4.13.0 | Apache-2.0 | Signer policy engine (eight gates) | packages/policy, services/signer |
| https://github.com/x402-foundation/x402 | npm `@x402/core`, `@x402/cardano` 2.28.0 | Apache-2.0 | x402 types, Masumi verification helpers | services/facilitator |
| https://github.com/pinojs/pino | npm `pino` 10.3.1 | MIT | Structured JSON logs with redaction | services |
| https://github.com/honojs/node-server | npm `@hono/node-server` 2.1.3 | MIT | Node HTTP adapter | services |
| https://github.com/websockets/ws | npm `ws` 8.22.0 | MIT | Indexer WebSocket feed | services/indexer |
| https://github.com/open-telemetry/opentelemetry-js | npm api 1.9.1; sdk-trace-base, sdk-trace-node, resources 2.11.0; exporter-trace-otlp-http 0.222.0 | Apache-2.0 | Traces keyed by tree_id and node_id | services |
| https://github.com/masumi-network/masumi-payment-service | d74b2c319228bcbef36632de37875c388dcee7ce (`smart-contracts/payment-v2/plutus.json`, vendored unmodified) | Apache-2.0 | Masumi `vested_pay` V2 validator, applied with the canonical parameters (2 of 3 admins, 420000 ms cooldown; hash a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad) for Masumi receipt locks and WithdrawRefund on Yaci | packages/sdk/vendor/masumi-payment-v2.plutus.json |
| https://github.com/scanny/python-pptx | pip `python-pptx` 1.0.2 | MIT | Deck builder with embedded video | demo/deck.py |
| https://github.com/microsoft/playwright | npm `@playwright/test` 1.63.0 | Apache-2.0 | Demo recording, e2e tests | demo, tests/e2e, apps/web/e2e |
| https://github.com/paulmillr/noble-curves, noble-hashes, scure-base | `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0, `@scure/base` 2.4.0 (direct deps of the web app too) | MIT | Receipt signing in the web read path without Lucid | apps/web |
