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

function setup(options: { retractable?: boolean; injectFails?: boolean } = {}) {
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
      return turnId;
    },
    interrupt: () => {},
    listActiveTurns: () => [...active],
    listSubagents: () => [],
    endSubagentWait: () => false,
    findSession: (id) => store.getSession(id),
    subagentWaitSince: () => null,
    injectMessage: async (_id, message) => {
      if (options.injectFails) throw new Error("no active turn to steer");
      injected.push(message.id);
    },
    retractMessage: async () => true,
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
    threads.onDriverEvent(sessionId, event);
    if (event.type === "user.message" || event.type === "turn.interrupted") turns.messageEvent(sessionId, event);
  };
  const done = (turnId: string) =>
    emit({ type: "turn.done", turnId, sessionId, resumeCursor: "cursor", resultText: "", usage: [], numTurns: 1, isError: false, backgroundTasks: 0 });
  return { dbPath, store, sessionId, turns, queue, prompts, injected, emit, done };
}

describe("MessageQueue", () => {
  test("queues a message sent during a turn and drops it once delivered", async () => {
    const ctx = setup();
    await ctx.turns.send(ctx.sessionId, "first");
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
    const result = await ctx.turns.send(ctx.sessionId, "stuck");
    const messageId = result.disposition === "queued" ? result.messageId : "";

    await expect(ctx.turns.unqueue(ctx.sessionId, messageId)).rejects.toThrow("cannot be removed");
    expect(ctx.queue.list(ctx.sessionId)).toHaveLength(1);
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
});
