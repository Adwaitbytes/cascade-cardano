# Masumi Payment Service built from a pinned upstream commit.
#
# Why not the published ghcr.io/masumi-network/masumi-payment-service:0.28.0 image:
#  1. Its final stage omits the workspace `packages/` directory, so `prisma:seed`
#     (run from source through tsx) fails with ERR_MODULE_NOT_FOUND for
#     @masumi/payment-core.
#  2. With those sources added back, 0.28.0's V2 seed derives the escrow address
#     addr_test1wzvs5jcp22t0lp2uvqvvkg6ehlkdxj883qke8qe7jfws8ggzsyeqe and aborts,
#     because its own config expects the live preprod V2 address
#     addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g.
# The pinned commit (main, 2026-09-26, Aiken v1.1.23 contracts) derives the live
# address; it is the commit documented in docs/research/masumi-payment-service.md.
# Stages mirror upstream's Dockerfile, plus `packages/` in the runner stage.

FROM alpine/git:2.49.1 AS source
ARG MASUMI_COMMIT=69297f308f603bffbdfd4efccb54398eaff1bd87
RUN git init -q /src && cd /src \
 && git remote add origin https://github.com/masumi-network/masumi-payment-service \
 && git fetch -q --depth 1 origin "${MASUMI_COMMIT}" \
 && git checkout -q FETCH_HEAD

FROM node:20-slim AS backend-builder
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm
WORKDIR /usr/src/app
COPY --from=source /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml ./
COPY --from=source /src/patches ./patches
COPY --from=source /src/smart-contracts ./smart-contracts
COPY --from=source /src/packages ./packages
COPY --from=source /src/src ./src
COPY --from=source /src/prisma ./prisma
COPY --from=source /src/public ./public
COPY --from=source /src/tsconfig.json /src/eslint.config.mjs ./
COPY --from=source /src/frontend/package.json ./frontend/
RUN pnpm install --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build
RUN pnpm run swagger-json

FROM node:20-slim AS frontend-builder
RUN npm install -g pnpm
WORKDIR /usr/src/app
COPY --from=source /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=source /src/patches ./patches
COPY --from=source /src/packages ./packages
COPY --from=backend-builder /usr/src/app/pnpm-lock.yaml ./
WORKDIR /usr/src/app/frontend
ARG NEXT_PUBLIC_PAYMENT_API_BASE_URL=/api/v1
ENV NEXT_PUBLIC_PAYMENT_API_BASE_URL=${NEXT_PUBLIC_PAYMENT_API_BASE_URL}
COPY --from=source /src/frontend/package.json /src/frontend/openapi-ts.config.ts ./
COPY --from=source /src/frontend/scripts ./scripts
COPY --from=source /src/frontend/src ./src
COPY --from=source /src/frontend/public ./public
COPY --from=source /src/frontend/next.config.ts /src/frontend/postcss.config.mjs /src/frontend/tsconfig.json /src/frontend/components.json ./
COPY --from=backend-builder /usr/src/app/src/utils/generator/swagger-generator/openapi-docs.json ./openapi-docs.json
RUN pnpm install --frozen-lockfile
RUN pnpm run openapi-ts
RUN pnpm run build

FROM node:20-slim AS runner
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm
WORKDIR /usr/src/app
COPY --from=backend-builder /usr/src/app/dist ./dist
COPY --from=backend-builder /usr/src/app/node_modules ./node_modules
COPY --from=backend-builder /usr/src/app/package.json ./
COPY --from=backend-builder /usr/src/app/prisma ./prisma
COPY --from=backend-builder /usr/src/app/smart-contracts ./smart-contracts
COPY --from=backend-builder /usr/src/app/packages ./packages
COPY --from=backend-builder /usr/src/app/src ./src
COPY --from=backend-builder /usr/src/app/public ./public
COPY --from=backend-builder /usr/src/app/tsconfig.json /usr/src/app/eslint.config.mjs ./
COPY --from=frontend-builder /usr/src/app/frontend/dist ./frontend/dist
EXPOSE 3001
ENV NODE_ENV=production
CMD ["pnpm", "run", "start"]
