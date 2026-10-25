import { useRef } from "react";
import type { TopicState } from "@cw-code/client";
import type { SessionRow, SidebarLayout, WorktreeCandidate } from "@cw-code/contracts";
import { SIDEBAR_TOPIC } from "@cw-code/shared/topics";
import { useTopicEntry, useTopicSelect, type TopicOptions } from "../server/topics.js";
import { rowKey, sameItems, sidebarRows, worktreesKey } from "../server/sidebarData.js";

const HELD: TopicOptions = { whenHidden: "keep" };
const NO_ROWS: SessionRow[] = [];
const NO_CANDIDATES: WorktreeCandidate[] = [];

interface ListCache<T> {
  data: unknown;
  list: T[];
}

function useSidebarList<T>(select: (data: Record<string, unknown>) => T[], empty: T[]): T[] {
  const cache = useRef<ListCache<T> | null>(null);
  return useTopicSelect<T[]>(
    SIDEBAR_TOPIC,
    (state: TopicState | undefined) => {
      const data = state?.data;
      const cached = cache.current;
      if (cached && cached.data === data) return cached.list;
      const next = data ? select(data) : empty;
      const list = cached && sameItems(cached.list, next) ? cached.list : next;
      cache.current = { data, list };
      return list;
    },
    HELD
  );
}

export function useSessions(): SessionRow[] {
  return useSidebarList(sidebarRows, NO_ROWS);
}

export function useSessionRow(sessionId: string | null | undefined): SessionRow | undefined {
  return useTopicEntry<SessionRow>(SIDEBAR_TOPIC, sessionId ? rowKey(sessionId) : "", HELD);
}

export function useSidebarLayout(): SidebarLayout | undefined {
  return useTopicEntry<SidebarLayout>(SIDEBAR_TOPIC, "layout", HELD);
}

export function useWorktreeCandidates(projectId: string | null): WorktreeCandidate[] {
  return useTopicEntry<WorktreeCandidate[]>(SIDEBAR_TOPIC, projectId ? worktreesKey(projectId) : "", HELD) ?? NO_CANDIDATES;
}
