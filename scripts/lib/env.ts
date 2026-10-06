// Loads the repo-root .env once and exposes typed getters.
// Errors name the variable only; values never appear in messages or logs.
import { resolve } from "node:path";
import { config } from "dotenv";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  // quiet: dotenv would otherwise print a banner; override: false keeps shell exports authoritative.
  config({ path: resolve(REPO_ROOT, ".env"), quiet: true, override: false });
  loaded = true;
}

export class MissingEnvError extends Error {
  constructor(readonly variable: string) {
    super(`Missing required environment variable ${variable}`);
    this.name = "MissingEnvError";
  }
}

export class InvalidEnvError extends Error {
  constructor(
    readonly variable: string,
    expectation: string,
  ) {
    super(`Environment variable ${variable} is invalid: expected ${expectation}`);
    this.name = "InvalidEnvError";
  }
}

export function optionalEnv(name: string): string | undefined {
  loadEnv();
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (value === undefined) throw new MissingEnvError(name);
  return value;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidEnvError(name, '"true" or "false"');
}

export function isEnvSet(name: string): boolean {
  return optionalEnv(name) !== undefined;
}

export function treasuryMnemonic(): string {
  const mnemonic = requireEnv("CASCADE_TREASURY_MNEMONIC");
  const words = mnemonic.split(/\s+/).length;
  if (![12, 15, 24].includes(words)) {
    throw new InvalidEnvError("CASCADE_TREASURY_MNEMONIC", "a 12, 15 or 24 word mnemonic");
  }
  return mnemonic;
}
