import { describe, expect, test } from "bun:test";
import type { ThreadTopicData, TopicOp } from "@cw-code/contracts";
import { sessionTopic } from "@cw-code/shared/topics";
import { TopicHub } from "../topics/TopicHub.js";
import { ThreadService } from "./ThreadService.js";
import { createThreadTopicProvider } from "./threadTopic.js";
import { TurnService, type TurnServiceDeps } from "./TurnService.js";

type Sessions = TurnServiceDeps["sessions"];

function setup(startTurn: Sessions["startTurn"]) {
  const log: string[] = [];
  const hub = new TopicHub((_clientIds, frame) => {
    const { ops } = JSON.parse(frame) as { ops: TopicOp[] };
    for (const op of ops) log.push(`patch:${op.op}:${"key" in op ? op.key : ""}`);
  });
  const threads = new ThreadService({
    hub,
    history: async () => [],
    liveTasks: () => [],
    pendingRequests: () => [],
    loadHistoryOnSubscribe: false,
    now: () => 500
  });
  hub.register(createThreadTopicProvider(threads));
  const active: Array<{ sessionId: string; turnId: string; startedAt: number }> = [];
  const interrupted: string[] = [];
  const known = new Set(["s1"]);
  const sessions: Sessions = {
    assertCanStartTurn: (sessionId) => {
      if (!known.has(sessionId)) throw new Error(`unknown session ${sessionId}`);
      return {} as ReturnType<Sessions["assertCanStartTurn"]>;
    },
    startTurn,
    interrupt: (turnId) => {
      interrupted.push(turnId);
      const index = active.findIndex((turn) => turn.turnId === turnId);
      if (index < 0) return;
      const [turn] = active.splice(index, 1);
      threads.onDriverEvent(turn.sessionId, { type: "turn.interrupted", turnId, sessionId: turn.sessionId });
    },
    listActiveTurns: () => [...active]
  };
  const turns = new TurnService({ sessions, threads });
  const topic = sessionTopic("s1");
  hub.subscribe({ clientId: "c1", client: "web", auth: { kind: "owner" } }, [topic]);
  const snapshot = (): ThreadTopicData => hub.subscribe({ clientId: "c1", client: "web", auth: { kind: "owner" } }, [topic])[topic].data as ThreadTopicData;
  const markStarted = (turnId: string, prompt: string): void => {
    active.push({ sessionId: "s1", turnId, startedAt: 600 });
    threads.onDriverEvent("s1", { type: "turn.started", turnId, sessionId: "s1", startedAt: 600, prompt });
  };
  return { threads, turns, log, interrupted, snapshot, markStarted };
}

function itemKeys(data: ThreadTopicData): string[] {
  return Object.keys(data).filter((key) => key.startsWith("item/"));
}

describe("TurnService", () => {
  test("start echoes the prompt, then re-keys the echo to the turn on commit before returning", async () => {
    const during: ThreadTopicData[] = [];
    const ctx = setup(async (_sessionId, prompt) => {
      during.push(ctx.snapshot());
      ctx.markStarted("turn-1", prompt);
      return "turn-1";
    });
    const started: Array<[string, boolean]> = [];
    ctx.turns.onTurnStarted((sessionId, auto) => started.push([sessionId, auto]));

    const turnId = await ctx.turns.start("s1", "hello", { auto: true });
    ctx.log.push("result");

    expect(turnId).toBe("turn-1");
    expect(during).toHaveLength(1);
    expect(during[0].turn).toMatchObject({ phase: "starting", turnId: null, auto: true });
    expect(itemKeys(during[0])).toEqual(["item/pending:1"]);
    const data = ctx.snapshot();
    expect(itemKeys(data)).toEqual(["item/turn-1-u"]);
    expect(data["item/turn-1-u"]).toMatchObject({ role: "user", text: "hello", turnId: "turn-1" });
    expect(data["item/turn-1-u"]?.pending).toBeUndefined();
    expect(data.turn).toMatchObject({ phase: "running", turnId: "turn-1", auto: true });
    expect(ctx.log.indexOf("patch:upsert:item/turn-1-u")).toBeGreaterThan(-1);
    expect(ctx.log.indexOf("patch:upsert:item/turn-1-u")).toBeLessThan(ctx.log.indexOf("result"));
    expect(started).toEqual([["s1", true]]);
  });

  test("a failed start removes the echo, restores the todos and rethrows", async () => {
    const ctx = setup(async () => {
      throw new Error("no worktree");
    });
    const todos = [{ content: "keep", status: "in_progress" as const }];
    ctx.threads.onDriverEvent("s1", { type: "todo.updated", turnId: "turn-0", todos });

    const [outcome] = await Promise.allSettled([ctx.turns.start("s1", "hello", {})]);

    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    const data = ctx.snapshot();
    expect(itemKeys(data)).toEqual([]);
    expect(data.todos).toEqual(todos);
    expect(data.turn).toBeNull();
    expect(ctx.threads.runtime("s1").busy).toBe(false);
  });

  test("a second start while one is pending is rejected as busy", async () => {
    let release: (turnId: string) => void = () => {};
    const ctx = setup(() => new Promise<string>((resolve) => (release = resolve)));
    const first = ctx.turns.start("s1", "one", {});
    const [second] = await Promise.allSettled([ctx.turns.start("s1", "two", {})]);
    expect(second.status).toBe("rejected");
    expect(((second as PromiseRejectedResult).reason as { code?: string }).code).toBe("session-busy");
    release("turn-1");
    await first;
    expect(itemKeys(ctx.snapshot())).toEqual(["item/turn-1-u"]);
  });

  test("stop while starting interrupts the turn once it starts", async () => {
    let release: () => void = () => {};
    const ctx = setup(
      (_sessionId, prompt) =>
        new Promise<string>((resolve) => {
          release = () => {
            ctx.markStarted("turn-1", prompt);
            resolve("turn-1");
          };
        })
    );
    const order: string[] = [];
    ctx.turns.onTurnStarted((sessionId, auto) => order.push(`started:${sessionId}:${auto}`));
    ctx.turns.onTurnStopped((sessionId) => order.push(`stopped:${sessionId}:${ctx.interrupted.join(",")}`));
    const start = ctx.turns.start("s1", "hello", {});

    ctx.turns.stop("s1");
    expect(ctx.interrupted).toEqual([]);
    expect(order).toEqual([]);

    release();
    await start;

    expect(ctx.interrupted).toEqual(["turn-1"]);
    expect(order).toEqual(["started:s1:false", "stopped:s1:turn-1"]);
    expect(ctx.snapshot().turn).toBeNull();
    expect(ctx.threads.runtime("s1").busy).toBe(false);
  });

  test("an unknown session is rejected before any echo is published", async () => {
    let calls = 0;
    const ctx = setup(async () => {
      calls += 1;
      return "turn-1";
    });
    const before = ctx.log.length;

    const [outcome] = await Promise.allSettled([ctx.turns.start("missing", "hello", {})]);

    expect(outcome.status).toBe("rejected");
    expect(((outcome as PromiseRejectedResult).reason as Error).message).toBe("unknown session missing");
    expect(calls).toBe(0);
    expect(ctx.log.length).toBe(before);
    expect(ctx.threads.runtime("missing").busy).toBe(false);
  });

  test("stop interrupts a running turn and does nothing when idle", async () => {
    const ctx = setup(async (_sessionId, prompt) => {
      ctx.markStarted("turn-1", prompt);
      return "turn-1";
    });
    const stopped: string[] = [];
    ctx.turns.onTurnStopped((sessionId) => stopped.push(sessionId));
    ctx.turns.stop("s1");
    expect(stopped).toEqual([]);
    await ctx.turns.start("s1", "hello", {});
    ctx.turns.stop("s1");
    expect(ctx.interrupted).toEqual(["turn-1"]);
    expect(stopped).toEqual(["s1"]);
    expect(ctx.snapshot().turn).toBeNull();
  });
});
