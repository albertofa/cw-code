import { create } from "zustand";
import type {
  GitHubAccountRef,
  GitHubKind,
  GitHubSearchResult,
  GitHubViewDef,
  GitHubViewGroup,
  IssueSummary,
  PrSummary,
  ProjectGitHubRepo,
  RepoRef,
  RunRef,
  RunSources,
  RunsResult,
  SavedGitHubView,
  WorkflowRunSummary
} from "../cw.js";
import {
  DEFAULT_REMOTE_SORT,
  definitionOf,
  isStateToken,
  joinTokens,
  kindFromQuery,
  lowerValue,
  normalizeQuery,
  sortKeysFor,
  tokenProblem,
  tokenize,
  uniqueBy,
  type QueryToken
} from "@cw-code/shared/githubQueryDsl";
import { BUILTIN_VIEWS, MAX_QUERY_LENGTH, MAX_SAVED_VIEWS, MAX_VIEW_NAME_LENGTH, resolveViews } from "@cw-code/shared/githubViews";
import { GITHUB_RUNS_TOPIC } from "@cw-code/shared/topics";
import { errorMessage } from "../components/errorMessage.js";
import type { LocalFilter } from "../components/githubViewQueryLegacy.js";
import { useAppStore } from "./appStore.js";
import { usePrStore } from "./prStore.js";

export interface GitHubTabState {
  query: string;
  viewId: string | null;
  group: GitHubViewGroup;
  collapsed: string[];
}

export type Loadable<T> = { loading: boolean; data: T | null; error: string | null; stale?: boolean };

export type GitHubView = GitHubViewDef;

export interface GitHubStore {
  kind: GitHubKind;
  tabs: Record<GitHubKind, GitHubTabState>;
  prResults: Record<string, Loadable<GitHubSearchResult<PrSummary>>>;
  issueResults: Record<string, Loadable<GitHubSearchResult<IssueSummary>>>;
  runResults: Record<string, Loadable<RunsResult>>;
  viewCounts: Record<string, number | null>;
  savedViews: SavedGitHubView[];
  viewer: string | null;
  org: string | null;
  active: boolean;
  error: string | null;
  setKind(kind: GitHubKind): void;
  setQuery(kind: GitHubKind, query: string): void;
  selectView(viewId: string): void;
  setGroup(kind: GitHubKind, group: GitHubViewGroup): void;
  toggleCollapsed(kind: GitHubKind, groupId: string): void;
  refresh(force?: boolean): Promise<void>;
  loadViewCounts(kind: GitHubKind): Promise<void>;
  saveView(name: string): Promise<void>;
  renameView(id: string, name: string): Promise<void>;
  deleteView(id: string): Promise<void>;
  applySavedViews(views: SavedGitHubView[]): void;
  setActive(active: boolean, force?: boolean): void;
  setWatchedRuns(refs: RunRef[]): void;
  syncContext(): void;
  clearError(): void;
}

const QUERY_DEBOUNCE_MS = 350;
const VIEW_COUNTS_TTL_MS = 60_000;
const MAX_WATCHED_RUNS = 30;
const MAX_COUNT_QUERIES = 20;
export const MAX_RESULT_ENTRIES_PER_KIND = 20;
const MAX_SOURCE_REPOS = 20;
const MAX_SOURCE_ORGS = 5;
const MIN_REFRESH_SECONDS = 30;
const DEFAULT_REFRESH_SECONDS = 120;

const KINDS: GitHubKind[] = ["pr", "issue", "run"];

function initialTab(kind: GitHubKind): GitHubTabState {
  const view = BUILTIN_VIEWS.find((item) => item.kind === kind && item.id.endsWith(":inbox")) ?? BUILTIN_VIEWS.find((item) => item.kind === kind);
  return { query: view?.query ?? `is:${kind}`, viewId: view?.id ?? null, group: view?.group ?? "none", collapsed: [] };
}

const GITHUB_HOST = "github.com";

function onGitHub(repo: ProjectGitHubRepo): boolean {
  return repo.host.toLowerCase() === GITHUB_HOST;
}

export function githubProjectRepos(repos: ProjectGitHubRepo[]): ProjectGitHubRepo[] {
  return repos.filter(onGitHub);
}

export function orgFromRepos(repos: ProjectGitHubRepo[], viewer: string | null): string | null {
  if (!viewer) return null;
  const login = viewer.toLowerCase();
  return repos.find((repo) => onGitHub(repo) && repo.owner.toLowerCase() !== login)?.owner ?? null;
}

export function clonedReposOf(repos: ProjectGitHubRepo[]): RepoRef[] {
  return githubProjectRepos(repos).map((repo) => ({ host: repo.host, owner: repo.owner, repo: repo.repo }));
}

export interface SplitQuery {
  remote: string;
  countBase: string;
  local: LocalFilter[];
  sort: string;
}

const DEFAULT_HOST = "github.com";

function isLocalToken(t: QueryToken): boolean {
  if (t.kind !== "qual") return false;
  const value = lowerValue(t);
  if (t.key === "has") return value === "" || value === "session";
  if (t.key === "cloned") return true;
  return t.key === "is" && value === "unread";
}

function localFilterOf(t: QueryToken): LocalFilter | null {
  const value = lowerValue(t);
  if (t.key === "has" && value === "session") return { key: "has", value, neg: !!t.neg };
  if (t.key === "cloned" && (value === "true" || value === "false")) return { key: "cloned", value, neg: !!t.neg };
  if (t.key === "is" && value === "unread") return { key: "is", value, neg: !!t.neg };
  return null;
}

export function splitQuery(kind: "pr" | "issue", q: string): SplitQuery {
  const tokens = tokenize(q);
  const local: LocalFilter[] = [];
  const remoteTokens: QueryToken[] = [];
  let sort = DEFAULT_REMOTE_SORT;
  const validSorts = sortKeysFor(kind);
  for (const t of tokens) {
    if (t.kind === "space") continue;
    const invalidValue = t.kind === "qual" && !!t.key && !!definitionOf(kind, t.key) && !!tokenProblem(kind, t);
    if (t.kind === "qual" && (isLocalToken(t) || !t.value || invalidValue)) {
      const filter = localFilterOf(t);
      if (filter) local.push(filter);
      continue;
    }
    if (t.kind === "qual" && !t.neg && t.key === "sort" && validSorts.includes(lowerValue(t))) sort = lowerValue(t);
    remoteTokens.push(t);
  }
  return {
    remote: joinTokens(remoteTokens),
    countBase: joinTokens(remoteTokens.filter((t) => !isStateToken(t))),
    local,
    sort
  };
}

export function sortedRemoteOf(split: SplitQuery): string {
  const hasSort = tokenize(split.remote).some((t) => t.kind === "qual" && !t.neg && t.key === "sort");
  return hasSort ? split.remote : `${split.remote} sort:${split.sort}`.trim();
}

export function runSources(q: string, clonedRepos: RepoRef[]): RunSources {
  const tokens = tokenize(q).filter((t) => t.kind === "qual" && !t.neg && !!t.value);
  const orgs = uniqueBy(
    tokens.filter((t) => t.key === "org").map((t) => t.value ?? ""),
    (org) => org
  );
  const repoNames = uniqueBy(
    tokens.map((t) => (t.key === "repo" ? (t.value ?? "") : "")).filter((v) => /^[^/\s]+\/[^/\s]+$/.test(v)),
    (name) => name
  );

  if (orgs.length === 0 && repoNames.length === 0) {
    return {
      prSearchQuery: "is:pr is:open involves:@me archived:false",
      repos: uniqueBy(clonedRepos, (r) => `${r.host}/${r.owner}/${r.repo}`),
      orgs: []
    };
  }

  const repos = repoNames.map((name): RepoRef => {
    const [owner, repo] = name.split("/");
    const cloned = clonedRepos.find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase());
    return { host: cloned?.host ?? DEFAULT_HOST, owner, repo };
  });
  const scopes = [...orgs.map((org) => `org:${org}`), ...repoNames.map((name) => `repo:${name}`)];
  const archived = orgs.length > 0 ? " archived:false" : "";
  return { prSearchQuery: `is:pr is:open ${scopes.join(" ")}${archived}`, repos, orgs };
}

export function cappedRunSources(query: string, clonedRepos: RepoRef[]): RunSources {
  const sources = runSources(query, clonedRepos);
  return { ...sources, repos: sources.repos.slice(0, MAX_SOURCE_REPOS), orgs: sources.orgs.slice(0, MAX_SOURCE_ORGS) };
}

const SCOPING_KEYS: ReadonlySet<string> = new Set([
  "author",
  "assignee",
  "involves",
  "mentions",
  "review-requested",
  "reviewed-by",
  "team-review-requested",
  "commenter",
  "org",
  "repo",
  "user",
  "head",
  "base"
]);
const SCOPE_QUALIFIER = "involves:@me";

function scoped(query: string): string {
  const hasScope = tokenize(query).some((token) => token.kind === "qual" && !token.neg && SCOPING_KEYS.has(token.key ?? ""));
  return hasScope ? query : `${query} ${SCOPE_QUALIFIER}`.trim();
}

export function scopeSplitQuery(split: SplitQuery): SplitQuery {
  if (split.local.length === 0) return split;
  return { ...split, remote: scoped(split.remote), countBase: scoped(split.countBase) };
}

export function scopedSplitOf(kind: "pr" | "issue", query: string): SplitQuery {
  return scopeSplitQuery(splitQuery(kind, query));
}

export function searchKey(kind: GitHubKind, query: string, clonedRepos: RepoRef[]): string {
  if (kind === "run") return `run:${JSON.stringify(cappedRunSources(query, clonedRepos))}`;
  return `${kind}:${normalizeQuery(scopeSplitQuery(splitQuery(kind, query)).remote)}`;
}

function builtinQuery(id: string): string {
  return BUILTIN_VIEWS.find((view) => view.id === id)?.query ?? "";
}

type BadgeKind = "issue" | "run";

const BADGE_KINDS: BadgeKind[] = ["issue", "run"];

const BADGE_QUERIES: Record<BadgeKind, string> = {
  issue: builtinQuery("issue:inbox"),
  run: builtinQuery("run:watching")
};

export function badgeSearchKeys(clonedRepos: RepoRef[]): Record<BadgeKind, string> {
  return {
    issue: searchKey("issue", BADGE_QUERIES.issue, []),
    run: searchKey("run", BADGE_QUERIES.run, clonedRepos)
  };
}

const SAVED_VIEWS_LOADING = "Saved views are still loading";

export function evictionCandidates(keys: string[], touched: ReadonlyMap<string, number>, protectedKeys: ReadonlySet<string | null>, max: number): string[] {
  if (keys.length <= max) return [];
  return keys
    .filter((key) => !protectedKeys.has(key))
    .sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0))
    .slice(0, keys.length - max);
}

function runKeyOf(ref: RunRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.runId}`;
}

function mergeRun(existing: WorkflowRunSummary, update: WorkflowRunSummary): WorkflowRunSummary {
  return {
    ...existing,
    status: update.status,
    conclusion: update.conclusion,
    jobs: update.jobs,
    updatedAt: update.updatedAt
  };
}

function mergeRuns(
  results: Record<string, Loadable<RunsResult>>,
  updates: Map<number, WorkflowRunSummary>
): Record<string, Loadable<RunsResult>> {
  let changed = false;
  const next: Record<string, Loadable<RunsResult>> = {};
  for (const [key, entry] of Object.entries(results)) {
    const data = entry.data;
    if (!data || !data.items.some((run) => updates.has(run.ref.runId))) {
      next[key] = entry;
      continue;
    }
    changed = true;
    const items = data.items.map((run) => {
      const update = updates.get(run.ref.runId);
      return update ? mergeRun(run, update) : run;
    });
    next[key] = { ...entry, data: { ...data, items } };
  }
  return changed ? next : results;
}

function validateViewName(name: string): string | null {
  if (!name) return "View name cannot be empty";
  if (name.length > MAX_VIEW_NAME_LENGTH) return `View name is limited to ${MAX_VIEW_NAME_LENGTH} characters`;
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function withEntry<T>(record: Record<string, Loadable<T>>, key: string, next: Loadable<T>): Record<string, Loadable<T>> {
  return { ...record, [key]: next };
}

function reconcileRuns(incoming: RunsResult, existing: Record<string, Loadable<RunsResult>>): RunsResult {
  const newest = new Map<number, WorkflowRunSummary>();
  for (const entry of Object.values(existing)) {
    for (const run of entry.data?.items ?? []) {
      const seen = newest.get(run.ref.runId);
      if (!seen || run.updatedAt > seen.updatedAt) newest.set(run.ref.runId, run);
    }
  }
  const items = incoming.items.map((run) => {
    const known = newest.get(run.ref.runId);
    return known && known.updatedAt > run.updatedAt ? mergeRun(run, known) : run;
  });
  return { ...incoming, items };
}

let teardownRuntime: () => void = () => undefined;
let runsTopicDisposer: (() => void) | null = null;

function holdRunsTopic(): void {
  if (runsTopicDisposer) return;
  runsTopicDisposer = window.cw.topics.acquire(GITHUB_RUNS_TOPIC);
}

function releaseRunsTopic(): void {
  runsTopicDisposer?.();
  runsTopicDisposer = null;
}

export const useGitHubStore = create<GitHubStore>((set, get) => {
  const keySequences = new Map<string, number>();
  const latestKeys: Record<GitHubKind, string | null> = { pr: null, issue: null, run: null };
  const settledKeys: Record<GitHubKind, string | null> = { pr: null, issue: null, run: null };
  const timers: Record<GitHubKind, ReturnType<typeof setTimeout> | null> = { pr: null, issue: null, run: null };
  const countsLoadedAt: Record<GitHubKind, { at: number; signature: string } | null> = { pr: null, issue: null, run: null };
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribers: Array<() => void> = [];
  let watchedSignature: string | null = null;
  let requestedRuns: RunRef[] = [];
  const touched = new Map<string, number>();
  let touchClock = 0;
  let persistFailure: string | null = null;
  let savedViewsLoaded = false;
  let mutations: Promise<void> = Promise.resolve();

  const fail = (context: string, err: unknown): string => {
    const message = errorMessage(err);
    console.warn(`[github] ${context}: ${message}`);
    set({ error: message });
    return message;
  };

  const noteViewer = (account: GitHubAccountRef | null) => {
    if (account && account.login !== get().viewer) {
      set({ viewer: account.login });
      get().syncContext();
    }
  };

  const touch = (key: string) => {
    touchClock += 1;
    touched.set(key, touchClock);
  };

  function prune<T>(kind: GitHubKind, select: (state: GitHubStore) => Record<string, Loadable<T>>, assign: (results: Record<string, Loadable<T>>) => Partial<GitHubStore>) {
    const results = select(get());
    const badgeKeys = badgeSearchKeys(clonedRepos());
    const protectedKeys = new Set<string | null>([latestKeys[kind], settledKeys[kind], kind === "issue" ? badgeKeys.issue : null, kind === "run" ? badgeKeys.run : null]);
    const dropped = evictionCandidates(Object.keys(results), touched, protectedKeys, MAX_RESULT_ENTRIES_PER_KIND);
    if (dropped.length === 0) return;
    const next = { ...results };
    for (const key of dropped) {
      delete next[key];
      touched.delete(key);
    }
    set(assign(next));
  }

  const clonedRepos = (): RepoRef[] => clonedReposOf(usePrStore.getState().projectRepos);

  const cancelTimer = (kind: GitHubKind) => {
    const timer = timers[kind];
    if (timer !== null) clearTimeout(timer);
    timers[kind] = null;
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = mutations.then(task);
    mutations = run.catch(() => undefined);
    return run;
  };

  async function load<T extends { account: GitHubAccountRef | null; error: string | null }>(
    kind: GitHubKind,
    key: string,
    track: boolean,
    select: (state: GitHubStore) => Record<string, Loadable<T>>,
    assign: (results: Record<string, Loadable<T>>) => Partial<GitHubStore>,
    fetcher: () => Promise<T>,
    reconcile: (incoming: T, existing: Record<string, Loadable<T>>) => T = (incoming) => incoming
  ): Promise<void> {
    const sequence = (keySequences.get(key) ?? 0) + 1;
    keySequences.set(key, sequence);
    if (track) latestKeys[kind] = key;
    const results = select(get());
    const own = results[key];
    const settledKey = track ? settledKeys[kind] : null;
    const seed = own?.data ? null : settledKey && settledKey !== key ? (results[settledKey]?.data ?? null) : null;
    const loading: Loadable<T> = seed
      ? { loading: true, data: seed, error: null, stale: true }
      : { loading: true, data: own?.data ?? null, error: null, ...(own?.stale ? { stale: true } : {}) };
    touch(key);
    set((state) => assign(withEntry(select(state), key, loading)));
    prune(kind, select, assign);
    const settle = (next: Loadable<T>) => {
      touch(key);
      set((state) => assign(withEntry(select(state), key, next)));
      prune(kind, select, assign);
    };
    try {
      const fetched = await fetcher();
      if (keySequences.get(key) !== sequence) return;
      const data = reconcile(fetched, select(get()));
      settle({ loading: false, data, error: data.error });
      if (track && data.error === null && latestKeys[kind] === key) settledKeys[kind] = key;
      noteViewer(data.account);
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[github] ${kind} fetch failed: ${message}`);
      if (keySequences.get(key) !== sequence) return;
      const current = select(get())[key];
      settle({ loading: false, data: current && !current.stale ? current.data : null, error: message });
    }
  }

  async function fetchQuery(kind: GitHubKind, query: string, force: boolean, track: boolean): Promise<void> {
    if (kind === "run") {
      const repos = clonedRepos();
      const sources = cappedRunSources(query, repos);
      await load(
        "run",
        searchKey("run", query, repos),
        track,
        (state) => state.runResults,
        (runResults) => ({ runResults }),
        () => window.cw.getGitHubRuns(sources, force),
        reconcileRuns
      );
      return;
    }
    const split = scopeSplitQuery(splitQuery(kind, query));
    if (!split.remote.trim()) return;
    const key = searchKey(kind, query, []);
    if (kind === "pr") {
      await load(
        "pr",
        key,
        track,
        (state) => state.prResults,
        (prResults) => ({ prResults }),
        () => window.cw.searchGitHub("pr", sortedRemoteOf(split), split.countBase, force)
      );
      return;
    }
    await load(
      "issue",
      key,
      track,
      (state) => state.issueResults,
      (issueResults) => ({ issueResults }),
      () => window.cw.searchGitHub("issue", sortedRemoteOf(split), split.countBase, force)
    );
  }

  async function fetchKind(kind: GitHubKind, force: boolean): Promise<void> {
    cancelTimer(kind);
    await fetchQuery(kind, get().tabs[kind].query, force, true);
  }

  const refreshBadges = (onlyMissing: boolean) => {
    const repos = clonedRepos();
    const keys = badgeSearchKeys(repos);
    const current = get().kind;
    for (const kind of BADGE_KINDS) {
      const key = keys[kind];
      if (kind === current && key === searchKey(kind, get().tabs[kind].query, repos)) continue;
      const entry = kind === "issue" ? get().issueResults[key] : get().runResults[key];
      if (entry?.loading || (onlyMissing && entry?.data)) continue;
      void fetchQuery(kind, BADGE_QUERIES[kind], false, false);
    }
  };

  const scheduleFetch = (kind: GitHubKind) => {
    cancelTimer(kind);
    timers[kind] = setTimeout(() => {
      timers[kind] = null;
      void fetchKind(kind, false);
    }, QUERY_DEBOUNCE_MS);
  };

  const hasResult = (kind: GitHubKind): boolean => {
    const key = searchKey(kind, get().tabs[kind].query, clonedRepos());
    const results = kind === "pr" ? get().prResults : kind === "issue" ? get().issueResults : get().runResults;
    return key in results;
  };

  const updateTab = (kind: GitHubKind, patch: Partial<GitHubTabState>) => {
    set((state) => ({ tabs: { ...state.tabs, [kind]: { ...state.tabs[kind], ...patch } } }));
  };

  const matchingViewId = (kind: GitHubKind, query: string): string | null => {
    const normalized = normalizeQuery(query);
    return resolveViews(kind, get().org, get().savedViews).find((view) => normalizeQuery(view.query) === normalized)?.id ?? null;
  };

  const persistViews = async (next: SavedGitHubView[]): Promise<boolean> => {
    try {
      const saved = await window.cw.setSettings({ githubSavedViews: next });
      const ownError = persistFailure;
      persistFailure = null;
      set((state) => ({ savedViews: saved.githubSavedViews ?? next, error: ownError !== null && state.error === ownError ? null : state.error }));
      return true;
    } catch (err) {
      persistFailure = fail("saving views failed", err);
      return false;
    }
  };

  const savedViewsReady = (): boolean => {
    if (savedViewsLoaded) return true;
    set({ error: SAVED_VIEWS_LOADING });
    return false;
  };

  const scheduleRefresh = () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    const seconds = Math.max(MIN_REFRESH_SECONDS, useAppStore.getState().prRefreshIntervalSeconds || DEFAULT_REFRESH_SECONDS);
    refreshTimer = setTimeout(() => {
      void fetchKind(get().kind, false);
      refreshBadges(false);
      scheduleRefresh();
    }, seconds * 1000);
  };

  const stopRefresh = () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
  };

  const subscribe = () => {
    if (unsubscribers.length > 0) return;
    unsubscribers = [
      window.cw.onGitHubRunsChanged((runs) => {
        const updates = new Map(runs.map((run) => [run.ref.runId, run]));
        set((state) => {
          const runResults = mergeRuns(state.runResults, updates);
          return runResults === state.runResults ? state : { runResults };
        });
      }),
      window.cw.onGitHubCiActivity(() => {
        if (get().kind === "run" || Object.keys(get().runResults).length > 0) void fetchKind("run", true);
      })
    ];
  };

  const unsubscribe = () => {
    for (const off of unsubscribers) off();
    unsubscribers = [];
  };

  const knownRuns = (): Map<string, WorkflowRunSummary> => {
    const runs = new Map<string, WorkflowRunSummary>();
    for (const entry of Object.values(get().runResults)) {
      for (const run of entry.data?.items ?? []) runs.set(runKeyOf(run.ref), run);
    }
    return runs;
  };

  teardownRuntime = () => {
    for (const kind of KINDS) cancelTimer(kind);
    stopRefresh();
    unsubscribe();
  };

  return {
    kind: "pr",
    tabs: { pr: initialTab("pr"), issue: initialTab("issue"), run: initialTab("run") },
    prResults: {},
    issueResults: {},
    runResults: {},
    viewCounts: {},
    savedViews: [],
    viewer: null,
    org: null,
    active: false,
    error: null,

    setKind(kind: GitHubKind) {
      set({ kind });
      if (get().active && !hasResult(kind)) void fetchKind(kind, false);
    },

    setQuery(kind: GitHubKind, query: string) {
      const target = kindFromQuery(query) ?? kind;
      updateTab(target, { query, viewId: matchingViewId(target, query) ?? get().tabs[target].viewId });
      if (target !== kind) set({ kind: target });
      scheduleFetch(target);
    },

    selectView(viewId: string) {
      const view = KINDS.flatMap((kind) => resolveViews(kind, get().org, get().savedViews)).find((item) => item.id === viewId);
      if (!view) {
        console.warn(`[github] unknown view ${viewId}`);
        return;
      }
      updateTab(view.kind, { query: view.query, viewId: view.id, group: view.group });
      set({ kind: view.kind });
      void fetchKind(view.kind, false);
    },

    setGroup(kind: GitHubKind, group: GitHubViewGroup) {
      updateTab(kind, { group });
    },

    toggleCollapsed(kind: GitHubKind, groupId: string) {
      const collapsed = get().tabs[kind].collapsed;
      updateTab(kind, { collapsed: collapsed.includes(groupId) ? collapsed.filter((id) => id !== groupId) : [...collapsed, groupId] });
    },

    async refresh(force?: boolean) {
      await fetchKind(get().kind, force === true);
    },

    async loadViewCounts(kind: GitHubKind) {
      if (kind === "run") return;
      const views = resolveViews(kind, get().org, get().savedViews);
      const signature = views.map((view) => `${view.id}=${view.query}`).join("\n");
      const loaded = countsLoadedAt[kind];
      if (loaded && loaded.signature === signature && Date.now() - loaded.at < VIEW_COUNTS_TTL_MS) return;
      countsLoadedAt[kind] = { at: Date.now(), signature };
      const counted: Array<{ id: string; query: string }> = [];
      const counts: Record<string, number | null> = {};
      for (const view of views) {
        const split = splitQuery(kind, view.query);
        if (split.local.length > 0) counts[view.id] = null;
        else counted.push({ id: view.id, query: split.remote });
      }
      try {
        const batches = chunk(counted, MAX_COUNT_QUERIES);
        const results = await Promise.all(batches.map((batch) => window.cw.countGitHub(kind, batch.map((item) => item.query))));
        batches.forEach((batch, batchIndex) => {
          batch.forEach((item, index) => {
            counts[item.id] = results[batchIndex]?.[index] ?? null;
          });
        });
        set((state) => ({ viewCounts: { ...state.viewCounts, ...counts } }));
      } catch (err) {
        countsLoadedAt[kind] = null;
        fail(`view counts failed for ${kind}`, err);
      }
    },

    saveView(name: string) {
      const trimmed = name.trim();
      const { kind, tabs } = get();
      const query = normalizeQuery(tabs[kind].query);
      const group = tabs[kind].group;
      return enqueue(async () => {
        if (!savedViewsReady()) return;
        const nameProblem = validateViewName(trimmed);
        if (nameProblem) {
          set({ error: nameProblem });
          return;
        }
        if (query.length > MAX_QUERY_LENGTH) {
          set({ error: `Query is limited to ${MAX_QUERY_LENGTH} characters` });
          return;
        }
        const { savedViews } = get();
        if (savedViews.length >= MAX_SAVED_VIEWS) {
          set({ error: `At most ${MAX_SAVED_VIEWS} saved views are allowed` });
          return;
        }
        const view: SavedGitHubView = { id: crypto.randomUUID(), kind, name: trimmed, query, group };
        if (await persistViews([...savedViews, view])) updateTab(kind, { viewId: view.id });
      });
    },

    renameView(id: string, name: string) {
      const trimmed = name.trim();
      return enqueue(async () => {
        if (!savedViewsReady()) return;
        const nameProblem = validateViewName(trimmed);
        if (nameProblem) {
          set({ error: nameProblem });
          return;
        }
        const { savedViews } = get();
        if (!savedViews.some((view) => view.id === id)) {
          set({ error: "View not found" });
          return;
        }
        await persistViews(savedViews.map((view) => (view.id === id ? { ...view, name: trimmed } : view)));
      });
    },

    deleteView(id: string) {
      return enqueue(async () => {
        if (!savedViewsReady()) return;
        const { savedViews } = get();
        if (!savedViews.some((view) => view.id === id)) {
          set({ error: "View not found" });
          return;
        }
        if (!(await persistViews(savedViews.filter((view) => view.id !== id)))) return;
        for (const kind of KINDS) {
          if (get().tabs[kind].viewId === id) updateTab(kind, { viewId: null });
        }
      });
    },

    applySavedViews(views: SavedGitHubView[]) {
      savedViewsLoaded = true;
      set((state) => ({ savedViews: views, error: state.error === SAVED_VIEWS_LOADING ? null : state.error }));
    },

    setActive(active: boolean, force?: boolean) {
      set({ active });
      if (!active) {
        releaseRunsTopic();
        teardownRuntime();
        watchedSignature = null;
        return;
      }
      holdRunsTopic();
      if (requestedRuns.length > 0) get().setWatchedRuns(requestedRuns);
      subscribe();
      scheduleRefresh();
      void fetchKind(get().kind, force === true);
      get().syncContext();
    },

    setWatchedRuns(refs: RunRef[]) {
      requestedRuns = refs;
      const known = knownRuns();
      const rank = (ref: RunRef): number => {
        const status = known.get(runKeyOf(ref))?.status;
        return status === "in_progress" ? 0 : status === "queued" ? 1 : 2;
      };
      const updatedAt = (ref: RunRef): number => known.get(runKeyOf(ref))?.updatedAt ?? 0;
      const unique = [...new Map(refs.map((ref) => [runKeyOf(ref), ref])).values()];
      const picked = unique
        .map((ref, index) => ({ ref, index }))
        .sort((a, b) => rank(a.ref) - rank(b.ref) || updatedAt(b.ref) - updatedAt(a.ref) || a.index - b.index)
        .slice(0, MAX_WATCHED_RUNS)
        .map((item) => item.ref);
      const signature = picked.map(runKeyOf).sort().join("|");
      if (signature === watchedSignature) return;
      watchedSignature = signature;
      void window.cw.watchGitHubRuns(picked).catch((err: unknown) => {
        watchedSignature = null;
        fail("watching runs failed", err);
      });
    },

    syncContext() {
      const prState = usePrStore.getState();
      const viewer = get().viewer ?? prState.inbox?.account?.login ?? null;
      const org = orgFromRepos(prState.projectRepos, viewer);
      if (viewer !== get().viewer || org !== get().org) set({ viewer, org });
      if (get().active) refreshBadges(true);
      const previousRunKey = latestKeys.run;
      if (previousRunKey === null) return;
      const runKey = searchKey("run", get().tabs.run.query, clonedRepos());
      const live = get().active && (get().kind === "run" || Object.keys(get().runResults).length > 0);
      if (runKey !== previousRunKey && live) void fetchKind("run", false);
    },

    clearError() {
      set({ error: null });
    }
  };
});

import.meta.hot?.dispose(() => {
  teardownRuntime();
  releaseRunsTopic();
});
