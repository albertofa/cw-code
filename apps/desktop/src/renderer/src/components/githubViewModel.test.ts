import { describe, expect, it } from "bun:test";
import type { GitHubRow, GitHubSubject, IssueSummary, PrSummary, WorkflowRunSummary } from "@cw-code/contracts";
import { ISSUE_BUCKETS, PR_BUCKETS, buildSuggestionSource, groupItems, isViewEdited, retargetQuery, sortOf } from "./githubViewModel.js";
import { prBucket } from "./prInbox.js";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
    url: "https://github.com/acme/widgets/pull/42",
    title: "Add feature",
    state: "OPEN",
    isDraft: false,
    author: { login: "author", isBot: false },
    viewerIsAuthor: false,
    reviewRequestedFromViewer: false,
    headRefName: "feature",
    headRefOid: "abc123",
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
    mergeStateStatus: "CLEAN",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 1000,
    ...overrides
  };
}

function issue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 },
    url: "https://github.com/acme/widgets/issues/7",
    title: "Broken",
    state: "OPEN",
    stateReason: null,
    author: { login: "reporter", isBot: false },
    assignees: [],
    labels: [],
    milestone: null,
    commentsCount: 0,
    linkedPrs: [],
    createdAt: 100,
    updatedAt: 1000,
    ...overrides
  };
}

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 900 },
    url: "https://github.com/acme/widgets/actions/runs/900",
    workflowName: "CI",
    runNumber: 12,
    event: "push",
    branch: "main",
    headSha: "abc123",
    title: "chore: bump",
    actor: "dev",
    status: "completed",
    conclusion: "success",
    prNumber: null,
    onDefaultBranch: false,
    createdAt: 1000,
    updatedAt: 61_000,
    jobs: [],
    ...overrides
  };
}

const RELATIONS: GitHubRow["relations"] = {
  linkedSessionIds: [],
  unseenSessionIds: [],
  mainSessionId: null,
  babysitter: null,
  action: { kind: "github" },
  delta: null
};

function row(subject: GitHubSubject, bucket: string, seq = 0): GitHubRow {
  return { seq, subject, bucket, relations: RELATIONS };
}

function prRow(item: PrSummary, seq = 0): GitHubRow {
  return row({ kind: "pr", pr: item }, prBucket(item), seq);
}

const prOptions = {
  buckets: PR_BUCKETS,
  isCloned: (repo: { owner: string; repo: string }) => repo.repo === "widgets"
};

describe("groupItems", () => {
  const items = [
    prRow(pr({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 }, viewerIsAuthor: false, reviewRequestedFromViewer: true }), 0),
    prRow(pr({ ref: { host: "github.com", owner: "acme", repo: "gadgets", number: 2 }, state: "MERGED" }), 1),
    prRow(pr({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 3 }, state: "CLOSED" }), 2)
  ];

  it("buckets by triage order and drops empty buckets", () => {
    const groups = groupItems(items, "triage", prOptions);
    expect(groups.map((group) => [group.id, group.items.length])).toEqual([
      ["review", 1],
      ["merged", 1],
      ["closed", 1]
    ]);
    expect(groups.every((group) => !group.flat)).toBe(true);
  });

  it("groups by the server-provided bucket", () => {
    const groups = groupItems([row({ kind: "pr", pr: pr() }, "ready")], "triage", prOptions);
    expect(groups.map((group) => group.id)).toEqual(["ready"]);
  });

  it("groups by repo in first-seen order and flags cloned repos", () => {
    const groups = groupItems(items, "repo", prOptions);
    expect(groups.map((group) => [group.id, group.items.length, group.hint])).toEqual([
      ["repo:acme/widgets", 2, "cloned"],
      ["repo:acme/gadgets", 1, ""]
    ]);
  });

  it("returns one flat group without header for none", () => {
    const groups = groupItems(items, "none", prOptions);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ flat: true, title: "" });
    expect(groups[0].items).toHaveLength(3);
  });

  it("keeps the closed issue bucket last", () => {
    const issues = [row({ kind: "issue", issue: issue({ state: "CLOSED" }) }, "closed"), row({ kind: "issue", issue: issue({ assignees: ["me"] }) }, "assigned")];
    const groups = groupItems(issues, "triage", { buckets: ISSUE_BUCKETS, isCloned: () => false });
    expect(groups.map((group) => group.id)).toEqual(["assigned", "closed"]);
  });
});

describe("query helpers", () => {
  it("drops other kind tokens when retargeting a query", () => {
    expect(retargetQuery("is:pr author:@me is:issue ", "issue")).toBe("author:@me is:issue ");
    expect(retargetQuery("is:run -is:pr repo:acme/widgets", "run")).toBe("is:run -is:pr repo:acme/widgets ");
    expect(retargetQuery("is:pr is:pr label:bug", "pr")).toBe("is:pr is:pr label:bug ");
  });

  it("reads the sort qualifier with per-kind defaults", () => {
    expect(sortOf("pr", "is:pr")).toBe("updated-desc");
    expect(sortOf("pr", "is:pr sort:comments-desc")).toBe("comments-desc");
    expect(sortOf("run", "is:run")).toBe("created-desc");
    expect(sortOf("run", "is:run sort:comments-desc")).toBe("created-desc");
    expect(sortOf("run", "is:run sort:created-asc")).toBe("created-asc");
  });

  it("marks a view edited when its query diverges or there is no view", () => {
    const view = { id: "pr:inbox", kind: "pr" as const, name: "Inbox", icon: "Inbox", query: "is:pr involves:@me", group: "triage" as const, saved: false };
    expect(isViewEdited(view, "is:pr  involves:@me")).toBe(false);
    expect(isViewEdited(view, "is:pr author:@me")).toBe(true);
    expect(isViewEdited(null, "is:pr")).toBe(true);
  });
});

describe("buildSuggestionSource", () => {
  it("merges people, repos, orgs, labels, milestones, workflows and branches", () => {
    const source = buildSuggestionSource({
      viewer: "me",
      prs: [pr({ author: { login: "alice", isBot: false }, reviewers: [{ login: "bob", state: "APPROVED" }], labels: ["bug"] })],
      issues: [issue({ author: { login: "carol", isBot: false }, assignees: ["alice"], labels: ["help wanted"], milestone: "v1" })],
      runs: [run({ actor: "dave", workflowName: "Deploy", branch: "release" })],
      repos: [{ projectId: "p1", host: "github.com", owner: "nuria-tech", repo: "hub" }]
    });
    expect(source.viewer).toBe("me");
    expect([...source.people].sort()).toEqual(["alice", "bob", "carol", "dave"]);
    expect([...source.repos].sort()).toEqual(["acme/widgets", "nuria-tech/hub"]);
    expect([...source.orgs].sort()).toEqual(["acme", "nuria-tech"]);
    expect([...source.labels].sort()).toEqual(["bug", "help wanted"]);
    expect(source.milestones).toEqual(["v1"]);
    expect(source.workflows).toEqual(["Deploy"]);
    expect(source.branches).toEqual(["release"]);
  });
});
