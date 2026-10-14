import { describe, expect, it } from "vitest";
import type { GitBranchInfo, PrWorkflow, RunRef, WorkflowRunSummary, WorkflowSubject } from "../cw.js";
import {
  effectiveSubject,
  findCachedRun,
  isLinkedTo,
  issueKey,
  otherSessionCandidates,
  prRefForRun,
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

const branch = (name: string, remote: boolean, current = false): GitBranchInfo => ({
  name,
  label: remote ? name.slice(name.indexOf("/") + 1) : name,
  current,
  remote,
  worktreePath: null
});

describe("resolveRunBase", () => {
  it("prefers origin/<branch> over a local branch", () => {
    const result = resolveRunBase([branch("feat", false), branch("origin/feat", true)], "feat");
    expect(result).toEqual({ baseBranch: "origin/feat", hint: "isolated, from origin/feat" });
  });

  it("uses the local branch when no origin ref is listed", () => {
    expect(resolveRunBase([branch("feat", false)], "feat").baseBranch).toBe("feat");
  });

  it("matches exactly, never by suffix", () => {
    const branches = [branch("main", false, true), branch("origin/other/feat", true), branch("upstream/feat", true), branch("my-feat", false)];
    const result = resolveRunBase(branches, "feat");
    expect(result.baseBranch).toBeUndefined();
    expect(result.hint).toBe("isolated, from main — run branch feat not found locally or on origin");
  });

  it("warns when the run has no branch", () => {
    const result = resolveRunBase([branch("main", false, true)], null);
    expect(result.baseBranch).toBeUndefined();
    expect(result.hint).toContain("the run has no branch");
  });
});

describe("resolveIssueBase", () => {
  it("follows origin/main, main, origin/master, master", () => {
    expect(resolveIssueBase([branch("master", false), branch("origin/main", true)]).baseBranch).toBe("origin/main");
    expect(resolveIssueBase([branch("master", false), branch("main", false)]).baseBranch).toBe("main");
    expect(resolveIssueBase([branch("master", false), branch("origin/master", true)]).baseBranch).toBe("origin/master");
    expect(resolveIssueBase([branch("master", false)]).baseBranch).toBe("master");
  });

  it("omits the base and says so when none exists", () => {
    const result = resolveIssueBase([branch("develop", false, true)]);
    expect(result.baseBranch).toBeUndefined();
    expect(result.hint).toContain("develop");
    expect(result.hint).toContain("none of");
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
