/**
 * Turns Playwright's raw recording into the final MP4. Nothing is cut: long waits for preprod
 * blocks are sped up (the overlay shows the speed while it applies), every other second plays at
 * real time.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Segment {
  /** Seconds from the start of the raw video. */
  from: number;
  speed: number;
}

/** Records speed changes against the wall clock from the moment the page (and its video) opened. */
export class Timeline {
  readonly startMs = Date.now();
  readonly segments: Segment[] = [{ from: 0, speed: 1 }];

  now(): number {
    return (Date.now() - this.startMs) / 1000;
  }

  setSpeed(speed: number): void {
    const last = this.segments[this.segments.length - 1];
    if (last !== undefined && last.speed === speed) return;
    this.segments.push({ from: this.now(), speed });
  }
}

export interface OutputSegment {
  /** Seconds in the final video. */
  start: number;
  end: number;
  /** 1 is real time; above 1 is a labelled time-lapse of idle waiting. */
  factor: number;
  rawStart: number;
  rawEnd: number;
}

/** The speed segments as they land in the final video (the encoder drops nothing). */
export function outputSegments(segments: readonly Segment[], rawTotal: number): OutputSegment[] {
  const out: OutputSegment[] = [];
  let at = 0;
  segments.forEach((s, i) => {
    const rawEnd = Math.min(segments[i + 1]?.from ?? rawTotal, rawTotal);
    if (rawEnd - s.from <= 0.05) return;
    const len = (rawEnd - s.from) / s.speed;
    out.push({ start: round(at), end: round(at + len), factor: s.speed, rawStart: round(s.from), rawEnd: round(rawEnd) });
    at += len;
  });
  return out;
}

/** Maps a moment of the raw recording to seconds in the final video. */
export function outputTime(segments: readonly OutputSegment[], raw: number): { at: number; factor: number } {
  const seg = segments.find((s) => raw >= s.rawStart && raw < s.rawEnd) ?? segments[segments.length - 1];
  if (seg === undefined) return { at: 0, factor: 1 };
  return { at: round(seg.start + (Math.min(raw, seg.rawEnd) - seg.rawStart) / seg.factor), factor: seg.factor };
}

const round = (x: number): number => Math.round(x * 100) / 100;

export function rawDuration(path: string): number {
  return ffprobeDuration(path);
}

function ffprobeDuration(path: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { encoding: "utf8" });
  const d = Number(r.stdout.trim());
  if (r.status !== 0 || !Number.isFinite(d)) throw new Error(`ffprobe failed on ${path}: ${r.stderr}`);
  return d;
}

/**
 * Encodes `raw` (webm) to `out` (H.264 MP4, 30 fps). Each segment is encoded on its own, sped up
 * with setpts when its speed is above 1, then the parts are joined with the concat demuxer, so no
 * frame range is dropped. Returns the output duration in seconds.
 */
export function encode(raw: string, out: string, segments: readonly Segment[], workDir: string): number {
  mkdirSync(workDir, { recursive: true });
  const total = ffprobeDuration(raw);
  const parts = segments
    .map((s, i) => ({ from: s.from, to: Math.min(segments[i + 1]?.from ?? total, total), speed: s.speed }))
    .filter((p) => p.to - p.from > 0.05);
  const files: string[] = [];
  parts.forEach((p, i) => {
    const file = join(workDir, `part-${String(i).padStart(3, "0")}.mp4`);
    run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-ss", p.from.toFixed(3), "-to", p.to.toFixed(3), "-i", raw,
      "-vf", `setpts=PTS/${p.speed},fps=30,format=yuv420p`,
      "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "20", file,
    ]);
    files.push(file);
  });
  const list = join(workDir, "parts.txt");
  writeFileSync(list, files.map((f) => `file '${f}'`).join("\n") + "\n");
  run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  return ffprobeDuration(out);
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
}

/** A still frame for the deck's poster image. */
export function posterFrame(video: string, atSeconds: number, out: string): void {
  run("ffmpeg", ["-y", "-loglevel", "error", "-ss", atSeconds.toFixed(2), "-i", video, "-frames:v", "1", out]);
}
