import { describe, expect, it } from "vitest";
import type { GitPullRequest, PrDetail, PrRef, PrSummary, SessionPrLink } from "@cw-code/contracts";
import { prKey } from "./prInbox.js";
import { sessionPrItemLabel, sessionPrItems, sessionPrItemsTitle } from "./sessionPrItems.js";

function ref(number: number): PrRef {
  return { host: "github.com", owner: "acme", repo: "widgets", number };
}

function link(number: number, overrides: Partial<SessionPrLink> = {}): SessionPrLink {
  return { ref: ref(number), origin: "linked", lastSeenSha: `sha-${number}`, lastSeenAt: 1_000, ...overrides };
}

function summary(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: ref(number),
    url: `https://github.com/acme/widgets/pull/${number}`,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "mbarros", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: `feature/${number}`,
    headRefOid: `sha-${number}`,
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "passing",
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 500,
    ...overrides
  };
}

function gitPr(number: number, overrides: Partial<GitPullRequest> = {}): GitPullRequest {
  return {
    number,
    title: `Branch ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: null,
    headRefName: `feature/${number}`,
    baseRefName: "main",
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    ...overrides
  };
}

function lookup(...items: PrSummary[]): Map<string, PrSummary> {
  return new Map(items.map((item) => [prKey(item.ref), item]));
}

describe("sessionPrItems", () => {
  it("returns nothing without links or a branch PR", () => {
    expect(sessionPrItems(undefined, null, new Map(), {})).toEqual([]);
    expect(sessionPrItems({ prs: [] }, null, new Map(), {})).toEqual([]);
  });

  it("adds a branch item when the branch PR is not linked", () => {
    const items = sessionPrItems({ prs: [link(16)] }, gitPr(18), lookup(summary(16)), {});
    expect(items.map((item) => [item.ref.number, item.source])).toEqual([
      [16, "linked"],
      [18, "branch"]
    ]);
    const branch = items.find((item) => item.source === "branch");
    expect(branch?.link).toBeUndefined();
    expect(branch?.title).toBe("Branch 18");
  });

  it("builds a branch-only item when nothing is linked", () => {
    const items = sessionPrItems({}, gitPr(18), new Map(), {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "branch", unseen: false, headSha: "" });
    expect(items[0].chip.label).toBe("#18");
  });

  it("does not duplicate the branch PR when it is already linked", () => {
    const items = sessionPrItems({ prs: [link(16)] }, gitPr(16), lookup(summary(16)), {});
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("linked");
  });

  it("ignores a branch PR whose url is not a pull request url", () => {
    expect(sessionPrItems({}, gitPr(18, { url: "https://example.com/x" }), new Map(), {})).toEqual([]);
  });

  it("orders by urgency, then by most recent update", () => {
    const summaries = lookup(
      summary(1, { ci: "passing", review: "approved", updatedAt: 100 }),
      summary(2, { ci: "failing", checks: { total: 1, passed: 0, failed: 1, pending: 0 }, updatedAt: 50 }),
      summary(3, { state: "MERGED", updatedAt: 900 }),
      summary(4, { ci: "failing", checks: { total: 1, passed: 0, failed: 1, pending: 0 }, updatedAt: 80 })
    );
    const items = sessionPrItems({ prs: [link(1), link(2), link(3), link(4)] }, null, summaries, {});
    expect(items.map((item) => item.ref.number)).toEqual([4, 2, 1, 3]);
  });

  it("ranks the branch item with the same urgency rules", () => {
    const failing = gitPr(18, { checks: { total: 1, passed: 0, failed: 1, pending: 0 } });
    const items = sessionPrItems({ prs: [link(16)] }, failing, lookup(summary(16, { review: "approved" })), {});
    expect(items.map((item) => item.ref.number)).toEqual([18, 16]);
  });

  it("flags unseen only for linked items that changed since they were seen", () => {
    const summaries = lookup(summary(1, { updatedAt: 2_000 }), summary(2, { updatedAt: 500 }), summary(3, { updatedAt: 500, headRefOid: "moved" }));
    const items = sessionPrItems({ prs: [link(1), link(2), link(3)] }, gitPr(18), summaries, {});
    const unseen = Object.fromEntries(items.map((item) => [item.ref.number, item.unseen]));
    expect(unseen).toEqual({ 1: true, 2: false, 3: true, 18: false });
  });

  it("reads the unseen basis from a loaded detail when no summary exists", () => {
    const base = summary(1, { updatedAt: 2_000 });
    const detail: PrDetail = { ...base, body: "", createdAt: 0, timeline: [], threads: [], checkRuns: [], commits: [], reviewers: [], viewerLogin: "me" };
    const items = sessionPrItems({ prs: [link(1)] }, null, new Map(), { [prKey(ref(1))]: detail });
    expect(items[0]).toMatchObject({ unseen: true, title: "PR 1", headSha: "sha-1" });
    expect(items[0].detail).toBe(detail);
  });

  it("falls back to the fallback chip for a linked PR with no known status", () => {
    const items = sessionPrItems({ prs: [link(7)] }, null, new Map(), {});
    expect(items[0]).toMatchObject({ title: null, unseen: false });
    expect(items[0].chip.label).toBe("#7");
  });
});

describe("sessionPrItemLabel and sessionPrItemsTitle", () => {
  it("labels with the title when known", () => {
    const items = sessionPrItems({ prs: [link(1), link(2)] }, null, lookup(summary(1)), {});
    expect(items.map(sessionPrItemLabel).sort()).toEqual(["#1 · PR 1", "#2"]);
  });

  it("joins every item chip", () => {
    const items = sessionPrItems({ prs: [link(1)] }, gitPr(18), lookup(summary(1, { review: "approved" })), {});
    expect(sessionPrItemsTitle(items)).toBe("#18 awaiting review · #1 approved");
  });
});
