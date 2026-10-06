#!/usr/bin/env node
/** `cascade` CLI entry point (PRD 15.4). */
import { ApiError, CascadeApi, ConfigError, endpointsFromEnv } from "@cascade/mcp/client";
import { loadEnv, REPO_ROOT } from "@cascade/service-kit";
import { parseCommand, USAGE, UsageError } from "./args.js";
import { CommandError, run } from "./commands.js";
import { BudgetError } from "./budget.js";
import { chainFor, crankOnce, subscribe, terminalIo, untilInterrupted } from "./runtime.js";

async function main(): Promise<number> {
  const io = terminalIo();
  try {
    const cmd = parseCommand(process.argv.slice(2));
    loadEnv();
    const endpoints = endpointsFromEnv();
    const api = new CascadeApi(endpoints);
    await run(
      cmd,
      {
        api,
        network: endpoints.network,
        root: REPO_ROOT,
        cwd: process.cwd(),
        io,
        now: Date.now,
        chain: () => chainFor(endpoints.network),
        crank: () => crankOnce(endpoints.network, REPO_ROOT),
        subscribe,
        untilInterrupted,
      },
      USAGE,
    );
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof ApiError || e instanceof ConfigError || e instanceof CommandError || e instanceof BudgetError) {
      io.err(e.message);
      return 1;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

main().then((code) => process.exit(code));
