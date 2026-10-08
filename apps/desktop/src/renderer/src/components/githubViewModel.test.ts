import { describe, expect, it } from "vitest";
import type { IssueSummary, PrSummary, WorkflowRunSummary } from "@cw-code/contracts";
import { prKeyOf } from "./githubQuery.js";
import {
  ISSUE_BUCKETS,
  PR_BUCKETS,
  assignedOpenIssueCount,
  buildLocalContext,
  buildRunContext,
  buildSuggestionSource,
  failingInvolvedRunCount,
  groupItems,
  involvedPrKeysOf,
  isViewEdited,
  liveRunRefs,
  mentionsMode,
  runRefsSignature,
  sortOf
} from "./githubViewModel.js";
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

const prOptions = {
  buckets: PR_BUCKETS,
  bucketOf: prBucket,
  repoOf: (item: PrSummary) => item.ref,
  isCloned: (repo: { owner: string; repo: string }) => repo.repo === "widgets"
};

describe("groupItems", () => {
  const items = [
    pr({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 }, viewerIsAuthor: false, reviewRequestedFromViewer: true }),
    pr({ ref: { host: "github.com", owner: "acme", repo: "gadgets", number: 2 }, state: "MERGED" }),
    pr({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 3 }, state: "CLOSED" })
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
    const issues = [issue({ state: "CLOSED" }), issue({ assignees: ["me"] })];
    const groups = groupItems(issues, "triage", {
      buckets: ISSUE_BUCKETS,
      bucketOf: (item) => (item.state === "CLOSED" ? "closed" : "assigned"),
      repoOf: (item) => item.ref,
      isCloned: () => false
    });
    expect(groups.map((group) => group.id)).toEqual(["assigned", "closed"]);
  });
});

describe("query helpers", () => {
  it("detects non-negated mentions:@me only", () => {
    expect(mentionsMode("is:issue mentions:@me state:open")).toBe(true);
    expect(mentionsMode("is:issue -mentions:@me")).toBe(false);
    expect(mentionsMode("is:issue mentions:someone")).toBe(false);
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

describe("buildLocalContext", () => {
  const sessions = [
    {
      id: "s1",
      updatedAt: 1,
      prs: [{ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 42 }, origin: "linked" as const, lastSeenSha: "abc123", lastSeenAt: 2000 }]
    },
    {
      id: "s2",
      updatedAt: 1,
      issues: [{ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 }, origin: "linked" as const, lastSeenAt: 500 }]
    }
  ];
  const context = buildLocalContext(sessions, (repo) => repo.repo === "widgets");

  it("matches sessions by item kind", () => {
    expect(context.hasSession(pr())).toBe(true);
    expect(context.hasSession(pr({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 43 } }))).toBe(false);
    expect(context.hasSession(issue())).toBe(true);
    expect(context.hasSession(issue({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 8 } }))).toBe(false);
  });

  it("treats an item as unread when a linked session has not seen its latest update", () => {
    expect(context.isUnread(pr({ updatedAt: 1000 }))).toBe(false);
    expect(context.isUnread(pr({ updatedAt: 3000 }))).toBe(true);
    expect(context.isUnread(issue({ updatedAt: 1000 }))).toBe(true);
    expect(context.isUnread(issue({ updatedAt: 400 }))).toBe(false);
  });

  it("delegates cloned lookup", () => {
    expect(context.isCloned({ host: "github.com", owner: "acme", repo: "widgets" })).toBe(true);
    expect(context.isCloned({ host: "github.com", owner: "acme", repo: "other" })).toBe(false);
  });
});

describe("run context and badges", () => {
  const failing = run({ ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 1 }, conclusion: "failure", prNumber: 42 });
  const failingOnDefault = run({
    ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 2 },
    conclusion: "timed_out",
    actor: "someone",
    onDefaultBranch: true
  });
  const failingElsewhere = run({ ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 3 }, conclusion: "failure", actor: "someone", prNumber: 99 });
  const passing = run({ ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 4 }, actor: "me" });

  it("collects PR keys from the inbox and viewer-involved cached PRs", () => {
    const inboxPr = pr({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 1 } });
    const involved = pr({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 2 }, assignees: ["me"] });
    const stranger = pr({ ref: { host: "github.com", owner: "acme", repo: "widgets", number: 3 } });
    const keys = involvedPrKeysOf([inboxPr], [involved, stranger], "me");
    expect(keys).toEqual(new Set([prKeyOf(inboxPr.ref, 1), prKeyOf(involved.ref, 2)]));
  });

  it("counts failing runs that involve the viewer", () => {
    const context = buildRunContext("me", new Set([prKeyOf(failing.ref, 42)]), []);
    expect(failingInvolvedRunCount([failing, failingOnDefault, failingElsewhere, passing], context)).toBe(2);
  });

  it("counts open assigned issues only", () => {
    const issues = [issue({ assignees: ["me"] }), issue({ assignees: ["me"], state: "CLOSED" }), issue({ assignees: ["other"] })];
    expect(assignedOpenIssueCount(issues, "me")).toBe(1);
  });

  it("derives a stable signature from live runs only", () => {
    const live = run({ ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 5 }, status: "in_progress", conclusion: null });
    const queued = run({ ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 6 }, status: "queued", conclusion: null });
    const refs = liveRunRefs([passing, live, queued]);
    expect(refs.map((ref) => ref.runId)).toEqual([5, 6]);
    expect(runRefsSignature(refs)).toBe("github.com/acme/widgets#5|github.com/acme/widgets#6");
    expect(runRefsSignature([])).toBe("");
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
