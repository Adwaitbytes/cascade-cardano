import { LandingDataSchema, type LandingData } from "./data";
import snapshot from "./snapshot.json";

/**
 * The bundled capture of the landing data, taken from the preprod read API by
 * `scripts/landing-snapshot.ts`. Shown only when the indexer cannot be read, and labelled so.
 */
export function landingSnapshot(): LandingData {
  return { ...LandingDataSchema.parse(snapshot), source: "snapshot" };
}
