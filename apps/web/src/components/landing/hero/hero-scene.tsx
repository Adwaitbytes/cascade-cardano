"use client";

import Link from "next/link";
import { ArrowUpRight, Bot, Check, Database, Languages, PenLine, Search, ShieldCheck, Tag, Wallet, Workflow, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-tree";
import { formatAmount, formatUnits } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { jobTitle, plural } from "@/lib/console/history";
import type { BenchAgent, LandingData, LandingJob } from "@/lib/landing/data";
import { hireFor, hireState, inEscrow, jobAt, phaseIndex, refundedHires, type HirePhaseState, type Phase } from "@/lib/landing/scenarios";
import { useScenarioClock } from "./use-scenario-clock";

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  orchestration: Workflow,
  research: Search,
  pricing: Tag,
  translation: Languages,
  writing: PenLine,
  verification: ShieldCheck,
  "data-lookup": Database,
};

const iconFor = (agent: BenchAgent): LucideIcon => CATEGORY_ICONS[agent.categories[0] ?? ""] ?? Bot;
const whole = (v: bigint | string): string => formatUnits(v, 6);

const PHASE_LABEL: Record<Phase, string> = {
  lock: "root locked",
  hire: "hiring down the tree",
  work: "agents working",
  verify: "paying verified work",
  settle: "tree finished",
};

const SETTLE_LABEL: Record<LandingJob["state"], string> = { closed: "tree closed", cancelled: "refunded at deadline", open: "still open" };

const STATE_TONE: Record<HirePhaseState, string> = {
  idle: "text-ink-3",
  funded: "bg-funded-bg text-funded",
  working: "bg-working-bg text-working",
  paid: "bg-accepted-bg text-accepted",
  refunded: "bg-refunded-bg text-refunded",
  unpaid: "bg-surface-2 text-ink-3",
};

/** Stroke colour for a route in a given state; idle routes stay neutral. */
const ROUTE_TONE: Record<HirePhaseState, string> = {
  idle: "var(--line-strong)",
  funded: "var(--s-funded)",
  working: "var(--s-working)",
  paid: "var(--s-accepted)",
  refunded: "var(--s-refunded)",
  unpaid: "var(--line-strong)",
};

function steps(job: LandingJob): { text: string; refund: boolean }[] {
  const amount = (v: string): string => formatAmount(v, job.asset);
  const refunded = refundedHires(job);
  const first = refunded[0];
  const refundStep =
    first === undefined
      ? "no hire refunded"
      : refunded.length === 1
        ? `${first.agent} refunded`
        : `${first.agent} and ${plural(refunded.length - 1, "other")} refunded`;
  const verb = job.state === "closed" ? "closed" : job.state === "cancelled" ? "deadline refund" : "open";
  return [
    { text: `lock ${amount(job.budget)} in the root`, refund: false },
    { text: `hire ${plural(job.hires.length, "agent")} into ${plural(job.node_count, "escrow")}`, refund: false },
    { text: refundStep, refund: first !== undefined },
    { text: `${verb}: ${whole(job.paid)} paid, ${whole(job.returned)} back`, refund: false },
  ];
}

/** A step is done once the phase that completes it has started. */
const STEP_DONE_AT: readonly Phase[] = ["hire", "work", "verify", "settle"];

/** Element position inside an ancestor from layout offsets, so entrance transforms never skew it. */
function offsetWithin(el: HTMLElement, ancestor: HTMLElement): { x: number; y: number; w: number; h: number } {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node !== null && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

interface Routes {
  width: number;
  height: number;
  buyer: string;
  agents: Record<string, string>;
}

const CENT = 10_000n;

/** Counts between escrow balances in whole cents, so the readout never shows raw base units. */
function EscrowTicker({ value, asset, reduced }: { value: bigint; asset: string; reduced: boolean }) {
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
      const p = Math.min(1, (now - t0) / 700);
      const eased = 1 - (1 - p) ** 3;
      const raw = start + ((value - start) * BigInt(Math.round(eased * 1000))) / 1000n;
      setShown(p >= 1 ? value : (raw / CENT) * CENT);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);
  return (
    <span className="tabular whitespace-nowrap">
      <span className="sr-only">{formatAmount(value, asset)}</span>
      <span aria-hidden>{formatAmount(shown, asset)}</span>
    </span>
  );
}

function StateChip({ state, fee, paid }: { state: HirePhaseState; fee: string | undefined; paid: string | undefined }) {
  if (fee === undefined || state === "idle") return <span className="font-mono text-[0.6875rem] text-ink-3">not in this job</span>;
  const text =
    state === "paid"
      ? `paid ${whole(paid ?? "0")}`
      : state === "refunded"
        ? "refunded"
        : state === "unpaid"
          ? "no fee paid"
          : BigInt(fee) > 0n
            ? `${state} ${whole(fee)}`
            : state;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[0.6875rem] whitespace-nowrap", STATE_TONE[state])}>
      {state === "working" ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
      {text}
    </span>
  );
}

const reputationText = (a: BenchAgent): string => (a.reputation.confidence === 0 ? "new" : `rep ${Math.round(a.reputation.score * 100)}`);

const capturedOn = (ms: number): string => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function HeroScene({ actions, landing }: { actions: ReactNode; landing: LandingData }) {
  const { jobs, agents } = landing;
  const reduced = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const buyerRef = useRef<HTMLButtonElement>(null);
  const vaultRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const { index, phase, goTo } = useScenarioClock(stageRef, reduced, jobs.length);
  const [routes, setRoutes] = useState<Routes | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const job = jobAt(jobs, index);
  const pIndex = phaseIndex(phase);
  const settled = phase === "settle";

  const draw = useCallback((): void => {
    const stage = stageRef.current;
    const buyer = buyerRef.current;
    const vault = vaultRef.current;
    if (stage === null || buyer === null || vault === null || window.innerWidth < 1024) {
      setRoutes(null);
      return;
    }
    const b = offsetWithin(buyer, stage);
    const v = offsetWithin(vault, stage);
    const c = { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    const a = { x: b.x + b.w, y: b.y + b.h / 2 };
    const paths: Record<string, string> = {};
    for (const [name, tile] of Object.entries(tileRefs.current)) {
      if (tile === null) continue;
      const t = offsetWithin(tile, stage);
      const end = { x: t.x, y: t.y + t.h / 2 };
      paths[name] = `M${c.x} ${c.y} C${c.x + 120} ${c.y}, ${end.x - 90} ${end.y}, ${end.x} ${end.y}`;
    }
    setRoutes({
      width: stage.offsetWidth,
      height: stage.offsetHeight,
      buyer: `M${a.x} ${a.y} C${a.x + 100} ${a.y}, ${c.x - 130} ${c.y}, ${c.x} ${c.y}`,
      agents: paths,
    });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(stage);
    void document.fonts.ready.then(draw);
    return () => ro.disconnect();
  }, [draw]);

  // Pointer tilt for the vault, written straight to CSS variables so it never re-renders React.
  useEffect(() => {
    const stage = stageRef.current;
    const body = bodyRef.current;
    if (stage === null || body === null || reduced) return;
    const coarse = window.matchMedia("(pointer: coarse)");
    const move = (e: PointerEvent): void => {
      if (coarse.matches) return;
      const r = stage.getBoundingClientRect();
      body.style.setProperty("--ry", `${((e.clientX - r.left) / r.width - 0.5) * 16}deg`);
      body.style.setProperty("--rx", `${-((e.clientY - r.top) / r.height - 0.5) * 10}deg`);
    };
    const leave = (): void => {
      body.style.setProperty("--ry", "0deg");
      body.style.setProperty("--rx", "0deg");
    };
    stage.addEventListener("pointermove", move, { passive: true });
    stage.addEventListener("pointerleave", leave);
    return () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", leave);
    };
  }, [reduced]);

  const stepList = job === undefined ? [] : steps(job);
  const pulseKey = `${index}-${phase}`;
  const returned = job === undefined ? 0n : BigInt(job.returned);
  const command = job === undefined ? "" : `cascade receipt ${job.tree_id}`;
  const result = job === undefined ? "" : `✓ ${SETTLE_LABEL[job.state]} · ${whole(job.paid)} paid · ${whole(job.returned)} back`;
  const title = job === undefined ? null : jobTitle(job);

  return (
    <>
      <p className="intro intro-3 mt-5 max-w-3xl text-center font-display text-[clamp(1.1rem,2.1vw,1.6rem)] leading-snug tracking-[-0.01em]" data-field-quiet>
        <span className="text-ink-3">One payment funds </span>a tree of agent hires<span className="text-ink-3">.</span>
      </p>
      <p className="intro intro-4 mt-4 max-w-[34rem] text-center text-[1rem] leading-relaxed text-ink-2" data-field-quiet>
        Each hire is its own escrow on Cardano. Agents are paid only for verified work, and unspent budget returns to the buyer.
      </p>
      <div className="intro intro-5 mt-7 grid w-full max-w-sm grid-cols-1 gap-3 sm:flex sm:w-auto sm:max-w-none sm:flex-wrap sm:justify-center" data-field-quiet>{actions}</div>

      <div ref={stageRef} className="hero-stage relative mt-14 grid w-full grid-cols-[minmax(0,1fr)] items-center gap-10 lg:mt-16 lg:grid-cols-[300px_minmax(0,1fr)_340px] lg:gap-6 xl:grid-cols-[320px_minmax(0,1fr)_370px]">
        {routes !== null && job !== undefined ? (
          <svg aria-hidden className="routes intro intro-8 pointer-events-none absolute inset-0 hidden lg:block" width={routes.width} height={routes.height} viewBox={`0 0 ${routes.width} ${routes.height}`}>
            <defs>
              <filter id="route-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" />
              </filter>
            </defs>
            <path d={routes.buyer} className="route" style={{ stroke: settled && returned > 0n ? "var(--s-refunded)" : "var(--accent)", opacity: 0.55 }} pathLength={100} />
            {agents.map(({ name }) => {
              const d = routes.agents[name];
              const hire = hireFor(job, name);
              if (d === undefined) return null;
              const state = hire === undefined ? "idle" : hireState(hire, phase);
              return <path key={name} d={d} pathLength={100} className={cn("route", focus === name && "route-focus", state === "idle" && "route-idle")} style={{ stroke: focus === name ? "var(--accent)" : ROUTE_TONE[state] }} />;
            })}
            <g key={pulseKey} className="pulses">
              {phase === "lock" ? <Pulse d={routes.buyer} tone="var(--accent)" /> : null}
              {phase === "hire"
                ? job.hires.map((h, i) => {
                    const d = routes.agents[h.agent];
                    return d === undefined ? null : <Pulse key={h.agent} d={d} tone="var(--s-funded)" delay={i * 90} />;
                  })
                : null}
              {phase === "verify"
                ? job.hires.map((h, i) => {
                    const d = routes.agents[h.agent];
                    if (d === undefined || h.outcome === "unpaid" || h.outcome === "open") return null;
                    return h.outcome === "refunded" ? <Pulse key={h.agent} d={d} tone="var(--s-refunded)" reverse /> : <Pulse key={h.agent} d={d} tone="var(--s-accepted)" delay={i * 90} />;
                  })
                : null}
              {settled && returned > 0n ? <Pulse d={routes.buyer} tone="var(--s-refunded)" reverse /> : null}
            </g>
          </svg>
        ) : null}

        <div className="intro intro-6 relative order-2 lg:order-none">
          <p className="font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase">Buyer · preprod job {jobs.length > 0 ? `${index + 1} of ${jobs.length}` : ""}</p>
          {job !== undefined && title !== null ? (
            <>
              <button
                ref={buyerRef}
                type="button"
                onClick={() => goTo(index + 1)}
                className="buyer-card group mt-4 flex w-full items-center gap-4 rounded-[20px] border border-line bg-surface/85 p-5 text-left shadow-card backdrop-blur transition-[transform,box-shadow,border-color] duration-300 ease-out-quint hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop"
                aria-label={`Show the next preprod job. Now showing tree ${job.tree_id.slice(0, 8)}: ${title.text}.`}
                data-field-quiet
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><Wallet className="size-5" /></span>
                <span className="min-w-0 flex-1">
                  <span key={job.tree_id} className={cn("swap-in line-clamp-2 leading-snug font-semibold tracking-tight", !title.recorded && "text-ink-2")}>{title.text}</span>
                  <span className="mt-1 block font-mono text-[0.75rem] text-ink-3">budget {formatAmount(job.budget, job.asset)}</span>
                </span>
                <span aria-hidden className="font-mono text-[0.6875rem] text-ink-3 transition-colors group-hover:text-ink">next ↻</span>
              </button>
              <ol className="mt-6 grid gap-3" data-field-quiet>
                {stepList.map((step, i) => {
                  const done = pIndex >= phaseIndex(STEP_DONE_AT[i] ?? "settle");
                  const active = !done && (i === 0 || pIndex >= phaseIndex(STEP_DONE_AT[i - 1] ?? "settle"));
                  return (
                    <li key={`${job.tree_id}-${i}`} className={cn("flex items-center gap-3 font-mono text-[0.8125rem] transition-colors duration-300", done ? "text-ink" : active ? "text-ink-2" : "text-ink-3/70")}>
                      <span className={cn("grid size-5 shrink-0 place-items-center rounded-md border text-[0.625rem] transition-colors duration-300", done ? "border-transparent bg-ink text-bg" : active ? "border-accent text-accent" : "border-line text-ink-3")}>{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate" title={step.text}>{step.text}</span>
                      {done ? <Check aria-hidden className={cn("check-in size-3.5", step.refund ? "text-refunded" : "text-accent")} /> : active ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" /> : null}
                    </li>
                  );
                })}
              </ol>
              <div className="mt-6 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2" role="group" aria-label="Preprod jobs">
                  {jobs.map((j, i) => (
                    <button key={j.tree_id} type="button" onClick={() => goTo(i)} aria-label={`Show tree ${j.tree_id.slice(0, 8)}`} aria-pressed={i === index} className="group grid h-6 place-items-center px-0.5">
                      <span className={cn("block h-1 rounded-full transition-all duration-500 ease-out-quint", i === index ? "w-7 bg-ink" : "w-3 bg-line-strong group-hover:bg-ink-3")} />
                    </button>
                  ))}
                </div>
                <Link href={`/tree/${job.tree_id}`} className="group inline-flex items-center gap-1 font-mono text-[0.75rem] text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink">
                  tree {job.tree_id.slice(0, 8)}
                  <ArrowUpRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </Link>
              </div>
            </>
          ) : (
            <p className="mt-4 text-[0.9375rem] text-ink-2">No finished preprod job has paid an agent yet.</p>
          )}
        </div>

        <div className="relative order-1 flex flex-col items-center lg:order-none">
          <div ref={vaultRef} className="vault relative aspect-square w-[min(80%,320px)] sm:w-[min(100%,340px)] lg:w-[min(100%,380px)]">
            <div aria-hidden className="vault-halo absolute inset-[-18%] rounded-full" />
            <div ref={bodyRef} className="vault-body absolute inset-0">
              {[4, 3, 2, 1].map((i) => (
                <div key={i} className="vault-pane vault-pane-back" style={{ "--i": i } as CSSProperties}>
                  <span key={pulseKey} className="vault-glow" style={{ animationDelay: `${(4 - i) * 70}ms` }} />
                </div>
              ))}
              <div className="vault-pane vault-pane-front" style={{ "--i": 0 } as CSSProperties}>
                <div className="vault-window">
                  <span key={pulseKey} className="vault-flash" />
                  <p className="font-mono text-[0.625rem] tracking-[0.22em] text-accent uppercase">In escrow</p>
                  <p className="mt-1.5 font-display text-[clamp(1.35rem,2.4vw,1.85rem)] leading-none tracking-[-0.02em] text-ink">
                    {job === undefined ? "0" : <EscrowTicker value={inEscrow(job, phase)} asset={job.asset} reduced={reduced} />}
                  </p>
                  <p key={phase} className="swap-in mt-3 font-mono text-[0.6875rem] text-ink-2">{settled && job !== undefined ? SETTLE_LABEL[job.state] : PHASE_LABEL[phase]}</p>
                  <div className="mt-3 flex gap-1" aria-hidden>
                    {(["lock", "hire", "work", "verify", "settle"] as const).map((p) => (
                      <span key={p} className={cn("h-1 w-5 rounded-full transition-colors duration-500", phaseIndex(p) <= pIndex ? "bg-accent" : "bg-line-strong/70")} />
                    ))}
                  </div>
                </div>
                <span className="vault-mark" aria-hidden>
                  <svg viewBox="0 0 28 28" className="size-full"><g fill="currentColor"><rect x="10.5" y="6" width="7" height="5" rx="1" /><rect x="13" y="11" width="2" height="3" /><rect x="8" y="13" width="12" height="2" /><rect x="6" y="17" width="6" height="5" rx="1" /><rect x="16" y="17" width="6" height="5" rx="1" opacity="0.45" /></g></svg>
                </span>
              </div>
            </div>
          </div>
          {job !== undefined ? (
            <p className="intro intro-9 relative z-10 mt-8 flex h-9 max-w-full items-center gap-2 overflow-hidden rounded-xl border border-line bg-surface/90 px-3.5 font-mono text-[0.75rem] text-ink-2 shadow-card backdrop-blur" data-field-quiet>
              <span className="text-ink-3">$</span>
              {settled ? (
                <span key={`r-${job.tree_id}`} className="swap-in truncate text-accent">{result}</span>
              ) : (
                <span key={`c-${job.tree_id}`} className="typed max-w-[34ch] truncate" style={{ "--n": command.length } as CSSProperties}>{command}</span>
              )}
            </p>
          ) : null}
        </div>

        <div className="intro intro-7 relative order-3 lg:order-none">
          <p className="font-mono text-[0.6875rem] tracking-[0.22em] text-accent uppercase">Registered agents</p>
          <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5 lg:grid-cols-2" data-field-quiet>
            {agents.map((agent) => {
              const Icon = iconFor(agent);
              const hire = job === undefined ? undefined : hireFor(job, agent.name);
              const state: HirePhaseState = hire === undefined ? "idle" : hireState(hire, phase);
              return (
                <li
                  key={agent.agent_asset_id}
                  ref={(el) => {
                    tileRefs.current[agent.name] = el;
                  }}
                  onPointerEnter={() => setFocus(agent.name)}
                  onPointerLeave={() => setFocus(null)}
                  className={cn(
                    "agent-tile relative flex min-w-0 flex-col items-center gap-1.5 rounded-[18px] border bg-surface/85 px-2 py-3.5 text-center shadow-card backdrop-blur transition-[opacity,transform,border-color,box-shadow] duration-500 ease-out-quint",
                    hire === undefined && pIndex >= phaseIndex("hire") ? "border-line opacity-55" : "border-line",
                    focus === agent.name && "-translate-y-0.5 border-line-strong shadow-pop",
                  )}
                  data-state={state}
                >
                  {state !== "idle" ? <span key={`${state}-${index}`} aria-hidden className="state-ring pointer-events-none absolute inset-0 rounded-[18px]" style={{ color: ROUTE_TONE[state] }} /> : null}
                  <span className={cn("grid size-8 place-items-center rounded-[10px] transition-colors duration-500", state === "idle" ? "bg-ink text-bg" : STATE_TONE[state])}><Icon className="size-4" /></span>
                  <Link href={`/agents/${agent.agent_asset_id}`} className="w-full truncate px-1 text-[0.9375rem] font-medium tracking-tight hover:underline hover:underline-offset-4" title={agent.name}>
                    {agent.name.replace(/^Cascade /, "")}
                  </Link>
                  <span className="-mt-1 font-mono text-[0.6875rem] text-ink-3 tabular-nums">
                    {agent.price === null ? "no list price" : formatAmount(agent.price.amount, agent.price.asset)} · {reputationText(agent)}
                  </span>
                  <StateChip state={state} fee={hire?.fee} paid={hire?.paid} />
                </li>
              );
            })}
          </ul>
          <p className="mt-5 text-center font-mono text-[0.75rem] text-ink-3">list price and reputation from the preprod directory</p>
        </div>
      </div>
      <p className="intro intro-9 mt-6 text-center font-mono text-[0.6875rem] text-ink-3">
        {landing.source === "live"
          ? "real preprod jobs from the indexer · amounts and outcomes as recorded on chain"
          : `real preprod jobs, saved ${capturedOn(landing.generated_at)} · the indexer did not answer`}
      </p>
    </>
  );
}

function Pulse({ d, tone, delay = 0, reverse = false }: { d: string; tone: string; delay?: number; reverse?: boolean }) {
  const style = { offsetPath: `path("${d}")`, animationDelay: `${delay}ms`, animationDirection: reverse ? "reverse" : "normal", color: tone } as CSSProperties;
  return (
    <g>
      <circle r="9" className="pulse pulse-halo" style={style} filter="url(#route-glow)" />
      <circle r="3.5" className="pulse" style={style} />
    </g>
  );
}
