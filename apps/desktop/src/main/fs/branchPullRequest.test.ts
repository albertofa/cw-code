import { describe, expect, it, vi } from "vitest";
import { parsePullRequestList, pickBranchPullRequest, pickComparisonBase, type BranchPullRequestCandidate } from "./branchPullRequest.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function candidate(overrides: Partial<BranchPullRequestCandidate> = {}): BranchPullRequestCandidate {
  return {
    number: 1,
    title: "Feature",
    url: "https://github.com/acme/repo/pull/1",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: null,
    headRefName: "feature",
    baseRefName: "main",
    headRefOid: HEAD,
    updatedAt: 1_000,
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    headOwner: "acme",
    ...overrides
  };
}

const target = { branch: "feature", headSha: HEAD, owner: "acme" };

describe("parsePullRequestList", () => {
  it("maps gh pr list fields, head owner and update time", () => {
    const [parsed] = parsePullRequestList(JSON.stringify([{
      number: 42,
      title: "Worktrees",
      url: "https://github.com/acme/repo/pull/42",
      state: "MERGED",
      isDraft: true,
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: HEAD,
      headRepositoryOwner: { id: "x", login: "acme", name: "Acme" },
      updatedAt: "2026-10-22T13:30:49Z",
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { status: "IN_PROGRESS" }]
    }]));
    expect(parsed).toEqual({
      number: 42,
      title: "Worktrees",
      url: "https://github.com/acme/repo/pull/42",
      state: "MERGED",
      isDraft: true,
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: HEAD,
      updatedAt: Date.parse("2026-10-22T13:30:49Z"),
      checks: { total: 3, passed: 1, failed: 1, pending: 1 },
      headOwner: "acme"
    });
  });

  it("tolerates a null head owner and missing optional fields", () => {
    const [parsed] = parsePullRequestList(JSON.stringify([{ number: 7, url: "https://github.com/acme/repo/pull/7", headRepositoryOwner: null }]));
    expect(parsed).toMatchObject({ number: 7, state: "OPEN", headOwner: null, updatedAt: 0, headRefOid: "", title: "Pull request #7" });
  });

  it("returns an empty list for malformed output and skips invalid entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(parsePullRequestList("not-json")).toEqual([]);
      expect(parsePullRequestList(JSON.stringify({ number: 1 }))).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0][0]).toContain("[git] could not parse gh pr list output");
      expect(parsePullRequestList(JSON.stringify([null, { number: 0, url: "x" }, { number: 3 }]))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("pickBranchPullRequest", () => {
  it("prefers an open pull request over a merged one", () => {
    const picked = pickBranchPullRequest([
      candidate({ number: 1, state: "MERGED", updatedAt: 5_000 }),
      candidate({ number: 2, state: "OPEN", headRefOid: OTHER, updatedAt: 1_000 })
    ], target);
    expect(picked?.number).toBe(2);
  });

  it("picks the most recently updated open pull request", () => {
    const picked = pickBranchPullRequest([
      candidate({ number: 1, updatedAt: 1_000 }),
      candidate({ number: 2, updatedAt: 3_000 }),
      candidate({ number: 3, updatedAt: 2_000 })
    ], target);
    expect(picked?.number).toBe(2);
  });

  it("links a merged pull request only when its head matches the local head exactly", () => {
    expect(pickBranchPullRequest([candidate({ state: "MERGED" })], target)?.number).toBe(1);
    expect(pickBranchPullRequest([candidate({ state: "MERGED", headRefOid: OTHER })], target)).toBeNull();
    expect(pickBranchPullRequest([candidate({ state: "MERGED" })], { ...target, headSha: null })).toBeNull();
  });

  it("ignores a closed pull request with a different head", () => {
    expect(pickBranchPullRequest([candidate({ state: "CLOSED", headRefOid: OTHER })], target)).toBeNull();
  });

  it("ignores pull requests from a fork with a different head owner", () => {
    expect(pickBranchPullRequest([candidate({ headOwner: "someone-else" })], target)).toBeNull();
    expect(pickBranchPullRequest([candidate({ headOwner: "ACME" })], target)?.number).toBe(1);
  });

  it("tolerates an unknown owner on either side", () => {
    expect(pickBranchPullRequest([candidate({ headOwner: null })], target)?.number).toBe(1);
    expect(pickBranchPullRequest([candidate({ headOwner: "someone-else" })], { ...target, owner: null })?.number).toBe(1);
  });

  it("ignores pull requests for other head branches and strips the head owner", () => {
    expect(pickBranchPullRequest([candidate({ headRefName: "feature-2" })], target)).toBeNull();
    expect(pickBranchPullRequest([candidate()], target)).not.toHaveProperty("headOwner");
  });
});

describe("pickComparisonBase", () => {
  it("prefers an existing requested base, then the default, then the fallback", () => {
    expect(pickComparisonBase({ requested: "origin/develop", requestedExists: true, defaultBase: "origin/main", fallback: "main" })).toBe("origin/develop");
    expect(pickComparisonBase({ requested: "origin/develop", requestedExists: false, defaultBase: "origin/main", fallback: "main" })).toBe("origin/main");
    expect(pickComparisonBase({ requested: null, requestedExists: false, defaultBase: null, fallback: "main" })).toBe("main");
    expect(pickComparisonBase({ requested: "gone", requestedExists: false, defaultBase: null, fallback: null })).toBeNull();
  });
});
