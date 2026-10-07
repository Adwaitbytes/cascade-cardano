import Link from "next/link";
import { LogoTile } from "@/components/logo";
import { REPO_URL } from "@/lib/landing/proof";

const COLUMNS = [
  { title: "Product", links: [{ href: "/console/new", label: "New job" }, { href: "/console/history", label: "Jobs" }, { href: "/economy", label: "Network" }] },
  { title: "Build", links: [{ href: "/provider", label: "List an agent" }, { href: "/arbiter", label: "Arbiters" }, { href: "/ops", label: "Status" }] },
] as const;

const SOURCE = [
  { href: REPO_URL, label: "GitHub" },
  { href: `${REPO_URL}#every-redeemer-on-preprod`, label: "Redeemer proofs" },
  { href: `${REPO_URL}/blob/main/docs/sokosumi-coworker.md`, label: "Sokosumi Coworker" },
] as const;

export function SiteFooter() {
  return (
    <footer className="footer-dots relative overflow-hidden bg-[#0b0b0c] text-[#f2f2f0]">
      <div className="relative mx-auto grid max-w-[1440px] grid-cols-2 gap-x-6 gap-y-10 px-4 pt-16 pb-10 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:gap-12 md:pt-20 lg:px-10">
        <div className="col-span-2 max-w-sm md:col-span-1">
          <div className="flex items-center gap-2.5">
            <LogoTile className="size-7" inverted />
            <span className="font-mono text-[1.0625rem] font-medium tracking-[-0.02em]">cascade</span>
          </div>
          <p className="mt-5 text-[0.9375rem] leading-relaxed text-[#a3a7ab]">
            Aiken escrow trees, x402 payments and Masumi interop. Every amount on this site comes from Cardano preprod. Test network only.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="font-mono text-[0.6875rem] tracking-[0.18em] text-[#7d8186] uppercase">{col.title}</p>
            <ul className="mt-2 grid md:mt-4 md:gap-2.5">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="inline-flex min-h-11 items-center text-[0.9375rem] text-[#d4d6d8] transition-colors hover:text-white md:min-h-0">{l.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
        <nav aria-label="Source">
          <p className="font-mono text-[0.6875rem] tracking-[0.18em] text-[#7d8186] uppercase">Source</p>
          <ul className="mt-2 grid md:mt-4 md:gap-2.5">
            {SOURCE.map((l) => (
              <li key={l.href}>
                <a href={l.href} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center text-[0.9375rem] text-[#d4d6d8] transition-colors hover:text-white md:min-h-0">{l.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <p aria-hidden className="footer-wordmark pointer-events-none relative -mb-[0.24em] pb-[env(safe-area-inset-bottom)] text-center font-display text-[clamp(5rem,23vw,22rem)] leading-none tracking-[-0.04em] select-none">
        cascade
      </p>
    </footer>
  );
}
