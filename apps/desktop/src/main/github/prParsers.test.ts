import { describe, expect, it } from "vitest";
import type { PrSummary } from "@cw-code/contracts";
import { bucketFor, ciFromRollup, parseDetail, parseInbox, prKey, prRefFromUrl } from "./prParsers.js";

function rollupNode(state: string) {
  return { __typename: "CheckRun", conclusion: state };
}

function summaryNode(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    url: "https://github.com/acme/widgets/pull/1",
    title: "Base PR",
    state: "OPEN",
    isDraft: false,
    viewerDidAuthor: false,
    author: { login: "octocat", __typename: "User" },
    headRefName: "feature",
    headRefOid: "sha-1",
    baseRefName: "main",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    comments: { totalCount: 0 },
    reviewThreads: { nodes: [] },
    reviewDecision: null,
    mergeable: "MERGEABLE",
    labels: { nodes: [] },
    updatedAt: "2024-01-01T00:00:00Z",
    reviewRequests: { nodes: [] },
    ciCommits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
    ...overrides
  };
}

describe("parseInbox", () => {
  it("parses a bot author, a draft, a conflicting PR, and a failing rollup", () => {
    const json = JSON.stringify({
      data: {
        viewer: { login: "octocat" },
        search: {
          nodes: [
            summaryNode({
              number: 10,
              url: "https://github.com/acme/widgets/pull/10",
              author: { login: "dependabot", __typename: "Bot" },
              reviewRequests: { nodes: [{ requestedReviewer: { login: "octocat" } }] }
            }),
            summaryNode({
              number: 11,
              url: "https://github.com/acme/widgets/pull/11",
              isDraft: true,
              viewerDidAuthor: true
            }),
            summaryNode({
              number: 12,
              url: "https://github.com/acme/widgets/pull/12",
              viewerDidAuthor: true,
              mergeable: "CONFLICTING",
              reviewDecision: "APPROVED",
              ciCommits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [rollupNode("SUCCESS")] } } } }] }
            }),
            summaryNode({
              number: 13,
              url: "https://github.com/acme/widgets/pull/13",
              viewerDidAuthor: true,
              reviewDecision: "APPROVED",
              ciCommits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [rollupNode("FAILURE")] } } } }] }
            })
          ]
        }
      }
    });

    const result = parseInbox(json);
    expect(result.viewer).toBe("octocat");
    expect(result.items).toHaveLength(4);

    const bot = result.items.find((item) => item.ref.number === 10)!;
    expect(bot.author.isBot).toBe(true);
    expect(bot.reviewRequestedFromViewer).toBe(true);
    expect(bucketFor(bot)).toBe("review");

    const draft = result.items.find((item) => item.ref.number === 11)!;
    expect(draft.isDraft).toBe(true);

    const conflicting = result.items.find((item) => item.ref.number === 12)!;
    expect(conflicting.mergeable).toBe("CONFLICTING");
    expect(bucketFor(conflicting)).toBe("action");

    const failing = result.items.find((item) => item.ref.number === 13)!;
    expect(failing.ci).toBe("failing");
    expect(bucketFor(failing)).toBe("action");
  });

  it("returns an empty result for malformed JSON", () => {
    expect(parseInbox("not-json")).toEqual({ viewer: null, items: [] });
  });

  it("drops nodes whose url does not parse into a PR ref", () => {
    const json = JSON.stringify({
      data: { viewer: { login: "octocat" }, search: { nodes: [summaryNode({ url: "not-a-url" })] } }
    });
    expect(parseInbox(json).items).toHaveLength(0);
  });
});

describe("bucketFor", () => {
  const base: PrSummary = {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 },
    url: "https://github.com/acme/widgets/pull/1",
    title: "Base",
    state: "OPEN",
    isDraft: false,
    author: { login: "octocat", isBot: false },
    viewerIsAuthor: false,
    reviewRequestedFromViewer: false,
    headRefName: "feature",
    headRefOid: "sha-1",
    baseRefName: "main",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    commentsCount: 0,
    unresolvedThreads: 0,
    ci: "none",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    review: "none",
    mergeable: "MERGEABLE",
    labels: [],
    updatedAt: 0
  };

  it("is merged when state is MERGED regardless of other fields", () => {
    expect(bucketFor({ ...base, state: "MERGED", viewerIsAuthor: true, review: "approved", ci: "failing" })).toBe("merged");
  });

  it("is review when review is requested from a non-author viewer", () => {
    expect(bucketFor({ ...base, reviewRequestedFromViewer: true })).toBe("review");
  });

  it("is action when the author's PR has failing ci", () => {
    expect(bucketFor({ ...base, viewerIsAuthor: true, ci: "failing" })).toBe("action");
  });

  it("is action when the author's PR has changes requested", () => {
    expect(bucketFor({ ...base, viewerIsAuthor: true, review: "changes_requested" })).toBe("action");
  });

  it("is action when the author's PR is conflicting", () => {
    expect(bucketFor({ ...base, viewerIsAuthor: true, mergeable: "CONFLICTING" })).toBe("action");
  });

  it("is ready when the author's PR is approved and passing", () => {
    expect(bucketFor({ ...base, viewerIsAuthor: true, review: "approved", ci: "passing" })).toBe("ready");
  });

  it("is waiting otherwise", () => {
    expect(bucketFor({ ...base, viewerIsAuthor: true, review: "review_required", ci: "pending" })).toBe("waiting");
    expect(bucketFor(base)).toBe("waiting");
  });
});

describe("prRefFromUrl", () => {
  it("parses a github.com PR url", () => {
    expect(prRefFromUrl("https://github.com/acme/widgets/pull/42")).toEqual({ host: "github.com", owner: "acme", repo: "widgets", number: 42 });
  });

  it("parses a GitHub Enterprise host", () => {
    expect(prRefFromUrl("https://ghe.acme.internal/acme/widgets/pull/7")).toEqual({ host: "ghe.acme.internal", owner: "acme", repo: "widgets", number: 7 });
  });

  it("returns null for a non-PR url", () => {
    expect(prRefFromUrl("https://github.com/acme/widgets/issues/7")).toBeNull();
    expect(prRefFromUrl("not a url")).toBeNull();
  });
});

describe("prKey", () => {
  it("formats host/owner/repo#number", () => {
    expect(prKey({ host: "github.com", owner: "acme", repo: "widgets", number: 42 })).toBe("github.com/acme/widgets#42");
  });
});

describe("ciFromRollup", () => {
  it("returns none for an empty rollup", () => {
    expect(ciFromRollup([])).toEqual({ ci: "none", checks: { total: 0, passed: 0, failed: 0, pending: 0 } });
  });

  it("classifies success, failure, and pending states", () => {
    expect(ciFromRollup(["SUCCESS", "NEUTRAL", "SKIPPED"])).toEqual({ ci: "passing", checks: { total: 3, passed: 3, failed: 0, pending: 0 } });
    expect(ciFromRollup(["SUCCESS", "FAILURE"])).toEqual({ ci: "failing", checks: { total: 2, passed: 1, failed: 1, pending: 0 } });
    expect(ciFromRollup(["SUCCESS", "IN_PROGRESS"])).toEqual({ ci: "pending", checks: { total: 2, passed: 1, failed: 0, pending: 1 } });
  });
});

describe("parseDetail", () => {
  function detailJson(timelineNodes: Record<string, unknown>[], threadNodes: Record<string, unknown>[] = []) {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            ...summaryNode({ viewerDidAuthor: true }),
            body: "PR body",
            createdAt: "2024-01-01T00:00:00Z",
            timelineItems: { nodes: timelineNodes },
            threads: { nodes: threadNodes },
            latestReviews: { nodes: [{ author: { login: "bob" }, state: "APPROVED" }] },
            commits: { nodes: [] },
            checkRunCommits: { nodes: [{ commit: { checkSuites: { nodes: [] } } }] }
          }
        }
      }
    });
  }

  it("maps each timeline kind and drops an unknown kind", () => {
    const detail = parseDetail(detailJson([
      {
        __typename: "PullRequestCommit",
        commit: {
          oid: "sha-1",
          messageHeadline: "Fix bug",
          committedDate: "2024-01-02T00:00:00Z",
          author: { name: "Alice", user: { login: "alice" } },
          statusCheckRollup: { contexts: { nodes: [rollupNode("SUCCESS")] } }
        }
      },
      {
        __typename: "PullRequestReview",
        id: "review-1",
        state: "APPROVED",
        body: "LGTM",
        createdAt: "2024-01-03T00:00:00Z",
        author: { login: "bob" }
      },
      { __typename: "IssueComment", body: "Thanks!", createdAt: "2024-01-04T00:00:00Z", author: { login: "carol" } },
      { __typename: "ReviewRequestedEvent", createdAt: "2024-01-05T00:00:00Z", actor: { login: "dave" }, requestedReviewer: { login: "erin" } },
      { __typename: "MergedEvent", createdAt: "2024-01-06T00:00:00Z", actor: { login: "frank" } },
      { __typename: "SomeUnknownEvent", createdAt: "2024-01-07T00:00:00Z" }
    ], [
      {
        id: "thread-1",
        path: "src/app.ts",
        line: 10,
        isResolved: false,
        comments: { nodes: [{ author: { login: "bob" }, body: "fix this", createdAt: "2024-01-03T00:05:00Z", diffHunk: "@@ -1,1 +1,1 @@", pullRequestReview: { id: "review-1" } }] }
      }
    ]), "octocat")!;

    expect(detail).not.toBeNull();
    expect(detail.timeline.map((item) => item.kind)).toEqual(["commits", "review", "comment", "review_requested", "merged"]);

    const commitsItem = detail.timeline[0];
    if (commitsItem.kind !== "commits") throw new Error("expected commits item");
    expect(commitsItem.commits).toEqual([{ oid: "sha-1", headline: "Fix bug", author: "alice", committedAt: Date.parse("2024-01-02T00:00:00Z"), ci: "passing" }]);

    const reviewItem = detail.timeline[1];
    if (reviewItem.kind !== "review") throw new Error("expected review item");
    expect(reviewItem.threadIds).toEqual(["thread-1"]);
    expect(reviewItem.actor).toBe("bob");

    expect(detail.threads).toEqual([{
      id: "thread-1",
      path: "src/app.ts",
      line: 10,
      isResolved: false,
      diffHunk: "@@ -1,1 +1,1 @@",
      comments: [{ author: "bob", body: "fix this", createdAt: Date.parse("2024-01-03T00:05:00Z") }]
    }]);
    expect(detail.unresolvedThreads).toBe(1);
  });

  it("leaves threadIds empty when no thread references the review", () => {
    const detail = parseDetail(detailJson([
      { __typename: "PullRequestReview", id: "review-2", state: "COMMENTED", body: "", createdAt: "2024-01-03T00:00:00Z", author: { login: "bob" } }
    ]), "octocat")!;
    const reviewItem = detail.timeline[0];
    if (reviewItem.kind !== "review") throw new Error("expected review item");
    expect(reviewItem.threadIds).toEqual([]);
  });

  it("returns null for malformed JSON", () => {
    expect(parseDetail("not-json", "octocat")).toBeNull();
  });

  it("returns null when the pull request node is missing", () => {
    expect(parseDetail(JSON.stringify({ data: { repository: {} } }), "octocat")).toBeNull();
  });
});
