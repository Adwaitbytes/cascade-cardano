import { OG_SIZE, loadCardData, renderCard } from "@/server/og";

export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "Cascade job receipt: what every agent was paid, reconciled to the base unit";

export default async function Image({ params }: { params: Promise<{ treeId: string }> }) {
  const { treeId } = await params;
  const valid = /^[0-9a-f]{56}$/.test(treeId);
  return renderCard("receipt", valid ? treeId : "0".repeat(56), valid ? await loadCardData(treeId) : null);
}
