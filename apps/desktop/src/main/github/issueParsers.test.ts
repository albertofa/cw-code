import { describe, expect, it } from "vitest";
import { issueRefFromUrl, parseCounts, parseIssueDetail, parseIssueSearch } from "./issueParsers.js";

function issueNode(overrides: Record<string, unknown> = {}) {
  return {
    __typename: "Issue",
    number: 5,
    url: "https://github.com/acme/widgets/issues/5",
    title: "Crash on start",
    state: "OPEN",
    stateReason: null,
    author: { login: "octocat", __typename: "User" },
    assignees: { nodes: [] },
    labels: { nodes: [] },
    milestone: null,
    commentCount: { totalCount: 0 },
    closedByPullRequestsReferences: { nodes: [] },
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    ...overrides
  };
}

function searchJson(nodes: unknown[], results: Record<string, unknown> = { issueCount: nodes.length, nodes }) {
  return JSON.stringify({
    data: {
      viewer: { login: "octocat" },
      results,
      open: { issueCount: 4 },
      closed: { issueCount: 9 }
    }
  });
}

describe("parseIssueSearch", () => {
  it("parses labels, assignees, milestone, comment count and timestamps", () => {
    const result = parseIssueSearch(
      searchJson([
        issueNode({
          labels: { nodes: [{ name: "bug" }, { name: "p1" }] },
          assignees: { nodes: [{ login: "alice" }, { login: "bob" }] },
          milestone: { title: "v2" },
          commentCount: { totalCount: 3 }
        })
      ])
    );
    expect(result.viewer).toBe("octocat");
    expect(result.openCount).toBe(4);
    expect(result.closedCount).toBe(9);
    expect(result.truncated).toBe(false);
    expect(result.items).toEqual([
      {
        ref: { host: "github.com", owner: "acme", repo: "widgets", number: 5 },
        url: "https://github.com/acme/widgets/issues/5",
        title: "Crash on start",
        state: "OPEN",
        stateReason: null,
        author: { login: "octocat", isBot: false },
        assignees: ["alice", "bob"],
        labels: ["bug", "p1"],
        milestone: "v2",
        commentsCount: 3,
        linkedPrs: [],
        createdAt: Date.parse("2024-01-01T00:00:00Z"),
        updatedAt: Date.parse("2024-01-02T00:00:00Z")
      }
    ]);
  });

  it("parses linked pull requests and state reasons", () => {
    const result = parseIssueSearch(
      searchJson([
        issueNode({
          state: "CLOSED",
          stateReason: "NOT_PLANNED",
          closedByPullRequestsReferences: {
            nodes: [
              { number: 9, url: "https://github.com/acme/widgets/pull/9", state: "MERGED", isDraft: false },
              { number: 10, url: "https://github.com/acme/widgets/pull/10", state: "OPEN", isDraft: true },
              { number: 0, url: "", state: "OPEN", isDraft: false }
            ]
          }
        }),
        issueNode({ number: 6, url: "https://github.com/acme/widgets/issues/6", state: "CLOSED", stateReason: "DUPLICATE" })
      ])
    );
    expect(result.items[0].state).toBe("CLOSED");
    expect(result.items[0].stateReason).toBe("NOT_PLANNED");
    expect(result.items[0].linkedPrs).toEqual([
      { number: 9, url: "https://github.com/acme/widgets/pull/9", state: "MERGED", isDraft: false },
      { number: 10, url: "https://github.com/acme/widgets/pull/10", state: "OPEN", isDraft: true }
    ]);
    expect(result.items[1].stateReason).toBeNull();
  });

  it("flags a bot author and falls back to ghost for a deleted author", () => {
    const result = parseIssueSearch(
      searchJson([
        issueNode({ author: { login: "dependabot", __typename: "Bot" } }),
        issueNode({ number: 6, url: "https://github.com/acme/widgets/issues/6", author: null })
      ])
    );
    expect(result.items[0].author).toEqual({ login: "dependabot[bot]", isBot: true });
    expect(result.items[1].author).toEqual({ login: "ghost", isBot: false });
  });

  it("drops nodes that are not issues and reports truncation from the total", () => {
    const nodes = [{}, issueNode({ url: "https://github.com/acme/widgets/pull/5" }), issueNode()];
    const result = parseIssueSearch(searchJson(nodes, { issueCount: 120, nodes }));
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("returns an empty result for malformed JSON", () => {
    expect(parseIssueSearch("not-json")).toEqual({ viewer: null, items: [], openCount: null, closedCount: null, truncated: false });
  });
});

describe("issueRefFromUrl", () => {
  it("parses an issue url and rejects a pull request url", () => {
    expect(issueRefFromUrl("https://github.com/acme/widgets/issues/42")).toEqual({ host: "github.com", owner: "acme", repo: "widgets", number: 42 });
    expect(issueRefFromUrl("https://github.com/acme/widgets/pull/42")).toBeNull();
  });
});

describe("parseCounts", () => {
  it("returns null for a missing or malformed alias", () => {
    const json = JSON.stringify({ data: { c0: { issueCount: 12 }, c2: { issueCount: "x" } } });
    expect(parseCounts(json, 4)).toEqual([12, null, null, null]);
  });

  it("returns all nulls for malformed JSON", () => {
    expect(parseCounts("not-json", 2)).toEqual([null, null]);
  });
});

describe("parseIssueDetail", () => {
  function detailJson(comments: unknown[]) {
    return JSON.stringify({
      data: {
        viewer: { login: "octocat" },
        repository: {
          issue: { ...issueNode({ commentCount: { totalCount: comments.length } }), body: "Steps to reproduce", comments: { nodes: comments } }
        }
      }
    });
  }

  it("keeps the comment order and fills body and viewer", () => {
    const detail = parseIssueDetail(
      detailJson([
        { author: { login: "alice" }, body: "first", createdAt: "2024-01-03T00:00:00Z" },
        { author: null, body: "second", createdAt: "2024-01-04T00:00:00Z" }
      ]),
      "octocat"
    )!;
    expect(detail.body).toBe("Steps to reproduce");
    expect(detail.viewerLogin).toBe("octocat");
    expect(detail.commentsCount).toBe(2);
    expect(detail.comments).toEqual([
      { author: "alice", body: "first", createdAt: Date.parse("2024-01-03T00:00:00Z") },
      { author: "ghost", body: "second", createdAt: Date.parse("2024-01-04T00:00:00Z") }
    ]);
  });

  it("returns null for malformed JSON and a missing issue", () => {
    expect(parseIssueDetail("not-json", "octocat")).toBeNull();
    expect(parseIssueDetail(JSON.stringify({ data: { repository: { issue: null } } }), "octocat")).toBeNull();
  });
});
