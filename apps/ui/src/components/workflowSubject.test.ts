import { describe, expect, it } from "bun:test";
import type { WorkflowBase } from "@cw-code/contracts";
import type { RunRef, WorkflowSubject } from "../cw.js";
import { baseWorkspaceHint, issueKey, prWorkspaceHint, runKey, subjectLink } from "./workflowSubject.js";

const runRef: RunRef = { host: "github.com", owner: "acme", repo: "widgets", runId: 99 };
const runSubject: WorkflowSubject = { kind: "run", ref: runRef };
const DEFAULT_BASE: WorkflowBase = { baseBranch: null, label: "the default branch (fetched from origin)" };
const RUN_BASE: WorkflowBase = { baseBranch: "feat", label: "feat (fetched from origin; falls back to the default branch if it no longer exists)" };

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

describe("workspace hints", () => {
  it("describes the isolated worktree and the checkout switch for issue and run bases", () => {
    const issue = DEFAULT_BASE;
    expect(baseWorkspaceHint(issue, "worktree", "widgets")).toBe("isolated, from the default branch (fetched from origin)");
    expect(baseWorkspaceHint(issue, "checkout", "widgets")).toBe(
      "switches widgets to a new branch from the default branch (fetched from origin)"
    );
    expect(baseWorkspaceHint(RUN_BASE, "checkout", null)).toBe(
      "switches the project to a new branch from feat (fetched from origin; falls back to the default branch if it no longer exists)"
    );
  });

  it("describes the PR worktree and the checkout switch", () => {
    expect(prWorkspaceHint("fix/x", "worktree", "widgets")).toBe("isolated, from fix/x");
    expect(prWorkspaceHint(null, "worktree", "widgets")).toBe("isolated, from the PR head");
    expect(prWorkspaceHint("fix/x", "checkout", "widgets")).toBe(
      "switches widgets to the PR branch (or a new branch from the PR head)"
    );
  });
});
