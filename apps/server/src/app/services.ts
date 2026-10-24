import type { ShutdownReason } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { ptyTopic } from "@cw-code/shared/topics";
import { FileService } from "../fs/FileService.js";
import { FileWatcher } from "../fs/FileWatcher.js";
import { GitService } from "../fs/GitService.js";
import { configureGitHubAccounts, defaultGitHubAccounts } from "../github/GitHubAccounts.js";
import { githubCliBinary } from "../github/githubAccount.js";
import { GitHubSearchService } from "../github/GitHubSearchService.js";
import { PrTracker } from "../github/PrTracker.js";
import { snapshotOf } from "../github/prTracking.js";
import { PullRequestService } from "../github/PullRequestService.js";
import { RunsService } from "../github/RunsService.js";
import { RunWatcher } from "../github/RunWatcher.js";
import { PtyPool } from "../pty/PtyPool.js";
import { SessionManager } from "../sessions/SessionManager.js";
import type { SessionStore } from "../sessions/SessionStore.js";
import type { SettingsStore } from "../settings/SettingsStore.js";
import { ShutdownCoordinator } from "../shutdown/ShutdownCoordinator.js";
import { SkillsStore } from "../skills/SkillsStore.js";
import { SourceControlService } from "../sourceControl/SourceControlService.js";
import { AccountUsageService } from "../usage/AccountUsageService.js";

export type Emit = (channel: string, payload?: unknown) => void;

export interface Services {
  sessions: SessionManager;
  skills: SkillsStore;
  files: FileService;
  fileWatcher: FileWatcher;
  git: GitService;
  pullRequests: PullRequestService;
  prTracker: PrTracker;
  sourceControl: SourceControlService;
  githubSearch: GitHubSearchService;
  runs: RunsService;
  runWatcher: RunWatcher;
  ptys: PtyPool;
  accountUsage: AccountUsageService;
  shutdown: ShutdownCoordinator;
}

export interface ServiceHooks {
  emit: Emit;
  dropTopic: (topic: string) => void;
  legacyAppRoots: string[];
  onShutdownRecovered: (failure: string | null) => void;
  onShutdownExpired: (reason: ShutdownReason) => void;
}

const PR_STATE_REUSE_MS = 60_000;

function wireServiceEvents({ sessions, sourceControl, prTracker, ptys, runWatcher }: Services, { emit, dropTopic }: ServiceHooks): void {
  sessions.setEmitter((sessionId, event) => {
    emit("turn.event", { sessionId, event });
    sourceControl.onThreadEvent(sessionId, event);
  });
  sessions.setTitleEmitter((sessionId, title) => emit("session.title", { sessionId, title }));
  sessions.setSessionEmitter((session) => {
    emit("session.updated", session);
    prTracker.setTracked(sessions.trackedPrRefs());
  });
  ptys.setExitEmitter((ptyId, token, exitCode) => {
    emit("pty.exit", { ptyId, token, exitCode });
    if (!ptys.has(ptyId)) dropTopic(ptyTopic(ptyId));
  });
  runWatcher.onRunsChanged = (changed) => emit("github.runsChanged", changed);
  runWatcher.onCiActivity = () => emit("github.ciActivity");
}

export function createServices(stores: { sessionStore: SessionStore; settingsStore: SettingsStore }, hooks: ServiceHooks): Services {
  const { emit } = hooks;
  let pullRequests: PullRequestService;
  const fileWatcher = new FileWatcher((event) => emit("fs.changed", event));
  configureGitHubAccounts(() => githubCliBinary(() => sessions.getSettings()));
  const git: GitService = new GitService(() => sessions.getSettings(), defaultGitHubAccounts);
  const sessions: SessionManager = new SessionManager({
    sessionStore: stores.sessionStore,
    settingsStore: stores.settingsStore,
    gitService: git,
    prHead: (ref) => prTracker.snapshot(ref)?.headRefOid || pullRequests.knownHead(ref),
    prHeadRefresh: async (ref) => {
      await prTracker.refresh([ref]);
      return prTracker.snapshot(ref)?.headRefOid || pullRequests.refreshHead(ref);
    },
    prState: (ref) => prTracker.snapshot(ref)?.state ?? pullRequests.knownState(ref),
    prStateRefresh: async (ref) => {
      const syncedAt = prTracker.snapshot(ref)?.syncedAt ?? 0;
      if (Date.now() - syncedAt >= PR_STATE_REUSE_MS) await prTracker.refresh([ref]);
      return prTracker.snapshot(ref)?.state ?? pullRequests.refreshState(ref);
    },
    prUpdatedAt: (ref) => prTracker.snapshot(ref)?.updatedAt ?? pullRequests.knownUpdatedAt(ref),
    onResolved: (sessionId) => {
      ptys.killSession(sessionId);
      void fileWatcher.unwatch(sessionId);
    },
    legacyAppRoots: hooks.legacyAppRoots
  });
  pullRequests = new PullRequestService(git, () => sessions.getSettings(), (rootPath) => sessions.addProject(rootPath));
  const prTracker: PrTracker = new PrTracker(
    () => sessions.getSettings(),
    (changed) => {
      const syncedAt = Date.now();
      sessions.applyPrSnapshots(new Map(changed.map((summary) => [prKey(summary.ref), snapshotOf(summary, syncedAt)])));
      emit("prs.tracked", prTracker.summaries());
    }
  );
  prTracker.setTracked(sessions.trackedPrRefs());
  const sourceControl = new SourceControlService({
    git,
    sessions,
    tracker: prTracker,
    settings: () => sessions.getSettings(),
    emit: (update) => emit("git.statusChanged", update)
  });
  const ptys = new PtyPool(() => sessions.getSettings());
  const services: Services = {
    sessions,
    skills: new SkillsStore(),
    files: new FileService(),
    fileWatcher,
    git,
    pullRequests,
    prTracker,
    sourceControl,
    githubSearch: new GitHubSearchService(() => sessions.getSettings()),
    runs: new RunsService(() => sessions.getSettings()),
    runWatcher: new RunWatcher(() => sessions.getSettings()),
    ptys,
    accountUsage: new AccountUsageService(() => sessions.driversForProbe()),
    shutdown: new ShutdownCoordinator({ sessions, ptys, onRecovered: hooks.onShutdownRecovered, onExpired: hooks.onShutdownExpired })
  };
  wireServiceEvents(services, hooks);
  return services;
}
