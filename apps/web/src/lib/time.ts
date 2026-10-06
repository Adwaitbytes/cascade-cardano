/** Preprod slot clock (deployments/preprod.json `slotConfig`): slot 86400 began at 1655769600000 ms, 1 s per slot. */
const PREPROD = { zeroTime: 1_655_769_600_000, zeroSlot: 86_400, slotLength: 1_000 };

export const preprodSlotToMs = (slot: number): number => PREPROD.zeroTime + (slot - PREPROD.zeroSlot) * PREPROD.slotLength;

export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}
