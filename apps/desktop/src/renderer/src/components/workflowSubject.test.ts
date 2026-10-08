import { describe, expect, it } from "vitest";
import type { GitBranchInfo, PrWorkflow, RunRef, WorkflowRunSummary, WorkflowSubject } from "../cw.js";
import {
  effectiveSubject,
  findCachedRun,
  issueKey,
  prRefForRun,
  runBaseBranch,
  runKey,
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

describe("runBaseBranch", () => {
  const branch = (name: string, remote: boolean): GitBranchInfo => ({ name, label: name, current: false, remote, worktreePath: null });

  it("prefers a local branch, then a remote one, else nothing", () => {
    expect(runBaseBranch([branch("origin/feat", true), branch("feat", false)], "feat")).toBe("feat");
    expect(runBaseBranch([branch("origin/feat", true)], "feat")).toBe("origin/feat");
    expect(runBaseBranch([branch("main", false)], "feat")).toBeUndefined();
    expect(runBaseBranch([branch("main", false)], null)).toBeUndefined();
  });
});
