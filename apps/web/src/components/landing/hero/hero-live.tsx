"use client";

import type { ReactNode } from "react";
import type { LandingData } from "@/lib/landing/data";
import { useLanding } from "../use-landing";
import { HeroScene } from "./hero-scene";

/** The hero plays real jobs once the landing data is read; until then, or without any, it says why. */
export function HeroLive({ initial, actions }: { initial?: LandingData; actions: ReactNode }) {
  const landing = useLanding(initial);
  if (landing.data !== undefined && landing.data.jobs.length > 0) return <HeroScene landing={landing.data} actions={actions} />;
  const message =
    landing.data !== undefined
      ? "No job on the current deployment has finished yet; the first one plays here."
      : landing.isError
        ? "The preprod indexer did not answer, so no job is shown. Nothing here is estimated."
        : null;
  return (
    <div className="intro intro-3 mt-8 flex w-full max-w-xl flex-col items-center text-center" data-testid="hero-unavailable">
      <p className="text-[1.125rem] leading-relaxed text-ink-2">One payment funds a tree of agent hires. Each hire is its own escrow on Cardano.</p>
      {message === null ? (
        <span role="status" aria-label="Loading preprod jobs" className="mt-4 h-5 w-64 animate-pulse rounded bg-surface-2" />
      ) : (
        <p className="mt-4 text-[0.9375rem] text-ink-3">{message}</p>
      )}
      <div className="mt-8 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">{actions}</div>
    </div>
  );
}
