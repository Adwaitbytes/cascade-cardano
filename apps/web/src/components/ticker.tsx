"use client";

import { useEffect, useRef, useState } from "react";
import { describeAmount, formatAmount } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { usePrefersReducedMotion } from "@/hooks/use-tree";

const DURATION_MS = 650;

/**
 * An amount that counts from its previous value to the new one when it changes. The tween is
 * display only: it runs in base units as bigint steps and always lands on the exact value.
 */
export function AmountTicker({ value, asset, className }: { value: bigint; asset: string; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (reduced || start === value) {
      setShown(value);
      return;
    }
    let frame = 0;
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / DURATION_MS);
      const eased = 1 - (1 - p) ** 3;
      const scaled = BigInt(Math.round(eased * 1_000_000));
      setShown(p >= 1 ? value : start + ((value - start) * scaled) / 1_000_000n);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);
  return (
    <span className={cn("tabular whitespace-nowrap", className)} title={describeAmount(value, asset)}>
      <span className="sr-only">{formatAmount(value, asset)}</span>
      <span aria-hidden>{formatAmount(shown, asset)}</span>
    </span>
  );
}

/** Whole numbers that count up the same way. */
export function CountTicker({ value, className }: { value: number; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (reduced || start === value) {
      setShown(value);
      return;
    }
    let frame = 0;
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / DURATION_MS);
      setShown(Math.round(start + (value - start) * (1 - (1 - p) ** 3)));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);
  return (
    <span className={cn("tabular", className)}>
      <span className="sr-only">{value.toLocaleString("en-US")}</span>
      <span aria-hidden>{shown.toLocaleString("en-US")}</span>
    </span>
  );
}
