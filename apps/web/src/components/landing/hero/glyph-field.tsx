"use client";

import { useEffect, useRef } from "react";

/*
 * The hero backdrop: a grid of tiny glyphs (dots, rings, squares) drawn in one WebGL point call.
 * A slow wave travels through it, an opening ripple reveals it from the stage centre, the cursor
 * leaves a short lit trail, and the field thins out behind any element marked data-field-quiet.
 * Without WebGL the canvas hides itself and the CSS halftone stays.
 */

const TRAIL = 16;
const QUIET = 6;

const VERTEX = `
precision highp float;
attribute vec3 aPoint;
uniform vec2 uSize, uDrift;
uniform float uTime, uDpr, uCell, uOpen;
uniform vec2 uOrigin;
uniform vec3 uTrail[${TRAIL}];
uniform vec4 uQuiet[${QUIET}];
varying float vAlpha, vHeat, vKind;

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.001), 0.0, 1.0);
  return length(p - a - t * ab);
}

void main() {
  vec2 p = aPoint.xy + uDrift;
  float wave = 0.5 + 0.32 * sin(p.x * 0.011 + p.y * 0.007 - uTime * 0.7) + 0.18 * sin(-p.x * 0.005 + p.y * 0.013 - uTime * 0.41);

  float ripple = 0.0;
  float reveal = 1.0;
  if (uOpen >= 0.0) {
    vec2 radial = p - uOrigin;
    float dist = length(radial);
    float radius = uOpen * length(uSize) * 0.2;
    ripple = exp(-pow((dist - radius) / 64.0, 2.0)) * (1.0 - smoothstep(2.6, 4.2, uOpen));
    reveal = mix(1.0 - smoothstep(radius - 120.0, radius + 60.0, dist), 1.0, smoothstep(2.8, 4.2, uOpen));
    p += radial / max(dist, 1.0) * ripple * 5.0;
  }

  float heat = 0.0;
  for (int i = 0; i < ${TRAIL - 1}; i++) {
    float life = min(uTrail[i].z, uTrail[i + 1].z);
    if (life > 0.0) heat = max(heat, exp(-pow(segment(p, uTrail[i].xy, uTrail[i + 1].xy) / 22.0, 2.0)) * life);
  }

  float quiet = 1.0;
  for (int i = 0; i < ${QUIET}; i++) {
    vec4 r = uQuiet[i];
    if (r.z > 0.0) {
      vec2 outside = max(abs(p - r.xy) - r.zw, vec2(0.0));
      quiet = min(quiet, 0.12 + 0.88 * smoothstep(0.0, 90.0, length(outside)));
    }
  }

  float edge = smoothstep(40.0, 160.0, p.y) * (1.0 - smoothstep(uSize.y - 220.0, uSize.y, p.y));
  float present = step(0.12, aPoint.z);
  vAlpha = ((0.03 + 0.26 * pow(wave, 1.7)) * reveal + ripple * 0.32) * quiet * edge * present;
  vHeat = max(heat, ripple * 0.5) * edge * present * mix(0.35, 1.0, quiet);
  vKind = mod(floor(aPoint.z * 37.0), 3.0);

  gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, 0.0, 1.0);
  gl_PointSize = (min(uCell * 0.8, 5.0) + ripple * 0.8 + heat * 0.9) * uDpr;
}`;

const FRAGMENT = `
precision mediump float;
uniform vec3 uBase, uHot;
varying float vAlpha, vHeat, vKind;

float box(vec2 p, float r) { return 1.0 - smoothstep(r - 0.05, r + 0.05, max(abs(p.x), abs(p.y))); }

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  float glyph;
  if (vKind < 0.5) glyph = 1.0 - smoothstep(0.16, 0.24, d);
  else if (vKind < 1.5) glyph = (1.0 - smoothstep(0.34, 0.42, d)) * smoothstep(0.13, 0.2, d);
  else glyph = box(p, 0.22);
  float a = glyph * mix(vAlpha, 0.85, vHeat);
  gl_FragColor = vec4(mix(uBase, uHot, vHeat) * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

type Rgb = [number, number, number];

/** Resolves a token like var(--accent) to 0..1 RGB. The tokens are hex, so the computed value is rgb(). */
function cssRgb(probe: HTMLElement, value: string): Rgb {
  probe.style.color = value;
  const m = getComputedStyle(probe).color.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (m === null) return [0.2, 0.4, 0.34];
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

export function GlyphField({ originSelector }: { originSelector: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (canvas === null || host === null || host === undefined) return;
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: "low-power" });
    if (gl === null) {
      canvas.hidden = true;
      return;
    }

    let program: WebGLProgram | null = null;
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    try {
      vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
      fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      program = gl.createProgram();
      if (program === null) throw new Error("createProgram failed");
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    } catch (error) {
      // The field is decoration; the CSS halftone carries the look without it.
      console.warn("Hero glyph field disabled:", error);
      if (vs !== null) gl.deleteShader(vs);
      if (fs !== null) gl.deleteShader(fs);
      if (program !== null) gl.deleteProgram(program);
      canvas.hidden = true;
      return;
    }
    const prog = program;
    gl.useProgram(prog);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const aPoint = gl.getAttribLocation(prog, "aPoint");
    gl.enableVertexAttribArray(aPoint);
    gl.vertexAttribPointer(aPoint, 3, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, name);
    const loc = {
      size: u("uSize"), drift: u("uDrift"), time: u("uTime"), dpr: u("uDpr"), cell: u("uCell"), open: u("uOpen"), origin: u("uOrigin"),
      trail: u("uTrail[0]"), quiet: u("uQuiet[0]"), base: u("uBase"), hot: u("uHot"),
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarse = window.matchMedia("(pointer: coarse)");
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.append(probe);

    let width = 1;
    let height = 1;
    let count = 0;
    let dpr = 1;
    let cell = 7;
    let visible = true;
    let frame = 0;
    let last = 0;
    let time = 0;
    let opening = reduced.matches || window.scrollY > 120 ? -1 : 0;
    let origin: [number, number] = [0, 0];
    let drift: [number, number] = [0, 0];
    let driftTarget: [number, number] = [0, 0];
    let trail: TrailPoint[] = [];
    const packedTrail = new Float32Array(TRAIL * 3);
    const quiet = new Float32Array(QUIET * 4);

    const paintColours = (): void => {
      const accent = cssRgb(probe, "var(--accent)");
      gl.uniform3fv(loc.base, mix(cssRgb(probe, "var(--ink)"), accent, 0.45));
      gl.uniform3fv(loc.hot, accent);
    };

    const measure = (): void => {
      const box = host.getBoundingClientRect();
      quiet.fill(0);
      [...host.querySelectorAll<HTMLElement>("[data-field-quiet]")].slice(0, QUIET).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        quiet.set([r.left - box.left + r.width / 2, r.top - box.top + r.height / 2, r.width / 2 + 6, r.height / 2 + 4], i * 4);
      });
      const o = host.querySelector(originSelector)?.getBoundingClientRect();
      origin = o === undefined ? [width / 2, height * 0.55] : [o.left - box.left + o.width / 2, o.top - box.top + o.height / 2];
    };

    const resize = (): void => {
      width = host.clientWidth;
      height = host.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      cell = coarse.matches ? 9 : 7;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const pts: number[] = [];
      let seed = 97;
      for (let y = -cell; y < height + cell; y += cell) {
        for (let x = -cell; x < width + cell; x += cell) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          pts.push(x, y, seed / 4294967296);
        }
      }
      count = pts.length / 3;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
      measure();
      draw(performance.now());
    };

    const draw = (now: number): void => {
      const dt = last === 0 ? 0 : Math.min((now - last) / 1000, 0.05);
      last = now;
      const moving = !reduced.matches;
      if (moving) time += dt;
      if (opening >= 0) {
        opening += dt;
        if (opening > 4.2) opening = -1;
      }
      const ease = 1 - Math.exp(-dt * 5);
      drift = [drift[0] + (driftTarget[0] - drift[0]) * ease, drift[1] + (driftTarget[1] - drift[1]) * ease];
      trail = trail.filter((p) => now - p.t < 900);
      packedTrail.fill(0);
      trail.forEach((p, i) => packedTrail.set([p.x, p.y, 1 - (now - p.t) / 900], i * 3));

      gl.uniform2f(loc.size, width, height);
      gl.uniform2f(loc.drift, drift[0], drift[1]);
      gl.uniform1f(loc.time, time);
      gl.uniform1f(loc.dpr, dpr);
      gl.uniform1f(loc.cell, cell);
      gl.uniform1f(loc.open, moving ? opening : -1);
      gl.uniform2f(loc.origin, origin[0], origin[1]);
      gl.uniform3fv(loc.trail, packedTrail);
      gl.uniform4fv(loc.quiet, quiet);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, count);
    };

    const loop = (now: number): void => {
      frame = 0;
      if (!visible || document.hidden || reduced.matches) {
        last = 0;
        return;
      }
      draw(now);
      frame = requestAnimationFrame(loop);
    };
    const start = (): void => {
      if (frame === 0 && visible && !document.hidden && !reduced.matches) frame = requestAnimationFrame(loop);
    };

    const onPointer = (e: PointerEvent): void => {
      if (e.pointerType === "touch" || reduced.matches) return;
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      driftTarget = [(x / width - 0.5) * -14, (y / height - 0.5) * -10];
      const prev = trail[trail.length - 1];
      const now = performance.now();
      if (prev === undefined || Math.hypot(x - prev.x, y - prev.y) > 6 || now - prev.t > 40) {
        trail.push({ x, y, t: now });
        if (trail.length > TRAIL) trail.shift();
      }
    };
    const onLeave = (): void => {
      driftTarget = [0, 0];
    };

    paintColours();
    resize();
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(host);
    const viewObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      start();
    });
    viewObserver.observe(host);
    const themeObserver = new MutationObserver(() => {
      paintColours();
      draw(performance.now());
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = (): void => {
      paintColours();
      draw(performance.now());
    };
    const onVisibility = (): void => start();
    const onMotion = (): void => {
      opening = -1;
      draw(performance.now());
      start();
    };
    scheme.addEventListener("change", onScheme);
    reduced.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
    host.addEventListener("pointermove", onPointer, { passive: true });
    host.addEventListener("pointerleave", onLeave);
    // Fonts shift the headline after first paint; re-measure the quiet zones once they land.
    void document.fonts.ready.then(measure);
    start();

    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      viewObserver.disconnect();
      themeObserver.disconnect();
      scheme.removeEventListener("change", onScheme);
      reduced.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
      host.removeEventListener("pointermove", onPointer);
      host.removeEventListener("pointerleave", onLeave);
      probe.remove();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(prog);
      if (vs !== null) gl.deleteShader(vs);
      if (fs !== null) gl.deleteShader(fs);
    };
  }, [originSelector]);

  return <canvas ref={canvasRef} aria-hidden className="glyph-field pointer-events-none absolute inset-0 h-full w-full" />;
}
