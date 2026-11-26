import type { HistoryScope, HistoryTopicData } from "@cw-code/contracts";
import { parseHistoryTopicId, topicId } from "@cw-code/shared/topics";
import { comparableRoot } from "../sessions/worktreeCleanup.js";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import type { HistorySnapshot } from "./HistoryService.js";

export const HISTORY_TOPIC_PREFIX = "history/";

export interface HistoryTopicDeps {
  root(scope: HistoryScope, worktreeKey: string | null): Promise<string>;
  snapshot(root: string, withWip: boolean): Promise<HistorySnapshot>;
  setWatched(sessionIds: string[], worktreeRoots: string[]): void;
}

interface Entry {
  scope: HistoryScope;
  worktreeKey: string | null;
  store: TopicStore<HistoryTopicData>;
  root: string | null;
  rootKey: string | null;
  fingerprint: string | null;
  rev: number;
  generation: number;
}

function isRootOnly(entry: Entry): boolean {
  return entry.worktreeKey !== null || "projectId" in entry.scope;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyData(rev: number, avatarsRev: number, error: string | null): HistoryTopicData {
  return { head: null, refs: [], rev, avatarsRev, fetchedAt: null, error };
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
    const id = topicId(topic, HISTORY_TOPIC_PREFIX);
    const parsed = id ? parseHistoryTopicId(id) : null;
    if (!parsed) throw new Error(`invalid history topic '${topic}'`);
    const store = this.hub.createStore<HistoryTopicData>(topic, emptyData(0, this.avatarsRev, null));
    this.entries.set(topic, { scope: parsed.scope, worktreeKey: parsed.worktreeKey, store, root: null, rootKey: null, fingerprint: null, rev: 0, generation: 0 });
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
      if ("sessionId" in entry.scope && entry.scope.sessionId === sessionId && entry.worktreeKey === null) void this.recompute(topic);
    }
  }

  pollWorktrees(): void {
    for (const [topic, entry] of this.entries) {
      if (isRootOnly(entry)) void this.recompute(topic);
    }
  }

  async recompute(topic: string): Promise<void> {
    const entry = this.entries.get(topic);
    if (!entry) return;
    const generation = ++entry.generation;
    const current = (): boolean => this.entries.get(topic) === entry && entry.generation === generation;
    let snapshot: HistorySnapshot;
    try {
      const root = await this.deps.root(entry.scope, entry.worktreeKey);
      if (!current()) return;
      const rootKey = comparableRoot(root);
      const moved = entry.rootKey !== rootKey;
      entry.root = root;
      entry.rootKey = rootKey;
      if (moved && isRootOnly(entry)) this.syncWatched();
      snapshot = await this.deps.snapshot(root, isRootOnly(entry));
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
    entry.store.sync({ head: snapshot.head, refs: snapshot.refs, rev: entry.rev, avatarsRev: this.avatarsRev, fetchedAt: snapshot.fetchedAt, error: null });
  }

  avatarsChanged(): void {
    this.avatarsRev += 1;
    for (const entry of this.entries.values()) entry.store.sync({ ...entry.store.snapshot().data, avatarsRev: this.avatarsRev });
  }

  private syncWatched(): void {
    const sessionIds = new Set<string>();
    const worktreeRoots = new Map<string, string>();
    for (const entry of this.entries.values()) {
      if ("sessionId" in entry.scope) sessionIds.add(entry.scope.sessionId);
      if (isRootOnly(entry) && entry.root !== null && entry.rootKey !== null) worktreeRoots.set(entry.rootKey, entry.root);
    }
    this.deps.setWatched([...sessionIds], [...worktreeRoots.values()]);
  }
}
