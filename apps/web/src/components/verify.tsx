"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, ExternalLink, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { getDataSource } from "@/lib/api";
import type { ApiNode, NodeDetail, Receipt, Tree } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";
import { txUrl, utxoUrl } from "@/lib/explorer";
import type { Reconciliation } from "@/lib/receipt/reconcile";
import { checkReceiptSignature, checkResultText, checkSpecHash, type CheckResult } from "@/lib/verify";

const ORDER: Record<CheckResult["status"], number> = { mismatch: 0, match: 1, consistent: 2, manual: 3, unavailable: 4 };

const TONE = {
  match: { text: "Matches chain", className: "bg-accepted-bg text-accepted", Icon: CheckCircle2 },
  consistent: { text: "Adds up", className: "bg-accepted-bg text-accepted", Icon: CheckCircle2 },
  manual: { text: "Manual check", className: "bg-surface-2 text-ink-2", Icon: CircleDashed },
  mismatch: { text: "Mismatch", className: "bg-challenged-bg text-challenged", Icon: XCircle },
  unavailable: { text: "Not checkable", className: "bg-refunded-bg text-refunded", Icon: CircleDashed },
} as const;

export function CheckBadge({ result }: { result: CheckResult }) {
  const t = TONE[result.status];
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-semibold", t.className)} data-testid="check-badge" data-status={result.status}>
      <t.Icon className="size-3.5" aria-hidden /> {t.text}
    </span>
  );
}

function CheckRow({ title, result, children }: { title: string; result: CheckResult | null; children?: ReactNode }) {
  return (
    <li className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{title}</span>
        {result === null ? null : <CheckBadge result={result} />}
      </div>
      {result !== null ? <p className="text-xs break-words text-ink-3">{result.detail}</p> : null}
      {children}
    </li>
  );
}

const ChainLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-medium text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
    {children} <ExternalLink className="size-3" aria-hidden />
  </a>
);

/** Node drawer: recompute the spec hash, hash a pasted result, and open the exact UTxO and redeemer on Cardanoscan. */
export function VerifyNode({ node, detail, stateTxId }: { node: ApiNode; detail: NodeDetail; stateTxId: string | null }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  return (
    <ul className="divide-y divide-line" data-testid="verify-node">
      <CheckRow title="Spec hash, recomputed in your browser" result={checkSpecHash(detail.spec, node.spec_hash)} />
      <CheckRow title="Result hash" result={result ?? (node.result_hash === null ? { status: "unavailable", detail: "This node has not submitted a result." } : null)}>
        {node.result_hash !== null ? (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setResult(checkResultText(text, node.result_hash));
            }}
          >
            <label htmlFor={`result-${node.node_id}`} className="text-xs text-ink-3">Paste the result JSON the agent returned</label>
            <Textarea id={`result-${node.node_id}`} value={text} onChange={(e) => setText(e.target.value)} className="min-h-20 font-mono text-xs" spellCheck={false} />
            <Button type="submit" variant="secondary" size="sm" className="justify-self-start" disabled={text.trim() === ""}>Hash and compare</Button>
          </form>
        ) : null}
      </CheckRow>
      <CheckRow title="On chain" result={null}>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {node.current_utxo !== null ? <ChainLink href={utxoUrl(node.current_utxo)}>Current UTxO</ChainLink> : null}
          {stateTxId !== null ? <ChainLink href={txUrl(stateTxId, "contracts")}>Redeemer and datum of the last state change</ChainLink> : null}
        </div>
      </CheckRow>
    </ul>
  );
}

/** Receipt: the indexer's signature, the reconciliation and every node's spec hash, checked in the browser. */
export function VerifyReceipt({ receipt, tree, rec, details }: { receipt: Receipt; tree: Tree; rec: Reconciliation; details: (NodeDetail | undefined)[] }) {
  const deployment = useQuery({ queryKey: ["deployment"], queryFn: async () => (await getDataSource()).getDeployment(), staleTime: Infinity });
  const signature: CheckResult = deployment.isLoading
    ? { status: "unavailable", detail: "Loading the published oracle address." }
    : checkReceiptSignature(receipt, deployment.data?.oracle_address ?? null);
  const specs = tree.nodes.map((n) => {
    const d = details.find((x) => x?.node_id === n.node_id);
    return d === undefined ? null : checkSpecHash(d.spec, n.spec_hash);
  });
  const checked = specs.filter((s): s is CheckResult => s !== null && s.status !== "unavailable");
  const specResult: CheckResult =
    checked.length === 0
      ? { status: "unavailable", detail: "No public specs to check." }
      : checked.every((s) => s.status === "match")
        ? { status: "match", detail: `${checked.length} of ${tree.nodes.length} node specs hash to the spec hash in their datum; the rest are private.` }
        : { status: "mismatch", detail: `${checked.filter((s) => s.status === "mismatch").length} node specs do not hash to their datum value.` };
  const reconciliation: CheckResult = rec.balanced && rec.indexerAgrees
    ? { status: "consistent", detail: "Recomputed here from the receipt totals; the indexer's balanced flag agrees." }
    : { status: "mismatch", detail: rec.indexerAgrees ? "The totals do not balance." : "The indexer's balanced flag disagrees with the totals." };
  return (
    <section className="no-print rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6" aria-labelledby="verify-title" data-testid="verify-receipt">
      <h2 id="verify-title" className="text-[0.9375rem] font-semibold">Verify this receipt yourself</h2>
      <p className="mt-1 mb-4 text-[0.8125rem] text-ink-3">Every check runs in your browser against what the chain and the indexer published.</p>
      <ul className="divide-y divide-line">
        {/* Passing checks first, things the reader cannot check here last. */}
        {[
          { title: "Node specs", result: specResult },
          { title: "Reconciliation", result: reconciliation },
          { title: "Indexer signature", result: signature },
        ]
          .sort((a, b) => ORDER[a.result.status] - ORDER[b.result.status])
          .map((c) => (
            <CheckRow key={c.title} title={c.title} result={c.result} />
          ))}
        <CheckRow title="Plan root" result={{ status: "manual", detail: "The plan root lives in the tree config datum. Rebuilding it needs the full plan, so compare it with the plan you approved." }}>
          <ChainLink href={utxoUrl(tree.config_utxo)}>Tree config UTxO</ChainLink>
        </CheckRow>
      </ul>
    </section>
  );
}
