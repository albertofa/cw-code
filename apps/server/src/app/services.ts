import { homedir } from "node:os";
import type { ShutdownReason } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { ptyTopic } from "@cw-code/shared/topics";
import { SessionWatch } from "../agent/SessionWatch.js";
import { SubagentDelivery } from "../agent/SubagentDelivery.js";
import { FileService } from "../fs/FileService.js";
import { FilesTopic } from "../fs/FilesTopic.js";
import { FileWatcher } from "../fs/FileWatcher.js";
import { configuredGitBinary, GitService } from "../fs/GitService.js";
import { gitDecorations } from "../fs/workspaceQueries.js";
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
import { HarnessUpdateService } from "../cli/harnessUpdates/HarnessUpdateService.js";
import { planFor } from "../cli/harnessUpdates/installMethod.js";
import { LatestVersionCache } from "../cli/harnessUpdates/latestVersion.js";
import { runUpdateCommand } from "../cli/harnessUpdates/runUpdateCommand.js";
import { PreferencesStore } from "../prefs/PreferencesStore.js";
import { preferencesFilePath } from "../paths/appPaths.js";
import { AutoFollowUpEngine } from "../prEngine/AutoFollowUpEngine.js";
import { PrStore } from "../prEngine/PrStore.js";
import { SessionPrModel } from "../prEngine/sessionPrModel.js";
import { WorkflowPreviewService } from "../prEngine/WorkflowPreview.js";
import { WorkflowRunner } from "../prEngine/WorkflowRunner.js";
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
import { TurnChangesModel } from "../threads/TurnChangesModel.js";
import { TurnService } from "../threads/TurnService.js";
import type { TopicHub } from "../topics/TopicHub.js";
import { AccountUsageService } from "../usage/AccountUsageService.js";
import { UsageTopic } from "../usage/UsageTopic.js";
import { wireSessionUsageTotals } from "../usage/wireSessionUsageTotals.js";
import { AppTopic } from "./AppTopic.js";
import type { ClientInputs } from "./clientInputs.js";

export type Emit = (channel: string, payload?: unknown) => void;

export interface Services {
  sessions: SessionManager;
  skills: SkillsStore;
  files: FileService;
  fileWatcher: FileWatcher;
  filesTopic: FilesTopic;
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
  harnessUpdates: HarnessUpdateService;
  threads: ThreadService;
  turns: TurnService;
  autoFollowUp: AutoFollowUpEngine;
  sessionPrs: SessionPrModel;
  turnChanges: TurnChangesModel;
  sidebar: SidebarService;
  workflowPreview: WorkflowPreviewService;
  workflowRunner: WorkflowRunner;
  sessionWatch: SessionWatch;
  subagentDelivery: SubagentDelivery;
}

export interface ServiceHooks {
  emit: Emit;
  topics: TopicHub;
  clientInputs: ClientInputs;
  dropTopic: (topic: string) => void;
  assessmentChanged: () => void;
  legacyAppRoots: string[];
  onShutdownRecovered: (failure: string | null) => void;
  onShutdownExpired: (reason: ShutdownReason) => void;
  agentEnv: (sessionId: string) => Record<string, string>;
  revokeAgentToken: (sessionId: string) => void;
  claudePluginDir: () => string | null;
  codexSkillsRoot: () => string | null;
  agentMcpUrl: () => string | null;
}

const PR_STATE_REUSE_MS = 60_000;

function wireAutoFollowUp({ autoFollowUp, prStore, threads, turns }: Services): void {
  threads.registerExtras((sessionId) => ({ babysit: autoFollowUp.babysit(sessionId) }));
  prStore.onChanged(() => autoFollowUp.reevaluate());
  threads.onRuntimeChanged(() => autoFollowUp.reevaluate());
  threads.onTurnSettled((sessionId, _turnId, event) => autoFollowUp.turnSettled(sessionId, event));
  turns.onTurnStarted((sessionId, auto, turn) => autoFollowUp.turnStarted(sessionId, auto, turn));
  turns.onTurnStopped((sessionId) => autoFollowUp.turnStopped(sessionId));
  autoFollowUp.setEnabled(true);
}

function wireSessionWatch({ sessionWatch, threads }: Services): void {
  threads.onTurnSettled((sessionId, _turnId, event) => sessionWatch.turnSettled(sessionId, event));
}

function wireSubagentDelivery({ subagentDelivery, sessions, threads }: Services): void {
  const parentOf = (sessionId: string) => sessions.findSession(sessionId)?.subagent?.parentSessionId ?? sessionId;
  threads.onRuntimeChanged((sessionId) => subagentDelivery.reevaluate(parentOf(sessionId)));
  threads.onTurnSettled((sessionId) => subagentDelivery.reevaluate(parentOf(sessionId)));
}

function wireUsage({ sessions, threads, usageTopic }: Services): void {
  wireSessionUsageTotals(threads, usageTopic, (cb) => sessions.onUsageRecorded(cb));
}

function wireSessionPrs({ sessionPrs, threads, prStore, sourceControl, autoFollowUp }: Services): void {
  threads.registerExtras((sessionId) => sessionPrs.extras(sessionId));
  sessionPrs.watch(
    (onChange) => prStore.onChanged(onChange),
    (onChange) => sourceControl.onPublished(onChange),
    (onChange) => autoFollowUp.onChanged(onChange)
  );
}

function wireTurnChanges({ turnChanges, threads, sessions }: Services): void {
  threads.registerExtras((sessionId) => turnChanges.extras(sessionId));
  sessions.onSnapshotChanged((sessionId) => turnChanges.snapshotChanged(sessionId));
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
  sessions.onCheckoutChanged(({ sessionIds, forced }) => {
    for (const sessionId of sessionIds) void sourceControl.refresh(sessionId, { forcePullRequest: forced.includes(sessionId) });
  });
}

function wireFilesTopic({ filesTopic, sourceControl }: Services): void {
  sourceControl.onPublished((update) => filesTopic.gitPublished(update.sessionId));
}

function wireGitHubViews({ githubViews, prStore }: Services): void {
  prStore.onChanged(() => githubViews.reevaluate());
}

function wireServiceEvents(
  {
    sessions,
    sourceControl,
    gitTopic,
    filesTopic,
    prTracker,
    prStore,
    ptys,
    runWatcher,
    githubViews,
    threads,
    autoFollowUp,
    sidebar,
    sessionWatch,
    subagentDelivery
  }: Services,
  { emit, dropTopic, assessmentChanged, revokeAgentToken }: ServiceHooks
): void {
  sessions.setEmitter((sessionId, event) => {
    if (event.type === "task.updated") assessmentChanged();
    try {
      threads.onDriverEvent(sessionId, event);
    } catch (error) {
      console.warn(`[threads] ${event.type} for session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (event.type === "turn.interrupted") autoFollowUp.turnInterrupted(sessionId, event.reason);
    sourceControl.onThreadEvent(sessionId, event);
  });
  sessions.setTitleEmitter(() => {
    assessmentChanged();
    sidebar.invalidate();
  });
  sessions.setSessionEmitter((session) => {
    sessionWatch.sessionChanged(session);
    subagentDelivery.reevaluate(session.subagent?.parentSessionId ?? session.id);
    assessmentChanged();
    prTracker.setTracked(sessions.trackedPrRefs());
    prStore.onSessionsChanged();
    if (session.status === "archived" || session.status === "resolved") {
      revokeAgentToken(session.id);
      sessionWatch.forget(session.id);
      sessions.forgetTurnPermissionMode(session.id);
      gitTopic.forgetKeptHead(session.id);
      filesTopic.forget(session.id);
      threads.forget(session.id);
    } else gitTopic.stateChanged(session.id);
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
  runWatcher.onRunsChanged = (changed) => githubViews.runsChanged(changed);
  runWatcher.onCiActivity = () => githubViews.ciActivity();
}

export function createServices(stores: { sessionStore: SessionStore; settingsStore: SettingsStore }, hooks: ServiceHooks): Services {
  const { emit } = hooks;
  let pullRequests: PullRequestService;
  const fileWatcher = new FileWatcher((event) => {
    emit("fs.changed", event);
    filesTopic.changed(event.sessionId);
  });
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
    legacyAppRoots: hooks.legacyAppRoots,
    agentEnv: hooks.agentEnv,
    claudePluginDir: hooks.claudePluginDir,
    codexSkillsRoot: hooks.codexSkillsRoot,
    agentMcpUrl: hooks.agentMcpUrl
  });
  pullRequests = new PullRequestService(git, () => sessions.getSettings(), (rootPath) => sessions.addProject(rootPath));
  const prStore = new PrStore({
    sessions: () => sessions.listAllSessions(),
    settings: () => sessions.getSettings(),
    projects: () => sessions.listProjects(),
    githubRemote: (rootPath) => git.githubRemote(rootPath),
    fetchInbox: (force) => pullRequests.inbox(force),
    fetchDetail: (ref) => pullRequests.detail(ref),
    watchedDetails: () => hooks.clientInputs.watchedPrs()
  });
  const prTracker: PrTracker = new PrTracker(
    () => sessions.getSettings(),
    (changed) => {
      const syncedAt = Date.now();
      sessions.applyPrSnapshots(new Map(changed.map((summary) => [prKey(summary.ref), snapshotOf(summary, syncedAt)])));
      prStore.onTracked(prTracker.summaries());
    }
  );
  prTracker.setTracked(sessions.trackedPrRefs());
  const sourceControl = new SourceControlService({
    git,
    sessions,
    tracker: prTracker,
    settings: () => sessions.getSettings()
  });
  const gitTopic = new GitTopic(hooks.topics, {
    status: (sessionId) => sourceControl.status(sessionId),
    failure: (sessionId) => sourceControl.failure(sessionId),
    session: (sessionId) => sessions.findSession(sessionId),
    setWatched: (sessionIds) => sourceControl.setWatched(sessionIds)
  });
  const ptys = new PtyPool(() => sessions.getSettings(), undefined, hooks.claudePluginDir);
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
    publish: (availability) => {
      appTopic.setHarnesses(availability);
      harnessUpdates.harnessChecked();
    }
  });
  const latestVersions = new LatestVersionCache({ fetch, now: Date.now });
  const harnessUpdates = new HarnessUpdateService({
    initial: appTopic.harnessUpdates,
    checks: () => appTopic.harnesses.checks,
    enabled: () => sessions.getSettings().harnessUpdateChecks,
    plan: planFor,
    latest: (packageName, opts) => latestVersions.get(packageName, opts),
    run: runUpdateCommand,
    activity: (kind) => sessions.harnessActivity(kind),
    onActivity: (listener) => sessions.onHarnessActivity(listener),
    release: (kind) => sessions.releaseHarnessBinary(kind),
    recheck: () => harnessMonitor.check("recheck"),
    publish: (updates) => appTopic.setHarnessUpdates(updates),
    shutdownReserved: () => sessions.isShutdownReserved()
  });
  sessions.setTurnGate((kind) => harnessUpdates.turnGate(kind));
  const threads = new ThreadService({
    hub: hooks.topics,
    history: (sessionId) => sessions.getHistory(sessionId),
    hasNoTranscript: (sessionId) => sessions.hasNoTranscript(sessionId),
    hasSession: (sessionId) => sessions.hasSession(sessionId),
    liveTasks: (sessionId) => sessions.liveTasks(sessionId),
    pendingRequests: (sessionId) => sessions.listPendingRequests(sessionId)
  });
  const turns = new TurnService({ sessions, threads, git: gitTopic });
  sessions.setTurnStopper((sessionId) => turns.stop(sessionId));
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
  const sessionPrs = new SessionPrModel({
    sessions: () => sessions.listAllSessions(),
    isOpen: (sessionId) => threads.isOpen(sessionId),
    refresh: (sessionId) => threads.refreshExtras(sessionId),
    settings: () => sessions.getSettings(),
    gitStatus: (sessionId) => sourceControl.status(sessionId),
    branchMismatch: (sessionId) => gitTopic.rawMismatch(sessionId),
    summaryLookup: () => prStore.summaryLookup(),
    detail: (key) => prStore.detail(key),
    detailError: (key) => prStore.detailError(key),
    babysit: (sessionId) => autoFollowUp.babysit(sessionId),
    startTurn: (sessionId, prompt, input) => turns.start(sessionId, prompt, input),
    markPrSeen: (sessionId, ref, headSha, seenAt) => {
      sessions.markPrSeen(sessionId, ref, headSha, seenAt);
    },
    postNotice: (sessionId, noticeId, text, severity) => sessions.emitNotice(sessionId, noticeId, text, severity)
  });
  const turnChanges = new TurnChangesModel({
    sessions: () => sessions.listAllSessions(),
    projects: () => sessions.listProjects(),
    isOpen: (sessionId) => threads.isOpen(sessionId),
    turnChanges: (sessionId) => sessions.turnChanges(sessionId),
    latestTurnId: (sessionId) => sessions.findSession(sessionId)?.lastTurnSnapshot?.turnId ?? null,
    refresh: (sessionId) => threads.refreshExtras(sessionId)
  });
  const sidebar = new SidebarService(hooks.topics, {
    sessions: () => sessions.listAllSessions(),
    projects: () => sessions.listProjects(),
    ownsWorktree: (path) => sessions.ownsWorktree(path),
    runtime: (sessionId) => threads.runtime(sessionId),
    gitStatus: (sessionId) => sourceControl.status(sessionId),
    summaryLookup: () => prStore.summaryLookup(),
    detail: (key) => prStore.detail(key),
    inboxItems: () => prStore.inbox()?.items ?? [],
    workflows: () => sessions.getSettings().prWorkflows,
    sidebarOrder: () => preferences.sidebarOrder(),
    setSidebarOrder: (order) => preferences.setSidebarOrder(order),
    publishAttention: (count) => appTopic.setAttention(count),
    watchWorkingSet: (sessionIds) => sourceControl.setWorkingSet(sessionIds),
    keepPrInboxFresh: (on) => prStore.keepInboxFresh(on)
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
  const filesTopic = new FilesTopic(hooks.topics, {
    ensureWorktree: (sessionId) => sessions.ensureWorktree(sessionId),
    decorations: (root) => gitDecorations(configuredGitBinary(sessions.getSettings()), root),
    clientPaths: (sessionId, clientIds) => hooks.clientInputs.pathsUnion(sessionId, clientIds),
    clearClientPaths: (clientId, sessionId) => hooks.clientInputs.clearPaths(clientId, sessionId),
    watch: (sessionId, root, paths) => fileWatcher.setWatched(sessionId, root, paths),
    unwatch: (sessionId) => void fileWatcher.unwatch(sessionId)
  });
  const workflowPreview = new WorkflowPreviewService({
    settings: () => sessions.getSettings(),
    sessions: () => sessions.listAllSessions(),
    projects: () => sessions.listProjects(),
    ownsWorktree: (path) => sessions.ownsWorktree(path),
    projectRepos: () => prStore.projectRepos(),
    installedHarnesses: () => appTopic.harnesses.installed,
    recentModels: (driver) => preferences.recentModels()[driver] ?? [],
    listModels: (driver, projectId) => (projectId ? sessions.listModelsFor(projectId, driver) : sessions.listModelsForHarness(driver)),
    listPermissions: (driver, projectId) =>
      projectId ? sessions.listPermissionModesFor(projectId, driver) : sessions.listPermissionModesForHarness(driver),
    prSummary: (key) => prStore.summaryLookup().get(key),
    prDetail: (key) => prStore.detail(key),
    prDetailError: (key) => prStore.detailError(key),
    loadPrDetail: (ref) => prStore.loadDetail(ref),
    issueDetail: (ref) => githubSearch.issueDetail(ref),
    cachedRun: (ref) => githubViews.cachedRun(ref),
    checkLog: (ref, runId) => pullRequests.failedCheckLog(ref, runId),
    runLog: (ref) => runs.runLog(ref)
  });
  const workflowRunner = new WorkflowRunner({
    preview: (req) => workflowPreview.preview(req),
    resolveHarness: (req) => workflowPreview.resolveHarness(req),
    workflows: () => sessions.getSettings().prWorkflows,
    sessions: () => sessions.listAllSessions(),
    ownsWorktree: (path) => sessions.ownsWorktree(path),
    clone: (repo) => pullRequests.clone(repo),
    refreshProjectRepos: () => prStore.refreshProjectRepos(),
    createSession: (projectId, driver, options) => sessions.createSession(projectId, driver, options),
    setComposer: (sessionId, prefs) => {
      sessions.setComposer(sessionId, prefs);
    },
    linkPr: (sessionId, link) => {
      sessions.linkPr(sessionId, link);
    },
    linkIssue: (sessionId, link) => {
      sessions.linkIssue(sessionId, link);
    },
    linkRun: (sessionId, link) => {
      sessions.linkRun(sessionId, link);
    },
    markPrSeen: (sessionId, ref, headSha, seenAt) => {
      sessions.markPrSeen(sessionId, ref, headSha, seenAt);
    },
    markIssueSeen: (sessionId, ref, seenAt) => {
      sessions.markIssueSeen(sessionId, ref, seenAt);
    },
    markRunSeen: (sessionId, ref, seenAt) => {
      sessions.markRunSeen(sessionId, ref, seenAt);
    },
    startTurn: (sessionId, prompt, input) => turns.start(sessionId, prompt, input),
    postNotice: (sessionId, noticeId, text, severity) => sessions.emitNotice(sessionId, noticeId, text, severity)
  });
  const services: Services = {
    sessions,
    skills: new SkillsStore(),
    files: new FileService(),
    fileWatcher,
    filesTopic,
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
    harnessUpdates,
    threads,
    turns,
    autoFollowUp,
    sessionPrs,
    turnChanges,
    sidebar,
    workflowPreview,
    workflowRunner,
    sessionWatch: new SessionWatch({ getSession: (sessionId) => sessions.findSession(sessionId) }),
    subagentDelivery: new SubagentDelivery({
      sessions: () => sessions.listAllSessions(),
      runtime: (sessionId) => threads.runtime(sessionId),
      startTurn: (sessionId, prompt) => turns.start(sessionId, prompt, { auto: true, origin: "subagent-wake" }),
      markDelivered: (childId, turnId) => sessions.markSubagentDelivered(childId, turnId),
      postNotice: (sessionId, notice) => sessions.emitNotice(sessionId, notice.noticeId, notice.text, notice.severity),
      shutdownReserved: () => sessions.isShutdownReserved()
    })
  };
  wireServiceEvents(services, hooks);
  wireAutoFollowUp(services);
  wireSessionWatch(services);
  wireSubagentDelivery(services);
  wireUsage(services);
  wireSessionPrs(services);
  wireTurnChanges(services);
  wireSidebar(services);
  wireGitTopic(services);
  wireFilesTopic(services);
  wireGitHubViews(services);
  return services;
}
