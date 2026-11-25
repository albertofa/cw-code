import type { HistoryTopicData } from "@cw-code/contracts";
import { topicId } from "@cw-code/shared/topics";
import { comparableRoot } from "../sessions/worktreeCleanup.js";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import type { HistorySnapshot } from "./HistoryService.js";

export const HISTORY_TOPIC_PREFIX = "history/";

export interface HistoryTopicDeps {
  root(sessionId: string, worktreeKey: string | null): Promise<string>;
  snapshot(root: string, withWip: boolean): Promise<HistorySnapshot>;
  setWatched(sessionIds: string[], worktreeRoots: string[]): void;
}

interface Entry {
  sessionId: string;
  worktreeKey: string | null;
  store: TopicStore<HistoryTopicData>;
  root: string | null;
  rootKey: string | null;
  fingerprint: string | null;
  rev: number;
  generation: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyData(rev: number, avatarsRev: number, error: string | null): HistoryTopicData {
  return { head: null, refs: [], rev, avatarsRev, error };
}

function parseTopic(topic: string): { sessionId: string; worktreeKey: string | null } | null {
  const id = topicId(topic, HISTORY_TOPIC_PREFIX);
  if (!id) return null;
  const separator = id.indexOf(":");
  if (separator === -1) return { sessionId: id, worktreeKey: null };
  const sessionId = id.slice(0, separator);
  const worktreeKey = id.slice(separator + 1);
  if (!sessionId || !/^[0-9a-f]{16}$/.test(worktreeKey)) return null;
  return { sessionId, worktreeKey };
}

export class HistoryTopic implements TopicProvider {
  private readonly entries = new Map<string, Entry>();
  private avatarsRev = 0;

  constructor(
    private readonly hub: TopicHub,
    private readonly deps: HistoryTopicDeps
  ) {}

  owns(topic: string): boolean {
    return topic.startsWith(HISTORY_TOPIC_PREFIX);
  }

  acquire(topic: string): TopicStore<HistoryTopicData> {
    const parsed = parseTopic(topic);
    if (!parsed) throw new Error(`invalid history topic '${topic}'`);
    const store = this.hub.createStore<HistoryTopicData>(topic, emptyData(0, this.avatarsRev, null));
    this.entries.set(topic, { ...parsed, store, root: null, rootKey: null, fingerprint: null, rev: 0, generation: 0 });
    this.syncWatched();
    void this.recompute(topic);
    return store;
  }

  release(topic: string): void {
    this.entries.delete(topic);
    this.syncWatched();
  }

  resync(topic: string): void {
    this.syncWatched();
    void this.recompute(topic);
  }

  rootsChanged(roots: string[]): void {
    const keys = new Set(roots.map((root) => comparableRoot(root)));
    for (const [topic, entry] of this.entries) {
      if (entry.rootKey === null || keys.has(entry.rootKey)) void this.recompute(topic);
    }
  }

  sessionChanged(sessionId: string): void {
    for (const [topic, entry] of this.entries) {
      if (entry.sessionId === sessionId && entry.worktreeKey === null) void this.recompute(topic);
    }
  }

  pollWorktrees(): void {
    for (const [topic, entry] of this.entries) {
      if (entry.worktreeKey !== null) void this.recompute(topic);
    }
  }

  async recompute(topic: string): Promise<void> {
    const entry = this.entries.get(topic);
    if (!entry) return;
    const generation = ++entry.generation;
    const current = (): boolean => this.entries.get(topic) === entry && entry.generation === generation;
    let snapshot: HistorySnapshot;
    try {
      const root = await this.deps.root(entry.sessionId, entry.worktreeKey);
      if (!current()) return;
      const rootKey = comparableRoot(root);
      const moved = entry.rootKey !== rootKey;
      entry.root = root;
      entry.rootKey = rootKey;
      if (moved && entry.worktreeKey !== null) this.syncWatched();
      snapshot = await this.deps.snapshot(root, entry.worktreeKey !== null);
    } catch (error) {
      if (!current()) return;
      entry.fingerprint = null;
      entry.store.sync(emptyData(entry.rev, this.avatarsRev, describeError(error)));
      return;
    }
    if (!current()) return;
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== entry.fingerprint) {
      entry.fingerprint = fingerprint;
      entry.rev += 1;
    }
    entry.store.sync({ head: snapshot.head, refs: snapshot.refs, rev: entry.rev, avatarsRev: this.avatarsRev, error: null });
  }

  avatarsChanged(): void {
    this.avatarsRev += 1;
    for (const entry of this.entries.values()) entry.store.sync({ ...entry.store.snapshot().data, avatarsRev: this.avatarsRev });
  }

  private syncWatched(): void {
    const sessionIds = new Set<string>();
    const worktreeRoots = new Map<string, string>();
    for (const entry of this.entries.values()) {
      sessionIds.add(entry.sessionId);
      if (entry.worktreeKey !== null && entry.root !== null && entry.rootKey !== null) worktreeRoots.set(entry.rootKey, entry.root);
    }
    this.deps.setWatched([...sessionIds], [...worktreeRoots.values()]);
  }
}
