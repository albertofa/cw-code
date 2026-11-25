import type { HistoryTopicData } from "@cw-code/contracts";
import { topicId } from "@cw-code/shared/topics";
import { comparableRoot } from "../sessions/worktreeCleanup.js";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import type { HistorySnapshot } from "./HistoryService.js";

export const HISTORY_TOPIC_PREFIX = "history/";

export interface HistoryTopicDeps {
  root(sessionId: string): Promise<string>;
  snapshot(root: string): Promise<HistorySnapshot>;
  setWatched(sessionIds: string[]): void;
}

interface Entry {
  store: TopicStore<HistoryTopicData>;
  rootKey: string | null;
  fingerprint: string | null;
  rev: number;
  generation: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyData(rev: number, error: string | null): HistoryTopicData {
  return { head: null, refs: [], rev, error };
}

export class HistoryTopic implements TopicProvider {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly hub: TopicHub,
    private readonly deps: HistoryTopicDeps
  ) {}

  owns(topic: string): boolean {
    return topic.startsWith(HISTORY_TOPIC_PREFIX);
  }

  acquire(topic: string): TopicStore<HistoryTopicData> {
    const sessionId = topicId(topic, HISTORY_TOPIC_PREFIX);
    if (!sessionId) throw new Error(`invalid history topic '${topic}'`);
    const store = this.hub.createStore<HistoryTopicData>(topic, emptyData(0, null));
    this.entries.set(sessionId, { store, rootKey: null, fingerprint: null, rev: 0, generation: 0 });
    this.syncWatched();
    void this.recompute(sessionId);
    return store;
  }

  release(topic: string): void {
    const sessionId = topicId(topic, HISTORY_TOPIC_PREFIX);
    if (sessionId) this.entries.delete(sessionId);
    this.syncWatched();
  }

  resync(topic: string): void {
    const sessionId = topicId(topic, HISTORY_TOPIC_PREFIX);
    this.syncWatched();
    if (sessionId) void this.recompute(sessionId);
  }

  rootsChanged(roots: string[]): void {
    const keys = new Set(roots.map((root) => comparableRoot(root)));
    for (const [sessionId, entry] of this.entries) {
      if (entry.rootKey === null || keys.has(entry.rootKey)) void this.recompute(sessionId);
    }
  }

  sessionChanged(sessionId: string): void {
    if (this.entries.has(sessionId)) void this.recompute(sessionId);
  }

  async recompute(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    const generation = ++entry.generation;
    const current = (): boolean => this.entries.get(sessionId) === entry && entry.generation === generation;
    let root: string;
    let snapshot: HistorySnapshot;
    try {
      root = await this.deps.root(sessionId);
      if (!current()) return;
      entry.rootKey = comparableRoot(root);
      snapshot = await this.deps.snapshot(root);
    } catch (error) {
      if (!current()) return;
      entry.fingerprint = null;
      entry.store.sync(emptyData(entry.rev, describeError(error)));
      return;
    }
    if (!current()) return;
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== entry.fingerprint) {
      entry.fingerprint = fingerprint;
      entry.rev += 1;
    }
    entry.store.sync({ head: snapshot.head, refs: snapshot.refs, rev: entry.rev, error: null });
  }

  private syncWatched(): void {
    this.deps.setWatched([...this.entries.keys()]);
  }
}
