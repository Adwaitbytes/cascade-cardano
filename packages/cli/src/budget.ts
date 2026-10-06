/**
 * Human amounts to base units, asset shortcuts to x402 asset ids, and relative deadlines.
 * All amount math is on decimal strings and bigint, never floats.
 */
import type { CascadeNetwork } from "@cascade/mcp/client";

export interface ResolvedAsset {
  /** x402 asset id: `lovelace` or `<policy>.<name hex>`. */
  assetId: string;
  decimals: number;
  label: string;
}

export interface TestTokenInfo {
  policyId: string;
  assetNameHex: string;
  decimals: number;
  ticker: string;
}

export class BudgetError extends Error {
  override name = "BudgetError";
}

const ASSET_ID = /^[0-9a-f]{56}\.(?:[0-9a-f]{2}){0,32}$/;

/**
 * `ada` and `lovelace` resolve everywhere. `usdm` resolves to the local test token on Yaci; on
 * preprod Cascade holds no tUSDM (PREPROD_TUSDM_AVAILABLE=false), so it is refused.
 */
export function resolveAsset(arg: string, network: CascadeNetwork, localToken: TestTokenInfo | null): ResolvedAsset {
  const a = arg.trim().toLowerCase();
  if (a === "ada" || a === "tada") return { assetId: "lovelace", decimals: 6, label: "ADA" };
  if (a === "lovelace") return { assetId: "lovelace", decimals: 0, label: "lovelace" };
  if (a === "usdm" || a === "tusdm") {
    if (network === "preprod") {
      throw new BudgetError("tUSDM is not available on preprod (PREPROD_TUSDM_AVAILABLE=false); use --asset ada");
    }
    if (localToken === null) {
      throw new BudgetError("no local tUSDM recorded in deployments/local.runtime.json; run pnpm local:up or scripts/mint-test-usdm.ts");
    }
    return { assetId: `${localToken.policyId}.${localToken.assetNameHex}`, decimals: localToken.decimals, label: localToken.ticker };
  }
  if (ASSET_ID.test(a)) return { assetId: a, decimals: 0, label: `${a.slice(0, 8)}… base units` };
  throw new BudgetError("--asset must be ada, lovelace, usdm or <policy hex>.<asset name hex>");
}

/** "150" or "12.5" in whole units to a canonical base-unit integer string. */
export function toBaseUnits(amount: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (m === null) throw new BudgetError("--budget must be a positive decimal number");
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new BudgetError(`--budget has more than ${decimals} decimal places for this asset`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new BudgetError("--budget must be greater than zero");
  if (units >= 1n << 64n) throw new BudgetError("--budget is too large");
  return units.toString();
}

/** Base units back to a human string, trimming trailing zeros. */
export function formatUnits(units: string | bigint, decimals: number): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  if (decimals === 0) return `${neg ? "-" : ""}${abs}`;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac === "" ? "" : `.${frac}`}`;
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "90m", "2h", "1d" relative to now, or an ISO date. Returns POSIX ms. */
export function parseDeadline(value: string, now: number): number {
  const rel = /^(\d+)([mhd])$/.exec(value.trim());
  if (rel !== null) return now + Number(rel[1]) * (UNIT_MS[rel[2] ?? "h"] ?? 0);
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new BudgetError("--deadline must look like 90m, 2h, 1d or an ISO date");
  if (at <= now) throw new BudgetError("--deadline is in the past");
  return at;
}
