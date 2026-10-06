/** Real implementations of the side-effecting `Deps`: chain access, cranks, terminal, WebSocket. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { utxoToCore } from "@lucid-evolution/lucid";
import type { CascadeNetwork } from "@cascade/mcp/client";
import { CascadeClient, loadCascadeScripts, loadReferenceScripts } from "@cascade/sdk";
import {
  OgmiosClient,
  createLogger,
  createPool,
  loadNetworkConfig,
  makeLucid,
  migrate,
  parseWalletsFile,
  requireEnv,
  resolveSlotConfig,
  slotToPosixMs,
} from "@cascade/service-kit";
import { SdkCrankExecutor, tick } from "@cascade/watchtower";
import type { Chain, CrankOutcome, Io } from "./commands.js";
import { readDeployedData, referenceRefs, scriptHash } from "./deployments.js";

export function terminalIo(): Io {
  return {
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    clear: () => {
      if (process.stdout.isTTY === true) process.stdout.write("\x1b[2J\x1b[H");
    },
  };
}

export async function chainFor(network: CascadeNetwork): Promise<Chain> {
  const lucid = await makeLucid(loadNetworkConfig(network));
  return {
    walletUtxos: async (address) => (await lucid.utxosAt(address)).map((u) => utxoToCore(u).to_cbor_hex()),
    submit: async (signed) => {
      const provider = lucid.config().provider;
      if (provider === undefined) throw new Error("Lucid has no provider");
      return provider.submitTx(signed);
    },
  };
}

/**
 * One watchtower pass (the same `tick` services/watchtower runs on a timer). The watchtower role
 * wallet pays fees; every crank is permissionless, so no other key signs.
 */
export async function crankOnce(network: CascadeNetwork, root: string): Promise<CrankOutcome> {
  const cfg = loadNetworkConfig(network);
  const blueprintPath = resolve(root, "contracts", "plutus.json");
  if (!existsSync(blueprintPath)) throw new Error("contracts/plutus.json is missing; build the contracts first");
  const data = readDeployedData(root, network);
  const refs = referenceRefs(data);
  if (refs === null) {
    throw new Error(`no reference scripts recorded for ${network}; run scripts/deploy-scripts.ts --network ${network}`);
  }
  const mnemonic = requireEnv("CASCADE_TREASURY_MNEMONIC");
  const walletsPath = resolve(root, "deployments", `wallets.${network}.json`);
  const wallets = existsSync(walletsPath) ? parseWalletsFile(JSON.parse(readFileSync(walletsPath, "utf8"))) : [];
  const account = wallets.find((w) => w.role === "watchtower")?.accountIndex ?? 14;

  const lucid = await makeLucid(cfg);
  lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex: account });
  const channelHash = scriptHash(data, "cascade_channel");
  const scripts = loadCascadeScripts(JSON.parse(readFileSync(blueprintPath, "utf8")), channelHash === null ? {} : { channelHash });
  const deployedNode = scriptHash(data, "cascade_node");
  if (deployedNode !== null && scripts.nodeHash !== deployedNode) {
    throw new Error("contracts/plutus.json does not match the deployed cascade_node; redeploy or rebuild");
  }
  const executor = new SdkCrankExecutor(new CascadeClient(lucid, scripts, await loadReferenceScripts(lucid, refs)));

  const log = createLogger("cascade-cli", process.env.LOG_LEVEL ?? "warn");
  const pool = createPool(cfg.databaseUrl, 2);
  try {
    await migrate(pool, log);
    const ogmios = new OgmiosClient(cfg.ogmiosHttp);
    const slotConfig = await resolveSlotConfig(cfg);
    const { selected, ran } = await tick({
      pool,
      executor,
      log,
      chainTime: async () => BigInt(slotToPosixMs(slotConfig, (await ogmios.tip()).slot)),
    });
    return {
      selected: selected.length,
      ran: ran.map((r) => ({
        kind: r.crank.kind,
        nodeId: r.crank.nodeId,
        ...(r.txId === undefined ? {} : { txId: r.txId }),
        ...(r.error === undefined ? {} : { error: r.error }),
      })),
    };
  } finally {
    await pool.end();
  }
}

/** Indexer event stream over Node's built-in WebSocket client. */
export function subscribe(url: string, onEvent: () => void, onClose: (reason: string) => void): () => void {
  const ws = new WebSocket(url);
  let closedByUs = false;
  ws.addEventListener("message", () => onEvent());
  ws.addEventListener("error", () => undefined);
  ws.addEventListener("close", (e) => {
    if (!closedByUs) onClose(e.reason === "" ? `code ${e.code}` : e.reason);
  });
  return () => {
    closedByUs = true;
    ws.close();
  };
}

export function untilInterrupted(): Promise<void> {
  return new Promise((resolvePromise) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolvePromise();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}
