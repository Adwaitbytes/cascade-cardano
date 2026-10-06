/**
 * MIP-003 input schema (`/input_schema`, Attachment 01) and server-side validation of
 * `input_data`. The schema is a display hint for front ends; the agent still treats every input as
 * untrusted and validates it here before any work starts.
 */
import { jcsSha256Hex } from "@cascade/shared/browser";

export interface InputValidation {
  validation: "min" | "max" | "format" | "accept" | "optional";
  value: string;
}

export interface InputField {
  id: string;
  /** MIP-003 types (`string`, `number`, `boolean`, `option`, `none`) or Attachment 01 HTML types. */
  type: string;
  name: string;
  data?: Record<string, unknown>;
  validations?: InputValidation[];
}

export interface InputGroup {
  id: string;
  title: string;
  input_data: InputField[];
}

export type Mip003InputSchema = { input_data: InputField[] } | { input_groups: InputGroup[] };

export function inputFields(schema: Mip003InputSchema): InputField[] {
  return "input_data" in schema ? schema.input_data : schema.input_groups.flatMap((g) => g.input_data);
}

/** `input_schema_hash` for `/provide_input`: SHA-256 of the canonical JSON of the schema. */
export const inputSchemaHash = (schema: Mip003InputSchema): string => jcsSha256Hex(schema);

const TEXT_TYPES = new Set(["string", "text", "textarea", "email", "password", "tel", "url", "search", "hidden", "color"]);
const DATE_TYPES = new Set(["date", "datetime-local", "time", "month", "week"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEL_RE = /^\+?[0-9 ()-]{3,32}$/;

/** Checks the schema itself: unique ids and valid validation entries. Throws on the first problem. */
export function assertInputSchema(schema: Mip003InputSchema): void {
  if (("input_data" in schema) === ("input_groups" in schema)) throw new Error("input schema must have exactly one of input_data or input_groups");
  const seen = new Set<string>();
  for (const field of inputFields(schema)) {
    if (!field.id || seen.has(field.id)) throw new Error(`input field id "${field.id}" is empty or duplicated`);
    seen.add(field.id);
    if (!field.name) throw new Error(`input field ${field.id} needs a name`);
  }
}

function validationValue(field: InputField, name: InputValidation["validation"]): string[] {
  return (field.validations ?? []).filter((v) => v.validation === name).map((v) => v.value);
}

function numberBound(field: InputField, name: "min" | "max"): number | undefined {
  const values = validationValue(field, name).map(Number).filter(Number.isFinite);
  if (values.length === 0) return undefined;
  return name === "min" ? Math.max(...values) : Math.min(...values);
}

function isOptional(field: InputField): boolean {
  return validationValue(field, "optional").some((v) => v === "true");
}

function fieldErrors(field: InputField, value: unknown): string[] {
  const at = `input_data.${field.id}`;
  const min = numberBound(field, "min");
  const max = numberBound(field, "max");
  const formats = validationValue(field, "format");
  const errors: string[] = [];
  const type = field.type;

  if (TEXT_TYPES.has(type) || DATE_TYPES.has(type)) {
    if (typeof value !== "string") return [`${at} must be a string`];
    if (!DATE_TYPES.has(type)) {
      if (min !== undefined && value.length < min) errors.push(`${at} must be at least ${min} characters`);
      if (max !== undefined && value.length > max) errors.push(`${at} must be at most ${max} characters`);
    }
    if (formats.includes("nonempty") && value.trim().length === 0) errors.push(`${at} must not be empty`);
    if ((type === "email" || formats.includes("email")) && !EMAIL_RE.test(value)) errors.push(`${at} must be an email address`);
    if (type === "url" || formats.includes("url")) {
      try {
        const u = new URL(value);
        if (u.protocol !== "https:" && u.protocol !== "http:") errors.push(`${at} must be an http(s) URL`);
      } catch {
        errors.push(`${at} must be a URL`);
      }
    }
    if (formats.includes("tel-pattern") && !TEL_RE.test(value)) errors.push(`${at} must be a phone number`);
    return errors;
  }
  switch (type) {
    case "number":
    case "range": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) return [`${at} must be a number`];
      if (formats.includes("integer") && !Number.isInteger(n)) errors.push(`${at} must be an integer`);
      if (min !== undefined && n < min) errors.push(`${at} must be >= ${min}`);
      if (max !== undefined && n > max) errors.push(`${at} must be <= ${max}`);
      return errors;
    }
    case "boolean":
    case "checkbox":
      return typeof value === "boolean" ? [] : [`${at} must be a boolean`];
    case "option":
    case "radio": {
      const allowed = Array.isArray(field.data?.["values"]) ? (field.data["values"] as unknown[]).filter((v) => typeof v === "string") : [];
      const picked = Array.isArray(value) ? value : [value];
      if (!picked.every((v) => typeof v === "string" && allowed.includes(v))) return [`${at} must be one of ${allowed.join(", ")}`];
      if (min !== undefined && picked.length < min) errors.push(`${at} needs at least ${min} selections`);
      if (max !== undefined && picked.length > max) errors.push(`${at} allows at most ${max} selections`);
      return errors;
    }
    case "file":
      return typeof value === "string" ? [] : [`${at} must be a URL string`];
    case "none":
      return [];
    default:
      return [`${at} has unsupported input type ${type}`];
  }
}

/**
 * Validates `input_data` against the schema. Unknown keys are rejected so the committed
 * `input_hash` covers exactly the fields the agent understands.
 */
export function validateInputData(schema: Mip003InputSchema, data: unknown): string[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return ["input_data must be an object"];
  const record = data as Record<string, unknown>;
  const fields = inputFields(schema);
  const known = new Set(fields.map((f) => f.id));
  const errors: string[] = [];
  for (const key of Object.keys(record)) if (!known.has(key)) errors.push(`input_data.${key} is not in the input schema`);
  for (const field of fields) {
    if (field.type === "none") continue;
    const value = record[field.id];
    if (value === undefined || value === null) {
      if (!isOptional(field)) errors.push(`input_data.${field.id} is required`);
      continue;
    }
    errors.push(...fieldErrors(field, value));
  }
  return errors;
}
