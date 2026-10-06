/**
 * W8's recorder manifest (demo/record.ts), written next to demo/out/cascade-demo.mp4, and the
 * no-cuts rules A20 checks on it. Times are seconds in the final video; `factor` is playback speed
 * (1 is real time). The encoder only changes speed, so the segments must tile the raw recording and
 * the final video without a gap.
 */
import { z } from "zod";

const TxHash = z.string().regex(/^[0-9a-f]{64}$/);

export const DemoManifest = z.looseObject({
  dryRun: z.boolean(),
  rehearsal: z.boolean(),
  recordedAt: z.iso.datetime(),
  treeId: z.string().regex(/^[0-9a-f]{56}$/).nullable(),
  fundTx: z.string().nullable(),
  walletSigned: z.array(z.looseObject({ txHash: TxHash, submitted: z.boolean(), at: z.number(), factor: z.number() })),
  events: z.array(z.looseObject({ type: z.string(), node: z.string(), tx: TxHash, at: z.number(), factor: z.number() })),
  segments: z.array(z.object({ start: z.number(), end: z.number(), factor: z.number(), rawStart: z.number(), rawEnd: z.number() })),
  outputSeconds: z.number(),
  failure: z.string().nullable(),
});
export type DemoManifest = z.infer<typeof DemoManifest>;

/** Events that move value. Each must be on chain and captioned in the recording at real time. */
export const MONEY_EVENTS: ReadonlySet<string> = new Set(["tree.funded", "node.drawn", "node.settled", "node.refunded", "node.resolved", "receipt.closed", "tree.closed"]);

/** Manifest times are rounded to 0.01 s. */
const EPS = 0.011;

/** Every way the timeline could hide footage; empty when it only changes speed. */
export function timelineGaps(m: Pick<DemoManifest, "segments" | "outputSeconds">): string[] {
  const out: string[] = [];
  const segs = m.segments;
  if (segs.length === 0) return ["no segments"];
  if (Math.abs(segs[0]!.start) > EPS || Math.abs(segs[0]!.rawStart) > EPS) out.push("the first segment does not start at 0");
  segs.forEach((s, i) => {
    if (!(s.factor >= 1)) out.push(`segment ${i} has speed ${s.factor}`);
    if (!(s.end > s.start) || !(s.rawEnd > s.rawStart)) out.push(`segment ${i} is empty or reversed`);
    else if (Math.abs((s.rawEnd - s.rawStart) / s.factor - (s.end - s.start)) > 2 * EPS) out.push(`segment ${i} drops footage (raw ${s.rawStart}-${s.rawEnd} at ${s.factor}x is not ${s.start}-${s.end})`);
    const prev = segs[i - 1];
    if (prev !== undefined) {
      if (Math.abs(s.start - prev.end) > EPS) out.push(`gap in the video between segments ${i - 1} and ${i}`);
      if (Math.abs(s.rawStart - prev.rawEnd) > EPS) out.push(`raw footage ${prev.rawEnd}-${s.rawStart} is cut`);
    }
  });
  if (Math.abs(segs[segs.length - 1]!.end - m.outputSeconds) > 2) out.push(`segments end at ${segs[segs.length - 1]!.end} s, the video lasts ${m.outputSeconds} s`);
  return out;
}

/** Speed of the final video at `t` seconds, from the segments rather than the event's own claim. */
export function speedAt(m: Pick<DemoManifest, "segments">, t: number): number {
  return m.segments.find((s) => t >= s.start && t < s.end)?.factor ?? m.segments[m.segments.length - 1]?.factor ?? 1;
}

/** Money movements (and wallet signatures) that play faster than real time. */
export function spedUpMoments(m: Pick<DemoManifest, "segments" | "events" | "walletSigned">): string[] {
  const events = m.events.filter((e) => MONEY_EVENTS.has(e.type) && (e.factor !== 1 || speedAt(m, e.at) !== 1)).map((e) => `${e.type} ${e.tx.slice(0, 8)}`);
  const signatures = m.walletSigned.filter((w) => w.factor !== 1 || speedAt(m, w.at) !== 1).map((w) => `wallet signature ${w.txHash.slice(0, 8)}`);
  return [...events, ...signatures];
}
