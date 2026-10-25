import type { TopicOp, TopicPatch, TopicsSubscribeResult } from "@cw-code/contracts";
import { isValidTopic, MAX_TOPICS_PER_CALL } from "@cw-code/shared/topics";
import { ServerCallError, type ConnectionState, type ServerClient } from "./ServerClient.js";

export interface TopicState<D = Record<string, unknown>> {
  status: "subscribing" | "ready" | "error";
  rev: number;
  data: D;
  error: string | null;
}

interface Entry {
  refs: number;
  state: TopicState;
  subscribed: boolean;
  invalid: boolean;
  inflight: object | null;
  buffer: TopicPatch[];
}

const PTY_PREFIX = "pty/";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chunk(topics: string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < topics.length; i += MAX_TOPICS_PER_CALL) batches.push(topics.slice(i, i + MAX_TOPICS_PER_CALL));
  return batches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applyTopicOps<D extends Record<string, unknown>>(data: D, ops: TopicOp[]): D {
  let next: Record<string, unknown> = data;
  let owned = false;
  const writable = (): Record<string, unknown> => {
    if (!owned) {
      next = { ...next };
      owned = true;
    }
    return next;
  };
  for (const op of ops) {
    switch (op.op) {
      case "replace":
        next = op.value;
        owned = false;
        break;
      case "upsert":
        if (!Object.hasOwn(next, op.key) || next[op.key] !== op.value) writable()[op.key] = op.value;
        break;
      case "remove":
        if (Object.hasOwn(next, op.key)) delete writable()[op.key];
        break;
      case "append": {
        const entry = next[op.key];
        if (!isRecord(entry)) break;
        const current = entry[op.field];
        writable()[op.key] = { ...entry, [op.field]: (typeof current === "string" ? current : "") + op.text };
        break;
      }
    }
  }
  return next as D;
}

export function orderedEntries<T extends { seq: number }>(data: Record<string, unknown>, prefix: string): T[] {
  const entries: T[] = [];
  for (const key of Object.keys(data)) {
    if (key.startsWith(prefix)) entries.push(data[key] as T);
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

export class TopicCache {
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<() => void>>();
  private epochListeners = new Set<(epoch: number) => void>();
  private epochValue = 0;
  private dirty = new Set<string>();
  private flushScheduled = false;
  private openedBefore: boolean;
  private disposed = false;
  private readonly offPatch: () => void;
  private readonly offState: () => void;

  constructor(private readonly client: ServerClient) {
    this.openedBefore = client.state === "open";
    this.offPatch = client.onPatch((patch) => this.handlePatch(patch));
    this.offState = client.onState((state, previous) => this.handleState(state, previous));
  }

  get epoch(): number {
    return this.epochValue;
  }

  acquire(topic: string): () => void {
    if (this.disposed) return () => undefined;
    let entry = this.entries.get(topic);
    if (!entry) {
      entry = this.createEntry(topic);
      this.entries.set(topic, entry);
      this.notify(topic);
    }
    const owner = entry;
    owner.refs += 1;
    this.markDirty(topic);
    let released = false;
    return () => {
      if (released || this.disposed || this.entries.get(topic) !== owner) return;
      released = true;
      owner.refs -= 1;
      this.markDirty(topic);
    };
  }

  state<D = Record<string, unknown>>(topic: string): TopicState<D> | undefined {
    return this.entries.get(topic)?.state as TopicState<D> | undefined;
  }

  listen(topic: string, cb: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(cb);
    return () => {
      this.listeners.get(topic)?.delete(cb);
    };
  }

  onEpoch(cb: (epoch: number) => void): () => void {
    this.epochListeners.add(cb);
    return () => {
      this.epochListeners.delete(cb);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offPatch();
    this.offState();
    const subscribed = [...this.entries].filter(([, entry]) => entry.subscribed).map(([topic]) => topic);
    this.unsubscribe(subscribed);
    this.entries.clear();
    this.dirty.clear();
    this.listeners.clear();
    this.epochListeners.clear();
  }

  private createEntry(topic: string): Entry {
    const invalid = !isValidTopic(topic) || topic.startsWith(PTY_PREFIX);
    return {
      refs: 0,
      subscribed: false,
      invalid,
      inflight: null,
      buffer: [],
      state: invalid
        ? { status: "error", rev: 0, data: {}, error: `invalid topic "${topic}"` }
        : { status: "subscribing", rev: 0, data: {}, error: null }
    };
  }

  private markDirty(topic: string): void {
    this.dirty.add(topic);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (!this.disposed) this.flush();
    });
  }

  private flush(): void {
    const topics = [...this.dirty];
    this.dirty.clear();
    const added: string[] = [];
    const removed: string[] = [];
    for (const topic of topics) {
      const entry = this.entries.get(topic);
      if (!entry) continue;
      if (entry.refs === 0) {
        this.entries.delete(topic);
        if (entry.subscribed) removed.push(topic);
      } else if (!entry.subscribed && !entry.invalid) added.push(topic);
    }
    if (this.client.state !== "open") return;
    this.unsubscribe(removed);
    if (added.length > 0) void this.subscribe(added);
  }

  private unsubscribe(topics: string[]): void {
    if (this.client.state !== "open") return;
    for (const batch of chunk(topics)) this.client.send("topics.unsubscribe", { topics: batch });
  }

  private subscribe(topics: string[]): Promise<void> {
    return Promise.all(chunk(topics).map((batch) => this.subscribeBatch(batch))).then(() => undefined);
  }

  private async subscribeBatch(topics: string[]): Promise<void> {
    const token = {};
    const live: string[] = [];
    for (const topic of topics) {
      const entry = this.entries.get(topic);
      if (!entry) continue;
      entry.subscribed = true;
      entry.inflight = token;
      entry.buffer = [];
      live.push(topic);
      if (entry.state.status === "error") this.update(topic, entry, { ...entry.state, status: "subscribing", error: null });
    }
    if (live.length === 0) return;
    try {
      const result = await this.client.call<TopicsSubscribeResult>("topics.subscribe", { topics: live });
      for (const topic of live) this.applySnapshot(topic, token, result[topic]);
    } catch (error) {
      if (error instanceof ServerCallError && error.code === "disconnected") {
        for (const topic of live) this.abandon(topic, token);
      } else if (live.length > 1) {
        await Promise.all(live.map((topic) => this.subscribeBatch([topic])));
      } else {
        this.fail(live[0] as string, token, describe(error));
      }
    }
  }

  private applySnapshot(topic: string, token: object, snapshot: TopicsSubscribeResult[string] | undefined): void {
    const entry = this.entries.get(topic);
    if (!entry || entry.inflight !== token) return;
    if (!snapshot) {
      this.fail(topic, token, `server returned no snapshot for "${topic}"`);
      return;
    }
    entry.inflight = null;
    const buffered = entry.buffer;
    entry.buffer = [];
    let state: TopicState = { status: "ready", rev: snapshot.rev, data: snapshot.data, error: null };
    let gap = false;
    for (const patch of buffered) {
      if (patch.rev <= state.rev) continue;
      if (patch.rev !== state.rev + 1) {
        gap = true;
        break;
      }
      state = { ...state, rev: patch.rev, data: applyTopicOps(state.data, patch.ops) };
    }
    this.update(topic, entry, state);
    if (gap) void this.subscribeBatch([topic]);
  }

  private abandon(topic: string, token: object): void {
    const entry = this.entries.get(topic);
    if (!entry || entry.inflight !== token) return;
    entry.inflight = null;
    entry.buffer = [];
    entry.subscribed = false;
  }

  private fail(topic: string, token: object, message: string): void {
    const entry = this.entries.get(topic);
    if (!entry || entry.inflight !== token) return;
    entry.inflight = null;
    entry.buffer = [];
    entry.subscribed = false;
    this.update(topic, entry, { ...entry.state, status: "error", error: message });
  }

  private handlePatch(patch: TopicPatch): void {
    const entry = this.entries.get(patch.topic);
    if (!entry || entry.refs === 0) return;
    if (entry.inflight) {
      entry.buffer.push(patch);
      return;
    }
    if (entry.state.status !== "ready" || patch.rev <= entry.state.rev) return;
    if (patch.rev !== entry.state.rev + 1) {
      void this.subscribeBatch([patch.topic]);
      return;
    }
    this.update(patch.topic, entry, { ...entry.state, rev: patch.rev, data: applyTopicOps(entry.state.data, patch.ops) });
  }

  private handleState(state: ConnectionState, previous: ConnectionState): void {
    if (this.disposed) return;
    if (previous === "open" && state !== "open") {
      for (const entry of this.entries.values()) entry.subscribed = false;
      return;
    }
    if (state !== "open") return;
    const reconnect = this.openedBefore;
    this.openedBefore = true;
    if (!reconnect) {
      for (const topic of this.entries.keys()) this.dirty.add(topic);
      this.flush();
      return;
    }
    this.resubscribeAll();
  }

  private resubscribeAll(): void {
    this.dirty.clear();
    const topics: string[] = [];
    for (const [topic, entry] of [...this.entries]) {
      if (entry.refs === 0) this.entries.delete(topic);
      else if (!entry.invalid) topics.push(topic);
    }
    void this.subscribe(topics).then(() => this.bumpEpoch());
  }

  private bumpEpoch(): void {
    if (this.disposed) return;
    this.epochValue += 1;
    for (const cb of [...this.epochListeners]) {
      try {
        cb(this.epochValue);
      } catch (error) {
        console.error("[TopicCache] epoch listener failed", error);
      }
    }
  }

  private update(topic: string, entry: Entry, next: TopicState): void {
    entry.state = next;
    this.notify(topic);
  }

  private notify(topic: string): void {
    for (const cb of [...(this.listeners.get(topic) ?? [])]) {
      try {
        cb();
      } catch (error) {
        console.error(`[TopicCache] listener for "${topic}" failed`, error);
      }
    }
  }
}
