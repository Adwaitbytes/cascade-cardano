// Builds a Lucid instance for the two networks Cascade may touch: the local
// Yaci devnet and Cardano preprod. Anything else, mainnet included, is refused.
import { Blockfrost, Koios, Kupmios, Lucid, type LucidEvolution, type Network, type SlotConfig } from "@lucid-evolution/lucid";
import { readLocalDeployment, readPreprodDeployment } from "./deployments.js";
import { InvalidEnvError, requireEnv } from "./env.js";

export const CASCADE_NETWORKS = ["local", "preprod"] as const;
export type CascadeNetwork = (typeof CASCADE_NETWORKS)[number];

export class UnsupportedNetworkError extends Error {
  constructor(value: string) {
    super(`Unsupported network "${value}". Cascade scripts run only on: ${CASCADE_NETWORKS.join(", ")}`);
    this.name = "UnsupportedNetworkError";
  }
}

export function parseNetwork(value: string | undefined): CascadeNetwork {
  if (value === undefined || value === "") throw new UnsupportedNetworkError("(none)");
  const normalised = value.trim().toLowerCase();
  if ((CASCADE_NETWORKS as readonly string[]).includes(normalised)) return normalised as CascadeNetwork;
  throw new UnsupportedNetworkError(value);
}

/** Reads `--network <name>` or `--network=<name>` from argv. The flag is required. */
export function networkFromArgv(argv: readonly string[] = process.argv.slice(2)): CascadeNetwork {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--network") return parseNetwork(argv[i + 1]);
    if (arg?.startsWith("--network=")) return parseNetwork(arg.slice("--network=".length));
  }
  throw new UnsupportedNetworkError("(missing --network flag)");
}

export function lucidNetworkName(network: CascadeNetwork): Network {
  return network === "local" ? "Custom" : "Preprod";
}

export interface DevnetInfo {
  protocolMagic: number;
  startTime: number;
  slotLength: number;
}

export async function fetchJson(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json() as Promise<unknown>;
}

export async function fetchDevnetInfo(): Promise<DevnetInfo> {
  const { endpoints } = readLocalDeployment();
  const raw = await fetchJson(endpoints.adminDevnetInfo);
  if (typeof raw !== "object" || raw === null) throw new Error("Yaci devnet info is not an object");
  const { protocolMagic, startTime, slotLength } = raw as Record<string, unknown>;
  if (typeof protocolMagic !== "number" || typeof startTime !== "number" || typeof slotLength !== "number") {
    throw new Error("Yaci devnet info lacks protocolMagic, startTime or slotLength");
  }
  if (protocolMagic !== 42) throw new Error(`Local devnet reports protocol magic ${protocolMagic}, expected 42`);
  return { protocolMagic, startTime, slotLength };
}

/** Yaci recreates genesis on every start, so zero time must be read from the running devnet. */
export async function localSlotConfig(): Promise<SlotConfig> {
  const info = await fetchDevnetInfo();
  return { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: Math.round(info.slotLength * 1000) };
}

export type ProviderName = "yaci-store" | "kupmios" | "blockfrost" | "koios";

/** Local provider choice. Kupo does not index genesis UTxOs, so Kupmios needs funded (topped-up) wallets. */
export type LocalProvider = "yaci-store" | "kupmios";

export interface NetworkContext {
  network: CascadeNetwork;
  lucid: LucidEvolution;
  provider: ProviderName;
}

async function localLucid(choice: LocalProvider): Promise<NetworkContext> {
  const { endpoints } = readLocalDeployment();
  const slotConfig = await localSlotConfig();
  if (choice === "kupmios") {
    const lucid = await Lucid(new Kupmios(endpoints.kupo, endpoints.ogmiosHttp), "Custom", { slotConfig });
    return { network: "local", lucid, provider: "kupmios" };
  }
  // Yaci Store serves a Blockfrost-compatible API and, unlike Kupo, indexes genesis UTxOs.
  const lucid = await Lucid(new Blockfrost(endpoints.blockfrostCompatible, "yaci"), "Custom", { slotConfig });
  return { network: "local", lucid, provider: "yaci-store" };
}

async function preprodLucid(): Promise<NetworkContext> {
  const { endpoints } = readPreprodDeployment();
  const projectId = requireEnv("BLOCKFROST_PROJECT_ID_PREPROD");
  // Blockfrost keys are network-scoped; a non-preprod key must never reach a signing path.
  if (!projectId.startsWith("preprod")) {
    throw new InvalidEnvError("BLOCKFROST_PROJECT_ID_PREPROD", "a preprod project id");
  }
  try {
    const lucid = await Lucid(new Blockfrost(endpoints.blockfrost, projectId), "Preprod");
    return { network: "preprod", lucid, provider: "blockfrost" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Blockfrost preprod unavailable (${reason.slice(0, 200)}); falling back to Koios\n`);
    const lucid = await Lucid(new Koios(endpoints.koios), "Preprod");
    return { network: "preprod", lucid, provider: "koios" };
  }
}

export async function makeLucid(
  network: CascadeNetwork,
  options: { localProvider?: LocalProvider } = {},
): Promise<NetworkContext> {
  // Re-validate so a value that bypassed the type system (e.g. a cast) is still refused.
  const checked = parseNetwork(network);
  return checked === "local" ? localLucid(options.localProvider ?? "yaci-store") : preprodLucid();
}

export function explorerTxUrl(network: CascadeNetwork, txHash: string): string {
  if (network === "preprod") return `https://preprod.cardanoscan.io/transaction/${txHash}`;
  return `${readLocalDeployment().endpoints.viewer}/transactions/${txHash}`;
}
