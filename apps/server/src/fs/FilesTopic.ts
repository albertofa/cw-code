import type { FilesTopicData, GitDecorations } from "@cw-code/contracts";
import { filesTopic, topicId } from "@cw-code/shared/topics";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";

export const FILES_TOPIC_PREFIX = "files/";

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETAIN_MS = 10 * 60 * 1000;

export interface FilesTopicDeps {
  ensureWorktree(sessionId: string): Promise<string>;
  decorations(root: string): Promise<GitDecorations>;
  clientPaths(sessionId: string, clientIds: readonly string[]): string[];
  clearClientPaths(clientId: string, sessionId: string): void;
  watch(sessionId: string, root: string, paths: string[]): void;
  unwatch(sessionId: string): void;
  coalesceMs?: number;
  retainMs?: number;
}

type FilesStore = TopicStore<Partial<FilesTopicData>>;

function sessionIdOf(topic: string): string {
  const sessionId = topicId(topic, FILES_TOPIC_PREFIX);
  if (!sessionId) throw new Error(`invalid files topic '${topic}'`);
  return sessionId;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FilesTopic implements TopicProvider {
  private readonly stores = new Map<string, FilesStore>();
  private readonly lastDecorations = new Map<string, GitDecorations>();
  private readonly retainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly computing = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly watchGenerations = new Map<string, number>();
  private watchGeneration = 0;
  private disposed = false;

  constructor(
    private readonly hub: TopicHub,
    private readonly deps: FilesTopicDeps
  ) {}

  owns(topic: string): boolean {
    return topic.startsWith(FILES_TOPIC_PREFIX);
  }

  acquire(topic: string): FilesStore {
    const sessionId = sessionIdOf(topic);
    this.cancelRetain(sessionId);
    const last = this.lastDecorations.get(sessionId);
    const store = this.hub.createStore<Partial<FilesTopicData>>(topic, last ? { decorations: last } : {});
    this.stores.set(sessionId, store);
    this.schedule(sessionId);
    return store;
  }

  release(topic: string): void {
    const sessionId = topicId(topic, FILES_TOPIC_PREFIX);
    if (!sessionId) return;
    this.stores.delete(sessionId);
    this.cancel(sessionId);
    this.retainWhileReleased(sessionId);
  }

  onSubscribe(_clientId: string, topic: string): void {
    this.applyWatchedTopic(topic);
  }

  onUnsubscribe(clientId: string, topic: string): void {
    const sessionId = topicId(topic, FILES_TOPIC_PREFIX);
    if (!sessionId) return;
    this.deps.clearClientPaths(clientId, sessionId);
    this.applyWatched(sessionId);
  }

  resync(topic: string): void {
    this.applyWatchedTopic(topic);
    const sessionId = topicId(topic, FILES_TOPIC_PREFIX);
    if (sessionId) this.schedule(sessionId);
  }

  applyWatched(sessionId: string): void {
    const generation = ++this.watchGeneration;
    const topic = filesTopic(sessionId);
    if (this.hub.subscribers(topic) === 0) {
      this.watchGenerations.delete(sessionId);
      this.deps.unwatch(sessionId);
      return;
    }
    this.watchGenerations.set(sessionId, generation);
    this.deps
      .ensureWorktree(sessionId)
      .then((root) => {
        if (this.watchGenerations.get(sessionId) !== generation) return;
        this.deps.watch(sessionId, root, this.deps.clientPaths(sessionId, [...this.hub.subscriberIds(topic)]));
      })
      .catch((error: unknown) => {
        console.warn(`[files] cannot watch ${sessionId}: ${describeError(error)}`);
      });
  }

  changed(sessionId: string): void {
    this.schedule(sessionId);
  }

  gitPublished(sessionId: string): void {
    this.schedule(sessionId);
  }

  forget(sessionId: string): void {
    this.cancelRetain(sessionId);
    this.lastDecorations.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  resume(): void {
    if (!this.disposed) return;
    this.disposed = false;
    for (const sessionId of this.stores.keys()) this.schedule(sessionId);
  }

  private retainWhileReleased(sessionId: string): void {
    if (!this.lastDecorations.has(sessionId)) return;
    this.cancelRetain(sessionId);
    const timer = setTimeout(() => this.forget(sessionId), this.deps.retainMs ?? DEFAULT_RETAIN_MS);
    timer.unref?.();
    this.retainTimers.set(sessionId, timer);
  }

  private cancelRetain(sessionId: string): void {
    const timer = this.retainTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retainTimers.delete(sessionId);
  }

  private applyWatchedTopic(topic: string): void {
    const sessionId = topicId(topic, FILES_TOPIC_PREFIX);
    if (sessionId) this.applyWatched(sessionId);
  }

  private schedule(sessionId: string): void {
    if (this.disposed || !this.stores.has(sessionId) || this.timers.has(sessionId)) return;
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        this.start(sessionId);
      }, this.deps.coalesceMs ?? DEFAULT_COALESCE_MS)
    );
  }

  private cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.dirty.delete(sessionId);
  }

  private start(sessionId: string): void {
    if (this.computing.has(sessionId)) {
      this.dirty.add(sessionId);
      return;
    }
    this.computing.add(sessionId);
    void this.compute(sessionId).finally(() => {
      this.computing.delete(sessionId);
      if (this.dirty.delete(sessionId)) this.schedule(sessionId);
    });
  }

  private async compute(sessionId: string): Promise<void> {
    const store = this.stores.get(sessionId);
    if (!store) return;
    try {
      const root = await this.deps.ensureWorktree(sessionId);
      const decorations = await this.deps.decorations(root);
      if (this.stores.get(sessionId) !== store) return;
      this.lastDecorations.set(sessionId, decorations);
      store.upsert("decorations", decorations);
    } catch (error) {
      console.warn(`[files] git decorations unavailable for ${sessionId}: ${describeError(error)}`);
    }
  }
}
