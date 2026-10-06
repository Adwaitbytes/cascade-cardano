"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Amount } from "@/components/amount";
import { Hash } from "@/components/hash";
import { VerifyNode } from "@/components/verify";
import { MasumiHireDetail } from "@/components/masumi";
import { Rail, railOfKind } from "@/components/rail";
import { StateBadge } from "@/components/state-badge";
import { ErrorState, LoadingBlock } from "@/components/states";
import { TxLink } from "@/components/tx-link";
import { Sheet } from "@/components/ui/sheet";
import { getDataSource } from "@/lib/api";
import { txUrl, utxoUrl } from "@/lib/explorer";
import type { NodeView } from "@/lib/tree/replay";
import { formatDuration } from "@/lib/plan/summary";
import { timeOf } from "./event-style";

/** ADR 0001 1.5 `spent`: from the node row when the indexer sends it, else from the decoded datum. */
function spentOf(view: NodeView, datum: Record<string, unknown> | undefined): bigint | null {
  if (view.node.spent !== undefined) return BigInt(view.node.spent);
  const raw = datum?.spent;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  return null;
}

const sentenceCase = (s: string): string => (s === "" ? s : (s[0]?.toUpperCase() ?? "") + s.slice(1).toLowerCase());

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section className="px-5 py-5">
      <h3 className="mb-3 flex items-center gap-2.5 text-[0.8125rem] font-semibold tracking-tight text-ink">
        <span className="shrink-0">{title}</span>
        {count !== undefined ? <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-surface-2 px-1.5 font-mono text-[0.6875rem] font-normal text-ink-3">{count}</span> : null}
        <span aria-hidden className="h-px flex-1 bg-line" />
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7.5rem,9rem)_1fr] items-baseline gap-3 py-1.5 text-sm">
      <dt className="text-ink-3">{label}</dt>
      <dd className="tabular min-w-0">{children}</dd>
    </div>
  );
}

export function NodeDrawer({ treeId, view, name, asset, minDisputeWindow, onClose }: { treeId: string; view: NodeView | null; name: string; asset: string; minDisputeWindow?: number | undefined; onClose: () => void }) {
  const nodeId = view?.node.node_id ?? null;
  const detail = useQuery({
    queryKey: ["node-detail", treeId, nodeId],
    queryFn: async () => (await getDataSource()).getNodeDetail(treeId, nodeId ?? ""),
    enabled: nodeId !== null,
  });

  return (
    <Sheet
      modal={false}
      // Phones: a bottom sheet with a grab handle that leaves the top of the tree visible and clears the home indicator.
      className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)] before:mx-auto before:mt-2 before:block before:h-1 before:w-10 before:shrink-0 before:rounded-full before:bg-line-strong before:content-[''] max-sm:rounded-t-[22px] max-sm:shadow-[0_-24px_60px_-20px_rgb(11_11_12/0.35)] sm:pb-0 sm:before:hidden"
      open={view !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {name}
          {view !== null ? <StateBadge state={view.state} txId={view.stateTxId} /> : null}
        </span>
      }
      description={view === null ? undefined : <Hash value={view.node.node_id} label="node id" />}
    >
      {view === null ? null : (
        <div className="divide-y divide-line" data-testid="node-drawer">
          <Section title="Escrow">
            <dl>
              <Row label="Budget">
                <Amount value={view.node.budget} asset={asset} />
              </Row>
              <Row label="Fee on acceptance">
                <Amount value={view.node.fee} asset={asset} />
              </Row>
              <Row label="Holds now">
                <Amount value={view.held} asset={asset} />
              </Row>
              <Row label="In open children">
                <Amount value={view.node.committed} asset={asset} />
              </Row>
              {spentOf(view, detail.data?.datum) !== null ? (
                <Row label="Left the tree">
                  <Amount value={spentOf(view, detail.data?.datum) ?? 0n} asset={asset} />
                </Row>
              ) : null}
              {view.node.agent_asset_id != null ? (
                <Row label="Agent">
                  <Link href={`/agents/${view.node.agent_asset_id}`} className="font-medium underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                    {name}, reputation and record
                  </Link>
                </Row>
              ) : null}
              <Row label="Rail">
                <Rail rail={railOfKind(view.node.kind)} />
              </Row>
              <Row label="Acceptance">{sentenceCase(view.node.acceptance.type.replace(/([a-z])([A-Z])/g, "$1 $2"))}</Row>
              <Row label="Submit by">{timeOf(view.node.submit_by)}</Row>
              <Row label="Refund after">{timeOf(view.node.refund_after)}</Row>
              <Row label="Challenge until">{timeOf(view.node.challenge_until)}</Row>
              <Row label="Dispute until">{timeOf(view.node.dispute_until)}</Row>
              <Row label="Time to escalate">
                {formatDuration(view.node.dispute_until - view.node.challenge_until)}
                {minDisputeWindow !== undefined ? <span className="text-ink-3">, tree minimum {formatDuration(minDisputeWindow)}</span> : null}
              </Row>
              {view.node.current_utxo !== null ? (
                <Row label="Current UTxO">
                  <a className="font-mono text-[0.78rem] text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink" href={utxoUrl(view.node.current_utxo)} target="_blank" rel="noreferrer noopener">
                    {view.node.current_utxo.slice(0, 10)}…#{view.node.current_utxo.split("#")[1]}
                  </a>
                </Row>
              ) : null}
            </dl>
          </Section>

          {detail.isLoading ? <LoadingBlock label="Loading node detail" /> : null}
          {detail.error !== null ? <ErrorState error={detail.error} what="node detail" /> : null}
          {detail.data !== undefined ? (
            <>
              {detail.data.metered !== null ? (
                <Section title="Metered usage">
                  <dl className="grid grid-cols-3 gap-3">
                    <div>
                      <dt className="text-2xs text-ink-3">Calls</dt>
                      <dd className="tabular text-lg font-semibold">{detail.data.metered.calls.toLocaleString("en-US")}</dd>
                    </div>
                    <div>
                      <dt className="text-2xs text-ink-3">Paid</dt>
                      <dd className="text-lg font-semibold">
                        <Amount value={detail.data.metered.paid.amount} asset={detail.data.metered.paid.asset} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-2xs text-ink-3">L1 transactions</dt>
                      <dd className="tabular text-lg font-semibold">{detail.data.metered.l1_txs}</dd>
                    </div>
                  </dl>
                </Section>
              ) : null}
              {detail.data.masumi != null || detail.data.masumi_leaves.length > 0 ? (
                <Section title="Masumi hires" count={detail.data.masumi_leaves.length || undefined}>
                  {detail.data.masumi != null ? (
                    <dl className="mb-3 grid gap-1 text-[0.8125rem]">
                      <div className="grid grid-cols-[8.5rem_1fr] gap-2"><dt className="text-ink-3">Tracked lock</dt><dd>{detail.data.masumi.lock === null ? <span className="text-ink-3">Not locked yet</span> : <TxLink txId={detail.data.masumi.lock.split("#")[0] ?? ""} />}</dd></div>
                      <div className="grid grid-cols-[8.5rem_1fr] gap-2"><dt className="text-ink-3">blockchainIdentifier</dt><dd className="min-w-0">{detail.data.masumi.blockchain_identifier === null ? <span className="text-ink-3">Not known yet</span> : <Hash value={detail.data.masumi.blockchain_identifier} label="blockchainIdentifier" />}</dd></div>
                    </dl>
                  ) : null}
                  <ul className="grid gap-3">
                    {detail.data.masumi_leaves.map((leaf) => (
                      <li key={leaf.payment_out_ref} className="rounded-xl border border-line bg-bg/50 p-3.5">
                        <p className="mb-2 text-sm font-medium">
                          <Amount value={leaf.value.lovelace} asset="lovelace" /> to the Masumi purchase wallet
                          {leaf.lock_state !== null ? <span className="ml-2 text-2xs font-normal text-ink-3">vested_pay state {leaf.lock_state}</span> : null}
                        </p>
                        <MasumiHireDetail hire={{ drawTx: leaf.draw_tx, lockTx: leaf.lock_tx, blockchainIdentifier: leaf.blockchain_identifier, outcome: leaf.outcome, outcomeTx: leaf.outcome_tx }} />
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
              <Section title="Verify">
                <VerifyNode node={view.node} detail={detail.data} stateTxId={view.stateTxId} />
              </Section>
              <Section title="Spec">
                {detail.data.spec === null ? (
                  <p className="text-sm text-ink-3">The spec is private to the buyer. Its hash is below.</p>
                ) : (
                  <>
                    <p className="text-sm leading-relaxed">{detail.data.spec.task}</p>
                    <dl className="mt-2">
                      <Row label="Category">{sentenceCase(detail.data.spec.category.replace(/-/g, " "))}</Row>
                      <Row label="Checks">{detail.data.spec.verifier.deterministic.join(", ")}</Row>
                      <Row label="May sub-hire">{detail.data.spec.may_sub_hire ? "Yes" : "No"}</Row>
                    </dl>
                  </>
                )}
              </Section>
              <Section title="Hashes">
                <dl>
                  <Row label="Spec">
                    <Hash value={view.node.spec_hash} label="spec hash" />
                  </Row>
                  <Row label="Input">
                    <Hash value={view.node.input_hash} label="input hash" />
                  </Row>
                  <Row label="Result">{view.node.result_hash === null ? <span className="text-ink-3">Not submitted</span> : <Hash value={view.node.result_hash} label="result hash" />}</Row>
                </dl>
              </Section>
              <Section title="Verdicts" count={detail.data.verdicts.length}>
                {detail.data.verdicts.length === 0 ? (
                  <p className="text-sm text-ink-3">No verifier has checked this node.</p>
                ) : (
                  <ul className="grid gap-2">
                    {detail.data.verdicts.map((v) => (
                      <li key={v.evidence_hash} className="rounded-xl border border-line bg-bg/50 p-3.5">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {v.verdict === "accept" ? <CheckCircle2 className="size-4 text-accepted" aria-hidden /> : <XCircle className="size-4 text-challenged" aria-hidden />}
                          {v.verifier_name ?? v.verifier.slice(0, 12)} {v.verdict === "accept" ? "accepted" : "rejected"}
                          <span className="tabular ml-auto text-2xs text-ink-3">score {v.score.toFixed(2)}</span>
                        </div>
                        <ul className="mt-2 flex flex-wrap gap-1.5">
                          {v.checks.map((c) => (
                            <li key={c.name} className={c.passed ? "rounded bg-accepted-bg px-1.5 py-0.5 text-2xs text-accepted" : "rounded bg-challenged-bg px-1.5 py-0.5 text-2xs text-challenged"}>
                              {c.passed ? "Passed" : "Failed"}: {c.name}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-2xs text-ink-3">
                          Evidence <Hash value={v.evidence_hash} label="evidence hash" />
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section title="Signer gate log" count={detail.data.gate_logs.length}>
                {detail.data.gate_logs.length === 0 ? (
                  <p className="text-sm text-ink-3">No transaction for this node went through the policy signer.</p>
                ) : (
                  detail.data.gate_logs.map((log) => (
                    <div key={log.tx_body_hash} className="mb-2.5 rounded-xl border border-line bg-bg/50 p-3.5 last:mb-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {log.action}: {log.decision === "signed" ? <span className="text-accepted">signed</span> : <span className="text-challenged">refused</span>}
                        <span className="text-2xs font-normal text-ink-3">{timeOf(log.at)}</span>
                      </p>
                      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                        {log.gates.map((g) => (
                          <li key={g.name} className="flex items-start gap-1.5 text-[0.8125rem]" title={g.detail}>
                            {g.passed ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-accepted" aria-label="passed" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-challenged" aria-label="failed" />}
                            {g.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </Section>
              <Section title="Transactions" count={detail.data.txs.length}>
                <ol className="-mx-2 grid gap-0.5">
                  {detail.data.txs.map((t) => (
                    <li key={t.tx_id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2">
                      <a
                        href={txUrl(t.tx_id, "contracts")}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[0.72rem] text-ink hover:border-ink-3"
                        title={`Open the ${t.action} redeemer on Cardanoscan`}
                        data-testid="redeemer-chip"
                      >
                        {t.action}
                      </a>
                      <span className="flex items-center gap-3">
                        <span className="tabular text-2xs text-ink-3">slot {t.slot.toLocaleString("en-US")}</span>
                        <TxLink txId={t.tx_id} tab="utxo" />
                      </span>
                    </li>
                  ))}
                </ol>
              </Section>
              <Section title="Datum, decoded">
                <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-surface-2 p-4 font-mono text-[0.72rem] leading-relaxed text-ink-2">{JSON.stringify(detail.data.datum, null, 2)}</pre>
              </Section>
            </>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
