import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type {
  AppSettings,
  GitHubContext,
  GitHubMetaTopicData,
  GitHubRow,
  GitHubViewTopicData,
  IssueSummary,
  PrSummary,
  RunRef,
  SessionMeta,
  WorkflowRunSummary
} from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { GITHUB_META_TOPIC, githubViewTopic, parseGithubViewTopic } from "@cw-code/shared/topics";
import { advanceTimersByTimeAsync } from "../../tests/testing.js";
import { DEFAULT_SETTINGS } from "../settings/SettingsStore.js";
import { TopicHub, type TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { GitHubViews } from "./GitHubViews.js";
import { MAX_WATCHED_RUNS, runKey } from "./RunWatcher.js";
import { watchedRunRefs } from "./viewQuery.js";
import type { GitHubSearchResult, PrInboxResult, RunSources, RunsResult } from "./results.js";

const ACCOUNT = { host: "github.com", login: "me" };

function pr(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number },
    url: `https://github.com/acme/widgets/pull/${number}`,
    title: `PR ${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "me", isBot: false },
    viewerIsAuthor: true,
    reviewRequestedFromViewer: false,
    headRefName: `branch-${number}`,
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
    mergeStateStatus: "CLEAN",
    labels: [],
    reviewers: [],
    assignees: [],
    updatedAt: 2000,
    ...overrides
  };
}

function issue(number: number, overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number },
    url: `https://github.com/acme/widgets/issues/${number}`,
    title: `Issue ${number}`,
    state: "OPEN",
    stateReason: null,
    author: { login: "someone", isBot: false },
    assignees: [],
    labels: [],
    milestone: null,
    commentsCount: 0,
    linkedPrs: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides
  };
}

function run(runId: number, overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    ref: { host: "github.com", owner: "acme", repo: "widgets", runId },
    url: `https://github.com/acme/widgets/actions/runs/${runId}`,
    workflowName: "CI",
    runNumber: runId,
    event: "push",
    branch: "main",
    headSha: "abc",
    title: `Run ${runId}`,
    actor: "me",
    status: "completed",
    conclusion: "success",
    prNumber: null,
    onDefaultBranch: true,
    createdAt: runId,
    updatedAt: 1000,
    jobs: [],
    ...overrides
  };
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    projectId: "project",
    driver: "claude",
    title: "Session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 5,
    ...overrides
  };
}

function searchResult<T>(items: T[]): GitHubSearchResult<T> {
  return { account: ACCOUNT, items, openCount: items.length, closedCount: 0, truncated: false, limit: 100, fetchedAt: 10, error: null };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness() {
  const state = {
    settings: { ...DEFAULT_SETTINGS, prRefreshIntervalSeconds: 60, prWorkflows: [], githubSavedViews: [] } as AppSettings,
    sessions: [] as SessionMeta[],
    context: { viewer: "me", org: null, projectRepos: [] } as GitHubContext,
    inbox: null as PrInboxResult | null,
    prs: [] as PrSummary[],
    issues: [] as IssueSummary[],
    runs: [] as WorkflowRunSummary[],
    hold: null as Deferred | null
  };
  const calls = { prs: [] as Array<{ query: string; force: boolean }>, issues: [] as string[], runs: [] as RunSources[], counts: [] as string[][] };
  const watched: RunRef[][] = [];
  const active: boolean[] = [];
  const stores = new Map<string, TopicStore<Record<string, unknown>>>();
  const held = async () => {
    if (state.hold) await state.hold.promise;
  };
  const hub = new TopicHub(() => undefined);
  const views = new GitHubViews(hub, {
    settings: () => state.settings,
    sessions: () => state.sessions,
    context: () => state.context,
    inbox: () => state.inbox,
    summaryLookup: () => new Map(),
    ensureContext: async () => undefined,
    refreshInbox: async () => undefined,
    searchPrs: async (query, _countBase, force) => {
      calls.prs.push({ query, force });
      await held();
      return searchResult(state.prs);
    },
    searchIssues: async (query) => {
      calls.issues.push(query);
      await held();
      return searchResult(state.issues);
    },
    fetchRuns: async (sources): Promise<RunsResult> => {
      calls.runs.push(sources);
      await held();
      return { account: ACCOUNT, items: state.runs, fetchedAt: 10, error: null };
    },
    counts: async (_kind, queries) => {
      calls.counts.push(queries);
      return queries.map((_query, index) => index + 1);
    },
    watchRuns: (refs) => watched.push(refs),
    setRunWatchActive: (on) => active.push(on)
  });
  const capture = (provider: TopicProvider): TopicProvider => ({
    ...provider,
    acquire: (topic, owner) => {
      const store = provider.acquire(topic, owner);
      stores.set(topic, store);
      return store;
    }
  });
  hub.register(capture(views.metaProvider));
  hub.register(capture(views.viewProvider));
  return {
    state,
    calls,
    watched,
    active,
    views,
    subscribe: (topic: string, client = "c1") => void hub.subscribeClient(client, [topic]),
    unsubscribe: (topic: string, client = "c1") => hub.unsubscribeClient(client, [topic]),
    view: (topic: string) => (stores.get(topic)?.snapshot().data ?? {}) as GitHubViewTopicData,
    meta: () => (stores.get(GITHUB_META_TOPIC)?.snapshot().data ?? {}) as GitHubMetaTopicData
  };
}

function rows(data: GitHubViewTopicData): GitHubRow[] {
  return Object.entries(data)
    .filter(([key]) => key.startsWith("row/"))
    .map(([, value]) => value as GitHubRow)
    .sort((a, b) => a.seq - b.seq);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("GitHubViews", () => {
  it("round-trips the topic name into the published view state", async () => {
    const query = 'is:pr author:@me label:"needs review" café sort:created-asc';
    const topic = githubViewTopic("pr", query);
    expect(parseGithubViewTopic(topic)).toEqual({ kind: "pr", query });
    const h = createHarness();
    h.subscribe(topic);
    await flush();
    const { view } = h.view(topic);
    expect(view).toMatchObject({ kind: "pr", query, sort: "created-asc", loading: false, error: null, account: ACCOUNT, openCount: 0 });
    expect(h.calls.prs).toEqual([{ query: 'is:pr author:@me label:"needs review" café sort:created-asc', force: false }]);
  });

  it("publishes each row with its order, bucket and relations", async () => {
    const h = createHarness();
    h.state.prs = [pr(1, { viewerIsAuthor: false, reviewRequestedFromViewer: true, author: { login: "other", isBot: false } }), pr(2, { ci: "failing" })];
    h.state.sessions = [session({ prs: [{ ref: pr(1).ref, origin: "linked", lastSeenSha: "sha-1", lastSeenAt: 9000 }] })];
    const topic = githubViewTopic("pr", "is:pr involves:@me");
    h.subscribe(topic);
    await flush();
    const published = rows(h.view(topic));
    expect(published.map((row) => [row.seq, row.subject.kind === "pr" ? row.subject.pr.ref.number : null, row.bucket])).toEqual([
      [0, 1, "review"],
      [1, 2, "action"]
    ]);
    expect(published[0].relations).toMatchObject({ linkedSessionIds: ["s1"], mainSessionId: "s1", unseenSessionIds: [] });
    expect(published[1].relations.linkedSessionIds).toEqual([]);
    expect(Object.keys(h.view(topic))).toContain(`row/${prKey(pr(1).ref)}`);

    h.state.issues = [issue(5), issue(6, { assignees: ["me"] })];
    const issues = githubViewTopic("issue", "is:issue mentions:@me");
    h.subscribe(issues);
    await flush();
    expect(rows(h.view(issues)).map((row) => row.bucket)).toEqual(["mentioned", "assigned"]);

    h.state.runs = [run(7, { conclusion: "failure" }), run(8, { status: "in_progress", conclusion: null })];
    const runs = githubViewTopic("run", "is:run");
    h.subscribe(runs);
    await flush();
    expect(rows(h.view(runs)).map((row) => [row.subject.kind === "run" ? row.subject.run.ref.runId : null, row.bucket])).toEqual([
      [8, "running"],
      [7, "failing"]
    ]);
  });

  it("recomputes relations on session changes and keeps unchanged rows", async () => {
    const h = createHarness();
    h.state.prs = [pr(1), pr(2)];
    const topic = githubViewTopic("pr", "is:pr author:@me");
    h.subscribe(topic);
    await flush();
    const before = rows(h.view(topic));
    h.state.sessions = [session({ prs: [{ ref: pr(2).ref, origin: "linked", lastSeenSha: "sha-2", lastSeenAt: 9000 }] })];
    h.views.reevaluate();
    await flush();
    const after = rows(h.view(topic));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].relations.linkedSessionIds).toEqual(["s1"]);
  });

  it("shares one fetch between topics with the same search key", async () => {
    const h = createHarness();
    h.state.prs = [pr(1)];
    h.state.hold = deferred();
    const plain = githubViewTopic("pr", "is:pr author:@me");
    const unread = githubViewTopic("pr", "is:pr   author:@me is:unread");
    h.subscribe(plain);
    h.subscribe(unread);
    await flush();
    expect(h.calls.prs).toHaveLength(1);
    expect(h.view(plain).view.loading).toBe(true);
    expect(h.view(unread).view.loading).toBe(true);
    h.state.hold.resolve();
    await flush();
    expect(rows(h.view(plain))).toHaveLength(1);
    expect(rows(h.view(unread))).toHaveLength(0);
    expect(h.view(unread).view.loading).toBe(false);
    expect(h.view(plain).view.countsUnavailable).toBe(false);
    expect(h.view(unread).view.countsUnavailable).toBe(true);
    h.subscribe(plain, "c2");
    h.subscribe(githubViewTopic("pr", "is:pr author:@me "));
    await flush();
    expect(h.calls.prs).toHaveLength(1);
  });

  it("merges run updates into the published rows", async () => {
    const h = createHarness();
    h.state.runs = [run(1, { status: "in_progress", conclusion: null, updatedAt: 100 })];
    const topic = githubViewTopic("run", "is:run");
    h.subscribe(topic);
    await flush();
    h.views.runsChanged([run(1, { status: "completed", conclusion: "failure", updatedAt: 200, title: "ignored" })]);
    await flush();
    const [row] = rows(h.view(topic));
    expect(row.bucket).toBe("failing");
    expect(row.subject.kind === "run" ? [row.subject.run.title, row.subject.run.updatedAt] : null).toEqual(["Run 1", 200]);
    expect(h.views.cachedRun(run(1).ref)?.updatedAt).toBe(200);
    expect(h.views.cachedRun(run(2).ref)).toBeUndefined();
  });

  it("derives the run watch set from open run topics, capped at 30", async () => {
    const live = Array.from({ length: 40 }, (_, index) =>
      run(index + 1, { status: index % 2 === 0 ? "queued" : "in_progress", conclusion: null, updatedAt: index })
    );
    const picked = watchedRunRefs([[run(99), ...live], live], MAX_WATCHED_RUNS);
    expect(picked).toHaveLength(MAX_WATCHED_RUNS);
    expect(picked.slice(0, 20).map((ref) => ref.runId)).toEqual(live.filter((item) => item.status === "in_progress").map((item) => item.ref.runId).reverse());
    expect(picked.some((ref) => ref.runId === 99)).toBe(false);

    const h = createHarness();
    h.state.runs = [run(1, { status: "in_progress", conclusion: null }), run(2)];
    const topic = githubViewTopic("run", "is:run");
    h.subscribe(topic);
    await flush();
    expect(h.active.at(-1)).toBe(true);
    expect(h.watched.at(-1)?.map(runKey)).toEqual([runKey(run(1).ref)]);
    h.unsubscribe(topic);
    h.views.syncRunWatch();
    expect(h.watched.at(-1)).toEqual([]);
    expect(h.active.at(-1)).toBe(false);
  });

  it("publishes meta views and badges", async () => {
    const h = createHarness();
    h.state.context = { viewer: "me", org: "acme", projectRepos: [{ projectId: "project", host: "github.com", owner: "acme", repo: "widgets" }] };
    h.state.settings = { ...h.state.settings, githubSavedViews: [{ id: "saved", kind: "issue", name: "Bugs", query: "is:issue label:bug", group: "none" }] };
    h.state.inbox = { account: ACCOUNT, items: [pr(1, { ci: "failing" }), pr(2)], fetchedAt: 1, error: null };
    h.state.issues = [issue(1, { assignees: ["me"] }), issue(2)];
    h.state.runs = [run(1, { conclusion: "failure" }), run(2)];
    h.subscribe(GITHUB_META_TOPIC);
    await flush();
    const meta = h.meta();
    expect(meta.context.org).toBe("acme");
    expect(meta.views.issue.map((view) => view.id)).toContain("saved");
    expect(meta.views.pr.find((view) => view.id === "pr:org")?.query).toBe("is:pr org:acme state:open");
    expect(meta.badges).toEqual({ pr: { count: 1, tone: "default" }, issue: { count: 1, tone: "quiet" }, run: { count: 1, tone: "bad" } });
  });

  it("rejects a refresh for a topic that is not subscribed", async () => {
    const h = createHarness();
    const topic = githubViewTopic("pr", "is:pr author:@me");
    const [viewResult, metaResult] = await Promise.allSettled([h.views.refresh(topic, true), h.views.refresh(GITHUB_META_TOPIC, true)]);
    expect(viewResult.status).toBe("rejected");
    expect(metaResult.status).toBe("rejected");
    h.subscribe(topic);
    await flush();
    await h.views.refresh(topic, true);
    expect(h.calls.prs.at(-1)?.force).toBe(true);
  });

  it("force-refreshes only open run views on CI activity", async () => {
    const h = createHarness();
    h.state.runs = [run(1)];
    h.subscribe(GITHUB_META_TOPIC);
    await flush();
    const metaRunFetches = h.calls.runs.length;
    h.views.ciActivity();
    await flush();
    expect(h.calls.runs).toHaveLength(metaRunFetches);
    h.subscribe(githubViewTopic("run", "is:run"));
    await flush();
    const before = h.calls.runs.length;
    h.views.ciActivity();
    await flush();
    expect(h.calls.runs.length).toBeGreaterThan(before);
  });

  it("caches view counts for 60 seconds", async () => {
    const h = createHarness();
    setSystemTime(new Date(1_000_000));
    try {
      const first = await h.views.viewCounts("issue");
      expect(first["issue:inbox"]).toBe(1);
      await h.views.viewCounts("issue");
      expect(h.calls.counts).toHaveLength(1);
      setSystemTime(new Date(1_061_000));
      await h.views.viewCounts("issue");
      expect(h.calls.counts).toHaveLength(2);
      expect(await h.views.viewCounts("run")).toEqual({ "run:watching": null, "run:mine": null, "run:failing": null });
    } finally {
      setSystemTime();
    }
  });

  describe("refresh schedule", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("refreshes only while the topic is subscribed", async () => {
      const h = createHarness();
      const topic = githubViewTopic("pr", "is:pr author:@me");
      h.subscribe(topic);
      await advanceTimersByTimeAsync(0);
      expect(h.calls.prs).toHaveLength(1);
      await advanceTimersByTimeAsync(60_000);
      expect(h.calls.prs).toHaveLength(2);
      await h.views.refresh(topic, true);
      expect(h.calls.prs.at(-1)?.force).toBe(true);
      h.unsubscribe(topic);
      await advanceTimersByTimeAsync(180_000);
      const [afterUnsubscribe] = await Promise.allSettled([h.views.refresh(topic, true)]);
      expect(afterUnsubscribe.status).toBe("rejected");
      expect(h.calls.prs).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops on dispose and resumes afterwards", async () => {
      const h = createHarness();
      const topic = githubViewTopic("pr", "is:pr author:@me");
      h.subscribe(topic);
      await advanceTimersByTimeAsync(0);
      h.views.dispose();
      await advanceTimersByTimeAsync(120_000);
      expect(h.calls.prs).toHaveLength(1);
      h.views.resume();
      await advanceTimersByTimeAsync(0);
      expect(h.calls.prs).toHaveLength(2);
      await advanceTimersByTimeAsync(60_000);
      expect(h.calls.prs).toHaveLength(3);
      h.unsubscribe(topic);
    });
  });
});
