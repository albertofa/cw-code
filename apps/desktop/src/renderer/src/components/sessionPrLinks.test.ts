import { describe, expect, it } from "vitest";
import type { GitPullRequest, PrRef, PrSummary, SessionPrLink } from "@cw-code/contracts";
import { prKey } from "./prInbox.js";
import {
  anyLinkUnseen,
  displayChip,
  linkFor,
  linksTitle,
  mostUrgentLink,
  pickMainSession,
  prRefFromUrl,
  prSummaryLookup,
  sessionLinks,
  sessionsLinkedTo
} from "./sessionPrLinks.js";

function ref(number: number, repo = "widgets"): PrRef {
  return { host: "github.com", owner: "acme", repo, number };
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
    updatedAt: 500,
    ...overrides
  };
}

function lookup(...items: PrSummary[]): Map<string, PrSummary> {
  return new Map(items.map((item) => [prKey(item.ref), item]));
}

function gitPr(overrides: Partial<GitPullRequest> = {}): GitPullRequest {
  return {
    number: 9,
    title: "Local",
    url: "https://github.com/acme/widgets/pull/9",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: null,
    headRefName: "feature/9",
    baseRefName: "main",
    checks: { total: 1, passed: 0, failed: 1, pending: 0 },
    ...overrides
  };
}

describe("session link lookups", () => {
  it("returns a stable empty list for sessions without links", () => {
    expect(sessionLinks({})).toEqual([]);
    expect(sessionLinks({})).toBe(sessionLinks(undefined));
  });

  it("finds the link for a ref by value and lists sessions linked to it", () => {
    const a = { id: "a", prs: [link(1), link(2)] };
    const b = { id: "b", prs: [link(2)] };
    const c: { id: string; prs?: SessionPrLink[] } = { id: "c" };
    expect(linkFor(a, ref(2))).toBe(a.prs[1]);
    expect(linkFor(a, ref(2, "gadgets"))).toBeUndefined();
    expect(sessionsLinkedTo([a, b, c], ref(2)).map((s) => s.id)).toEqual(["a", "b"]);
    expect(sessionsLinkedTo([a, b, c], ref(1)).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("mostUrgentLink", () => {
  it("returns null without links", () => {
    expect(mostUrgentLink([], lookup())).toBeNull();
  });

  it("ranks failing and changes requested above review requested, awaiting, draft, approved and merged", () => {
    const summaries = lookup(
      summary(1, { state: "MERGED" }),
      summary(2, { review: "approved" }),
      summary(3, { isDraft: true }),
      summary(4),
      summary(5, { viewerIsAuthor: false, reviewRequestedFromViewer: true }),
      summary(6, { ci: "failing" })
    );
    const links = [1, 2, 3, 4, 5, 6].map((n) => link(n));
    expect(mostUrgentLink(links, summaries)?.ref.number).toBe(6);
    expect(mostUrgentLink(links.slice(0, 5), summaries)?.ref.number).toBe(5);
    expect(mostUrgentLink(links.slice(0, 4), summaries)?.ref.number).toBe(4);
    expect(mostUrgentLink(links.slice(0, 3), summaries)?.ref.number).toBe(3);
    expect(mostUrgentLink(links.slice(0, 2), summaries)?.ref.number).toBe(2);
    expect(mostUrgentLink(links.slice(0, 1), summaries)?.ref.number).toBe(1);
  });

  it("treats changes requested as bad and closed as finished", () => {
    const summaries = lookup(summary(1, { state: "CLOSED" }), summary(2, { review: "changes_requested" }), summary(3, { review: "approved" }));
    expect(mostUrgentLink([link(1), link(3), link(2)], summaries)?.ref.number).toBe(2);
    expect(mostUrgentLink([link(1), link(3)], summaries)?.ref.number).toBe(3);
  });

  it("breaks ties with the most recently updated summary", () => {
    const summaries = lookup(summary(1, { ci: "failing", updatedAt: 100 }), summary(2, { review: "changes_requested", updatedAt: 900 }));
    expect(mostUrgentLink([link(1), link(2)], summaries)?.ref.number).toBe(2);
  });

  it("uses the git pull request only for the link whose URL matches", () => {
    const summaries = lookup(summary(1, { review: "approved" }));
    expect(mostUrgentLink([link(1), link(9)], summaries, gitPr())?.ref.number).toBe(9);
    const otherRepo = gitPr({ url: "https://github.com/acme/gadgets/pull/9" });
    expect(mostUrgentLink([link(1), link(9)], summaries, otherRepo)?.ref.number).toBe(1);
  });
});

describe("chip data sources", () => {
  it("parses pull request URLs into refs", () => {
    expect(prRefFromUrl("https://GitHub.com/acme/widgets/pull/12/files")).toEqual(ref(12));
    expect(prRefFromUrl("https://github.com/acme/widgets/issues/12")).toBeNull();
    expect(prRefFromUrl("https://github.com/acme/widgets/pull/0")).toBeNull();
  });

  it("falls back to a neutral chip when no status is known", () => {
    expect(displayChip(link(5), lookup())).toEqual({
      tone: "neutral",
      icon: "pr",
      label: "#5",
      reason: "status not loaded",
      title: "PR #5"
    });
    expect(displayChip(link(5), lookup(summary(5, { ci: "failing" })))).toMatchObject({ tone: "bad", label: "#5" });
  });

  it("prefers the inbox summary over a cached detail for the same pull request", () => {
    const inbox = summary(1, { title: "from inbox" });
    const detail = { ...summary(1, { title: "from detail" }), body: "", createdAt: 0, timeline: [], threads: [], checkRuns: [], commits: [], reviewers: [], viewerLogin: "" };
    const onlyDetail = { ...detail, ref: ref(2), title: "detail only" };
    const byKey = prSummaryLookup([inbox], { [prKey(detail.ref)]: detail, [prKey(onlyDetail.ref)]: onlyDetail });
    expect(byKey.get(prKey(ref(1)))?.title).toBe("from inbox");
    expect(byKey.get(prKey(ref(2)))?.title).toBe("detail only");
  });
});

describe("link titles and unseen state", () => {
  it("lists every linked pull request with its reason", () => {
    const summaries = lookup(summary(207, { ci: "failing" }), summary(212, { viewerIsAuthor: false, reviewRequestedFromViewer: true }));
    expect(linksTitle([link(207), link(212), link(300)], summaries)).toBe("#207 checks failing · #212 review requested · #300");
  });

  it("reports unseen when any link has updates", () => {
    const summaries = lookup(summary(1), summary(2, { headRefOid: "sha-new" }));
    expect(anyLinkUnseen([link(1)], summaries)).toBe(false);
    expect(anyLinkUnseen([link(1), link(2)], summaries)).toBe(true);
    expect(anyLinkUnseen([link(3)], summaries)).toBe(false);
  });
});

describe("pickMainSession", () => {
  it("prefers the session that opened this pull request, then a review workflow, then the latest", () => {
    const opened = { id: "opened", updatedAt: 1, prs: [link(1, { origin: "opened" }), link(2)] };
    const review = { id: "review", updatedAt: 2, prs: [link(2, { origin: "workflow", workflowId: "review" }), link(1)] };
    const latest = { id: "latest", updatedAt: 9, prs: [link(1), link(2), link(3)] };
    const sessions = [latest, review, opened];
    expect(pickMainSession(sessions, ref(1))?.id).toBe("opened");
    expect(pickMainSession(sessions, ref(2))?.id).toBe("review");
    expect(pickMainSession(sessions, ref(3))?.id).toBe("latest");
    expect(pickMainSession(sessions, ref(4))).toBeNull();
  });
});
