import { describe, expect, it } from "vitest";
import type { PrCheck, PrDetail, PrTimelineItem, SessionPrLink } from "@cw-code/contracts";
import { firstUnseenIndex, hasUnseen, updatesSince } from "./prUpdates.js";

function basePr(overrides: Partial<PrDetail> = {}): PrDetail {
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
    ci: "none",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    labels: [],
    updatedAt: 1_000,
    body: "",
    createdAt: 500,
    timeline: [],
    threads: [],
    checkRuns: [],
    commits: [],
    reviewers: [],
    ...overrides
  };
}

function baseLink(overrides: Partial<SessionPrLink> = {}): SessionPrLink {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    origin: "opened",
    lastSeenSha: "sha-1",
    lastSeenAt: 1_000,
    ...overrides
  };
}

describe("hasUnseen", () => {
  it("is false when the head sha matches and nothing updated since", () => {
    const pr = basePr({ headRefOid: "sha-1", updatedAt: 1_000 });
    expect(hasUnseen(pr, baseLink({ lastSeenSha: "sha-1", lastSeenAt: 1_000 }))).toBe(false);
  });

  it("is true when the head sha changed", () => {
    const pr = basePr({ headRefOid: "sha-2", updatedAt: 1_000 });
    expect(hasUnseen(pr, baseLink({ lastSeenSha: "sha-1", lastSeenAt: 1_000 }))).toBe(true);
  });

  it("is true when the sha matches but updatedAt is newer (a comment only)", () => {
    const pr = basePr({ headRefOid: "sha-1", updatedAt: 2_000 });
    expect(hasUnseen(pr, baseLink({ lastSeenSha: "sha-1", lastSeenAt: 1_000 }))).toBe(true);
  });

  it("ignores the head sha while the link has not recorded one yet", () => {
    const pr = basePr({ headRefOid: "sha-2", updatedAt: 500 });
    expect(hasUnseen(pr, baseLink({ lastSeenSha: "", lastSeenAt: 1_000 }))).toBe(false);
  });
});

describe("updatesSince", () => {
  it("returns nothing when there is no change since lastSeenAt", () => {
    const timeline: PrTimelineItem[] = [{ kind: "comment", at: 900, actor: "rcosta", body: "looks fine" }];
    const checkRuns: PrCheck[] = [{ name: "lint", workflow: "ci", status: "failure", url: null, runId: 1, completedAt: 900 }];
    const detail = basePr({ timeline, checkRuns, ci: "failing" });
    expect(updatesSince(detail, baseLink({ lastSeenAt: 1_000 }))).toEqual([]);
  });

  it("returns a commits update", () => {
    const timeline: PrTimelineItem[] = [
      {
        kind: "commits",
        at: 1_500,
        actor: "mbarros",
        commits: [
          { oid: "a", headline: "fix a", author: "mbarros", committedAt: 1_100, ci: "none" },
          { oid: "b", headline: "fix b", author: "mbarros", committedAt: 1_200, ci: "none" },
          { oid: "c", headline: "fix c", author: "mbarros", committedAt: 1_300, ci: "none" }
        ]
      }
    ];
    const detail = basePr({ timeline });
    expect(updatesSince(detail, baseLink())).toEqual([{ kind: "commits", at: 1_500, actor: "mbarros", summary: "mbarros pushed 3 commits" }]);
  });

  it("returns a review update with the count of unresolved threads it left", () => {
    const timeline: PrTimelineItem[] = [
      { kind: "review", at: 1_500, actor: "rcosta", state: "CHANGES_REQUESTED", body: "", threadIds: ["t1", "t2", "t3", "t4"] }
    ];
    const detail = basePr({
      timeline,
      threads: [
        { id: "t1", path: "a.ts", line: 1, isResolved: false, diffHunk: "", comments: [] },
        { id: "t2", path: "a.ts", line: 2, isResolved: false, diffHunk: "", comments: [] },
        { id: "t3", path: "a.ts", line: 3, isResolved: true, diffHunk: "", comments: [] },
        { id: "t4", path: "a.ts", line: 4, isResolved: false, diffHunk: "", comments: [] }
      ]
    });
    expect(updatesSince(detail, baseLink())).toEqual([
      { kind: "review", at: 1_500, actor: "rcosta", summary: "rcosta requested changes · 3 unresolved threads" }
    ]);
  });

  it("returns an approval without a thread count", () => {
    const timeline: PrTimelineItem[] = [{ kind: "review", at: 1_500, actor: "rcosta", state: "APPROVED", body: "", threadIds: [] }];
    const detail = basePr({ timeline });
    expect(updatesSince(detail, baseLink())).toEqual([{ kind: "review", at: 1_500, actor: "rcosta", summary: "rcosta approved" }]);
  });

  it("returns a comment update when only updatedAt advanced past lastSeenAt", () => {
    const timeline: PrTimelineItem[] = [{ kind: "comment", at: 1_500, actor: "rcosta", body: "one more thing" }];
    const detail = basePr({ timeline, headRefOid: "sha-1", updatedAt: 1_500 });
    const link = baseLink({ lastSeenSha: "sha-1", lastSeenAt: 1_000 });
    expect(hasUnseen(detail, link)).toBe(true);
    expect(updatesSince(detail, link)).toEqual([{ kind: "comment", at: 1_500, actor: "rcosta", summary: "rcosta commented" }]);
  });

  it("returns checks_failed with the single failing check's workflow and name", () => {
    const checkRuns: PrCheck[] = [{ name: "lint", workflow: "ci", status: "failure", url: null, runId: 1, completedAt: 1_500 }];
    const detail = basePr({ ci: "failing", checkRuns });
    expect(updatesSince(detail, baseLink())).toEqual([{ kind: "checks_failed", at: 1_500, actor: null, summary: "ci / lint failed" }]);
  });

  it("returns checks_failed naming every failing check when there is more than one", () => {
    const checkRuns: PrCheck[] = [
      { name: "lint", workflow: "ci", status: "failure", url: null, runId: 1, completedAt: 1_500 },
      { name: "test", workflow: "ci", status: "failure", url: null, runId: 2, completedAt: 1_600 }
    ];
    const detail = basePr({ ci: "failing", checkRuns });
    expect(updatesSince(detail, baseLink())).toEqual([{ kind: "checks_failed", at: 1_600, actor: null, summary: "2 checks failed: lint, test" }]);
  });

  it("returns checks_passed with the pass count once all checks are green", () => {
    const checkRuns: PrCheck[] = [{ name: "build", workflow: "ci", status: "success", url: null, runId: 1, completedAt: 1_500 }];
    const detail = basePr({ ci: "passing", checkRuns, checks: { total: 12, passed: 12, failed: 0, pending: 0 } });
    expect(updatesSince(detail, baseLink())).toEqual([{ kind: "checks_passed", at: 1_500, actor: null, summary: "Checks passed (12/12)" }]);
  });

  it("returns nothing when ci is failing but only a passing check completed since lastSeenAt", () => {
    const checkRuns: PrCheck[] = [
      { name: "lint", workflow: "ci", status: "failure", url: null, runId: 1, completedAt: 900 },
      { name: "build", workflow: "ci", status: "success", url: null, runId: 2, completedAt: 1_500 }
    ];
    const detail = basePr({ ci: "failing", checkRuns });
    expect(updatesSince(detail, baseLink())).toEqual([]);
  });

  it("names only the newly failing check when an older failure was already seen", () => {
    const checkRuns: PrCheck[] = [
      { name: "lint", workflow: "ci", status: "failure", url: null, runId: 1, completedAt: 900 },
      { name: "test", workflow: "ci", status: "failure", url: null, runId: 2, completedAt: 1_500 }
    ];
    const detail = basePr({ ci: "failing", checkRuns });
    expect(updatesSince(detail, baseLink())).toEqual([{ kind: "checks_failed", at: 1_500, actor: null, summary: "ci / test failed" }]);
  });

  it("re-requests your review when the requested reviewer already reviewed", () => {
    const timeline: PrTimelineItem[] = [{ kind: "review_requested", at: 1_500, actor: "mbarros", reviewer: "rcosta" }];
    const detail = basePr({
      timeline,
      reviewRequestedFromViewer: true,
      reviewers: [{ login: "rcosta", state: "CHANGES_REQUESTED" }]
    });
    expect(updatesSince(detail, baseLink())).toEqual([
      { kind: "review_requested", at: 1_500, actor: "mbarros", summary: "mbarros re-requested your review" }
    ]);
  });

  it("requests your review on a first-time request", () => {
    const timeline: PrTimelineItem[] = [{ kind: "review_requested", at: 1_500, actor: "mbarros", reviewer: "rcosta" }];
    const detail = basePr({
      timeline,
      reviewRequestedFromViewer: true,
      reviewers: [{ login: "rcosta", state: "PENDING" }]
    });
    expect(updatesSince(detail, baseLink())).toEqual([
      { kind: "review_requested", at: 1_500, actor: "mbarros", summary: "mbarros requested your review" }
    ]);
  });

  it("names the reviewer when the request does not target the viewer", () => {
    const timeline: PrTimelineItem[] = [{ kind: "review_requested", at: 1_500, actor: "mbarros", reviewer: "dcosta" }];
    const detail = basePr({
      timeline,
      reviewRequestedFromViewer: false,
      reviewers: [{ login: "dcosta", state: "PENDING" }]
    });
    expect(updatesSince(detail, baseLink())).toEqual([
      { kind: "review_requested", at: 1_500, actor: "mbarros", summary: "mbarros requested review from dcosta" }
    ]);
  });

  it("re-requests from a named reviewer who already reviewed and is not the viewer", () => {
    const timeline: PrTimelineItem[] = [{ kind: "review_requested", at: 1_500, actor: "mbarros", reviewer: "dcosta" }];
    const detail = basePr({
      timeline,
      reviewRequestedFromViewer: false,
      reviewers: [{ login: "dcosta", state: "APPROVED" }]
    });
    expect(updatesSince(detail, baseLink())).toEqual([
      { kind: "review_requested", at: 1_500, actor: "mbarros", summary: "mbarros re-requested review from dcosta" }
    ]);
  });

  it("sorts mixed updates newest first", () => {
    const timeline: PrTimelineItem[] = [
      { kind: "comment", at: 1_100, actor: "rcosta", body: "first" },
      { kind: "commits", at: 1_900, actor: "mbarros", commits: [{ oid: "a", headline: "fix", author: "mbarros", committedAt: 1_800, ci: "none" }] }
    ];
    const detail = basePr({ timeline });
    const updates = updatesSince(detail, baseLink());
    expect(updates.map((update) => update.at)).toEqual([1_900, 1_100]);
  });

  it("drops timeline kinds that have no matching update kind", () => {
    const timeline: PrTimelineItem[] = [{ kind: "merged", at: 1_500, actor: "mbarros" }];
    const detail = basePr({ timeline });
    expect(updatesSince(detail, baseLink())).toEqual([]);
  });

  it("reports new commits when the head moved but the pushed commits predate lastSeenAt", () => {
    const timeline: PrTimelineItem[] = [
      { kind: "commits", at: 900, actor: "mbarros", commits: [{ oid: "sha-2", headline: "fix", author: "mbarros", committedAt: 900, ci: "none" }] }
    ];
    const detail = basePr({ timeline, headRefOid: "sha-2", updatedAt: 1_200 });
    const link = baseLink({ lastSeenSha: "sha-1", lastSeenAt: 1_000 });
    expect(hasUnseen(detail, link)).toBe(true);
    expect(updatesSince(detail, link)).toEqual([
      { kind: "commits", at: 1_200, actor: null, summary: "New commits since the session last ran" }
    ]);
  });

  it("does not add a synthetic commits update when a real one exists", () => {
    const timeline: PrTimelineItem[] = [
      { kind: "commits", at: 1_500, actor: "mbarros", commits: [{ oid: "sha-2", headline: "fix", author: "mbarros", committedAt: 1_500, ci: "none" }] }
    ];
    const detail = basePr({ timeline, headRefOid: "sha-2" });
    expect(updatesSince(detail, baseLink()).map((update) => update.summary)).toEqual(["mbarros pushed 1 commit"]);
  });

  it("reports a generic update when the PR changed without a timeline item", () => {
    const detail = basePr({ updatedAt: 2_000 });
    const link = baseLink();
    expect(hasUnseen(detail, link)).toBe(true);
    expect(updatesSince(detail, link)).toEqual([{ kind: "comment", at: 2_000, actor: null, summary: "PR updated" }]);
  });
});

describe("firstUnseenIndex", () => {
  it("returns the index of the first item after lastSeenAt", () => {
    const timeline: PrTimelineItem[] = [
      { kind: "comment", at: 900, actor: "rcosta", body: "old" },
      { kind: "comment", at: 1_100, actor: "rcosta", body: "new" },
      { kind: "comment", at: 1_200, actor: "rcosta", body: "newer" }
    ];
    expect(firstUnseenIndex(timeline, 1_000)).toBe(1);
  });

  it("returns -1 when nothing is unseen", () => {
    const timeline: PrTimelineItem[] = [{ kind: "comment", at: 900, actor: "rcosta", body: "old" }];
    expect(firstUnseenIndex(timeline, 1_000)).toBe(-1);
  });
});
