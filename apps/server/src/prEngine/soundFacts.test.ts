import { describe, expect, it } from "bun:test";
import type { PrDetail, PrSummary, PrTimelineItem, SessionMeta, SessionPrLink, SessionStatus } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { latestUnseenPrUpdateAt } from "./soundFacts.js";

describe("latestUnseenPrUpdateAt", () => {
  const ref = { host: "github.com", owner: "acme", repo: "widgets", number: 1 };
  const link: SessionPrLink = { ref, origin: "linked", lastSeenSha: "sha-1", lastSeenAt: 1_000 };
  const session = (status: SessionStatus = "idle"): SessionMeta => ({
    id: "s",
    projectId: "p",
    driver: "claude",
    title: "Session",
    status,
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    prs: [link]
  });
  const summary = (updatedAt: number): PrSummary => ({
    ref,
    url: "https://github.com/acme/widgets/pull/1",
    title: "PR 1",
    state: "OPEN",
    isDraft: false,
    author: { login: "mbarros", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: "feature/1",
    headRefOid: "sha-1",
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "none",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt
  });
  const detail = (pr: PrSummary, timeline: PrTimelineItem[]): PrDetail => ({
    ...pr,
    body: "",
    createdAt: 0,
    timeline,
    threads: [],
    checkRuns: [],
    commits: [],
    reviewers: [],
    viewerLogin: "me"
  });

  it("returns the newest unseen update from a current detail", () => {
    const pr = summary(2_500);
    const lookup = new Map([[prKey(ref), pr]]);
    const current = detail(pr, [
      { kind: "comment", at: 2_000, actor: "rcosta", body: "" },
      { kind: "comment", at: 2_500, actor: "rcosta", body: "" }
    ]);
    expect(latestUnseenPrUpdateAt(session(), lookup, { [prKey(ref)]: current })).toBe(2_500);
  });

  it("waits for a current detail before reporting anything", () => {
    const pr = summary(3_000);
    const stale = detail(summary(2_000), [{ kind: "comment", at: 2_000, actor: "rcosta", body: "" }]);
    const lookup = new Map([[prKey(ref), pr]]);
    expect(latestUnseenPrUpdateAt(session(), lookup, {})).toBeNull();
    expect(latestUnseenPrUpdateAt(session(), lookup, { [prKey(ref)]: stale })).toBeNull();
  });

  it("ignores the viewer's own activity", () => {
    const pr = summary(2_000);
    const own = detail(pr, [{ kind: "comment", at: 2_000, actor: "me", body: "" }]);
    expect(latestUnseenPrUpdateAt(session(), new Map([[prKey(ref), pr]]), { [prKey(ref)]: own })).toBeNull();
  });
});
