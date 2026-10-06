/**
 * Lucid Evolution instance for a Cascade network. Locally the provider is Yaci Store's
 * Blockfrost-compatible API (it indexes genesis UTxOs, unlike Kupo); on preprod it is Blockfrost.
 */
import { Blockfrost, Lucid, type LucidEvolution } from "@lucid-evolution/lucid";
import { ConfigError, resolveSlotConfig, type NetworkConfig } from "./config.js";

export async function makeLucid(cfg: NetworkConfig): Promise<LucidEvolution> {
  if (cfg.blockfrostUrl === null) throw new ConfigError(`no Blockfrost-compatible endpoint for ${cfg.network}`);
  if (cfg.network === "local") {
    const slotConfig = await resolveSlotConfig(cfg);
    return Lucid(new Blockfrost(cfg.blockfrostUrl, cfg.blockfrostProjectId ?? "yaci"), "Custom", { slotConfig });
  }
  if (cfg.blockfrostProjectId === null) throw new ConfigError("missing required environment variable BLOCKFROST_PROJECT_ID_PREPROD");
  return Lucid(new Blockfrost(cfg.blockfrostUrl, cfg.blockfrostProjectId), "Preprod");
}
