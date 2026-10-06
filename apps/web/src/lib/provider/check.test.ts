// @vitest-environment node
import { describe, expect, it } from "vitest";
import { UnsafeUrlError, checkAgentEndpoints, isPrivateAddress, parseAgentUrl } from "./check";

describe("parseAgentUrl", () => {
  it("accepts https and trims trailing slashes", () => expect(parseAgentUrl("https://agent.example.com/api/", false).pathname).toBe("/api"));
  it("rejects http unless allowed, credentials, queries and junk", () => {
    expect(() => parseAgentUrl("http://agent.example.com", false)).toThrow(UnsafeUrlError);
    expect(() => parseAgentUrl("https://u:p@agent.example.com", false)).toThrow(UnsafeUrlError);
    expect(() => parseAgentUrl("https://agent.example.com/?x=1", false)).toThrow(UnsafeUrlError);
    expect(() => parseAgentUrl("file:///etc/passwd", true)).toThrow(UnsafeUrlError);
    expect(() => parseAgentUrl("not a url", false)).toThrow(UnsafeUrlError);
  });
});

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])("blocks %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700::1111"])("allows %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("checkAgentEndpoints", () => {
  it("refuses a literal private address before fetching", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    await expect(checkAgentEndpoints("https://169.254.169.254", { allowPrivate: false, fetchImpl })).rejects.toThrow(UnsafeUrlError);
    expect(called).toBe(false);
  });

  it("reports pass and fail per endpoint", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/availability")) return Response.json({ status: "available" });
      if (url.endsWith("/input_schema")) return Response.json({ input_data: [] });
      if (url.endsWith("/.well-known/cascade.json")) return new Response(null, { status: 302, headers: { location: "http://10.0.0.1" } });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const result = await checkAgentEndpoints("http://127.0.0.1:9999", { allowPrivate: true, fetchImpl });
    const byPath = Object.fromEntries(result.checks.map((c) => [c.path, c]));
    expect(byPath["/availability"]?.status).toBe("pass");
    expect(byPath["/input_schema"]?.status).toBe("pass");
    expect(byPath["/.well-known/cascade.json"]?.detail).toBe("redirects are not followed");
    expect(byPath["/output_schema"]?.status).toBe("fail");
  });
});
