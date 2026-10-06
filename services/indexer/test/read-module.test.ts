/**
 * `@cascade/indexer/read` must load without Lucid (CML wasm), without the repo-root config reader,
 * and without side effects, so Next.js server routes on Vercel can import it. Walks the built
 * module graph from dist/read.js.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function resolveSpec(spec: string, from: string): string | null {
  if (spec.startsWith(".")) return resolve(dirname(from), spec);
  if (!spec.startsWith("@cascade/")) return null; // third-party: checked by name only
  const [scope, name, ...rest] = spec.split("/");
  let dir = dirname(from);
  let pkgDir: string | null = null;
  while (pkgDir === null) {
    const candidate = resolve(dir, "node_modules", scope as string, name as string);
    if (existsSync(candidate)) pkgDir = realpathSync(candidate);
    else if (dirname(dir) === dir) throw new Error(`cannot find ${spec}`);
    else dir = dirname(dir);
  }
  const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as { exports: Record<string, { import: string }> };
  const sub = rest.length === 0 ? "." : `./${rest.join("/")}`;
  const target = pkg.exports[sub]?.import;
  if (target === undefined) throw new Error(`${spec} is not exported`);
  return resolve(pkgDir, target);
}

function graph(entry: string): { files: string[]; externals: string[] } {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
      const spec = m[1] as string;
      if (/^import\s+type\b/.test(m[0]) || /^export\s+type\b/.test(m[0])) continue;
      const r = resolveSpec(spec, file);
      if (r === null) externals.add(spec);
      else visit(r);
    }
  };
  visit(entry);
  return { files: [...seen], externals: [...externals] };
}

describe("@cascade/indexer/read", () => {
  it("imports no Lucid, no config reader and no service entry points", () => {
    const { files, externals } = graph(resolve(here, "../dist/read.js"));
    expect(externals.filter((e) => e.includes("lucid") || e.includes("cardano-multiplatform"))).toEqual([]);
    expect(files.filter((f) => /service-kit\/dist\/(index|config|keys|lucid|chaintx)\.js$|indexer\/dist\/(main|follower|poller|anchor|api)\.js$/.test(f))).toEqual([]);
    expect(files.some((f) => f.endsWith("shared/dist/codec.js"))).toBe(false);
  });

  it("exposes every read the REST API serves", async () => {
    const read = await import("../dist/read.js");
    for (const fn of ["getTree", "getTreeEvents", "getReceipt", "searchAgents", "getAgent", "getLatestSnapshot", "getSnapshot", "getNodeDetail", "listTrees", "listDisputes", "getOpsStatus", "getProviderWork"]) {
      expect(typeof (read as Record<string, unknown>)[fn]).toBe("function");
    }
  });
});
