import { describe, expect, it } from "vitest";
import type { GitPullRequest, GitStatus, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { linkFromStatus, markSeen } from "./prLinks.js";

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "sess_1",
    projectId: "proj_1",
    driver: "claude",
    title: "New session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function pullRequest(overrides: Partial<GitPullRequest> = {}): GitPullRequest {
  return {
    number: 42,
    title: "Add feature",
    url: "https://github.com/acme/widgets/pull/42",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: null,
    headRefName: "feature",
    baseRefName: "main",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    ...overrides
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
    isWorktree: true,
    worktreeName: "feature",
    worktreePath: "C:/worktrees/feature",
    repositoryRoot: "C:/repo",
    prNumber: null,
    pullRequest: null,
    githubError: null,
    githubHost: "github.com",
    githubAccount: "octocat",
    githubAccountSource: "active",
    clean: true,
    ...overrides
  };
}

describe("linkFromStatus", () => {
  it("returns null when there is no pull request", () => {
    expect(linkFromStatus(session(), status(), 100)).toBeNull();
  });

  it("returns null when the pull request is merged", () => {
    const merged = status({ pullRequest: pullRequest({ state: "MERGED" }) });
    expect(linkFromStatus(session(), merged, 100)).toBeNull();
  });

  it("keeps an existing link instead of overwriting it", () => {
    const existing: SessionPrLink = {
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 },
      origin: "linked",
      lastSeenSha: "sha-old",
      lastSeenAt: 1
    };
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session({ pr: existing }), open, 100)).toBeNull();
  });

  it("parses the pull request URL into a ref and links with origin opened", () => {
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session(), open, 100)).toEqual({
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
      origin: "opened",
      lastSeenSha: "",
      lastSeenAt: 100
    });
  });
});

describe("markSeen", () => {
  const link: SessionPrLink = {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    origin: "opened",
    lastSeenSha: "sha-old",
    lastSeenAt: 1
  };

  it("updates the sha and timestamp when a head is known", () => {
    expect(markSeen(link, "sha-new", 200)).toEqual({ ...link, lastSeenSha: "sha-new", lastSeenAt: 200 });
  });

  it("keeps the old sha when the head is null", () => {
    expect(markSeen(link, null, 200)).toEqual({ ...link, lastSeenSha: "sha-old", lastSeenAt: 200 });
  });
});
