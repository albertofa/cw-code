import type {
  AppSettings,
  PrDetail,
  PrDetailEntry,
  PrInboxResult,
  PrInboxState,
  PrRef,
  PrsTopicData,
  PrSummary,
  Project,
  ProjectGitHubRepo,
  SessionMeta,
  SubjectRelations
} from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { PRS_TOPIC, sessionTopic } from "@cw-code/shared/topics";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { detailPolicy } from "./detailPolicy.js";
import { githubContext } from "./githubContext.js";
import { shouldRequestDetail, type DetailAttempt } from "./needsYou.js";
import { detailRefreshKey } from "./prUpdates.js";
import { prSummaryLookup } from "./sessionPrLinks.js";
import { subjectRelations } from "./subjectRelations.js";

const MIN_REFRESH_SECONDS = 30;
const DEFAULT_REFRESH_SECONDS = 120;
const MAX_CONCURRENT_DETAIL_LOADS = 3;
const EXPLICIT_RETENTION_MS = 10 * 60_000;
const MAX_CACHED_DETAILS = 100;
const LOG_PREFIX = "[pr-store]";

export interface PrStoreDeps {
  sessions(): SessionMeta[];
  settings(): AppSettings;
  projects(): Array<Pick<Project, "id" | "rootPath">>;
  githubRemote(rootPath: string): Promise<{ host: string; owner: string; repository: string } | null>;
  fetchInbox(force: boolean): Promise<PrInboxResult>;
  fetchDetail(ref: PrRef): Promise<PrDetail>;
}

interface InboxTimer {
  handle: ReturnType<typeof setInterval>;
  intervalMs: number;
}

interface DetailRequest {
  promise: Promise<PrDetail>;
  start(): void;
  cancel(reason: Error): void;
}

interface CachedSummary {
  source: PrSummary;
  entry: PrSummary;
}

interface RelationsContext {
  sessions: SessionMeta[];
  unchangedInputs: boolean;
  workflows: AppSettings["prWorkflows"];
  viewer: string | null;
  lookupPr(ref: PrRef): PrSummary | undefined;
}

interface CachedRelations {
  summary: PrSummary;
  json: string;
  value: SubjectRelations;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDetail(summary: PrSummary): summary is PrDetail {
  return "timeline" in summary;
}

function summaryOf(summary: PrSummary): PrSummary {
  if (!isDetail(summary)) return summary;
  const { body, createdAt, timeline, threads, checkRuns, commits, viewerLogin, ...rest } = summary;
  return rest;
}

export class PrStore {
  private inboxResult: PrInboxResult | null = null;
  private inboxError: string | null = null;
  private inboxRequest: { promise: Promise<void>; force: boolean } | null = null;
  private inboxLoading = false;
  private tracked = new Map<string, PrSummary>();
  private details = new Map<string, PrDetail>();
  private detailErrors = new Map<string, string>();
  private detailRequests = new Map<string, DetailRequest>();
  private detailQueue: string[] = [];
  private runningLoads = 0;
  private attempts = new Map<string, DetailAttempt>();
  private touchedAt = new Map<string, number>();
  private explicitAt = new Map<string, number>();
  private repos: ProjectGitHubRepo[] = [];
  private reposRequest: Promise<ProjectGitHubRepo[]> | null = null;
  private lookupCache: Map<string, PrSummary> | null = null;
  private summaryCache = new Map<string, CachedSummary>();
  private relationsCache = new Map<string, CachedRelations>();
  private relationsInputs = "";
  private detailEntryCache = new Map<string, PrDetailEntry>();
  private listeners = new Set<() => void>();
  private hub: TopicHub | null = null;
  private store: TopicStore<PrsTopicData> | null = null;
  private timer: InboxTimer | null = null;
  private active = false;
  private disposed = false;
  private generation = 0;
  private changePending = false;

  constructor(private readonly deps: PrStoreDeps) {}

  attach(hub: TopicHub): TopicProvider {
    this.hub = hub;
    return {
      owns: (topic) => topic === PRS_TOPIC,
      exactTopics: [PRS_TOPIC],
      acquire: (_topic, owner) => this.activate(owner),
      release: () => this.deactivate()
    };
  }

  summaryLookup(): ReadonlyMap<string, PrSummary> {
    return this.lookup();
  }

  detail(key: string): PrDetail | undefined {
    return this.details.get(key);
  }

  loadDetail(ref: PrRef): Promise<PrDetail> {
    const key = prKey(ref);
    this.explicitAt.set(key, Date.now());
    const request = this.beginLoad(ref, true);
    this.publish();
    return request;
  }

  refreshInbox(force: boolean): Promise<void> {
    const running = this.inboxRequest;
    if (running) {
      if (!force || running.force) return running.promise;
      return running.promise.then(() => this.refreshInbox(true));
    }
    const promise = this.runInboxRefresh(force).finally(() => {
      if (this.inboxRequest?.promise === promise) this.inboxRequest = null;
    });
    this.inboxRequest = { promise, force };
    return promise;
  }

  refreshProjectRepos(): Promise<ProjectGitHubRepo[]> {
    if (this.reposRequest) return this.reposRequest;
    const generation = this.generation;
    const request = this.lookupProjectRepos()
      .then((repos) => {
        if (generation === this.generation) {
          this.repos = repos;
          this.scheduleChanged();
        }
        return repos;
      })
      .finally(() => {
        this.reposRequest = null;
      });
    this.reposRequest = request;
    return request;
  }

  onChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  onTracked(items: PrSummary[]): void {
    this.tracked = new Map(items.map((item) => [prKey(item.ref), item]));
    this.lookupCache = null;
    this.scheduleChanged();
  }

  onSessionsChanged(): void {
    this.scheduleChanged();
  }

  onProjectsChanged(): void {
    void this.refreshProjectRepos().catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} project repo lookup failed: ${describeError(error)}`);
    });
  }

  onSettingsChanged(): void {
    if (this.timer && this.timer.intervalMs !== this.intervalMs()) this.startTimer();
    this.scheduleChanged();
  }

  reevaluate(): void {
    this.scheduleChanged();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.stopTimer();
    this.active = false;
    this.store = null;
    this.changePending = false;
    const reason = new Error("PR store disposed");
    for (const request of this.detailRequests.values()) request.cancel(reason);
    this.detailRequests.clear();
    this.detailQueue = [];
    this.runningLoads = 0;
    this.inboxRequest = null;
    this.inboxLoading = false;
    this.reposRequest = null;
  }

  resume(): void {
    if (!this.disposed) return;
    this.disposed = false;
    const hub = this.hub;
    if (hub && hub.subscribers(PRS_TOPIC) > 0) this.activate(hub);
    this.scheduleChanged();
  }

  private activate(hub: TopicHub): TopicStore<PrsTopicData> {
    this.active = true;
    const store = hub.createStore<PrsTopicData>(PRS_TOPIC, this.projection());
    this.store = store;
    this.startTimer();
    void this.refreshInbox(false);
    return store;
  }

  private deactivate(): void {
    this.active = false;
    this.store = null;
    this.stopTimer();
  }

  private intervalMs(): number {
    return Math.max(MIN_REFRESH_SECONDS, this.deps.settings().prRefreshIntervalSeconds || DEFAULT_REFRESH_SECONDS) * 1000;
  }

  private startTimer(): void {
    this.stopTimer();
    if (this.disposed) return;
    const intervalMs = this.intervalMs();
    const handle = setInterval(() => void this.refreshInbox(false), intervalMs);
    handle.unref?.();
    this.timer = { handle, intervalMs };
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer.handle);
    this.timer = null;
  }

  private async runInboxRefresh(force: boolean): Promise<void> {
    const generation = this.generation;
    this.inboxLoading = true;
    this.publish();
    void this.refreshProjectRepos().catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} project repo lookup failed: ${describeError(error)}`);
    });
    let result: PrInboxResult | null = null;
    let failure: string | null = null;
    try {
      result = await this.deps.fetchInbox(force);
    } catch (error) {
      failure = describeError(error);
      console.warn(`${LOG_PREFIX} inbox refresh failed: ${failure}`);
    }
    if (generation !== this.generation) return;
    if (result) {
      this.inboxResult = result;
      this.lookupCache = null;
    }
    this.inboxError = result ? result.error : failure;
    this.inboxLoading = false;
    this.changed();
  }

  private async lookupProjectRepos(): Promise<ProjectGitHubRepo[]> {
    const repos = await Promise.all(
      this.deps.projects().map(async (project) => {
        const remote = await this.deps.githubRemote(project.rootPath).catch(() => null);
        return remote ? { projectId: project.id, host: remote.host, owner: remote.owner, repo: remote.repository } : null;
      })
    );
    return repos.filter((repo): repo is ProjectGitHubRepo => repo !== null);
  }

  private beginLoad(ref: PrRef, urgent: boolean): Promise<PrDetail> {
    const key = prKey(ref);
    const running = this.detailRequests.get(key);
    if (running) {
      if (urgent) this.promote(key);
      return running.promise;
    }
    this.detailErrors.delete(key);
    this.attempts.set(key, { version: detailRefreshKey(key, this.lookup().get(key)), fetchedAt: this.fetchedAt() });
    const generation = this.generation;
    let start: () => void = () => {};
    let cancel: (reason: Error) => void = () => {};
    const gate = new Promise<void>((resolve, reject) => {
      start = resolve;
      cancel = reject;
    });
    const promise = gate
      .then(() => this.deps.fetchDetail(ref))
      .then(
        (detail) => {
          if (generation === this.generation) {
            this.details.set(key, detail);
            this.lookupCache = null;
            this.touchedAt.set(key, Date.now());
          }
          return detail;
        },
        (error: unknown) => {
          if (generation === this.generation) {
            this.detailErrors.set(key, describeError(error));
            console.warn(`${LOG_PREFIX} detail load failed for ${key}: ${describeError(error)}`);
          }
          throw error;
        }
      )
      .finally(() => {
        if (generation !== this.generation) return;
        this.detailRequests.delete(key);
        this.runningLoads -= 1;
        this.pumpLoads();
        this.changed();
      });
    this.detailRequests.set(key, { promise, start, cancel });
    if (urgent) this.detailQueue.unshift(key);
    else this.detailQueue.push(key);
    this.pumpLoads();
    return promise;
  }

  private promote(key: string): void {
    const index = this.detailQueue.indexOf(key);
    if (index <= 0) return;
    this.detailQueue.splice(index, 1);
    this.detailQueue.unshift(key);
  }

  private pumpLoads(): void {
    while (this.runningLoads < MAX_CONCURRENT_DETAIL_LOADS) {
      const key = this.detailQueue.shift();
      if (key === undefined) return;
      this.runningLoads += 1;
      this.detailRequests.get(key)?.start();
    }
  }

  private loadWanted(): void {
    if (this.disposed) return;
    const { wanted, retained } = detailPolicy({
      sessions: this.deps.sessions(),
      lookup: this.lookup(),
      details: this.details,
      workflows: this.deps.settings().prWorkflows,
      isSessionOpen: (sessionId) => (this.hub?.subscribers(sessionTopic(sessionId)) ?? 0) > 0
    });
    this.evict(retained);
    for (const [key, { ref, version }] of wanted) {
      if (!shouldRequestDetail(this.attempts.get(key), version, this.fetchedAt(), this.detailRequests.has(key))) continue;
      this.beginLoad(ref, false).catch(() => undefined);
    }
  }

  private evict(retained: ReadonlySet<string>): void {
    const now = Date.now();
    const keep = (key: string): boolean =>
      retained.has(key) || this.detailRequests.has(key) || now - (this.explicitAt.get(key) ?? Number.NEGATIVE_INFINITY) < EXPLICIT_RETENTION_MS;
    const known = new Set([...this.details.keys(), ...this.detailErrors.keys(), ...this.attempts.keys(), ...this.explicitAt.keys()]);
    let evicted = false;
    for (const key of known) {
      if (keep(key)) continue;
      this.forget(key);
      evicted = true;
    }
    if (this.details.size > MAX_CACHED_DETAILS) {
      const candidates = [...this.details.keys()]
        .filter((key) => !retained.has(key) && !this.detailRequests.has(key))
        .sort((a, b) => (this.touchedAt.get(a) ?? 0) - (this.touchedAt.get(b) ?? 0));
      for (const key of candidates.slice(0, this.details.size - MAX_CACHED_DETAILS)) this.forget(key);
      evicted = true;
    }
    if (evicted) this.lookupCache = null;
  }

  private forget(key: string): void {
    this.details.delete(key);
    this.detailErrors.delete(key);
    this.attempts.delete(key);
    this.touchedAt.delete(key);
    this.explicitAt.delete(key);
  }

  private scheduleChanged(): void {
    if (this.changePending || this.disposed) return;
    this.changePending = true;
    queueMicrotask(() => {
      if (!this.changePending) return;
      this.changed();
    });
  }

  private changed(): void {
    this.changePending = false;
    if (this.disposed) return;
    this.lookupCache = null;
    this.guard(() => {
      this.loadWanted();
      this.publish();
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn(`${LOG_PREFIX} change listener failed: ${describeError(error)}`);
      }
    }
  }

  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      console.warn(`${LOG_PREFIX} update failed: ${describeError(error)}`);
    }
  }

  private publish(): void {
    if (!this.active || !this.store) return;
    this.guard(() => this.store?.sync(this.projection()));
  }

  private fetchedAt(): number {
    return this.inboxResult?.fetchedAt ?? 0;
  }

  private viewer(): string | null {
    return this.inboxResult?.account?.login ?? null;
  }

  private lookup(): Map<string, PrSummary> {
    this.lookupCache ??= prSummaryLookup(this.inboxResult?.items ?? [], Object.fromEntries(this.details), Object.fromEntries(this.tracked));
    return this.lookupCache;
  }

  private inboxState(): PrInboxState {
    const result = this.inboxResult;
    return {
      keys: result?.items.map((item) => prKey(item.ref)) ?? [],
      account: result?.account ?? null,
      fetchedAt: result?.fetchedAt ?? 0,
      error: this.inboxError,
      truncated: result?.truncated ?? false,
      limit: result?.limit ?? null,
      loading: this.inboxLoading
    };
  }

  private summaryEntry(key: string, source: PrSummary): PrSummary {
    const cached = this.summaryCache.get(key);
    if (cached?.source === source) return cached.entry;
    const entry = summaryOf(source);
    this.summaryCache.set(key, { source, entry });
    return entry;
  }

  private detailEntry(key: string): PrDetailEntry {
    const detail = this.details.get(key) ?? null;
    const loading = this.detailRequests.has(key);
    const error = this.detailErrors.get(key) ?? null;
    const cached = this.detailEntryCache.get(key);
    if (cached && cached.detail === detail && cached.loading === loading && cached.error === error) return cached;
    const entry = { detail, loading, error };
    this.detailEntryCache.set(key, entry);
    return entry;
  }

  private relationsFor(
    key: string,
    summary: PrSummary,
    context: RelationsContext
  ): SubjectRelations {
    const cached = this.relationsCache.get(key);
    if (cached && context.unchangedInputs && cached.summary === summary) return cached.value;
    const computed = subjectRelations({ kind: "pr", pr: summary }, context.sessions, context.workflows, context.viewer, context.lookupPr);
    const json = JSON.stringify(computed);
    if (cached && cached.json === json) {
      cached.summary = summary;
      return cached.value;
    }
    this.relationsCache.set(key, { summary, json, value: computed });
    return computed;
  }

  private projection(): PrsTopicData {
    const lookup = this.lookup();
    const sessions = this.deps.sessions();
    const workflows = this.deps.settings().prWorkflows;
    const viewer = this.viewer();
    const inputs = JSON.stringify([sessions, workflows, viewer]);
    const context: RelationsContext = {
      sessions,
      unchangedInputs: inputs === this.relationsInputs,
      workflows,
      viewer,
      lookupPr: (ref) => lookup.get(prKey(ref))
    };
    const data: Record<string, unknown> = { inbox: this.inboxState(), context: githubContext(this.repos, viewer) };
    for (const [key, summary] of lookup) {
      data[`summary/${key}`] = this.summaryEntry(key, summary);
      data[`rel/${key}`] = this.relationsFor(key, summary, context);
    }
    this.relationsInputs = inputs;
    const detailKeys = new Set([...this.details.keys(), ...this.detailErrors.keys(), ...this.detailRequests.keys()]);
    for (const key of detailKeys) data[`detail/${key}`] = this.detailEntry(key);
    this.pruneCaches(lookup, detailKeys);
    return data as PrsTopicData;
  }

  private pruneCaches(lookup: ReadonlyMap<string, PrSummary>, detailKeys: ReadonlySet<string>): void {
    for (const key of this.summaryCache.keys()) if (!lookup.has(key)) this.summaryCache.delete(key);
    for (const key of this.relationsCache.keys()) if (!lookup.has(key)) this.relationsCache.delete(key);
    for (const key of this.detailEntryCache.keys()) if (!detailKeys.has(key)) this.detailEntryCache.delete(key);
  }
}
