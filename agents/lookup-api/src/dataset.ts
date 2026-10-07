/**
 * The data the Lookup API sells. These rows are illustrative sample values for the demo, not
 * market data: brand names are placeholders and every row carries `sample: true`.
 */
import { brandKey } from "@cascade/orchestrator/deliverable";

export const DATASET_ID = "cascade-demo-juice-prices-v1 (illustrative sample values, not market data)";

export interface PriceRow {
  brand: string;
  product: string;
  size_ml: number;
  price_aed: number;
  source_url: string;
  sample: true;
}

const row = (brand: string, product: string, size_ml: number, price_aed: number): PriceRow => ({
  brand,
  product,
  size_ml,
  price_aed,
  source_url: `https://data.cascade.invalid/samples/${encodeURIComponent(brand.toLowerCase().replace(/\s+/g, "-"))}`,
  sample: true,
});

export const ROWS: readonly PriceRow[] = [
  row("Sample Brand A", "Green detox", 250, 18),
  row("Sample Brand A", "Orange carrot ginger", 250, 16),
  row("Sample Brand B", "Beetroot apple", 330, 22),
  row("Sample Brand B", "Pineapple mint", 330, 21),
  row("Sample Brand C", "Celery", 500, 29),
  row("Sample Brand C", "Watermelon", 500, 24),
  row("Sample Brand D", "Pomegranate", 250, 25),
  row("Sample Brand E", "Mango passion", 300, 19),
];

/** Rows for a brand, matched on `brandKey`, so "N Juice" finds rows filed under "N'Juice". */
export function lookup(brand: string): PriceRow[] {
  const q = brandKey(brand);
  if (q === "") return [];
  return ROWS.filter((r) => brandKey(r.brand) === q);
}

export const brands = (): string[] => [...new Set(ROWS.map((r) => r.brand))];

/**
 * Price on `day` (1 to 60) of the illustrative series: the base price with a fixed, labelled
 * synthetic variation. One metered call buys one brand-day.
 */
export function lookupDay(brand: string, day: number): (PriceRow & { day: number })[] {
  if (!Number.isInteger(day) || day < 1 || day > 60) return [];
  return lookup(brand).map((r) => ({ ...r, day, price_aed: Math.round((r.price_aed * (100 + ((day * 7 + r.size_ml) % 9) - 4)) / 100) }));
}
