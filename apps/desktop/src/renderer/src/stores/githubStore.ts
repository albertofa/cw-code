import { create } from "zustand";
import type {
  GitHubAccountRef,
  GitHubKind,
  GitHubSearchResult,
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
import { errorMessage } from "../components/errorMessage.js";
import { kindFromQuery, normalizeQuery, runSources, splitQuery } from "../components/githubQuery.js";
import { useAppStore } from "./appStore.js";
import { usePrStore } from "./prStore.js";

export interface GitHubTabState {
  query: string;
  viewId: string | null;
  group: GitHubViewGroup;
  collapsed: string[];
}

export type Loadable<T> = { loading: boolean; data: T | null; error: string | null };

export interface GitHubView {
  id: string;
  kind: GitHubKind;
  name: string;
  icon: string;
  query: string;
  group: GitHubViewGroup;
  saved: boolean;
}

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
  loadSavedViews(): Promise<void>;
  setActive(active: boolean): void;
  setWatchedRuns(refs: RunRef[]): void;
  syncContext(): void;
  clearError(): void;
}

export const ORG_PLACEHOLDER = "{org}";

export const BUILTIN_VIEWS: Array<{ id: string; kind: GitHubKind; name: string; icon: string; query: string; group: GitHubViewGroup }> = [
  { id: "pr:inbox", kind: "pr", name: "Inbox", icon: "Inbox", query: "is:pr involves:@me state:open", group: "triage" },
  { id: "pr:authored", kind: "pr", name: "Authored by me", icon: "Pencil", query: "is:pr author:@me state:open archived:false sort:updated-desc", group: "none" },
  { id: "pr:review", kind: "pr", name: "Review requests", icon: "Eye", query: "is:pr review-requested:@me state:open", group: "none" },
  { id: "pr:assigned", kind: "pr", name: "Assigned to me", icon: "UserCheck", query: "is:pr assignee:@me state:open", group: "none" },
  { id: "pr:mentions", kind: "pr", name: "Mentions", icon: "AtSign", query: "is:pr mentions:@me state:open", group: "none" },
  { id: "pr:org", kind: "pr", name: `${ORG_PLACEHOLDER} · all open`, icon: "Building2", query: `is:pr org:${ORG_PLACEHOLDER} state:open`, group: "repo" },
  { id: "issue:inbox", kind: "issue", name: "Inbox", icon: "Inbox", query: "is:issue involves:@me state:open", group: "triage" },
  { id: "issue:assigned", kind: "issue", name: "Assigned to me", icon: "UserCheck", query: "is:issue assignee:@me state:open", group: "none" },
  { id: "issue:created", kind: "issue", name: "Created by me", icon: "Pencil", query: "is:issue author:@me state:open", group: "none" },
  { id: "issue:mentions", kind: "issue", name: "Mentions", icon: "AtSign", query: "is:issue mentions:@me state:open", group: "none" },
  { id: "issue:org", kind: "issue", name: `${ORG_PLACEHOLDER} · all open`, icon: "Building2", query: `is:issue org:${ORG_PLACEHOLDER} state:open`, group: "repo" },
  { id: "run:watching", kind: "run", name: "Watching", icon: "Inbox", query: "is:run involves:@me", group: "triage" },
  { id: "run:mine", kind: "run", name: "Triggered by me", icon: "User", query: "is:run actor:@me", group: "none" },
  { id: "run:failing", kind: "run", name: "Failing", icon: "CircleX", query: "is:run involves:@me status:failure", group: "none" },
  { id: "run:org", kind: "run", name: `${ORG_PLACEHOLDER} · all runs`, icon: "Building2", query: `is:run org:${ORG_PLACEHOLDER}`, group: "repo" }
];

export const SAVED_VIEW_ICON = "Bookmark";
export const MAX_SAVED_VIEWS = 50;
export const MAX_VIEW_NAME_LENGTH = 80;
export const MAX_QUERY_LENGTH = 512;

const QUERY_DEBOUNCE_MS = 350;
const VIEW_COUNTS_TTL_MS = 60_000;
const MAX_WATCHED_RUNS = 30;
const MAX_COUNT_QUERIES = 20;
const MAX_SOURCE_REPOS = 20;
const MAX_SOURCE_ORGS = 5;
const MIN_REFRESH_SECONDS = 30;
const DEFAULT_REFRESH_SECONDS = 120;

const KINDS: GitHubKind[] = ["pr", "issue", "run"];

function initialTab(kind: GitHubKind): GitHubTabState {
  const view = BUILTIN_VIEWS.find((item) => item.kind === kind && item.id.endsWith(":inbox")) ?? BUILTIN_VIEWS.find((item) => item.kind === kind);
  return { query: view?.query ?? `is:${kind}`, viewId: view?.id ?? null, group: view?.group ?? "none", collapsed: [] };
}

export function resolveViews(kind: GitHubKind, org: string | null, savedViews: SavedGitHubView[]): GitHubView[] {
  const builtin = BUILTIN_VIEWS.filter((view) => view.kind === kind).flatMap((view): GitHubView[] => {
    const needsOrg = view.query.includes(ORG_PLACEHOLDER);
    if (needsOrg && !org) return [];
    return [
      {
        ...view,
        name: view.name.split(ORG_PLACEHOLDER).join(org ?? ""),
        query: view.query.split(ORG_PLACEHOLDER).join(org ?? ""),
        saved: false
      }
    ];
  });
  const saved = savedViews.filter((view) => view.kind === kind).map((view): GitHubView => ({ ...view, icon: SAVED_VIEW_ICON, saved: true }));
  return [...builtin, ...saved];
}

export function orgFromRepos(repos: ProjectGitHubRepo[], viewer: string | null): string | null {
  if (!viewer) return null;
  const login = viewer.toLowerCase();
  return repos.find((repo) => repo.owner.toLowerCase() !== login)?.owner ?? null;
}

export function clonedReposOf(repos: ProjectGitHubRepo[]): RepoRef[] {
  return repos.map((repo) => ({ host: repo.host, owner: repo.owner, repo: repo.repo }));
}

export function cappedRunSources(query: string, clonedRepos: RepoRef[]): RunSources {
  const sources = runSources(query, clonedRepos);
  return { ...sources, repos: sources.repos.slice(0, MAX_SOURCE_REPOS), orgs: sources.orgs.slice(0, MAX_SOURCE_ORGS) };
}

function remoteWithKind(kind: "pr" | "issue", remote: string): string {
  const trimmed = remote.trim();
  return kindFromQuery(trimmed) === null ? `is:${kind} ${trimmed}`.trim() : trimmed;
}

export function searchKey(kind: GitHubKind, query: string, clonedRepos: RepoRef[]): string {
  if (kind === "run") return `run:${JSON.stringify(cappedRunSources(query, clonedRepos))}`;
  return `${kind}:${normalizeQuery(remoteWithKind(kind, splitQuery(kind, query).remote))}`;
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

export const useGitHubStore = create<GitHubStore>((set, get) => {
  const sequences: Record<GitHubKind, number> = { pr: 0, issue: 0, run: 0 };
  const latestKeys: Record<GitHubKind, string | null> = { pr: null, issue: null, run: null };
  const timers: Record<GitHubKind, ReturnType<typeof setTimeout> | null> = { pr: null, issue: null, run: null };
  const countsLoadedAt: Record<GitHubKind, { at: number; signature: string } | null> = { pr: null, issue: null, run: null };
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribers: Array<() => void> = [];
  let watchedSignature = "";
  let savedViewsLoaded = false;

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

  const clonedRepos = (): RepoRef[] => clonedReposOf(usePrStore.getState().projectRepos);

  const cancelTimer = (kind: GitHubKind) => {
    const timer = timers[kind];
    if (timer !== null) clearTimeout(timer);
    timers[kind] = null;
  };

  async function load<T extends { account: GitHubAccountRef | null; error: string | null }>(
    kind: GitHubKind,
    key: string,
    select: (state: GitHubStore) => Record<string, Loadable<T>>,
    assign: (results: Record<string, Loadable<T>>) => Partial<GitHubStore>,
    fetcher: () => Promise<T>
  ): Promise<void> {
    const sequence = ++sequences[kind];
    latestKeys[kind] = key;
    const previous = select(get())[key]?.data ?? null;
    set((state) => assign(withEntry(select(state), key, { loading: true, data: previous, error: null })));
    const settle = (next: Loadable<T>) => set((state) => assign(withEntry(select(state), key, next)));
    try {
      const data = await fetcher();
      if (sequence !== sequences[kind]) {
        if (latestKeys[kind] !== key) settle({ loading: false, data, error: data.error });
        return;
      }
      settle({ loading: false, data, error: data.error });
      noteViewer(data.account);
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[github] ${kind} fetch failed: ${message}`);
      if (sequence !== sequences[kind] && latestKeys[kind] === key) return;
      settle({ loading: false, data: select(get())[key]?.data ?? previous, error: message });
    }
  }

  async function fetchKind(kind: GitHubKind, force: boolean): Promise<void> {
    cancelTimer(kind);
    const query = get().tabs[kind].query;
    if (kind === "run") {
      const sources = cappedRunSources(query, clonedRepos());
      await load(
        "run",
        searchKey("run", query, clonedRepos()),
        (state) => state.runResults,
        (runResults) => ({ runResults }),
        () => window.cw.getGitHubRuns(sources, force)
      );
      return;
    }
    const split = splitQuery(kind, query);
    const remote = remoteWithKind(kind, split.remote);
    const countBase = split.countBase.trim();
    const key = searchKey(kind, query, []);
    if (kind === "pr") {
      await load(
        "pr",
        key,
        (state) => state.prResults,
        (prResults) => ({ prResults }),
        () => window.cw.searchGitHub("pr", remote, countBase, force)
      );
      return;
    }
    await load(
      "issue",
      key,
      (state) => state.issueResults,
      (issueResults) => ({ issueResults }),
      () => window.cw.searchGitHub("issue", remote, countBase, force)
    );
  }

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

  const persistViews = async (next: SavedGitHubView[]): Promise<boolean> => {
    try {
      const saved = await window.cw.setSettings({ githubSavedViews: next });
      set({ savedViews: saved.githubSavedViews ?? next, error: null });
      return true;
    } catch (err) {
      fail("saving views failed", err);
      return false;
    }
  };

  const startRefreshTimer = () => {
    if (refreshTimer !== null) clearInterval(refreshTimer);
    const seconds = Math.max(MIN_REFRESH_SECONDS, useAppStore.getState().prRefreshIntervalSeconds || DEFAULT_REFRESH_SECONDS);
    refreshTimer = setInterval(() => void fetchKind(get().kind, false), seconds * 1000);
  };

  const stopRefreshTimer = () => {
    if (refreshTimer !== null) clearInterval(refreshTimer);
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
      if (target === kind) {
        updateTab(kind, { query });
        scheduleFetch(kind);
        return;
      }
      const match = resolveViews(target, get().org, get().savedViews).find((view) => normalizeQuery(view.query) === normalizeQuery(query));
      updateTab(target, { query, viewId: match?.id ?? get().tabs[target].viewId });
      set({ kind: target });
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
        else counted.push({ id: view.id, query: remoteWithKind(kind, split.remote) });
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

    async saveView(name: string) {
      const trimmed = name.trim();
      const nameProblem = validateViewName(trimmed);
      if (nameProblem) {
        set({ error: nameProblem });
        return;
      }
      const { kind, tabs, savedViews } = get();
      const query = normalizeQuery(tabs[kind].query);
      if (query.length > MAX_QUERY_LENGTH) {
        set({ error: `Query is limited to ${MAX_QUERY_LENGTH} characters` });
        return;
      }
      if (savedViews.length >= MAX_SAVED_VIEWS) {
        set({ error: `At most ${MAX_SAVED_VIEWS} saved views are allowed` });
        return;
      }
      const view: SavedGitHubView = { id: crypto.randomUUID(), kind, name: trimmed, query, group: tabs[kind].group };
      if (await persistViews([...savedViews, view])) updateTab(kind, { viewId: view.id });
    },

    async renameView(id: string, name: string) {
      const trimmed = name.trim();
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
    },

    async deleteView(id: string) {
      const { savedViews } = get();
      if (!savedViews.some((view) => view.id === id)) {
        set({ error: "View not found" });
        return;
      }
      const saved = await persistViews(savedViews.filter((view) => view.id !== id));
      if (!saved) return;
      for (const kind of KINDS) {
        if (get().tabs[kind].viewId === id) updateTab(kind, { viewId: null });
      }
    },

    async loadSavedViews() {
      try {
        const settings = await window.cw.getSettings();
        savedViewsLoaded = true;
        set({ savedViews: settings.githubSavedViews ?? [] });
      } catch (err) {
        fail("loading saved views failed", err);
      }
    },

    setActive(active: boolean) {
      set({ active });
      void window.cw.setGitHubActive(active).catch((err: unknown) => {
        fail("setActive failed", err);
      });
      if (!active) {
        stopRefreshTimer();
        unsubscribe();
        watchedSignature = "";
        return;
      }
      subscribe();
      startRefreshTimer();
      get().syncContext();
      if (!savedViewsLoaded) void get().loadSavedViews();
      void fetchKind(get().kind, true);
    },

    setWatchedRuns(refs: RunRef[]) {
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
        watchedSignature = "";
        fail("watching runs failed", err);
      });
    },

    syncContext() {
      const prState = usePrStore.getState();
      const viewer = get().viewer ?? prState.inbox?.account?.login ?? null;
      const org = orgFromRepos(prState.projectRepos, viewer);
      if (viewer !== get().viewer || org !== get().org) set({ viewer, org });
    },

    clearError() {
      set({ error: null });
    }
  };
});
