import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { notImplemented } from "./not-implemented.js";
import { repoPath } from "./repo.js";

/** The subset of deployments/preprod.json the harness reads. W6 owns the file and its full shape. */
const PreprodDeployment = z.looseObject({
  network: z.literal("preprod"),
  urls: z.looseObject({ console: z.url().nullable().optional(), explorer_demo_tree: z.url().nullable().optional() }).optional(),
});
export type PreprodDeployment = z.infer<typeof PreprodDeployment>;

export function readPreprodDeployment(): PreprodDeployment {
  const path = repoPath("deployments", "preprod.json");
  if (!existsSync(path)) notImplemented("deployments/preprod.json (W6 preprod script deployment)");
  return PreprodDeployment.parse(JSON.parse(readFileSync(path, "utf8")));
}
