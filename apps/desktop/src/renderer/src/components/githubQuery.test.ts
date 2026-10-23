import { describe, expect, it } from "bun:test";
import type { IssueSummary, PrSummary, RepoRef, WorkflowRunSummary } from "../cw.js";
import {
  addQualifier,
  applyAutocomplete,
  applyLocalFilters,
  autocomplete,
  kindFromQuery,
  normalizeQuery,
  prKeyOf,
  queryProblems,
  runMatches,
  runSources,
  sortedRemoteOf,
  sortRuns,
  splitQuery,
  stateOf,
  tokenize,
  withQualifier,
  withState,
  type RunContext,
  type SuggestionSource,
} from "./githubQuery.js";

const SOURCE: SuggestionSource = {
  viewer: "albertofa",
  people: ["lcosta", "albertofa", "dependabot[bot]", "mrodrigues"],
  repos: ["nuria-tech/nuria-hub", "albertofa/cw-code"],
  orgs: ["nuria-tech", "albertofa"],
  labels: ["perf", "bug"],
  milestones: ["v1"],
  workflows: ["CI", "Release"],
  branches: ["main", "feat/x"],
};

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
    ...overrides,
  };
}

const runCtx: RunContext = { viewer: "albertofa", involvedPrKeys: new Set(), isDefaultBranchRun: () => false, hasSession: () => false };

function pr(overrides: Partial<PrSummary> & { owner?: string } = {}): PrSummary {
  const { owner = "albertofa", ...rest } = overrides;
  return {
    ref: { host: "github.com", owner, repo: "cw-code", number: 1 },
    ...rest,
  } as PrSummary;
}

function issue(owner: string, number: number): IssueSummary {
  return { ref: { host: "github.com", owner, repo: "hub", number } } as IssueSummary;
}

describe("tokenize", () => {
  it("splits qualifiers, text and spaces with positions", () => {
    const tokens = tokenize('is:pr author:@me foo');
    expect(tokens.map((t) => [t.kind, t.start, t.end])).toEqual([
      ["qual", 0, 5],
      ["space", 5, 6],
      ["qual", 6, 16],
      ["space", 16, 17],
      ["text", 17, 20],
    ]);
    expect(tokens[2]).toMatchObject({ key: "author", rawKey: "author", value: "@me", neg: false });
  });

  it("keeps quoted values together and strips the quotes from value", () => {
    const [token] = tokenize('label:"good first issue"');
    expect(token).toMatchObject({ kind: "qual", key: "label", value: "good first issue", rawValue: '"good first issue"' });
  });

  it("handles an unterminated quote", () => {
    const [token] = tokenize('label:"good fi');
    expect(token.value).toBe("good fi");
    expect(token.end).toBe(14);
  });

  it("marks negation and lower-cases the key", () => {
    const [token] = tokenize("-Repo:acme/x");
    expect(token).toMatchObject({ neg: true, key: "repo", rawKey: "Repo", value: "acme/x" });
  });

  it("treats a bare word as text", () => {
    expect(tokenize("-foo")[0]).toMatchObject({ kind: "text", value: "-foo" });
  });
});

describe("queryProblems", () => {
  it("flags unknown qualifiers", () => {
    expect(queryProblems("pr", "foo:bar")).toEqual(["Unknown qualifier foo:"]);
  });

  it("uses GitHub's syntax for close reasons and drops no:reviewers", () => {
    expect(queryProblems("issue", 'reason:"not planned" reason:completed')).toEqual([]);
    expect(queryProblems("issue", "reason:not_planned")).toEqual(["not_planned isn't a valid value for reason:"]);
    expect(queryProblems("pr", "no:reviewers")).toEqual(["reviewers isn't a valid value for no:"]);
  });

  it("flags bad enum values", () => {
    expect(queryProblems("run", "status:broken")).toEqual(["broken isn't a valid value for status:"]);
  });

  it("accepts valid and local keys and ignores empty values", () => {
    expect(queryProblems("pr", "is:pr has:session cloned:true is:unread status:")).toEqual([]);
  });

  it("validates per kind", () => {
    expect(queryProblems("run", "cloned:true")).toEqual(["Unknown qualifier cloned:"]);
    expect(queryProblems("run", "sort:updated-desc")).toEqual(["updated-desc isn't a valid value for sort:"]);
  });
});

describe("kindFromQuery", () => {
  it("returns the last non-negated kind", () => {
    expect(kindFromQuery("is:pr is:issue")).toBe("issue");
    expect(kindFromQuery("is:run -is:issue")).toBe("run");
    expect(kindFromQuery("author:@me")).toBeNull();
  });
});

describe("splitQuery", () => {
  it("strips cw-only qualifiers from the remote part and collects them", () => {
    const split = splitQuery("pr", "is:pr author:@me has:session -cloned:true is:unread");
    expect(split.remote).toBe("is:pr author:@me");
    expect(split.local).toEqual([
      { key: "has", value: "session", neg: false },
      { key: "cloned", value: "true", neg: true },
      { key: "is", value: "unread", neg: false },
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
      { key: "cloned", value: "true", neg: false },
    ]);
    expect(queryProblems("pr", "is:Unread has:Session")).toEqual([]);
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
    expect(queryProblems("issue", "foo:bar")).toEqual(["Unknown qualifier foo:"]);
  });

  it("validates GitHub's standard search qualifiers", () => {
    expect(
      queryProblems("pr", "created:>2026-01-01 updated:<2026-02-01 closed:2026-03-01 comments:>5 commenter:lcosta in:title user:acme language:go head:feat/x base:main merged:>2026-01-01 team-review-requested:acme/core is:locked"),
    ).toEqual([]);
    expect(queryProblems("issue", "created:>2026-01-01 in:body is:locked language:go")).toEqual([]);
    expect(queryProblems("issue", "head:feat/x")).toEqual(["Unknown qualifier head:"]);
    expect(queryProblems("pr", "in:author")).toEqual(["author isn't a valid value for in:"]);
    expect(splitQuery("pr", "created:>2026-01-01 in:title").remote).toBe("created:>2026-01-01 in:title");
  });

  it("reads sort and state values case-insensitively", () => {
    expect(splitQuery("pr", "is:pr Sort:Created-Asc").sort).toBe("created-asc");
    expect(stateOf("is:Merged")).toBe("closed");
    expect(withState("is:Open is:pr", "closed")).toBe("is:pr state:closed");
    expect(kindFromQuery("is:Issue")).toBe("issue");
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

describe("query rewrites", () => {
  it("reads and toggles state", () => {
    expect(stateOf("is:pr is:merged")).toBe("closed");
    expect(stateOf("is:pr state:open")).toBe("open");
    expect(stateOf("is:pr -is:open")).toBeNull();
    expect(withState("is:pr is:open author:@me", "closed")).toBe("is:pr author:@me state:closed");
  });

  it("replaces a qualifier or removes it", () => {
    expect(withQualifier("is:pr sort:created-asc foo", "sort", "updated-desc")).toBe("is:pr foo sort:updated-desc");
    expect(withQualifier("is:pr sort:created-asc", "sort", null)).toBe("is:pr");
  });

  it("appends a qualifier once and quotes values with spaces", () => {
    expect(addQualifier("is:pr", "label", "good first issue")).toBe('is:pr label:"good first issue"');
    expect(addQualifier("is:pr label:bug", "label", "bug")).toBe("is:pr label:bug");
    expect(addQualifier("", "repo", "acme/x")).toBe("repo:acme/x");
  });

  it("normalizes whitespace", () => {
    expect(normalizeQuery("  is:pr   author:@me \n foo ")).toBe("is:pr author:@me foo");
  });
});

describe("applyLocalFilters", () => {
  const cloned = new Set(["albertofa"]);
  const ctx = {
    hasSession: (item: PrSummary | IssueSummary) => item.ref.number === 1,
    isCloned: (repo: RepoRef) => cloned.has(repo.owner),
    isUnread: (item: PrSummary | IssueSummary) => item.ref.number === 2,
  };
  const items = [
    { ...pr(), ref: { host: "github.com", owner: "albertofa", repo: "cw-code", number: 1 } },
    { ...pr(), ref: { host: "github.com", owner: "acme", repo: "cw-code", number: 2 } },
    { ...pr(), ref: { host: "github.com", owner: "acme", repo: "cw-code", number: 3 } },
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
          { key: "cloned", value: "true", neg: false },
        ],
        ctx,
      ),
    ).toEqual([]);
  });

  it("returns the input when there are no filters", () => {
    expect(applyLocalFilters([issue("a", 1)], [], ctx)).toHaveLength(1);
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
  const runs = [run({ ref: { host: "h", owner: "o", repo: "r", runId: 1 }, createdAt: 10 }), run({ ref: { host: "h", owner: "o", repo: "r", runId: 2 }, createdAt: 30 }), run({ ref: { host: "h", owner: "o", repo: "r", runId: 3 }, createdAt: 20 })];

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
    { host: "github.com", owner: "nuria-tech", repo: "nuria-hub" },
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
      orgs: ["nuria-tech"],
    });
  });

  it("scopes to a repo and reuses the cloned host", () => {
    expect(runSources("repo:nuria-tech/nuria-hub", cloned)).toEqual({
      prSearchQuery: "is:pr is:open repo:nuria-tech/nuria-hub",
      repos: [{ host: "github.com", owner: "nuria-tech", repo: "nuria-hub" }],
      orgs: [],
    });
    expect(runSources("repo:other/thing", cloned).repos).toEqual([{ host: "github.com", owner: "other", repo: "thing" }]);
  });

  it("ignores negated and malformed scopes", () => {
    expect(runSources("-org:acme repo:noslash", cloned).orgs).toEqual([]);
    expect(runSources("-org:acme repo:noslash", cloned).prSearchQuery).toContain("involves:@me");
  });
});

describe("autocomplete", () => {
  it("lists qualifier keys in key mode", () => {
    const result = autocomplete("pr", "", 0, SOURCE);
    expect(result.heading).toBe("Qualifiers");
    expect(result.items[0]).toMatchObject({ kind: "key", key: "is", label: "is:" });
    expect(result.items.find((i) => i.key === "has")).toMatchObject({ local: true });
  });

  it("filters keys by prefix and falls back to title search", () => {
    const keys = autocomplete("pr", "re", 2, SOURCE).items.map((i) => i.key);
    expect(keys).toEqual(["review-requested", "reviewed-by", "repo", "review"]);
    const none = autocomplete("pr", "zzz", 3, SOURCE);
    expect(none.items).toEqual([]);
    expect(none.empty).toContain("Searching titles");
    expect(none.invalid).toBe(false);
  });

  it("offers the exclude item first in repo value mode", () => {
    const result = autocomplete("pr", "repo:", 5, SOURCE);
    expect(result.heading).toBe("repo");
    expect(result.items[0]).toMatchObject({ kind: "exclude", key: "repo", label: "Exclude repo" });
    expect(result.items.slice(1).map((i) => i.value)).toEqual(["albertofa/cw-code", "nuria-tech/nuria-hub"]);
  });

  it("does not offer exclude once a partial value is typed or for negated keys", () => {
    expect(autocomplete("pr", "repo:nur", 8, SOURCE).items.map((i) => i.value)).toEqual(["nuria-tech/nuria-hub"]);
    expect(autocomplete("pr", "-repo:", 6, SOURCE).items.every((i) => i.kind === "value" && i.neg)).toBe(true);
  });

  it("lists @me first with the viewer avatar and maps bots to app/", () => {
    const result = autocomplete("pr", "author:", 7, SOURCE);
    expect(result.items[0]).toMatchObject({ value: "@me", avatarLogin: "albertofa" });
    const values = result.items.map((i) => i.value);
    expect(values).toEqual(["@me", "app/dependabot", "lcosta", "mrodrigues"]);
    expect(result.items.find((i) => i.value === "app/dependabot")).toMatchObject({ description: "app", avatarLogin: "dependabot[bot]" });
  });

  it("reports unknown keys as invalid", () => {
    const result = autocomplete("pr", "foo:b", 5, SOURCE);
    expect(result.invalid).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.empty).toContain("foo:");
  });

  it("reports no matching values", () => {
    const result = autocomplete("pr", "status:zzz", 10, SOURCE);
    expect(result.items).toEqual([]);
    expect(result.empty).toContain("zzz");
  });

  it("completes enum values with local flags and label colors", () => {
    expect(autocomplete("pr", "is:unr", 6, SOURCE).items).toMatchObject([{ value: "unread", local: true }]);
    const label = autocomplete("issue", "label:", 6, SOURCE).items.find((i) => i.value === "bug");
    expect(label?.labelColor).toMatch(/^hsl\(\d+,55%,58%\)$/);
  });

  it("autocompletes the standard search qualifiers", () => {
    expect(autocomplete("pr", "crea", 4, SOURCE).items).toMatchObject([{ key: "created", description: "Created date, e.g. >2026-01-01" }]);
    expect(autocomplete("pr", "in:", 3, SOURCE).items.map((i) => i.value)).toEqual(["title", "body", "comments"]);
    expect(autocomplete("pr", "is:lock", 7, SOURCE).items.map((i) => i.value)).toEqual(["locked"]);
    expect(autocomplete("issue", "hea", 3, SOURCE).items).toEqual([]);
    expect(autocomplete("pr", "hea", 3, SOURCE).items.map((i) => i.key)).toEqual(["head"]);
  });

  it("only offers @me for involves on runs", () => {
    expect(autocomplete("run", "involves:", 9, SOURCE).items.map((i) => i.value)).toEqual(["@me"]);
  });

  it("targets the token under the caret", () => {
    const result = autocomplete("pr", "is:pr aut foo", 9, SOURCE);
    expect([result.tokenStart, result.tokenEnd]).toEqual([6, 9]);
  });
});

describe("applyAutocomplete", () => {
  it("inserts a key and keeps the dropdown open", () => {
    const result = autocomplete("pr", "is:pr au", 8, SOURCE);
    const item = result.items[0];
    expect(applyAutocomplete("is:pr au", result, item, "pr")).toEqual({ query: "is:pr author:", caret: 13, reopen: true, switchKind: null });
  });

  it("turns exclude into a negated key and keeps the dropdown open", () => {
    const result = autocomplete("pr", "repo:", 5, SOURCE);
    expect(applyAutocomplete("repo:", result, result.items[0], "pr")).toEqual({ query: "-repo:", caret: 6, reopen: true, switchKind: null });
  });

  it("appends a space after a value unless one follows", () => {
    const result = autocomplete("pr", "author:l", 8, SOURCE);
    const item = result.items.find((i) => i.value === "lcosta");
    expect(item).toBeDefined();
    expect(applyAutocomplete("author:l", result, item!, "pr")).toEqual({ query: "author:lcosta ", caret: 14, reopen: false, switchKind: null });

    const mid = autocomplete("pr", "author:l foo", 8, SOURCE);
    expect(applyAutocomplete("author:l foo", mid, mid.items.find((i) => i.value === "lcosta")!, "pr").query).toBe("author:lcosta foo");
  });

  it("separates a key inserted right before another token", () => {
    const q = "is:pr foo";
    const result = autocomplete("pr", q, 6, SOURCE);
    expect([result.tokenStart, result.tokenEnd]).toEqual([6, 6]);
    const item = result.items.find((i) => i.key === "author")!;
    expect(applyAutocomplete(q, result, item, "pr")).toEqual({ query: "is:pr author: foo", caret: 13, reopen: true, switchKind: null });
  });

  it("replaces only the key when the caret is inside the key of a finished qualifier", () => {
    const q = "author:lcosta";
    const result = autocomplete("pr", q, 3, SOURCE);
    expect([result.tokenStart, result.tokenEnd]).toEqual([0, 7]);
    const item = result.items.find((i) => i.key === "author")!;
    expect(applyAutocomplete(q, result, item, "pr")).toEqual({ query: "author:lcosta", caret: 7, reopen: true, switchKind: null });
    const negated = autocomplete("pr", "-aut:x", 4, SOURCE);
    expect(applyAutocomplete("-aut:x", negated, negated.items[0], "pr").query).toBe("-author:x");
  });

  it("inserts close reasons with quotes", () => {
    const q = "reason:";
    const result = autocomplete("issue", q, 7, SOURCE);
    const item = result.items.find((i) => i.value === "not planned")!;
    expect(applyAutocomplete(q, result, item, "issue").query).toBe('reason:"not planned" ');
  });

  it("quotes values with spaces and keeps negation", () => {
    const result = autocomplete("pr", "-label:", 7, { ...SOURCE, labels: ["good first issue"] });
    expect(applyAutocomplete("-label:", result, result.items[0], "pr").query).toBe('-label:"good first issue" ');
  });

  it("requests a kind switch for is:issue and is:run but not for the current kind", () => {
    const result = autocomplete("pr", "is:", 3, SOURCE);
    const issueItem = result.items.find((i) => i.value === "issue")!;
    expect(applyAutocomplete("is:", result, issueItem, "pr")).toMatchObject({ query: "is:issue ", switchKind: "issue", reopen: false });
    const runItem = result.items.find((i) => i.value === "run")!;
    expect(applyAutocomplete("is:", result, runItem, "pr").switchKind).toBe("run");
    const prItem = result.items.find((i) => i.value === "pr")!;
    expect(applyAutocomplete("is:", result, prItem, "pr").switchKind).toBeNull();
    expect(applyAutocomplete("is:", result, prItem, "issue").switchKind).toBe("pr");
  });
});
