import { describe, expect, it } from "vitest";
import type { PrSummary } from "@cw-code/contracts";
import { actorLoginOf, bucketFor, ciFromRollup, graphqlOutcome, graphqlPartialFailure, parseDetail, parseHead, parseInbox, parsePrSearch, parseTrackedPrs, prKey, prRefFromUrl, withBotSuffix } from "./prParsers.js";

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
    mergeStateStatus: "CLEAN",
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
              mergeStateStatus: "SOMETHING_NEW",
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
    expect(bot.author).toEqual({ login: "dependabot[bot]", isBot: true });
    expect(bot.reviewRequestedFromViewer).toBe(true);
    expect(bucketFor(bot)).toBe("review");

    const draft = result.items.find((item) => item.ref.number === 11)!;
    expect(draft.isDraft).toBe(true);

    const conflicting = result.items.find((item) => item.ref.number === 12)!;
    expect(conflicting.mergeable).toBe("CONFLICTING");
    expect(conflicting.mergeStateStatus).toBe("UNKNOWN");
    expect(result.items.find((item) => item.ref.number === 13)?.mergeStateStatus).toBe("CLEAN");
    expect(bucketFor(conflicting)).toBe("action");

    const failing = result.items.find((item) => item.ref.number === 13)!;
    expect(failing.ci).toBe("failing");
    expect(bucketFor(failing)).toBe("action");
  });

  it("maps the author name and avatar url", () => {
    const json = JSON.stringify({
      data: {
        viewer: { login: "octocat" },
        search: {
          nodes: [summaryNode({ author: { login: "octocat", __typename: "User", name: "The Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/1?s=48" } })]
        }
      }
    });
    expect(parseInbox(json).items[0].author).toEqual({
      login: "octocat",
      isBot: false,
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?s=48"
    });
  });

  it("collects avatar urls for the author, reviewers and assignees by lowercased login", () => {
    const json = JSON.stringify({
      data: {
        viewer: null,
        search: {
          nodes: [
            summaryNode({
              author: { login: "Octocat", __typename: "User", avatarUrl: "https://a.test/author" },
              reviewRequests: { nodes: [{ requestedReviewer: { login: "Pending", avatarUrl: "https://a.test/pending" } }, { requestedReviewer: {} }] },
              latestReviews: {
                nodes: [
                  { author: { login: "copilot", __typename: "Bot", avatarUrl: "https://a.test/bot" }, state: "COMMENTED" },
                  { author: { login: "mallory", __typename: "User", avatarUrl: "http://a.test/insecure" }, state: "APPROVED" }
                ]
              },
              assignees: { nodes: [{ login: "helper", avatarUrl: "https://a.test/helper" }] }
            })
          ]
        }
      }
    });
    expect(parseInbox(json).items[0].avatarUrls).toEqual({
      octocat: "https://a.test/author",
      pending: "https://a.test/pending",
      "copilot[bot]": "https://a.test/bot",
      helper: "https://a.test/helper"
    });
  });

  it("parses a bot author without a name", () => {
    const json = JSON.stringify({
      data: {
        viewer: null,
        search: {
          nodes: [summaryNode({ author: { login: "renovate", __typename: "Bot", avatarUrl: "https://avatars.githubusercontent.com/in/2?s=48" } })]
        }
      }
    });
    const author = parseInbox(json).items[0].author;
    expect(author.isBot).toBe(true);
    expect(author.name).toBeUndefined();
    expect(author.avatarUrl).toBe("https://avatars.githubusercontent.com/in/2?s=48");
  });

  it("leaves avatarUrl and name unset when missing, blank or not https", () => {
    const json = JSON.stringify({
      data: {
        viewer: null,
        search: {
          nodes: [
            summaryNode({ author: { login: "octocat", __typename: "User", name: "  " } }),
            summaryNode({
              number: 2,
              url: "https://github.com/acme/widgets/pull/2",
              author: { login: "mallory", __typename: "User", avatarUrl: "http://example.test/a.png" }
            })
          ]
        }
      }
    });
    const [blank, insecure] = parseInbox(json).items;
    expect(blank.author).toEqual({ login: "octocat", isBot: false });
    expect(insecure.author).toEqual({ login: "mallory", isBot: false });
  });

  it("returns an empty result for malformed JSON", () => {
    expect(parseInbox("not-json")).toEqual({ viewer: null, items: [], truncated: false });
  });

  it("flags a search that returned a full page as truncated", () => {
    const nodes = Array.from({ length: 50 }, (_, index) =>
      summaryNode({ number: index + 1, url: `https://github.com/acme/widgets/pull/${index + 1}` })
    );
    const full = JSON.stringify({ data: { viewer: { login: "octocat" }, search: { nodes } } });
    const partial = JSON.stringify({ data: { viewer: { login: "octocat" }, search: { nodes: nodes.slice(0, 49) } } });
    expect(parseInbox(full).truncated).toBe(true);
    expect(parseInbox(partial).truncated).toBe(false);
  });

  it("drops nodes whose url does not parse into a PR ref", () => {
    const json = JSON.stringify({
      data: { viewer: { login: "octocat" }, search: { nodes: [summaryNode({ url: "not-a-url" })] } }
    });
    expect(parseInbox(json).items).toHaveLength(0);
  });
});

describe("reviewers and assignees", () => {
  function parseOne(overrides: Record<string, unknown>) {
    const json = JSON.stringify({ data: { viewer: { login: "octocat" }, search: { nodes: [summaryNode(overrides)] } } });
    return parseInbox(json).items[0];
  }

  it("merges latest reviews with pending requests, pending only for logins without a review", () => {
    const pr = parseOne({
      latestReviews: {
        nodes: [
          { author: { login: "bob" }, state: "APPROVED" },
          { author: { login: "carol" }, state: "CHANGES_REQUESTED" }
        ]
      },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "carol" } }, { requestedReviewer: { login: "dave" } }, { requestedReviewer: {} }] }
    });
    expect(pr.reviewers).toEqual([
      { login: "bob", state: "APPROVED" },
      { login: "carol", state: "CHANGES_REQUESTED" },
      { login: "dave", state: "PENDING" }
    ]);
  });

  it("drops dismissed and unknown review states and reviews without an author", () => {
    const pr = parseOne({
      latestReviews: {
        nodes: [
          { author: { login: "bob" }, state: "DISMISSED" },
          { author: { login: "carol" }, state: "WHATEVER" },
          { author: null, state: "APPROVED" }
        ]
      }
    });
    expect(pr.reviewers).toEqual([]);
  });

  it("keeps a dismissed reviewer as PENDING only when a review is requested again", () => {
    const pr = parseOne({
      latestReviews: { nodes: [{ author: { login: "bob" }, state: "DISMISSED" }] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "bob" } }] }
    });
    expect(pr.reviewers).toEqual([{ login: "bob", state: "PENDING" }]);
  });

  it("suffixes bot reviewers with [bot] like GitHub logins", () => {
    const pr = parseOne({
      latestReviews: {
        nodes: [
          { author: { login: "copilot-pull-request-reviewer", __typename: "Bot" }, state: "COMMENTED" },
          { author: { login: "bob", __typename: "User" }, state: "APPROVED" }
        ]
      }
    });
    expect(pr.reviewers).toEqual([
      { login: "copilot-pull-request-reviewer[bot]", state: "COMMENTED" },
      { login: "bob", state: "APPROVED" }
    ]);
  });

  it("parses assignees and tolerates their absence", () => {
    expect(parseOne({ assignees: { nodes: [{ login: "alice" }, { login: "bob" }, {}] } }).assignees).toEqual(["alice", "bob"]);
    expect(parseOne({}).assignees).toEqual([]);
    expect(parseOne({}).reviewers).toEqual([]);
  });
});

describe("parsePrSearch", () => {
  function searchJson(nodes: unknown[], issueCount: number | null) {
    return JSON.stringify({
      data: {
        viewer: { login: "octocat" },
        results: issueCount === null ? { nodes } : { issueCount, nodes },
        open: { issueCount: 7 },
        closed: { issueCount: 3 }
      }
    });
  }

  it("parses items, counts and the viewer", () => {
    const result = parsePrSearch(searchJson([summaryNode()], 1));
    expect(result.viewer).toBe("octocat");
    expect(result.items).toHaveLength(1);
    expect(result.openCount).toBe(7);
    expect(result.closedCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("flags truncation when the total exceeds the returned page", () => {
    expect(parsePrSearch(searchJson([summaryNode()], 80)).truncated).toBe(true);
  });

  it("falls back to the page size when the total is missing", () => {
    const nodes = Array.from({ length: 50 }, (_, index) => summaryNode({ number: index + 1, url: `https://github.com/acme/widgets/pull/${index + 1}` }));
    expect(parsePrSearch(searchJson(nodes, null)).truncated).toBe(true);
    expect(parsePrSearch(searchJson(nodes.slice(0, 3), null)).truncated).toBe(false);
  });

  it("returns null counts when the aliases are missing and an empty result for malformed JSON", () => {
    const missing = parsePrSearch(JSON.stringify({ data: { viewer: { login: "octocat" }, results: { nodes: [] } } }));
    expect(missing.openCount).toBeNull();
    expect(missing.closedCount).toBeNull();
    expect(parsePrSearch("not-json")).toEqual({ viewer: null, items: [], openCount: null, closedCount: null, truncated: false });
  });
});

describe("graphqlOutcome", () => {
  it("reports data presence and the first error message", () => {
    expect(graphqlOutcome(JSON.stringify({ data: { r0: null }, errors: [{ message: "Could not resolve" }] }))).toEqual({
      hasData: true,
      message: "Could not resolve"
    });
    expect(graphqlOutcome(JSON.stringify({ errors: [{ message: "Bad credentials" }] }))).toEqual({ hasData: false, message: "Bad credentials" });
    expect(graphqlOutcome("garbage")).toEqual({ hasData: false, message: null });
  });
});

describe("graphqlPartialFailure", () => {
  it("describes errors that arrive together with data, labelled by subject", () => {
    const partial = JSON.stringify({ data: { r0: null }, errors: [{ message: "Could not resolve to a Repository" }] });
    expect(graphqlPartialFailure(partial, "sources")).toBe("Some sources failed: Could not resolve to a Repository");
    expect(graphqlPartialFailure(partial, "results")).toBe("Some results failed: Could not resolve to a Repository");
  });

  it("is null for clean responses and for responses without data", () => {
    expect(graphqlPartialFailure(JSON.stringify({ data: { r0: {} } }), "sources")).toBeNull();
    expect(graphqlPartialFailure(JSON.stringify({ errors: [{ message: "Bad credentials" }] }), "sources")).toBeNull();
    expect(graphqlPartialFailure("garbage", "results")).toBeNull();
  });
});

describe("bot logins", () => {
  it("suffixes Bot actors once and leaves users untouched", () => {
    expect(actorLoginOf({ login: "dependabot", __typename: "Bot" })).toEqual({ login: "dependabot[bot]", isBot: true });
    expect(actorLoginOf({ login: "octocat", __typename: "User" })).toEqual({ login: "octocat", isBot: false });
    expect(actorLoginOf(null)).toEqual({ login: "", isBot: false });
    expect(withBotSuffix("renovate[bot]")).toBe("renovate[bot]");
    expect(withBotSuffix("")).toBe("");
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
    mergeStateStatus: "CLEAN",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 0
  };

  it("is closed when state is CLOSED regardless of other fields", () => {
    expect(bucketFor({ ...base, state: "CLOSED", viewerIsAuthor: true, ci: "failing" })).toBe("closed");
    expect(bucketFor({ ...base, state: "CLOSED", reviewRequestedFromViewer: true })).toBe("closed");
  });

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

describe("parseHead", () => {
  it("extracts the head sha and state", () => {
    const json = JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "sha-1", state: "MERGED" } } } });
    expect(parseHead(json)).toEqual({ headRefOid: "sha-1", state: "MERGED", updatedAt: null });
  });

  it("extracts the updatedAt timestamp", () => {
    const json = JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "sha-1", state: "OPEN", updatedAt: "2026-09-24T18:06:56Z" } } } });
    expect(parseHead(json).updatedAt).toBe(Date.parse("2026-09-24T18:06:56Z"));
  });

  it("returns nulls when the head sha and state are missing or unknown", () => {
    expect(parseHead(JSON.stringify({ data: { repository: { pullRequest: {} } } }))).toEqual({ headRefOid: null, state: null, updatedAt: null });
    expect(parseHead(JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "sha-1", state: "DRAFT" } } } }))).toEqual({
      headRefOid: "sha-1",
      state: null,
      updatedAt: null
    });
  });

  it("returns nulls for malformed JSON", () => {
    expect(parseHead("not-json")).toEqual({ headRefOid: null, state: null, updatedAt: null });
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
          author: { name: "Alice", avatarUrl: "https://avatars.githubusercontent.com/u/7?s=48", user: { login: "alice" } },
          statusCheckRollup: { contexts: { nodes: [rollupNode("SUCCESS")] } }
        }
      },
      {
        __typename: "PullRequestCommit",
        commit: {
          oid: "sha-2",
          messageHeadline: "Tidy up",
          committedDate: "2024-01-02T01:00:00Z",
          author: { name: "Alice", avatarUrl: "http://example.test/a.png", user: { login: "alice" } }
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
    expect(commitsItem.commits).toEqual([
      { oid: "sha-1", headline: "Fix bug", author: "alice", authorAvatarUrl: "https://avatars.githubusercontent.com/u/7?s=48", committedAt: Date.parse("2024-01-02T00:00:00Z"), ci: "passing" },
      { oid: "sha-2", headline: "Tidy up", author: "alice", committedAt: Date.parse("2024-01-02T01:00:00Z"), ci: "none" }
    ]);

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

  it("flags comments posted by bots", () => {
    const detail = parseDetail(detailJson([
      { __typename: "IssueComment", body: "CI gate passed", createdAt: "2024-01-04T00:00:00Z", author: { login: "github-actions", __typename: "Bot" } },
      { __typename: "IssueComment", body: "Thanks!", createdAt: "2024-01-05T00:00:00Z", author: { login: "carol", __typename: "User" } }
    ], []), "octocat")!;

    expect(detail.timeline).toEqual([
      { kind: "comment", at: Date.parse("2024-01-04T00:00:00Z"), actor: "github-actions[bot]", body: "CI gate passed", isBot: true },
      { kind: "comment", at: Date.parse("2024-01-05T00:00:00Z"), actor: "carol", body: "Thanks!", isBot: false }
    ]);
  });

  it("takes reviewers from the summary, merging latest reviews with pending requests", () => {
    const json = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            ...summaryNode({
              viewerDidAuthor: true,
              reviewRequests: { nodes: [{ requestedReviewer: { login: "erin" } }, { requestedReviewer: { login: "bob" } }] }
            }),
            body: "",
            createdAt: "2024-01-01T00:00:00Z",
            timelineItems: { nodes: [] },
            threads: { nodes: [] },
            latestReviews: { nodes: [{ author: { login: "bob" }, state: "APPROVED" }] },
            commits: { nodes: [] },
            checkRunCommits: { nodes: [] }
          }
        }
      }
    });
    expect(parseDetail(json, "octocat")!.reviewers).toEqual([
      { login: "bob", state: "APPROVED" },
      { login: "erin", state: "PENDING" }
    ]);
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

describe("parseTrackedPrs", () => {
  const refs = [
    { host: "github.com", owner: "acme", repo: "widgets", number: 1 },
    { host: "github.com", owner: "acme", repo: "widgets", number: 2 },
    { host: "github.com", owner: "acme", repo: "gadgets", number: 3 }
  ];

  it("maps aliases back to refs and skips missing or null pull requests", () => {
    const json = JSON.stringify({
      data: {
        pr0: { pullRequest: summaryNode({ viewerDidAuthor: true }) },
        pr1: { pullRequest: null },
        pr2: { pullRequest: summaryNode({ number: 3, url: "https://github.com/acme/gadgets/pull/3", state: "MERGED" }) }
      }
    });
    const result = parseTrackedPrs(json, refs, "octocat");
    expect([...result.keys()]).toEqual(["github.com/acme/widgets#1", "github.com/acme/gadgets#3"]);
    expect(result.get("github.com/acme/widgets#1")?.viewerIsAuthor).toBe(true);
    expect(result.get("github.com/acme/gadgets#3")?.state).toBe("MERGED");
  });

  it("returns summaries carrying the tracked ref, not the canonical URL ref", () => {
    const tracked = [{ host: "github.com", owner: "ACME", repo: "Widgets", number: 1 }];
    const json = JSON.stringify({ data: { pr0: { pullRequest: summaryNode() } } });
    const summary = parseTrackedPrs(json, tracked, "octocat").get("github.com/ACME/Widgets#1");
    expect(summary?.ref).toEqual(tracked[0]);
  });

  it("skips an alias that is absent from data", () => {
    const json = JSON.stringify({ data: { pr0: { pullRequest: summaryNode() } } });
    const result = parseTrackedPrs(json, refs, "octocat");
    expect([...result.keys()]).toEqual(["github.com/acme/widgets#1"]);
  });

  it("uses the viewer to flag review requests", () => {
    const node = summaryNode({ reviewRequests: { nodes: [{ requestedReviewer: { login: "octocat" } }] } });
    const result = parseTrackedPrs(JSON.stringify({ data: { pr0: { pullRequest: node } } }), refs.slice(0, 1), "octocat");
    expect(result.get("github.com/acme/widgets#1")?.reviewRequestedFromViewer).toBe(true);
  });

  it("keeps partial data when the response also carries errors", () => {
    const json = JSON.stringify({
      data: { pr0: { pullRequest: summaryNode() }, pr1: null },
      errors: [{ type: "NOT_FOUND", path: ["pr1"], message: "Could not resolve to a Repository" }]
    });
    const result = parseTrackedPrs(json, refs.slice(0, 2), "octocat");
    expect([...result.keys()]).toEqual(["github.com/acme/widgets#1"]);
  });

  it("returns an empty map for malformed or data-less responses", () => {
    expect(parseTrackedPrs("not json", refs, "octocat").size).toBe(0);
    expect(parseTrackedPrs(JSON.stringify({ errors: [{ message: "boom" }] }), refs, "octocat").size).toBe(0);
  });
});
