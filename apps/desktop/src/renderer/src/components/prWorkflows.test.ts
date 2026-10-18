import { describe, expect, it } from "vitest";
import type { IssueDetail, PrCheck, PrDetail, PrRef, PrSummary, PrWorkflow, SessionMeta, WorkflowRunSummary } from "@cw-code/contracts";
import {
  attributionText,
  failedJobNames,
  issueTemplateVars,
  loadFailedLogs,
  primaryAction,
  resolveTemplate,
  runRefTemplateVars,
  runTemplateVars,
  suggestedWorkflow,
  TEMPLATE_VARS,
  TEMPLATE_VARS_BY_TARGET,
  templateVars
} from "./prWorkflows.js";

function prSummary(overrides: Partial<PrSummary> = {}): PrSummary {
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
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
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

function prDetail(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    ...prSummary(),
    body: "PR body",
    createdAt: 0,
    timeline: [],
    threads: [],
    checkRuns: [],
    commits: [],
    reviewers: [],
    viewerLogin: "",
    ...overrides
  };
}

function workflow(overrides: Partial<PrWorkflow> = {}): PrWorkflow {
  return {
    id: "review",
    label: "Review",
    description: "desc",
    icon: "eye",
    builtIn: true,
    enabled: true,
    target: "pr",
    suggestWhen: ["review-requested"],
    workspace: "checkout",
    startPrompt: "start",
    updatePrompt: "update",
    ...overrides
  };
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    projectId: "p1",
    driver: "claude",
    title: "Session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

describe("resolveTemplate", () => {
  it("substitutes known vars", () => {
    expect(resolveTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("leaves unknown vars in place", () => {
    expect(resolveTemplate("Hi {{unknown}}", { name: "World" })).toBe("Hi {{unknown}}");
  });

  it("substitutes repeated vars", () => {
    expect(resolveTemplate("{{x}} and {{x}} again", { x: "y" })).toBe("y and y again");
  });
});

describe("templateVars", () => {
  it("formats diff stat, repo, and checks summary", () => {
    const detail = prDetail({
      checkRuns: [
        { name: "test", workflow: "ci", status: "success", url: null, runId: null, completedAt: null },
        { name: "lint", workflow: "ci", status: "failure", url: null, runId: null, completedAt: null }
      ]
    });
    const vars = templateVars(detail, { attribution: "att", harness: "Claude" });
    expect(vars["pr.repo"]).toBe("acme/widgets");
    expect(vars["pr.diffStat"]).toBe("+10 −2, 3 files");
    expect(vars["checks.summary"]).toBe("1 passed, 1 failing (lint)");
    expect(vars.attribution).toBe("att");
    expect(vars.harness).toBe("Claude");
  });

  it("formats unresolved threads separately from all threads", () => {
    const detail = prDetail({
      threads: [
        { id: "t1", path: "a.ts", line: 5, isResolved: true, diffHunk: "", comments: [{ author: "bob", body: "ok", createdAt: 0 }] },
        { id: "t2", path: "b.ts", line: 9, isResolved: false, diffHunk: "", comments: [{ author: "amy", body: "fix this", createdAt: 0 }] }
      ]
    });
    const vars = templateVars(detail, { attribution: "", harness: "" });
    expect(vars["pr.threads"]).toBe("- a.ts:5 — bob: ok\n- b.ts:9 — amy: fix this");
    expect(vars["pr.unresolvedThreads"]).toBe("- b.ts:9 — amy: fix this");
  });
});

describe("attributionText", () => {
  it("is empty when disabled", () => {
    expect(attributionText({ prAttributionEnabled: false, prAttributionText: "— {{harness}}" }, "Claude")).toBe("");
  });

  it("resolves harness when enabled", () => {
    expect(attributionText({ prAttributionEnabled: true, prAttributionText: "drafted with {{harness}}" }, "Claude")).toBe("drafted with Claude");
  });
});

describe("suggestedWorkflow", () => {
  const review = workflow({ id: "review", suggestWhen: ["review-requested"] });
  const babysit = workflow({ id: "babysit", suggestWhen: ["author"] });
  const bot = workflow({ id: "bot-check", suggestWhen: ["bot-author"] });
  const workflows = [review, babysit, bot];

  it("suggests review when review requested from viewer", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: true });
    expect(suggestedWorkflow(pr, workflows)?.id).toBe("review");
  });

  it("suggests babysit when viewer is the author", () => {
    const pr = prSummary({ viewerIsAuthor: true });
    expect(suggestedWorkflow(pr, workflows)?.id).toBe("babysit");
  });

  it("suggests the bot workflow for a bot author", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: false, author: { login: "dependabot", isBot: true } });
    expect(suggestedWorkflow(pr, workflows)?.id).toBe("bot-check");
  });

  it("skips a disabled workflow even when its condition matches", () => {
    const disabledReview = workflow({ id: "review", suggestWhen: ["review-requested"], enabled: false });
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: true });
    expect(suggestedWorkflow(pr, [disabledReview, babysit])).toBeNull();
  });
});

describe("primaryAction", () => {
  const reviewWorkflow = workflow({ id: "review", suggestWhen: ["review-requested"] });

  it("returns none for a merged PR", () => {
    const pr = prSummary({ state: "MERGED" });
    expect(primaryAction(pr, [session()], [reviewWorkflow])).toEqual({ kind: "none" });
  });

  it("returns open when a main session has seen the current head", () => {
    const pr = prSummary({ headRefOid: "sha1" });
    const linked = [session({ prs: [{ ref: pr.ref, origin: "opened", lastSeenSha: "sha1", lastSeenAt: 0 }] })];
    expect(primaryAction(pr, linked, [])).toEqual({ kind: "open", sessionId: "s1" });
  });

  it("returns continue when the main session is a review link behind the head", () => {
    const pr = prSummary({ headRefOid: "sha2" });
    const linked = [session({ prs: [{ ref: pr.ref, origin: "workflow", workflowId: "review", lastSeenSha: "sha1", lastSeenAt: 0 }] })];
    expect(primaryAction(pr, linked, [])).toEqual({ kind: "continue", sessionId: "s1", workflowId: "review" });
  });

  it("returns open when the review session already saw the current head", () => {
    const pr = prSummary({ headRefOid: "sha1" });
    const linked = [session({ prs: [{ ref: pr.ref, origin: "workflow", workflowId: "review", lastSeenSha: "sha1", lastSeenAt: 0 }] })];
    expect(primaryAction(pr, linked, [])).toEqual({ kind: "open", sessionId: "s1" });
  });

  it("returns run for a suggested workflow when nothing is linked", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: true });
    expect(primaryAction(pr, [], [reviewWorkflow])).toEqual({ kind: "run", workflowId: "review" });
  });

  it("returns none when nothing is linked and no workflow is suggested", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: false });
    expect(primaryAction(pr, [], [reviewWorkflow])).toEqual({ kind: "none" });
  });
});

function issueDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 },
    url: "https://github.com/acme/widgets/issues/7",
    title: "Crash on start",
    state: "OPEN",
    stateReason: null,
    author: { login: "reporter", isBot: false },
    assignees: [],
    labels: ["bug", "p1"],
    milestone: null,
    commentsCount: 0,
    linkedPrs: [],
    createdAt: 0,
    updatedAt: 0,
    body: "It crashes.",
    comments: [],
    viewerLogin: "me",
    ...overrides
  };
}

function runSummary(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 99 },
    url: "https://github.com/acme/widgets/actions/runs/99",
    workflowName: "CI",
    runNumber: 12,
    event: "push",
    branch: "main",
    headSha: "deadbeef",
    title: "fix",
    actor: "dev",
    status: "completed",
    conclusion: "failure",
    prNumber: null,
    onDefaultBranch: true,
    createdAt: 0,
    updatedAt: 0,
    jobs: [],
    ...overrides
  };
}

const baseOpts = { attribution: "signed", harness: "Claude Code" };

describe("issueTemplateVars", () => {
  it("fills the scalar fields and joins labels", () => {
    const vars = issueTemplateVars(issueDetail(), baseOpts);
    expect(vars["issue.number"]).toBe("7");
    expect(vars["issue.repo"]).toBe("acme/widgets");
    expect(vars["issue.title"]).toBe("Crash on start");
    expect(vars["issue.labels"]).toBe("bug, p1");
    expect(vars.attribution).toBe("signed");
    expect(vars.harness).toBe("Claude Code");
  });

  it("formats comments as author: body", () => {
    const issue = issueDetail({ comments: [{ author: "a", body: "first", createdAt: 1 }] });
    expect(issueTemplateVars(issue, baseOpts)["issue.comments"]).toBe("a: first");
  });

  it("keeps only the last 10 comments", () => {
    const comments = Array.from({ length: 12 }, (_, i) => ({ author: "a", body: `c${i}`, createdAt: i }));
    const lines = issueTemplateVars(issueDetail({ comments }), baseOpts)["issue.comments"].split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("a: c2");
    expect(lines[9]).toBe("a: c11");
  });

  it("limits the delta to comments after the link's lastSeenAt", () => {
    const comments = [
      { author: "a", body: "old", createdAt: 100 },
      { author: "b", body: "same", createdAt: 200 },
      { author: "c", body: "new", createdAt: 300 }
    ];
    const link = { ref: issueDetail().ref, origin: "workflow" as const, lastSeenAt: 200 };
    expect(issueTemplateVars(issueDetail({ comments }), { ...baseOpts, link })["issue.delta"]).toBe("c: new");
  });

  it("leaves the delta empty without a link", () => {
    const comments = [{ author: "a", body: "x", createdAt: 100 }];
    expect(issueTemplateVars(issueDetail({ comments }), baseOpts)["issue.delta"]).toBe("");
  });
});

describe("runTemplateVars", () => {
  it("lists failed jobs and ignores passing ones", () => {
    const job = (name: string, conclusion: WorkflowRunSummary["jobs"][number]["conclusion"]) => ({
      name,
      status: "completed" as const,
      conclusion,
      startedAt: null,
      completedAt: null,
      url: null
    });
    const run = runSummary({ jobs: [job("build", "success"), job("test", "failure"), job("lint", "timed_out"), job("docs", "cancelled")] });
    expect(failedJobNames(run.jobs)).toEqual(["test", "lint"]);
    expect(runTemplateVars(run, baseOpts)["run.failedJobs"]).toBe("test, lint");
  });

  it("fills the run fields and failed logs", () => {
    const vars = runTemplateVars(runSummary(), { ...baseOpts, failedLogs: "boom" });
    expect(vars["run.id"]).toBe("99");
    expect(vars["run.number"]).toBe("12");
    expect(vars["run.workflow"]).toBe("CI");
    expect(vars["run.repo"]).toBe("acme/widgets");
    expect(vars["run.branch"]).toBe("main");
    expect(vars["run.sha"]).toBe("deadbeef");
    expect(vars["run.event"]).toBe("push");
    expect(vars["run.failedLogs"]).toBe("boom");
  });

  it("uses empty strings for a missing branch and missing logs", () => {
    const vars = runTemplateVars(runSummary({ branch: null }), baseOpts);
    expect(vars["run.branch"]).toBe("");
    expect(vars["run.failedLogs"]).toBe("");
  });
});

describe("runRefTemplateVars", () => {
  it("resolves everything that needs run data to an empty string", () => {
    const vars = runRefTemplateVars(runSummary().ref, baseOpts);
    expect(vars["run.id"]).toBe("99");
    expect(vars["run.repo"]).toBe("acme/widgets");
    expect(vars["run.workflow"]).toBe("");
    expect(vars["run.failedJobs"]).toBe("");
  });
});

describe("TEMPLATE_VARS_BY_TARGET", () => {
  it("keeps the PR variables for pr workflows", () => {
    expect(TEMPLATE_VARS_BY_TARGET.pr).toBe(TEMPLATE_VARS);
  });

  it("covers every variable each target's vars function produces", () => {
    const issueKeys = Object.keys(issueTemplateVars(issueDetail(), baseOpts)).sort();
    const runKeys = Object.keys(runTemplateVars(runSummary(), baseOpts)).sort();
    expect([...TEMPLATE_VARS_BY_TARGET.issue].sort()).toEqual(issueKeys);
    expect([...TEMPLATE_VARS_BY_TARGET.run].sort()).toEqual(runKeys);
  });
});

describe("issueTemplateVars truncation", () => {
  it("caps the body at 8000 characters with a marker", () => {
    const vars = issueTemplateVars(issueDetail({ body: "b".repeat(9000) }), baseOpts);
    expect(vars["issue.body"]).toBe(`${"b".repeat(8000)}\n[…truncated]`);
  });

  it("leaves a body at the cap untouched", () => {
    expect(issueTemplateVars(issueDetail({ body: "b".repeat(8000) }), baseOpts)["issue.body"]).toHaveLength(8000);
  });

  it("caps each comment at 2000 characters in comments and delta", () => {
    const comments = [{ author: "a", body: "c".repeat(2500), createdAt: 300 }];
    const link = { ref: issueDetail().ref, origin: "workflow" as const, lastSeenAt: 100 };
    const vars = issueTemplateVars(issueDetail({ comments }), { ...baseOpts, link });
    const expected = `a: ${"c".repeat(2000)}\n[…truncated]`;
    expect(vars["issue.comments"]).toBe(expected);
    expect(vars["issue.delta"]).toBe(expected);
  });
});

function check(overrides: Partial<PrCheck> = {}): PrCheck {
  return { name: "test", workflow: "ci", status: "failure", url: null, runId: 1, completedAt: null, ...overrides };
}

describe("loadFailedLogs", () => {
  it("fetches each failing run once, labels it with its checks and joins the sections", async () => {
    const calls: Array<{ ref: PrRef; runId: number }> = [];
    const detail = prDetail({
      checkRuns: [
        check({ name: "unit", runId: 7 }),
        check({ name: "lint", runId: 7 }),
        check({ name: "e2e", runId: 9 }),
        check({ name: "build", status: "success", runId: 11 }),
        check({ name: "external", runId: null })
      ]
    });
    const text = await loadFailedLogs(detail, async (ref, runId) => {
      calls.push({ ref, runId });
      return `  log ${runId}  \n`;
    });
    expect(calls.map((c) => c.runId)).toEqual([7, 9]);
    expect(calls[0].ref).toEqual(detail.ref);
    expect(text).toBe("### unit, lint (run 7)\nlog 7\n\n### e2e (run 9)\nlog 9");
  });

  it("keeps only the tail of a long run log", async () => {
    const detail = prDetail({ checkRuns: [check({ runId: 3 })] });
    const log = `${"a".repeat(100)}${"b".repeat(12_000)}`;
    const text = await loadFailedLogs(detail, async () => log);
    expect(text).toBe(`### test (run 3)\n[…truncated]\n${"b".repeat(12_000)}`);
  });

  it("caps the joined logs and marks the cut", async () => {
    const detail = prDetail({ checkRuns: [1, 2, 3].map((runId) => check({ name: `job${runId}`, runId })) });
    const text = await loadFailedLogs(detail, async () => "x".repeat(11_000));
    expect(text.endsWith("\n[…more logs truncated]")).toBe(true);
    expect(text.length).toBe(30_000 + "\n[…more logs truncated]".length);
  });

  it("returns an empty string when no run failed", async () => {
    const detail = prDetail({ checkRuns: [check({ status: "success" })] });
    expect(await loadFailedLogs(detail, async () => "unused")).toBe("");
  });
});
