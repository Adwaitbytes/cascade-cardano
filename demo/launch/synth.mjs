// Synthesizes the film's score and UI sound design from scratch (no samples, no third-party audio),
// so the soundtrack is original work. Cue times mirror the GSAP timeline in index.html.
// Writes assets/audio/score.wav (48 kHz stereo, 16-bit). mix.sh adds the voiceover and normalizes.
import { writeFileSync, mkdirSync } from "node:fs";

const SR = 48000;
const DUR = 30;
const N = SR * DUR;
const L = new Float32Array(N);
const R = new Float32Array(N);
const music = { L: new Float32Array(N), R: new Float32Array(N) };

// Deterministic noise.
let seed = 1234567;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function add(buf, t0, samples, pan = 0) {
  const i0 = Math.round(t0 * SR);
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < samples.length; i++) {
    const j = i0 + i;
    if (j < 0 || j >= N) continue;
    buf.L[j] += samples[i] * gl;
    buf.R[j] += samples[i] * gr;
  }
}

// --- Score -------------------------------------------------------------------------------------
// Four airy chords, two bars each at 96 bpm, then a resolve on the logo.
const CHORDS = [
  [50, 57, 62, 66, 69, 73, 76], // Dmaj9
  [47, 54, 59, 62, 66, 69, 73], // Bm9
  [43, 50, 59, 62, 66, 69, 74], // Gmaj9
  [45, 52, 57, 62, 64, 69, 71], // A6sus
];
const BAR = 2.5;
const chordAt = (t) => (t >= 27.15 ? CHORDS[0] : CHORDS[Math.floor(t / (2 * BAR)) % 4]);

function pad(t0, dur, notes, gain) {
  const n = Math.round((dur + 2.5) * SR);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 1.2) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.8));
    let s = 0;
    for (const m of notes.slice(1)) {
      const f = hz(m);
      s += Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.003 * t + 1.3) + 0.18 * Math.sin(2 * Math.PI * f * 2.001 * t);
    }
    lp += 0.08 * (s - lp);
    out[i] = lp * env * gain;
  }
  return out;
}

function pluck(f, gain) {
  const n = Math.round(1.4 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.32);
    out[i] = gain * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f * t) * Math.exp(-t / 0.08));
  }
  return out;
}

function sub(f, dur, gain) {
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.05) * Math.min(1, (dur - t) / 0.2);
    out[i] = gain * env * Math.sin(2 * Math.PI * f * t);
  }
  return out;
}

function kick(gain) {
  const n = Math.round(0.4 * SR);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (48 + 70 * Math.exp(-t / 0.035))) / SR;
    out[i] = gain * Math.sin(ph) * Math.exp(-t / 0.14);
  }
  return out;
}

function hat(gain) {
  const n = Math.round(0.06 * SR);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = rnd();
    out[i] = gain * (x - prev) * Math.exp(-i / SR / 0.018);
    prev = x;
  }
  return out;
}

// Pads: one per two-bar chord, plus the resolve.
for (let c = 0; c < 6; c++) {
  const t0 = c * 2 * BAR;
  if (t0 >= 27.15) break;
  add(music, t0, pad(t0, Math.min(2 * BAR, 27.15 - t0) + 0.3, CHORDS[c % 4], 0.032), 0);
}
add(music, 27.15, pad(27.15, 2.85, [38, 50, 57, 62, 66, 69, 73, 76], 0.034), 0);

// Arpeggio from the reveal on, eighth notes, until the URL bar.
const E8 = 60 / 96 / 2;
for (let t = 4.3, k = 0; t < 24.6; t += E8, k++) {
  const ch = chordAt(t);
  const order = [3, 4, 5, 6, 5, 4];
  const m = ch[order[k % order.length]] + 12;
  add(music, t, pluck(hz(m), t < 8.3 ? 0.035 : 0.05), k % 2 ? 0.35 : -0.35);
}
// Sub and pulse through the product beats.
for (let t = 8.3; t < 24.6; t += BAR) add(music, t, sub(hz(chordAt(t)[0] - 12), BAR, 0.11), 0);
for (let t = 8.3, k = 0; t < 24.6; t += E8 * 2, k++) {
  add(music, t, kick(t < 10.05 ? 0.12 : 0.2), 0);
  add(music, t + E8, hat(0.05), 0.2);
}
// The CTA keeps only the pad and a soft high arp so the typing reads.
for (let t = 25.0, k = 0; t < 27.0; t += E8, k++) add(music, t, pluck(hz(CHORDS[3][3 + (k % 4)] + 24), 0.022), k % 2 ? 0.4 : -0.4);

// --- Sound design ------------------------------------------------------------------------------
const sfx = { L: new Float32Array(N), R: new Float32Array(N) };

function whoosh(dur, gain, rise = false) {
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  let bp = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const env = rise ? Math.pow(x, 2) * Math.min(1, (1 - x) / 0.05) : Math.sin(Math.PI * Math.pow(x, 0.6));
    const cut = rise ? 0.02 + 0.2 * x : 0.03 + 0.18 * Math.sin(Math.PI * x);
    lp += cut * (rnd() - lp);
    bp += cut * (lp - bp);
    out[i] = gain * env * (lp - bp) * 6;
  }
  return out;
}
function click(gain) {
  const n = Math.round(0.05 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = gain * (Math.sin(2 * Math.PI * 2100 * t) * Math.exp(-t / 0.004) + 0.6 * Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t / 0.01));
  }
  return out;
}
function blip(f, gain, decay = 0.09) {
  const n = Math.round(0.5 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = gain * Math.min(1, t / 0.002) * Math.exp(-t / decay) * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * 2 * f * t));
  }
  return out;
}
function bell(f, gain, decay = 1.6) {
  const n = Math.round(3 * SR);
  const out = new Float32Array(n);
  const parts = [[1, 1], [2.76, 0.35], [5.4, 0.12], [8.93, 0.05]];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (const [m, a] of parts) s += a * Math.sin(2 * Math.PI * f * m * t) * Math.exp(-t / (decay / m));
    out[i] = gain * Math.min(1, t / 0.003) * s;
  }
  return out;
}

[2.0, 3.95, 7.95, 15.24, 19.95, 24.66].forEach((t, i) => add(sfx, t - 0.08, whoosh(0.5, 0.11), i % 2 ? 0.3 : -0.3));
add(sfx, 3.55, whoosh(0.8, 0.09, true), 0);
add(sfx, 4.3, bell(hz(74), 0.06), 0);
add(sfx, 4.3, bell(hz(81), 0.035), 0.2);
add(sfx, 10.05, click(0.22), 0.1);
for (let i = 0; i < 5; i++) add(sfx, 10.08 + i * 0.06, blip(hz(79 + [0, 2, 4, 7, 9][i]), 0.045, 0.06), -0.5 + i * 0.25);
for (let i = 0; i < 4; i++) add(sfx, 13.4 + i * 0.12, blip(hz(86 + [0, 2, 4, 7][i]), 0.04, 0.12), -0.5 + i * 0.25);
add(sfx, 14.9, blip(hz(67), 0.06, 0.18), 0.5);
add(sfx, 17.25, blip(hz(81), 0.05, 0.12), 0);
add(sfx, 17.37, blip(hz(88), 0.05, 0.25), 0);
[20.35, 21.4, 22.45].forEach((t, i) => add(sfx, t, blip(hz(76 + i * 3), 0.045, 0.14), 0));
for (let i = 0; i < 30; i++) add(sfx, 25.45 + i * 0.032, click(0.035 + 0.01 * ((i * 7) % 3)), ((i * 5) % 7) / 7 - 0.5);
add(sfx, 26.45, whoosh(1.3, 0.16), 0);
add(sfx, 27.15, bell(hz(62), 0.04, 2.4), -0.15);
add(sfx, 27.15, bell(hz(69), 0.03, 2.4), 0.15);
add(sfx, 27.2, bell(hz(78), 0.02, 2.4), 0);

// --- Reverb (small Schroeder network) on music + sfx ------------------------------------------
function reverb(inL, inR, mix) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356];
  const aps = [225, 556];
  const run = (input, spread) => {
    const out = new Float32Array(N);
    for (const d0 of combs) {
      const d = d0 + spread;
      const buf = new Float32Array(d);
      let idx = 0, lp = 0;
      for (let i = 0; i < N; i++) {
        const y = buf[idx];
        lp = y * 0.7 + lp * 0.3;
        buf[idx] = input[i] + lp * 0.86;
        out[i] += y / combs.length;
        idx = (idx + 1) % d;
      }
    }
    for (const d0 of aps) {
      const d = d0 + spread;
      const buf = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < N; i++) {
        const b = buf[idx];
        const y = -out[i] + b;
        buf[idx] = out[i] + b * 0.5;
        out[i] = y;
        idx = (idx + 1) % d;
      }
    }
    return out;
  };
  const wl = run(inL, 0), wr = run(inR, 23);
  for (let i = 0; i < N; i++) { inL[i] += wl[i] * mix; inR[i] += wr[i] * mix; }
}
reverb(music.L, music.R, 0.5);
reverb(sfx.L, sfx.R, 0.3);

// Music ducks under the voiceover (speech 27.3 to 29.7) and fades at the tail.
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const duck = t > 27.1 && t < 29.8 ? 0.4 : 1;
  const fadeIn = Math.min(1, t / 0.4);
  const fadeOut = Math.min(1, (DUR - t) / 1.2);
  L[i] = (music.L[i] * duck + sfx.L[i]) * fadeIn * fadeOut;
  R[i] = (music.R[i] * duck + sfx.R[i]) * fadeIn * fadeOut;
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = peak > 0 ? 0.89 / peak : 1;
const pcm = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), i * 4);
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), i * 4 + 2);
}
const h = Buffer.alloc(44);
h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
mkdirSync("assets/audio", { recursive: true });
writeFileSync("assets/audio/score.wav", Buffer.concat([h, pcm]));
console.log(`wrote assets/audio/score.wav, peak ${peak.toFixed(3)}`);
