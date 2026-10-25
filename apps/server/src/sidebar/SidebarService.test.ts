import { describe, expect, test } from "bun:test";
import type {
  ApprovalRequest,
  GitStatus,
  Project,
  PrSummary,
  PrWorkflow,
  SessionMeta,
  SessionPrLink,
  SessionRow,
  SessionStatus,
  SidebarLayout,
  SidebarOrderPrefs,
  TopicPatch
} from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { SIDEBAR_TOPIC } from "@cw-code/shared/topics";
import { TopicHub } from "../topics/TopicHub.js";
import type { CallContext } from "../transport/Router.js";
import { MAX_WATCHED_WORKING_SET, SidebarService } from "./SidebarService.js";

const ctx: CallContext = { clientId: "a", client: "web", auth: { kind: "owner" } };
const PROJECT: Project = { id: "p", rootPath: "/repo", name: "repo" };
const REF = { host: "github.com", owner: "o", repo: "r", number: 7 };
const HEAD = "sha-7";

function session(id: string, status: SessionStatus, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id, projectId: "p", driver: "claude", title: id, status, resumeCursor: "", createdAt: 0, updatedAt: 0, ...overrides };
}

function approval(): ApprovalRequest {
  return { requestId: "r1", kind: "command", title: "Run tests", decisions: ["accept", "decline"] };
}

function babysitWorkflow(): PrWorkflow {
  return {
    id: "babysit",
    label: "Babysit",
    description: "",
    icon: "eye",
    builtIn: true,
    enabled: true,
    target: "pr",
    suggestWhen: [],
    workspace: "linked",
    harness: { driver: null, model: "", effort: null, permissionMode: null },
    startPrompt: "start",
    updatePrompt: "update",
    autoFollowUp: true
  };
}

function babysatLink(): SessionPrLink {
  return { ref: REF, origin: "opened", workflowId: "babysit", lastSeenSha: HEAD, lastSeenAt: 10_000, finalReviewSha: HEAD };
}

function mergeReadySummary(): PrSummary {
  return {
    ref: REF,
    url: "https://github.com/o/r/pull/7",
    title: "PR 7",
    state: "OPEN",
    isDraft: false,
    author: { login: "me", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: "feature",
    headRefOid: HEAD,
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "none",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 500
  };
}

function gitStatus(branch: string): GitStatus {
  return { branch, pullRequest: null } as GitStatus;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

function setup(initial: SessionMeta[], options: { failFirstCompute?: boolean } = {}) {
  const state = {
    sessions: initial,
    approvals: new Map<string, ApprovalRequest[]>(),
    busy: new Set<string>(),
    git: new Map<string, GitStatus>(),
    lookup: new Map<string, PrSummary>(),
    workflows: [] as PrWorkflow[],
    order: null as SidebarOrderPrefs | null,
    attention: [] as number[],
    watched: [] as string[][],
    computes: 0
  };
  const patches: TopicPatch[] = [];
  const hub = new TopicHub((_clientIds, frame) => patches.push(JSON.parse(frame) as TopicPatch));
  const sidebar = new SidebarService(hub, {
    sessions: () => {
      state.computes += 1;
      if (options.failFirstCompute && state.computes === 1) throw new Error("boom");
      return state.sessions;
    },
    projects: () => [PROJECT],
    runtime: (id) => ({ busy: state.busy.has(id), approvals: state.approvals.get(id) ?? [], questions: [] }),
    gitStatus: (id) => state.git.get(id) ?? null,
    summaryLookup: () => state.lookup,
    detail: () => undefined,
    workflows: () => state.workflows,
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

const noAction = async (): Promise<void> => {
  throw new Error("no status action expected");
};

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
    state.sessions = [session("a", "idle", { prs: [babysatLink()] })];
    state.workflows = [babysitWorkflow()];
    state.lookup = new Map([[prKey(REF), mergeReadySummary()]]);
    sidebar.invalidate();
    await settle();
    expect(row("a").babysit?.phase.kind).toBe("done");
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

  test("a burst of invalidations from different sources recomputes once", async () => {
    const { state, sidebar } = setup([session("a", "idle")]);
    const triggers: Array<() => void> = [];
    sidebar.watch(
      (onChange) => {
        triggers.push(onChange);
        return () => {};
      },
      (onChange) => {
        triggers.push(onChange);
        return () => {};
      }
    );
    const before = state.computes;
    triggers[0]?.();
    sidebar.invalidate();
    queueMicrotask(() => triggers[1]?.());
    await Promise.resolve();
    queueMicrotask(() => sidebar.invalidate());
    await settle();
    expect(state.computes - before).toBe(1);
  });

  test("the working set is watched only while the sidebar topic has subscribers", async () => {
    const { state, hub, sidebar } = setup([session("a", "working"), session("b", "idle")]);
    expect(state.watched).toEqual([[]]);
    hub.subscribe(ctx, [SIDEBAR_TOPIC]);
    expect(state.watched).toEqual([[], ["a"]]);
    state.sessions = [session("a", "working"), session("b", "done")];
    sidebar.invalidate();
    await settle();
    hub.unsubscribe(ctx, [SIDEBAR_TOPIC]);
    expect(state.watched).toEqual([[], ["a"], ["a", "b"], []]);
  });

  test("the watched working set is capped to the most recently updated sessions", () => {
    const sessions = Array.from({ length: MAX_WATCHED_WORKING_SET + 5 }, (_, index) =>
      session(`s${String(index).padStart(2, "0")}`, "working", { updatedAt: index })
    );
    const { state, hub } = setup(sessions);
    hub.subscribe(ctx, [SIDEBAR_TOPIC]);
    const expected = sessions.slice(5).map((item) => item.id);
    expect(state.watched.at(-1)).toEqual(expected);
  });

  test("a failing initial compute starts with an empty layout and recovers on the next recompute", async () => {
    const { sidebar, data, layout } = setup([session("a", "idle")], { failFirstCompute: true });
    expect(data().layout).toEqual({ needsYou: [], workingSet: [], main: [], resolved: [], quickCounts: { pr: 0 } });
    expect(data().defaults).toEqual({ restoreSessionId: null, restoreProjectId: null, projectsByRecency: [] });
    sidebar.invalidate();
    await settle();
    expect(layout().main).toEqual(["a"]);
  });

  test("reorder resolves a session dropped into resolved, then persists the order", async () => {
    const { state, sidebar } = setup([session("a", "idle", { updatedAt: 2 }), session("b", "idle", { updatedAt: 1 })]);
    const actions: string[] = [];
    await sidebar.reorder({ sessionId: "a", from: "main", to: "resolved", targetId: null, before: false }, async (action) => {
      actions.push(action);
      expect(state.order).toBeNull();
    });
    expect(actions).toEqual(["resolve"]);
    expect(state.order).toEqual({ main: ["b"], resolved: ["a"], pinned: ["a"] });
  });

  test("reorder restores only a resolved session dropped into main", async () => {
    const { state, sidebar } = setup([session("a", "resolved", { updatedAt: 2 }), session("b", "idle", { updatedAt: 1 })]);
    const actions: string[] = [];
    await sidebar.reorder({ sessionId: "a", from: "resolved", to: "main", targetId: "b", before: true }, async (action) => {
      actions.push(action);
    });
    expect(actions).toEqual(["restore"]);
    expect(state.order).toEqual({ main: ["a", "b"], resolved: [], pinned: ["a"] });
    state.sessions = [session("a", "idle", { updatedAt: 2 }), session("b", "idle", { updatedAt: 1 })];
    state.order = { main: ["b"], resolved: ["a"], pinned: ["a"] };
    await sidebar.reorder({ sessionId: "a", from: "resolved", to: "main", targetId: null, before: false }, noAction);
    expect(state.order).toEqual({ main: ["b", "a"], resolved: [], pinned: ["a"] });
  });

  test("a failed status change rejects and keeps the stored order", async () => {
    const { state, sidebar } = setup([session("a", "idle")]);
    const [result] = await Promise.allSettled([
      sidebar.reorder({ sessionId: "a", from: "main", to: "resolved", targetId: null, before: false }, async () => {
        throw new Error("session busy (turn active)");
      })
    ]);
    expect(result?.status).toBe("rejected");
    expect(state.order).toBeNull();
  });

  test("a no-op reorder persists nothing", async () => {
    const { state, sidebar } = setup([session("a", "idle")]);
    await sidebar.reorder({ sessionId: "a", from: "main", to: "main", targetId: "a", before: true }, noAction);
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
