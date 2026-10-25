import type { AppSettings, GitStatus, GitStatusUpdate, PrRef, SessionMeta, ThreadEvent } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import type { GitService } from "../fs/GitService.js";
import type { PrTracker } from "../github/PrTracker.js";
import type { SessionManager } from "../sessions/SessionManager.js";
import { comparableRoot } from "../sessions/worktreeCleanup.js";
import { classifyToolCall, type ToolGitEffect } from "./gitActivity.js";
import { GitWatcher, type GitWatchRoot } from "./GitWatcher.js";
import { RefreshScheduler, type RefreshRequest } from "./RefreshScheduler.js";
import { statusGroupsForRoot, type StatusCandidate, type StatusGroup } from "./statusTargets.js";

export const TOOL_REFRESH_DEBOUNCE_MS = 250;
export const STATUS_REFRESH_CONCURRENCY = 4;
const MIN_POLL_SECONDS = 5;
const LOG_PREFIX = "[source-control]";

export interface SourceControlDeps {
  git: GitService;
  sessions: SessionManager;
  tracker: PrTracker;
  watcher?: GitWatcher;
  settings: () => AppSettings;
  emit: (update: GitStatusUpdate) => void;
  warn?: (msg: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLive(session: SessionMeta): boolean {
  return session.status !== "resolved" && session.status !== "archived";
}

export class SourceControlService {
  private readonly git: GitService;
  private readonly sessions: SessionManager;
  private readonly tracker: PrTracker;
  private readonly settings: () => AppSettings;
  private readonly emit: (update: GitStatusUpdate) => void;
  private readonly warn: (msg: string) => void;
  private readonly watcher: GitWatcher;
  private scheduler: RefreshScheduler | null = null;
  private readonly statuses = new Map<string, GitStatus>();
  private readonly fingerprints = new Map<string, string>();
  private readonly failures = new Map<string, string>();
  private readonly rootByKey = new Map<string, string>();
  private readonly requested = new Map<string, Set<string>>();
  private readonly toolEffects = new Map<string, Map<string, ToolGitEffect>>();
  private watched = new Set<string>();
  private subscribed: string[] = [];
  private workingSet: string[] = [];
  private readonly publishedListeners = new Set<(update: GitStatusUpdate) => void>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private watchGeneration = 0;

  constructor(deps: SourceControlDeps) {
    this.git = deps.git;
    this.sessions = deps.sessions;
    this.tracker = deps.tracker;
    this.settings = deps.settings;
    this.emit = deps.emit;
    this.warn = deps.warn ?? ((msg) => console.warn(msg));
    this.watcher = deps.watcher ?? new GitWatcher((roots) => this.handleGitChange(roots), { warn: this.warn });
  }

  start(): void {
    if (this.scheduler) return;
    this.scheduler = new RefreshScheduler((rootKey, request) => this.runRoot(rootKey, request), {
      concurrency: STATUS_REFRESH_CONCURRENCY,
      warn: (msg) => this.warn(`${LOG_PREFIX} ${msg}`)
    });
    this.schedulePoll();
    if (this.watched.size === 0) return;
    this.refreshWatched();
    void this.syncWatcherRoots();
  }

  setWatched(sessionIds: string[]): void {
    this.subscribed = [...sessionIds];
    this.applyWatched();
  }

  setWorkingSet(sessionIds: string[]): void {
    this.workingSet = [...sessionIds];
    this.applyWatched();
  }

  onPublished(cb: (update: GitStatusUpdate) => void): () => void {
    this.publishedListeners.add(cb);
    return () => this.publishedListeners.delete(cb);
  }

  refresh(sessionId: string, request: { forcePullRequest?: boolean } = {}): Promise<void> {
    return this.request(sessionId, { forcePullRequest: request.forcePullRequest === true });
  }

  status(sessionId: string): GitStatus | null {
    return this.statuses.get(sessionId) ?? null;
  }

  failure(sessionId: string): string | null {
    return this.failures.get(sessionId) ?? null;
  }

  onThreadEvent(sessionId: string, event: ThreadEvent): void {
    if (!this.scheduler) return;
    const id = sessionId || ("sessionId" in event ? event.sessionId : "");
    if (!id) return;
    switch (event.type) {
      case "tool.call":
        this.trackToolCall(id, event.toolCallId, classifyToolCall(event.name, event.input));
        return;
      case "tool.result":
        this.settleToolCall(id, event.toolCallId);
        return;
      case "turn.done":
      case "turn.error":
        this.toolEffects.delete(id);
        void this.request(id, { forcePullRequest: true });
        void this.refreshLinkedPrs(id);
        return;
      case "session.branch.updated":
        void this.request(id, { forcePullRequest: true });
        return;
      default:
        return;
    }
  }

  handleGitChange(roots: string[]): void {
    const scheduler = this.scheduler;
    if (!scheduler) return;
    for (const root of roots) {
      const rootKey = comparableRoot(root);
      this.rootByKey.set(rootKey, root);
      void scheduler.request(rootKey, { forcePullRequest: false });
    }
  }

  async dispose(): Promise<void> {
    const scheduler = this.scheduler;
    this.scheduler = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.watchGeneration += 1;
    scheduler?.dispose();
    this.toolEffects.clear();
    this.requested.clear();
    await this.watcher.dispose();
  }

  private async request(sessionId: string, request: RefreshRequest, debounceMs = 0, invalidatePullRequest = false): Promise<void> {
    if (!this.scheduler) return;
    let root: string;
    try {
      root = (await this.sessions.sessionStatusContext(sessionId)).root;
    } catch (error) {
      this.recordFailure([sessionId], `could not resolve the checkout of session ${sessionId}: ${describeError(error)}`);
      return;
    }
    const scheduler = this.scheduler;
    if (!scheduler) return;
    const rootKey = comparableRoot(root);
    this.rootByKey.set(rootKey, root);
    if (invalidatePullRequest) this.git.invalidatePullRequest(root);
    const requested = this.requested.get(rootKey) ?? new Set<string>();
    requested.add(sessionId);
    this.requested.set(rootKey, requested);
    await scheduler.request(rootKey, request, debounceMs);
  }

  private trackToolCall(sessionId: string, toolCallId: string, effect: ToolGitEffect): void {
    if (!effect.refreshLocal && !effect.remoteEffect) return;
    const calls = this.toolEffects.get(sessionId) ?? new Map<string, ToolGitEffect>();
    calls.set(toolCallId, effect);
    this.toolEffects.set(sessionId, calls);
  }

  private settleToolCall(sessionId: string, toolCallId: string): void {
    const calls = this.toolEffects.get(sessionId);
    const effect = calls?.get(toolCallId);
    if (!calls || !effect) return;
    calls.delete(toolCallId);
    if (calls.size === 0) this.toolEffects.delete(sessionId);
    if (!effect.remoteEffect) {
      void this.request(sessionId, { forcePullRequest: false }, TOOL_REFRESH_DEBOUNCE_MS);
      return;
    }
    void this.request(sessionId, { forcePullRequest: true }, TOOL_REFRESH_DEBOUNCE_MS, true);
    void this.refreshLinkedPrs(sessionId);
  }

  private async refreshLinkedPrs(sessionId: string): Promise<void> {
    const refs = (this.findSession(sessionId)?.prs ?? []).map((link) => link.ref);
    if (refs.length === 0) return;
    try {
      await this.tracker.refresh(refs);
    } catch (error) {
      this.warn(`${LOG_PREFIX} pull request refresh failed for session ${sessionId}: ${describeError(error)}`);
    }
  }

  private findSession(sessionId: string): SessionMeta | undefined {
    return this.sessions.listAllSessions().find((session) => session.id === sessionId);
  }

  private candidates(): StatusCandidate[] {
    return this.sessions.listAllSessions().map((session) => ({
      id: session.id,
      projectId: session.projectId,
      ...(session.baseRef ? { baseRef: session.baseRef } : {}),
      rootKey: this.candidateRootKey(session),
      active: isLive(session)
    }));
  }

  private candidateRootKey(session: SessionMeta): string | null {
    try {
      return comparableRoot(session.worktreePath || this.sessions.rootForProject(session.projectId));
    } catch {
      return null;
    }
  }

  private async runRoot(rootKey: string, request: RefreshRequest): Promise<void> {
    const root = this.rootByKey.get(rootKey);
    const requested = this.requested.get(rootKey) ?? new Set<string>();
    this.requested.delete(rootKey);
    if (!root || !this.scheduler) return;
    for (const group of statusGroupsForRoot(this.candidates(), rootKey, requested)) {
      if (!this.scheduler) return;
      await this.refreshGroup(root, group, request);
    }
  }

  private async refreshGroup(root: string, group: StatusGroup, request: RefreshRequest): Promise<void> {
    let status: GitStatus;
    try {
      const project = this.sessions.getProject(group.projectId);
      status = await this.git.status(root, project, {
        ...(group.baseRef ? { baseRef: group.baseRef } : {}),
        forcePullRequest: request.forcePullRequest,
        fresh: true
      });
    } catch (error) {
      this.recordFailure(group.sessionIds, `git status failed for ${root}: ${describeError(error)}`);
      return;
    }
    if (!this.scheduler) return;
    const linked: PrRef[] = [];
    for (const sessionId of group.sessionIds) {
      linked.push(...this.syncSession(sessionId, status));
      this.publish(sessionId, status);
    }
    if (linked.length === 0) return;
    this.tracker.setTracked(this.sessions.trackedPrRefs());
    void this.tracker.refresh(linked);
  }

  private syncSession(sessionId: string, status: GitStatus): PrRef[] {
    const before = new Set((this.findSession(sessionId)?.prs ?? []).map((link) => prKey(link.ref)));
    let updated: SessionMeta | null;
    try {
      updated = this.sessions.syncFromStatus(sessionId, status);
    } catch (error) {
      this.warn(`${LOG_PREFIX} syncFromStatus failed for session ${sessionId}: ${describeError(error)}`);
      return [];
    }
    return (updated?.prs ?? []).filter((link) => !before.has(prKey(link.ref))).map((link) => link.ref);
  }

  private publish(sessionId: string, status: GitStatus): void {
    this.failures.delete(sessionId);
    this.statuses.set(sessionId, status);
    const fingerprint = JSON.stringify(status);
    if (this.fingerprints.get(sessionId) === fingerprint) return;
    this.fingerprints.set(sessionId, fingerprint);
    const update: GitStatusUpdate = { sessionId, status };
    try {
      this.emit(update);
    } catch (error) {
      this.warn(`${LOG_PREFIX} could not push the status of session ${sessionId}: ${describeError(error)}`);
    }
    for (const listener of [...this.publishedListeners]) {
      try {
        listener(update);
      } catch (error) {
        this.warn(`${LOG_PREFIX} a published-status listener failed for session ${sessionId}: ${describeError(error)}`);
      }
    }
  }

  private recordFailure(sessionIds: string[], message: string): void {
    let fresh = false;
    for (const sessionId of sessionIds) {
      if (this.failures.get(sessionId) !== message) fresh = true;
      this.failures.set(sessionId, message);
    }
    if (fresh) this.warn(`${LOG_PREFIX} ${message}`);
  }

  private applyWatched(): void {
    const next = new Set([...this.subscribed, ...this.workingSet]);
    const added = [...next].filter((id) => !this.watched.has(id));
    const removed = [...this.watched].some((id) => !next.has(id));
    this.watched = next;
    if (!this.scheduler || (added.length === 0 && !removed)) return;
    for (const id of added) void this.refresh(id);
    void this.syncWatcherRoots();
  }

  private refreshWatched(): void {
    for (const sessionId of this.watched) void this.refresh(sessionId);
  }

  private schedulePoll(): void {
    if (!this.scheduler) return;
    const configured = Number(this.settings().sourceControlRefreshIntervalSeconds);
    const seconds = Math.max(MIN_POLL_SECONDS, Number.isFinite(configured) ? configured : MIN_POLL_SECONDS);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.refreshWatched();
      this.schedulePoll();
    }, seconds * 1000);
    this.pollTimer.unref?.();
  }

  private async syncWatcherRoots(): Promise<void> {
    const generation = ++this.watchGeneration;
    const roots = await Promise.all(
      [...this.watched].map((sessionId) =>
        this.sessions.sessionStatusContext(sessionId).then(
          (context) => context.root,
          () => null
        )
      )
    );
    const unique = new Map<string, string>();
    for (const root of roots) if (root) unique.set(comparableRoot(root), root);
    const entries = await Promise.all(
      [...unique.values()].map(async (root): Promise<GitWatchRoot | null> => {
        try {
          const locations = await this.git.gitLocations(root);
          return locations ? { root, ...locations } : null;
        } catch (error) {
          this.warn(`${LOG_PREFIX} could not locate git metadata for ${root}: ${describeError(error)}`);
          return null;
        }
      })
    );
    if (!this.scheduler || generation !== this.watchGeneration) return;
    this.watcher.setRoots(entries.filter((entry): entry is GitWatchRoot => entry !== null));
  }
}
