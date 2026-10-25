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
  SessionMeta
} from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { PRS_TOPIC, sessionTopic } from "@cw-code/shared/topics";
import type { TopicHub, TopicProvider } from "../topics/TopicHub.js";
import type { TopicStore } from "../topics/TopicStore.js";
import { wantedDetails } from "./detailPolicy.js";
import { githubContext } from "./githubContext.js";
import { shouldRequestDetail, type DetailAttempt } from "./needsYou.js";
import { detailRefreshKey } from "./prUpdates.js";
import { prSummaryLookup } from "./sessionPrLinks.js";
import { subjectRelations } from "./subjectRelations.js";

const MIN_REFRESH_SECONDS = 30;
const DEFAULT_REFRESH_SECONDS = 120;
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
  private inboxRequest: Promise<void> | null = null;
  private inboxLoading = false;
  private tracked = new Map<string, PrSummary>();
  private details = new Map<string, PrDetail>();
  private detailErrors = new Map<string, string>();
  private inFlight = new Map<string, Promise<PrDetail>>();
  private attempts = new Map<string, DetailAttempt>();
  private repos: ProjectGitHubRepo[] = [];
  private reposRequest: Promise<ProjectGitHubRepo[]> | null = null;
  private lookupCache: Map<string, PrSummary> | null = null;
  private listeners = new Set<() => void>();
  private hub: TopicHub | null = null;
  private store: TopicStore<PrsTopicData> | null = null;
  private timer: InboxTimer | null = null;
  private active = false;
  private disposed = false;

  constructor(private readonly deps: PrStoreDeps) {}

  attach(hub: TopicHub): TopicProvider {
    this.hub = hub;
    return {
      owns: (topic) => topic === PRS_TOPIC,
      acquire: (topic, owner) => {
        this.active = true;
        const store = owner.createStore<PrsTopicData>(topic, this.projection());
        this.store = store;
        this.startTimer();
        void this.refreshInbox(false);
        return store;
      },
      release: () => {
        this.active = false;
        this.store = null;
        this.stopTimer();
      }
    };
  }

  summaryLookup(): ReadonlyMap<string, PrSummary> {
    return this.lookup();
  }

  detail(key: string): PrDetail | undefined {
    return this.details.get(key);
  }

  loadDetail(ref: PrRef): Promise<PrDetail> {
    const request = this.beginLoad(ref);
    this.publish();
    return request;
  }

  refreshInbox(force: boolean): Promise<void> {
    if (this.inboxRequest) return this.inboxRequest;
    const request = this.runInboxRefresh(force).finally(() => {
      this.inboxRequest = null;
    });
    this.inboxRequest = request;
    return request;
  }

  refreshProjectRepos(): Promise<ProjectGitHubRepo[]> {
    if (this.reposRequest) return this.reposRequest;
    const request = this.lookupProjectRepos()
      .then((repos) => {
        this.repos = repos;
        this.changed();
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
    this.changed();
  }

  onSessionsChanged(): void {
    this.changed();
  }

  onProjectsChanged(): void {
    void this.refreshProjectRepos().catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} project repo lookup failed: ${describeError(error)}`);
    });
  }

  onSettingsChanged(): void {
    if (this.timer && this.timer.intervalMs !== this.intervalMs()) this.startTimer();
    this.changed();
  }

  reevaluate(): void {
    this.guard(() => {
      this.loadWanted();
      this.publish();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  resume(): void {
    if (!this.disposed) return;
    this.disposed = false;
    if (this.active) this.startTimer();
    this.changed();
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
    this.inboxLoading = true;
    this.publish();
    void this.refreshProjectRepos().catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} project repo lookup failed: ${describeError(error)}`);
    });
    try {
      const result = await this.deps.fetchInbox(force);
      this.inboxResult = result;
      this.inboxError = result.error;
    } catch (error) {
      this.inboxError = describeError(error);
      console.warn(`${LOG_PREFIX} inbox refresh failed: ${this.inboxError}`);
    }
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

  private beginLoad(ref: PrRef): Promise<PrDetail> {
    const key = prKey(ref);
    const running = this.inFlight.get(key);
    if (running) return running;
    this.detailErrors.delete(key);
    this.attempts.set(key, { version: detailRefreshKey(key, this.lookup().get(key)), fetchedAt: this.fetchedAt() });
    const request = Promise.resolve()
      .then(() => this.deps.fetchDetail(ref))
      .then(
        (detail) => {
          this.details.set(key, detail);
          return detail;
        },
        (error: unknown) => {
          this.detailErrors.set(key, describeError(error));
          console.warn(`${LOG_PREFIX} detail load failed for ${key}: ${describeError(error)}`);
          throw error;
        }
      )
      .finally(() => {
        this.inFlight.delete(key);
        this.changed();
      });
    this.inFlight.set(key, request);
    return request;
  }

  private loadWanted(): void {
    if (this.disposed) return;
    const wanted = wantedDetails({
      sessions: this.deps.sessions(),
      lookup: this.lookup(),
      details: this.details,
      workflows: this.deps.settings().prWorkflows,
      isSessionOpen: (sessionId) => (this.hub?.subscribers(sessionTopic(sessionId)) ?? 0) > 0
    });
    for (const [key, { ref, version }] of wanted) {
      if (!shouldRequestDetail(this.attempts.get(key), version, this.fetchedAt(), this.inFlight.has(key))) continue;
      this.beginLoad(ref).catch(() => undefined);
    }
  }

  private changed(): void {
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

  private detailEntry(key: string): PrDetailEntry {
    return { detail: this.details.get(key) ?? null, loading: this.inFlight.has(key), error: this.detailErrors.get(key) ?? null };
  }

  private projection(): PrsTopicData {
    const lookup = this.lookup();
    const sessions = this.deps.sessions();
    const workflows = this.deps.settings().prWorkflows;
    const viewer = this.viewer();
    const lookupPr = (ref: PrRef) => lookup.get(prKey(ref));
    const data: Record<string, unknown> = { inbox: this.inboxState(), context: githubContext(this.repos, viewer) };
    for (const [key, summary] of lookup) {
      data[`summary/${key}`] = summaryOf(summary);
      data[`rel/${key}`] = subjectRelations({ kind: "pr", pr: summary }, sessions, workflows, viewer, lookupPr);
    }
    for (const key of new Set([...this.details.keys(), ...this.detailErrors.keys(), ...this.inFlight.keys()])) {
      data[`detail/${key}`] = this.detailEntry(key);
    }
    return data as PrsTopicData;
  }
}
