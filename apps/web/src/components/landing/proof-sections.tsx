import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { CopyCommand } from "@/components/landing/copy-command";
import { TxLink } from "@/components/tx-link";
import { shortHash, txUrl } from "@/lib/explorer";
import { ACTIONS_TREE_ID, CONTRACT_ACTIONS, COWORKER, REPO_URL } from "@/lib/landing/proof";
import type { DeployedScript } from "@/server/deployment";

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[0.6875rem] tracking-[0.22em] text-ink-3 uppercase">{children}</p>;
}

function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={`inline-flex items-center gap-1 font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink ${className ?? ""}`}>
      {children}
      <ArrowUpRight aria-hidden className="size-3.5" />
    </a>
  );
}

/** The 17 contract actions, each linked to the preprod transaction that ran it, and the scripts they ran against. */
export function ContractProof({ scripts }: { scripts: DeployedScript[] }) {
  return (
    <section aria-labelledby="actions" className="reveal mx-auto max-w-[1440px] px-4 pb-24 sm:px-6 lg:px-10">
      <div>
        <div>
          <Eyebrow>Proven on preprod · {CONTRACT_ACTIONS.length} contract actions</Eyebrow>
          <h2 id="actions" className="mt-4 max-w-2xl text-[clamp(1.8rem,3.6vw,2.75rem)] leading-[1.08] font-semibold tracking-[-0.035em]">Every action the validators allow, run on chain.</h2>
          <p className="mt-4 max-w-2xl text-[1.0625rem] leading-relaxed text-ink-2">
            One scripted run on the current scripts, each transaction read back and its redeemer decoded before it was recorded. Most ran on <Link href={`/tree/${ACTIONS_TREE_ID}`} className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">tree {ACTIONS_TREE_ID.slice(0, 8)}</Link>.
          </p>
        </div>
      </div>
      <ol className="mt-10 grid gap-px overflow-hidden rounded-[22px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3" data-testid="contract-actions">
        {CONTRACT_ACTIONS.map((a) => (
          <li key={a.tx} className="flex min-w-0 flex-col gap-2 bg-surface px-5 py-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[0.8125rem] font-medium">{a.redeemer}</span>
              <TxLink txId={a.tx} tab="contracts" />
            </div>
            <p className="text-[0.875rem] leading-relaxed text-ink-2">{a.proves}</p>
          </li>
        ))}
        <li className="flex min-w-0 flex-col justify-center gap-2 bg-surface-2 px-5 py-4 text-[0.875rem] text-ink-2">
          <p>Each one has its supporting transactions and decoded redeemer in the README.</p>
          <ExternalLink href={`${REPO_URL}#every-redeemer-on-preprod`} className="w-fit text-ink">Full table on GitHub</ExternalLink>
        </li>
      </ol>
      {scripts.length > 0 ? (
        <div className="mt-6 rounded-[22px] border border-line bg-surface px-5 py-4">
          <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">Deployed scripts · reference UTxOs from deployments/preprod.json</p>
          <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
            {scripts.map((s) => (
              <li key={s.name} className="min-w-0 text-[0.8125rem]">
                <a href={txUrl(s.referenceTx, "utxo")} target="_blank" rel="noreferrer noopener" className="group block min-w-0" title={`${s.name} ${s.hash}: open its reference script transaction on Cardanoscan preprod`}>
                  <span className="block truncate font-medium group-hover:underline group-hover:underline-offset-4">{s.name}</span>
                  <span className="block font-mono text-[0.75rem] text-ink-3">{shortHash(s.hash)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Cascade's Sokosumi Coworker and the paid Tasks it completed, with every Masumi transaction. */
export function CoworkerProof() {
  return (
    <section aria-labelledby="coworker" className="reveal border-t border-line">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14 lg:px-10 lg:py-28">
        <div className="min-w-0">
          <Eyebrow>Sokosumi Coworker · preprod</Eyebrow>
          <h2 id="coworker" className="mt-4 text-[clamp(1.8rem,3.6vw,2.75rem)] leading-[1.08] font-semibold tracking-[-0.035em]">Hire Cascade with one Sokosumi Task.</h2>
          <p className="mt-4 text-[1.0625rem] leading-relaxed text-ink-2">
            A buyer pays 1 test USDM through Masumi escrow. Cascade plans the work as an escrow tree, hires the agents, checks their results and returns the brief with a receipt. The result hash goes on chain before the Task completes.
          </p>
          <dl className="mt-6 grid gap-3 text-[0.875rem]">
            <div>
              <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">Coworker id</dt>
              <dd className="mt-1 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">{COWORKER.id}</dd>
            </div>
            <div>
              <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">Masumi registration</dt>
              <dd className="mt-1"><TxLink txId={COWORKER.registrationTx} /></dd>
            </div>
          </dl>
          <div className="mt-8">
            <CopyCommand title="Create a Task from the Sokosumi CLI" command={COWORKER.command} />
          </div>
        </div>
        <ul className="grid min-w-0 content-start gap-4" data-testid="coworker-tasks">
          {COWORKER.tasks.map((t) => (
            <li key={t.task} className="rounded-[22px] border border-line bg-surface p-5 shadow-card sm:p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-mono text-[0.75rem] text-ink-3">Paid Task · {t.date}</p>
                <p className="font-mono text-[0.75rem] text-ink-3 [overflow-wrap:anywhere]">{t.task}</p>
              </div>
              <p className="mt-3 text-[0.9375rem] leading-relaxed">{t.brief}</p>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[0.8125rem] sm:grid-cols-4">
                {[
                  { label: "Masumi lock", tx: t.lock },
                  { label: "Result hash", tx: t.resultHash },
                  { label: "Seller paid", tx: t.collection },
                  { label: "Tree funded", tx: t.treeFunding },
                ].map((row) => (
                  <div key={row.label} className="min-w-0">
                    <dt className="text-ink-3">{row.label}</dt>
                    <dd className="mt-0.5"><TxLink txId={row.tx} /></dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
          <li className="px-1 text-[0.8125rem] leading-relaxed text-ink-3">
            Both Tasks ran before the switch to today&apos;s scripts, so their trees use the earlier script hashes. Every Masumi transaction above is inside the hackathon window.{" "}
            <ExternalLink href={`${REPO_URL}/blob/main/docs/sokosumi-coworker.md`}>How a paid Task runs</ExternalLink>
          </li>
        </ul>
      </div>
    </section>
  );
}
