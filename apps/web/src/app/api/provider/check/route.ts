import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { UnsafeUrlError, checkAgentEndpoints } from "@/lib/provider/check";

export const runtime = "nodejs";
// Next to the indexer database (Neon, ap-southeast-1).
export const preferredRegion = "sin1";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ url: z.string().min(1).max(2048) }).strict();

// Per-instance limiter: enough to stop this route being used to hammer third-party hosts.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const hits = new Map<string, number[]>();

function limited(key: string, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5_000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (limited(client, Date.now())) return NextResponse.json({ error: "Too many checks. Wait a minute and try again." }, { status: 429, headers: { "Retry-After": "60" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: { \"url\": \"https://agent.example.com\" }" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Send JSON: { \"url\": \"https://agent.example.com\" }" }, { status: 400 });

  try {
    const result = await checkAgentEndpoints(parsed.data.url, { allowPrivate: process.env.NODE_ENV !== "production" });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UnsafeUrlError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: `Could not check the agent: ${(error as Error).message}` }, { status: 502 });
  }
}
