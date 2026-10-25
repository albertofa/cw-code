import type { ServerClient, TopicCache } from "@cw-code/client";
import type {
  AccountUsageSnapshot,
  AppSettings,
  CliBinary,
  CliDiscoveredCandidate,
  CliDiscoverResult,
  DesktopApi,
  DirEntry,
  FileReadResult,
  FileStatInfo,
  GitBaseline,
  GitBranchInfo,
  GitDecorations,
  GitDiffResult,
  GitHubSearchResult,
  GitStatus,
  HarnessAvailability,
  ImportableSession,
  LegacyPreferences,
  IssueDetail,
  IssueSummary,
  PrDetail,
  PrInboxResult,
  PrSummary,
  PrWorkflow,
  ProjectGitHubRepo,
  RunsResult,
  ShutdownAssessment,
  ShutdownCommitResult,
  ShutdownPrepareResult,
  ShutdownRequestedEvent,
  SkillDetail,
  SkillMeta,
  SkillsListResult,
  SourceControlHealth,
  StartupState,
  SubagentToolsResult,
  TextSearchResult,
  TurnChanges,
  UsageLedgerRow,
  WorktreePruneSummary
} from "@cw-code/contracts";
import { assertPasteImageSize } from "@cw-code/shared/protocol";
import type {
  ActiveTurn,
  ComposerChangedEvent,
  ComposerPrefs,
  CwApi,
  HistoryMessage,
  ModelOption,
  PermissionOption,
  Project,
  RetryConnectionResult,
  Session,
  SessionCleanupResult
} from "../cw.js";
import { ipcErrorMessage } from "../components/ipcError.js";
import { createPtyAttachments, type PtyOpenResult } from "./ptyAttachments.js";

const BASE64_CHUNK = 0x8000;

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...data.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

export type ShutdownHandlers = Set<(event: ShutdownRequestedEvent) => void>;

export function createCwApi(client: ServerClient, topics: TopicCache, desktop: DesktopApi, shutdownHandlers: ShutdownHandlers): CwApi {
  const call = <T>(method: string, params?: unknown): Promise<T> => client.call<T>(method, params);
  const callVoid = (method: string, params?: unknown): Promise<void> => client.call(method, params).then(() => undefined);
  const subscribe = <T>(channel: string, cb: (payload: T) => void): (() => void) => client.on(channel, (payload) => cb(payload as T));
  const ptyAttachments = createPtyAttachments((ptyId) => client.send("pty.detach", { ptyId }));

  function searchGitHub(kind: "pr", query: string, countBase: string, force?: boolean): Promise<GitHubSearchResult<PrSummary>>;
  function searchGitHub(kind: "issue", query: string, countBase: string, force?: boolean): Promise<GitHubSearchResult<IssueSummary>>;
  function searchGitHub(kind: "pr" | "issue", query: string, countBase: string, force?: boolean): Promise<unknown> {
    return call("github.search", { kind, query, countBase, force });
  }

  return {
    topics,
    getStartupState: () => call<StartupState>("startup.state"),
    recovery: {
      openDataDir: async () => {
        const state = await call<StartupState>("startup.state");
        if (state.mode !== "recovery") throw new Error("cw-code is not in recovery mode");
        await desktop.openPath(state.dataDir);
      },
      restore: (file, backupPath) => callVoid("recovery.restore", { file, backupPath }),
      startFresh: (file) => callVoid("recovery.startFresh", { file }),
      retry: () => callVoid("recovery.retry")
    },
    updates: {
      getState: () => desktop.updates.getState(),
      check: () => desktop.updates.check(),
      download: () => desktop.updates.download(),
      setChannel: (channel) => desktop.updates.setChannel(channel),
      install: (request) => desktop.updates.install(request),
      onChanged: (cb) => desktop.updates.onChanged(cb)
    },
    shutdown: {
      assess: () => {
        desktop.shutdown.acknowledge();
        return call<ShutdownAssessment>("shutdown.assess");
      },
      prepare: (request) => {
        desktop.shutdown.acknowledge();
        return call<ShutdownPrepareResult>("shutdown.prepare", request);
      },
      force: (token) => call<ShutdownPrepareResult>("shutdown.force", { token }),
      cancel: (token) => callVoid("shutdown.cancel", { token }),
      quit: async (token) => {
        const result = await call<ShutdownCommitResult>("shutdown.quit", { token });
        if (result.ok) desktop.shutdown.quit();
        return result;
      },
      onRequested: (cb) => {
        shutdownHandlers.add(cb);
        return () => {
          shutdownHandlers.delete(cb);
        };
      },
      onExpired: (cb) => subscribe("shutdown.expired", cb)
    },
    recheckClis: () => call<HarnessAvailability>("cli.recheck", {}),
    importLegacyPrefs: (legacy: LegacyPreferences) => callVoid("prefs.importLegacy", legacy),
    pushRecentModel: (driver, model) => callVoid("prefs.pushRecentModel", { driver, model }),
    setComposerDraft: (key, text, attachments) => callVoid("prefs.setDraft", { key, text, attachments }),
    discoverBinaries: (binaries?: CliBinary[]) => call<CliDiscoverResult>("cli.discover", { binaries }),
    verifyBinaryPath: (binary, path) => call<CliDiscoveredCandidate>("cli.verifyPath", { binary, path }),
    isDev: desktop.isDev,
    openHarnessTrace: async () => {
      const result = await call<{ ok: boolean; path?: string; error?: string }>("debug.tracePath");
      if (!result.ok || !result.path) return result;
      try {
        await desktop.openPath(result.path);
        return { ok: true, path: result.path };
      } catch (err) {
        return { ok: false, path: result.path, error: ipcErrorMessage(err) };
      }
    },
    listProjects: () => call<Project[]>("projects.list"),
    addProject: (rootPath) => call<Project>("projects.add", rootPath),
    updateProjectSettings: (projectId, settings) => call<Project>("projects.updateSettings", { projectId, settings }),
    listSessions: (projectId) => call<Session[]>("sessions.list", projectId),
    createSession: (projectId, driver, options) => call<Session>("sessions.create", { projectId, driver, options }),
    listImportableSessions: (driver) => call<ImportableSession[]>("sessions.importable", driver),
    importSession: (request) => call<{ project: Project; session: Session }>("sessions.import", request),
    renameSession: (sessionId, title) => callVoid("sessions.rename", { sessionId, title }),
    regenerateSessionTitle: (sessionId) => call<string>("sessions.regenerateTitle", { sessionId }),
    setSessionStatus: (sessionId, status, reason) => call<Session>("sessions.setStatus", { sessionId, status, reason }),
    markSessionWorking: (sessionId) => call<Session>("sessions.markWorking", { sessionId }),
    restoreSession: (sessionId) => call<Session>("sessions.restore", { sessionId }),
    markTurnSeen: (sessionId) => callVoid("sessions.markTurnSeen", { sessionId }),
    openSession: (sessionId, reason) => callVoid("sessions.open", { sessionId, reason }),
    pauseAutoFollowUp: (sessionId) => callVoid("sessions.pauseAutoFollowUp", { sessionId }),
    resumeAutoFollowUp: (sessionId) => callVoid("sessions.resumeAutoFollowUp", { sessionId }),
    resolveSession: (sessionId, status, removeWorktree, forceBranch) =>
      call<SessionCleanupResult>("sessions.resolve", { sessionId, status, removeWorktree, forceBranch }),
    pruneStaleWorktrees: () => call<WorktreePruneSummary>("worktrees.prune"),
    getHistory: (sessionId) => call<HistoryMessage[]>("sessions.history", { sessionId }),
    getSubagentTools: (sessionId, agentId) => call<SubagentToolsResult>("sessions.subagentTools", { sessionId, agentId }),
    activeTurns: () => call<ActiveTurn[]>("sessions.activeTurns"),
    retryConnection: (sessionId) => call<RetryConnectionResult>("sessions.retryConnection", { sessionId }),
    startTurn: (sessionId, prompt, opts) =>
      call<string>("turns.start", {
        sessionId,
        prompt,
        prefs: opts?.prefs,
        attachments: opts?.attachments,
        command: opts?.command,
        skills: opts?.skills,
        prRefs: opts?.prRefs,
        finalReview: opts?.finalReview,
        acceptFolderHead: opts?.acceptFolderHead
      }),
    interrupt: (turnId) => callVoid("turns.interrupt", { turnId }),
    respondApproval: (requestId, decision) => callVoid("approvals.respond", { requestId, decision }),
    respondQuestion: (requestId, answers) => callVoid("questions.respond", { requestId, answers }),
    listCommands: (sessionId) => call("commands.list", { sessionId }),
    listCommandsFor: (projectId, driver) => call("commands.listFor", { projectId, driver }),
    listModels: (sessionId) => call<ModelOption[]>("models.list", { sessionId }),
    listModelsFor: (projectId, driver) => call<ModelOption[]>("models.listFor", { projectId, driver }),
    listModelsForHarness: (driver) => call<ModelOption[]>("models.listForHarness", { driver }),
    listPermissions: (sessionId) => call<PermissionOption[]>("permissions.list", { sessionId }),
    listPermissionsFor: (projectId, driver) => call<PermissionOption[]>("permissions.listFor", { projectId, driver }),
    listPermissionsForHarness: (driver) => call<PermissionOption[]>("permissions.listForHarness", { driver }),
    getComposer: (sessionId) => call<ComposerPrefs>("composer.get", { sessionId }),
    setComposer: (sessionId, prefs) => call<ComposerPrefs>("composer.set", { sessionId, prefs }),
    setSettings: (patch) => call<AppSettings>("settings.set", patch),
    getDefaultPrWorkflows: () => call<PrWorkflow[]>("settings.prWorkflowDefaults"),
    skills: {
      list: () => call<SkillsListResult>("skills.list"),
      get: (name) => call<SkillDetail>("skills.get", name),
      save: (input) => call<SkillDetail>("skills.save", input),
      remove: (name) => call<SkillsListResult>("skills.remove", name),
      setEnabled: (name, harness, on) => call<SkillMeta>("skills.setEnabled", { name, harness, on }),
      importAll: () => call<SkillsListResult>("skills.importAll")
    },
    getGitStatus: (sessionId) => call<GitStatus>("git.status", { sessionId }),
    onGitStatus: (cb) => subscribe("git.statusChanged", cb),
    listGitBranches: (sessionId) => call<GitBranchInfo[]>("git.branches", { sessionId }),
    listProjectBranches: (projectId) => call<GitBranchInfo[]>("git.projectBranches", { projectId }),
    switchGitBranch: (sessionId, branch) => call<GitStatus>("git.switchBranch", { sessionId, branch }),
    getGitDiff: (sessionId, mode, baseRef) => call<GitDiffResult>("git.diff", { sessionId, mode, baseRef }),
    getTurnChanges: (sessionId) => call<TurnChanges | null>("git.turnChanges", { sessionId }),
    undoTurn: (sessionId, turnId, expectedEndSha) => call<TurnChanges>("git.undoTurn", { sessionId, turnId, expectedEndSha }),
    getSourceControlHealth: (projectId) => call<SourceControlHealth>("git.health", { projectId }),
    setProjectGitHubAccount: (projectId, account) => call<Project>("git.setProjectAccount", { projectId, account }),
    setRepositoryGitIdentity: (projectId, name, email) => callVoid("git.setIdentity", { projectId, name, email }),
    getUsageLedger: (query) => call<UsageLedgerRow[]>("usage.ledger", query),
    getAccountUsage: (drivers, force) => call<AccountUsageSnapshot[]>("usage.account", { drivers, force }),
    getPrInbox: (force) => call<PrInboxResult>("prs.inbox", { force }),
    getTrackedPrs: () => call<PrSummary[]>("prs.tracked"),
    onTrackedPrs: (cb) => subscribe("prs.tracked", cb),
    getPrDetail: (ref) => call<PrDetail>("prs.detail", { ref }),
    getPrDiff: (ref) => call<string>("prs.diff", { ref }),
    getPrCheckLog: (ref, runId) => call<string>("prs.checkLog", { ref, runId }),
    searchGitHub,
    countGitHub: (kind, queries) => call<Array<number | null>>("github.counts", { kind, queries }),
    getIssueDetail: (ref) => call<IssueDetail>("github.issueDetail", { ref }),
    getGitHubRuns: (sources, force) => call<RunsResult>("github.runs", { sources, force }),
    getRunLog: (ref) => call<string>("github.runLog", { ref }),
    watchGitHubRuns: (refs) => callVoid("github.watchRuns", { refs }),
    onGitHubRunsChanged: (cb) => subscribe("github.runsChanged", cb),
    onGitHubCiActivity: (cb) => client.on("github.ciActivity", () => cb()),
    cloneGitHubRepo: (repo) => call<Project>("github.clone", { repo }),
    getProjectGitHubRepos: () => call<ProjectGitHubRepo[]>("prs.projectRepos"),
    linkSessionPr: (sessionId, link) => call<Session>("sessions.linkPr", { sessionId, link }),
    unlinkSessionPr: (sessionId, ref) => call<Session>("sessions.unlinkPr", { sessionId, ref }),
    markSessionPrSeen: (sessionId, ref, headSha, seenAt) => call<Session>("sessions.markPrSeen", { sessionId, ref, headSha, seenAt }),
    linkSessionIssue: (sessionId, link) => call<Session>("sessions.linkIssue", { sessionId, link }),
    unlinkSessionIssue: (sessionId, ref) => call<Session>("sessions.unlinkIssue", { sessionId, ref }),
    markSessionIssueSeen: (sessionId, ref, seenAt) => call<Session>("sessions.markIssueSeen", { sessionId, ref, seenAt }),
    linkSessionRun: (sessionId, link) => call<Session>("sessions.linkRun", { sessionId, link }),
    unlinkSessionRun: (sessionId, ref) => call<Session>("sessions.unlinkRun", { sessionId, ref }),
    markSessionRunSeen: (sessionId, ref, seenAt) => call<Session>("sessions.markRunSeen", { sessionId, ref, seenAt }),
    onTurnEvent: (cb) => subscribe("turn.event", cb),
    onSessionTitle: (cb) => subscribe("session.title", cb),
    onSessionUpdated: (cb) => subscribe("session.updated", cb),
    onProjectChanged: (cb) => subscribe("projects.changed", cb),
    onSkillsChanged: (cb) => subscribe("skills.changed", cb),
    onComposerChanged: (cb) => subscribe("composer.changed", cb),
    readFile: (sessionId, path) => call<string>("fs.readFile", { sessionId, path }),
    readOutsideFile: (path) => call<string>("fs.readOutsideFile", { path }),
    listFiles: (sessionId) => call<string[]>("fs.listFiles", { sessionId }),
    listProjectFiles: (projectId) => call<string[]>("fs.listProjectFiles", { projectId }),
    listDir: (sessionId, dir) => call<DirEntry[]>("fs.listDir", { sessionId, dir }),
    readFileInfo: (sessionId, path) => call<FileReadResult>("fs.readFileInfo", { sessionId, path }),
    writeFileGuarded: (sessionId, path, content, expectedMtimeMs) =>
      call<FileStatInfo>("fs.writeFileGuarded", { sessionId, path, content, expectedMtimeMs }),
    createFile: (sessionId, path) => callVoid("fs.createFile", { sessionId, path }),
    createDir: (sessionId, path) => callVoid("fs.createDir", { sessionId, path }),
    renamePath: (sessionId, from, to) => callVoid("fs.renamePath", { sessionId, from, to }),
    trashPath: (sessionId, path) => callVoid("fs.trashPath", { sessionId, path }),
    revealPath: async (sessionId, path) => {
      const absolute = await call<string>("fs.resolvePath", { sessionId, path });
      await desktop.showItemInFolder(absolute);
    },
    workspaceRoot: (sessionId) => call<string>("fs.workspaceRoot", { sessionId }),
    listWorkspaceFiles: (sessionId) => call<string[]>("fs.listWorkspaceFiles", { sessionId }),
    gitDecorations: (sessionId) => call<GitDecorations>("fs.gitDecorations", { sessionId }),
    gitBaseline: (sessionId, path) => call<GitBaseline>("fs.gitBaseline", { sessionId, path }),
    searchText: (sessionId, query) => call<TextSearchResult>("fs.searchText", { sessionId, query }),
    setWatchedPaths: (sessionId, paths) => callVoid("fs.setWatchedPaths", { sessionId, paths }),
    onFsChanged: (cb) => subscribe("fs.changed", cb),
    savePasteImage: async (projectId, mime, data) => {
      assertPasteImageSize(data.byteLength);
      return call<string>("fs.savePasteImage", { projectId, mime, base64: toBase64(data) });
    },
    readImage: (args) => call<{ mime: string; base64: string }>("fs.readImage", args),
    openPty: (sessionId, kind) => ptyAttachments.open(() => call<PtyOpenResult>("pty.open", { sessionId, kind })),
    writePty: (ptyId, data) => client.send("pty.write", { ptyId, data }),
    resizePty: (ptyId, cols, rows) => client.send("pty.resize", { ptyId, cols, rows }),
    detachPty: (ptyId) => ptyAttachments.detach(ptyId),
    killPty: (ptyId) => client.send("pty.kill", { ptyId }),
    onPtyData: (cb) => subscribe("pty.data", cb),
    onPtyExit: (cb) => subscribe("pty.exit", cb),
    minimizeWindow: () => desktop.minimizeWindow(),
    toggleMaximizeWindow: () => desktop.toggleMaximizeWindow(),
    closeWindow: () => desktop.closeWindow(),
    isWindowMaximized: () => desktop.isWindowMaximized(),
    onWindowMaximized: (cb) => desktop.onWindowMaximized(cb),
    zoomIn: () => desktop.zoomIn(),
    zoomOut: () => desktop.zoomOut(),
    zoomReset: () => desktop.zoomReset(),
    setAttention: (state) => desktop.setAttention(state),
    pickProjectDir: () => desktop.pickDirectory(),
    openPath: (path) => desktop.openPath(path),
    openExternal: (url) => desktop.openExternal(url),
    openHtml: (name, html) => desktop.openHtml(name, html)
  };
}
