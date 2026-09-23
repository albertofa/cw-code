import { describe, expect, it } from "vitest";
import type { PrDetail, PrReviewThread, PrSummary, PrWorkflow, SessionMeta } from "@cw-code/contracts";
import { linkedSessionsBarState, mergeBoxState, pickMainSession, threadQuoteText, threadSendTarget } from "./prDetailModel.js";

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
    labels: [],
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

describe("mergeBoxState", () => {
  it("marks approved review, passing checks, and no conflicts as ok", () => {
    const detail = prDetail({
      review: "approved",
      ci: "passing",
      mergeable: "MERGEABLE",
      checks: { total: 3, passed: 3, failed: 0, pending: 0 },
      reviewers: [{ login: "bob", state: "APPROVED" }]
    });
    const state = mergeBoxState(detail);
    expect(state.review).toEqual({ ok: true, label: "Approved", detail: "1 approving review" });
    expect(state.ci).toEqual({ ok: true, label: "All checks have passed", detail: "3/3 checks passed" });
    expect(state.conflicts).toEqual({ ok: true, label: "No conflicts with base branch", detail: "" });
    expect(state.overallOk).toBe(true);
  });

  it("lists failing check names and unresolved review state", () => {
    const detail = prDetail({
      review: "changes_requested",
      ci: "failing",
      mergeable: "CONFLICTING",
      checks: { total: 2, passed: 1, failed: 1, pending: 0 },
      checkRuns: [
        { name: "lint", workflow: "ci", status: "failure", url: null, runId: 1, completedAt: null },
        { name: "test", workflow: "ci", status: "success", url: null, runId: 2, completedAt: null }
      ],
      reviewers: [
        { login: "bob", state: "CHANGES_REQUESTED" },
        { login: "amy", state: "APPROVED" }
      ]
    });
    const state = mergeBoxState(detail);
    expect(state.review).toEqual({ ok: false, label: "Changes requested", detail: "1 review requested changes · 1 approval" });
    expect(state.ci).toEqual({ ok: false, label: "Some checks were not successful", detail: "lint" });
    expect(state.conflicts.ok).toBe(false);
    expect(state.overallOk).toBe(false);
  });

  it("falls back to a count when failing checks have no names", () => {
    const detail = prDetail({
      ci: "failing",
      checks: { total: 1, passed: 0, failed: 1, pending: 0 },
      checkRuns: []
    });
    expect(mergeBoxState(detail).ci.detail).toBe("1 failing");
  });
});

describe("threadQuoteText", () => {
  const ref = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };

  it("produces a self-contained ask quoting the path, line, and comments", () => {
    const thread: PrReviewThread = {
      id: "t1",
      path: "src/app.ts",
      line: 42,
      isResolved: false,
      diffHunk: "@@ -1,2 +1,2 @@",
      comments: [
        { author: "bob", body: "this leaks", createdAt: 0 },
        { author: "amy", body: "agreed", createdAt: 0 }
      ]
    };
    expect(threadQuoteText(thread, ref)).toBe(
      "Address this review thread on acme/widgets#42 (src/app.ts:42):\n\nbob: this leaks\n\namy: agreed"
    );
  });

  it("falls back to the path alone when there is no line or comments", () => {
    const thread: PrReviewThread = { id: "t1", path: "README.md", line: null, isResolved: false, diffHunk: "", comments: [] };
    expect(threadQuoteText(thread, ref)).toBe("Address this review thread on acme/widgets#42 (README.md):");
  });
});

describe("linkedSessionsBarState", () => {
  it("returns continue with the stale review session", () => {
    const pr = prSummary({ headRefOid: "sha2" });
    const s = session({ pr: { ref: pr.ref, origin: "workflow", workflowId: "review", lastSeenSha: "sha1", lastSeenAt: 0 } });
    expect(linkedSessionsBarState(pr, [s], [])).toEqual({ kind: "continue", session: s, workflowId: "review" });
  });

  it("returns open with the suggested workflow when the main session is current", () => {
    const pr = prSummary({ headRefOid: "sha1", viewerIsAuthor: true });
    const s = session({ pr: { ref: pr.ref, origin: "opened", lastSeenSha: "sha1", lastSeenAt: 0 } });
    const babysit = workflow({ id: "babysit", suggestWhen: ["author"] });
    expect(linkedSessionsBarState(pr, [s], [babysit])).toEqual({ kind: "open", session: s, suggested: babysit });
  });

  it("returns run when nothing is linked but a workflow is suggested", () => {
    const pr = prSummary({ viewerIsAuthor: false, reviewRequestedFromViewer: true });
    const review = workflow({ id: "review", suggestWhen: ["review-requested"] });
    expect(linkedSessionsBarState(pr, [], [review])).toEqual({ kind: "run", workflowId: "review" });
  });

  it("returns none for a merged PR", () => {
    const pr = prSummary({ state: "MERGED" });
    expect(linkedSessionsBarState(pr, [session()], [])).toEqual({ kind: "none" });
  });
});

describe("threadSendTarget", () => {
  it("continues the main session with its workflow id", () => {
    const s = session({ pr: { ref: { host: "github.com", owner: "a", repo: "b", number: 1 }, origin: "workflow", workflowId: "address-feedback", lastSeenSha: "s", lastSeenAt: 0 } });
    expect(threadSendTarget(s, null)).toEqual({ workflowId: "address-feedback", continueSessionId: "s1" });
  });

  it("falls back to babysit when the main session has no workflow id", () => {
    const s = session({ pr: { ref: { host: "github.com", owner: "a", repo: "b", number: 1 }, origin: "opened", lastSeenSha: "s", lastSeenAt: 0 } });
    expect(threadSendTarget(s, null)).toEqual({ workflowId: "babysit", continueSessionId: "s1" });
  });

  it("uses the suggested workflow when there is no main session", () => {
    const suggested = workflow({ id: "address-feedback" });
    expect(threadSendTarget(null, suggested)).toEqual({ workflowId: "address-feedback" });
  });

  it("falls back to review when there is no main session and no suggestion", () => {
    expect(threadSendTarget(null, null)).toEqual({ workflowId: "review" });
  });
});

describe("pickMainSession", () => {
  it("returns null when there are no linked sessions", () => {
    expect(pickMainSession([])).toBeNull();
  });

  it("prefers the session that opened the PR", () => {
    const opened = session({ id: "opened", pr: { ref: { host: "github.com", owner: "a", repo: "b", number: 1 }, origin: "opened", lastSeenSha: "s", lastSeenAt: 0 } });
    const review = session({ id: "review", updatedAt: 100, pr: { ref: { host: "github.com", owner: "a", repo: "b", number: 1 }, origin: "workflow", workflowId: "review", lastSeenSha: "s", lastSeenAt: 0 } });
    expect(pickMainSession([review, opened])?.id).toBe("opened");
  });

  it("falls back to the review-workflow session when none opened the PR", () => {
    const review = session({ id: "review", pr: { ref: { host: "github.com", owner: "a", repo: "b", number: 1 }, origin: "workflow", workflowId: "review", lastSeenSha: "s", lastSeenAt: 0 } });
    const other = session({ id: "other", updatedAt: 100, pr: { ref: { host: "github.com", owner: "a", repo: "b", number: 1 }, origin: "workflow", workflowId: "babysit", lastSeenSha: "s", lastSeenAt: 0 } });
    expect(pickMainSession([other, review])?.id).toBe("review");
  });

  it("falls back to the most recently updated session otherwise", () => {
    const older = session({ id: "older", updatedAt: 1, pr: { ref: { host: "github.com", owner: "a", repo: "b", number: 1 }, origin: "workflow", workflowId: "babysit", lastSeenSha: "s", lastSeenAt: 0 } });
    const newer = session({ id: "newer", updatedAt: 2, pr: { ref: { host: "github.com", owner: "a", repo: "b", number: 1 }, origin: "workflow", workflowId: "babysit", lastSeenSha: "s", lastSeenAt: 0 } });
    expect(pickMainSession([older, newer])?.id).toBe("newer");
  });
});
