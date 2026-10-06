/**
 * Asset metadata and exact amount formatting. Amounts are base-unit decimal strings or bigints on
 * the wire and are never converted through floating point.
 */

/** Preprod tUSDM (PRD 8.7). */
export const TUSDM_ASSET_ID =
  "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";

export interface AssetInfo {
  id: string;
  ticker: string;
  decimals: number;
  /** Plain name for previews, e.g. "test USDM". */
  name: string;
}

const KNOWN: Record<string, AssetInfo> = {
  lovelace: { id: "lovelace", ticker: "ADA", decimals: 6, name: "ADA" },
  [TUSDM_ASSET_ID]: { id: TUSDM_ASSET_ID, ticker: "tUSDM", decimals: 6, name: "test USDM" },
};

export function assetInfo(assetId: string): AssetInfo {
  const known = KNOWN[assetId];
  if (known !== undefined) return known;
  const [policy = "", name = ""] = assetId.split(".");
  const ticker = decodeAssetName(name) ?? `${policy.slice(0, 8)}…`;
  return { id: assetId, ticker, decimals: 0, name: ticker };
}

/** Asset names are hex; show them as text only when they decode to printable ASCII. */
function decodeAssetName(hex: string): string | null {
  if (hex === "" || hex.length % 2 !== 0) return null;
  const withoutLabel = hex.length > 8 && /^00[0-9a-f]{6}/.test(hex) ? hex.slice(8) : hex;
  let out = "";
  for (let i = 0; i < withoutLabel.length; i += 2) {
    const code = Number.parseInt(withoutLabel.slice(i, i + 2), 16);
    if (code < 0x20 || code > 0x7e) return null;
    out += String.fromCharCode(code);
  }
  return out;
}

export type AmountInput = string | bigint;

function toBigInt(amount: AmountInput): bigint {
  if (typeof amount === "bigint") return amount;
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(amount)) throw new TypeError(`not a base-unit integer: ${amount}`);
  return BigInt(amount);
}

/**
 * Exact decimal rendering of a base-unit amount: at least two fraction digits, more only when the
 * value needs them, never rounded. `formatUnits(150000000n, 6)` is `"150.00"`.
 */
export function formatUnits(amount: AmountInput, decimals: number): string {
  const value = toBigInt(amount);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const wholeText = whole.toLocaleString("en-US");
  if (decimals === 0) return `${negative ? "-" : ""}${wholeText}`;
  let fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(Math.min(2, decimals), "0");
  return `${negative ? "-" : ""}${wholeText}.${fraction}`;
}

/** "150.00 tUSDM". Always carries the ticker (PRD 14.7). */
export function formatAmount(amount: AmountInput, assetId: string): string {
  const info = assetInfo(assetId);
  return `${formatUnits(amount, info.decimals)} ${info.ticker}`;
}

/** Tooltip text that states the exact base units and the decimals used. */
export function describeAmount(amount: AmountInput, assetId: string): string {
  const info = assetInfo(assetId);
  const unit = assetId === "lovelace" ? "lovelace" : "base units";
  return `${toBigInt(amount).toString()} ${unit}, ${info.decimals} decimals`;
}

/** Exact lovelace with thousands separators: "14,000,000 lovelace". */
export function formatLovelace(amount: AmountInput): string {
  return `${toBigInt(amount).toLocaleString("en-US")} lovelace`;
}

/**
 * Parses a user-typed decimal ("150", "150.5", "0.000001") into base units. Returns null for
 * anything that is not a plain non-negative decimal or has more fraction digits than the asset.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  const trimmed = text.trim().replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}
