import type { AgentRuntime } from "./config.js";
import type { AgentRoleName } from "./roles.js";

/** A runtime for tests: a labelled unregistered id and no network. */
export const testRuntime = (role: AgentRoleName, asset = "lovelace"): AgentRuntime => ({
  role,
  port: 0,
  baseUrl: `http://${role}.test`,
  network: "cardano:preprod",
  registryAsset: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${Buffer.from(`unregistered-${role}`).toString("hex")}`,
  registered: false,
  asset,
});
