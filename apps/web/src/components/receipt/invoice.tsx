import { CheckCircle2, XCircle } from "lucide-react";
import { AgentAvatar } from "@/components/avatar";
import { Amount } from "@/components/amount";
import { Hash } from "@/components/hash";
import { Rail, railOfKind } from "@/components/rail";
import { StateBadge } from "@/components/state-badge";
import { TxLink } from "@/components/tx-link";
import type { NodeDetail, Receipt, Tree } from "@/lib/api/schemas";
import { formatLovelace } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { utxoUrl } from "@/lib/explorer";
import type { Reconciliation } from "@/lib/receipt/reconcile";
import { formatUtc, preprodSlotToMs } from "@/lib/time";
import { splitPayouts } from "@/lib/receipt/split";
import { ReconciliationLine } from "./reconciliation";

function roleOf(node: Tree["nodes"][number], hasChildren: boolean): string {
  if (node.parent_id === null) return "Orchestrator";
  if (node.kind === "MeteredReceipt") return "Metered data";
  if (node.kind === "MasumiReceipt") return "Masumi agent";
  return hasChildren ? "Sub-orchestrator" : "Specialist";
}

function Party({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[0.6875rem] tracking-[0.14em] text-ink-3 uppercase">{label}</dt>
      <dd className="mt-1.5 min-w-0 text-sm font-medium">{children}</dd>
    </div>
  );
}

/** PRD 21.2 step 8: the receipt as a business document, with the reconciliation as its total line. */
export function Invoice({ receipt, tree, rec, nameOf, paidByNode, detailOf }: { receipt: Receipt; tree: Tree; rec: Reconciliation; nameOf: (id: string) => string; paidByNode: Map<string, bigint>; detailOf: (id: string) => NodeDetail | undefined }) {
  const asset = receipt.deposits.asset;
  const root = tree.nodes.find((n) => n.parent_id === null);
  const split = splitPayouts(receipt, rec, tree, paidByNode);
  const meteredPaid = (nodeId: string): bigint | null => {
    const m = detailOf(nodeId)?.metered;
    return m == null || m.paid.asset !== asset ? null : BigInt(m.paid.amount);
  };
  return (
    <article className="invoice overflow-hidden rounded-[22px] border border-line bg-surface shadow-card" aria-label="Receipt" data-testid="invoice">
      <header className="grid gap-6 border-b border-line px-5 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:px-8 sm:py-7">
        <div className="min-w-0">
          <p className="font-mono text-[0.6875rem] tracking-[0.18em] text-ink-3 uppercase">Cascade escrow tree</p>
          <p className="mt-2 font-mono text-[0.8125rem] leading-relaxed break-all text-ink-2 max-sm:hidden">{tree.tree_id}</p>
          <Hash value={tree.tree_id} label="tree id" className="mt-2 flex sm:hidden" />
          <span className={cn("mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold", rec.balanced ? "bg-accepted-bg text-accepted" : "bg-challenged-bg text-challenged")}>
            {rec.balanced ? <CheckCircle2 className="size-4" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
            {rec.balanced ? "Reconciled" : "Not reconciled"}
          </span>
        </div>
        <div className="sm:text-right">
          <p className="font-mono text-[0.6875rem] tracking-[0.18em] text-ink-3 uppercase">Total deposit</p>
          <p className="mt-2 font-display text-[clamp(2rem,5vw,2.75rem)] leading-none tracking-[-0.02em]"><Amount value={rec.deposits} asset={asset} /></p>
          <p className="tabular mt-2 text-[0.8125rem] text-ink-3"><Amount value={split.toAgents} asset={asset} /> paid to {split.agents} {split.agents === 1 ? "agent" : "agents"}</p>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-b border-line px-5 py-5 sm:grid-cols-4 sm:px-8">
        <Party label="Buyer">
          <Hash value={tree.buyer_vkh} label="buyer key hash" />
        </Party>
        <Party label="Orchestrator">{root === undefined ? "Unknown" : nameOf(root.node_id)}</Party>
        <Party label="Funded">{formatUtc(preprodSlotToMs(tree.created_slot))}</Party>
        <Party label="Closed">{tree.closed_slot === null ? "Open" : formatUtc(preprodSlotToMs(tree.closed_slot))}</Party>
      </dl>

      <div className="overflow-x-auto">
        {/* Under 640 px each row restacks into a card; the table stays one DOM for print and tests. */}
        <table className="w-full text-sm max-sm:block sm:min-w-[640px]" data-testid="receipt-nodes">
          <thead className="max-sm:hidden">
            <tr className="border-b border-line bg-surface-2/50 text-left font-mono text-[0.6875rem] tracking-[0.12em] text-ink-3 uppercase">
              <th scope="col" className="px-5 py-2.5 font-normal sm:px-8">Agent</th>
              <th scope="col" className="px-3 py-2.5 font-normal">Role</th>
              <th scope="col" className="px-3 py-2.5 font-normal">Result</th>
              <th scope="col" className="px-3 py-2.5 font-normal">State</th>
              <th scope="col" className="px-5 py-2.5 text-right font-normal sm:px-8">Paid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line max-sm:block">
            {tree.nodes.map((n) => {
              const detail = detailOf(n.node_id);
              const accepts = detail?.verdicts.filter((v) => v.verdict === "accept").length ?? 0;
              const verdicts = detail?.verdicts.length ?? 0;
              const lastTx = n.tx_ids.at(-1) ?? null;
              const metered = n.kind === "MeteredReceipt" ? meteredPaid(n.node_id) : null;
              const calls = n.kind === "MeteredReceipt" ? detailOf(n.node_id)?.metered?.calls : undefined;
              const escrowAda = split.structuralByNode.get(n.node_id) ?? 0n;
              return (
                <tr key={n.node_id} className="align-top transition-colors hover:bg-surface-2/40 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-2.5 max-sm:px-5 max-sm:py-4">
                  <td className="px-5 py-3.5 max-sm:order-1 max-sm:p-0 sm:px-8">
                    <span className="flex items-center gap-2.5">
                      <AgentAvatar name={nameOf(n.node_id)} size={26} />
                      <span className="min-w-0">
                        <span className="block font-semibold">{nameOf(n.node_id)}</span>
                        <Rail rail={railOfKind(n.kind)} className="text-xs" />
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-3.5 text-ink-2 max-sm:order-3 max-sm:p-0 max-sm:text-[0.8125rem]">{roleOf(n, tree.nodes.some((c) => c.parent_id === n.node_id))}</td>
                  <td className="px-3 py-3.5 max-sm:order-5 max-sm:col-span-2 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:justify-between max-sm:gap-x-3 max-sm:rounded-lg max-sm:bg-surface-2/60 max-sm:px-3 max-sm:py-2">
                    {n.result_hash === null ? <span className="text-ink-3">No result</span> : <Hash value={n.result_hash} label="result hash" />}
                    <span className="block text-xs text-ink-3">{verdicts === 0 ? "No verifier verdicts" : `${accepts} of ${verdicts} verifiers accepted`}</span>
                  </td>
                  <td className="px-3 py-3.5 max-sm:order-4 max-sm:justify-self-end max-sm:p-0">
                    <StateBadge state={n.state} txId={lastTx} />
                  </td>
                  <td className="tabular px-5 py-3.5 text-right font-semibold max-sm:order-2 max-sm:p-0 sm:px-8">
                    <Amount value={metered ?? paidByNode.get(n.node_id) ?? 0n} asset={asset} />
                    <span className="block text-xs font-normal text-ink-3">
                      {calls !== undefined ? `${calls} ${calls === 1 ? "call" : "calls"} redeemed, ` : null}of <Amount value={n.budget} asset={asset} />
                    </span>
                    {escrowAda > 0n ? (
                      <span className="block text-xs font-normal whitespace-nowrap text-ink-3" title="Structural ADA locked with the Masumi escrow output, not part of the agent's pay">
                        + <Amount value={escrowAda} asset="lovelace" /> in escrow
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end border-t border-line px-5 py-6 sm:px-8">
        <dl className="tabular grid w-full max-w-sm content-start gap-2.5 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-ink-2">Paid to agents</dt><dd><Amount value={split.toAgents} asset={asset} /></dd></div>
          {split.toEscrow > 0n ? (
            <div className="flex justify-between gap-4" data-testid="structural-escrow">
              <dt className="text-ink-2">Structural ADA locked in Masumi escrow</dt>
              <dd className="text-right"><Amount value={split.toEscrow} asset="lovelace" /></dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4"><dt className="text-ink-2">Protocol fees</dt><dd><Amount value={rec.fees} asset={asset} /></dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-2">Returned to buyer</dt><dd><Amount value={rec.refunds} asset={asset} /></dd></div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-2">Structural ADA returned</dt>
            <dd className="text-right">
              <Amount value={rec.structuralLovelace} asset="lovelace" />
              <span className="block font-mono text-[0.7rem] text-ink-3">{formatLovelace(rec.structuralLovelace)}</span>
            </dd>
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-4 border-t border-ink pt-3 font-semibold"><dt className="text-base">Deposited</dt><dd className="font-display text-[1.5rem] leading-none font-normal"><Amount value={rec.deposits} asset={asset} /></dd></div>
          <div className="pt-2">
            <ReconciliationLine r={rec} />
          </div>
        </dl>
      </div>

      <footer className="grid gap-2.5 border-t border-line bg-surface-2/60 px-5 py-5 text-xs leading-relaxed text-ink-3 sm:grid-cols-3 sm:px-8">
        <span className="flex min-w-0 items-center gap-2">Plan root <Hash value={tree.plan_root} label="plan root" /></span>
        <span className="flex min-w-0 items-center gap-2">
          Tree config{" "}
          <a href={utxoUrl(tree.config_utxo)} target="_blank" rel="noreferrer noopener" className="font-mono text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
            {tree.config_utxo.slice(0, 10)}…#{tree.config_utxo.split("#")[1]}
          </a>
        </span>
        <span className="flex min-w-0 items-center gap-2">Indexer signature <Hash value={receipt.signature} label="indexer signature" /></span>
        <span className="sm:col-span-3">Signed by the indexer key <Hash value={receipt.key} label="indexer key" />. Every state and amount above links to its preprod transaction{" "}
          {receipt.lines[0] !== undefined ? <TxLink txId={receipt.lines[0].tx_id} label="starting with the deposit" /> : null}.
        </span>
      </footer>
    </article>
  );
}
