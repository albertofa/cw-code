import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../sessions/SessionStore.js";
import { TopicHub } from "../topics/TopicHub.js";
import { MessageQueue } from "./MessageQueue.js";
import { createThreadState, reduceThreadEvent } from "./threadReducer.js";
import { orderedItems } from "./threadItems.js";
import { ThreadService } from "./ThreadService.js";
import { TurnService, type TurnServiceDeps } from "./TurnService.js";

type Sessions = TurnServiceDeps["sessions"];

function setup(options: { retractable?: boolean; injectFails?: boolean; startGate?: Promise<void> } = {}) {
  let waitSince: number | null = null;
  let failures = 0;
  const dbPath = join(mkdtempSync(join(tmpdir(), "cw-queue-")), "test.db");
  const store = new SessionStore(dbPath);
  const project = store.addProject("C:/proj");
  const sessionId = store.createSession(project.id, "claude", "queue").id;
  const threads = new ThreadService({
    hub: new TopicHub(() => {}),
    history: async () => [],
    liveTasks: () => [],
    pendingRequests: () => [],
    loadHistoryOnSubscribe: false
  });
  const active: Array<{ sessionId: string; turnId: string; startedAt: number }> = [];
  const prompts: string[] = [];
  const injected: string[] = [];
  const retracted: string[] = [];
  const sessions: Sessions = {
    assertCanStartTurn: (id) => {
      if (active.some((turn) => turn.sessionId === id)) throw new Error("busy");
      return { session: store.getSession(id)!, project };
    },
    startTurn: async (id, prompt) => {
      prompts.push(prompt);
      const turnId = `turn-${prompts.length}`;
      active.push({ sessionId: id, turnId, startedAt: 1 });
      threads.onDriverEvent(id, { type: "turn.started", turnId, sessionId: id, startedAt: 1, prompt });
      if (options.startGate) {
        turns.noteTurnStarted(id, turnId);
        await options.startGate;
      }
      return turnId;
    },
    interrupt: (turnId) => {
      const index = active.findIndex((turn) => turn.turnId === turnId);
      if (index >= 0) active.splice(index, 1);
      threads.onDriverEvent(sessionId, { type: "turn.interrupted", turnId, sessionId });
      turns.messageEvent(sessionId, { type: "turn.interrupted", turnId, sessionId });
    },
    listActiveTurns: () => [...active],
    listSubagents: () => [],
    endSubagentWait: () => false,
    findSession: (id) => store.getSession(id),
    subagentWaitSince: () => waitSince,
    injectMessage: async (_id, message) => {
      if (options.injectFails) throw new Error("no active turn to steer");
      if (failures > 0) {
        failures -= 1;
        throw new Error("steer rejected");
      }
      injected.push(message.id);
    },
    retractMessage: async (_id, messageId) => {
      retracted.push(messageId);
      return true;
    },
    canRetractMessages: () => options.retractable ?? false
  };
  const queue = new MessageQueue({ store, refresh: () => {} });
  const turns = new TurnService({ sessions, threads, git: { keptFolderHead: () => null }, queue });
  threads.onTurnSettled((id, _turnId, event) => turns.turnSettled(id, event));
  const emit: (event: Parameters<ThreadService["onDriverEvent"]>[1]) => void = (event) => {
    if (event.type === "turn.done" || event.type === "turn.error" || event.type === "turn.interrupted") {
      const index = active.findIndex((turn) => turn.turnId === event.turnId);
      if (index >= 0) active.splice(index, 1);
    }
    if (event.type === "turn.started") turns.noteTurnStarted(sessionId, event.turnId);
    if (event.type === "user.message") turns.messageEvent(sessionId, event);
    if (event.type === "tool.call" || event.type === "tool.result") turns.toolEvent(sessionId, event);
    threads.onDriverEvent(sessionId, event);
    if (event.type === "turn.interrupted") turns.messageEvent(sessionId, event);
  };
  const done = (turnId: string, isError = false) =>
    emit({ type: "turn.done", turnId, sessionId, resumeCursor: "cursor", resultText: "", usage: [], numTurns: 1, isError, backgroundTasks: 0 });
  const setWait = (since: number | null) => {
    waitSince = since;
  };
  const startExternal = (turnId: string) => {
    active.push({ sessionId, turnId, startedAt: 1 });
    emit({ type: "turn.started", turnId, sessionId, startedAt: 1, prompt: "" });
  };
  const toolCall = (turnId: string, toolCallId: string) => emit({ type: "tool.call", turnId, toolCallId, name: "Read", input: {} });
  const toolResult = (turnId: string, toolCallId: string) => emit({ type: "tool.result", turnId, toolCallId, output: "", isError: false });
  const failNextInject = () => {
    failures += 1;
  };
  return { dbPath, store, sessionId, turns, queue, prompts, injected, retracted, emit, done, setWait, startExternal, toolCall, toolResult, failNextInject };
}

describe("MessageQueue", () => {
  test("leftovers of a turn started outside TurnService (reconnect) still go out at turn.done", async () => {
    const ctx = setup({ injectFails: true });
    await ctx.turns.send(ctx.sessionId, "first");
    ctx.done("turn-1");
    await Promise.resolve();
    ctx.startExternal("retry:1");
    await ctx.turns.send(ctx.sessionId, "during reconnect");
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ text: "during reconnect", state: "sending" }]);

    ctx.done("retry:1");
    await Promise.resolve();

    expect(ctx.prompts).toEqual(["first", "during reconnect"]);
    expect(ctx.queue.list(ctx.sessionId)).toEqual([]);
  });

  test("queues a message sent during a turn and drops it once delivered", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    ctx.toolCall("turn-1", "tool-1");
    const result = await ctx.turns.send(ctx.sessionId, "more", { attachments: ["a.png"] });
    expect(result.disposition).toBe("queued");
    const messageId = result.disposition === "queued" ? result.messageId : "";
    expect(ctx.injected).toEqual([messageId]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ id: messageId, text: "more", state: "sending", removable: false }]);

    ctx.emit({ type: "user.message", turnId: "turn-1", messageId, text: "more", timestamp: 2 });

    expect(ctx.queue.list(ctx.sessionId)).toEqual([]);
  });

  test("turn.done with leftovers starts one turn with the texts joined", async () => {
    const ctx = setup({ injectFails: true });
    await ctx.turns.send(ctx.sessionId, "first");
    await ctx.turns.send(ctx.sessionId, "second", { skills: ["s1"] });
    await ctx.turns.send(ctx.sessionId, "third", { attachments: ["b.txt"] });
    expect(ctx.queue.list(ctx.sessionId).map((message) => message.removable)).toEqual([true, true]);

    ctx.done("turn-1");
    await Promise.resolve();

    expect(ctx.prompts).toEqual(["first", "second\n\nthird"]);
    expect(ctx.queue.list(ctx.sessionId)).toEqual([]);
  });

  test("turn.interrupted holds what is left", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    await ctx.turns.send(ctx.sessionId, "later");

    ctx.emit({ type: "turn.interrupted", turnId: "turn-1", sessionId: ctx.sessionId });

    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ text: "later", state: "held", removable: true }]);
    expect(ctx.prompts).toEqual(["first"]);
  });

  test("unqueue refuses a message the harness cannot give back", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    ctx.toolCall("turn-1", "tool-1");
    const result = await ctx.turns.send(ctx.sessionId, "stuck");
    const messageId = result.disposition === "queued" ? result.messageId : "";

    await expect(ctx.turns.unqueue(ctx.sessionId, messageId)).rejects.toThrow("cannot be removed");
    expect(ctx.queue.list(ctx.sessionId)).toHaveLength(1);
  });

  test("without an open tool a message stays queued, removable and not injected", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    await ctx.turns.send(ctx.sessionId, "later");

    expect(ctx.injected).toEqual([]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ text: "later", state: "sending", removable: true }]);
  });

  test("tool.call injects every waiting message in order and marks them not removable", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    const a = await ctx.turns.send(ctx.sessionId, "a");
    const b = await ctx.turns.send(ctx.sessionId, "b");

    ctx.toolCall("turn-1", "tool-1");
    await Promise.resolve();

    const ids = [a, b].map((result) => (result.disposition === "queued" ? result.messageId : ""));
    expect(ctx.injected).toEqual(ids);
    expect(ctx.queue.list(ctx.sessionId).map((message) => message.removable)).toEqual([false, false]);
  });

  test("a message sent while a tool runs is injected right away; a closed tool holds the next one", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    ctx.toolCall("turn-1", "tool-1");
    const now = await ctx.turns.send(ctx.sessionId, "now");
    expect(ctx.injected).toEqual([now.disposition === "queued" ? now.messageId : ""]);

    ctx.toolResult("turn-1", "tool-1");
    await ctx.turns.send(ctx.sessionId, "later");

    expect(ctx.injected).toHaveLength(1);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([
      { text: "now", removable: false },
      { text: "later", removable: true }
    ]);
  });

  test("a message removed before tool.call is never injected", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    const result = await ctx.turns.send(ctx.sessionId, "oops");
    const messageId = result.disposition === "queued" ? result.messageId : "";

    await ctx.turns.unqueue(ctx.sessionId, messageId);
    ctx.toolCall("turn-1", "tool-1");
    await Promise.resolve();

    expect(ctx.injected).toEqual([]);
    expect(ctx.retracted).toEqual([]);
    expect(ctx.queue.list(ctx.sessionId)).toEqual([]);
  });

  test("a turn that ends without a tool sends the held message as a leftover turn", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    await ctx.turns.send(ctx.sessionId, "after");

    ctx.done("turn-1");
    await Promise.resolve();

    expect(ctx.injected).toEqual([]);
    expect(ctx.prompts).toEqual(["first", "after"]);
    expect(ctx.queue.list(ctx.sessionId)).toEqual([]);
  });

  test("a tool open in a finished turn does not inject into the next one", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    ctx.toolCall("turn-1", "tool-1");
    ctx.done("turn-1");
    await Promise.resolve();
    await ctx.turns.send(ctx.sessionId, "second");
    await ctx.turns.send(ctx.sessionId, "during second");
    ctx.toolCall("turn-1", "tool-2");

    expect(ctx.injected).toEqual([]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ text: "during second", removable: true }]);
  });

  test("a tool.call that arrives while the turn is still starting is kept and injects once start resolves", async () => {
    let release = () => {};
    const startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = setup({ startGate });
    const first = ctx.turns.send(ctx.sessionId, "first");
    const queued = await ctx.turns.send(ctx.sessionId, "during start");
    ctx.toolCall("turn-1", "tool-1");
    expect(ctx.injected).toEqual([]);

    release();
    await first;

    expect(ctx.injected).toEqual([queued.disposition === "queued" ? queued.messageId : ""]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ text: "during start", removable: false }]);
  });

  test("an injection that fails at tool.call goes back to removable and is injected at the next tool.call", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
    const queued = await ctx.turns.send(ctx.sessionId, "retry me");
    const messageId = queued.disposition === "queued" ? queued.messageId : "";
    ctx.failNextInject();

    ctx.toolCall("turn-1", "tool-1");
    await Promise.resolve();
    expect(ctx.injected).toEqual([]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ id: messageId, state: "sending", removable: true }]);

    ctx.toolCall("turn-1", "tool-2");
    await Promise.resolve();
    expect(ctx.injected).toEqual([messageId]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ id: messageId, removable: false }]);
  });

  test("a driver that can retract still injects right away", async () => {
    const ctx = setup({ retractable: true });
    await ctx.turns.send(ctx.sessionId, "first");
    const result = await ctx.turns.send(ctx.sessionId, "now");
    const messageId = result.disposition === "queued" ? result.messageId : "";

    expect(ctx.injected).toEqual([messageId]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ id: messageId, removable: true }]);
    await ctx.turns.unqueue(ctx.sessionId, messageId);
    expect(ctx.retracted).toEqual([messageId]);
  });

  test("the queue survives a store reload as held messages", async () => {
    const ctx = setup({ retractable: true });
    await ctx.turns.send(ctx.sessionId, "first");
    await ctx.turns.send(ctx.sessionId, "pending");

    const reloaded = new SessionStore(ctx.dbPath);

    expect(reloaded.getSession(ctx.sessionId)?.queuedMessages).toMatchObject([{ text: "pending", state: "held", removable: true }]);
  });

  test("reducer inserts the delivered message as a user item mid-turn", () => {
    const state = createThreadState();
    reduceThreadEvent(state, { type: "turn.started", turnId: "t1", sessionId: "s1", startedAt: 1, prompt: "go" }, 1);
    reduceThreadEvent(state, { type: "assistant.delta", turnId: "t1", text: "working" }, 2);
    reduceThreadEvent(state, { type: "user.message", turnId: "t1", messageId: "m1", text: "also this", timestamp: 3 }, 3);
    reduceThreadEvent(state, { type: "assistant.delta", turnId: "t1", text: "ok" }, 4);

    const items = orderedItems(state);
    expect(items.map((item) => item.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(items[2]).toMatchObject({ id: "t1-q-m1", text: "also this", turnId: "t1" });
  });

  test("a message sent while idle starts a turn and leaves held messages alone", async () => {
    const ctx = setup({ retractable: true });
    await ctx.turns.send(ctx.sessionId, "first");
    await ctx.turns.send(ctx.sessionId, "pending");
    ctx.turns.stop(ctx.sessionId);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ text: "pending", state: "held" }]);

    const result = await ctx.turns.send(ctx.sessionId, "new");

    expect(result.disposition).toBe("started");
    expect(ctx.prompts).toEqual(["first", "new"]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ text: "pending", state: "held" }]);
  });

  test("turn.done with isError holds what is left", async () => {
    const ctx = setup({ injectFails: true });
    await ctx.turns.send(ctx.sessionId, "first");
    await ctx.turns.send(ctx.sessionId, "later");

    ctx.done("turn-1", true);
    await Promise.resolve();

    expect(ctx.prompts).toEqual(["first"]);
    expect(ctx.queue.list(ctx.sessionId)).toMatchObject([{ text: "later", state: "held", removable: true }]);
  });

  test("a subagent wait keeps messages queued and sends them before the wake turn", async () => {
    const ctx = setup({ injectFails: true });
    await ctx.turns.send(ctx.sessionId, "first");
    await ctx.turns.send(ctx.sessionId, "user text");
    ctx.setWait(1);
    ctx.done("turn-1");
    await Promise.resolve();
    expect(ctx.prompts).toEqual(["first"]);
    expect(ctx.turns.sendPending(ctx.sessionId)).toBeNull();

    const pending = ctx.turns.sendPending(ctx.sessionId, { ignoreWait: true });
    ctx.setWait(null);
    expect(await pending).toBe("turn-2");
    ctx.done("turn-2");
    await ctx.turns.start(ctx.sessionId, "wake", { origin: "subagent-wake" });

    expect(ctx.prompts).toEqual(["first", "user text", "wake"]);
    expect(ctx.queue.list(ctx.sessionId)).toEqual([]);
  });
});
