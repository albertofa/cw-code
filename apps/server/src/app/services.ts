import { homedir } from "node:os";
import type { ShutdownReason } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { ptyTopic } from "@cw-code/shared/topics";
import { FileService } from "../fs/FileService.js";
import { FileWatcher } from "../fs/FileWatcher.js";
import { GitService } from "../fs/GitService.js";
import { configureGitHubAccounts, defaultGitHubAccounts } from "../github/GitHubAccounts.js";
import { githubCliBinary } from "../github/githubAccount.js";
import { GitHubSearchService } from "../github/GitHubSearchService.js";
import { GitHubViews } from "../github/GitHubViews.js";
import { PrTracker } from "../github/PrTracker.js";
import { snapshotOf } from "../github/prTracking.js";
import { PullRequestService } from "../github/PullRequestService.js";
import { RunsService } from "../github/RunsService.js";
import { RunWatcher } from "../github/RunWatcher.js";
import { HarnessMonitor } from "../cli/HarnessMonitor.js";
import { PreferencesStore } from "../prefs/PreferencesStore.js";
import { preferencesFilePath } from "../paths/appPaths.js";
import { AutoFollowUpEngine } from "../prEngine/AutoFollowUpEngine.js";
import { PrStore } from "../prEngine/PrStore.js";
import { PtyPool } from "../pty/PtyPool.js";
import { SessionManager } from "../sessions/SessionManager.js";
import type { SessionStore } from "../sessions/SessionStore.js";
import type { SettingsStore } from "../settings/SettingsStore.js";
import { ShutdownCoordinator } from "../shutdown/ShutdownCoordinator.js";
import { SidebarService } from "../sidebar/SidebarService.js";
import { SkillsStore } from "../skills/SkillsStore.js";
import { GitTopic } from "../sourceControl/GitTopic.js";
import { SourceControlService } from "../sourceControl/SourceControlService.js";
import { ThreadService } from "../threads/ThreadService.js";
import { TurnService } from "../threads/TurnService.js";
import type { TopicHub } from "../topics/TopicHub.js";
import { AccountUsageService } from "../usage/AccountUsageService.js";
import { UsageTopic } from "../usage/UsageTopic.js";
import { wireSessionUsageTotals } from "../usage/wireSessionUsageTotals.js";
import { AppTopic } from "./AppTopic.js";

export type Emit = (channel: string, payload?: unknown) => void;

export interface Services {
  sessions: SessionManager;
  skills: SkillsStore;
  files: FileService;
  fileWatcher: FileWatcher;
  git: GitService;
  pullRequests: PullRequestService;
  prTracker: PrTracker;
  prStore: PrStore;
  sourceControl: SourceControlService;
  gitTopic: GitTopic;
  githubSearch: GitHubSearchService;
  runs: RunsService;
  runWatcher: RunWatcher;
  githubViews: GitHubViews;
  ptys: PtyPool;
  accountUsage: AccountUsageService;
  usageTopic: UsageTopic;
  shutdown: ShutdownCoordinator;
  appTopic: AppTopic;
  preferences: PreferencesStore;
  harnessMonitor: HarnessMonitor;
  threads: ThreadService;
  turns: TurnService;
  autoFollowUp: AutoFollowUpEngine;
  sidebar: SidebarService;
}

export interface ServiceHooks {
  emit: Emit;
  topics: TopicHub;
  dropTopic: (topic: string) => void;
  legacyAppRoots: string[];
  onShutdownRecovered: (failure: string | null) => void;
  onShutdownExpired: (reason: ShutdownReason) => void;
}

const PR_STATE_REUSE_MS = 60_000;

function wireAutoFollowUp({ autoFollowUp, prStore, threads, turns }: Services): void {
  threads.registerExtras((sessionId) => ({ babysit: autoFollowUp.babysit(sessionId) }));
  autoFollowUp.onChanged((sessionId) => threads.refreshExtras(sessionId));
  prStore.onChanged(() => autoFollowUp.reevaluate());
  threads.onRuntimeChanged(() => autoFollowUp.reevaluate());
  threads.onTurnSettled((sessionId, _turnId, event) => autoFollowUp.turnSettled(sessionId, event));
  turns.onTurnStarted((sessionId, auto) => autoFollowUp.turnStarted(sessionId, auto));
  turns.onTurnStopped((sessionId) => autoFollowUp.turnStopped(sessionId));
  autoFollowUp.setEnabled(true);
}

function wireUsage({ sessions, threads, usageTopic }: Services): void {
  wireSessionUsageTotals(threads, usageTopic, (cb) => sessions.onUsageRecorded(cb));
}

function wireSidebar({ sidebar, threads, sourceControl, prStore, autoFollowUp, preferences }: Services): void {
  sidebar.watch(
    (onChange) => threads.onRuntimeChanged(onChange),
    (onChange) => sourceControl.onPublished(onChange),
    (onChange) => prStore.onChanged(onChange),
    (onChange) => autoFollowUp.onChanged(onChange),
    (onChange) =>
      preferences.onChanged((change) => {
        if (change.kind === "sidebarOrder") onChange();
      })
  );
}

function wireGitTopic({ gitTopic, sourceControl, sessions }: Services): void {
  sourceControl.onPublished((update) => gitTopic.statusChanged(update.sessionId));
  sourceControl.onFailureChanged((sessionId) => gitTopic.stateChanged(sessionId));
  sessions.onCheckoutChanged((sessionIds) => {
    for (const sessionId of sessionIds) void sourceControl.refresh(sessionId, { forcePullRequest: true });
  });
}

function wireGitHubViews({ githubViews, prStore }: Services): void {
  prStore.onChanged(() => githubViews.reevaluate());
}

function wireServiceEvents(
  { sessions, sourceControl, gitTopic, prTracker, prStore, ptys, runWatcher, githubViews, threads, autoFollowUp, sidebar }: Services,
  { emit, dropTopic }: ServiceHooks
): void {
  sessions.setEmitter((sessionId, event) => {
    emit("turn.event", { sessionId, event });
    try {
      threads.onDriverEvent(sessionId, event);
    } catch (error) {
      console.warn(`[threads] ${event.type} for session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (event.type === "turn.interrupted") autoFollowUp.turnInterrupted(sessionId, event.reason);
    sourceControl.onThreadEvent(sessionId, event);
  });
  sessions.setTitleEmitter((sessionId, title) => {
    emit("session.title", { sessionId, title });
    sidebar.invalidate();
  });
  sessions.setSessionEmitter((session) => {
    emit("session.updated", session);
    prTracker.setTracked(sessions.trackedPrRefs());
    prStore.onSessionsChanged();
    autoFollowUp.reevaluate();
    sidebar.invalidate();
    gitTopic.stateChanged(session.id);
  });
  sessions.setProjectEmitter((project) => {
    emit("projects.changed", project);
    prStore.onProjectsChanged();
    sidebar.invalidate();
  });
  ptys.setExitEmitter((ptyId, token, exitCode) => {
    emit("pty.exit", { ptyId, token, exitCode });
    if (!ptys.has(ptyId)) dropTopic(ptyTopic(ptyId));
  });
  runWatcher.onRunsChanged = (changed) => {
    emit("github.runsChanged", changed);
    githubViews.runsChanged(changed);
  };
  runWatcher.onCiActivity = () => {
    emit("github.ciActivity");
    githubViews.ciActivity();
  };
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
  const prStore = new PrStore({
    sessions: () => sessions.listAllSessions(),
    settings: () => sessions.getSettings(),
    projects: () => sessions.listProjects(),
    githubRemote: (rootPath) => git.githubRemote(rootPath),
    fetchInbox: (force) => pullRequests.inbox(force),
    fetchDetail: (ref) => pullRequests.detail(ref)
  });
  const prTracker: PrTracker = new PrTracker(
    () => sessions.getSettings(),
    (changed) => {
      const syncedAt = Date.now();
      sessions.applyPrSnapshots(new Map(changed.map((summary) => [prKey(summary.ref), snapshotOf(summary, syncedAt)])));
      emit("prs.tracked", prTracker.summaries());
      prStore.onTracked(prTracker.summaries());
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
  const gitTopic = new GitTopic(hooks.topics, {
    status: (sessionId) => sourceControl.status(sessionId),
    failure: (sessionId) => sourceControl.failure(sessionId),
    session: (sessionId) => sessions.findSession(sessionId),
    setWatched: (sessionIds) => sourceControl.setWatched(sessionIds)
  });
  const ptys = new PtyPool(() => sessions.getSettings());
  const shutdown = new ShutdownCoordinator({ sessions, ptys, onRecovered: hooks.onShutdownRecovered, onExpired: hooks.onShutdownExpired });
  const preferences = new PreferencesStore(preferencesFilePath());
  const appTopic = new AppTopic(hooks.topics, {
    settings: sessions.getSettings(),
    homeDir: homedir(),
    recentModels: preferences.recentModels(),
    drafts: preferences.drafts(),
    shutdown: {
      status: { idle: shutdown.isIdle(), committed: shutdown.isCommitted(), reason: shutdown.currentReason() },
      assessment: shutdown.assess()
    }
  });
  preferences.onChanged((change) => {
    if (change.kind === "recentModels") appTopic.setRecentModels(change.driver, preferences.recentModels()[change.driver]);
    else if (change.kind === "draft") appTopic.setDraft(change.key, change.draft);
  });
  const harnessMonitor = new HarnessMonitor({
    binaries: () => {
      const settings = sessions.getSettings();
      return { claudeBinary: settings.claudeBinaryPath, opencodeBinary: settings.opencodeBinaryPath, codexBinary: settings.codexBinaryPath };
    },
    current: () => appTopic.harnesses,
    publish: (availability) => appTopic.setHarnesses(availability)
  });
  const threads = new ThreadService({
    hub: hooks.topics,
    history: (sessionId) => sessions.getHistory(sessionId),
    liveTasks: (sessionId) => sessions.liveTasks(sessionId),
    pendingRequests: (sessionId) => sessions.listPendingRequests(sessionId)
  });
  const turns = new TurnService({ sessions, threads, git: gitTopic });
  const autoFollowUp = new AutoFollowUpEngine({
    sessions: () => sessions.listAllSessions(),
    settings: () => sessions.getSettings(),
    runtime: (sessionId) => threads.runtime(sessionId),
    summaryLookup: () => prStore.summaryLookup(),
    detail: (key) => prStore.detail(key),
    failedCheckLog: (ref, runId) => pullRequests.failedCheckLog(ref, runId),
    startTurn: (sessionId, prompt, input) => turns.start(sessionId, prompt, input),
    markPrSeen: (sessionId, ref, headSha, seenAt) => {
      sessions.markPrSeen(sessionId, ref, headSha, seenAt);
    },
    updateAutoFollowUp: (sessionId, update) => sessions.updateAutoFollowUp(sessionId, update) !== null,
    postNotice: (sessionId, notice) => sessions.emitNotice(sessionId, notice.noticeId, notice.text, notice.severity),
    shutdownReserved: () => sessions.isShutdownReserved()
  });
  const sidebar = new SidebarService(hooks.topics, {
    sessions: () => sessions.listAllSessions(),
    projects: () => sessions.listProjects(),
    runtime: (sessionId) => threads.runtime(sessionId),
    gitStatus: (sessionId) => sourceControl.status(sessionId),
    summaryLookup: () => prStore.summaryLookup(),
    detail: (key) => prStore.detail(key),
    workflows: () => sessions.getSettings().prWorkflows,
    sidebarOrder: () => preferences.sidebarOrder(),
    setSidebarOrder: (order) => preferences.setSidebarOrder(order),
    publishAttention: (count) => appTopic.setAttention(count),
    watchWorkingSet: (sessionIds) => sourceControl.setWorkingSet(sessionIds)
  });
  const githubSearch = new GitHubSearchService(() => sessions.getSettings());
  const runs = new RunsService(() => sessions.getSettings());
  const runWatcher = new RunWatcher(() => sessions.getSettings());
  const githubViews = new GitHubViews(hooks.topics, {
    settings: () => sessions.getSettings(),
    sessions: () => sessions.listAllSessions().filter((session) => session.status !== "archived"),
    context: () => prStore.context(),
    inbox: () => prStore.inbox(),
    summaryLookup: () => prStore.summaryLookup(),
    ensureContext: () => prStore.refreshProjectRepos(),
    refreshInbox: (force) => prStore.refreshInbox(force),
    searchPrs: (query, countBase, force) => githubSearch.search("pr", query, countBase, force),
    searchIssues: (query, countBase, force) => githubSearch.search("issue", query, countBase, force),
    fetchRuns: (sources, force) => runs.runs(sources, force),
    counts: (kind, queries) => githubSearch.counts(kind, queries),
    watchRuns: (refs) => runWatcher.watch(refs),
    setRunWatchActive: (active) => runWatcher.setActive(active)
  });
  const accountUsage = new AccountUsageService(() => sessions.driversForProbe());
  const usageTopic = new UsageTopic(hooks.topics, {
    accountUsage,
    ledgerRows: (query) => sessions.queryUsageLedger(query),
    onUsageRecorded: (cb) => sessions.onUsageRecorded(cb)
  });
  const services: Services = {
    sessions,
    skills: new SkillsStore(),
    files: new FileService(),
    fileWatcher,
    git,
    pullRequests,
    prTracker,
    prStore,
    sourceControl,
    gitTopic,
    githubSearch,
    runs,
    runWatcher,
    githubViews,
    ptys,
    accountUsage,
    usageTopic,
    shutdown,
    appTopic,
    preferences,
    harnessMonitor,
    threads,
    turns,
    autoFollowUp,
    sidebar
  };
  wireServiceEvents(services, hooks);
  wireAutoFollowUp(services);
  wireUsage(services);
  wireSidebar(services);
  wireGitTopic(services);
  wireGitHubViews(services);
  return services;
}
