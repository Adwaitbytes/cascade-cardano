import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/** Origins the browser may call besides this site: an external indexer, its WebSocket, and the Conductor. */
function connectSources(): string[] {
  const sources = new Set<string>(["'self'"]);
  const urls = [
    process.env.NEXT_PUBLIC_INDEXER_URL,
    process.env.NEXT_PUBLIC_INDEXER_WS_URL,
    process.env.NEXT_PUBLIC_CONDUCTOR_URL,
  ];
  for (const raw of urls) {
    if (raw === undefined || raw === "" || raw.startsWith("/")) continue;
    const url = new URL(raw);
    sources.add(url.origin);
    const wsProtocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
    sources.add(`${wsProtocol}//${url.host}`);
  }
  if (isDev) sources.add("ws://localhost:*");
  return [...sources];
}

// Next.js injects inline bootstrap scripts, so script-src needs 'unsafe-inline' without a nonce
// proxy. 'wasm-unsafe-eval' is for the Mesh wallet's serialisation library on the fund step.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src ${connectSources().join(" ")}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const nextConfig: NextConfig = {
  // The /api/v1 mount runs the indexer's own server code. Workspace packages are bundled, so the
  // packages that load WASM or native code at runtime stay external; they are direct deps of this
  // app only so the bundler can resolve them as externals.
  serverExternalPackages: ["@lucid-evolution/lucid", "@cedar-policy/cedar-wasm", "pg"],
  outputFileTracingRoot: REPO_ROOT,
  outputFileTracingIncludes: {
    // A glob, not the route name: brackets in "[...path]" are read as a glob class and match nothing.
    "/api/**/*": ["../../pnpm-workspace.yaml", "../../deployments/preprod.json", "../../deployments/wallets.preprod.json", "../../contracts/plutus.json"],
    "/receipt/**/*": ["../../pnpm-workspace.yaml", "../../deployments/preprod.json", "../../deployments/wallets.preprod.json", "../../contracts/plutus.json"],
    "/tree/**/*": ["../../pnpm-workspace.yaml", "../../deployments/preprod.json", "../../deployments/wallets.preprod.json", "../../contracts/plutus.json"],
    // The landing page lists the deployed scripts from deployments/preprod.json.
    "/": ["../../pnpm-workspace.yaml", "../../deployments/preprod.json"],
  },
  // The local stack, e2e suite and demo recorder open the dev server as 127.0.0.1; Next 16 blocks
  // dev resources for any origin other than localhost, and the page then never hydrates.
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  // A separate build directory lets the smoke-test server run beside another dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  agentRules: false,
  devIndicators: false,
  poweredByHeader: false,
  transpilePackages: ["@cascade/shared", "geist"],
  // There is no separate agent index: the directory lives on the network page.
  async redirects() {
    return [{ source: "/agents", destination: "/economy#agents", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
