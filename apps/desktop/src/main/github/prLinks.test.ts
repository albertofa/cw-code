import { describe, expect, it } from "vitest";
import type { GitBranchInfo, GitPullRequest, GitStatus, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import { authorLocalBranch, linkFromStatus, markSeen, prHeadPlan } from "./prLinks.js";

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

  it("returns null when the candidate pull request key was previously unlinked", () => {
    const open = status({ pullRequest: pullRequest() });
    const unlinked = session({ prUnlinked: ["github.com/acme/widgets#42"] });
    expect(linkFromStatus(unlinked, open, 100)).toBeNull();
  });

  it("links when a different pull request key was previously unlinked", () => {
    const open = status({ pullRequest: pullRequest() });
    const unlinked = session({ prUnlinked: ["github.com/acme/widgets#7"] });
    expect(linkFromStatus(unlinked, open, 100)).not.toBeNull();
  });

  it("uses the provided head sha instead of an empty string", () => {
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session(), open, 100, "sha-head")).toEqual({
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
      origin: "opened",
      lastSeenSha: "sha-head",
      lastSeenAt: 100
    });
  });

  it("keeps an empty sha when the head is unknown", () => {
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session(), open, 100, null)).toMatchObject({ lastSeenSha: "" });
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

describe("prHeadPlan", () => {
  const branch = (overrides: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
    name: "feature",
    label: "feature",
    current: false,
    remote: false,
    worktreePath: null,
    ...overrides
  });
  const head = (viewerIsAuthor: boolean) => ({
    prHead: { number: 42, headRefName: "feature", headRefOid: "sha-head", viewerIsAuthor }
  });
  const matching = { feature: "sha-head" };

  it("returns null without a pull request head", () => {
    expect(prHeadPlan({ mode: "new" }, [branch()], matching)).toBeNull();
  });

  it("attaches the author's local branch when its tip matches the PR head and no worktree has it", () => {
    expect(prHeadPlan(head(true), [branch()], matching)).toEqual({ kind: "attach", branch: "feature" });
  });

  it("branches from the author's local branch when another worktree has it checked out", () => {
    expect(prHeadPlan(head(true), [branch({ worktreePath: "C:/repo" })], matching)).toEqual({ kind: "base", branch: "feature" });
  });

  it("fetches the pull request head when the author's local branch is behind or diverged", () => {
    expect(prHeadPlan(head(true), [branch()], { feature: "sha-local" })).toEqual({ kind: "fetch", number: 42 });
  });

  it("fetches the pull request head when the local tip is unknown", () => {
    expect(prHeadPlan(head(true), [branch()], {})).toEqual({ kind: "fetch", number: 42 });
  });

  it("fetches the pull request head when the author has no local branch", () => {
    expect(prHeadPlan(head(true), [branch({ name: "other", label: "other" })], { other: "sha-head" })).toEqual({
      kind: "fetch",
      number: 42
    });
  });

  it("ignores a remote-tracking branch with the same name", () => {
    expect(prHeadPlan(head(true), [branch({ remote: true })], matching)).toEqual({ kind: "fetch", number: 42 });
  });

  it("fetches the pull request head when the viewer is not the author even if the branch matches", () => {
    expect(prHeadPlan(head(false), [branch()], matching)).toEqual({ kind: "fetch", number: 42 });
  });
});

describe("authorLocalBranch", () => {
  it("returns the local branch named after the PR head only for the author", () => {
    const local: GitBranchInfo = { name: "feature", label: "feature", current: false, remote: false, worktreePath: null };
    const prHead = { number: 1, headRefName: "feature", headRefOid: "sha", viewerIsAuthor: true };
    expect(authorLocalBranch({ prHead }, [local])).toBe(local);
    expect(authorLocalBranch({ prHead: { ...prHead, viewerIsAuthor: false } }, [local])).toBeNull();
  });
});
