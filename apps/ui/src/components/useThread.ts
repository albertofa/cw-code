import { useEffect, useRef } from "react";
import type { TopicState } from "@cw-code/client";
import type { ThreadItem, ThreadTopicData } from "@cw-code/contracts";
import { sessionTopic } from "@cw-code/shared/topics";
import { acquireTopic, peekTopic, useTopicEntry, useTopicSelect, type TopicOptions } from "../server/topics.js";
import { sameItems } from "../server/sidebarData.js";
import { useSessionRow } from "./useSessions.js";

export type ThreadField = Exclude<keyof ThreadTopicData, `item/${string}`>;

const ITEM_PREFIX = "item/";
const HELD: TopicOptions = { whenHidden: "keep" };
const CACHED_THREADS = 8;
const HELD_THREADS = 3;
const NO_ITEMS: ThreadItem[] = [];

interface ItemsCache {
  data: unknown;
  items: ThreadItem[];
}

const itemsCache = new Map<string, ItemsCache>();

function collectItems(data: Record<string, unknown>): ThreadItem[] {
  const items: ThreadItem[] = [];
  let sorted = true;
  for (const key of Object.keys(data)) {
    if (!key.startsWith(ITEM_PREFIX)) continue;
    const item = data[key] as ThreadItem;
    if (sorted && items.length > 0 && items[items.length - 1].seq > item.seq) sorted = false;
    items.push(item);
  }
  return sorted ? items : items.sort((a, b) => a.seq - b.seq);
}

function threadItemsOf(sessionId: string, data: Record<string, unknown> | undefined): ThreadItem[] {
  if (!data) return NO_ITEMS;
  const cached = itemsCache.get(sessionId);
  if (cached?.data === data) return cached.items;
  const next = collectItems(data);
  const items = cached && sameItems(cached.items, next) ? cached.items : next;
  itemsCache.delete(sessionId);
  itemsCache.set(sessionId, { data, items });
  if (itemsCache.size > CACHED_THREADS) {
    const oldest = itemsCache.keys().next().value;
    if (oldest !== undefined) itemsCache.delete(oldest);
  }
  return items;
}

function threadTopic(sessionId: string | null | undefined): string | null {
  return sessionId ? sessionTopic(sessionId) : null;
}

export function useThreadItemsSelect<T>(
  sessionId: string | null | undefined,
  select: (items: ThreadItem[]) => T,
  equal: (a: T, b: T) => boolean = Object.is
): T {
  const last = useRef<{ items: ThreadItem[]; select: (items: ThreadItem[]) => T; value: T } | null>(null);
  return useTopicSelect<T>(
    threadTopic(sessionId),
    (state: TopicState | undefined) => {
      const items = sessionId ? threadItemsOf(sessionId, state?.data) : NO_ITEMS;
      const previous = last.current;
      if (previous && previous.items === items && previous.select === select) return previous.value;
      const value = select(items);
      const kept = previous && equal(previous.value, value) ? previous.value : value;
      last.current = { items, select, value: kept };
      return kept;
    },
    HELD
  );
}

function identity(items: ThreadItem[]): ThreadItem[] {
  return items;
}

export function useThreadItems(sessionId: string | null | undefined): ThreadItem[] {
  return useThreadItemsSelect(sessionId, identity);
}

export function useThreadEntry<K extends ThreadField>(sessionId: string | null | undefined, key: K): ThreadTopicData[K] | undefined {
  return useTopicEntry<ThreadTopicData[K]>(threadTopic(sessionId), key, HELD);
}

export function useThreadTopicError(sessionId: string | null | undefined): string | null {
  return useTopicSelect<string | null>(threadTopic(sessionId), (state) => (state?.status === "error" ? (state.error ?? "unknown error") : null), HELD);
}

export function useHoldRecentThreads(activeSessionId: string | null | undefined): void {
  const held = useRef(new Map<string, () => void>());

  useEffect(() => {
    if (!activeSessionId) return;
    const releases = held.current;
    const release = releases.get(activeSessionId) ?? acquireTopic(sessionTopic(activeSessionId));
    releases.delete(activeSessionId);
    releases.set(activeSessionId, release);
    while (releases.size > HELD_THREADS) {
      const [oldest, releaseOldest] = releases.entries().next().value as [string, () => void];
      releases.delete(oldest);
      releaseOldest();
    }
  }, [activeSessionId]);

  useEffect(() => {
    const releases = held.current;
    return () => {
      for (const release of releases.values()) release();
      releases.clear();
    };
  }, []);
}

function threadBusy(data: ThreadTopicData): boolean {
  return data.turn != null || data.subagentWait != null;
}

export function useThreadBusy(sessionId: string | null | undefined): boolean {
  const live = useTopicSelect<boolean | undefined>(
    threadTopic(sessionId),
    (state) => (state?.status === "ready" ? threadBusy(state.data as ThreadTopicData) : undefined),
    HELD
  );
  const rowBusy = useSessionRow(sessionId)?.busy ?? false;
  return live ?? rowBusy;
}

export function isThreadBusy(sessionId: string): boolean {
  const data = peekTopic<ThreadTopicData>(sessionTopic(sessionId))?.data;
  return data !== undefined && threadBusy(data);
}

export function runningTurnId(turn: ThreadTopicData["turn"] | undefined, items: ThreadItem[]): string | undefined {
  if (!turn) return undefined;
  if (turn.turnId !== null) return turn.turnId;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].pending) return items[i].turnId;
  }
  return undefined;
}
