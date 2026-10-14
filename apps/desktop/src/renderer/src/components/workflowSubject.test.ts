import { describe, expect, it } from "vitest";
import type { PrWorkflow, RunRef, WorkflowRunSummary, WorkflowSubject } from "../cw.js";
import {
  baseWorkspaceHint,
  effectiveSubject,
  findCachedRun,
  isLinkedTo,
  issueKey,
  otherSessionCandidates,
  prRefForRun,
  prWorkspaceHint,
  issueDataTime,
  resolveIssueBase,
  resolveRunBase,
  runKey,
  subjectLabel,
  subjectLink,
  workflowsForSubject
} from "./workflowSubject.js";

const runRef: RunRef = { host: "github.com", owner: "acme", repo: "widgets", runId: 99 };

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    ref: runRef,
    url: "",
    workflowName: "CI",
    runNumber: 1,
    event: "push",
    branch: "main",
    headSha: "abc",
    title: "",
    actor: null,
    status: "completed",
    conclusion: "failure",
    prNumber: null,
    onDefaultBranch: false,
    createdAt: 0,
    updatedAt: 0,
    jobs: [],
    ...overrides
  };
}

function workflow(id: string, target: PrWorkflow["target"]): PrWorkflow {
  return {
    id,
    label: id,
    description: "",
    icon: "sparkle",
    builtIn: true,
    enabled: true,
    target,
    suggestWhen: [],
    workspace: "checkout",
    startPrompt: "",
    updatePrompt: ""
  };
}

const workflows = [workflow("review", "pr"), workflow("implement", "issue"), workflow("investigate-run", "run")];
const runSubject: WorkflowSubject = { kind: "run", ref: runRef };

describe("workflowsForSubject", () => {
  it("filters by the subject's target", () => {
    const issue: WorkflowSubject = { kind: "issue", ref: { host: "github.com", owner: "a", repo: "b", number: 1 } };
    expect(workflowsForSubject(workflows, issue, undefined).map((w) => w.id)).toEqual(["implement"]);
    expect(workflowsForSubject(workflows, runSubject, run()).map((w) => w.id)).toEqual(["investigate-run"]);
  });

  it("adds pr workflows for a run that belongs to a pull request", () => {
    expect(workflowsForSubject(workflows, runSubject, run({ prNumber: 5 })).map((w) => w.id)).toEqual(["review", "investigate-run"]);
  });
});

describe("effectiveSubject", () => {
  it("turns a run with a pr into a pr subject when a pr workflow is picked", () => {
    const next = effectiveSubject(runSubject, workflows[0], run({ prNumber: 5 }));
    expect(next).toEqual({ kind: "pr", ref: { host: "github.com", owner: "acme", repo: "widgets", number: 5 } });
  });

  it("keeps the run subject for run workflows or runs without a pr", () => {
    expect(effectiveSubject(runSubject, workflows[2], run({ prNumber: 5 }))).toBe(runSubject);
    expect(effectiveSubject(runSubject, workflows[0], run())).toBe(runSubject);
    expect(effectiveSubject(runSubject, workflows[0], undefined)).toBe(runSubject);
  });

  it("never rewrites issue subjects", () => {
    const issue: WorkflowSubject = { kind: "issue", ref: { host: "github.com", owner: "a", repo: "b", number: 1 } };
    expect(effectiveSubject(issue, workflows[0], undefined)).toBe(issue);
  });
});

describe("findCachedRun", () => {
  it("searches across caches by run id", () => {
    const caches = {
      a: { data: { account: null, items: [run({ ref: { ...runRef, runId: 1 } })], fetchedAt: 0, error: null } },
      b: { data: { account: null, items: [run()], fetchedAt: 0, error: null } },
      c: { data: null }
    };
    expect(findCachedRun(caches, runRef)?.ref.runId).toBe(99);
    expect(findCachedRun(caches, { ...runRef, runId: 7 })).toBeUndefined();
  });
});

describe("prRefForRun", () => {
  it("returns null without a pr number", () => {
    expect(prRefForRun(run())).toBeNull();
    expect(prRefForRun(undefined)).toBeNull();
  });
});

describe("subjectLink", () => {
  const issueRef = { host: "github.com", owner: "acme", repo: "widgets", number: 3 };

  it("finds issue and run links by key", () => {
    const session = {
      issues: [{ ref: issueRef, origin: "workflow" as const, lastSeenAt: 10 }],
      runs: [{ ref: runRef, origin: "linked" as const, lastSeenAt: 20 }]
    };
    expect(subjectLink(session, { kind: "issue", ref: issueRef })).toEqual({ origin: "workflow", lastSeenAt: 10 });
    expect(subjectLink(session, runSubject)).toEqual({ origin: "linked", lastSeenAt: 20 });
    expect(subjectLink(session, { kind: "issue", ref: { ...issueRef, number: 4 } })).toBeUndefined();
  });

  it("finds pr links without a lastSeenAt", () => {
    const prRef = { host: "github.com", owner: "acme", repo: "widgets", number: 5 };
    expect(subjectLink({ prs: [{ ref: prRef, origin: "opened" }] }, { kind: "pr", ref: prRef })).toEqual({
      origin: "opened",
      lastSeenAt: null
    });
  });

  it("builds stable keys", () => {
    expect(issueKey(issueRef)).toBe("github.com/acme/widgets#3");
    expect(runKey(runRef)).toBe("github.com/acme/widgets/runs/99");
  });
});

describe("resolveRunBase", () => {
  it("passes the run branch through for main to fetch", () => {
    expect(resolveRunBase("feat")).toEqual({ baseBranch: "feat", source: "feat (fetched from origin)" });
  });

  it("falls back to the default branch when the run has no branch", () => {
    const result = resolveRunBase(null);
    expect(result.baseBranch).toBeUndefined();
    expect(result.source).toContain("the default branch (fetched from origin)");
    expect(result.source).toContain("the run has no branch");
  });
});

describe("resolveIssueBase", () => {
  it("omits the base so main resolves the fetched default branch", () => {
    expect(resolveIssueBase()).toEqual({ baseBranch: undefined, source: "the default branch (fetched from origin)" });
  });
});

describe("workspace hints", () => {
  it("describes the isolated worktree and the checkout switch for issue and run bases", () => {
    const issue = resolveIssueBase();
    expect(baseWorkspaceHint(issue, "worktree", "widgets")).toBe("isolated, from the default branch (fetched from origin)");
    expect(baseWorkspaceHint(issue, "checkout", "widgets")).toBe(
      "switches widgets to a new branch from the default branch (fetched from origin)"
    );
    expect(baseWorkspaceHint(resolveRunBase("feat"), "checkout", null)).toBe(
      "switches the project to a new branch from feat (fetched from origin)"
    );
  });

  it("describes the PR worktree and the checkout switch", () => {
    expect(prWorkspaceHint("fix/x", "worktree", "widgets")).toBe("isolated, from fix/x");
    expect(prWorkspaceHint(null, "worktree", "widgets")).toBe("isolated, from the PR head");
    expect(prWorkspaceHint("fix/x", "checkout", "widgets")).toBe("switches widgets to the PR branch");
  });
});

describe("issueDataTime", () => {
  it("returns the latest of the issue update and its newest comment", () => {
    expect(issueDataTime({ updatedAt: 100, comments: [{ author: "a", body: "", createdAt: 300 }, { author: "b", body: "", createdAt: 200 }] })).toBe(300);
    expect(issueDataTime({ updatedAt: 500, comments: [{ author: "a", body: "", createdAt: 300 }] })).toBe(500);
    expect(issueDataTime({ updatedAt: 100, comments: [] })).toBe(100);
  });
});

describe("isLinkedTo and subjectLabel", () => {
  const prRef = { host: "github.com", owner: "acme", repo: "widgets", number: 5 };
  const issueRef = { host: "github.com", owner: "acme", repo: "widgets", number: 3 };

  it("reports whether a session is linked to the subject", () => {
    const session = { prs: [{ ref: prRef, origin: "opened" as const }] };
    expect(isLinkedTo(session, { kind: "pr", ref: prRef })).toBe(true);
    expect(isLinkedTo(session, { kind: "pr", ref: { ...prRef, number: 6 } })).toBe(false);
    expect(isLinkedTo(session, { kind: "issue", ref: issueRef })).toBe(false);
    expect(isLinkedTo({}, runSubject)).toBe(false);
  });

  it("labels each subject kind", () => {
    expect(subjectLabel({ kind: "pr", ref: prRef }, undefined)).toBe("#5");
    expect(subjectLabel({ kind: "issue", ref: issueRef }, undefined)).toBe("#3");
    expect(subjectLabel(runSubject, 12)).toBe("run #12");
    expect(subjectLabel(runSubject, undefined)).toBe("run 99");
  });
});

describe("otherSessionCandidates", () => {
  const prRef = { host: "github.com", owner: "acme", repo: "widgets", number: 5 };
  const subject: WorkflowSubject = { kind: "pr", ref: prRef };

  function session(id: string, overrides: Partial<{ projectId: string; status: string; updatedAt: number; linked: boolean }> = {}) {
    const { linked, ...rest } = overrides;
    return {
      id,
      projectId: "p1",
      status: "idle",
      updatedAt: 0,
      ...(linked ? { prs: [{ ref: prRef, origin: "opened" as const }] } : {}),
      ...rest
    };
  }

  it("keeps unlinked, non-archived sessions of the project, newest first", () => {
    const sessions = [
      session("old", { updatedAt: 1 }),
      session("new", { updatedAt: 9 }),
      session("linked", { linked: true, updatedAt: 5 }),
      session("archived", { status: "archived", updatedAt: 7 }),
      session("other-project", { projectId: "p2", updatedAt: 8 })
    ];
    expect(otherSessionCandidates(sessions, subject, "p1").map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("limits the list", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(`s${i}`, { updatedAt: i }));
    const result = otherSessionCandidates(sessions, subject, "p1");
    expect(result).toHaveLength(8);
    expect(result[0].id).toBe("s11");
  });

  it("returns nothing without a project", () => {
    expect(otherSessionCandidates([session("a")], subject, null)).toEqual([]);
  });

  it("pins a preselected unlinked session that falls outside the list", () => {
    const sessions = [session("a", { updatedAt: 3 }), session("far", { projectId: "p2" }), session("linked", { linked: true })];
    expect(otherSessionCandidates(sessions, subject, "p1", "far").map((s) => s.id)).toEqual(["far", "a"]);
    expect(otherSessionCandidates(sessions, subject, "p1", "linked").map((s) => s.id)).toEqual(["a"]);
    expect(otherSessionCandidates(sessions, subject, "p1", "a").map((s) => s.id)).toEqual(["a"]);
  });

  it("pins an archived preselected session", () => {
    const sessions = [session("a", { updatedAt: 3 }), session("gone", { status: "archived" })];
    expect(otherSessionCandidates(sessions, subject, "p1", "gone").map((s) => s.id)).toEqual(["gone", "a"]);
  });
});
