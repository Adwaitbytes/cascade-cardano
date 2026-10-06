/**
 * The registered agent endpoint (Masumi Standard type, `apiBaseUrl`). Cascade Coworker is hired as
 * a Sokosumi Coworker: Tasks arrive through Sokosumi and are paid through the masumiPayment flow, so
 * `start_job` points callers there instead of opening a second, unpaid entry point.
 */
import { Hono } from "hono";
import type { CoworkerConfig, Registration } from "./config.js";

export const INPUT_SCHEMA = {
  input_data: [
    {
      id: "brief",
      type: "string",
      name: "Brief",
      data: { description: "What you need, in one or two sentences. Example: Market-entry brief for cold-pressed juice in Dubai with a competitor price table." },
    },
  ],
};

export function coworkerApi(config: CoworkerConfig, registration: Registration, openTasks: () => number): Hono {
  const app = new Hono();
  const hire = { sokosumi_coworker_id: config.coworkerId, how: "Create a Task for this Coworker on Sokosumi (preprod); it is paid through Masumi escrow in test USDM." };
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/availability", (c) =>
    c.json({ status: "available", type: "masumi-agent", agentIdentifier: registration.agentIdentifier, message: `Cascade Coworker is running with ${openTasks()} open Task(s).` }),
  );
  app.get("/input_schema", (c) => c.json(INPUT_SCHEMA));
  app.post("/start_job", (c) => c.json({ status: "error", error: "hire_through_sokosumi", ...hire }, 409));
  app.get("/status", (c) => c.json({ status: "error", error: "hire_through_sokosumi", ...hire }, 404));
  return app;
}
