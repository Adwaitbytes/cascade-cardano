import { describe, expect, it } from "vitest";
import { DemoManifest, spedUpMoments, timelineGaps } from "./demo-manifest.js";

const TX = "a".repeat(64);
const TX2 = "b".repeat(64);

/** 0-60 s real time, 60-300 s of raw footage at 8x (30 s), then 30 s real time: 120 s of video. */
const segments = [
  { start: 0, end: 60, factor: 1, rawStart: 0, rawEnd: 60 },
  { start: 60, end: 90, factor: 8, rawStart: 60, rawEnd: 300 },
  { start: 90, end: 120, factor: 1, rawStart: 300, rawEnd: 330 },
];

function manifest(over: Record<string, unknown> = {}) {
  return DemoManifest.parse({
    dryRun: false,
    rehearsal: false,
    recordedAt: "2026-10-04T10:00:00.000Z",
    treeId: "c".repeat(56),
    fundTx: TX,
    walletSigned: [{ txHash: TX, submitted: true, at: 20, factor: 1, link: `https://preprod.cardanoscan.io/transaction/${TX}` }],
    events: [
      { type: "tree.funded", node: "c".repeat(56), tx: TX, at: 30, factor: 1 },
      { type: "node.submitted", node: "d".repeat(56), tx: TX2, at: 70, factor: 8 },
    ],
    segments,
    outputSeconds: 120,
    failure: null,
    ...over,
  });
}

describe("demo manifest (demo/record.ts format)", () => {
  it("parses the recorder's shape and refuses the old boolean walletSigned and from/speed segments", () => {
    expect(() => manifest()).not.toThrow();
    expect(() => manifest({ walletSigned: true })).toThrow();
    expect(() => manifest({ segments: [{ from: 0, speed: 1 }] })).toThrow();
    expect(() => manifest({ events: [{ type: "tree.funded", node: "x", tx: TX }] })).toThrow();
  });

  it("accepts a timeline that only changes speed", () => {
    expect(timelineGaps(manifest())).toEqual([]);
  });

  it("flags cut raw footage, a video gap, dropped frames inside a segment, a late start and a length mismatch", () => {
    const cutRaw = manifest({ segments: [segments[0], { ...segments[1], rawStart: 90, end: 86.25 }, { ...segments[2], start: 86.25, end: 116.25 }], outputSeconds: 116 });
    expect(timelineGaps(cutRaw)).toEqual(["raw footage 60-90 is cut"]);
    expect(timelineGaps(manifest({ segments: [segments[0], { ...segments[1], start: 61, end: 91 }, { ...segments[2], start: 91, end: 121 }], outputSeconds: 121 }))).toEqual(["gap in the video between segments 0 and 1"]);
    expect(timelineGaps(manifest({ segments: [segments[0], { ...segments[1], end: 80 }, { ...segments[2], start: 80, end: 110 }], outputSeconds: 110 }))[0]).toMatch(/segment 1 drops footage/);
    expect(timelineGaps(manifest({ segments: [{ ...segments[0], start: 5, rawStart: 5 }, ...segments.slice(1)] }))).toContain("the first segment does not start at 0");
    expect(timelineGaps(manifest({ outputSeconds: 150 }))).toEqual(["segments end at 120 s, the video lasts 150 s"]);
    expect(timelineGaps(manifest({ segments: [] }))).toEqual(["no segments"]);
    expect(timelineGaps(manifest({ segments: [{ ...segments[0], factor: 0.5, end: 120 }], outputSeconds: 120 }))).toContain("segment 0 has speed 0.5");
  });

  it("allows non-money events in a time-lapse but no money movement or wallet signature", () => {
    expect(spedUpMoments(manifest())).toEqual([]);
    const fastFund = manifest({ events: [{ type: "tree.funded", node: "c".repeat(56), tx: TX, at: 70, factor: 8 }] });
    expect(spedUpMoments(fastFund)).toEqual([`tree.funded ${TX.slice(0, 8)}`]);
    // An event that claims real time but sits inside a fast segment is still caught.
    const misreported = manifest({ events: [{ type: "node.settled", node: "d".repeat(56), tx: TX2, at: 75, factor: 1 }] });
    expect(spedUpMoments(misreported)).toEqual([`node.settled ${TX2.slice(0, 8)}`]);
    const fastSign = manifest({ walletSigned: [{ txHash: TX, submitted: true, at: 65, factor: 8 }] });
    expect(spedUpMoments(fastSign)).toEqual([`wallet signature ${TX.slice(0, 8)}`]);
  });
});
