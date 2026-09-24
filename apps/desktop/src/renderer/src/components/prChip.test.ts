import { describe, expect, it } from "vitest";
import type { GitPullRequest, PrSummary } from "@cw-code/contracts";
import { prChip } from "./prChip.js";

function summary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add widget",
    state: "OPEN",
    isDraft: false,
    author: { login: "mbarros", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: "feature/widget",
    headRefOid: "sha-1",
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
    updatedAt: 1_000,
    ...overrides
  };
}

function gitPr(overrides: Partial<GitPullRequest> = {}): GitPullRequest {
  return {
    number: 7,
    title: "Fix bug",
    url: "https://github.com/acme/widgets/pull/7",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: null,
    headRefName: "fix/bug",
    baseRefName: "main",
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    ...overrides
  };
}

describe("prChip", () => {
  it("returns null without a summary or git pull request", () => {
    expect(prChip({ pr: null, git: null })).toBeNull();
  });

  it("marks failing checks as bad with an x", () => {
    expect(prChip({ pr: summary({ ci: "failing", review: "approved" }), git: null })).toEqual({
      tone: "bad",
      icon: "x",
      label: "#42",
      reason: "checks failing",
      title: "PR #42 · checks failing"
    });
  });

  it("marks changes requested as bad with a message icon", () => {
    expect(prChip({ pr: summary({ review: "changes_requested" }), git: null })).toMatchObject({ tone: "bad", icon: "message" });
  });

  it("marks approved as ok", () => {
    expect(prChip({ pr: summary({ review: "approved" }), git: null })).toMatchObject({ tone: "ok", icon: "check" });
  });

  it("marks drafts as neutral", () => {
    expect(prChip({ pr: summary({ isDraft: true }), git: null })).toMatchObject({ tone: "neutral", icon: "draft" });
  });

  it("marks a review requested from the viewer as info", () => {
    const pr = summary({ viewerIsAuthor: false, reviewRequestedFromViewer: true });
    expect(prChip({ pr, git: null })).toMatchObject({ tone: "info", icon: "eye", title: "PR #42 · review requested" });
  });

  it("marks merged pull requests as neutral merge even when approved", () => {
    expect(prChip({ pr: summary({ state: "MERGED", review: "approved" }), git: null })).toMatchObject({ tone: "neutral", icon: "merge" });
  });

  it("marks closed pull requests as neutral", () => {
    expect(prChip({ pr: summary({ state: "CLOSED" }), git: null })).toMatchObject({ tone: "neutral", icon: "x", title: "PR #42 · closed" });
  });

  it("marks other open pull requests as warn with a clock", () => {
    expect(prChip({ pr: summary(), git: null })).toEqual({ tone: "warn", icon: "clock", label: "#42", reason: "awaiting review", title: "PR #42 · awaiting review" });
    expect(prChip({ pr: summary({ ci: "pending" }), git: null })).toMatchObject({ tone: "warn", icon: "clock", title: "PR #42 · checks pending" });
  });

  it("prefers the inbox summary over the git pull request", () => {
    expect(prChip({ pr: summary({ review: "approved" }), git: gitPr({ checks: { total: 1, passed: 0, failed: 1, pending: 0 } }) })).toMatchObject({
      tone: "ok",
      label: "#42"
    });
  });

  describe("fallback from GitPullRequest", () => {
    it("uses failed checks", () => {
      const git = gitPr({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } });
      expect(prChip({ pr: null, git })).toEqual({ tone: "bad", icon: "x", label: "#7", reason: "checks failing", title: "PR #7 · checks failing" });
    });

    it("uses the review decision", () => {
      expect(prChip({ pr: null, git: gitPr({ reviewDecision: "CHANGES_REQUESTED" }) })).toMatchObject({ tone: "bad", icon: "message" });
      expect(prChip({ pr: null, git: gitPr({ reviewDecision: "APPROVED" }) })).toMatchObject({ tone: "ok", icon: "check" });
    });

    it("uses draft, merged and pending states", () => {
      expect(prChip({ pr: null, git: gitPr({ isDraft: true }) })).toMatchObject({ tone: "neutral", icon: "draft" });
      expect(prChip({ pr: null, git: gitPr({ state: "MERGED" }) })).toMatchObject({ tone: "neutral", icon: "merge" });
      expect(prChip({ pr: null, git: gitPr({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }) })).toMatchObject({
        tone: "warn",
        icon: "clock",
        title: "PR #7 · checks pending"
      });
    });

    it("never reports a review request without a summary", () => {
      expect(prChip({ pr: null, git: gitPr() })).toMatchObject({ tone: "warn", icon: "clock", title: "PR #7 · awaiting review" });
    });
  });
});
