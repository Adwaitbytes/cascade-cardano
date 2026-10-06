"use client";

import type { CascadeEvent } from "@cascade/shared/browser";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getDataSource, type LiveStatus } from "@/lib/api";
import type { AgentProfile, Tree } from "@/lib/api/schemas";

export interface AgentLabel {
  name: string;
  reputation: number | null;
  /** `cascade.json` may declare `test_agent: true` (PRD 21.1 Flaky Lisan); the UI says so on screen. */
  testAgent: boolean;
}

/**
 * Tree snapshot, full event log and a live WebSocket tail. New events are appended in order and
 * de-duplicated by id; each one also refreshes the snapshot so chain-confirmed state replaces
 * what the events implied.
 */
/**
 * The console opens a tree right after its FundRoot is submitted, which can be before the indexer
 * has seen the block. A 404 then means "not indexed yet": keep asking for about a minute.
 */
const UNINDEXED_RETRIES = 30;
const UNINDEXED_RETRY_MS = 2_000;
const retryUnindexed = (count: number, error: Error): boolean =>
  error instanceof ApiError && error.notFound ? count < UNINDEXED_RETRIES : !(error instanceof ApiError && error.status !== null && error.status < 500) && count < 2;
const unindexedDelay = (count: number, error: Error): number => (error instanceof ApiError && error.notFound ? UNINDEXED_RETRY_MS : Math.min(1_000 * 2 ** count, 30_000));

export function useTreeData(treeId: string) {
  const queryClient = useQueryClient();
  const tree = useQuery({ queryKey: ["tree", treeId], queryFn: async () => (await getDataSource()).getTree(treeId), retry: retryUnindexed, retryDelay: unindexedDelay });
  const history = useQuery({ queryKey: ["tree-events", treeId], queryFn: async () => (await getDataSource()).getTreeEvents(treeId), retry: retryUnindexed, retryDelay: unindexedDelay });
  const [liveEvents, setLiveEvents] = useState<CascadeEvent[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamWarnings, setStreamWarnings] = useState<string[]>([]);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastHistoryId = history.data?.events.at(-1)?.event_id ?? null;
  const historyReady = history.isSuccess;

  useEffect(() => {
    if (!historyReady) return;
    let cancelled = false;
    let close: (() => void) | null = null;
    void getDataSource().then((source) => {
      if (cancelled) return;
      const sub = source.subscribeTree(treeId, lastHistoryId, {
        onEvent: (event) => {
          setLiveEvents((prev) => (prev.some((e) => e.event_id === event.event_id) ? prev : [...prev, event]));
          if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
          refetchTimer.current = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["tree", treeId] }), 800);
        },
        onStatus: setStatus,
        onError: (message) => {
          setStreamError(message);
          setStreamWarnings((w) => (w.length >= 50 ? w : [...w, message]));
        },
      });
      close = () => sub.close();
    });
    return () => {
      cancelled = true;
      close?.();
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
    };
  }, [treeId, historyReady, lastHistoryId, queryClient]);

  const events = useMemo(() => {
    const base = history.data?.events ?? [];
    const seen = new Set(base.map((e) => e.event_id));
    return [...base, ...liveEvents.filter((e) => !seen.has(e.event_id))];
  }, [history.data, liveEvents]);

  const agents = useAgentLabels(tree.data);

  return {
    tree: tree.data,
    events,
    agents,
    status,
    streamError,
    /** Events kept with gaps or skipped; shown only in development. */
    eventWarnings: [...(history.data?.warnings ?? []), ...streamWarnings],
    isLoading: tree.isLoading || history.isLoading,
    error: tree.error ?? history.error,
  };
}

export function useAgentLabels(tree: Tree | undefined): Map<string, AgentLabel> {
  const ids = useMemo(() => [...new Set((tree?.nodes ?? []).map((n) => n.agent_asset_id).filter((id): id is string => typeof id === "string"))], [tree]);
  const combine = useCallback(
    (results: { data?: AgentProfile | undefined }[]) => {
      const map = new Map<string, AgentLabel>();
      results.forEach((r, i) => {
        const id = ids[i];
        if (id !== undefined && r.data !== undefined) map.set(id, { name: r.data.name, reputation: r.data.reputation.score, testAgent: r.data.capabilities.test_agent === true });
      });
      return map;
    },
    [ids],
  );
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["agent", id],
      queryFn: async (): Promise<AgentProfile> => (await getDataSource()).getAgent(id),
      staleTime: 5 * 60_000,
    })),
    combine,
  });
}

/** Current time, ticking once a second, for deadline countdowns. */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);
  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
