"use client";

import { AlarmClock, MessageSquareText, ShieldAlert, Snowflake, ThumbsUp } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TreeExplorer } from "@/components/explorer/tree-explorer";
import { Hash } from "@/components/hash";
import { SignFlow } from "@/components/sign-flow";
import { ErrorState } from "@/components/states";
import { ExplorerSkeleton } from "@/components/explorer/explorer-skeleton";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { useTreeData } from "@/hooks/use-tree";
import { getDataSource } from "@/lib/api";
import type { TreeActionRequest } from "@/lib/api/schemas";
import { formatAmount } from "@/lib/assets";
import { cn } from "@/lib/cn";
import { overdueNodes, type Overdue } from "@/lib/console/overdue";
import { formatDurationShort } from "@/lib/plan/summary";
import { formatUtc } from "@/lib/time";
import { replayTree } from "@/lib/tree/replay";
import { HASH_TOUCH } from "./touch";

type Action = { action: TreeActionRequest["action"]; nodeId: string; title: string; sentence: string; label: string };

function PendingItem({ icon, tone, title, body, action }: { icon: ReactNode; tone: string; title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-4 px-5 py-5 sm:items-center motion-safe:animate-[rise_500ms_var(--ease-out-quint)_both] sm:px-6">
      <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-xl", tone)}>{icon}</span>
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-[0.9375rem] font-semibold tracking-tight">{title}</p>
        <div className="mt-1 text-[0.875rem] leading-relaxed text-ink-2 sm:text-[0.8125rem]">{body}</div>
      </div>
      {action}
    </li>
  );
}

function overdueTitle(o: Overdue, who: string): string {
  if (o.kind === "submit") return o.isRoot ? "The root missed its submit deadline" : `${who} missed its submit deadline`;
  if (o.kind === "challenge") return `${who}'s result is accepted by deadline`;
  return `The dispute on ${who} ran out of time`;
}

function overdueBody(o: Overdue, parentName: string | null, amount: string, offerFreeze: boolean): string {
  const freeze = offerFreeze ? " Freeze stops new hires while it settles." : "";
  const back = parentName === null ? "you" : parentName;
  if (o.kind === "submit")
    return o.isRoot
      ? `No result arrived in time. The root can be refunded: ${amount} returns to you once its open hires close. The watchtower submits the refund, and anyone can.${freeze}`
      : `No result arrived in time. ${amount} returns to ${back} when the refund lands. The watchtower submits it, and anyone can.${freeze}`;
  if (o.kind === "challenge") return `Nobody challenged the result. Payment settles when the watchtower submits it, with no action from you.`;
  return `No split was signed before the dispute deadline, so the node refunds to ${back}. The watchtower submits it, and anyone can.`;
}

export function JobConsole({ treeId }: { treeId: string }) {
  const data = useTreeData(treeId);
  const [pending, setPending] = useState<Action | null>(null);
  const view = useMemo(() => (data.tree === undefined ? null : replayTree(data.tree, data.events)), [data.tree, data.events]);
  // Deadlines pass without any chain event, so the overdue check runs on a clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  if (data.isLoading) return <ExplorerSkeleton />;
  if (data.error !== null || data.tree === undefined || view === null) return <Panel><ErrorState error={data.error} what="job" /></Panel>;

  const tree = data.tree;
  const root = view.rootId === null ? undefined : view.nodes.get(view.rootId);
  const name = (id: string): string => {
    const node = view.nodes.get(id)?.node;
    const agentId = node?.agent_asset_id;
    return (agentId == null ? undefined : data.agents.get(agentId)?.name) ?? node?.agent_name ?? `Node ${id.slice(0, 6)}`;
  };
  const awaitingInput = [...view.nodes.values()].filter((n) => n.awaitingInput);
  const rootNeedsBuyer = root !== undefined && root.state === "Submitted" && root.node.acceptance.type === "BuyerAccept" && now <= root.node.challenge_until;
  const items: ReactNode[] = [];
  let buyerActions = 0;

  if (rootNeedsBuyer && root !== undefined) {
    buyerActions++;
    items.push(
      <PendingItem
        key="accept"
        icon={<ThumbsUp className="size-4" />}
        tone="bg-submitted-bg text-submitted"
        title="Accept the root result"
        body={<>Result <Hash value={root.node.result_hash ?? "00".repeat(32)} label="result hash" className={HASH_TOUCH} />. If you do nothing, it is accepted when the challenge window closes.</>}
        action={
          <div className="flex w-full gap-3 sm:w-auto sm:gap-2">
            <Button variant="secondary" size="sm" className="pointer-coarse:h-11 max-sm:flex-1 max-sm:text-[0.9375rem] active:scale-[0.98]" onClick={() => setPending({ action: "Challenge", nodeId: root.node.node_id, title: "Challenge the result", label: "Sign and challenge", sentence: "Challenge the root result and post the challenger bond from your wallet. An arbiter or the verifier quorum decides the split" })}>Challenge</Button>
            <Button size="sm" className="pointer-coarse:h-11 max-sm:flex-1 max-sm:text-[0.9375rem] active:scale-[0.98]" onClick={() => setPending({ action: "Accept", nodeId: root.node.node_id, title: "Accept the result", label: "Sign and accept", sentence: `Accept the root result. ${name(root.node.node_id)} is paid ${formatAmount(root.node.fee, tree.asset)} when the root closes, and the rest returns to you` })}>Accept</Button>
          </div>
        }
      />,
    );
  }
  if (root !== undefined && (root.state === "Challenged" || root.state === "Disputed")) {
    items.push(<PendingItem key="challenge" icon={<ShieldAlert className="size-4" />} tone="bg-challenged-bg text-challenged" title="The root result is in dispute" body="The arbiters or the verifier quorum will sign a split. Anyone can submit it once signed." />);
  }
  for (const n of awaitingInput) {
    items.push(<PendingItem key={`input-${n.node.node_id}`} icon={<MessageSquareText className="size-4" />} tone="bg-working-bg text-working" title={`${name(n.node.node_id)} needs more input`} body="The agent paused its work. Answer through the orchestrator; the node's submit deadline keeps running." />);
  }

  const freezeAction: Action = view.frozen
    ? { action: "Unfreeze", nodeId: tree.tree_id, title: "Unfreeze the tree", label: "Sign and unfreeze", sentence: "Unfreeze the tree. The orchestrator can hire again. No value moves" }
    : { action: "Freeze", nodeId: tree.tree_id, title: "Freeze the tree", label: "Sign and freeze", sentence: "Freeze the tree. No new agent can be hired anywhere in it until you unfreeze. No value moves, and running work keeps its deadlines" };
  const late = view.closed ? [] : overdueNodes(view, now);
  const firstMissed = view.frozen ? undefined : late.find((o) => o.kind === "submit");
  if (firstMissed !== undefined) buyerActions++;
  for (const o of late) {
    const parentName = o.view.node.parent_id === null ? null : name(o.view.node.parent_id);
    items.push(
      <PendingItem
        key={`late-${o.view.node.node_id}`}
        icon={<AlarmClock className="size-4" />}
        tone={o.kind === "challenge" ? "bg-accepted-bg text-accepted" : "bg-challenged-bg text-challenged"}
        title={overdueTitle(o, name(o.view.node.node_id))}
        body={
          <span data-testid="overdue" data-kind={o.kind}>
            {overdueBody(o, parentName, formatAmount(o.view.held > 0n ? o.view.held : BigInt(o.view.node.budget), tree.asset), o === firstMissed)} Due {formatUtc(o.at)}, {formatDurationShort(now - o.at)} ago.
          </span>
        }
        action={
          o === firstMissed ? (
            <Button variant="secondary" size="sm" className="pointer-coarse:h-11 max-sm:w-full active:scale-[0.98]" onClick={() => setPending(freezeAction)}>
              <Snowflake /> Freeze hiring
            </Button>
          ) : undefined
        }
      />,
    );
  }

  return (
    <div className="grid gap-6">
      <Panel className="overflow-hidden motion-safe:animate-[rise_600ms_var(--ease-out-quint)_80ms_both]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight">Needs you</h2>
            {buyerActions === 0 ? null : (
              <span className="inline-flex h-5 items-center rounded-full bg-ink px-2 font-mono text-[0.6875rem] text-bg">{`${buyerActions} ${buyerActions === 1 ? "action" : "actions"}`}</span>
            )}
            {view.frozen ? <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-funded-bg px-2 text-[0.6875rem] font-semibold text-funded"><Snowflake aria-hidden className="size-3" />Frozen</span> : null}
          </div>
          {view.closed ? null : (
            <Button variant={view.frozen ? "secondary" : "danger"} size="sm" className="pointer-coarse:h-11 max-sm:px-4 active:scale-[0.98]" onClick={() => setPending(freezeAction)}>
              <Snowflake /> {view.frozen ? "Unfreeze" : "Freeze"}
            </Button>
          )}
        </header>
        {items.length === 0 ? (
          <p className="flex items-center gap-3 px-5 py-5 text-sm text-ink-2 sm:px-6" data-testid="no-pending">
            <span aria-hidden className="relative flex size-2 shrink-0">
              {view.closed ? null : <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />}
              <span className={cn("relative size-2 rounded-full", view.closed ? "bg-ink-3" : "bg-accent")} />
            </span>
            {view.closed ? "This job is closed. The receipt has every payout and refund." : "Nothing needs you right now. Agents are working inside their deadlines."}
          </p>
        ) : (
          <ul className="divide-y divide-line" data-testid="pending-actions">{items}</ul>
        )}
      </Panel>

      <TreeExplorer tree={tree} events={data.events} agents={data.agents} status={data.status} streamError={data.streamError} eventWarnings={data.eventWarnings} variant="embedded" />

      <SignFlow
        open={pending !== null}
        onOpenChange={(open) => (open ? undefined : setPending(null))}
        title={pending?.title ?? ""}
        sentence={pending?.sentence ?? ""}
        actionLabel={pending?.label ?? "Sign"}
        build={async (wallet) => {
          if (pending === null) throw new Error("No action selected.");
          return (await (await getDataSource()).buildTreeActionTx(tree.tree_id, { action: pending.action, node_id: pending.nodeId, change_address: wallet.changeAddress, utxos: wallet.utxos })).tx_cbor;
        }}
        verify={(preview) => (pending !== null && preview.actions.some((a) => a.type === pending.action) ? [] : [`The transaction does not perform ${pending?.action ?? "the chosen action"}.`])}
      />
    </div>
  );
}
