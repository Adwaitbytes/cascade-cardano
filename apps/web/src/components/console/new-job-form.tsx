"use client";

import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Slider } from "radix-ui";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Eyebrow } from "@/components/agents/heading";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { getDataSource } from "@/lib/api";
import { RISK_LEVELS, type CreateJobRequest } from "@/lib/api/schemas";
import { assetInfo, formatAmount, parseUnits, TUSDM_ASSET_ID } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { minimumDeadlineMs, validateJobForm, type JobFormErrors, type JobFormValues } from "@/lib/console/job-form";
import { formatDuration } from "@/lib/plan/summary";
import { ACTION_BAR, SAFE_BOTTOM } from "./touch";

const RISK_COPY: Record<(typeof RISK_LEVELS)[number], string> = {
  cheapest: "Lowest quotes that clear the reputation floor. One deterministic check per node.",
  balanced: "Price and reputation weighted equally. A verifier quorum on the nodes that produce the final result.",
  safest: "Highest reputation first, a two-verifier quorum on every node, and a fallback agent for each task.",
};

const toLocalInput = (ms: number): string => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const ACCEPTANCE_OPTIONS = [
  ["buyer_review", "I review the result", "Nothing is paid out at the root until you accept, or the challenge window lapses."],
  ["auto_after_checks", "Accept after checks pass", "The root accepts when every verifier check passes and no one challenges in time."],
] as const;

const NEXT_STEPS = [
  "The orchestrator returns a signed plan with a price, rail, verifier and deadline for every node.",
  "You review it and fund the root with one wallet signature.",
  "Agents are hired into child escrows. Failed work refunds to its parent and is re-spent.",
  "You accept the result and get a receipt that reconciles to the base unit.",
] as const;

const DEADLINE_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function Section({ index, title, description, children }: { index: number; title: string; description: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-5 border-t border-line px-5 py-7 first:border-t-0 sm:px-7 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-10">
      <legend className="sr-only">{title}</legend>
      <div aria-hidden>
        <span className="font-display text-[1.375rem] leading-none text-line-strong">{String(index).padStart(2, "0")}</span>
        <p className="mt-3 text-[0.9375rem] font-semibold tracking-tight">{title}</p>
        <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-3">{description}</p>
      </div>
      <div className="grid min-w-0 gap-5">{children}</div>
    </fieldset>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[0.8125rem] font-medium">{children}</dd>
    </div>
  );
}

export function NewJobForm() {
  const router = useRouter();
  const [values, setValues] = useState<JobFormValues>({
    goal: "",
    budget: "150",
    asset: TUSDM_ASSET_ID,
    deadline: "",
    maxDepth: 3,
    minReputation: 60,
    risk: "balanced",
    acceptance: "buyer_review",
    allow: "",
    block: "",
  });
  const [errors, setErrors] = useState<JobFormErrors>({});
  useEffect(() => setValues((v) => (v.deadline === "" ? { ...v, deadline: toLocalInput(Date.now() + 6 * 3600_000) } : v)), []);

  const create = useMutation({
    mutationFn: async (request: CreateJobRequest) => (await getDataSource()).createJob(request),
    onSuccess: ({ plan_id }) => router.push(`/console/plan/${encodeURIComponent(plan_id)}`),
  });

  const set = <K extends keyof JobFormValues>(key: K, value: JobFormValues[K]): void => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key] !== undefined) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const result = validateJobForm(values, Date.now());
    if (!result.ok) {
      setErrors(result.errors);
      const first = Object.keys(result.errors)[0];
      if (first !== undefined) document.getElementById(`job-${first}`)?.focus();
      return;
    }
    create.mutate(result.request);
  };

  const riskIndex = RISK_LEVELS.indexOf(values.risk);
  const invalid = (key: keyof JobFormValues) => (errors[key] === undefined ? {} : { "aria-invalid": true, "aria-describedby": `job-${key}-error` });
  const info = assetInfo(values.asset);
  const budget = parseUnits(values.budget, info.decimals);
  const deadline = values.deadline === "" ? Number.NaN : new Date(values.deadline).getTime();

  return (
    <form onSubmit={submit} noValidate className="grid gap-6 pb-28 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:pb-0" data-testid="new-job-form">
      <Panel className="motion-safe:animate-[rise_600ms_var(--ease-out-quint)_80ms_both]">
        <Section index={1} title="Goal" description="What you want delivered. The orchestrator turns it into a plan of tasks, one per node.">
          <Field label="Goal" htmlFor="job-goal" error={errors.goal} hint="Name the deliverables and how you will judge them.">
            <Textarea id="job-goal" className="min-h-36 text-[0.9375rem] pointer-coarse:text-base" enterKeyHint="next" value={values.goal} onChange={(e) => set("goal", e.target.value)} rows={5} placeholder="Market entry brief for selling cold-pressed juice in Dubai, with a competitor pricing table, an Arabic translation of the summary, and a sourced fact check." {...invalid("goal")} />
          </Field>
        </Section>

        <Section index={2} title="Budget and deadline" description="The whole budget is locked once in the root. Unspent value returns to you when the root closes.">
          <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <Field label="Budget" htmlFor="job-budget" error={errors.budget}>
              <div className="relative">
                <Input id="job-budget" inputMode="decimal" autoComplete="off" className="tabular pr-16 font-medium pointer-coarse:h-11 pointer-coarse:text-base" enterKeyHint="done" value={values.budget} onChange={(e) => set("budget", e.target.value)} {...invalid("budget")} />
                <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center font-mono text-[0.75rem] text-ink-3">{info.ticker}</span>
              </div>
            </Field>
            <Field label="Asset" htmlFor="job-asset">
              <Select id="job-asset" className="pointer-coarse:h-11 pointer-coarse:text-base" value={values.asset} onChange={(e) => set("asset", e.target.value)}>
                <option value={TUSDM_ASSET_ID}>tUSDM, 6 decimals</option>
                <option value="lovelace">ADA, 6 decimals</option>
              </Select>
            </Field>
          </div>
          <Field label="Deadline" htmlFor="job-deadline" error={errors.deadline} hint={`Depth ${values.maxDepth} needs at least ${formatDuration(minimumDeadlineMs(values.maxDepth))} to fit every nested deadline.`}>
            <Input id="job-deadline" type="datetime-local" className="pointer-coarse:h-11 pointer-coarse:text-base" value={values.deadline} onChange={(e) => set("deadline", e.target.value)} {...invalid("deadline")} />
          </Field>
        </Section>

        <Section index={3} title="Who can do the work" description="Limits the orchestrator must respect when it hires. The signer refuses any hire that breaks them.">
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Depth cap" htmlFor="job-maxDepth" error={errors.maxDepth} hint="Levels of sub-hiring below the orchestrator.">
              <Select id="job-maxDepth" className="pointer-coarse:h-11 pointer-coarse:text-base" value={values.maxDepth} onChange={(e) => set("maxDepth", Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((d) => (
                  <option key={d} value={d}>{d} {d === 1 ? "level" : "levels"}</option>
                ))}
              </Select>
            </Field>
            <Field label={<span className="flex justify-between">Reputation floor <span className="tabular font-mono text-ink-2">{values.minReputation} / 100</span></span>} htmlFor="job-minReputation" error={errors.minReputation} hint="Agents below this score are never hired.">
              <input id="job-minReputation" type="range" min={0} max={100} step={5} value={values.minReputation} onChange={(e) => set("minReputation", Number(e.target.value))} className="h-10 w-full accent-[var(--ink)] pointer-coarse:h-11" />
            </Field>
          </div>
          <div className="grid gap-2 rounded-2xl border border-line bg-surface-2/60 p-4 sm:p-5">
            <span id="job-risk-label" className="text-[0.8125rem] font-medium">Risk</span>
            <Slider.Root
              aria-labelledby="job-risk-label"
              min={0}
              max={2}
              step={1}
              value={[riskIndex]}
              onValueChange={([v]) => set("risk", RISK_LEVELS[v ?? 1] ?? "balanced")}
              className="relative mt-1 flex h-6 w-full touch-none items-center select-none pointer-coarse:mt-0 pointer-coarse:h-11"
            >
              <Slider.Track className="relative h-1.5 grow rounded-full bg-surface shadow-[inset_0_0_0_1px_var(--line)]">
                <Slider.Range className="absolute h-full rounded-full bg-ink" />
              </Slider.Track>
              <Slider.Thumb aria-label="Risk" aria-valuetext={values.risk} className="block size-5 rounded-full border-2 border-ink bg-surface shadow-card transition-transform hover:scale-110 focus-visible:ring-3 focus-visible:ring-focus/30 focus-visible:outline-none pointer-coarse:size-6" />
            </Slider.Root>
            <div className="grid grid-cols-3 text-[0.8125rem]">
              {RISK_LEVELS.map((r, i) => (
                <button key={r} type="button" onClick={() => set("risk", r)} className={cn("capitalize transition-colors active:text-ink pointer-coarse:min-h-11", i === 0 && "text-left", i === 1 && "text-center", i === 2 && "text-right", values.risk === r ? "font-semibold text-ink" : "text-ink-3 hover:text-ink")}>
                  {r}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink-2" aria-live="polite">{RISK_COPY[values.risk]}</p>
          </div>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Allow list" htmlFor="job-allow" error={errors.allow} hint="Registry ids, one per line. Empty means any agent.">
              <Textarea id="job-allow" className="min-h-20 font-mono text-xs pointer-coarse:text-base" autoCapitalize="off" autoCorrect="off" value={values.allow} onChange={(e) => set("allow", e.target.value)} spellCheck={false} {...invalid("allow")} />
            </Field>
            <Field label="Block list" htmlFor="job-block" error={errors.block} hint="Registry ids that must never be hired.">
              <Textarea id="job-block" className="min-h-20 font-mono text-xs pointer-coarse:text-base" autoCapitalize="off" autoCorrect="off" value={values.block} onChange={(e) => set("block", e.target.value)} spellCheck={false} {...invalid("block")} />
            </Field>
          </div>
        </Section>

        <Section index={4} title="Acceptance" description="How the root result is released. Every other node follows the rule in its spec.">
          <div role="radiogroup" aria-label="Acceptance" className="grid gap-3 sm:grid-cols-2">
            {ACCEPTANCE_OPTIONS.map(([value, title, body]) => {
              const selected = values.acceptance === value;
              return (
                <label key={value} className={cn("relative cursor-pointer rounded-2xl border p-4 pr-11 transition-[border-color,background-color,box-shadow] duration-200 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-focus/30 active:scale-[0.99]", selected ? "border-accent/50 bg-accent-soft/60 shadow-card" : "border-line-strong hover:border-ink-3 hover:bg-surface-2/50")}>
                  <input type="radio" name="acceptance" value={value} checked={selected} onChange={() => set("acceptance", value)} className="sr-only" />
                  <span aria-hidden className={cn("absolute top-4 right-4 grid size-[18px] place-items-center rounded-full border transition-colors", selected ? "border-accent bg-accent" : "border-line-strong bg-surface")}>
                    {selected ? <span className="size-1.5 rounded-full bg-surface" /> : null}
                  </span>
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="mt-1 block text-[0.875rem] leading-relaxed text-ink-2 sm:text-[0.8125rem]">{body}</span>
                </label>
              );
            })}
          </div>
        </Section>
      </Panel>

      <aside className="grid gap-4 lg:sticky lg:top-20 lg:motion-safe:animate-[rise_600ms_var(--ease-out-quint)_160ms_both]">
        <Panel className="overflow-hidden">
          <div className="border-b border-line p-5 sm:p-6">
            <Eyebrow>Locked in the root</Eyebrow>
            <p className="tabular mt-3 truncate font-display text-[2rem] leading-none tracking-[-0.02em]">
              {budget !== null && budget > 0n ? formatAmount(budget, values.asset) : <span className="text-ink-3">Not set</span>}
            </p>
            <p className="mt-2 text-[0.8125rem] text-ink-3">Unspent value comes back to you at close. Nothing is signed or locked at this step.</p>
            <dl className="mt-4 divide-y divide-line border-t border-line">
              <SummaryRow label="Deadline">{Number.isNaN(deadline) ? "Not set" : DEADLINE_FORMAT.format(deadline)}</SummaryRow>
              <SummaryRow label="Depth">{values.maxDepth} {values.maxDepth === 1 ? "level" : "levels"}</SummaryRow>
              <SummaryRow label="Floor">{values.minReputation} / 100</SummaryRow>
              <SummaryRow label="Risk"><span className="capitalize">{values.risk}</span></SummaryRow>
            </dl>
          </div>
          <div className="p-5 sm:p-6">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight">What happens next</h2>
            <ol className="mt-4 grid gap-3.5 text-[0.8125rem] leading-relaxed text-ink-2">
              {NEXT_STEPS.map((text, i) => (
                <li key={text} className="grid grid-cols-[1.25rem_1fr] gap-2.5">
                  <span className="tabular mt-px grid size-5 place-items-center rounded-md border border-line bg-surface-2 font-mono text-[0.625rem] text-ink-2">{i + 1}</span>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
            {/* One action block: a thumb-reach bar below lg, part of this card from lg up, so the button exists once. */}
            <div className={cn(ACTION_BAR, "lg:mt-6")} style={SAFE_BOTTOM}>
              {create.error !== null ? (
                <div className="mx-auto mb-3 max-h-44 max-w-xl overflow-y-auto rounded-2xl border border-line bg-surface motion-safe:animate-[rise_400ms_var(--ease-out-quint)_both] lg:max-h-none">
                  <ErrorState error={create.error} what="a plan" />
                </div>
              ) : null}
              <div className="mx-auto flex max-w-xl items-center gap-4 pb-3 lg:block lg:pb-0">
                <div className="min-w-0 flex-1 lg:hidden">
                  <p className="font-mono text-[0.625rem] tracking-[0.18em] text-ink-3 uppercase">To lock</p>
                  <p className="tabular mt-1 truncate font-display text-[1.25rem] leading-none tracking-[-0.02em]">
                    {budget !== null && budget > 0n ? formatAmount(budget, values.asset) : <span className="text-ink-3">Not set</span>}
                  </p>
                </div>
                <Button type="submit" size="lg" className="group shrink-0 active:scale-[0.98] lg:w-full" disabled={create.isPending}>
                  {create.isPending ? <Loader2 className="animate-spin" /> : null}
                  {create.isPending ? "Asking for a plan" : "Get a plan"}
                  {create.isPending ? null : <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />}
                </Button>
              </div>
              <p className="mt-3 hidden text-center text-[0.75rem] text-ink-3 lg:block">Nothing is signed or locked at this step.</p>
            </div>
          </div>
        </Panel>
      </aside>
    </form>
  );
}
