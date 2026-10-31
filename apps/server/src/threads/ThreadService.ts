import type {
  ApprovalRequest,
  HistoryMessage,
  QuestionRequest,
  TaskSnapshot,
  ThreadEvent,
  ThreadHistory,
  ThreadTopicData,
  ThreadTurn
} from "@cw-code/contracts";
import { sessionTopic } from "@cw-code/shared/topics";
import { notifyAll } from "../events/notifyAll.js";
import type { PendingRequest } from "../sessions/PendingRequests.js";
import { SessionBusyError } from "../sessions/SessionBusyError.js";
import type { TopicHub } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { clearItems, type ThreadChange, type ThreadField, type ThreadState } from "./threadItems.js";
import {
  abortTurn,
  beginTurn,
  commitTurn,
  createThreadState,
  mergeHistory,
  reduceThreadEvent,
  replaceHistory,
  toTopicData,
  type BegunTurn
} from "./threadReducer.js";
import { threadItemKey } from "./threadTopic.js";

export interface SessionRuntime {
  busy: boolean;
  turn: ThreadTurn | null;
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
}

export type ThreadExtras = Partial<Pick<ThreadTopicData, "babysit" | "prItems" | "prDock" | "usageTotals" | "usageTotalsError" | "turnChanges" | "subagents" | "subagentWait">>;
export type ThreadExtrasProvider = (sessionId: string) => ThreadExtras;
export type SettledTurnEvent = Extract<ThreadEvent, { type: "turn.done" | "turn.error" }>;
export interface ThreadNotice {
  noticeId: string;
  text: string;
  severity: "info" | "warning" | "error";
}

export interface ThreadServiceDeps {
  hub: TopicHub;
  history(sessionId: string): Promise<HistoryMessage[]>;
  hasNoTranscript?(sessionId: string): boolean;
  hasSession?(sessionId: string): boolean;
  liveTasks(sessionId: string): TaskSnapshot[];
  pendingRequests(sessionId: string): PendingRequest[];
  loadHistoryOnSubscribe?: boolean;
  now?: () => number;
  retryDelayMs?: number;
  historyTimeoutMs?: number;
  idleThreadLimit?: number;
}

export const HISTORY_RETRY_DELAY_MS = 2_000;
export const HISTORY_TIMEOUT_MS = 60_000;
export const IDLE_THREAD_LIMIT = 20;

type ThreadStore = TopicStore<ThreadTopicData>;
type LoadMode = "subscribe" | "reload";

const RUNTIME_FIELDS: ReadonlySet<ThreadField> = new Set(["turn", "approvals", "questions"]);
const HISTORY_LOADING: ThreadHistory = { state: "loading", error: null, retrying: false };
const HISTORY_LOADED: ThreadHistory = { state: "loaded", error: null, retrying: false };
const EXTRAS_DEFAULTS: Required<ThreadExtras> = { babysit: null, prItems: [], prDock: [], usageTotals: null, usageTotalsError: null, turnChanges: null, subagents: [], subagentWait: null };

interface ThreadEntry {
  sessionId: string;
  state: ThreadState;
  history: ThreadHistory;
  store: ThreadStore | null;
  generation: number;
  loading: Promise<void> | null;
  loadMode: LoadMode | null;
  interruptedLoad: LoadMode | null;
  retry: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null;
}

class HistoryTimeoutError extends Error {
  constructor(ms: number) {
    super(`history did not load within ${ms} ms`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seededState(pending: PendingRequest[]): ThreadState {
  const state = createThreadState();
  for (const entry of pending) {
    if (entry.kind === "approval") state.approvals = [...state.approvals, entry.request];
    else state.questions = [...state.questions, entry.request];
  }
  return state;
}

export { notifyAll };

export class ThreadService {
  private readonly entries = new Map<string, ThreadEntry>();
  private readonly idle = new Set<string>();
  private readonly runtimeListeners = new Set<(sessionId: string) => void>();
  private readonly settledListeners = new Set<(sessionId: string, turnId: string, event: SettledTurnEvent) => void>();
  private readonly extrasProviders: ThreadExtrasProvider[] = [];
  private disposed = false;

  constructor(private readonly deps: ThreadServiceDeps) {}

  onDriverEvent(sessionId: string, event: ThreadEvent): void {
    if (!sessionId) return;
    const entry = this.entry(sessionId);
    this.apply(entry, reduceThreadEvent(entry.state, event, this.now()));
    if (event.type === "turn.done" || event.type === "turn.error") {
      notifyAll(this.settledListeners, "[threads] turn settled", sessionId, event.turnId, event);
    }
  }

  runtime(sessionId: string): SessionRuntime {
    const state = this.entries.get(sessionId)?.state ?? seededState(this.deps.pendingRequests(sessionId));
    return { busy: state.turn !== null, turn: state.turn, approvals: state.approvals, questions: state.questions };
  }

  onRuntimeChanged(cb: (sessionId: string) => void): () => void {
    this.runtimeListeners.add(cb);
    return () => this.runtimeListeners.delete(cb);
  }

  onTurnSettled(cb: (sessionId: string, turnId: string, event: SettledTurnEvent) => void): () => void {
    this.settledListeners.add(cb);
    return () => this.settledListeners.delete(cb);
  }

  replaceHistory(sessionId: string, history: HistoryMessage[]): void {
    const entry = this.entry(sessionId);
    this.cancelLoad(entry);
    const change = replaceHistory(entry.state, history, this.deps.liveTasks(sessionId));
    entry.history = HISTORY_LOADED;
    this.apply(entry, change, true);
  }

  reloadHistory(sessionId: string): Promise<void> {
    return this.load(this.entry(sessionId), "reload");
  }

  registerExtras(provider: ThreadExtrasProvider): void {
    this.extrasProviders.push(provider);
  }

  refreshExtras(sessionId: string): void {
    const store = this.entries.get(sessionId)?.store;
    if (!store) return;
    const extras = this.extras(sessionId);
    store.batch(() => {
      store.upsert("babysit", extras.babysit);
      store.upsert("prItems", extras.prItems);
      store.upsert("prDock", extras.prDock);
      store.upsert("usageTotals", extras.usageTotals);
      store.upsert("usageTotalsError", extras.usageTotalsError);
      store.upsert("turnChanges", extras.turnChanges);
      store.upsert("subagents", extras.subagents);
      store.upsert("subagentWait", extras.subagentWait);
    });
  }

  isOpen(sessionId: string): boolean {
    return this.deps.hub.subscribers(sessionTopic(sessionId)) > 0;
  }

  beginTurn(sessionId: string, prompt: string, auto: boolean): BegunTurn {
    const entry = this.entry(sessionId);
    if (entry.state.turn !== null && entry.state.turn.turnId === null) throw new SessionBusyError("turn pending");
    const begun = beginTurn(entry.state, { prompt, now: this.now(), auto });
    this.apply(entry, begun.change);
    return begun;
  }

  commitTurn(sessionId: string, pendingId: string, turnId: string): void {
    const entry = this.entry(sessionId);
    this.apply(entry, commitTurn(entry.state, pendingId, turnId));
  }

  abortTurn(sessionId: string, begun: BegunTurn): void {
    const entry = this.entry(sessionId);
    this.apply(entry, abortTurn(entry.state, begun.pendingId, begun.previousTodos, begun.previousTurn));
  }

  acquire(sessionId: string): ThreadStore {
    if (this.deps.hasSession && !this.deps.hasSession(sessionId)) throw new Error(`unknown session '${sessionId}'`);
    const entry = this.entry(sessionId);
    this.idle.delete(sessionId);
    if (!entry.state.historyLoaded && !entry.loading && this.deps.hasNoTranscript?.(sessionId)) {
      this.applyHistory(entry, [], "subscribe");
    }
    const autoLoad = this.deps.loadHistoryOnSubscribe !== false && !entry.state.historyLoaded;
    if (autoLoad && !entry.loading) entry.history = HISTORY_LOADING;
    const store = this.deps.hub.createStore<ThreadTopicData>(sessionTopic(sessionId), this.topicData(entry));
    entry.store = store;
    if (autoLoad) void this.load(entry, "subscribe");
    return store;
  }

  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.store = null;
    if (entry.retry) {
      this.cancelLoad(entry);
      entry.history = this.settledHistory(entry);
    }
    this.retain(entry);
  }

  forget(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.store || entry.state.turn !== null) return;
    this.cancelLoad(entry);
    this.entries.delete(sessionId);
    this.idle.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.loading) entry.interruptedLoad = entry.loadMode;
      this.cancelLoad(entry);
    }
  }

  resume(): void {
    if (!this.disposed) return;
    this.disposed = false;
    for (const entry of this.entries.values()) {
      const mode = entry.interruptedLoad;
      entry.interruptedLoad = null;
      if (mode === null) continue;
      if (entry.store) {
        void this.load(entry, mode);
        continue;
      }
      entry.history = this.settledHistory(entry);
      this.retain(entry);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private entry(sessionId: string): ThreadEntry {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const entry: ThreadEntry = {
      sessionId,
      state: seededState(this.deps.pendingRequests(sessionId)),
      history: HISTORY_LOADING,
      store: null,
      generation: 0,
      loading: null,
      loadMode: null,
      interruptedLoad: null,
      retry: null
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  private apply(entry: ThreadEntry, change: ThreadChange, withHistory = false): void {
    this.publish(entry, change, withHistory);
    this.retain(entry);
    if (change.fields.some((field) => RUNTIME_FIELDS.has(field))) notifyAll(this.runtimeListeners, "[threads] runtime", entry.sessionId);
  }

  private publish(entry: ThreadEntry, change: ThreadChange, withHistory: boolean): void {
    const store = entry.store;
    if (!store) return;
    const { state } = entry;
    try {
      store.batch(() => {
        if (change.reloaded) {
          store.replace(this.topicData(entry));
          return;
        }
        for (const id of change.removed) store.remove(threadItemKey(id));
        for (const id of change.upserted) {
          const item = state.items.get(id);
          if (item) store.upsert(threadItemKey(id), item);
        }
        for (const { id, text } of change.appended) store.append(threadItemKey(id), "text", text);
        for (const field of change.fields) this.writeField(store, state, field);
        if (withHistory) store.upsert("history", entry.history);
      });
    } catch (error) {
      console.warn(`[threads] patch for session ${entry.sessionId} failed; resending the thread: ${errorMessage(error)}`);
      store.replace(this.topicData(entry));
    }
  }

  private writeField(store: ThreadStore, state: ThreadState, field: ThreadField): void {
    switch (field) {
      case "turn":
        store.upsert("turn", state.turn);
        return;
      case "durations":
        store.upsert("durations", state.durations);
        return;
      case "usage":
        store.upsert("usage", state.usage);
        return;
      case "todos":
        store.upsert("todos", state.todos);
        return;
      case "approvals":
        store.upsert("approvals", state.approvals);
        return;
      case "questions":
        store.upsert("questions", state.questions);
        return;
    }
  }

  private settledHistory(entry: ThreadEntry): ThreadHistory {
    return entry.state.historyLoaded ? HISTORY_LOADED : HISTORY_LOADING;
  }

  private setHistory(entry: ThreadEntry, history: ThreadHistory): void {
    entry.history = history;
    entry.store?.upsert("history", history);
  }

  private extras(sessionId: string): Required<ThreadExtras> {
    const merged: Required<ThreadExtras> = { ...EXTRAS_DEFAULTS };
    for (const provider of this.extrasProviders) {
      try {
        Object.assign(merged, provider(sessionId));
      } catch (error) {
        console.warn(`[threads] extras for session ${sessionId} failed: ${errorMessage(error)}`);
      }
    }
    return merged;
  }

  private topicData(entry: ThreadEntry): ThreadTopicData {
    return { history: entry.history, ...this.extras(entry.sessionId), ...toTopicData(entry.state) };
  }

  private retain(entry: ThreadEntry): void {
    const { sessionId, state } = entry;
    this.idle.delete(sessionId);
    if (entry.store || state.turn !== null || entry.loading) return;
    if (state.items.size === 0 && !state.historyLoaded) return;
    this.idle.add(sessionId);
    const limit = this.deps.idleThreadLimit ?? IDLE_THREAD_LIMIT;
    for (const oldest of this.idle) {
      if (this.idle.size <= limit) break;
      this.idle.delete(oldest);
      const evicted = this.entries.get(oldest);
      if (evicted) this.evict(evicted);
    }
  }

  private evict(entry: ThreadEntry): void {
    this.cancelLoad(entry);
    clearItems(entry.state);
    entry.state.historyLoaded = false;
    entry.state.pendingEcho = null;
    entry.history = HISTORY_LOADING;
  }

  private cancelLoad(entry: ThreadEntry): void {
    entry.generation += 1;
    entry.loading = null;
    entry.loadMode = null;
    const retry = entry.retry;
    if (!retry) return;
    entry.retry = null;
    clearTimeout(retry.timer);
    retry.resolve();
  }

  private load(entry: ThreadEntry, mode: LoadMode): Promise<void> {
    if (entry.loading && mode === "subscribe") return entry.loading;
    this.cancelLoad(entry);
    const generation = entry.generation;
    const loading = this.runLoad(entry, generation, mode).catch((error: unknown) => {
      const message = errorMessage(error);
      console.warn(`[threads] history for session ${entry.sessionId} failed: ${message}`);
      if (entry.generation === generation && !this.disposed) this.setHistory(entry, { state: "error", error: message, retrying: false });
    });
    entry.loading = loading;
    entry.loadMode = mode;
    return loading;
  }

  private fetchHistory(sessionId: string): Promise<HistoryMessage[]> {
    const pending = this.deps.history(sessionId);
    const ms = this.deps.historyTimeoutMs ?? HISTORY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HistoryTimeoutError(ms)), ms);
      timer.unref?.();
    });
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  }

  private async runLoad(entry: ThreadEntry, generation: number, mode: LoadMode): Promise<void> {
    const isCurrent = (): boolean => !this.disposed && entry.generation === generation;
    try {
      await Promise.resolve();
      if (!isCurrent()) return;
      this.setHistory(entry, HISTORY_LOADING);
      for (let attempt = 1; ; attempt++) {
        let history: HistoryMessage[];
        try {
          history = await this.fetchHistory(entry.sessionId);
        } catch (error) {
          if (!isCurrent()) return;
          const message = errorMessage(error);
          if (attempt > 1 || error instanceof HistoryTimeoutError) {
            console.warn(`[threads] history for session ${entry.sessionId} failed after a retry: ${message}`);
            this.setHistory(entry, { state: "error", error: message, retrying: false });
            return;
          }
          this.setHistory(entry, { state: "loading", error: message, retrying: true });
          await this.waitForRetry(entry);
          if (!isCurrent()) return;
          continue;
        }
        if (!isCurrent()) return;
        this.applyHistory(entry, history, mode);
        return;
      }
    } finally {
      if (entry.generation === generation) {
        entry.loading = null;
        entry.loadMode = null;
        if (this.disposed) entry.interruptedLoad = mode;
        else this.retain(entry);
      }
    }
  }

  private applyHistory(entry: ThreadEntry, history: HistoryMessage[], mode: LoadMode): void {
    const { state } = entry;
    const liveTasks = this.deps.liveTasks(entry.sessionId);
    const replaceLoaded = mode === "reload" && state.historyLoaded;
    if (replaceLoaded && state.turn !== null) state.historyLoaded = false;
    const change = replaceLoaded && state.turn === null ? replaceHistory(state, history, liveTasks) : mergeHistory(state, history, liveTasks);
    entry.history = HISTORY_LOADED;
    this.apply(entry, change, true);
  }

  private waitForRetry(entry: ThreadEntry): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.retry = null;
        resolve();
      }, this.deps.retryDelayMs ?? HISTORY_RETRY_DELAY_MS);
      timer.unref?.();
      entry.retry = { timer, resolve };
    });
  }
}
