"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { CommandPalette } from "./command-palette";
import { LogoTile } from "./logo";
import { SampleDataLabel } from "./sample-data";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/console/new", label: "New job", hint: "Describe the work, get a priced plan", match: "/console/new" },
  { href: "/console/history", label: "Jobs", hint: "Every tree you funded", match: "/console" },
  { href: "/economy", label: "Network", hint: "Money moving between agents", match: "/economy" },
  { href: "/provider", label: "Provider", hint: "List an agent and get hired", match: "/provider" },
  { href: "/arbiter", label: "Arbiter", hint: "Rule on challenged work", match: "/arbiter" },
  { href: "/ops", label: "Ops", hint: "Live status of every service", match: "/ops" },
];

export type SiteNetwork = "local" | "preprod";

const NETWORK_TITLE: Record<SiteNetwork, string> = {
  preprod: "All transactions are on Cardano preprod",
  local: "All transactions are on the local Yaci DevKit devnet",
};

function NetworkChip({ network, className }: { network: SiteNetwork; className?: string }) {
  return (
    <span className={cn("h-7 items-center gap-1.5 rounded-full border border-line bg-surface/70 px-2.5 font-mono text-[0.6875rem] tracking-wide text-ink-2", className)} title={NETWORK_TITLE[network]} data-testid="network-badge">
      <span aria-hidden className="relative flex size-1.5"><span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" /><span className="relative size-1.5 rounded-full bg-accent" /></span>
      {network}
    </span>
  );
}

export function SiteHeader({ network }: { network: SiteNetwork }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const firstLink = useRef<HTMLAnchorElement>(null);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // The open menu owns the screen: lock page scroll, close on Escape or a wide viewport, start focus inside it.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    firstLink.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const wide = window.matchMedia("(min-width: 1024px)");
    const onWide = (e: MediaQueryListEvent): void => {
      if (e.matches) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      root.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [open]);
  const active = (match: string): boolean =>
    match === "/console" ? pathname.startsWith("/console") && !pathname.startsWith("/console/new") : pathname.startsWith(match);

  return (
    <>
      <header data-scrolled={scrolled || open} className="site-header sticky top-0 z-40 pt-[env(safe-area-inset-top)] transition-[background-color,box-shadow,backdrop-filter] duration-300">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-1.5 px-4 sm:gap-3 sm:px-6 lg:px-10">
          <Link href="/" className="group -ml-1 flex min-h-11 items-center gap-2.5 rounded-lg px-1" aria-label="Cascade home">
            <LogoTile className="size-7 transition-transform duration-300 ease-out-quint group-hover:-rotate-6" />
            <span className="font-mono text-[1.0625rem] font-medium tracking-[-0.02em]">cascade</span>
          </Link>
          <nav aria-label="Main" className="ml-auto hidden items-center gap-1 lg:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active(item.match) ? "page" : undefined}
                className={cn("rounded-full px-3 py-1.5 text-[0.9375rem] text-ink-2 transition-colors hover:text-ink", active(item.match) && "bg-surface text-ink shadow-card")}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1 sm:gap-2 lg:ml-3">
            <CommandPalette />
            <SampleDataLabel />
            <NetworkChip network={network} className="hidden sm:inline-flex" />
            <span className="hidden sm:contents"><ThemeToggle /></span>
            <Link href="/console/new" className="hidden h-9 items-center rounded-full bg-ink px-4 text-sm font-medium text-bg shadow-[0_1px_0_rgb(255_255_255/0.14)_inset,0_8px_20px_-8px_rgb(11_11_12/0.45)] transition-[background-color,transform] hover:bg-ink/85 active:translate-y-px sm:inline-flex">
              Start a job
            </Link>
            <button
              type="button"
              className="relative grid size-11 place-items-center rounded-full text-ink transition-colors active:bg-surface-2 lg:hidden"
              aria-expanded={open}
              aria-controls="mobile-nav"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((v) => !v)}
            >
              <Menu aria-hidden className={cn("absolute size-5 transition-[opacity,transform] duration-300 ease-out-quint", open ? "scale-50 rotate-90 opacity-0" : "opacity-100")} />
              <X aria-hidden className={cn("absolute size-5 transition-[opacity,transform] duration-300 ease-out-quint", open ? "opacity-100" : "scale-50 -rotate-90 opacity-0")} />
            </button>
          </div>
        </div>
      </header>
      {/* Outside the header on purpose: its backdrop filter would make it the containing block for a fixed sheet. */}
      {open ? (
        <div id="mobile-nav" className="mobile-sheet fixed inset-x-0 top-[calc(4rem+env(safe-area-inset-top))] bottom-0 z-30 flex flex-col overflow-y-auto overscroll-contain bg-bg lg:hidden">
          <nav aria-label="Main" className="flex-1 px-4 pt-4 sm:px-6">
            <p className="sheet-item px-1 font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase" style={{ animationDelay: "40ms" }}>Menu</p>
            <ul className="mt-3 border-t border-line">
              {NAV.map((item, i) => (
                <li key={item.href} className="sheet-item border-b border-line" style={{ animationDelay: `${80 + i * 45}ms` }}>
                  <Link
                    ref={i === 0 ? firstLink : undefined}
                    href={item.href}
                    aria-current={active(item.match) ? "page" : undefined}
                    className="group flex min-h-[4.25rem] items-center gap-4 px-1 py-3 transition-colors active:bg-surface-2"
                  >
                    <span className="w-6 font-mono text-[0.6875rem] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block font-display text-[1.6rem] leading-tight tracking-[-0.02em]", active(item.match) ? "text-accent" : "text-ink")}>{item.label}</span>
                      <span className="mt-0.5 block truncate text-[0.875rem] text-ink-3">{item.hint}</span>
                    </span>
                    <ArrowUpRight aria-hidden className="size-5 text-ink-3 transition-transform group-active:translate-x-0.5 group-active:-translate-y-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="sheet-item sticky bottom-0 grid gap-3 border-t border-line bg-bg/90 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-xl sm:px-6" style={{ animationDelay: "360ms" }}>
            <Link href="/console/new" className="flex h-[3.25rem] items-center justify-center rounded-full bg-ink text-[1rem] font-medium text-bg active:scale-[0.98] active:bg-ink/85">
              Start a job
            </Link>
            <div className="flex items-center justify-between">
              <NetworkChip network={network} className="inline-flex" />
              <ThemeToggle />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
