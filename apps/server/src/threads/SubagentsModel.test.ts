import { describe, expect, test } from "bun:test";
import type { SessionMeta, SessionStatus, ThreadTopicData, TopicPatch } from "@cw-code/contracts";
import { sessionTopic } from "@cw-code/shared/topics";
import { TopicHub } from "../topics/TopicHub.js";
import type { CallContext } from "../transport/Router.js";
import { SubagentsModel } from "./SubagentsModel.js";
import { ThreadService } from "./ThreadService.js";
import { createThreadTopicProvider } from "./threadTopic.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };

function meta(id: string, status: SessionStatus, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id, projectId: "p", driver: "claude", title: id, status, resumeCursor: "", createdAt: 0, updatedAt: 0, ...overrides };
}

function child(id: string, status: SessionStatus, createdAt: number, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return meta(id, status, { createdAt, subagent: { parentSessionId: "parent", isolation: "shared" }, ...overrides });
}

function setup(initial: SessionMeta[]) {
  const state = { sessions: initial, pending: new Map<string, number>() };
  const patches: TopicPatch[] = [];
  const hub = new TopicHub((_clientIds, frame) => patches.push(JSON.parse(frame) as TopicPatch));
  const threads = new ThreadService({ hub, history: async () => [], liveTasks: () => [], pendingRequests: () => [], loadHistoryOnSubscribe: false });
  hub.register(createThreadTopicProvider(threads));
  const model = new SubagentsModel({
    children: (parentId) =>
      state.sessions.filter((session) => session.subagent?.parentSessionId === parentId).sort((a, b) => a.createdAt - b.createdAt),
    parentOf: (sessionId) => state.sessions.find((session) => session.id === sessionId)?.subagent?.parentSessionId ?? null,
    pendingRequests: (sessionId) => state.pending.get(sessionId) ?? 0,
    refresh: (parentId) => threads.refreshExtras(parentId)
  });
  threads.registerExtras((sessionId) => model.extras(sessionId));
  const subscribe = () => hub.subscribe(ctx, [sessionTopic("parent")])[sessionTopic("parent")]?.data as ThreadTopicData;
  const subagentUpserts = () => patches.flatMap((patch) => patch.ops).filter((op) => op.op === "upsert" && op.key === "subagents");
  return { state, model, patches, subscribe, subagentUpserts };
}

describe("SubagentsModel", () => {
  test("summarizes the children in creation order, closed ones included, with their pending requests", () => {
    const { state, subscribe } = setup([
      meta("parent", "idle"),
      child("late", "working", 20),
      child("early", "archived", 10, { subagent: { parentSessionId: "parent", isolation: "worktree" } }),
      meta("unrelated", "idle")
    ]);
    state.pending.set("late", 2);
    const { subagents } = subscribe();
    expect(subagents.map((entry) => entry.id)).toEqual(["early", "late"]);
    expect(subagents[0]).toMatchObject({ status: "archived", isolation: "worktree", pendingRequests: 0 });
    expect(subagents[1]).toMatchObject({ status: "working", isolation: "shared", pendingRequests: 2 });
  });

  test("a session without children publishes an empty list", () => {
    const { subscribe } = setup([meta("parent", "idle")]);
    expect(subscribe().subagents).toEqual([]);
  });

  test("a change on a child republishes the parent's subagents", () => {
    const { state, model, subscribe, subagentUpserts } = setup([meta("parent", "idle"), child("kid", "working", 1)]);
    subscribe();
    expect(subagentUpserts()).toEqual([]);
    state.sessions = [meta("parent", "idle"), child("kid", "done", 1, { subagent: { parentSessionId: "parent", isolation: "shared", result: { turnId: "t1", outcome: "done", text: "ok", at: 5 } } })];
    model.changed("kid");
    const [upsert] = subagentUpserts();
    expect(upsert).toMatchObject({ value: [{ id: "kid", status: "done", result: { text: "ok" } }] });
  });

  test("a child's pending request count change republishes the parent's subagents", () => {
    const { state, model, subscribe, subagentUpserts } = setup([meta("parent", "idle"), child("kid", "working", 1)]);
    subscribe();
    state.pending.set("kid", 1);
    model.changed("kid");
    expect(subagentUpserts()).toMatchObject([{ value: [{ id: "kid", pendingRequests: 1 }] }]);
  });

  test("a change on a top-level session or an unchanged child publishes nothing", () => {
    const { model, subscribe, subagentUpserts } = setup([meta("parent", "idle"), child("kid", "working", 1)]);
    subscribe();
    model.changed("parent");
    model.changed("kid");
    model.changed("missing");
    expect(subagentUpserts()).toEqual([]);
  });
});
