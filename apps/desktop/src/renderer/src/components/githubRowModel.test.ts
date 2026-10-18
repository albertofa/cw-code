import { describe, expect, it } from "vitest";
import type { IssueSummary, PrSummary, PrWorkflow, SessionMeta, WorkflowRunSummary } from "@cw-code/contracts";
import {
  babysitterFor,
  diffBlocks,
  formatDuration,
  issueBucket,
  issueVerdict,
  peopleStack,
  prGates,
  prVerdict,
  continueSessionFor,
  rowAction,
  rowDelta,
  unseenSessionIds,
  runBucket,
  runVerdict,
  sessionsForIssue,
  sessionsForRun,
  suggestedWorkflowFor,
  type LinkedSession
} from "./githubRowModel.js";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add feature",
    state: "OPEN",
    isDraft: false,
    author: { login: "author", isBot: false },
    viewerIsAuthor: false,
    reviewRequestedFromViewer: false,
    headRefName: "feature",
    headRefOid: "abc123",
    baseRefName: "main",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "passing",
    checks: { total: 4, passed: 4, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 1000,
    ...overrides
  };
}

function issue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 },
    url: "https://github.com/acme/widgets/issues/7",
    title: "Broken",
    state: "OPEN",
    stateReason: null,
    author: { login: "reporter", isBot: false },
    assignees: [],
    labels: [],
    milestone: null,
    commentsCount: 0,
    linkedPrs: [],
    createdAt: 100,
    updatedAt: 1000,
    ...overrides
  };
}

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 900 },
    url: "https://github.com/acme/widgets/actions/runs/900",
    workflowName: "CI",
    runNumber: 12,
    event: "push",
    branch: "main",
    headSha: "abc123",
    title: "chore: bump",
    actor: "dev",
    status: "completed",
    conclusion: "success",
    prNumber: null,
    onDefaultBranch: false,
    createdAt: 1000,
    updatedAt: 61_000,
    jobs: [],
    ...overrides
  };
}

function sessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    projectId: "project",
    driver: "claude",
    title: "Session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 5,
    ...overrides
  };
}

function workflow(overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id: "wf",
    label: "Workflow",
    description: "",
    icon: "eye",
    builtIn: false,
    enabled: true,
    target: "pr",
    suggestWhen: [],
    workspace: "checkout",
    harness: { driver: null, model: "", effort: null, permissionMode: null },
    startPrompt: "",
    updatePrompt: "",
    ...overrides
  };
}

describe("prVerdict priority", () => {
  const base = pr({
    state: "MERGED",
    isDraft: true,
    mergeable: "CONFLICTING",
    ci: "failing",
    checks: { total: 4, passed: 2, failed: 2, pending: 0 },
    review: "changes_requested"
  });

  it("walks down the priority list one condition at a time", () => {
    expect(prVerdict(base, null).text).toBe("Merged");
    expect(prVerdict({ ...base, state: "CLOSED" }, null).text).toBe("Closed");
    expect(prVerdict({ ...base, state: "OPEN" }, null).text).toBe("Draft");
    expect(prVerdict({ ...base, state: "OPEN", isDraft: false }, null).text).toBe("Conflicts");
    const failing = { ...base, state: "OPEN" as const, isDraft: false, mergeable: "MERGEABLE" as const };
    expect(prVerdict(failing, null)).toMatchObject({ tone: "bad", text: "CI failing · 2" });
    const changes = { ...failing, ci: "pending" as const };
    expect(prVerdict(changes, null).text).toBe("Changes requested");
    const pending = { ...changes, review: "review_required" as const };
    expect(prVerdict(pending, null)).toMatchObject({ tone: "warn", text: "Checks running", spin: true });
    const yours = { ...pending, ci: "passing" as const, reviewRequestedFromViewer: true };
    expect(prVerdict(yours, null).text).toBe("Your review");
    expect(prVerdict({ ...yours, reviewRequestedFromViewer: false }, null).text).toBe("Awaiting review");
    expect(prVerdict({ ...yours, review: "approved" }, null)).toMatchObject({ tone: "ok", text: "Ready to merge" });
    expect(prVerdict({ ...yours, review: "none" }, null).text).toBe("No reviewers");
  });

  it("treats a pending review from the viewer as your review", () => {
    const item = pr({ review: "review_required", reviewers: [{ login: "Me", state: "PENDING" }] });
    expect(prVerdict(item, "me").text).toBe("Your review");
    expect(prVerdict(item, "someone").text).toBe("Awaiting review");
  });
});

describe("prGates", () => {
  it("describes checks, review and merge independently", () => {
    const item = pr({
      ci: "failing",
      checks: { total: 14, passed: 12, failed: 2, pending: 0 },
      review: "approved",
      baseRefName: "develop"
    });
    const gates = prGates(item, null);
    expect(gates.checks).toMatchObject({ tone: "bad", text: "12/14 passed · 2 failing" });
    expect(gates.review).toMatchObject({ tone: "ok", text: "Approved" });
    expect(gates.merge).toMatchObject({ tone: "neutral", text: "Blocked by required checks or review" });
    expect(prGates({ ...item, ci: "passing" }, null).merge).toMatchObject({ tone: "ok", text: "Can merge into develop" });
    expect(prGates({ ...item, mergeable: "CONFLICTING" }, null).merge.text).toBe("Conflicts with develop");
  });
});

describe("issueVerdict", () => {
  it("covers open, linked, closed and not planned", () => {
    expect(issueVerdict(issue())).toMatchObject({ tone: "neutral", text: "No linked PR" });
    const linked = issue({ linkedPrs: [{ number: 9, url: "u", state: "OPEN", isDraft: true }] });
    expect(issueVerdict(linked)).toMatchObject({ icon: "git-pull-request-draft", text: "#9 · Draft" });
    const closed = issue({ state: "CLOSED", stateReason: "COMPLETED", linkedPrs: [{ number: 9, url: "u", state: "MERGED", isDraft: false }] });
    expect(issueVerdict(closed)).toMatchObject({ tone: "merged", text: "Closed by #9" });
    expect(issueVerdict(issue({ state: "CLOSED", stateReason: "COMPLETED" })).text).toBe("Completed");
    expect(issueVerdict(issue({ state: "CLOSED", stateReason: "NOT_PLANNED" }))).toMatchObject({ icon: "circle-slash", text: "Not planned" });
  });
});

describe("runVerdict and runBucket", () => {
  const job = (name: string, status: "queued" | "in_progress" | "completed", conclusion: WorkflowRunSummary["conclusion"]) => ({
    name,
    status,
    conclusion,
    startedAt: null,
    completedAt: null,
    url: null
  });

  it("reports failed jobs for a failed run", () => {
    const failed = run({ conclusion: "failure", jobs: [job("a", "completed", "success"), job("b", "completed", "failure")] });
    expect(runVerdict(failed)).toMatchObject({ tone: "bad", text: "Failed · 1 of 2 jobs" });
    expect(runBucket(failed)).toBe("failing");
  });

  it("reports progress for an in-progress run", () => {
    const running = run({ status: "in_progress", conclusion: null, jobs: [job("a", "completed", "success"), job("b", "in_progress", null)] });
    expect(runVerdict(running)).toMatchObject({ tone: "warn", text: "Running · 1/2 jobs", spin: true });
    expect(runBucket(running)).toBe("running");
    expect(runBucket(run({ status: "queued", conclusion: null }))).toBe("running");
  });

  it("maps the remaining conclusions", () => {
    expect(runVerdict(run({ status: "queued", conclusion: null })).text).toBe("Queued");
    expect(runVerdict(run()).text).toBe("Succeeded");
    expect(runVerdict(run({ conclusion: "cancelled" })).text).toBe("Cancelled");
    expect(runVerdict(run({ conclusion: "timed_out" })).text).toBe("Timed out");
    expect(runBucket(run())).toBe("recent");
    expect(runBucket(run({ conclusion: "cancelled" }))).toBe("recent");
  });
});

describe("issueBucket", () => {
  it("prefers assigned, then created, then mentions mode", () => {
    expect(issueBucket(issue({ state: "CLOSED", assignees: ["me"] }), "me")).toBe("closed");
    expect(issueBucket(issue({ assignees: ["Me"] }), "me")).toBe("assigned");
    expect(issueBucket(issue({ author: { login: "me", isBot: false } }), "me")).toBe("created");
    expect(issueBucket(issue(), "me")).toBe("other");
    expect(issueBucket(issue(), "me", true)).toBe("mentioned");
  });
});

describe("diffBlocks", () => {
  it("caps small diffs at one block per side", () => {
    expect(diffBlocks(3, 2)).toEqual({ add: 1, del: 1, neutral: 3 });
    expect(diffBlocks(1, 0)).toEqual({ add: 1, del: 0, neutral: 4 });
    expect(diffBlocks(0, 0)).toEqual({ add: 0, del: 0, neutral: 5 });
  });

  it("splits large diffs proportionally across five blocks", () => {
    expect(diffBlocks(612, 148)).toEqual({ add: 4, del: 1, neutral: 0 });
    expect(diffBlocks(0, 2140)).toEqual({ add: 0, del: 5, neutral: 0 });
  });
});

describe("peopleStack", () => {
  it("shows reviewers with state badges first", () => {
    const item = pr({
      author: { login: "author", isBot: false },
      reviewers: [
        { login: "a", state: "APPROVED" },
        { login: "b", state: "CHANGES_REQUESTED" },
        { login: "c", state: "COMMENTED" },
        { login: "d", state: "PENDING" }
      ]
    });
    const stack = peopleStack(item, null);
    expect(stack.author).toBe("author");
    expect(stack.others.map((o) => o.badge)).toEqual(["ok", "bad", "neutral"]);
    expect(stack.overflow).toBe(1);
  });

  it("dedupes assignees against the author and reviewers and flags the viewer", () => {
    const item = pr({
      author: { login: "author", isBot: false },
      reviewers: [{ login: "Me", state: "PENDING" }],
      assignees: ["AUTHOR", "me", "other"]
    });
    const stack = peopleStack(item, "me");
    expect(stack.others).toEqual([
      { login: "Me", badge: "warn", assignee: false, viewer: true },
      { login: "other", badge: null, assignee: true, viewer: false }
    ]);
    expect(stack.overflow).toBe(0);
  });

  it("works for issues, which have assignees only", () => {
    const stack = peopleStack(issue({ assignees: ["a", "b", "c", "d", "e"] }), "b");
    expect(stack.others.map((o) => o.login)).toEqual(["a", "b", "c"]);
    expect(stack.others[1]).toMatchObject({ assignee: true, viewer: true });
    expect(stack.overflow).toBe(2);
  });
});

describe("suggestedWorkflowFor", () => {
  const workflows = [
    workflow({ id: "pr-ci", target: "pr", suggestWhen: ["checks-failing"] }),
    workflow({ id: "implement", target: "issue", suggestWhen: ["issue-assigned"] }),
    workflow({ id: "investigate", target: "issue", suggestWhen: ["issue-bug"] }),
    workflow({ id: "run-ci", target: "run", suggestWhen: ["run-failed"] }),
    workflow({ id: "disabled-run", target: "run", enabled: false, suggestWhen: ["run-failed"] })
  ];

  it("matches PR workflows only against the PR target", () => {
    const failing = pr({ ci: "failing" });
    expect(suggestedWorkflowFor({ kind: "pr", pr: failing }, workflows)?.id).toBe("pr-ci");
    expect(suggestedWorkflowFor({ kind: "pr", pr: pr() }, workflows)).toBeNull();
  });

  it("matches issue workflows by assignment and bug label", () => {
    const assigned = issue({ assignees: ["me"] });
    expect(suggestedWorkflowFor({ kind: "issue", issue: assigned, viewer: "me" }, workflows)?.id).toBe("implement");
    const bug = issue({ labels: ["Bug"] });
    expect(suggestedWorkflowFor({ kind: "issue", issue: bug, viewer: "me" }, workflows)?.id).toBe("investigate");
    expect(suggestedWorkflowFor({ kind: "issue", issue: issue(), viewer: "me" }, workflows)).toBeNull();
    expect(suggestedWorkflowFor({ kind: "issue", issue: { ...assigned, state: "CLOSED" }, viewer: "me" }, workflows)).toBeNull();
  });

  it("matches run workflows only for failed runs", () => {
    expect(suggestedWorkflowFor({ kind: "run", run: run({ conclusion: "failure" }) }, workflows)?.id).toBe("run-ci");
    expect(suggestedWorkflowFor({ kind: "run", run: run() }, workflows)).toBeNull();
  });
});

describe("session lookup", () => {
  const sessions: LinkedSession[] = [
    { id: "pr-session", updatedAt: 1, prs: [{ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 }, origin: "opened", lastSeenAt: 0, lastSeenSha: "" }] },
    {
      id: "run-session",
      updatedAt: 2,
      runs: [{ ref: { host: "GitHub.com", owner: "ACME", repo: "Widgets", runId: 900 }, origin: "workflow", lastSeenAt: 0 }]
    },
    { id: "issue-session", updatedAt: 3, issues: [{ ref: { host: "github.com", owner: "Acme", repo: "widgets", number: 7 }, origin: "linked", lastSeenAt: 0 }] },
    { id: "other", updatedAt: 4 }
  ];

  it("finds run sessions through the run link case-insensitively and through the run's PR", () => {
    expect(sessionsForRun(run(), sessions).map((s) => s.id)).toEqual(["run-session"]);
    expect(sessionsForRun(run({ prNumber: 42 }), sessions).map((s) => s.id)).toEqual(["pr-session", "run-session"]);
  });

  it("finds issue sessions by issue link", () => {
    expect(sessionsForIssue(issue(), sessions).map((s) => s.id)).toEqual(["issue-session"]);
    expect(sessionsForIssue(issue({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 8 } }), sessions)).toEqual([]);
  });
});

type ActInput = Parameters<typeof rowAction>[0];

function act(input: Omit<ActInput, "unseen"> & { unseen?: ReadonlySet<string> }) {
  return rowAction({ unseen: new Set<string>(), ...input });
}

describe("rowAction", () => {
  const prWorkflows = [
    workflow({ id: "review", label: "Review", suggestWhen: ["review-requested"] }),
    workflow({ id: "fix-ci", label: "Fix CI", suggestWhen: ["checks-failing"] }),
    workflow({ id: "implement", label: "Implement", target: "issue", suggestWhen: ["issue-assigned"] })
  ];
  const session = (overrides: Partial<SessionMeta> = {}) =>
    sessionMeta({
      prs: [{ ref: pr().ref, origin: "workflow", workflowId: "review", lastSeenAt: 5000, lastSeenSha: "abc123" }],
      ...overrides
    });

  it("opens the linked session for a PR", () => {
    const action = act({ subject: { kind: "pr", pr: pr() }, viewer: "me", sessions: [session()], workflows: prWorkflows });
    expect(action).toMatchObject({ kind: "session", mode: "open", label: "Review", meta: "idle", count: 1 });
  });

  it("continues a review session when the head moved", () => {
    const action = act({ subject: { kind: "pr", pr: pr({ headRefOid: "def456" }) }, viewer: "me", sessions: [session()], workflows: prWorkflows });
    expect(action).toMatchObject({ kind: "session", mode: "continue", label: "Re-review", meta: "new", workflowId: "review" });
  });

  it("only opens the babysitting session for a PR or its run", () => {
    const withBabysit = [...prWorkflows, workflow({ id: "babysit", label: "Babysit", autoFollowUp: true })];
    const reviewer = session({ id: "reviewer", updatedAt: 9 });
    const babysat = session({
      id: "babysat",
      prs: [{ ref: pr().ref, origin: "opened", workflowId: "babysit", lastSeenAt: 5000, lastSeenSha: "abc123" }]
    });
    const movedHead = { kind: "pr" as const, pr: pr({ headRefOid: "def456" }) };
    expect(act({ subject: movedHead, viewer: "me", sessions: [reviewer, babysat], workflows: withBabysit })).toMatchObject({
      kind: "session",
      mode: "open",
      label: "Babysit",
      session: { id: "babysat" }
    });
    const failingRun = { kind: "run" as const, run: run({ prNumber: 42, conclusion: "failure" }) };
    expect(act({ subject: failingRun, viewer: "dev", sessions: [babysat], workflows: withBabysit })).toMatchObject({
      kind: "session",
      mode: "open",
      session: { id: "babysat" }
    });
    expect(babysitterFor({ kind: "pr", pr: pr({ state: "CLOSED" }) }, [babysat], withBabysit)).toBeNull();
  });

  it("marks a working session", () => {
    const action = act({ subject: { kind: "pr", pr: pr() }, viewer: "me", sessions: [session({ status: "working" })], workflows: prWorkflows });
    expect(action).toMatchObject({ kind: "session", meta: "working" });
  });

  it("suggests a workflow, flagging urgent ones, and falls back to the first enabled", () => {
    const suggested = act({
      subject: { kind: "pr", pr: pr({ ci: "failing", viewerIsAuthor: true }) },
      viewer: "me",
      sessions: [],
      workflows: prWorkflows
    });
    expect(suggested).toMatchObject({ kind: "workflow", urgent: true });
    expect(suggested.kind === "workflow" && suggested.workflow.id).toBe("fix-ci");
    const fallback = act({ subject: { kind: "pr", pr: pr() }, viewer: "me", sessions: [], workflows: prWorkflows });
    expect(fallback).toMatchObject({ kind: "workflow", urgent: false });
    expect(fallback.kind === "workflow" && fallback.workflow.id).toBe("review");
  });

  it("falls back to GitHub for finished subjects and logs for runs without workflows", () => {
    expect(act({ subject: { kind: "pr", pr: pr({ state: "MERGED" }) }, viewer: "me", sessions: [], workflows: prWorkflows })).toEqual({ kind: "github" });
    expect(act({ subject: { kind: "issue", issue: issue({ state: "CLOSED" }) }, viewer: "me", sessions: [], workflows: prWorkflows })).toEqual({ kind: "github" });
    expect(act({ subject: { kind: "run", run: run() }, viewer: "me", sessions: [], workflows: prWorkflows })).toEqual({ kind: "logs" });
  });

  it("never falls back to the first enabled run workflow", () => {
    const runWorkflows = [workflow({ id: "run-ci", target: "run", suggestWhen: ["run-failed"] }), workflow({ id: "other-run", target: "run" })];
    expect(act({ subject: { kind: "run", run: run() }, viewer: "me", sessions: [], workflows: runWorkflows })).toEqual({ kind: "logs" });
    const failed = act({ subject: { kind: "run", run: run({ conclusion: "failure", actor: "me" }) }, viewer: "me", sessions: [], workflows: runWorkflows });
    expect(failed).toMatchObject({ kind: "workflow", urgent: true });
    expect(failed.kind === "workflow" && failed.workflow.id).toBe("run-ci");
  });

  it("opens the latest session on a merged PR", () => {
    const action = act({ subject: { kind: "pr", pr: pr({ state: "MERGED" }) }, viewer: "me", sessions: [session()], workflows: prWorkflows });
    expect(action).toMatchObject({ kind: "session", mode: "open" });
  });

  it("flags an issue session with new activity as unseen", () => {
    const issueSession = sessionMeta({ id: "i1", updatedAt: 9, issues: [{ ref: issue().ref, origin: "workflow", lastSeenAt: 500 }] });
    const subject = { kind: "issue" as const, issue: issue({ updatedAt: 900 }) };
    const action = act({ subject, viewer: "me", sessions: [issueSession], workflows: prWorkflows, unseen: unseenSessionIds(subject, [issueSession]) });
    expect(action).toMatchObject({ kind: "session", meta: "unseen" });
  });
});

describe("continueSessionFor", () => {
  const prSession = sessionMeta({ id: "pr", updatedAt: 1, prs: [{ ref: pr().ref, origin: "opened", lastSeenAt: 0, lastSeenSha: "" }] });
  const other = sessionMeta({ id: "other", updatedAt: 9 });

  it("continues the PR's main session for PR workflows, including from a run row", () => {
    expect(continueSessionFor({ kind: "pr", pr: pr() }, "pr", [prSession])?.id).toBe("pr");
    expect(continueSessionFor({ kind: "run", run: run({ prNumber: 42 }) }, "pr", [prSession, other])?.id).toBe("pr");
    expect(continueSessionFor({ kind: "run", run: run() }, "pr", [prSession])).toBeNull();
  });

  it("continues only sessions linked to the issue for issue workflows", () => {
    const linked = sessionMeta({ id: "linked", updatedAt: 3, issues: [{ ref: issue().ref, origin: "workflow", lastSeenAt: 0 }] });
    expect(continueSessionFor({ kind: "issue", issue: issue() }, "issue", [prSession, other, linked])?.id).toBe("linked");
    expect(continueSessionFor({ kind: "issue", issue: issue() }, "issue", [prSession, other])).toBeNull();
  });

  it("continues only sessions linked to the run for run workflows", () => {
    const linked = sessionMeta({ id: "linked", updatedAt: 3, runs: [{ ref: run().ref, origin: "workflow", lastSeenAt: 0 }] });
    expect(continueSessionFor({ kind: "run", run: run({ prNumber: 42 }) }, "run", [prSession, other, linked])?.id).toBe("linked");
    expect(continueSessionFor({ kind: "run", run: run({ prNumber: 42 }) }, "run", [prSession, other])).toBeNull();
  });
});

describe("run unseen dot", () => {
  const prSession = sessionMeta({ id: "pr", prs: [{ ref: pr().ref, origin: "opened", lastSeenAt: 5000, lastSeenSha: "abc123" }] });
  const runSession = sessionMeta({ id: "run", runs: [{ ref: run().ref, origin: "workflow", lastSeenAt: 2000 }] });
  const subject = { kind: "run" as const, run: run({ prNumber: 42, updatedAt: 3000 }) };

  it("is set when the run's PR has unseen updates in a linked session", () => {
    const lookup = (): PrSummary => pr({ updatedAt: 9000 });
    expect([...unseenSessionIds(subject, [prSession], lookup)]).toEqual(["pr"]);
    expect(unseenSessionIds(subject, [prSession], () => pr({ updatedAt: 1000 })).size).toBe(0);
    expect(unseenSessionIds(subject, [prSession]).size).toBe(0);
  });

  it("is set when a run-linked session last saw the run before its last update", () => {
    expect([...unseenSessionIds(subject, [runSession])]).toEqual(["run"]);
    expect(unseenSessionIds({ kind: "run", run: run({ updatedAt: 1500 }) }, [runSession]).size).toBe(0);
  });
});

describe("rowDelta", () => {
  const link = (lastSeenSha: string) => ({ ref: pr().ref, origin: "workflow" as const, lastSeenAt: 500, lastSeenSha });
  const now = 1000 + 3 * 3_600_000;

  it("says new commits when the head moved and updated <age> otherwise", () => {
    const moved = sessionMeta({ prs: [link("old")] });
    expect(rowDelta({ kind: "pr", pr: pr() }, [moved], now)).toBe("new commits");
    const same = sessionMeta({ prs: [link("abc123")] });
    expect(rowDelta({ kind: "pr", pr: pr() }, [same], now)).toBe("updated 3h");
    expect(rowDelta({ kind: "pr", pr: pr({ updatedAt: 100 }) }, [same], now)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(391_000)).toBe("6m 31s");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
  });
});
