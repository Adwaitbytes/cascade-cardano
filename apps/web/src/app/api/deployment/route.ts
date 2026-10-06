import { readDeployment } from "@/server/deployment";

export const runtime = "nodejs";
// Next to the indexer database (Neon, ap-southeast-1).
export const preferredRegion = "sin1";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return Response.json(readDeployment(), { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) {
    return Response.json({ error: "unavailable", detail: (error as Error).message }, { status: 503 });
  }
}
