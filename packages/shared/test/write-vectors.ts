import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeVectors } from "./vectors.js";

const target = fileURLToPath(new URL("./vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(computeVectors(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
