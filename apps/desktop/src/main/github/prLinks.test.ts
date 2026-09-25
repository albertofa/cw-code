import { describe, expect, it } from "vitest";
import type { GitBranchInfo, GitPullRequest, GitStatus, SessionMeta, SessionPrLink } from "@cw-code/contracts";
import {
  applyTurnSeen,
  authorLocalBranch,
  canOwnAutoLink,
  findLink,
  isValidPrLink,
  linkFromStatus,
  markSeen,
  prHeadPlan,
  removeLink,
  upsertLink
} from "./prLinks.js";
import { changedWorktreeBranch } from "../sessions/worktreeCleanup.js";

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
    worktreePath: "C:/worktrees/feature",
    branch: "feature",
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

  it("links the branch pull request alongside links to other pull requests", () => {
    const existing: SessionPrLink = {
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 },
      origin: "linked",
      lastSeenSha: "sha-old",
      lastSeenAt: 1
    };
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session({ prs: [existing] }), open, 100)).toMatchObject({
      ref: { number: 42 },
      origin: "opened"
    });
  });

  it("returns null when the branch pull request is already linked", () => {
    const existing: SessionPrLink = {
      ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
      origin: "linked",
      lastSeenSha: "sha-old",
      lastSeenAt: 1
    };
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session({ prs: [existing] }), open, 100)).toBeNull();
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

  it("returns null for a session running in the project's current checkout", () => {
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session({ worktreePath: undefined }), open, 100)).toBeNull();
  });

  it("returns null for archived and resolved sessions", () => {
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session({ status: "archived" }), open, 100)).toBeNull();
    expect(linkFromStatus(session({ status: "resolved" }), open, 100)).toBeNull();
  });

  it("returns null when the session branch differs from the checked-out branch", () => {
    const open = status({ pullRequest: pullRequest() });
    expect(linkFromStatus(session({ branch: "other" }), open, 100)).toBeNull();
    expect(linkFromStatus(session({ branch: undefined }), open, 100)).toBeNull();
  });

  it("returns null when the pull request head is a different branch", () => {
    const open = status({ pullRequest: pullRequest({ headRefName: "someone-else" }) });
    expect(linkFromStatus(session(), open, 100)).toBeNull();
  });
});

describe("auto-link ownership", () => {
  it("only lets live worktree sessions own an auto-link", () => {
    expect(canOwnAutoLink(session())).toBe(true);
    expect(canOwnAutoLink(session({ worktreePath: undefined }))).toBe(false);
    expect(canOwnAutoLink(session({ status: "archived" }))).toBe(false);
    expect(canOwnAutoLink(session({ status: "resolved" }))).toBe(false);
  });
});

describe("changedWorktreeBranch", () => {
  it("reports the branch the CLI checked out inside the session worktree", () => {
    const switched = status({ branch: "fix/cache", pullRequest: pullRequest({ headRefName: "fix/cache" }) });
    const stale = session({ branch: "cw/fix-issue-15" });
    const branch = changedWorktreeBranch(stale, switched);
    expect(branch).toBe("fix/cache");
    expect(linkFromStatus(stale, switched, 100)).toBeNull();
    expect(linkFromStatus(session({ branch: branch ?? undefined }), switched, 100)).toMatchObject({ ref: { number: 42 } });
  });

  it("returns null when the stored branch already matches", () => {
    expect(changedWorktreeBranch(session(), status())).toBeNull();
  });

  it("ignores detached heads, unavailable status and sessions without a worktree", () => {
    expect(changedWorktreeBranch(session(), status({ branch: "HEAD" }))).toBeNull();
    expect(changedWorktreeBranch(session(), status({ available: false, branch: "not a repository" }))).toBeNull();
    expect(changedWorktreeBranch(session({ worktreePath: undefined }), status({ branch: "other" }))).toBeNull();
  });

  it("ignores status read from a different checkout", () => {
    expect(changedWorktreeBranch(session(), status({ branch: "other", worktreePath: "C:/repo" }))).toBeNull();
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

  it("never moves lastSeenAt backwards when syncs overlap", () => {
    expect(markSeen({ ...link, lastSeenAt: 500 }, "sha-new", 200)).toMatchObject({ lastSeenSha: "sha-new", lastSeenAt: 500 });
  });
});

describe("applyTurnSeen", () => {
  const covered: SessionPrLink = {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    origin: "opened",
    lastSeenSha: "sha-42",
    lastSeenAt: 10
  };
  const other: SessionPrLink = { ...covered, ref: { ...covered.ref, number: 7 }, lastSeenSha: "sha-7" };

  it("marks covered links seen and leaves uncovered ones alone", () => {
    const next = applyTurnSeen(
      [covered, other],
      [
        { ref: covered.ref, covered: true, head: "new-42", seenAt: null },
        { ref: other.ref, covered: false, head: "new-7", seenAt: null }
      ],
      "worktree-head",
      100
    );
    expect(next).toEqual([{ ...covered, lastSeenSha: "new-42", lastSeenAt: 100 }, other]);
  });

  it("absorbs the session's own push on an uncovered link without touching lastSeenAt", () => {
    const next = applyTurnSeen([covered, other], [{ ref: other.ref, covered: false, head: "own", seenAt: 500 }], "own", 100);
    expect(next).toEqual([covered, { ...other, lastSeenSha: "own" }]);
  });

  it("returns the same list when nothing changed or the link is gone", () => {
    const prs = [covered];
    expect(applyTurnSeen(prs, [{ ref: other.ref, covered: true, head: "x", seenAt: null }], null, 100)).toBe(prs);
    expect(applyTurnSeen(prs, [{ ref: covered.ref, covered: false, head: null, seenAt: null }], null, 100)).toBe(prs);
  });

  it("marks covered links seen through GitHub's updatedAt when the local clock is behind", () => {
    const next = applyTurnSeen([covered], [{ ref: covered.ref, covered: true, head: "new-42", seenAt: 111 }], null, 100);
    expect(next).toEqual([{ ...covered, lastSeenSha: "new-42", lastSeenAt: 111 }]);
  });
});

describe("isValidPrLink", () => {
  const valid: SessionPrLink = {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    origin: "workflow",
    workflowId: "review",
    lastSeenSha: "",
    lastSeenAt: 0
  };

  it("accepts a well-formed link", () => {
    expect(isValidPrLink(valid)).toBe(true);
  });

  it("rejects malformed links", () => {
    expect(isValidPrLink(null)).toBe(false);
    expect(isValidPrLink("github.com/acme/widgets#42")).toBe(false);
    expect(isValidPrLink({ ...valid, ref: undefined })).toBe(false);
    expect(isValidPrLink({ ...valid, ref: { ...valid.ref, number: 0 } })).toBe(false);
    expect(isValidPrLink({ ...valid, ref: { ...valid.ref, owner: "" } })).toBe(false);
    expect(isValidPrLink({ ...valid, origin: "imported" })).toBe(false);
    expect(isValidPrLink({ ...valid, lastSeenSha: undefined })).toBe(false);
    expect(isValidPrLink({ ...valid, lastSeenAt: Number.NaN })).toBe(false);
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

describe("session pull request link list helpers", () => {
  const widgets42: SessionPrLink = {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    origin: "opened",
    lastSeenSha: "sha-1",
    lastSeenAt: 1
  };
  const gadgets7: SessionPrLink = {
    ref: { host: "github.com", owner: "acme", repo: "gadgets", number: 7 },
    origin: "linked",
    lastSeenSha: "sha-7",
    lastSeenAt: 2
  };

  it("appends a link for a new pull request", () => {
    expect(upsertLink([widgets42], gadgets7)).toEqual([widgets42, gadgets7]);
    expect(upsertLink(undefined, widgets42)).toEqual([widgets42]);
  });

  it("replaces the link for the same pull request in place", () => {
    const refreshed = { ...widgets42, lastSeenSha: "sha-2", lastSeenAt: 5 };
    expect(upsertLink([widgets42, gadgets7], refreshed)).toEqual([refreshed, gadgets7]);
  });

  it("does not mutate the input list", () => {
    const prs = [widgets42];
    upsertLink(prs, gadgets7);
    removeLink(prs, widgets42.ref);
    expect(prs).toEqual([widgets42]);
  });

  it("removes only the link for the given ref", () => {
    expect(removeLink([widgets42, gadgets7], { ...widgets42.ref })).toEqual([gadgets7]);
    expect(removeLink(undefined, widgets42.ref)).toEqual([]);
  });

  it("finds a link by ref value", () => {
    expect(findLink([widgets42, gadgets7], { host: "github.com", owner: "acme", repo: "gadgets", number: 7 })).toBe(gadgets7);
    expect(findLink([widgets42], gadgets7.ref)).toBeUndefined();
    expect(findLink(undefined, gadgets7.ref)).toBeUndefined();
  });
});
