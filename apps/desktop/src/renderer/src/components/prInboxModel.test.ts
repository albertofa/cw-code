import { describe, expect, it } from "vitest";
import type { PrRef, PrSummary, Session } from "../cw.js";
import {
  BUCKET_ORDER,
  buildInboxRows,
  filterCounts,
  formatRelativeAge,
  groupRowsByBucket,
  matchesFilter,
  rowDeltaText
} from "./prInboxModel.js";

function ref(overrides: Partial<PrRef> = {}): PrRef {
  return { host: "github.com", owner: "acme", repo: "widgets", number: 42, ...overrides };
}

function summary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: ref(),
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

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    driver: "claude",
    title: "Session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 500,
    ...overrides
  };
}

describe("buildInboxRows", () => {
  it("links sessions by matching prKey and flags unseen sessions", () => {
    const pr = summary({ headRefOid: "sha-2", review: "approved" });
    const linked = session({
      id: "s1",
      prs: [{ ref: ref(), origin: "opened", lastSeenSha: "sha-1", lastSeenAt: 0 }]
    });
    const other = session({ id: "s2", prs: [{ ref: ref({ number: 7 }), origin: "linked", lastSeenSha: "x", lastSeenAt: 0 }] });

    const [row] = buildInboxRows([pr], [linked, other], () => true);

    expect(row.linkedSessions.map((s) => s.id)).toEqual(["s1"]);
    expect(row.hasUnseenSession).toBe(true);
    expect(row.bucket).toBe("ready");
    expect(row.cloned).toBe(true);
  });

  it("marks a PR unseen-free when the linked session already saw the current head", () => {
    const pr = summary({ headRefOid: "sha-1", updatedAt: 100 });
    const linked = session({ prs: [{ ref: ref(), origin: "opened", lastSeenSha: "sha-1", lastSeenAt: 200 }] });

    const [row] = buildInboxRows([pr], [linked], () => false);

    expect(row.hasUnseenSession).toBe(false);
    expect(row.cloned).toBe(false);
  });

  it("uses the link for this PR when a session is linked to several PRs", () => {
    const first = summary({ headRefOid: "sha-1", updatedAt: 100 });
    const second = summary({ ref: ref({ number: 7 }), headRefOid: "sha-7b", updatedAt: 100 });
    const multi = session({
      id: "multi",
      prs: [
        { ref: ref(), origin: "opened", lastSeenSha: "sha-1", lastSeenAt: 200 },
        { ref: ref({ number: 7 }), origin: "linked", lastSeenSha: "sha-7a", lastSeenAt: 200 }
      ]
    });

    const [firstRow, secondRow] = buildInboxRows([first, second], [multi], () => true);

    expect(firstRow.linkedSessions.map((s) => s.id)).toEqual(["multi"]);
    expect(firstRow.hasUnseenSession).toBe(false);
    expect(secondRow.linkedSessions.map((s) => s.id)).toEqual(["multi"]);
    expect(secondRow.hasUnseenSession).toBe(true);
    expect(rowDeltaText(secondRow, 1_000)).toBe("new commits");
  });

  it("ignores sessions linked to a different PR", () => {
    const pr = summary();
    const unrelated = session({ prs: [{ ref: ref({ number: 99 }), origin: "opened", lastSeenSha: "x", lastSeenAt: 0 }] });

    const [row] = buildInboxRows([pr], [unrelated], () => false);

    expect(row.linkedSessions).toHaveLength(0);
  });
});

describe("matchesFilter / filterCounts", () => {
  const reviewRow = buildInboxRows(
    [summary({ viewerIsAuthor: false, reviewRequestedFromViewer: true })],
    [],
    () => true
  )[0];
  const actionRow = buildInboxRows(
    [summary({ viewerIsAuthor: true, ci: "failing", ref: ref({ number: 2 }) })],
    [],
    () => false
  )[0];

  it("all matches everything", () => {
    expect(matchesFilter(reviewRow, "all")).toBe(true);
    expect(matchesFilter(actionRow, "all")).toBe(true);
  });

  it("filters by bucket", () => {
    expect(matchesFilter(reviewRow, "review")).toBe(true);
    expect(matchesFilter(reviewRow, "action")).toBe(false);
    expect(matchesFilter(actionRow, "action")).toBe(true);
  });

  it("filters by cloned state", () => {
    expect(matchesFilter(reviewRow, "not-cloned")).toBe(false);
    expect(matchesFilter(actionRow, "not-cloned")).toBe(true);
  });

  it("counts rows per filter", () => {
    const counts = filterCounts([reviewRow, actionRow]);
    expect(counts.all).toBe(2);
    expect(counts.review).toBe(1);
    expect(counts.action).toBe(1);
    expect(counts["not-cloned"]).toBe(1);
    expect(counts["with-session"]).toBe(0);
    expect(counts.updated).toBe(0);
  });
});

describe("groupRowsByBucket", () => {
  it("orders groups review, action, ready, waiting, merged and drops empty ones", () => {
    const merged = buildInboxRows([summary({ state: "MERGED", ref: ref({ number: 3 }) })], [], () => true)[0];
    const review = buildInboxRows(
      [summary({ viewerIsAuthor: false, reviewRequestedFromViewer: true, ref: ref({ number: 4 }) })],
      [],
      () => true
    )[0];

    const groups = groupRowsByBucket([merged, review]);

    expect(groups.map((g) => g.bucket)).toEqual(["review", "merged"]);
    expect(BUCKET_ORDER.indexOf("review")).toBeLessThan(BUCKET_ORDER.indexOf("merged"));
  });

  it("returns nothing for an empty row list", () => {
    expect(groupRowsByBucket([])).toEqual([]);
  });
});

describe("rowDeltaText", () => {
  it("returns null when the row has no unseen session", () => {
    const pr = summary({ headRefOid: "sha-1", updatedAt: 100 });
    const linked = session({ prs: [{ ref: ref(), origin: "opened", lastSeenSha: "sha-1", lastSeenAt: 200 }] });
    const [row] = buildInboxRows([pr], [linked], () => true);

    expect(rowDeltaText(row, 500)).toBeNull();
  });

  it("returns null when no linked session carries a pr link", () => {
    const pr = summary({ headRefOid: "sha-2" });
    const row = { pr, bucket: "waiting" as const, linkedSessions: [session({ prs: undefined })], hasUnseenSession: true, cloned: true };

    expect(rowDeltaText(row, 500)).toBeNull();
  });

  it("reports new commits when the main session's last-seen sha is behind the PR head", () => {
    const pr = summary({ headRefOid: "sha-2" });
    const linked = session({
      id: "s1",
      prs: [{ ref: ref(), origin: "opened", lastSeenSha: "sha-1", lastSeenAt: 0 }]
    });
    const [row] = buildInboxRows([pr], [linked], () => true);

    expect(rowDeltaText(row, 1_000)).toBe("new commits");
  });

  it("reports the relative update age when the sha matches but the PR updated later", () => {
    const pr = summary({ headRefOid: "sha-1", updatedAt: 60_000 });
    const linked = session({
      id: "s1",
      prs: [{ ref: ref(), origin: "opened", lastSeenSha: "sha-1", lastSeenAt: 0 }]
    });
    const [row] = buildInboxRows([pr], [linked], () => true);

    expect(rowDeltaText(row, 120_000)).toBe("updated 1m");
  });

  it("reports the relative update age instead of new commits when the last-seen sha is unknown", () => {
    const pr = summary({ headRefOid: "sha-2", updatedAt: 60_000 });
    const linked = session({
      id: "s1",
      prs: [{ ref: ref(), origin: "opened", lastSeenSha: "", lastSeenAt: 0 }]
    });
    const [row] = buildInboxRows([pr], [linked], () => true);

    expect(rowDeltaText(row, 120_000)).toBe("updated 1m");
  });

  it("prefers the session that opened the PR over a more recently active one", () => {
    const pr = summary({ headRefOid: "sha-2" });
    const opener = session({
      id: "s1",
      updatedAt: 10,
      prs: [{ ref: ref(), origin: "opened", lastSeenSha: "sha-1", lastSeenAt: 0 }]
    });
    const active = session({
      id: "s2",
      updatedAt: 9_999,
      prs: [{ ref: ref(), origin: "linked", lastSeenSha: "sha-2", lastSeenAt: 0 }]
    });
    const [row] = buildInboxRows([pr], [opener, active], () => true);

    expect(rowDeltaText(row, 1_000)).toBe("new commits");
  });
});

describe("formatRelativeAge", () => {
  it("formats seconds", () => {
    expect(formatRelativeAge(1_000, 1_000)).toBe("0s");
    expect(formatRelativeAge(1_000, 41_000)).toBe("40s");
  });

  it("formats minutes once past 60 seconds", () => {
    expect(formatRelativeAge(0, 60_000)).toBe("1m");
    expect(formatRelativeAge(0, 12 * 60_000)).toBe("12m");
  });

  it("formats hours once past 60 minutes", () => {
    expect(formatRelativeAge(0, 60 * 60_000)).toBe("1h");
    expect(formatRelativeAge(0, 5 * 60 * 60_000)).toBe("5h");
  });

  it("formats days then weeks", () => {
    expect(formatRelativeAge(0, 24 * 60 * 60_000)).toBe("1d");
    expect(formatRelativeAge(0, 9 * 24 * 60 * 60_000)).toBe("1w");
  });
});
