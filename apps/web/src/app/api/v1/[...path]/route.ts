import { handleRead } from "@/server/read-api";

export const runtime = "nodejs";
// Next to the indexer database (Neon, ap-southeast-1).
export const preferredRegion = "sin1";
export const dynamic = "force-dynamic";

export const GET = (request: Request): Promise<Response> => handleRead(request);
export const POST = (request: Request): Promise<Response> => handleRead(request);
