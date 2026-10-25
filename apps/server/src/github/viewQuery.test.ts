import { describe, expect, it } from "bun:test";
import type { IssueSummary, PrSummary, RepoRef, WorkflowRunSummary } from "@cw-code/contracts";
import { BUILTIN_VIEWS } from "@cw-code/shared/githubViews";
import {
  applyLocalFilters,
  assignedOpenIssueCount,
  badgeSearchKeys,
  cappedRunSources,
  failingInvolvedRunCount,
  involvedPrKeysOf,
  liveRunRefs,
  prKeyOf,
  runMatches,
  runSources,
  scopeSplitQuery,
  searchKey,
  sortedRemoteOf,
  sortRuns,
  splitQuery,
  type RunContext
} from "./viewQuery.js";

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    ref: { host: "github.com", owner: "albertofa", repo: "cw-code", runId: 1 },
    url: "https://github.com/albertofa/cw-code/actions/runs/1",
    workflowName: "CI",
    runNumber: 812,
    event: "push",
    branch: "main",
    headSha: "abc123",
    title: "fix: stale cache",
    actor: "lcosta",
    status: "completed",
    conclusion: "success",
    prNumber: null,
    onDefaultBranch: false,
    createdAt: 1000,
    updatedAt: 2000,
    jobs: [],
    ...overrides
  };
}

const runCtx: RunContext = { viewer: "albertofa", involvedPrKeys: new Set(), isDefaultBranchRun: () => false, hasSession: () => false };

function pr(overrides: Partial<PrSummary> & { owner?: string } = {}): PrSummary {
  const { owner = "albertofa", ...rest } = overrides;
  return {
    ref: { host: "github.com", owner, repo: "cw-code", number: 1 },
    assignees: [],
    reviewers: [],
    viewerIsAuthor: false,
    reviewRequestedFromViewer: false,
    ...rest
  } as PrSummary;
}

function issue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "hub", number: 1 },
    state: "OPEN",
    assignees: [],
    ...overrides
  } as IssueSummary;
}

describe("splitQuery", () => {
  it("strips cw-only qualifiers from the remote part and collects them", () => {
    const split = splitQuery("pr", "is:pr author:@me has:session -cloned:true is:unread");
    expect(split.remote).toBe("is:pr author:@me");
    expect(split.local).toEqual([
      { key: "has", value: "session", neg: false },
      { key: "cloned", value: "true", neg: true },
      { key: "is", value: "unread", neg: false }
    ]);
  });

  it("drops state from countBase only", () => {
    const split = splitQuery("issue", "is:issue is:open state:closed label:bug -is:closed");
    expect(split.remote).toBe("is:issue is:open state:closed label:bug -is:closed");
    expect(split.countBase).toBe("is:issue label:bug -is:closed");
  });

  it("normalizes the casing of local qualifiers", () => {
    const split = splitQuery("pr", "is:pr is:Unread -Has:Session cloned:TRUE");
    expect(split.remote).toBe("is:pr");
    expect(split.local).toEqual([
      { key: "is", value: "unread", neg: false },
      { key: "has", value: "session", neg: true },
      { key: "cloned", value: "true", neg: false }
    ]);
  });

  it("drops known keys with an invalid value from remote and countBase", () => {
    const split = splitQuery("pr", "is:pr sort:bogus status:broken has:foo cloned:yes is:open label:perf");
    expect(split.remote).toBe("is:pr is:open label:perf");
    expect(split.countBase).toBe("is:pr label:perf");
    expect(split.sort).toBe("updated-desc");
    expect(split.local).toEqual([]);
  });

  it("passes unknown keys through to remote and countBase as typed", () => {
    const split = splitQuery("issue", "is:issue foo:bar is:open");
    expect(split.remote).toBe("is:issue foo:bar is:open");
    expect(split.countBase).toBe("is:issue foo:bar");
  });

  it("keeps GitHub's standard search qualifiers in the remote part", () => {
    expect(splitQuery("pr", "created:>2026-01-01 in:title").remote).toBe("created:>2026-01-01 in:title");
  });

  it("reads the sort value case-insensitively", () => {
    expect(splitQuery("pr", "is:pr Sort:Created-Asc").sort).toBe("created-asc");
  });

  it("defaults the sort and reads a valid sort value", () => {
    expect(splitQuery("pr", "is:pr").sort).toBe("updated-desc");
    expect(splitQuery("pr", "is:pr sort:comments-desc").sort).toBe("comments-desc");
    expect(splitQuery("pr", "is:pr sort:bogus").sort).toBe("updated-desc");
  });

  it("sends the default sort to GitHub when the query has none", () => {
    expect(sortedRemoteOf(splitQuery("pr", "is:pr state:open"))).toBe("is:pr state:open sort:updated-desc");
    expect(sortedRemoteOf(splitQuery("pr", "is:pr sort:created-asc"))).toBe("is:pr sort:created-asc");
    expect(sortedRemoteOf(splitQuery("issue", "is:issue sort:bogus"))).toBe("is:issue sort:updated-desc");
  });

  it("drops qualifiers still being typed", () => {
    expect(splitQuery("pr", "is:pr author:").remote).toBe("is:pr");
  });

  it("keeps quoted values intact", () => {
    expect(splitQuery("pr", 'label:"good  first"   is:pr').remote).toBe('label:"good  first" is:pr');
  });
});

describe("scopeSplitQuery", () => {
  it("leaves queries without local filters untouched", () => {
    const split = splitQuery("pr", "is:pr state:open");
    expect(scopeSplitQuery(split)).toBe(split);
  });

  it("adds involves:@me when local filters need a scope", () => {
    const split = scopeSplitQuery(splitQuery("pr", "is:pr has:session"));
    expect(split.remote).toBe("is:pr involves:@me");
    expect(split.countBase).toBe("is:pr involves:@me");
  });

  it("keeps an existing scope", () => {
    expect(scopeSplitQuery(splitQuery("pr", "is:pr org:acme has:session")).remote).toBe("is:pr org:acme");
  });
});

describe("applyLocalFilters", () => {
  const cloned = new Set(["albertofa"]);
  const ctx = {
    hasSession: (item: PrSummary | IssueSummary) => item.ref.number === 1,
    isCloned: (repo: RepoRef) => cloned.has(repo.owner),
    isUnread: (item: PrSummary | IssueSummary) => item.ref.number === 2
  };
  const items = [
    { ...pr(), ref: { host: "github.com", owner: "albertofa", repo: "cw-code", number: 1 } },
    { ...pr(), ref: { host: "github.com", owner: "acme", repo: "cw-code", number: 2 } },
    { ...pr(), ref: { host: "github.com", owner: "acme", repo: "cw-code", number: 3 } }
  ];

  it("filters by has:session", () => {
    expect(applyLocalFilters(items, [{ key: "has", value: "session", neg: false }], ctx).map((i) => i.ref.number)).toEqual([1]);
  });

  it("filters by -cloned:true", () => {
    expect(applyLocalFilters(items, [{ key: "cloned", value: "true", neg: true }], ctx).map((i) => i.ref.number)).toEqual([2, 3]);
  });

  it("filters by is:unread and ANDs filters", () => {
    expect(applyLocalFilters(items, [{ key: "is", value: "unread", neg: false }], ctx).map((i) => i.ref.number)).toEqual([2]);
    expect(
      applyLocalFilters(
        items,
        [
          { key: "is", value: "unread", neg: false },
          { key: "cloned", value: "true", neg: false }
        ],
        ctx
      )
    ).toEqual([]);
  });

  it("returns the input when there are no filters", () => {
    expect(applyLocalFilters([issue()], [], ctx)).toHaveLength(1);
  });
});

describe("runMatches", () => {
  it("ORs repeated repo, org and status values", () => {
    const r = run({ conclusion: "failure" });
    expect(runMatches(r, "repo:acme/x repo:albertofa/cw-code", runCtx)).toBe(true);
    expect(runMatches(r, "repo:acme/x repo:acme/y", runCtx)).toBe(false);
    expect(runMatches(r, "org:acme org:albertofa", runCtx)).toBe(true);
    expect(runMatches(r, "status:success status:failure", runCtx)).toBe(true);
    expect(runMatches(r, "status:success status:queued", runCtx)).toBe(false);
  });

  it("ANDs different keys", () => {
    const r = run({ branch: "main", workflowName: "CI" });
    expect(runMatches(r, "branch:main workflow:ci", runCtx)).toBe(true);
    expect(runMatches(r, "branch:main workflow:Release", runCtx)).toBe(false);
  });

  it("excludes with negation", () => {
    const r = run({ branch: "main" });
    expect(runMatches(r, "-branch:main", runCtx)).toBe(false);
    expect(runMatches(r, "-branch:dev", runCtx)).toBe(true);
    expect(runMatches(r, "-status:failure", runCtx)).toBe(true);
  });

  it("maps status and conclusion", () => {
    expect(runMatches(run({ conclusion: "timed_out" }), "status:failure", runCtx)).toBe(true);
    expect(runMatches(run({ conclusion: "startup_failure" }), "status:failure", runCtx)).toBe(true);
    expect(runMatches(run({ conclusion: "skipped" }), "status:success", runCtx)).toBe(true);
    expect(runMatches(run({ conclusion: "cancelled" }), "status:cancelled", runCtx)).toBe(true);
    expect(runMatches(run({ status: "in_progress", conclusion: null }), "status:in_progress", runCtx)).toBe(true);
    expect(runMatches(run({ status: "queued", conclusion: null }), "status:queued", runCtx)).toBe(true);
  });

  it("matches actor including @me and bots", () => {
    expect(runMatches(run({ actor: "albertofa" }), "actor:@me", runCtx)).toBe(true);
    expect(runMatches(run({ actor: "dependabot[bot]" }), "actor:app/dependabot", runCtx)).toBe(true);
    expect(runMatches(run({ actor: "lcosta" }), "actor:@me", runCtx)).toBe(false);
  });

  it("evaluates involves:@me from actor or involved PR keys", () => {
    const involved = { ...runCtx, involvedPrKeys: new Set([prKeyOf({ host: "github.com", owner: "AlbertoFA", repo: "CW-Code" }, 9)]) };
    expect(runMatches(run({ actor: "albertofa" }), "involves:@me", runCtx)).toBe(true);
    expect(runMatches(run({ actor: "lcosta", prNumber: 9 }), "involves:@me", involved)).toBe(true);
    expect(runMatches(run({ actor: "lcosta", prNumber: 8 }), "involves:@me", involved)).toBe(false);
    expect(runMatches(run({ actor: "lcosta", prNumber: null }), "involves:@me", involved)).toBe(false);
  });

  it("matches involves:@me for default-branch runs reported by the context", () => {
    const defaultBranch = { ...runCtx, isDefaultBranchRun: (r: WorkflowRunSummary) => r.branch === "main" };
    expect(runMatches(run({ actor: "lcosta", branch: "main" }), "involves:@me", defaultBranch)).toBe(true);
    expect(runMatches(run({ actor: "lcosta", branch: "feat/x" }), "involves:@me", defaultBranch)).toBe(false);
    expect(runMatches(run({ actor: "lcosta", branch: "main" }), "involves:@me", runCtx)).toBe(false);
  });

  it("matches event case-insensitively and branch exactly", () => {
    expect(runMatches(run({ event: "push" }), "event:Push", runCtx)).toBe(true);
    expect(runMatches(run({ branch: "main" }), "branch:Main", runCtx)).toBe(false);
  });

  it("evaluates has:session through the context", () => {
    expect(runMatches(run(), "has:session", { ...runCtx, hasSession: () => true })).toBe(true);
    expect(runMatches(run(), "has:session", runCtx)).toBe(false);
  });

  it("matches free text against title, workflow, branch, repo and run number", () => {
    const r = run({ title: "fix: stale cache", branch: "feat/x", runNumber: 812 });
    expect(runMatches(r, "stale", runCtx)).toBe(true);
    expect(runMatches(r, "CW-CODE", runCtx)).toBe(true);
    expect(runMatches(r, "feat/x", runCtx)).toBe(true);
    expect(runMatches(r, "#812", runCtx)).toBe(true);
    expect(runMatches(r, "stale unrelated", runCtx)).toBe(false);
  });

  it("ignores type, sort, unknown and invalid tokens", () => {
    expect(runMatches(run(), "is:run sort:created-asc foo:bar status:broken", runCtx)).toBe(true);
  });
});

describe("sortRuns", () => {
  const runs = [
    run({ ref: { host: "h", owner: "o", repo: "r", runId: 1 }, createdAt: 10 }),
    run({ ref: { host: "h", owner: "o", repo: "r", runId: 2 }, createdAt: 30 }),
    run({ ref: { host: "h", owner: "o", repo: "r", runId: 3 }, createdAt: 20 })
  ];

  it("sorts newest first by default", () => {
    expect(sortRuns(runs, "created-desc").map((r) => r.ref.runId)).toEqual([2, 3, 1]);
    expect(sortRuns(runs, "unknown").map((r) => r.ref.runId)).toEqual([2, 3, 1]);
  });

  it("sorts oldest first and does not mutate", () => {
    expect(sortRuns(runs, "created-asc").map((r) => r.ref.runId)).toEqual([1, 3, 2]);
    expect(runs.map((r) => r.ref.runId)).toEqual([1, 2, 3]);
  });
});

describe("runSources", () => {
  const cloned: RepoRef[] = [
    { host: "github.com", owner: "albertofa", repo: "cw-code" },
    { host: "github.com", owner: "nuria-tech", repo: "nuria-hub" }
  ];

  it("uses involves:@me and the cloned repos when there is no scope", () => {
    const expected = { prSearchQuery: "is:pr is:open involves:@me archived:false", repos: cloned, orgs: [] };
    expect(runSources("", cloned)).toEqual(expected);
    expect(runSources("involves:@me status:failure", cloned)).toEqual(expected);
  });

  it("scopes to an org", () => {
    expect(runSources("org:nuria-tech", cloned)).toEqual({
      prSearchQuery: "is:pr is:open org:nuria-tech archived:false",
      repos: [],
      orgs: ["nuria-tech"]
    });
  });

  it("scopes to a repo and reuses the cloned host", () => {
    expect(runSources("repo:nuria-tech/nuria-hub", cloned)).toEqual({
      prSearchQuery: "is:pr is:open repo:nuria-tech/nuria-hub",
      repos: [{ host: "github.com", owner: "nuria-tech", repo: "nuria-hub" }],
      orgs: []
    });
    expect(runSources("repo:other/thing", cloned).repos).toEqual([{ host: "github.com", owner: "other", repo: "thing" }]);
  });

  it("ignores negated and malformed scopes", () => {
    expect(runSources("-org:acme repo:noslash", cloned).orgs).toEqual([]);
    expect(runSources("-org:acme repo:noslash", cloned).prSearchQuery).toContain("involves:@me");
  });
});

describe("cappedRunSources", () => {
  it("keeps only the repos handed in", () => {
    const cloned: RepoRef[] = [
      { host: "github.com", owner: "nuria-tech", repo: "nuria-hub" },
      { host: "github.com", owner: "albertofa", repo: "cw-code" }
    ];
    expect(cappedRunSources("is:run involves:@me", cloned).repos).toEqual(cloned);
  });

  it("caps repos at 20 and orgs at 5", () => {
    const many: RepoRef[] = Array.from({ length: 30 }, (_, index) => ({ host: "github.com", owner: "acme", repo: `r${index}` }));
    expect(cappedRunSources("", many).repos).toHaveLength(20);
    const orgs = Array.from({ length: 9 }, (_, index) => `org:o${index}`).join(" ");
    expect(cappedRunSources(orgs, []).orgs).toHaveLength(5);
  });
});

describe("searchKey", () => {
  const cloned = [{ host: "github.com", owner: "acme", repo: "widgets" }];

  it("normalizes the remote part for pr and issue queries", () => {
    expect(searchKey("pr", "  is:pr   author:@me ", [])).toBe("pr:is:pr author:@me");
    expect(searchKey("issue", "is:issue label:bug", cloned)).toBe("issue:is:issue label:bug");
  });

  it("ignores local-only qualifiers apart from the scope they imply", () => {
    expect(searchKey("pr", "is:pr org:acme has:session", [])).toBe(searchKey("pr", "is:pr org:acme", []));
    expect(searchKey("pr", "is:pr has:session", [])).toBe("pr:is:pr involves:@me");
  });

  it("derives the run key from the capped sources", () => {
    expect(searchKey("run", "is:run", cloned)).toBe(`run:${JSON.stringify(cappedRunSources("is:run", cloned))}`);
    expect(searchKey("run", "is:run", cloned)).not.toBe(searchKey("run", "is:run", []));
  });
});

describe("badgeSearchKeys", () => {
  const cloned = [{ host: "github.com", owner: "acme", repo: "widgets" }];

  it("derives the issue inbox and run watching keys from the built-in views", () => {
    const issueQuery = BUILTIN_VIEWS.find((view) => view.id === "issue:inbox")?.query ?? "";
    const runQuery = BUILTIN_VIEWS.find((view) => view.id === "run:watching")?.query ?? "";

    expect(badgeSearchKeys(cloned)).toEqual({
      issue: searchKey("issue", issueQuery, []),
      run: searchKey("run", runQuery, cloned)
    });
  });

  it("changes the run key with the cloned repos but not the issue key", () => {
    expect(badgeSearchKeys([]).issue).toBe(badgeSearchKeys(cloned).issue);
    expect(badgeSearchKeys([]).run).not.toBe(badgeSearchKeys(cloned).run);
  });
});

describe("non-GitHub project remotes", () => {
  it("keeps only the repos handed in as run sources", () => {
    const cloned = [
      { host: "github.com", owner: "nuria-tech", repo: "nuria-hub" },
      { host: "github.com", owner: "albertofa", repo: "cw-code" }
    ];
    expect(cappedRunSources("is:run involves:@me", cloned).repos.every((repo) => repo.host.toLowerCase() === "github.com")).toBe(true);
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
    const context: RunContext = {
      viewer: "me",
      involvedPrKeys: new Set([prKeyOf(failing.ref, 42)]),
      isDefaultBranchRun: (r) => r.onDefaultBranch,
      hasSession: () => false
    };
    expect(failingInvolvedRunCount([failing, failingOnDefault, failingElsewhere, passing], context)).toBe(2);
  });

  it("counts open assigned issues only", () => {
    const issues = [issue({ assignees: ["me"] }), issue({ assignees: ["me"], state: "CLOSED" }), issue({ assignees: ["other"] })];
    expect(assignedOpenIssueCount(issues, "me")).toBe(1);
  });

  it("lists live runs only", () => {
    const live = run({ ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 5 }, status: "in_progress", conclusion: null });
    const queued = run({ ref: { host: "github.com", owner: "acme", repo: "widgets", runId: 6 }, status: "queued", conclusion: null });
    expect(liveRunRefs([passing, live, queued]).map((ref) => ref.runId)).toEqual([5, 6]);
  });
});
