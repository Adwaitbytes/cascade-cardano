"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Phones only: once the hero's own buttons scroll away, a floating bar keeps the main action under
 * the thumb. It steps aside over the footer so it never covers the footer links.
 */
export function MobileCta({ demoHref }: { demoHref: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let pastHero = false;
    let footerVisible = false;
    const update = (): void => setShow(pastHero && !footerVisible);
    const onScroll = (): void => {
      pastHero = window.scrollY > window.innerHeight * 0.9;
      update();
    };
    const footer = document.querySelector("footer");
    const io = new IntersectionObserver(([entry]) => {
      footerVisible = entry?.isIntersecting ?? false;
      update();
    });
    if (footer !== null) io.observe(footer);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return (
    <div
      className={cn(
        "fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-30 transition-[opacity,transform] duration-500 ease-out-quint sm:hidden",
        show ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-[140%] opacity-0",
      )}
      aria-hidden={!show}
    >
      <div className="flex items-center gap-2 rounded-full border border-line bg-surface/85 p-1.5 shadow-pop backdrop-blur-xl">
        <Link href={demoHref} tabIndex={show ? undefined : -1} className="flex h-12 flex-1 items-center justify-center rounded-full text-[0.9375rem] font-medium text-ink active:bg-surface-2">
          Watch the demo
        </Link>
        <Link href="/console/new" tabIndex={show ? undefined : -1} className="flex h-12 flex-1 items-center justify-center rounded-full bg-ink text-[0.9375rem] font-medium text-bg active:scale-[0.98]">
          Start a job
        </Link>
      </div>
    </div>
  );
}
