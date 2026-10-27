import type { ServerClient, TopicCache } from "@cw-code/client";
import type {
  AppSettings,
  BranchMismatch,
  CliBinary,
  CliDiscoveredCandidate,
  CliDiscoverResult,
  ConnectionProfile,
  DesktopApi,
  DeviceCreateResult,
  DeviceInfo,
  DirectoryListing,
  DirEntry,
  FileReadResult,
  FileStatInfo,
  GitBaseline,
  GitBranchInfo,
  GitDiffResult,
  GitStatus,
  HarnessAvailability,
  ImportableSession,
  LegacyPreferences,
  SidebarReorderRequest,
  PrDetail,
  PrWorkflow,
  SavedGitHubView,
  ServerHost,
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
  UsageReport,
  WorkflowHarnessResult,
  WorkflowPreview,
  WorkflowRunResult,
  WorkflowTemplatePreview,
  WorktreePruneSummary
} from "@cw-code/contracts";
import { assertPasteImageSize } from "@cw-code/shared/protocol";
import type {
  ComposerChangedEvent,
  ComposerPrefs,
  CwApi,
  LocalActions,
  ModelOption,
  PermissionOption,
  Project,
  RetryConnectionResult,
  StopTurnResult,
  Session,
  SessionCleanupResult,
  ShellActions
} from "../cw.js";
import { ipcErrorMessage } from "../components/ipcError.js";
import { deriveCapabilities } from "../platform/capabilities.js";
import { createPtyAttachments, type PtyOpenResult } from "./ptyAttachments.js";

const BASE64_CHUNK = 0x8000;

function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...data.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

const BLOB_URL_LIFETIME_MS = 60_000;

export type ShutdownHandlers = Set<(event: ShutdownRequestedEvent) => void>;

type Call = <T>(method: string, params?: unknown) => Promise<T>;

function shellActions(desktop: DesktopApi): ShellActions {
  return {
    minimizeWindow: () => desktop.minimizeWindow(),
    toggleMaximizeWindow: () => desktop.toggleMaximizeWindow(),
    closeWindow: () => desktop.closeWindow(),
    isWindowMaximized: () => desktop.isWindowMaximized(),
    onWindowMaximized: (cb) => desktop.onWindowMaximized(cb),
    zoomIn: () => desktop.zoomIn(),
    zoomOut: () => desktop.zoomOut(),
    zoomReset: () => desktop.zoomReset(),
    updates: desktop.updates,
    connections: desktop.connections
  };
}

function localActions(desktop: DesktopApi, call: Call): LocalActions {
  return {
    pickProjectDir: () => desktop.pickDirectory(),
    openPath: (path) => desktop.openPath(path),
    revealPath: async (sessionId, path) => {
      const absolute = await call<string>("fs.resolvePath", { sessionId, path });
      await desktop.showItemInFolder(absolute);
    },
    openDataDir: async () => {
      const state = await call<StartupState>("startup.state");
      if (state.mode !== "recovery") throw new Error("cw-code is not in recovery mode");
      await desktop.openPath(state.dataDir);
    },
    openHarnessTrace: async () => {
      const result = await call<{ ok: boolean; path?: string; error?: string }>("debug.tracePath");
      if (!result.ok || !result.path) return result;
      try {
        await desktop.openPath(result.path);
        return { ok: true, path: result.path };
      } catch (err) {
        return { ok: false, path: result.path, error: ipcErrorMessage(err) };
      }
    }
  };
}

function openInBrowserTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sandboxedPreviewDocument(name: string, html: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<title>${escapeAttribute(name)}</title>`,
    "<style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style>",
    `</head><body><iframe sandbox="allow-popups" srcdoc="${escapeAttribute(html)}"></iframe></body></html>`
  ].join("");
}

function openHtmlInBrowserTab(name: string, html: string): void {
  const url = URL.createObjectURL(new Blob([sandboxedPreviewDocument(name, html)], { type: "text/html" }));
  openInBrowserTab(url);
  window.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
}

export function createCwApi(
  client: ServerClient,
  topics: TopicCache,
  desktop: DesktopApi | null,
  profile: ConnectionProfile | null,
  shutdownHandlers: ShutdownHandlers
): CwApi {
  const call: Call = <T>(method: string, params?: unknown): Promise<T> => client.call<T>(method, params);
  const callVoid = (method: string, params?: unknown): Promise<void> => client.call(method, params).then(() => undefined);
  const subscribe = <T>(channel: string, cb: (payload: T) => void): (() => void) => client.on(channel, (payload) => cb(payload as T));
  const ptyAttachments = createPtyAttachments((ptyId) => client.send("pty.detach", { ptyId }));
  const capabilities = deriveCapabilities(desktop, profile);

  return {
    topics,
    capabilities,
    shell: desktop ? shellActions(desktop) : null,
    local: desktop && capabilities.localServer ? localActions(desktop, call) : null,
    getStartupState: () => call<StartupState>("startup.state"),
    recovery: {
      restore: (file, backupPath) => callVoid("recovery.restore", { file, backupPath }),
      startFresh: (file) => callVoid("recovery.startFresh", { file }),
      retry: () => callVoid("recovery.retry")
    },
    shutdown: {
      assess: () => {
        desktop?.shutdown.acknowledge();
        return call<ShutdownAssessment>("shutdown.assess");
      },
      prepare: (request) => {
        desktop?.shutdown.acknowledge();
        return call<ShutdownPrepareResult>("shutdown.prepare", request);
      },
      force: (token) => call<ShutdownPrepareResult>("shutdown.force", { token }),
      cancel: (token) => callVoid("shutdown.cancel", { token }),
      quit: async (token) => {
        const result = await call<ShutdownCommitResult>("shutdown.quit", { token });
        if (result.ok) desktop?.shutdown.quit();
        return result;
      },
      quitWindow: () => desktop?.shutdown.quit(),
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
    reorderSidebar: (request: SidebarReorderRequest) => callVoid("sidebar.reorder", request),
    pushRecentModel: (driver, model) => callVoid("prefs.pushRecentModel", { driver, model }),
    setComposerDraft: (key, text, attachments) => callVoid("prefs.setDraft", { key, text, attachments }),
    discoverBinaries: (binaries?: CliBinary[]) => call<CliDiscoverResult>("cli.discover", { binaries }),
    verifyBinaryPath: (binary, path) => call<CliDiscoveredCandidate>("cli.verifyPath", { binary, path }),
    isDev: desktop?.isDev ?? import.meta.env.DEV === true,
    addProject: (rootPath) => call<Project>("projects.add", rootPath),
    updateProjectSettings: (projectId, settings) => call<Project>("projects.updateSettings", { projectId, settings }),
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
    getSubagentTools: (sessionId, agentId) => call<SubagentToolsResult>("sessions.subagentTools", { sessionId, agentId }),
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
        acceptFolderHead: opts?.acceptFolderHead
      }),
    stopTurn: (sessionId) => call<StopTurnResult>("turns.stop", { sessionId }),
    reloadHistory: (sessionId) => callVoid("threads.reloadHistory", { sessionId }),
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
    refreshGit: (sessionId) => callVoid("git.refresh", { sessionId }),
    checkBranchMismatch: (sessionId) => call<BranchMismatch | null>("git.checkMismatch", { sessionId }),
    keepFolderHead: (sessionId) => call<string | null>("git.keepFolderHead", { sessionId }),
    listGitBranches: (sessionId) => call<GitBranchInfo[]>("git.branches", { sessionId }),
    listProjectBranches: (projectId) => call<GitBranchInfo[]>("git.projectBranches", { projectId }),
    switchGitBranch: (sessionId, branch) => call<GitStatus>("git.switchBranch", { sessionId, branch }),
    getGitDiff: (sessionId, mode, baseRef) => call<GitDiffResult>("git.diff", { sessionId, mode, baseRef }),
    getTurnChanges: (sessionId) => call<TurnChanges | null>("git.turnChanges", { sessionId }),
    undoTurn: (sessionId, turnId, expectedEndSha) => call<TurnChanges>("git.undoTurn", { sessionId, turnId, expectedEndSha }),
    getSourceControlHealth: (projectId) => call<SourceControlHealth>("git.health", { projectId }),
    setProjectGitHubAccount: (projectId, account) => call<Project>("git.setProjectAccount", { projectId, account }),
    setRepositoryGitIdentity: (projectId, name, email) => callVoid("git.setIdentity", { projectId, name, email }),
    usageReport: (query) => call<UsageReport>("usage.report", query),
    refreshAccountUsage: (force, drivers) => callVoid("usage.refreshAccount", { force, ...(drivers ? { drivers } : {}) }),
    refreshPrInbox: (force) => callVoid("prs.refresh", { force }),
    getPrDetail: (ref) => call<PrDetail>("prs.detail", { ref }),
    watchPrDetail: (ref) => callVoid("prs.watchDetail", { ref }),
    unwatchPrDetail: (ref) => callVoid("prs.unwatchDetail", { ref }),
    getPrDiff: (ref) => call<string>("prs.diff", { ref }),
    getPrCheckLog: (ref, runId) => call<string>("prs.checkLog", { ref, runId }),
    refreshGitHubView: (topic, force) => callVoid("github.refresh", { topic, force }),
    githubViewCounts: (kind) => call<Record<string, number | null>>("github.viewCounts", { kind }),
    saveGitHubView: (input) => call<SavedGitHubView>("github.saveView", input),
    renameGitHubView: (id, name) => callVoid("github.renameView", { id, name }),
    deleteGitHubView: (id) => callVoid("github.deleteView", { id }),
    workflowPreview: (req) => call<WorkflowPreview>("workflows.preview", req),
    workflowHarness: (req) => call<WorkflowHarnessResult>("workflows.resolveHarness", req),
    workflowTemplatePreview: (req) => call<WorkflowTemplatePreview>("workflows.previewTemplate", req),
    runWorkflow: (req) => call<WorkflowRunResult>("workflows.run", req),
    linkSessionPr: (sessionId, link) => call<Session>("sessions.linkPr", { sessionId, link }),
    unlinkSessionPr: (sessionId, ref) => call<Session>("sessions.unlinkPr", { sessionId, ref }),
    sendPrUpdates: (sessionId, keys) => call<string>("prs.sendUpdates", { sessionId, keys }),
    dismissPrUpdates: (sessionId, keys) => callVoid("prs.dismissUpdates", { sessionId, keys }),
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
    workspaceRoot: (sessionId) => call<string>("fs.workspaceRoot", { sessionId }),
    listWorkspaceFiles: (sessionId) => call<string[]>("fs.listWorkspaceFiles", { sessionId }),
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
    reattachPty: (sessionId, kind, token) =>
      ptyAttachments.reattach(() => call<PtyOpenResult | null>("pty.reattach", { sessionId, kind, token })),
    writePty: (ptyId, data) => client.send("pty.write", { ptyId, data }),
    resizePty: (ptyId, cols, rows) => client.send("pty.resize", { ptyId, cols, rows }),
    detachPty: (ptyId) => ptyAttachments.detach(ptyId),
    onPtyData: (cb) => subscribe("pty.data", cb),
    onPtyExit: (cb) => subscribe("pty.exit", cb),
    openExternal: async (url) => {
      if (desktop) return desktop.openExternal(url);
      openInBrowserTab(url);
    },
    openHtml: async (name, html) => {
      if (desktop) return desktop.openHtml(name, html);
      openHtmlInBrowserTab(name, html);
    },
    browseDirectories: (path, showHidden) => call<DirectoryListing>("fs.browseDirectories", { path: path ?? null, showHidden }),
    getServerHost: () => call<ServerHost>("server.host"),
    devices: {
      list: () => call<DeviceInfo[]>("devices.list"),
      create: (name) => call<DeviceCreateResult>("devices.create", { name }),
      revoke: (id) => callVoid("devices.revoke", { id })
    },
    onDevicesChanged: (cb) => subscribe("devices.changed", cb)
  };
}
