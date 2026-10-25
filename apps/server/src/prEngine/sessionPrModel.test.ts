import { describe, expect, it } from "bun:test";
import type {
  BabysitPhase,
  BabysitState,
  GitPullRequest,
  GitStatus,
  PrDetail,
  PrRef,
  PrSummary,
  PrWorkflow,
  SessionMeta,
  SessionPrLink
} from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { activeBranchMismatch } from "../sourceControl/branchMismatch.js";
import { SessionPrModel, sessionDockItems, sessionPrItemsFor, updatesToSend, type SessionPrModelDeps } from "./sessionPrModel.js";

function ref(number: number): PrRef {
  return { host: "github.com", owner: "acme", repo: "widgets", number };
}

function workflow(id: string, overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id,
    label: id === "babysit" ? "Babysit" : "Review",
    description: "",
    icon: "eye",
    builtIn: true,
    enabled: true,
    target: "pr",
    suggestWhen: [],
    workspace: "linked",
    harness: { driver: null, model: "", effort: null, permissionMode: null },
    startPrompt: "start",
    updatePrompt: "update {{pr.number}}",
    ...overrides
  };
}

function detail(number: number, overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    ref: ref(number),
    url: `https://github.com/acme/widgets/pull/${number}`,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "mbarros", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: `feature/${number}`,
    headRefOid: `new-${number}`,
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "failing",
    checks: { total: 1, passed: 0, failed: 1, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 2_000,
    body: "",
    createdAt: 0,
    timeline: [],
    threads: [],
    checkRuns: [{ name: "test", workflow: "ci", status: "failure", url: null, runId: 7, completedAt: 1_500 }],
    commits: [],
    viewerLogin: "",
    ...overrides
  };
}

function link(number: number, overrides: Partial<SessionPrLink> = {}): SessionPrLink {
  return { ref: ref(number), origin: "workflow", workflowId: "babysit", lastSeenSha: `new-${number}`, lastSeenAt: 1_000, ...overrides };
}

function session(prs: SessionPrLink[], overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    projectId: "p1",
    driver: "claude",
    title: "Session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    prs,
    ...overrides
  };
}

function gitPr(number: number): GitPullRequest {
  return {
    number,
    title: `Branch PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: null,
    headRefName: "feature",
    baseRefName: "main",
    headRefOid: "branch-sha",
    updatedAt: 0,
    checks: { total: 1, passed: 1, failed: 0, pending: 0 }
  };
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    available: true,
    branch: "feature",
    dirtyCount: 0,
    addedLines: 0,
    deletedLines: 0,
    stagedCount: 0,
    ahead: 0,
    behind: 0,
    baseRef: "main",
    baseAhead: 0,
    baseBehind: 0,
    isWorktree: false,
    worktreeName: "",
    worktreePath: "C:/repo",
    repositoryRoot: "C:/repo",
    prNumber: 9,
    pullRequest: gitPr(9),
    githubError: null,
    githubHost: "github.com",
    githubAccount: "octocat",
    githubAccountSource: "active",
    clean: true,
    ...overrides
  };
}

interface HarnessOptions {
  sessions?: SessionMeta[];
  details?: PrDetail[];
  workflows?: PrWorkflow[];
  babysit?: BabysitState | null;
  errors?: Record<string, string>;
  open?: string[];
}

function harness(options: HarnessOptions = {}) {
  const sessions = options.sessions ?? [session([link(42)])];
  const details = new Map((options.details ?? [detail(42)]).map((item) => [prKey(item.ref), item]));
  const summaries = new Map<string, PrSummary>(details);
  const events: string[] = [];
  const refreshed: string[] = [];
  const seen: Array<{ key: string; headSha: string | null; seenAt: number | null }> = [];
  let resolveTurn: (turnId: string) => void = () => {};
  let rejectTurn: (error: Error) => void = () => {};
  const started: Array<{ prompt: string; prRefs: PrRef[] }> = [];
  const deps: SessionPrModelDeps = {
    sessions: () => sessions,
    isOpen: (id) => (options.open ?? ["s1"]).includes(id),
    refresh: (id) => refreshed.push(id),
    settings: () => ({ ...DEFAULT_SETTINGS, prWorkflows: options.workflows ?? [workflow("babysit"), workflow("review")] }),
    gitStatus: () => null,
    branchMismatch: () => null,
    summaryLookup: () => summaries,
    detail: (key) => details.get(key),
    detailError: (key) => options.errors?.[key] ?? null,
    babysit: () => options.babysit ?? null,
    startTurn: (_id, prompt, input) => {
      events.push("start");
      started.push({ prompt, prRefs: input.prRefs });
      return new Promise<string>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
    },
    markPrSeen: (_id, prRef, headSha, seenAt) => {
      events.push(`seen ${prRef.number}`);
      seen.push({ key: prKey(prRef), headSha, seenAt });
    }
  };
  return {
    deps,
    model: new SessionPrModel(deps),
    events,
    refreshed,
    seen,
    started,
    resolveTurn: (turnId: string) => resolveTurn(turnId),
    rejectTurn: (error: Error) => rejectTurn(error)
  };
}

function babysitState(phase: BabysitPhase, autoWorkflow: PrWorkflow): BabysitState {
  return { link: link(42), workflow: autoWorkflow, phase, autoTurns: 0 };
}

describe("session PR dock", () => {
  it("builds one entry per linked PR with the follow-up prompt for changed PRs", () => {
    const { deps } = harness({ sessions: [session([link(42), link(43, { lastSeenAt: 5_000, lastSeenSha: "new-43" })])], details: [detail(42), detail(43)] });
    const [changed, quiet] = sessionDockItems(deps.sessions()[0], deps);
    expect(changed.entry).toMatchObject({ key: prKey(ref(42)), workflowId: "babysit", workflowLabel: "Babysit", prompt: "update 42", logsNeeded: false, isReview: false });
    expect(changed.entry.updates.map((update) => update.kind)).toEqual(["checks_failed"]);
    expect(changed.seenHead).toBe("new-42");
    expect(changed.seenAt).toBe(2_000);
    expect(quiet.entry.updates).toEqual([]);
    expect(quiet.entry.prompt).toBeNull();
  });

  it("combines the prompts of several changed PRs under one heading each", () => {
    const { deps } = harness({ sessions: [session([link(42), link(43)])], details: [detail(42), detail(43)] });
    const send = updatesToSend(sessionDockItems(deps.sessions()[0], deps), [prKey(ref(42)), prKey(ref(43))]);
    expect(send?.prompt).toBe("## acme/widgets#42\n\nupdate 42\n\n## acme/widgets#43\n\nupdate 43");
    expect(send?.covered.map((item) => item.entry.key)).toEqual([prKey(ref(42)), prKey(ref(43))]);
  });

  it("sends a single changed PR's prompt without a heading", () => {
    const { deps } = harness();
    expect(updatesToSend(sessionDockItems(deps.sessions()[0], deps), [prKey(ref(42))])?.prompt).toBe("update 42");
  });

  it("omits entries that need failed CI logs from the combined prompt", () => {
    const logs = workflow("logs", { label: "Fix CI", updatePrompt: "fix {{checks.failedLogs}}" });
    const { deps } = harness({
      sessions: [session([link(42, { workflowId: "logs" }), link(43)])],
      details: [detail(42), detail(43)],
      workflows: [workflow("babysit"), logs]
    });
    const items = sessionDockItems(deps.sessions()[0], deps);
    expect(items[0].entry).toMatchObject({ logsNeeded: true, prompt: null, workflowLabel: "Fix CI" });
    const send = updatesToSend(items, [prKey(ref(42)), prKey(ref(43))]);
    expect(send?.prompt).toBe("## acme/widgets#43\n\nupdate 43");
    expect(send?.covered.map((item) => item.entry.key)).toEqual([prKey(ref(43))]);
  });

  it("refuses to send a single changed PR whose prompt needs failed CI logs", () => {
    const logs = workflow("logs", { updatePrompt: "fix {{checks.failedLogs}}" });
    const { deps } = harness({ sessions: [session([link(42, { workflowId: "logs" })])], workflows: [logs] });
    expect(updatesToSend(sessionDockItems(deps.sessions()[0], deps), [prKey(ref(42))])).toBeNull();
  });

  it("reports the detail error and unseen state for a PR whose details failed to load", () => {
    const key = prKey(ref(42));
    const { deps } = harness({ details: [], errors: { [key]: "rate limited" } });
    const [item] = sessionDockItems(deps.sessions()[0], deps);
    expect(item.entry).toMatchObject({ updates: [], prompt: null, error: "rate limited", unseen: false });
  });

  describe("autoHint", () => {
    const auto = workflow("babysit", { autoFollowUp: true });

    function hintFor(phase: BabysitPhase | null, pr: PrDetail = detail(42)) {
      const { deps } = harness({ details: [pr], workflows: [auto], babysit: phase ? babysitState(phase, auto) : null });
      return sessionDockItems(deps.sessions()[0], deps)[0].entry.autoHint;
    }

    it("is null when the session is not babysat", () => {
      expect(hintFor(null)).toBeNull();
    });

    it("waits for the user while paused", () => {
      expect(hintFor({ kind: "paused", reason: "user" })).toBe("paused");
    });

    it("sends after the current turn while working", () => {
      expect(hintFor({ kind: "working" })).toBe("after-turn");
    });

    it("is sending while watching an actionable update", () => {
      expect(hintFor({ kind: "watching" })).toBe("sending");
    });

    it("explains that the workflow ignores updates that are not actionable", () => {
      const quiet = detail(42, {
        ci: "passing",
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        checkRuns: [{ name: "test", workflow: "ci", status: "success", url: null, runId: 7, completedAt: 1_500 }]
      });
      expect(hintFor({ kind: "watching" }, quiet)).toBe("not-actionable");
    });
  });
});

describe("session PR items", () => {
  const branchKey = prKey(ref(9));

  it("adds the branch PR when the folder is on the session's branch", () => {
    const owner = session([link(42)], { branch: "feature" });
    const current = status();
    const items = sessionPrItemsFor(owner, current, activeBranchMismatch(owner, current, undefined), new Map(), () => undefined);
    expect(items.map((item) => [item.key, item.source, item.canLink])).toContainEqual([branchKey, "branch", true]);
  });

  it("skips the branch PR when the folder is on another branch", () => {
    const owner = session([link(42)], { branch: "feature" });
    const other = status({ branch: "other" });
    const items = sessionPrItemsFor(owner, other, activeBranchMismatch(owner, other, undefined), new Map(), () => undefined);
    expect(items.map((item) => item.key)).toEqual([prKey(ref(42))]);
  });

  it("keeps the branch PR while the user kept the other folder head", () => {
    const owner = session([link(42)], { branch: "feature" });
    const other = status({ branch: "other" });
    const items = sessionPrItemsFor(owner, other, activeBranchMismatch(owner, other, "other"), new Map(), () => undefined);
    expect(items.map((item) => item.key)).toContain(branchKey);
  });
});

describe("SessionPrModel", () => {
  it("marks the sent PRs seen only after the turn starts", async () => {
    const { model, events, seen, started, resolveTurn } = harness();
    const sending = model.sendUpdates("s1", [prKey(ref(42))]);
    await Promise.resolve();
    expect(events).toEqual(["start"]);
    expect(started).toEqual([{ prompt: "update 42", prRefs: [ref(42)] }]);
    resolveTurn("turn-1");
    expect(await sending).toBe("turn-1");
    expect(events).toEqual(["start", "seen 42"]);
    expect(seen).toEqual([{ key: prKey(ref(42)), headSha: "new-42", seenAt: 2_000 }]);
  });

  it("leaves the PRs unseen when the turn fails to start", async () => {
    const { model, events, rejectTurn } = harness();
    const sending = model.sendUpdates("s1", [prKey(ref(42))]);
    rejectTurn(new Error("session busy"));
    const [result] = await Promise.allSettled([sending]);
    expect(result.status).toBe("rejected");
    expect(events).toEqual(["start"]);
  });

  it("rejects a send with nothing to send", async () => {
    const { model, events } = harness({ sessions: [session([link(42, { lastSeenAt: 5_000 })])] });
    const [result] = await Promise.allSettled([model.sendUpdates("s1", [prKey(ref(42))])]);
    expect(result.status).toBe("rejected");
    expect(events).toEqual([]);
  });

  it("dismisses only the requested PRs", () => {
    const { model, seen } = harness({ sessions: [session([link(42), link(43)])], details: [detail(42), detail(43)] });
    model.dismissUpdates("s1", [prKey(ref(43))]);
    expect(seen).toEqual([{ key: prKey(ref(43)), headSha: "new-43", seenAt: 2_000 }]);
  });

  it("coalesces invalidations and refreshes only open sessions", async () => {
    const { model, refreshed } = harness({ sessions: [session([]), session([], { id: "s2" })], open: ["s2"] });
    model.invalidate();
    model.invalidate();
    await Promise.resolve();
    expect(refreshed).toEqual(["s2"]);
  });

  it("publishes empty extras for an unknown session", () => {
    const { model } = harness();
    expect(model.extras("missing")).toEqual({ prItems: [], prDock: [] });
  });
});
