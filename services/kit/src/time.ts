/** Slot and POSIX-ms conversion. Pure, so it is safe in serverless read paths. */
export interface SlotConfig {
  zeroTime: number;
  zeroSlot: number;
  slotLength: number;
}

export const slotToPosixMs = (sc: SlotConfig, slot: number | bigint): number => sc.zeroTime + (Number(slot) - sc.zeroSlot) * sc.slotLength;
export const posixMsToSlot = (sc: SlotConfig, ms: number | bigint): number => Math.floor((Number(ms) - sc.zeroTime) / sc.slotLength) + sc.zeroSlot;
