"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useState } from "react";
import { getDataSource } from "@/lib/api";
import { cn } from "@/lib/cn";
import { txUrl } from "@/lib/explorer";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

const PAGES: [string, string][] = [
  ["/", "Home"],
  ["/console/new", "New job"],
  ["/console/history", "Jobs"],
  ["/economy", "Network"],
  ["/provider", "Provider portal"],
  ["/arbiter", "Arbiter console"],
  ["/ops", "Operations"],
];

const TREE_ID = /^[0-9a-f]{56}$/;
const TX_ID = /^[0-9a-f]{64}$/;
const AGENT_ID = /^[0-9a-f]{56}(?:[0-9a-f]{2}){1,32}$/;

/** Keyboard-first jump to any tree, agent, transaction or page (Cmd+K or Ctrl+K). */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const listId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const trees = useQuery({ queryKey: ["palette-trees"], queryFn: async () => (await getDataSource()).listTrees(null, 10), enabled: open, staleTime: 30_000 });
  const agents = useQuery({ queryKey: ["palette-agents"], queryFn: async () => (await getDataSource()).searchAgents({}), enabled: open, staleTime: 60_000 });

  const commands = useMemo<Command[]>(() => {
    const q = query.trim().toLowerCase();
    const go = (href: string) => () => {
      setOpen(false);
      router.push(href);
    };
    const out: Command[] = [];
    if (TREE_ID.test(q)) {
      out.push({ id: "tree-id", group: "Go to", label: `Tree ${q.slice(0, 8)}…`, run: go(`/tree/${q}`) });
      out.push({ id: "receipt-id", group: "Go to", label: `Receipt for tree ${q.slice(0, 8)}…`, run: go(`/receipt/${q}`) });
    } else if (TX_ID.test(q)) {
      out.push({
        id: "tx",
        group: "Go to",
        label: `Transaction ${q.slice(0, 8)}… on Cardanoscan`,
        hint: "opens a new tab",
        run: () => {
          setOpen(false);
          window.open(txUrl(q, "contracts"), "_blank", "noopener,noreferrer");
        },
      });
    } else if (AGENT_ID.test(q)) {
      out.push({ id: "agent-id", group: "Go to", label: `Agent ${q.slice(56, 64)}…`, run: go(`/agents/${q}`) });
    }
    const onTree = /^\/tree\/([0-9a-f]{56})/.exec(pathname)?.[1];
    if (onTree !== undefined) {
      const actions: Command[] = [
        { id: "replay", group: "This tree", label: "Replay from funding", run: go(`/tree/${onTree}?replay=1`) },
        { id: "stage", group: "This tree", label: "Open the stage view", run: go(`/tree/${onTree}?stage=1`) },
        { id: "receipt", group: "This tree", label: "Open the receipt", run: go(`/receipt/${onTree}`) },
        {
          id: "copy",
          group: "This tree",
          label: "Copy the link to this tree",
          run: () => {
            setOpen(false);
            void navigator.clipboard.writeText(`${window.location.origin}/tree/${onTree}`).catch(() => undefined);
          },
        },
      ];
      out.push(...actions.filter((c) => q === "" || c.label.toLowerCase().includes(q)));
    }
    for (const [href, label] of PAGES) if (q === "" || label.toLowerCase().includes(q)) out.push({ id: `page-${href}`, group: "Pages", label, run: go(href) });
    for (const t of trees.data ?? []) {
      const label = t.goal === "" ? `Tree ${t.tree_id.slice(0, 8)}` : t.goal;
      if (q === "" || label.toLowerCase().includes(q) || t.tree_id.startsWith(q)) out.push({ id: `tree-${t.tree_id}`, group: "Recent trees", label, hint: t.tree_id.slice(0, 8), run: go(`/tree/${t.tree_id}`) });
    }
    for (const a of agents.data ?? []) {
      if (q === "" || a.name.toLowerCase().includes(q) || a.categories.some((c) => c.includes(q))) out.push({ id: `agent-${a.agent_asset_id}`, group: "Agents", label: a.name, hint: `reputation ${Math.round(a.reputation.score * 100)}`, run: go(`/agents/${a.agent_asset_id}`) });
    }
    return out.slice(0, 40);
  }, [query, pathname, trees.data, agents.data, router]);

  useEffect(() => setActive(0), [query]);
  const current = commands[Math.min(active, Math.max(0, commands.length - 1))];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-8 items-center gap-2 rounded-full border border-line bg-surface/70 px-3 text-xs text-ink-3 hover:border-line-strong hover:text-ink lg:inline-flex"
        aria-label="Search trees, agents and pages"
      >
        <Search className="size-3.5" aria-hidden /> Search
        <kbd className="rounded border border-line bg-surface-2 px-1 font-sans text-[0.65rem]">⌘K</kbd>
      </button>
      <button type="button" onClick={() => setOpen(true)} className="grid size-11 place-items-center rounded-full text-ink-2 transition-colors active:bg-surface-2 lg:hidden" aria-label="Search">
        <Search className="size-[18px]" aria-hidden />
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms_ease-out]" />
          <Dialog.Content
            className="fixed top-[max(12px,env(safe-area-inset-top))] left-1/2 z-50 w-[min(600px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-[22px] sm:top-[12vh] border border-line bg-surface shadow-pop data-[state=open]:animate-[rise_160ms_var(--ease-out-quint)]"
            data-testid="command-palette"
          >
            <Dialog.Title className="sr-only">Search</Dialog.Title>
            <Dialog.Description className="sr-only">Jump to a tree, agent, transaction or page. Paste a tree id or transaction hash.</Dialog.Description>
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
              <input
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={current === undefined ? undefined : `${listId}-${current.id}`}
                aria-label="Search trees, agents and pages"
                placeholder="Search, or paste a tree id or transaction hash"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((i) => Math.min(commands.length - 1, i + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter" && current !== undefined) {
                    e.preventDefault();
                    current.run();
                  }
                }}
                className="h-12 w-full bg-transparent text-[0.9375rem] outline-none placeholder:text-ink-3"
                spellCheck={false}
              />
            </div>
            <ul id={listId} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-2">
              {commands.length === 0 ? <li className="px-4 py-6 text-center text-sm text-ink-3">Nothing matches. Paste a full tree id or transaction hash to jump to it.</li> : null}
              {commands.map((c, i) => {
                const first = i === 0 || commands[i - 1]?.group !== c.group;
                return (
                  <li key={c.id} role="presentation">
                    {first ? <p className="px-4 pt-2 pb-1 text-[0.7rem] font-medium text-ink-3">{c.group}</p> : null}
                    <div
                      id={`${listId}-${c.id}`}
                      role="option"
                      aria-selected={c === current}
                      onMouseMove={() => setActive(i)}
                      onClick={() => c.run()}
                      className={cn("mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm", c === current ? "bg-surface-2 text-ink" : "text-ink-2")}
                    >
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.hint !== undefined ? <span className="shrink-0 font-mono text-[0.7rem] text-ink-3">{c.hint}</span> : null}
                      {c.id === "tx" ? <ArrowUpRight className="size-3.5 text-ink-3" aria-hidden /> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
