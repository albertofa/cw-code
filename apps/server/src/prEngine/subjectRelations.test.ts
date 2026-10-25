import { describe, expect, it } from "bun:test";
import type { IssueSummary, PrSummary, PrWorkflow, SessionMeta, WorkflowRunSummary } from "@cw-code/contracts";
import {
  babysitterFor,
  continueSessionFor,
  issueBucket,
  needsAttentionCount,
  prBucket,
  rowAction,
  rowDelta,
  runBucket,
  sessionsForIssue,
  sessionsForRun,
  subjectRelations,
  unseenSessionIds
} from "./subjectRelations.js";

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

describe("prBucket", () => {
  const authored = (overrides: Partial<PrSummary> = {}) => pr({ viewerIsAuthor: true, ci: "pending", ...overrides });

  it("puts merged pull requests in merged", () => {
    expect(prBucket(authored({ state: "MERGED", ci: "failing" }))).toBe("merged");
  });

  it("puts closed unmerged pull requests in closed", () => {
    expect(prBucket(authored({ state: "CLOSED", ci: "failing" }))).toBe("closed");
  });

  it("puts review requests from someone else in review", () => {
    expect(prBucket(authored({ viewerIsAuthor: false, reviewRequestedFromViewer: true }))).toBe("review");
  });

  it("puts authored pull requests needing work in action", () => {
    expect(prBucket(authored({ ci: "failing" }))).toBe("action");
    expect(prBucket(authored({ review: "changes_requested" }))).toBe("action");
    expect(prBucket(authored({ mergeable: "CONFLICTING" }))).toBe("action");
  });

  it("puts approved and passing authored pull requests in ready", () => {
    expect(prBucket(authored({ review: "approved", ci: "passing" }))).toBe("ready");
  });

  it("puts everything else in waiting", () => {
    expect(prBucket(authored())).toBe("waiting");
    expect(prBucket(authored({ viewerIsAuthor: false, ci: "failing" }))).toBe("waiting");
  });
});

describe("needsAttentionCount", () => {
  it("counts review and action buckets only", () => {
    const items = [
      pr({ viewerIsAuthor: false, reviewRequestedFromViewer: true }),
      pr({ viewerIsAuthor: true, ci: "failing" }),
      pr({ viewerIsAuthor: true, review: "approved", ci: "passing" }),
      pr({ state: "MERGED" }),
      pr({ viewerIsAuthor: true, ci: "pending" })
    ];
    expect(needsAttentionCount(items)).toBe(2);
  });
});

describe("runBucket", () => {
  it("classifies failed, running and recent runs", () => {
    expect(runBucket(run({ conclusion: "failure" }))).toBe("failing");
    expect(runBucket(run({ status: "in_progress", conclusion: null }))).toBe("running");
    expect(runBucket(run({ status: "queued", conclusion: null }))).toBe("running");
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

describe("session lookup", () => {
  const sessions: SessionMeta[] = [
    sessionMeta({
      id: "pr-session",
      updatedAt: 1,
      prs: [{ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 }, origin: "opened", lastSeenAt: 0, lastSeenSha: "" }]
    }),
    sessionMeta({
      id: "run-session",
      updatedAt: 2,
      runs: [{ ref: { host: "GitHub.com", owner: "ACME", repo: "Widgets", runId: 900 }, origin: "workflow", lastSeenAt: 0 }]
    }),
    sessionMeta({
      id: "issue-session",
      updatedAt: 3,
      issues: [{ ref: { host: "github.com", owner: "Acme", repo: "widgets", number: 7 }, origin: "linked", lastSeenAt: 0 }]
    }),
    sessionMeta({ id: "other", updatedAt: 4 })
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
    expect(action).toMatchObject({ kind: "session", sessionId: "s1", mode: "open", label: "Review", meta: "idle", count: 1 });
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
      sessionId: "babysat"
    });
    const failingRun = { kind: "run" as const, run: run({ prNumber: 42, conclusion: "failure" }) };
    expect(act({ subject: failingRun, viewer: "dev", sessions: [babysat], workflows: withBabysit })).toMatchObject({
      kind: "session",
      mode: "open",
      sessionId: "babysat"
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
    expect(suggested).toEqual({ kind: "workflow", workflowId: "fix-ci", urgent: true });
    const fallback = act({ subject: { kind: "pr", pr: pr() }, viewer: "me", sessions: [], workflows: prWorkflows });
    expect(fallback).toEqual({ kind: "workflow", workflowId: "review", urgent: false });
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
    expect(failed).toEqual({ kind: "workflow", workflowId: "run-ci", urgent: true });
  });

  it("matches issue workflows by assignment and bug label", () => {
    const workflows = [
      workflow({ id: "implement", target: "issue", suggestWhen: ["issue-assigned"] }),
      workflow({ id: "investigate", target: "issue", suggestWhen: ["issue-bug"] })
    ];
    const assigned = act({ subject: { kind: "issue", issue: issue({ assignees: ["me"] }) }, viewer: "me", sessions: [], workflows });
    expect(assigned).toEqual({ kind: "workflow", workflowId: "implement", urgent: true });
    const bug = act({ subject: { kind: "issue", issue: issue({ labels: ["Bug"] }) }, viewer: "me", sessions: [], workflows });
    expect(bug).toEqual({ kind: "workflow", workflowId: "investigate", urgent: false });
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

  it("says commits when the head moved and updated with the PR time otherwise", () => {
    const moved = sessionMeta({ prs: [link("old")] });
    expect(rowDelta({ kind: "pr", pr: pr() }, [moved])).toEqual({ kind: "commits" });
    const same = sessionMeta({ prs: [link("abc123")] });
    expect(rowDelta({ kind: "pr", pr: pr() }, [same])).toEqual({ kind: "updated", at: 1000 });
    expect(rowDelta({ kind: "pr", pr: pr({ updatedAt: 100 }) }, [same])).toBeNull();
  });

  it("reports activity for an issue and nothing for a run", () => {
    const issueSession = sessionMeta({ issues: [{ ref: issue().ref, origin: "workflow", lastSeenAt: 500 }] });
    expect(rowDelta({ kind: "issue", issue: issue() }, [issueSession])).toEqual({ kind: "activity" });
    expect(rowDelta({ kind: "run", run: run() }, [sessionMeta({ runs: [{ ref: run().ref, origin: "workflow", lastSeenAt: 0 }] })])).toBeNull();
  });
});

describe("subjectRelations", () => {
  const reviewWorkflow = workflow({ id: "review", label: "Review", suggestWhen: ["review-requested"] });
  const babysitWorkflow = workflow({ id: "babysit", label: "Babysit", autoFollowUp: true });
  const lookup = () => undefined;

  it("returns empty relations for a subject without sessions", () => {
    expect(subjectRelations({ kind: "pr", pr: pr() }, [sessionMeta()], [reviewWorkflow], "me", lookup)).toEqual({
      linkedSessionIds: [],
      unseenSessionIds: [],
      mainSessionId: null,
      babysitter: null,
      action: { kind: "workflow", workflowId: "review", urgent: false },
      delta: null
    });
  });

  it("collects linked, unseen and main sessions and the delta", () => {
    const seen = sessionMeta({
      id: "seen",
      updatedAt: 1,
      prs: [{ ref: pr().ref, origin: "opened", lastSeenAt: 5000, lastSeenSha: "abc123" }]
    });
    const stale = sessionMeta({
      id: "stale",
      updatedAt: 2,
      prs: [{ ref: pr().ref, origin: "linked", lastSeenAt: 500, lastSeenSha: "old" }]
    });
    const unrelated = sessionMeta({ id: "unrelated", updatedAt: 9 });
    const relations = subjectRelations({ kind: "pr", pr: pr() }, [seen, stale, unrelated], [reviewWorkflow], "me", lookup);
    expect(relations.linkedSessionIds).toEqual(["seen", "stale"]);
    expect(relations.unseenSessionIds).toEqual(["stale"]);
    expect(relations.mainSessionId).toBe("seen");
    expect(relations.babysitter).toBeNull();
    expect(relations.action).toMatchObject({ kind: "session", sessionId: "seen", count: 2 });
    expect(relations.delta).toEqual({ kind: "updated", at: 1000 });
  });

  it("names the babysitting session and opens it", () => {
    const babysat = sessionMeta({
      id: "babysat",
      prs: [{ ref: pr().ref, origin: "opened", workflowId: "babysit", lastSeenAt: 5000, lastSeenSha: "abc123" }]
    });
    const relations = subjectRelations({ kind: "pr", pr: pr() }, [babysat], [reviewWorkflow, babysitWorkflow], "me", lookup);
    expect(relations.babysitter).toEqual({ sessionId: "babysat", workflowId: "babysit" });
    expect(relations.action).toMatchObject({ kind: "session", sessionId: "babysat", label: "Babysit" });
  });

  it("uses the pr lookup to flag a run's linked PR sessions as unseen", () => {
    const prSession = sessionMeta({ id: "pr", prs: [{ ref: pr().ref, origin: "opened", lastSeenAt: 5000, lastSeenSha: "abc123" }] });
    const subject = { kind: "run" as const, run: run({ prNumber: 42, updatedAt: 3000 }) };
    const relations = subjectRelations(subject, [prSession], [], "me", () => pr({ updatedAt: 9000 }));
    expect(relations.linkedSessionIds).toEqual(["pr"]);
    expect(relations.unseenSessionIds).toEqual(["pr"]);
    expect(relations.mainSessionId).toBe("pr");
    expect(relations.delta).toBeNull();
  });

  it("picks the latest session as main for an issue", () => {
    const link = { ref: issue().ref, origin: "workflow" as const, lastSeenAt: 0 };
    const older = sessionMeta({ id: "older", updatedAt: 1, issues: [link] });
    const newer = sessionMeta({ id: "newer", updatedAt: 2, issues: [link] });
    const relations = subjectRelations({ kind: "issue", issue: issue() }, [older, newer], [], "me", lookup);
    expect(relations.mainSessionId).toBe("newer");
    expect(relations.babysitter).toBeNull();
  });
});
