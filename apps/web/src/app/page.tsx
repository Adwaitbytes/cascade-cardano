import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, BadgeCheck, GitFork, Lock, Undo2 } from "lucide-react";
import { LiveStats } from "@/components/landing/live-stats";
import { LiveTree } from "@/components/landing/live-tree";
import { OpenTree } from "@/components/landing/open-tree";
import { MobileCta } from "@/components/landing/mobile-cta";
import { ContractProof, CoworkerProof } from "@/components/landing/proof-sections";
import { RecentTrees } from "@/components/landing/recent-trees";
import { SiteFooter } from "@/components/landing/site-footer";
import { GlyphField } from "@/components/landing/hero/glyph-field";
import { HeroScene } from "@/components/landing/hero/hero-scene";
import { Button } from "@/components/ui/button";
import { getDemoTreeId } from "@/lib/api";
import { REPO_URL } from "@/lib/landing/proof";
import { deployedScripts } from "@/server/deployment";
import { loadLandingData } from "@/server/landing-page";

// Network totals and the hero jobs are read at render and refreshed at most once a minute.
export const revalidate = 60;

const STEPS = [
  { title: "Lock once", body: "The buyer funds one root escrow. Its datum commits to the Merkle root of the plan they approved.", icon: Lock },
  { title: "Hire down the tree", body: "Each agent draws child escrows for the agents it hires. The validator only lets money move into escrows that match the plan.", icon: GitFork },
  { title: "Verify before paying", body: "A node's fee is released by its parent, a verifier quorum or an expired challenge window. Never by the worker itself.", icon: BadgeCheck },
  { title: "Refund up the tree", body: "Missed deadlines refund into the parent node, where the budget is re-spent or returned to the buyer at close.", icon: Undo2 },
] as const;

const PROOFS = [
  { title: "Every node is a UTxO", body: "Each hire has its own escrow, thread token and deadlines, so hundreds of subcontracts settle in parallel." },
  { title: "Every badge is a transaction", body: "States in the explorer link to the Cardanoscan transaction that set them. Nothing is shown that the chain did not record." },
  { title: "Every receipt reconciles", body: "Deposits equal payouts plus refunds plus fees plus structural ADA returned, checked to the base unit on every receipt." },
] as const;

const LEGEND = [
  { label: "Funded", dot: "bg-funded" },
  { label: "Working", dot: "bg-working" },
  { label: "Accepted", dot: "bg-accepted" },
  { label: "Refunded", dot: "bg-refunded" },
] as const;

const demoHref = (treeId: string | null): string => (treeId !== null ? `/tree/${treeId}?replay=1` : "/console/history");

/** Shown in place of the replayed jobs when the indexer did not answer or has no finished job yet. */
function HeroUnavailable({ reachable, actions }: { reachable: boolean; actions: ReactNode }) {
  return (
    <div className="intro intro-3 mt-8 flex w-full max-w-xl flex-col items-center text-center" data-testid="hero-unavailable">
      <p className="text-[1.125rem] leading-relaxed text-ink-2">
        {reachable
          ? "One payment funds a tree of agent hires. No job on the current deployment has finished yet; the first one plays here."
          : "One payment funds a tree of agent hires. The preprod indexer did not answer, so no job is shown. Nothing here is estimated."}
      </p>
      <div className="mt-8 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">{actions}</div>
    </div>
  );
}

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase ${className ?? ""}`}>{children}</p>;
}

export default async function Home() {
  const [configuredDemo, landing] = await Promise.all([getDemoTreeId(), loadLandingData()]);
  const demoTreeId = configuredDemo ?? landing?.hero_tree_id ?? null;
  const actions = (
    <>
      <Button size="lg" asChild>
        <Link href="/console/new">Start a job</Link>
      </Button>
      <Button size="lg" variant="secondary" asChild>
        <Link href={demoHref(demoTreeId)}>{demoTreeId !== null ? "Watch the demo tree" : "Browse funded trees"}</Link>
      </Button>
    </>
  );
  return (
    <div className="overflow-x-clip">
      <section className="hero relative">
        <div aria-hidden className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-[1000px]" />
        <GlyphField originSelector=".vault" />
        <div className="relative mx-auto flex max-w-[1440px] flex-col items-center px-4 pt-8 pb-20 sm:px-6 lg:px-10 lg:pt-12">
          <Link href={demoHref(demoTreeId)} data-field-quiet className="intro intro-1 group inline-flex items-center gap-2 rounded-full border border-line bg-surface/80 px-3.5 py-1.5 font-mono text-[0.75rem] tracking-[0.06em] whitespace-nowrap text-ink-2 shadow-card backdrop-blur transition-colors hover:text-ink">
            <span className="hidden sm:inline">aiken escrow</span>
            <span aria-hidden className="hidden text-ink-3 sm:inline">·</span>
            <span>x402 payments</span>
            <span aria-hidden className="text-ink-3">·</span>
            <span>live on preprod</span>
            <ArrowUpRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
          <h1 data-field-quiet className="intro intro-2 mt-6 text-center font-display text-[clamp(2.5rem,5.4vw,4.6rem)] leading-[1.02] font-medium tracking-[-0.03em]">
            Escrow trees for agent work
          </h1>
          {landing !== null && landing.jobs.length > 0 ? (
            <HeroScene landing={landing} actions={actions} />
          ) : (
            <HeroUnavailable reachable={landing !== null} actions={actions} />
          )}
        </div>
      </section>

      <section aria-labelledby="live" className="reveal mx-auto max-w-[1440px] px-4 pb-24 sm:px-6 lg:px-10">
        <div className="flex flex-col items-center text-center">
          <Eyebrow>Live · replayed from indexed chain events</Eyebrow>
          <h2 id="live" className="mt-4 max-w-2xl text-[clamp(1.8rem,3.6vw,2.75rem)] leading-[1.08] font-semibold tracking-[-0.035em]">A real tree, exactly as the chain recorded it.</h2>
        </div>
        <figure className="mt-10 rounded-[28px] border border-line bg-surface/90 p-4 shadow-pop backdrop-blur-sm sm:p-6">
          <figcaption className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[0.8125rem]">
            <span className="inline-flex items-center gap-2 font-medium">
              <span aria-hidden className="relative flex size-2"><span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" /><span className="relative size-2 rounded-full bg-accent" /></span>
              Preprod tree replay
              <span className="font-normal text-ink-3">· the tree with the most settled nodes</span>
            </span>
            <span className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.75rem] text-ink-3">
              {LEGEND.map((l) => (
                <span key={l.label} className="inline-flex items-center gap-1.5"><span aria-hidden className={`size-2 rounded-full ${l.dot}`} />{l.label.toLowerCase()}</span>
              ))}
            </span>
          </figcaption>
          <LiveTree treeId={landing?.hero_tree_id ?? null} indexerDown={landing === null} />
        </figure>
        <div className="mt-14">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h3 className="text-[1.375rem] font-semibold tracking-[-0.025em]">Newest trees on the current deployment</h3>
            <Link href="/console/history" className="text-[0.9375rem] font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink">Every tree</Link>
          </div>
          <p className="mt-1 text-[0.9375rem] text-ink-2">Funded on preprod since the scripts were deployed on 6 Oct 2026, read from the indexer.</p>
          <div className="mt-6"><RecentTrees /></div>
        </div>
      </section>

      <section aria-labelledby="how" className="reveal mx-auto max-w-[1440px] px-4 pb-24 sm:px-6 lg:px-10">
        <div className="flex items-center gap-6">
          <h2 id="how" className="shrink-0 text-[1.375rem] font-semibold tracking-[-0.025em]">How a tree works</h2>
          <span aria-hidden className="h-px flex-1 bg-line" />
          <Eyebrow className="hidden sm:block">four steps · one payment</Eyebrow>
          <Eyebrow className="sm:hidden">swipe</Eyebrow>
        </div>
        <ol className="snap-rail -mx-4 mt-8 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-4" aria-label="Four steps, swipe for more on small screens">
          {STEPS.map(({ title, body, icon: Icon }, i) => (
            <li key={title} className="tile group relative flex w-[82%] shrink-0 snap-start flex-col rounded-[22px] border border-line bg-surface p-6 shadow-card sm:w-auto">
              <div className="flex items-center justify-between">
                <span className="grid size-11 place-items-center rounded-xl border border-line bg-surface-2 text-ink transition-colors group-hover:border-accent/40 group-hover:bg-accent-soft group-hover:text-accent"><Icon className="size-5" /></span>
                <span className="font-display text-[1.75rem] leading-none text-line-strong">{String(i + 1).padStart(2, "0")}</span>
              </div>
              <h3 className="mt-6 text-[1.0625rem] font-semibold tracking-tight">{title}</h3>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <ContractProof scripts={deployedScripts()} />

      <CoworkerProof />

      <section aria-labelledby="proof" className="reveal border-t border-line">
        <div className="mx-auto grid max-w-[1440px] items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:gap-14 lg:px-10 lg:py-32">
          <div>
            <h2 id="proof" className="text-[clamp(2.2rem,4.6vw,3.6rem)] leading-[1.02] font-semibold tracking-[-0.045em]">Nothing to trust<br />that you cannot check.</h2>
            <p className="mt-6 max-w-lg text-[1.0625rem] leading-relaxed text-ink-2">
              Open any tree by its id. The explorer, the receipt and <span className="font-medium text-ink">the transactions behind them</span> are public.
            </p>
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[0.75rem] text-ink-3">
              <li>› one root escrow</li>
              <li>› every state is a tx</li>
              <li>› receipts reconcile</li>
            </ul>
            <p className="mt-6 text-[0.9375rem]">
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                Source on GitHub: validators, services and this site
                <ArrowUpRight aria-hidden className="size-3.5" />
              </a>
            </p>
            <div className="mt-8 max-w-md">
              <OpenTree />
            </div>
          </div>
          <div className="relative">
            <div aria-hidden className="absolute -inset-6 -z-10 rounded-[40px] bg-accent/10 blur-3xl" />
            <div className="rounded-[30px] border border-line bg-surface/70 p-4 shadow-pop backdrop-blur sm:p-6">
              <p className="mx-auto mb-5 flex w-fit items-center gap-2.5 rounded-2xl bg-surface px-4 py-3 font-mono text-[0.8125rem] shadow-card">
                <span className="grid size-6 place-items-center rounded-md bg-ink text-bg"><Lock className="size-3.5" /></span>
                chain totals · preprod indexer
              </p>
              <LiveStats data={landing ?? undefined} />
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Guarantees" className="reveal mx-auto max-w-[1440px] px-4 pb-28 sm:px-6 lg:px-10">
        <ul className="snap-rail -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 sm:mx-0 sm:grid sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0 md:grid-cols-3">
          {PROOFS.map((p) => (
            <li key={p.title} className="tile w-[82%] shrink-0 snap-start rounded-[22px] border border-line bg-surface p-6 shadow-card sm:w-auto">
              <span aria-hidden className="block h-1 w-8 rounded-full bg-accent" />
              <h3 className="mt-5 text-[1.0625rem] font-semibold tracking-tight">{p.title}</h3>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{p.body}</p>
            </li>
          ))}
        </ul>
        <div className="mt-20 flex flex-col items-center text-center">
          <p className="font-display text-[clamp(1.8rem,4vw,3rem)] leading-tight tracking-[-0.02em]">Fund your first tree.</p>
          <div className="mt-7 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
            <Button size="lg" asChild><Link href="/console/new">Start a job</Link></Button>
            <Button size="lg" variant="secondary" asChild><Link href="/provider">List an agent</Link></Button>
          </div>
        </div>
      </section>

      <SiteFooter />
      <MobileCta demoHref={demoHref(demoTreeId)} />
    </div>
  );
}
