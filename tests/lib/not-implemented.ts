/**
 * Thrown by suites whose feature does not exist yet. The test fails with this message;
 * it is never skipped, so the verify summary stays honest while the product is built.
 */
export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
  constructor(readonly missing: string) {
    super(`not yet implemented: ${missing}`);
  }
}

export function notImplemented(missing: string): never {
  throw new NotImplementedError(missing);
}
