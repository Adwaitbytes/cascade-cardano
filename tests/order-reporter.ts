/**
 * Prints the order in which vitest queues acceptance files. Used only for the dry ordering check
 * (`pnpm --filter @cascade/tests run acceptance:order`), which runs no test and spends nothing.
 */
import type { Reporter, TestModule } from "vitest/node";

export default class OrderReporter implements Reporter {
  private n = 0;
  onTestModuleQueued(m: TestModule): void {
    this.n += 1;
    process.stdout.write(`queued ${this.n}: ${m.moduleId.replace(/^.*\/tests\//, "")}\n`);
  }
}
