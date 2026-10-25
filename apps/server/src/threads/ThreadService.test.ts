import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { HistoryMessage, ThreadEvent, ThreadTopicData, TopicOp } from "@cw-code/contracts";
import { sessionTopic } from "@cw-code/shared/topics";
import { waitFor } from "../../tests/testing.js";
import type { PendingRequest } from "../sessions/PendingRequests.js";
import { TopicHub } from "../topics/TopicHub.js";
import { ThreadService, type ThreadServiceDeps } from "./ThreadService.js";
import { createThreadTopicProvider } from "./threadTopic.js";

const warn = spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => warn.mockClear());

interface Frame {
  clientIds: string[];
  topic: string;
  rev: number;
  ops: TopicOp[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<Omit<ThreadServiceDeps, "hub">> = {}) {
  const frames: Frame[] = [];
  const hub = new TopicHub((clientIds, frame) => {
    const parsed = JSON.parse(frame) as Omit<Frame, "clientIds">;
    frames.push({ clientIds: [...clientIds], topic: parsed.topic, rev: parsed.rev, ops: parsed.ops });
  });
  const historyCalls: string[] = [];
  const threads = new ThreadService({
    hub,
    history: async (sessionId) => {
      historyCalls.push(sessionId);
      return [];
    },
    liveTasks: () => [],
    pendingRequests: () => [],
    now: () => 5_000,
    retryDelayMs: 5,
    ...overrides
  });
  hub.register(createThreadTopicProvider(threads));
  const subscribe = (sessionId: string, clientId = "c1"): ThreadTopicData => {
    const topic = sessionTopic(sessionId);
    return hub.subscribe({ clientId, client: "web", auth: { kind: "owner" } }, [topic])[topic].data as ThreadTopicData;
  };
  const unsubscribe = (sessionId: string, clientId = "c1"): void => hub.unsubscribeClient(clientId, [sessionTopic(sessionId)]);
  const snapshot = (sessionId: string): ThreadTopicData => subscribe(sessionId, "probe");
  return { hub, frames, threads, historyCalls, subscribe, unsubscribe, snapshot };
}

function itemIds(data: ThreadTopicData): string[] {
  return Object.keys(data)
    .filter((key) => key.startsWith("item/"))
    .map((key) => key.slice("item/".length));
}

function started(turnId: string, prompt = "hello"): ThreadEvent {
  return { type: "turn.started", turnId, sessionId: "s1", prompt, startedAt: 1_000 };
}

function delta(turnId: string, text: string): ThreadEvent {
  return { type: "assistant.delta", turnId, text };
}

function done(turnId: string): ThreadEvent {
  return { type: "turn.done", turnId, sessionId: "s1", resumeCursor: "c", resultText: "", usage: [], numTurns: 1, isError: false, backgroundTasks: 0 };
}

const HISTORY: HistoryMessage[] = [
  { id: "h1", role: "user", text: "earlier", turnId: "h0", timestamp: 100 },
  { id: "h2", role: "assistant", text: "reply", turnId: "h0", timestamp: 200 }
];

describe("ThreadService history", () => {
  test("subscribing loads history into the topic with a replace", async () => {
    const pending = deferred<HistoryMessage[]>();
    const { threads, frames, subscribe, snapshot } = setup({ history: () => pending.promise });
    const initial = subscribe("s1");
    expect(initial.history).toEqual({ state: "loading", error: null, retrying: false });
    expect(initial.prItems).toEqual([]);
    expect(initial.babysit).toBeNull();

    pending.resolve(HISTORY);
    await waitFor(() => expect(snapshot("s1").history.state).toBe("loaded"));

    expect(itemIds(snapshot("s1"))).toEqual(["h1", "h2"]);
    expect(frames.some((frame) => frame.topic === "session/s1" && frame.ops.some((op) => op.op === "replace"))).toBe(true);
    expect(threads.isOpen("s1")).toBe(true);
  });

  test("a failed load retries once, then reports the error", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const { subscribe, snapshot } = setup({
      history: async () => {
        calls += 1;
        if (calls === 2) await gate.promise;
        throw new Error(`boom ${calls}`);
      },
      retryDelayMs: 20
    });
    subscribe("s1");
    await waitFor(() => expect(snapshot("s1").history).toEqual({ state: "loading", error: "boom 1", retrying: true }), { interval: 2 });
    await waitFor(() => expect(calls).toBe(2), { interval: 2 });
    gate.resolve();
    await waitFor(() => expect(snapshot("s1").history).toEqual({ state: "error", error: "boom 2", retrying: false }), { interval: 2 });
    expect(calls).toBe(2);
  });

  test("reloadHistory forces a fresh load that replaces a loaded thread", async () => {
    let history = HISTORY;
    const { threads, subscribe, snapshot } = setup({ history: async () => history });
    subscribe("s1");
    await waitFor(() => expect(snapshot("s1").history.state).toBe("loaded"));
    history = [{ id: "h9", role: "assistant", text: "fresh", turnId: "h9" }];
    await threads.reloadHistory("s1");
    expect(itemIds(snapshot("s1"))).toEqual(["h9"]);
  });

  test("reloadHistory recovers a thread whose load failed", async () => {
    let fail = true;
    const { threads, subscribe, snapshot } = setup({
      history: async () => {
        if (fail) throw new Error("offline");
        return HISTORY;
      }
    });
    subscribe("s1");
    await waitFor(() => expect(snapshot("s1").history.state).toBe("error"));
    fail = false;
    await threads.reloadHistory("s1");
    expect(snapshot("s1").history).toEqual({ state: "loaded", error: null, retrying: false });
    expect(itemIds(snapshot("s1"))).toEqual(["h1", "h2"]);
  });

  test("events received before the subscribe are kept after the history merge", async () => {
    const { threads, subscribe, snapshot } = setup({ history: async () => HISTORY });
    threads.onDriverEvent("s1", started("turn-1", "now"));
    threads.onDriverEvent("s1", delta("turn-1", "live"));
    subscribe("s1");
    await waitFor(() => expect(snapshot("s1").history.state).toBe("loaded"));
    const data = snapshot("s1");
    expect(itemIds(data)).toEqual(["h1", "h2", "turn-1-u", "turn-1-a"]);
    expect(data["item/turn-1-a"]?.text).toBe("live");
    expect(data.turn).toMatchObject({ phase: "running", turnId: "turn-1" });
  });

  test("replaceHistory publishes the given history as loaded", () => {
    const { threads, subscribe, snapshot } = setup({ loadHistoryOnSubscribe: false });
    subscribe("s1");
    threads.replaceHistory("s1", HISTORY);
    expect(snapshot("s1").history.state).toBe("loaded");
    expect(itemIds(snapshot("s1"))).toEqual(["h1", "h2"]);
  });

  test("a release during a reload's retry wait keeps a loaded thread loaded", async () => {
    let calls = 0;
    const { threads, hub, subscribe, unsubscribe, snapshot } = setup({
      history: async () => {
        calls += 1;
        if (calls === 2) throw new Error("transient");
        return HISTORY;
      },
      retryDelayMs: 50
    });
    subscribe("s1");
    await waitFor(() => expect(snapshot("s1").history.state).toBe("loaded"));
    const reload = threads.reloadHistory("s1");
    await waitFor(() => expect(snapshot("s1").history.retrying).toBe(true), { interval: 2 });
    hub.unsubscribeClient("probe", [sessionTopic("s1")]);
    unsubscribe("s1");
    await reload;

    const after = subscribe("s1", "c2");
    expect(after.history).toEqual({ state: "loaded", error: null, retrying: false });
    expect(itemIds(after)).toEqual(["h1", "h2"]);
    expect(calls).toBe(2);
  });

  test("a history load that never settles times out into the error state", async () => {
    const { subscribe, snapshot } = setup({ history: () => new Promise<HistoryMessage[]>(() => {}), historyTimeoutMs: 10 });
    subscribe("s1");
    await waitFor(() => expect(snapshot("s1").history).toEqual({ state: "error", error: "history did not load within 10 ms", retrying: false }), {
      interval: 2
    });
  });

  test("a history merge that throws reports the error instead of rejecting", async () => {
    const { threads, subscribe, snapshot } = setup({
      loadHistoryOnSubscribe: false,
      history: async () => HISTORY,
      liveTasks: () => {
        throw new Error("live tasks broke");
      }
    });
    subscribe("s1");
    await threads.reloadHistory("s1");
    expect(snapshot("s1").history).toEqual({ state: "error", error: "live tasks broke", retrying: false });
  });

  test("history is not loaded on subscribe when that is turned off", async () => {
    const { historyCalls, subscribe } = setup({ loadHistoryOnSubscribe: false });
    subscribe("s1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(historyCalls).toEqual([]);
  });
});

describe("ThreadService patches", () => {
  test("each change is published synchronously, deltas as appends on the item text", () => {
    const { threads, frames, subscribe } = setup({ loadHistoryOnSubscribe: false });
    subscribe("s1");
    threads.onDriverEvent("s1", started("turn-1"));
    threads.onDriverEvent("s1", delta("turn-1", "a"));
    const before = frames.length;
    threads.onDriverEvent("s1", delta("turn-1", "b"));
    expect(frames.length).toBe(before + 1);
    expect(frames.at(-1)?.ops).toEqual([{ op: "append", key: "item/turn-1-a", field: "text", text: "b" }]);
  });

  test("a change set becomes one batch", () => {
    const { threads, frames, subscribe } = setup({ loadHistoryOnSubscribe: false });
    subscribe("s1");
    const before = frames.length;
    threads.onDriverEvent("s1", started("turn-1"));
    expect(frames.length).toBe(before + 1);
    const keys = frames.at(-1)?.ops.map((op) => ("key" in op ? op.key : op.op));
    expect(keys).toEqual(["item/turn-1-u", "turn"]);
  });

  test("a released store is never written and the next subscribe sees the kept state", () => {
    const { threads, frames, subscribe, unsubscribe } = setup({ loadHistoryOnSubscribe: false });
    subscribe("s1");
    threads.onDriverEvent("s1", started("turn-1"));
    unsubscribe("s1");
    const before = frames.length;
    threads.onDriverEvent("s1", delta("turn-1", "while away"));
    expect(frames.length).toBe(before);
    expect(warn).not.toHaveBeenCalled();
    const data = subscribe("s1");
    expect(data["item/turn-1-a"]?.text).toBe("while away");
  });

  test("approvals and questions are seeded from the pending requests", () => {
    const pending: PendingRequest[] = [
      { kind: "approval", sessionId: "s1", turnId: "t", request: { requestId: "a1", kind: "command", title: "Run", decisions: ["accept"] } }
    ];
    const { threads, subscribe } = setup({ loadHistoryOnSubscribe: false, pendingRequests: (id) => (id === "s1" ? pending : []) });
    expect(threads.runtime("s1").approvals.map((a) => a.requestId)).toEqual(["a1"]);
    expect(subscribe("s1").approvals.map((a) => a.requestId)).toEqual(["a1"]);
  });

  test("extras fill the snapshot and refreshExtras publishes them", () => {
    let count = 0;
    const { threads, subscribe, snapshot } = setup({ loadHistoryOnSubscribe: false });
    threads.registerExtras(() => ({ usageTotals: count === 0 ? null : { totalTokens: count, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, turns: 1, sessions: 1, unpricedTurns: 0 } }));
    expect(subscribe("s1").usageTotals).toBeNull();
    count = 7;
    threads.refreshExtras("s1");
    expect(snapshot("s1").usageTotals?.totalTokens).toBe(7);
  });
});

describe("ThreadService runtime", () => {
  test("runtime changes fire for turn changes but never for pure deltas", () => {
    const { threads } = setup();
    const changed: string[] = [];
    threads.onRuntimeChanged((sessionId) => changed.push(sessionId));
    threads.onDriverEvent("s1", started("turn-1"));
    expect(changed).toEqual(["s1"]);
    threads.onDriverEvent("s1", delta("turn-1", "a"));
    threads.onDriverEvent("s1", delta("turn-1", "b"));
    expect(changed).toEqual(["s1"]);
    threads.onDriverEvent("s1", done("turn-1"));
    expect(changed).toEqual(["s1", "s1"]);
    expect(threads.runtime("s1")).toMatchObject({ busy: false, turn: null });
  });

  test("turn.done and turn.error are reported as settled", () => {
    const { threads } = setup();
    const settled: string[] = [];
    threads.onTurnSettled((sessionId, turnId, event) => settled.push(`${sessionId}:${turnId}:${event.type}`));
    threads.onDriverEvent("s1", started("turn-1"));
    threads.onDriverEvent("s1", done("turn-1"));
    threads.onDriverEvent("s1", { type: "turn.error", turnId: "turn-2", message: "x" });
    expect(settled).toEqual(["s1:turn-1:turn.done", "s1:turn-2:turn.error"]);
  });

  test("events without a session id are ignored", () => {
    const { threads } = setup();
    const changed: string[] = [];
    const settled: string[] = [];
    threads.onRuntimeChanged((sessionId) => changed.push(sessionId));
    threads.onTurnSettled((sessionId) => settled.push(sessionId));
    threads.onDriverEvent("", { type: "turn.error", turnId: "stray", message: "x" });
    threads.onDriverEvent("", delta("stray", "text"));
    expect(changed).toEqual([]);
    expect(settled).toEqual([]);
  });

  test("dispose then resume keeps listeners and fires each exactly once", () => {
    const { threads, subscribe, snapshot } = setup({ loadHistoryOnSubscribe: false });
    subscribe("s1");
    const changed: string[] = [];
    const settled: string[] = [];
    threads.onRuntimeChanged((sessionId) => changed.push(sessionId));
    threads.onTurnSettled((sessionId) => settled.push(sessionId));
    threads.dispose();
    threads.resume();
    threads.onDriverEvent("s1", started("turn-1"));
    threads.onDriverEvent("s1", done("turn-1"));
    expect(changed).toEqual(["s1", "s1"]);
    expect(settled).toEqual(["s1"]);
    expect(itemIds(snapshot("s1"))).toEqual(["turn-1-u"]);
  });

  test("resume restarts a history load interrupted by dispose", async () => {
    let calls = 0;
    const first = deferred<HistoryMessage[]>();
    const { threads, subscribe, snapshot } = setup({
      history: () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve(HISTORY);
      }
    });
    subscribe("s1");
    await waitFor(() => expect(calls).toBe(1), { interval: 2 });
    threads.dispose();
    first.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshot("s1").history.state).toBe("loading");
    threads.resume();
    await waitFor(() => expect(snapshot("s1").history.state).toBe("loaded"), { interval: 2 });
    expect(calls).toBe(2);
    expect(itemIds(snapshot("s1"))).toEqual(["h1", "h2"]);
  });
});

describe("ThreadService memory", () => {
  test("idle threads beyond the LRU limit drop their items but keep runtime state", async () => {
    const { threads, historyCalls, subscribe } = setup({ idleThreadLimit: 2, history: async (id) => (historyCalls.push(id), HISTORY) });
    for (const id of ["s1", "s2", "s3"]) {
      threads.onDriverEvent(id, started(`${id}-t`));
      threads.onDriverEvent(id, done(`${id}-t`));
    }
    const evicted = subscribe("s1");
    expect(itemIds(evicted)).toEqual([]);
    expect(evicted.durations).toEqual({ "s1-t": 4_000 });
    await waitFor(() => expect(historyCalls).toEqual(["s1"]));
    expect(itemIds(subscribe("s3"))).toEqual(["s3-t-u"]);
  });

  test("subscribed threads and threads with a turn in flight are never evicted", () => {
    const { threads, subscribe, snapshot } = setup({ idleThreadLimit: 1, loadHistoryOnSubscribe: false });
    subscribe("open");
    threads.onDriverEvent("open", started("open-t"));
    threads.onDriverEvent("open", done("open-t"));
    threads.onDriverEvent("busy", started("busy-t"));
    for (const id of ["a", "b", "c"]) {
      threads.onDriverEvent(id, started(`${id}-t`));
      threads.onDriverEvent(id, done(`${id}-t`));
    }
    expect(itemIds(snapshot("open"))).toEqual(["open-t-u"]);
    expect(itemIds(snapshot("busy"))).toEqual(["busy-t-u"]);
    expect(itemIds(snapshot("b"))).toEqual([]);
  });
});
