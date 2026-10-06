import { describe, expect, it } from "vitest";
import { conductorBase } from "./env";

describe("conductorBase", () => {
  it("accepts the Conductor URL with or without /v1", () => {
    expect(conductorBase("https://x.ngrok-free.dev/conductor/v1")).toBe("https://x.ngrok-free.dev/conductor");
    expect(conductorBase("https://x.ngrok-free.dev/conductor/v1/")).toBe("https://x.ngrok-free.dev/conductor");
    expect(conductorBase("https://x.ngrok-free.dev/conductor")).toBe("https://x.ngrok-free.dev/conductor");
    expect(conductorBase(undefined)).toBeNull();
  });
});
