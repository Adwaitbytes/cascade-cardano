"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { PHASE_START, PHASES, phaseAt, SCENARIO_MS, type Phase } from "@/lib/landing/scenarios";

/** Hold the first lock a moment longer so the opening entrance finishes before money moves. */
const FIRST_DELAY_MS = 1400;

function nextBoundary(ms: number): number {
  for (const p of PHASES) if (PHASE_START[p] > ms) return PHASE_START[p];
  return SCENARIO_MS;
}

/**
 * Plays `count` hero jobs on a clock that only runs while the stage is on screen and the tab is
 * visible. With reduced motion nothing plays: each job is shown settled and advances on demand.
 */
export function useScenarioClock(stageRef: RefObject<HTMLElement | null>, reduced: boolean, count: number) {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("lock");
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  // Bumped on every manual jump, so picking the scenario already showing restarts its clock.
  const [epoch, setEpoch] = useState(0);
  const elapsed = useRef(-FIRST_DELAY_MS);

  useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? true), { threshold: 0.15 });
    io.observe(el);
    const onVisibility = (): void => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stageRef]);

  const running = onScreen && tabVisible && !reduced;

  useEffect(() => {
    if (reduced) {
      setPhase("settle");
      return;
    }
    if (!running) return;
    const start = performance.now() - elapsed.current;
    let timer = 0;
    const tick = (): void => {
      const ms = performance.now() - start;
      if (ms >= SCENARIO_MS) {
        elapsed.current = 0;
        setPhase("lock");
        setIndex((i) => (i + 1) % Math.max(1, count));
        return;
      }
      elapsed.current = ms;
      setPhase(phaseAt(ms));
      timer = window.setTimeout(tick, nextBoundary(ms) - ms + 4);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [running, reduced, index, epoch, count]);

  const goTo = useCallback(
    (i: number): void => {
      elapsed.current = 0;
      setPhase(reduced ? "settle" : "lock");
      const n = Math.max(1, count);
      setIndex(((i % n) + n) % n);
      setEpoch((e) => e + 1);
    },
    [reduced, count],
  );

  return { index, phase, goTo };
}
