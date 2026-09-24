import { describe, expect, it } from "vitest";
import type { PrSummary } from "@cw-code/contracts";
import { needsAttentionCount, prBucket, prKey } from "./prInbox.js";

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
    ci: "pending",
    checks: { total: 1, passed: 0, failed: 0, pending: 1 },
    review: "none",
    mergeable: "MERGEABLE",
    labels: [],
    updatedAt: 1_000,
    ...overrides
  };
}

describe("prKey", () => {
  it("joins host, owner, repo and number", () => {
    expect(prKey({ host: "github.com", owner: "acme", repo: "widgets", number: 42 })).toBe("github.com/acme/widgets#42");
  });
});

describe("prBucket", () => {
  it("puts merged pull requests in merged", () => {
    expect(prBucket(summary({ state: "MERGED", ci: "failing" }))).toBe("merged");
  });

  it("puts review requests from someone else in review", () => {
    expect(prBucket(summary({ viewerIsAuthor: false, reviewRequestedFromViewer: true }))).toBe("review");
  });

  it("puts authored pull requests needing work in action", () => {
    expect(prBucket(summary({ ci: "failing" }))).toBe("action");
    expect(prBucket(summary({ review: "changes_requested" }))).toBe("action");
    expect(prBucket(summary({ mergeable: "CONFLICTING" }))).toBe("action");
  });

  it("puts approved and passing authored pull requests in ready", () => {
    expect(prBucket(summary({ review: "approved", ci: "passing" }))).toBe("ready");
  });

  it("puts everything else in waiting", () => {
    expect(prBucket(summary())).toBe("waiting");
    expect(prBucket(summary({ viewerIsAuthor: false, ci: "failing" }))).toBe("waiting");
  });
});

describe("needsAttentionCount", () => {
  it("counts review and action buckets only", () => {
    const items = [
      summary({ viewerIsAuthor: false, reviewRequestedFromViewer: true }),
      summary({ ci: "failing" }),
      summary({ review: "approved", ci: "passing" }),
      summary({ state: "MERGED" }),
      summary()
    ];
    expect(needsAttentionCount(items)).toBe(2);
  });
});
