import type {
  AppSettings,
  GitHubAccountRef,
  GitHubContext,
  GitHubKind,
  GitHubMetaTopicData,
  GitHubRow,
  GitHubSearchResult,
  GitHubSubject,
  GitHubTabBadge,
  GitHubViewState,
  GitHubViewTopicData,
  IssueSummary,
  PrInboxResult,
  PrRef,
  PrSummary,
  RunRef,
  RunSources,
  RunsResult,
  SessionMeta,
  WorkflowRunSummary
} from "@cw-code/contracts";
import { queryProblems } from "@cw-code/shared/githubQueryDsl";
import { resolveViews } from "@cw-code/shared/githubViews";
import { prKey } from "@cw-code/shared/prRef";
import { GITHUB_META_TOPIC, parseGithubViewTopic } from "@cw-code/shared/topics";
import { githubContext } from "../prEngine/githubContext.js";
import { issueBucket, prBucket, runBucket, subjectRelations, type PrLookup } from "../prEngine/subjectRelations.js";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { MAX_COUNT_QUERIES } from "./issueQueries.js";
import { MAX_WATCHED_RUNS, runKey } from "./RunWatcher.js";
import {
  BADGE_KINDS,
  BADGE_QUERIES,
  applyLocalFilters,
  applyRunUpdates,
  assignedOpenIssueCount,
  buildLocalContext,
  buildRunContext,
  cappedRunSources,
  clonedReposOf,
  failingInvolvedRunCount,
  involvedPrKeysOf,
  isClonedIn,
  mentionsMode,
  prBadge,
  reconcileRuns,
  runMatches,
  scopeSplitQuery,
  searchKey,
  sortedRemoteOf,
  sortRuns,
  splitQuery,
  viewSort,
  watchedRunRefs,
  type LocalContext,
  type RunContext,
  type SplitQuery
} from "./viewQuery.js";

export interface GitHubViewsDeps {
  settings(): AppSettings;
  sessions(): SessionMeta[];
  context(): GitHubContext;
  inbox(): PrInboxResult | null;
  summaryLookup(): ReadonlyMap<string, PrSummary>;
  ensureContext(): Promise<unknown>;
  refreshInbox(force: boolean): Promise<void>;
  searchPrs(query: string, countBase: string, force: boolean): Promise<GitHubSearchResult<PrSummary>>;
  searchIssues(query: string, countBase: string, force: boolean): Promise<GitHubSearchResult<IssueSummary>>;
  fetchRuns(sources: RunSources, force: boolean): Promise<RunsResult>;
  counts(kind: "pr" | "issue", queries: string[]): Promise<Array<number | null>>;
  watchRuns(refs: RunRef[]): void;
  setRunWatchActive(active: boolean): void;
}

type SearchSpec =
  | { kind: "pr"; query: string; countBase: string }
  | { kind: "issue"; query: string; countBase: string }
  | { kind: "run"; sources: RunSources };

interface FetchMeta {
  account: GitHubAccountRef | null;
  openCount: number | null;
  closedCount: number | null;
  truncated: boolean;
  limit: number | null;
  fetchedAt: number;
  error: string | null;
}

type Fetched = ({ kind: "pr"; items: PrSummary[] } | { kind: "issue"; items: IssueSummary[] } | { kind: "run"; items: WorkflowRunSummary[] }) & FetchMeta;

interface SearchTarget {
  key: string;
  spec: SearchSpec;
}

interface SearchEntry extends SearchTarget {
  result: Fetched | null;
  error: string | null;
  loading: boolean;
  request: { promise: Promise<void>; force: boolean } | null;
  completedAt: number;
  lastUsed: number;
}

interface Memo<T> {
  json: string;
  value: T;
}

interface ViewState {
  kind: GitHubKind;
  query: string;
  split: SplitQuery | null;
  mentions: boolean;
  key: string | null;
  rows: Map<string, Memo<GitHubRow>>;
  listing: WorkflowRunSummary[];
}

type ViewTopic = ViewState & { store: TopicStore<GitHubViewTopicData> };

interface MetaTopic {
  store: TopicStore<GitHubMetaTopicData>;
  keys: string[];
}

interface Env {
  context: GitHubContext;
  viewer: string | null;
  inbox: PrInboxResult | null;
  sessions: SessionMeta[];
  workflows: AppSettings["prWorkflows"];
  lookupPr: PrLookup;
  local: LocalContext;
  run: RunContext;
}

interface CountsEntry {
  signature: string;
  at: number;
  promise: Promise<Record<string, number | null>>;
}

const VIEW_PREFIX = "github/view:";
const GITHUB_PREFIX = "github/";
const MIN_REFRESH_SECONDS = 30;
const DEFAULT_REFRESH_SECONDS = 120;
const REUSE_FRESH_MS = 15_000;
const VIEW_COUNTS_TTL_MS = 60_000;
const MAX_IDLE_ENTRIES = 20;
const LOG_PREFIX = "[github-views]";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueKey(issue: IssueSummary): string {
  return `${issue.ref.host}/${issue.ref.owner}/${issue.ref.repo}#${issue.ref.number}`;
}

function subjectKey(subject: GitHubSubject): string {
  if (subject.kind === "pr") return prKey(subject.pr.ref);
  if (subject.kind === "issue") return issueKey(subject.issue);
  return runKey(subject.run.ref);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function memoize<T>(cache: Map<string, Memo<T>>, key: string, value: T): T {
  const json = JSON.stringify(value);
  const cached = cache.get(key);
  if (cached?.json === json) return cached.value;
  cache.set(key, { json, value });
  return value;
}

function searchTarget(kind: GitHubKind, query: string, context: GitHubContext): SearchTarget | null {
  if (kind === "run") {
    const repos = clonedReposOf(context.projectRepos);
    return { key: searchKey("run", query, repos), spec: { kind: "run", sources: cappedRunSources(query, repos) } };
  }
  const split = scopeSplitQuery(splitQuery(kind, query));
  if (!split.remote.trim()) return null;
  return { key: searchKey(kind, query, []), spec: { kind, query: sortedRemoteOf(split), countBase: split.countBase } };
}

function fromRuns(result: RunsResult): Fetched {
  return { ...result, kind: "run", openCount: null, closedCount: null, truncated: false, limit: null };
}

function badgeTargets(context: GitHubContext): SearchTarget[] {
  return BADGE_KINDS.flatMap((kind) => searchTarget(kind, BADGE_QUERIES[kind], context) ?? []);
}

export class GitHubViews {
  readonly viewProvider: TopicProvider;
  readonly metaProvider: TopicProvider;
  private readonly topics = new Map<string, ViewTopic>();
  private readonly entries = new Map<string, SearchEntry>();
  private readonly counts = new Map<GitHubKind, CountsEntry>();
  private meta: MetaTopic | null = null;
  private legacyRunRefs: RunRef[] = [];
  private watchSignature: string | null = null;
  private watchActive: boolean | null = null;
  private searchViewer: string | null = null;
  private timer: { handle: ReturnType<typeof setInterval>; intervalMs: number } | null = null;
  private recomputePending = false;
  private disposed = false;
  private generation = 0;
  private clock = 0;

  constructor(
    private readonly hub: TopicHub,
    private readonly deps: GitHubViewsDeps
  ) {
    this.viewProvider = {
      owns: (topic) => topic.startsWith(VIEW_PREFIX),
      acquire: (topic) => this.acquireView(topic),
      release: (topic) => this.releaseView(topic),
      resync: () => this.invalidate()
    };
    this.metaProvider = {
      owns: (topic) => topic === GITHUB_META_TOPIC,
      exactTopics: [GITHUB_META_TOPIC],
      acquire: () => this.acquireMeta(),
      release: () => this.releaseMeta(),
      resync: () => this.invalidate()
    };
  }

  async refresh(topic: string, force: boolean): Promise<void> {
    if (topic === GITHUB_META_TOPIC) {
      if (!this.meta) return;
      const inbox = this.deps.refreshInbox(force).catch((error: unknown) => {
        console.warn(`${LOG_PREFIX} inbox refresh failed: ${describeError(error)}`);
      });
      await Promise.all([inbox, ...this.metaEntries().map((entry) => this.fetchEntry(entry, force))]);
      return;
    }
    const state = this.topics.get(topic);
    const entry = state?.key ? this.entries.get(state.key) : undefined;
    if (entry) await this.fetchEntry(entry, force);
  }

  viewCounts(kind: GitHubKind): Promise<Record<string, number | null>> {
    const views = resolveViews(kind, this.context().org, this.deps.settings().githubSavedViews);
    const signature = views.map((view) => `${view.id}=${view.query}`).join("\n");
    const cached = this.counts.get(kind);
    if (cached && cached.signature === signature && Date.now() - cached.at < VIEW_COUNTS_TTL_MS) return cached.promise;
    const promise = this.computeCounts(kind, views);
    const entry: CountsEntry = { signature, at: Date.now(), promise };
    this.counts.set(kind, entry);
    promise.catch(() => {
      if (this.counts.get(kind) === entry) this.counts.delete(kind);
    });
    return promise;
  }

  setLegacyRunRefs(refs: RunRef[]): void {
    this.legacyRunRefs = refs;
    this.syncRunWatch();
  }

  syncRunWatch(): void {
    if (this.disposed) return;
    const active = this.hub.activeTopics(GITHUB_PREFIX).length > 0;
    const refs = active ? this.watchSet() : [];
    const signature = refs.map(runKey).sort().join("|");
    if (signature !== this.watchSignature) {
      this.watchSignature = signature;
      this.deps.watchRuns(refs);
    }
    if (active !== this.watchActive) {
      this.watchActive = active;
      this.deps.setRunWatchActive(active);
    }
  }

  runsChanged(runs: WorkflowRunSummary[]): void {
    const updates = new Map(runs.map((run) => [run.ref.runId, run]));
    let changed = false;
    for (const entry of this.entries.values()) {
      const result = entry.result;
      if (result?.kind !== "run") continue;
      const items = applyRunUpdates(result.items, updates);
      if (items === result.items) continue;
      entry.result = { ...result, items };
      changed = true;
    }
    if (changed) this.invalidate();
  }

  ciActivity(): void {
    const keys = new Set<string>();
    for (const state of this.topics.values()) if (state.kind === "run" && state.key) keys.add(state.key);
    for (const key of this.meta?.keys ?? []) if (this.entries.get(key)?.spec.kind === "run") keys.add(key);
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) void this.fetchEntry(entry, true);
    }
  }

  reevaluate(): void {
    this.invalidate();
  }

  onSettingsChanged(): void {
    if (this.timer && this.timer.intervalMs !== this.intervalMs()) this.startTimer();
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.stopTimer();
    this.recomputePending = false;
    for (const entry of this.entries.values()) {
      entry.request = null;
      entry.loading = false;
    }
    this.counts.clear();
    this.watchSignature = null;
    this.watchActive = null;
  }

  resume(): void {
    if (!this.disposed) return;
    this.disposed = false;
    if (this.hasUsers()) {
      this.startTimer();
      this.refreshUsed();
    }
    this.invalidate();
  }

  private acquireView(topic: string): TopicStore<GitHubViewTopicData> {
    const parsed = parseGithubViewTopic(topic);
    if (!parsed) throw new Error(`invalid GitHub view topic '${topic}'`);
    const wasIdle = !this.hasUsers();
    const env = this.env();
    const { kind, query } = parsed;
    const target = searchTarget(kind, query, env.context);
    if (target) this.use(target);
    const base: ViewState = {
      kind,
      query,
      split: kind === "run" ? null : scopeSplitQuery(splitQuery(kind, query)),
      mentions: mentionsMode(query),
      key: target?.key ?? null,
      rows: new Map(),
      listing: []
    };
    const store = this.hub.createStore<GitHubViewTopicData>(topic, this.viewData(base, env));
    this.topics.set(topic, Object.assign(base, { store }));
    this.activated(wasIdle);
    return store;
  }

  private releaseView(topic: string): void {
    if (!this.topics.delete(topic)) return;
    this.deactivated();
  }

  private acquireMeta(): TopicStore<GitHubMetaTopicData> {
    const wasIdle = !this.hasUsers();
    const env = this.env();
    const keys = badgeTargets(env.context).map((target) => this.use(target).key);
    const store = this.hub.createStore<GitHubMetaTopicData>(GITHUB_META_TOPIC, this.metaData(keys, env));
    this.meta = { keys, store };
    this.activated(wasIdle);
    return store;
  }

  private releaseMeta(): void {
    if (!this.meta) return;
    this.meta = null;
    this.deactivated();
  }

  private activated(wasIdle: boolean): void {
    if (wasIdle) {
      this.deps.ensureContext().catch((error: unknown) => {
        console.warn(`${LOG_PREFIX} project repo lookup failed: ${describeError(error)}`);
      });
    }
    if (!this.timer) this.startTimer();
    this.syncRunWatch();
  }

  private deactivated(): void {
    if (!this.hasUsers()) this.stopTimer();
    this.pruneEntries();
    this.syncRunWatch();
  }

  private hasUsers(): boolean {
    return this.topics.size > 0 || this.meta !== null;
  }

  private intervalMs(): number {
    return Math.max(MIN_REFRESH_SECONDS, this.deps.settings().prRefreshIntervalSeconds || DEFAULT_REFRESH_SECONDS) * 1000;
  }

  private startTimer(): void {
    this.stopTimer();
    if (this.disposed) return;
    const intervalMs = this.intervalMs();
    const handle = setInterval(() => this.refreshUsed(), intervalMs);
    handle.unref?.();
    this.timer = { handle, intervalMs };
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer.handle);
    this.timer = null;
  }

  private refreshUsed(): void {
    for (const key of this.usedKeys()) {
      const entry = this.entries.get(key);
      if (entry) void this.fetchEntry(entry, false);
    }
  }

  private usedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const state of this.topics.values()) if (state.key) keys.add(state.key);
    for (const key of this.meta?.keys ?? []) keys.add(key);
    return keys;
  }

  private metaEntries(): SearchEntry[] {
    return (this.meta?.keys ?? []).flatMap((key) => this.entries.get(key) ?? []);
  }

  private use(target: SearchTarget): SearchEntry {
    let entry = this.entries.get(target.key);
    if (!entry) {
      entry = { ...target, result: null, error: null, loading: false, request: null, completedAt: 0, lastUsed: 0 };
      this.entries.set(target.key, entry);
    }
    entry.lastUsed = ++this.clock;
    const fresh = entry.result !== null && entry.error === null && Date.now() - entry.completedAt < REUSE_FRESH_MS;
    if (!fresh && !entry.request) void this.fetchEntry(entry, false);
    return entry;
  }

  private pruneEntries(): void {
    const used = this.usedKeys();
    const idle = [...this.entries.values()].filter((entry) => !used.has(entry.key)).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const entry of idle.slice(MAX_IDLE_ENTRIES)) this.entries.delete(entry.key);
  }

  private fetchEntry(entry: SearchEntry, force: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const running = entry.request;
    if (running) {
      if (!force || running.force) return running.promise;
      return running.promise.then(() => this.fetchEntry(entry, true));
    }
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && this.entries.get(entry.key) === entry;
    entry.loading = true;
    const promise = this.runFetch(entry.spec, force)
      .then(
        (fetched) => {
          if (!isCurrent()) return;
          entry.result = fetched.kind === "run" ? { ...fetched, items: reconcileRuns(fetched.items, this.knownRuns()) } : fetched;
          entry.error = fetched.error;
          if (fetched.account) this.searchViewer = fetched.account.login;
        },
        (error: unknown) => {
          if (!isCurrent()) return;
          entry.error = describeError(error);
          console.warn(`${LOG_PREFIX} ${entry.spec.kind} fetch failed: ${entry.error}`);
        }
      )
      .finally(() => {
        if (!isCurrent()) return;
        entry.completedAt = Date.now();
        entry.loading = false;
        if (entry.request?.promise === promise) entry.request = null;
        this.invalidate();
      });
    entry.request = { promise, force };
    this.invalidate();
    return promise;
  }

  private async runFetch(spec: SearchSpec, force: boolean): Promise<Fetched> {
    if (spec.kind === "run") return fromRuns(await this.deps.fetchRuns(spec.sources, force));
    if (spec.kind === "pr") return { ...(await this.deps.searchPrs(spec.query, spec.countBase, force)), kind: "pr" };
    return { ...(await this.deps.searchIssues(spec.query, spec.countBase, force)), kind: "issue" };
  }

  private knownRuns(): WorkflowRunSummary[] {
    return [...this.entries.values()].flatMap((entry) => (entry.result?.kind === "run" ? entry.result.items : []));
  }

  private cachedPrs(): PrSummary[] {
    return [...this.entries.values()].flatMap((entry) => (entry.result?.kind === "pr" ? entry.result.items : []));
  }

  private async computeCounts(kind: GitHubKind, views: Array<{ id: string; query: string }>): Promise<Record<string, number | null>> {
    const counts: Record<string, number | null> = {};
    if (kind === "run") {
      for (const view of views) counts[view.id] = null;
      return counts;
    }
    const counted: Array<{ id: string; query: string }> = [];
    for (const view of views) {
      const split = splitQuery(kind, view.query);
      if (split.local.length > 0) counts[view.id] = null;
      else counted.push({ id: view.id, query: split.remote });
    }
    const batches = chunk(counted, MAX_COUNT_QUERIES);
    const results = await Promise.all(batches.map((batch) => this.deps.counts(kind, batch.map((item) => item.query))));
    batches.forEach((batch, batchIndex) => {
      batch.forEach((item, index) => {
        counts[item.id] = results[batchIndex]?.[index] ?? null;
      });
    });
    return counts;
  }

  private watchSet(): RunRef[] {
    const listings = [...this.topics.values()].filter((state) => state.kind === "run").map((state) => state.listing);
    const picked = new Map<string, RunRef>();
    for (const ref of [...watchedRunRefs(listings, MAX_WATCHED_RUNS), ...this.legacyRunRefs]) {
      if (picked.size >= MAX_WATCHED_RUNS) break;
      const key = runKey(ref);
      if (!picked.has(key)) picked.set(key, ref);
    }
    return [...picked.values()];
  }

  private invalidate(): void {
    if (this.recomputePending || this.disposed) return;
    this.recomputePending = true;
    queueMicrotask(() => {
      if (!this.recomputePending) return;
      this.recompute();
    });
  }

  private recompute(): void {
    this.recomputePending = false;
    try {
      const env = this.env();
      for (const state of this.topics.values()) {
        this.rekey(state, env);
        state.store.sync(this.viewData(state, env));
      }
      const meta = this.meta;
      if (meta) {
        const targets = badgeTargets(env.context);
        if (targets.map((target) => target.key).join("\n") !== meta.keys.join("\n")) meta.keys = targets.map((target) => this.use(target).key);
        meta.store.sync(this.metaData(meta.keys, env));
      }
      this.pruneEntries();
      this.syncRunWatch();
    } catch (error) {
      console.warn(`${LOG_PREFIX} recompute failed: ${describeError(error)}`);
    }
  }

  private rekey(state: ViewState, env: Env): void {
    if (state.kind !== "run") return;
    const target = searchTarget(state.kind, state.query, env.context);
    if (!target || target.key === state.key) return;
    state.key = target.key;
    this.use(target);
  }

  private context(): GitHubContext {
    const context = this.deps.context();
    const viewer = this.searchViewer ?? context.viewer;
    return viewer === context.viewer ? context : githubContext(context.projectRepos, viewer);
  }

  private env(): Env {
    const context = this.context();
    const inbox = this.deps.inbox();
    const viewer = context.viewer;
    const sessions = this.deps.sessions();
    const lookup = this.deps.summaryLookup();
    const involved = involvedPrKeysOf(inbox?.items ?? [], this.cachedPrs(), viewer);
    return {
      context,
      viewer,
      inbox,
      sessions,
      workflows: this.deps.settings().prWorkflows,
      lookupPr: (ref: PrRef) => lookup.get(prKey(ref)),
      local: buildLocalContext(sessions, (repo) => isClonedIn(context.projectRepos, repo)),
      run: buildRunContext(viewer, involved, sessions)
    };
  }

  private subjects(state: ViewState, env: Env): GitHubSubject[] {
    const entry = state.key ? this.entries.get(state.key) : undefined;
    const result = entry?.result;
    if (!result) return [];
    if (result.kind === "run") {
      const runs = result.items.filter((run) => runMatches(run, state.query, env.run));
      return sortRuns(runs, viewSort("run", state.query)).map((run) => ({ kind: "run", run }));
    }
    const local = state.split?.local ?? [];
    if (result.kind === "pr") return applyLocalFilters(result.items, local, env.local).map((pr) => ({ kind: "pr", pr }));
    return applyLocalFilters(result.items, local, env.local).map((issue) => ({ kind: "issue", issue }));
  }

  private bucketOf(subject: GitHubSubject, state: ViewState, env: Env): string {
    if (subject.kind === "pr") return prBucket(subject.pr);
    if (subject.kind === "issue") return issueBucket(subject.issue, env.viewer, state.mentions);
    return runBucket(subject.run);
  }

  private viewData(state: ViewState, env: Env): GitHubViewTopicData {
    const entry = state.key ? this.entries.get(state.key) : undefined;
    const result = entry?.result ?? null;
    const view: GitHubViewState = {
      kind: state.kind,
      query: state.query,
      sort: viewSort(state.kind, state.query),
      problems: queryProblems(state.kind, state.query),
      loading: entry?.loading ?? false,
      error: entry?.error ?? null,
      account: result?.account ?? env.inbox?.account ?? null,
      openCount: result?.openCount ?? null,
      closedCount: result?.closedCount ?? null,
      truncated: result?.truncated ?? false,
      limit: result?.limit ?? null,
      fetchedAt: result?.fetchedAt ?? null
    };
    const subjects = this.subjects(state, env);
    const data: Record<string, unknown> = { view };
    const seen = new Set<string>();
    subjects.forEach((subject, seq) => {
      const key = subjectKey(subject);
      if (seen.has(key)) return;
      seen.add(key);
      const row: GitHubRow = {
        seq,
        subject,
        bucket: this.bucketOf(subject, state, env),
        relations: subjectRelations(subject, env.sessions, env.workflows, env.viewer, env.lookupPr)
      };
      data[`row/${key}`] = memoize(state.rows, key, row);
    });
    for (const key of state.rows.keys()) if (!seen.has(key)) state.rows.delete(key);
    state.listing = subjects.flatMap((subject) => (subject.kind === "run" ? [subject.run] : []));
    return data as GitHubViewTopicData;
  }

  private metaData(keys: string[], env: Env): GitHubMetaTopicData {
    const saved = this.deps.settings().githubSavedViews;
    const org = env.context.org;
    const results = keys.flatMap((key) => this.entries.get(key)?.result ?? []);
    const issues = results.find((result) => result.kind === "issue");
    const runs = results.find((result) => result.kind === "run");
    const issueBadge: GitHubTabBadge | null = issues?.kind === "issue" ? { count: assignedOpenIssueCount(issues.items, env.viewer), tone: "quiet" } : null;
    const runBadge: GitHubTabBadge | null = runs?.kind === "run" ? { count: failingInvolvedRunCount(runs.items, env.run), tone: "bad" } : null;
    return {
      context: env.context,
      views: { pr: resolveViews("pr", org, saved), issue: resolveViews("issue", org, saved), run: resolveViews("run", org, saved) },
      badges: { pr: env.inbox ? prBadge(env.inbox.items) : null, issue: issueBadge, run: runBadge }
    };
  }
}
