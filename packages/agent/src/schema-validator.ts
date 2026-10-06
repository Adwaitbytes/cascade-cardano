/** JSON Schema validation (Ajv, draft 2020-12) used for result checks (PRD 11.1 L0). */
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS; under NodeNext its default import is `module.exports`, whose `default` is the plugin.
const addFormats = addFormatsModule.default;

export type SchemaCheck = { ok: true } | { ok: false; errors: string[] };

const formatErrors = (errors: ErrorObject[] | null | undefined): string[] =>
  (errors ?? []).slice(0, 20).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  return ajv;
}

/** Compiles a schema once and returns a checker. Throws if the schema itself is invalid. */
export function compileSchema(schema: Record<string, unknown>): (value: unknown) => SchemaCheck {
  const validate: ValidateFunction = createAjv().compile(schema);
  return (value) => (validate(value) ? { ok: true } : { ok: false, errors: formatErrors(validate.errors) });
}
