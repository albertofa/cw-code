import { describe, expect, test } from "bun:test";
import type {
  ApprovalRequest,
  BabysitState,
  GitStatus,
  Project,
  PrSummary,
  PrWorkflow,
  SessionMeta,
  SessionRow,
  SessionStatus,
  SidebarLayout,
  SidebarOrderPrefs,
  TopicPatch
} from "@cw-code/contracts";
import { SIDEBAR_TOPIC } from "@cw-code/shared/topics";
import { TopicHub } from "../topics/TopicHub.js";
import type { CallContext } from "../transport/Router.js";
import { SidebarService } from "./SidebarService.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };
const PROJECT: Project = { id: "p", rootPath: "/repo", name: "repo" };
const REF = { host: "github.com", owner: "o", repo: "r", number: 7 };

function session(id: string, status: SessionStatus, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id, projectId: "p", driver: "claude", title: id, status, resumeCursor: "", createdAt: 0, updatedAt: 0, ...overrides };
}

function approval(): ApprovalRequest {
  return { requestId: "r1", kind: "command", title: "Run tests", decisions: ["accept", "decline"] };
}

function babysitDone(): BabysitState {
  return {
    link: { ref: REF, origin: "opened", workflowId: "babysit", lastSeenSha: "", lastSeenAt: 0 },
    workflow: { id: "babysit", label: "Babysit" } as PrWorkflow,
    phase: { kind: "done", pr: { ref: REF } as PrSummary },
    autoTurns: 0
  };
}

function gitStatus(branch: string): GitStatus {
  return { branch, pullRequest: null } as GitStatus;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setup(initial: SessionMeta[]) {
  const state = {
    sessions: initial,
    approvals: new Map<string, ApprovalRequest[]>(),
    busy: new Set<string>(),
    git: new Map<string, GitStatus>(),
    babysit: new Map<string, BabysitState>(),
    order: null as SidebarOrderPrefs | null,
    attention: [] as number[],
    watched: [] as string[][]
  };
  const patches: TopicPatch[] = [];
  const hub = new TopicHub((_clientIds, frame) => patches.push(JSON.parse(frame) as TopicPatch));
  const sidebar = new SidebarService(hub, {
    sessions: () => state.sessions,
    projects: () => [PROJECT],
    runtime: (id) => ({ busy: state.busy.has(id), approvals: state.approvals.get(id) ?? [], questions: [] }),
    gitStatus: (id) => state.git.get(id) ?? null,
    summaryLookup: () => new Map(),
    detail: () => undefined,
    babysit: (id) => state.babysit.get(id) ?? null,
    sidebarOrder: () => state.order,
    setSidebarOrder: (order) => {
      state.order = order;
    },
    publishAttention: (count) => state.attention.push(count),
    watchWorkingSet: (ids) => state.watched.push(ids)
  });
  hub.register(sidebar);
  const data = () => hub.subscribe(ctx, [SIDEBAR_TOPIC])[SIDEBAR_TOPIC]?.data as Record<string, unknown>;
  const layout = () => data().layout as SidebarLayout;
  const row = (id: string) => data()[`row/${id}`] as SessionRow;
  return { state, hub, sidebar, patches, data, layout, row };
}

describe("SidebarService", () => {
  test("a session waiting on an approval is in needsYou, not in the working set", async () => {
    const { state, sidebar, layout, row } = setup([]);
    state.sessions = [session("a", "working"), session("b", "working")];
    state.approvals.set("a", [approval()]);
    sidebar.invalidate();
    await settle();
    expect(layout().needsYou).toEqual([
      { sessionId: "a", slot: "approval" },
      { sessionId: "b", slot: "running" }
    ]);
    expect(layout().workingSet).toEqual([]);
    expect(row("a").attention).toEqual({ kind: "approval", line: "Run tests" });
  });

  test("a babysat session that's done gets slot done", async () => {
    const { state, sidebar, layout, row } = setup([]);
    state.sessions = [session("a", "idle", { prs: [babysitDone().link] })];
    state.babysit.set("a", babysitDone());
    sidebar.invalidate();
    await settle();
    expect(layout().needsYou).toEqual([{ sessionId: "a", slot: "done" }]);
    expect(layout().main).toEqual([]);
    expect(row("a").prMuted).toBe(true);
  });

  test("the attention count excludes running sessions", async () => {
    const { state, sidebar } = setup([session("a", "working")]);
    expect(sidebar.attentionCount()).toBe(0);
    state.sessions = [session("a", "working"), session("b", "done"), session("c", "input-required")];
    sidebar.invalidate();
    await settle();
    expect(sidebar.attentionCount()).toBe(2);
    expect(state.attention).toEqual([0, 2]);
  });

  test("the working set is watched and only republished when it changes", async () => {
    const { state, sidebar } = setup([session("a", "working"), session("b", "idle")]);
    sidebar.invalidate();
    await settle();
    state.sessions = [session("a", "working"), session("b", "done")];
    sidebar.invalidate();
    await settle();
    expect(state.watched).toEqual([["a"], ["a", "b"]]);
  });

  test("reorder persists the order and asks to resolve a session dropped into resolved", () => {
    const { state, sidebar } = setup([session("a", "idle", { updatedAt: 2 }), session("b", "idle", { updatedAt: 1 })]);
    expect(sidebar.reorder({ sessionId: "a", from: "main", to: "resolved", targetId: null, before: false })).toBe("resolve");
    expect(state.order).toEqual({ main: ["b"], resolved: ["a"], pinned: ["a"] });
  });

  test("reorder restores only a resolved session dropped into main", () => {
    const { state, sidebar } = setup([session("a", "resolved", { updatedAt: 2 }), session("b", "idle", { updatedAt: 1 })]);
    expect(sidebar.reorder({ sessionId: "a", from: "resolved", to: "main", targetId: "b", before: true })).toBe("restore");
    expect(state.order).toEqual({ main: ["a", "b"], resolved: [], pinned: ["a"] });
    state.sessions = [session("a", "idle", { updatedAt: 2 }), session("b", "idle", { updatedAt: 1 })];
    state.order = { main: ["b"], resolved: ["a"], pinned: ["a"] };
    expect(sidebar.reorder({ sessionId: "a", from: "resolved", to: "main", targetId: null, before: false })).toBeNull();
    expect(state.order).toEqual({ main: ["b", "a"], resolved: [], pinned: ["a"] });
  });

  test("a no-op reorder persists nothing", () => {
    const { state, sidebar } = setup([session("a", "idle")]);
    expect(sidebar.reorder({ sessionId: "a", from: "main", to: "main", targetId: "a", before: true })).toBeNull();
    expect(state.order).toBeNull();
  });

  test("a git publish triggers a row recompute", async () => {
    const { state, sidebar, row, patches } = setup([session("a", "idle", { branch: "stored" })]);
    let publish: () => void = () => {};
    sidebar.watch((onChange) => {
      publish = onChange;
      return () => {};
    });
    expect(row("a").branch).toBe("stored");
    state.git.set("a", gitStatus("live"));
    publish();
    await settle();
    expect(row("a").branch).toBe("live");
    expect(patches.at(-1)?.ops).toEqual([{ op: "upsert", key: "row/a", value: { ...row("a"), branch: "live" } }]);
  });

  test("unchanged rows produce no patch and keep their identity", async () => {
    const { state, hub, sidebar, patches } = setup([session("a", "idle"), session("b", "idle")]);
    const before = hub.subscribe(ctx, [SIDEBAR_TOPIC])[SIDEBAR_TOPIC]?.data as Record<string, unknown>;
    sidebar.invalidate();
    await settle();
    expect(patches).toEqual([]);
    state.busy.add("b");
    sidebar.invalidate();
    await settle();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.ops.map((op) => ("key" in op ? op.key : op.op))).toEqual(["row/b"]);
    const after = hub.subscribe(ctx, [SIDEBAR_TOPIC])[SIDEBAR_TOPIC]?.data as Record<string, unknown>;
    expect(after["row/a"]).toBe(before["row/a"]);
    expect(after["row/b"]).not.toBe(before["row/b"]);
  });

  test("rows snapshot sessions so in-place mutations still publish", async () => {
    const live = session("a", "idle", { title: "old" });
    const { sidebar, row } = setup([live]);
    live.title = "new";
    sidebar.invalidate();
    await settle();
    expect(row("a").session.title).toBe("new");
  });

  test("archived sessions have no row and defaults pick the newest session not auto-resolved", () => {
    const { data } = setup([
      session("a", "archived", { updatedAt: 9 }),
      session("b", "resolved", { updatedAt: 8, autoResolved: true }),
      session("c", "idle", { updatedAt: 1 })
    ]);
    const snapshot = data();
    expect(Object.keys(snapshot).filter((key) => key.startsWith("row/")).sort()).toEqual(["row/b", "row/c"]);
    expect(snapshot.defaults).toEqual({ restoreSessionId: "c", restoreProjectId: "p", projectsByRecency: ["p"] });
    expect(snapshot["project/p"]).toEqual(PROJECT);
    expect(snapshot["worktrees/p"]).toEqual([]);
  });

  test("the store survives release and keeps its revision", async () => {
    const { state, hub, sidebar } = setup([session("a", "idle")]);
    const first = hub.subscribe(ctx, [SIDEBAR_TOPIC])[SIDEBAR_TOPIC];
    hub.unsubscribe(ctx, [SIDEBAR_TOPIC]);
    state.sessions = [session("a", "done")];
    sidebar.invalidate();
    await settle();
    const second = hub.subscribe(ctx, [SIDEBAR_TOPIC])[SIDEBAR_TOPIC];
    expect(second?.rev).toBe((first?.rev ?? 0) + 1);
    expect((second?.data.layout as SidebarLayout).needsYou).toEqual([{ sessionId: "a", slot: "done" }]);
  });
});
