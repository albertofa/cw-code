import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolvePreload(): string {
  const candidates = ["index.js", "index.mjs", "index.cjs"].map((f) =>
    join(__dirname, "..", "preload", f)
  );
  const found = candidates.find((p) => existsSync(p));
  if (!found) console.warn(`preload not found (tried ${candidates.join(", ")})`);
  return found ?? candidates[0];
}
import { checkCliVersion, checkCliVersions, type CliVersionCheck } from "./cliVersions.js";
import { discoverBinaries, verifyBinaryPath } from "./cli/binaryDiscovery.js";
import { getHarnessTracePath, initHarnessTrace } from "./debug/harnessTrace.js";
import { appendCrashLog, initCrashLog } from "./debug/crashLog.js";
import { claudeCommandsCachePath, ensureAppDirs, attachmentsDir, logsDir, migrateFromUserData, opencodeModelsCachePath, sessionDbPath, settingsFilePath, userdataDir } from "./paths/appPaths.js";
import { reapOrphanedServers } from "./orphanServers.js";
import type { ApprovalDecision, CliBinary, CommandInvocation, CreateSessionOptions, GitDiffMode, ProjectGitHubRepo, PrRef, SessionPrLink, MetadataIssue, SessionStatus, SettingsPatch, StartupState, UsageLedgerQuery } from "@cw-code/contracts";
import type { DriverKind, HarnessId, SkillSaveInput } from "@cw-code/contracts";
import type { PtyKind } from "./pty/PtyPool.js";
import { SessionManager } from "./sessions/SessionManager.js";
import { AccountUsageService } from "./usage/AccountUsageService.js";
import { SkillsStore } from "./skills/SkillsStore.js";
import { FileService, IMAGE_MAX_BYTES, imageExtMime } from "./fs/FileService.js";
import { GitService } from "./fs/GitService.js";
import { assertPrRef, PullRequestService } from "./github/PullRequestService.js";
import { PtyPool } from "./pty/PtyPool.js";
import { readWindowsTerminalFontFace } from "./pty/terminalFont.js";
import { defaultPrWorkflows } from "./settings/prWorkflowDefaults.js";
import { configuredCliBinaryPath } from "./settings/settingsUtils.js";
import { initOpencodeModelsCache } from "./providers/opencode/opencodeModels.js";
import { initClaudeCommandsCache } from "./providers/claude/claudeCommands.js";
import { metadataSchemaFor, openMetadataStores } from "./storage/metadataStores.js";
import { restoreBackup, startFresh } from "./storage/recovery.js";
import type { SessionStore } from "./sessions/SessionStore.js";
import type { SettingsStore } from "./settings/SettingsStore.js";

type DriverName = DriverKind;

const DRIVER_KINDS: DriverKind[] = ["claude", "opencode", "codex"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidUsageLedgerQuery(query: unknown): query is UsageLedgerQuery | undefined {
  if (query === undefined) return true;
  if (!query || typeof query !== "object") return false;
  const q = query as Record<string, unknown>;
  if (q.sinceDay !== undefined && (typeof q.sinceDay !== "string" || !DAY_RE.test(q.sinceDay))) return false;
  if (q.sessionId !== undefined && typeof q.sessionId !== "string") return false;
  return true;
}

interface Services {
  sessions: SessionManager;
  skills: SkillsStore;
  files: FileService;
  git: GitService;
  pullRequests: PullRequestService;
  ptys: PtyPool;
  accountUsage: AccountUsageService;
}

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;
let startupState: StartupState = { mode: "ready" };

function createServices(stores: { sessionStore: SessionStore; settingsStore: SettingsStore }): Services {
  let pullRequests: PullRequestService;
  const sessions = new SessionManager({
    sessionStore: stores.sessionStore,
    settingsStore: stores.settingsStore,
    prHead: (ref) => pullRequests.knownHead(ref),
    prHeadRefresh: (ref) => pullRequests.refreshHead(ref),
    prState: (ref) => pullRequests.knownState(ref),
    prUpdatedAt: (ref) => pullRequests.knownUpdatedAt(ref)
  });
  const git = new GitService(() => sessions.getSettings());
  pullRequests = new PullRequestService(git, () => sessions.getSettings(), (rootPath) => sessions.addProject(rootPath));
  return {
    sessions,
    skills: new SkillsStore(),
    files: new FileService(),
    git,
    pullRequests,
    ptys: new PtyPool(() => sessions.getSettings()),
    accountUsage: new AccountUsageService(() => sessions.getDrivers())
  };
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    frame: false,
    title: "cw-code",
    icon: app.isPackaged
      ? join(process.resourcesPath, "branding", "icon.ico")
      : join(app.getAppPath(), "resources", "icon.ico"),
    backgroundColor: "#141518",
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      sandbox: false,
      ...(process.env["ELECTRON_RENDERER_URL"] ? { partition: "dev" } : {})
    }
  });

  mainWindow.on("maximize", () => mainWindow?.webContents.send("win.maximized", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("win.maximized", false));
  mainWindow.on("unresponsive", () => appendCrashLog("window unresponsive"));

  const webContents = mainWindow.webContents;
  webContents.on("render-process-gone", (_e, details) => {
    appendCrashLog(
      `render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`
    );
    services?.ptys.detachAll();
    void webContents.reload();
  });
  webContents.on("console-message", (event) => {
    if (event.level === "error") {
      appendCrashLog(`renderer error: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(rendererIndexPath());
  }
}

function rendererIndexPath(): string {
  return join(__dirname, "../renderer/index.html");
}

function isAppUrl(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) return target.origin === new URL(devUrl).origin;
  const indexPath = pathToFileURL(rendererIndexPath()).pathname;
  return target.protocol === "file:" && target.host === "" && target.pathname.toLowerCase() === indexPath.toLowerCase();
}

function windowFromSender(sender: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender);
}

const ZOOM_MIN = -5;
const ZOOM_MAX = 5;

function bumpZoom(sender: WebContents, delta: number): void {
  const w = windowFromSender(sender);
  if (!w) return;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, w.webContents.getZoomLevel() + delta));
  w.webContents.setZoomLevel(next);
}

function isInsideAttachmentsDir(target: string): boolean {
  let base = resolve(attachmentsDir());
  let abs = resolve(target);
  if (process.platform === "win32") {
    base = base.toLowerCase();
    abs = abs.toLowerCase();
  }
  const rel = relative(base, abs);
  if (rel === "" || rel === ".") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return true;
}

function relaunch(): void {
  app.relaunch();
  app.exit(0);
}

function registerWindowIpc(): void {
  ipcMain.on("win.minimize", (e) => windowFromSender(e.sender)?.minimize());
  ipcMain.on("win.toggle-maximize", (e) => {
    const w = windowFromSender(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on("win.close", (e) => windowFromSender(e.sender)?.close());
  ipcMain.handle("win.is-maximized", (e) => windowFromSender(e.sender)?.isMaximized() ?? false);

  ipcMain.on("win.zoom-in", (e) => bumpZoom(e.sender, 1));
  ipcMain.on("win.zoom-out", (e) => bumpZoom(e.sender, -1));
  ipcMain.on("win.zoom-reset", (e) => windowFromSender(e.sender)?.webContents.setZoomLevel(0));
}

function recoveryIssueFor(args: { file?: unknown } | undefined): MetadataIssue {
  if (startupState.mode !== "recovery") throw new Error("cw-code is not in recovery mode");
  if (!args || typeof args.file !== "string") throw new Error("a recovery action requires { file }");
  const file = args.file;
  const issue = startupState.issues.find((candidate) => candidate.file === file);
  if (!issue) throw new Error(`${file} is not a file that needs recovery`);
  return issue;
}

function registerStartupIpc(): void {
  ipcMain.handle("startup.state", (): StartupState => startupState);
  ipcMain.handle("recovery.openDataDir", async (): Promise<void> => {
    const failure = await shell.openPath(userdataDir());
    if (failure) throw new Error(`could not open ${userdataDir()}: ${failure}`);
  });
  ipcMain.handle("recovery.restore", (_e, args: { file: string; backupPath: string }): void => {
    if (!args || typeof args.backupPath !== "string") throw new Error("recovery.restore requires { file, backupPath }");
    const issue = recoveryIssueFor(args);
    const result = restoreBackup(issue.file, args.backupPath, metadataSchemaFor(issue.store));
    console.warn(
      `restored ${result.file} from ${result.restoredFrom}${result.brokenPath ? `; previous file kept at ${result.brokenPath}` : ""}`
    );
    relaunch();
  });
  ipcMain.handle("recovery.startFresh", (_e, args: { file: string }): void => {
    const issue = recoveryIssueFor(args);
    const result = startFresh(issue.file, metadataSchemaFor(issue.store));
    console.warn(
      `started ${result.file} fresh${result.brokenPath ? `; previous file kept at ${result.brokenPath}` : ""}`
    );
    relaunch();
  });
  ipcMain.handle("recovery.retry", (): void => {
    if (startupState.mode !== "recovery") throw new Error("cw-code is not in recovery mode");
    relaunch();
  });
}

function registerIpc({ sessions, skills, files, git, pullRequests, ptys, accountUsage }: Services): void {
  sessions.setEmitter((sessionId, event) => {
    mainWindow?.webContents.send("turn.event", { sessionId, event });
  });
  sessions.setTitleEmitter((sessionId, title) => {
    mainWindow?.webContents.send("session.title", { sessionId, title });
  });
  sessions.setSessionEmitter((session) => {
    mainWindow?.webContents.send("session.updated", session);
  });
  ptys.setExitEmitter((ptyId, token, exitCode) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("pty.exit", { ptyId, token, exitCode });
  });
  ipcMain.handle("cli.checkVersions", () => {
    const s = sessions.getSettings();
    return checkCliVersions({
      claudeBinary: s.claudeBinaryPath,
      opencodeBinary: s.opencodeBinaryPath,
      codexBinary: s.codexBinaryPath
    });
  });
  ipcMain.handle("cli.discover", (_e, args: { binaries?: CliBinary[] }) => discoverBinaries(args?.binaries));
  ipcMain.handle("cli.verifyPath", (_e, args: { binary: CliBinary; path: string }) => {
    if (!args || typeof args.binary !== "string" || typeof args.path !== "string") {
      throw new Error("cli.verifyPath requires { binary, path }");
    }
    return verifyBinaryPath(args.binary, args.path);
  });
  ipcMain.handle("settings.get", () => sessions.getSettings());
  ipcMain.handle("settings.prWorkflowDefaults", () => defaultPrWorkflows());
  ipcMain.handle("skills.list", () => skills.listSkills());
  ipcMain.handle("skills.get", (_e, name: string) => skills.getSkill(name));
  ipcMain.handle("skills.save", (_e, input: SkillSaveInput) => skills.saveSkill(input));
  ipcMain.handle("skills.remove", (_e, name: string) => skills.removeSkill(name));
  ipcMain.handle(
    "skills.setEnabled",
    (_e, args: { name: string; harness: HarnessId; on: boolean }) =>
      skills.setSkillEnabled(args.name, args.harness, args.on)
  );
  ipcMain.handle("skills.importAll", () => skills.importSkills());
  ipcMain.handle("settings.set", async (_e, patch: SettingsPatch) => {
    const current = sessions.getSettings();
    const normalized = { ...patch };
    const checks: Array<Promise<CliVersionCheck>> = [];
    if (patch.claudeBinaryPath !== undefined) {
      normalized.claudeBinaryPath = configuredCliBinaryPath("claude", patch.claudeBinaryPath);
      if (normalized.claudeBinaryPath !== current.claudeBinaryPath) {
        checks.push(checkCliVersion("claude", normalized.claudeBinaryPath));
      }
    }
    if (patch.opencodeBinaryPath !== undefined) {
      normalized.opencodeBinaryPath = configuredCliBinaryPath("opencode", patch.opencodeBinaryPath);
      if (normalized.opencodeBinaryPath !== current.opencodeBinaryPath) {
        checks.push(checkCliVersion("opencode", normalized.opencodeBinaryPath));
      }
    }
    if (patch.codexBinaryPath !== undefined) {
      normalized.codexBinaryPath = configuredCliBinaryPath("codex", patch.codexBinaryPath);
      if (normalized.codexBinaryPath !== current.codexBinaryPath) {
        checks.push(checkCliVersion("codex", normalized.codexBinaryPath));
      }
    }
    const failed = (await Promise.all(checks)).find((check) => check.error !== null || !check.ok);
    if (failed) {
      const name = failed.binary === "claude" ? "Claude" : failed.binary === "codex" ? "Codex" : "OpenCode";
      const reason = !failed.available
        ? "Choose a valid executable name or full path."
        : failed.error !== null
          ? "The executable did not complete '--version' successfully."
          : `It reported version ${failed.actual ?? "unknown"} but needs >= ${failed.minimum}. Update the CLI to use it.`;
      throw new Error(`${name} CLI could not be verified at '${failed.binaryPath}'. ${reason}`);
    }
    if (patch.opencodeGoUsage !== undefined) accountUsage.invalidate("opencode");
    return sessions.setSettings(normalized);
  });
  ipcMain.handle(
    "approvals.respond",
    (_e, args: { sessionId: string; requestId: string; decision: ApprovalDecision }) =>
      sessions.respondApproval(args.requestId, args.decision)
  );
  ipcMain.handle(
    "questions.respond",
    (_e, args: { sessionId: string; requestId: string; answers: Record<string, string> }) =>
      sessions.respondQuestion(args.requestId, args.answers)
  );
  ipcMain.handle("projects.list", () => sessions.listProjects());
  ipcMain.handle("projects.add", (_e, rootPath: string) => sessions.addProject(rootPath));
  ipcMain.handle("os.homeDir", () => homedir());
  ipcMain.handle("sessions.list", (_e, projectId: string) => sessions.listSessions(projectId));
  ipcMain.handle("sessions.discovered", (_e, projectId: string) => sessions.listDiscovered(projectId));
  ipcMain.handle(
    "sessions.import",
    (_e, args: { projectId: string; driver: DriverName; resumeCursor: string; title: string }) =>
      sessions.importSession(args.projectId, args.driver, args.resumeCursor, args.title)
  );
  ipcMain.handle("sessions.create", (_e, args: { projectId: string; driver: DriverName; options?: CreateSessionOptions }) =>
    sessions.createSession(args.projectId, args.driver, args.options)
  );
  ipcMain.handle("sessions.rename", (_e, args: { sessionId: string; title: string }) =>
    sessions.renameSession(args.sessionId, args.title)
  );
  ipcMain.handle("sessions.regenerateTitle", (_e, args: { sessionId: string }) =>
    sessions.regenerateTitle(args.sessionId)
  );
  ipcMain.handle("sessions.setStatus", (_e, args: { sessionId: string; status: SessionStatus }) => {
    const updated = sessions.setSessionStatus(args.sessionId, args.status);
    if (updated.status === "resolved" || updated.status === "archived") ptys.killSession(args.sessionId);
    return updated;
  });
  ipcMain.handle("sessions.expireHolding", (_e, sessionIds: string[]) =>
    sessions.expireHoldingSessions(sessionIds)
  );
  ipcMain.handle(
    "sessions.resolve",
    async (_e, args: { sessionId: string; status: SessionStatus; removeWorktree?: boolean; forceBranch?: boolean }) => {
      const result = await sessions.resolveSession(args.sessionId, args.status, { removeWorktree: args.removeWorktree, forceBranch: args.forceBranch });
      if (result.status === "resolved" || result.status === "archived") ptys.killSession(args.sessionId);
      return result;
    }
  );
  ipcMain.handle("worktrees.prune", () => sessions.pruneStaleWorktrees());
  ipcMain.handle("sessions.history", (_e, args: { sessionId: string }) =>
    sessions.getHistory(args.sessionId)
  );
  ipcMain.handle("sessions.subagentTools", (_e, args: { sessionId: string; agentId: string }) =>
    sessions.getSubagentTools(args.sessionId, args.agentId)
  );
  ipcMain.handle("sessions.activeTurns", () => sessions.listActiveTurns());
  ipcMain.handle("sessions.retryConnection", (_e, args: { sessionId: string }) =>
    sessions.retryConnection(args.sessionId)
  );
  ipcMain.handle(
    "turns.start",
    (
      _e,
      args: {
        sessionId: string;
        prompt: string;
        prefs?: { model?: string; effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; variant?: string; permissionMode?: "auto" | "acceptEdits" | "bypassPermissions" | "manual" };
        attachments?: string[];
        command?: CommandInvocation;
        prRefs?: PrRef[];
      }
    ) => {
      if (args.prRefs !== undefined && !Array.isArray(args.prRefs)) throw new Error("invalid prRefs");
      for (const ref of args.prRefs ?? []) assertPrRef(ref);
      return sessions.startTurn(args.sessionId, args.prompt, {
        prefs: args.prefs,
        attachments: args.attachments,
        ...(args.command ? { command: args.command } : {}),
        prRefs: args.prRefs
      });
    }
  );
  ipcMain.handle("turns.interrupt", (_e, args: { turnId: string }) => sessions.interrupt(args.turnId));
  ipcMain.handle("commands.list", (_e, args: { sessionId: string }) => sessions.listCommands(args.sessionId));
  ipcMain.handle("commands.listFor", (_e, args: { projectId: string; driver: DriverName }) =>
    sessions.listCommandsFor(args.projectId, args.driver)
  );
  ipcMain.handle("models.list", (_e, args: { sessionId: string }) => sessions.listModels(args.sessionId));
  ipcMain.handle(
    "models.listFor",
    (_e, args: { projectId: string; driver: DriverName }) =>
      sessions.listModelsFor(args.projectId, args.driver)
  );
  ipcMain.handle("models.listForHarness", (_e, args: { driver: DriverName }) =>
    sessions.listModelsForHarness(args.driver)
  );
  ipcMain.handle("permissions.list", (_e, args: { sessionId: string }) =>
    sessions.listPermissionModes(args.sessionId)
  );
  ipcMain.handle(
    "permissions.listFor",
    (_e, args: { projectId: string; driver: DriverName }) =>
      sessions.listPermissionModesFor(args.projectId, args.driver)
  );
  ipcMain.handle("permissions.listForHarness", (_e, args: { driver: DriverName }) =>
    sessions.listPermissionModesForHarness(args.driver)
  );
  ipcMain.handle("composer.get", (_e, args: { sessionId: string }) => sessions.getComposer(args.sessionId));
  ipcMain.handle(
    "composer.set",
    (_e, args: { sessionId: string; prefs: { model?: string; effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; variant?: string; permissionMode?: "auto" | "acceptEdits" | "bypassPermissions" | "manual" } }) =>
      sessions.setComposer(args.sessionId, args.prefs)
  );
  ipcMain.handle("git.status", async (_e, args: { sessionId: string }) => {
    const root = await sessions.ensureWorktree(args.sessionId);
    const status = await git.status(root, sessions.projectForSession(args.sessionId));
    try {
      sessions.syncPrLink(args.sessionId, status);
    } catch (error) {
      console.warn(`syncPrLink failed for ${args.sessionId}: ${(error as Error).message}`);
    }
    return status;
  });
  ipcMain.handle("sessions.linkPr", (_e, args: { sessionId: string; link: SessionPrLink }) => {
    const link = args.link;
    assertPrRef(link.ref);
    if (link.origin !== "opened" && link.origin !== "workflow" && link.origin !== "linked") {
      throw new Error(`invalid pull request link origin '${String(link.origin)}'`);
    }
    if (link.workflowId !== undefined && typeof link.workflowId !== "string") {
      throw new Error("invalid workflowId");
    }
    if (typeof link.lastSeenSha !== "string") throw new Error("invalid lastSeenSha");
    if (typeof link.lastSeenAt !== "number" || !Number.isFinite(link.lastSeenAt)) throw new Error("invalid lastSeenAt");
    return sessions.linkPr(args.sessionId, {
      ref: link.ref,
      origin: link.origin,
      ...(link.workflowId !== undefined ? { workflowId: link.workflowId } : {}),
      lastSeenSha: link.lastSeenSha,
      lastSeenAt: link.lastSeenAt
    });
  });
  ipcMain.handle("sessions.unlinkPr", (_e, args: { sessionId: string; ref: PrRef }) => {
    assertPrRef(args.ref);
    return sessions.unlinkPr(args.sessionId, args.ref);
  });
  ipcMain.handle("sessions.markPrSeen", (_e, args: { sessionId: string; ref: PrRef; headSha: string | null; seenAt: number | null }) => {
    assertPrRef(args.ref);
    if (args.headSha !== null && typeof args.headSha !== "string") throw new Error("invalid headSha");
    if (args.seenAt !== null && !Number.isFinite(args.seenAt)) throw new Error("invalid seenAt");
    return sessions.markPrSeen(args.sessionId, args.ref, args.headSha, args.seenAt);
  });
  ipcMain.handle("git.branches", (_e, args: { sessionId: string }) =>
    sessions.ensureWorktree(args.sessionId).then((root) => git.branches(root))
  );
  ipcMain.handle("git.projectBranches", (_e, args: { projectId: string }) =>
    git.branches(sessions.rootForProject(args.projectId))
  );
  ipcMain.handle("git.switchBranch", async (_e, args: { sessionId: string; branch: string }) => {
    const root = await sessions.ensureWorktree(args.sessionId);
    const status = await git.switchBranch(root, args.branch, sessions.projectForSession(args.sessionId));
    sessions.updateSessionBranch(args.sessionId, status.branch);
    return status;
  });
  ipcMain.handle("git.diff", (_e, args: { sessionId: string; mode: GitDiffMode; baseRef?: string }) =>
    sessions.ensureWorktree(args.sessionId).then((root) => git.diff(root, args.mode, args.baseRef))
  );
  ipcMain.handle("git.health", (_e, args: { projectId?: string }) => {
    if (!args.projectId) return git.health();
    const project = sessions.getProject(args.projectId);
    return git.health(project.rootPath, project);
  });
  ipcMain.handle("git.setProjectAccount", (_e, args: { projectId: string; account: { host: string; login: string } | null }) =>
    sessions.setProjectGitHubAccount(args.projectId, args.account)
  );
  ipcMain.handle("git.setIdentity", (_e, args: { projectId: string; name: string; email: string }) =>
    git.setRepositoryIdentity(sessions.rootForProject(args.projectId), args.name, args.email)
  );

  ipcMain.handle("usage.ledger", (_e, query: UsageLedgerQuery) => {
    if (!isValidUsageLedgerQuery(query)) {
      throw new Error("usage.ledger requires { sinceDay?: string (YYYY-MM-DD), sessionId?: string }");
    }
    return sessions.queryUsageLedger(query ?? {});
  });
  ipcMain.handle("usage.account", (_e, args: { drivers: DriverKind[]; force?: boolean }) => {
    if (!args || !Array.isArray(args.drivers) || !args.drivers.every((driver) => DRIVER_KINDS.includes(driver))) {
      throw new Error("usage.account requires { drivers: DriverKind[] }");
    }
    return accountUsage.get(args.drivers, args.force ?? false);
  });

  ipcMain.handle("prs.inbox", (_e, args: { force?: boolean }) => pullRequests.inbox(args?.force));
  ipcMain.handle("prs.detail", (_e, args: { ref: PrRef }) => pullRequests.detail(args.ref));
  ipcMain.handle("prs.diff", (_e, args: { ref: PrRef }) => pullRequests.diff(args.ref));
  ipcMain.handle("prs.checkLog", (_e, args: { ref: PrRef; runId: number }) => pullRequests.failedCheckLog(args.ref, args.runId));
  ipcMain.handle("prs.clone", (_e, args: { ref: PrRef }) => pullRequests.clone(args.ref));
  ipcMain.handle("prs.projectRepos", async (): Promise<ProjectGitHubRepo[]> => {
    const repos = await Promise.all(
      sessions.listProjects().map(async (project) => {
        const remote = await git.githubRemote(project.rootPath).catch(() => null);
        return remote ? { projectId: project.id, host: remote.host, owner: remote.owner, repo: remote.repository } : null;
      })
    );
    return repos.filter((repo): repo is ProjectGitHubRepo => repo !== null);
  });

  ipcMain.handle("fs.readFile", (_e, args: { sessionId: string; path: string }) =>
    sessions.ensureWorktree(args.sessionId).then((root) => files.readFile(root, args.path))
  );
  ipcMain.handle("fs.readOutsideFile", (_e, args: { path: string }) => files.readOutsideFile(args.path));
  ipcMain.handle("fs.saveFile", (_e, args: { sessionId: string; path: string; content: string }) =>
    sessions.ensureWorktree(args.sessionId).then((root) => files.saveFile(root, args.path, args.content))
  );
  ipcMain.handle("fs.listFiles", (_e, args: { sessionId: string }) =>
    sessions.ensureWorktree(args.sessionId).then((root) => files.listFiles(root))
  );
  ipcMain.handle("fs.listProjectFiles", (_e, args: { projectId: string }) =>
    files.listFiles(sessions.rootForProject(args.projectId))
  );
  ipcMain.handle("fs.listDir", (_e, args: { sessionId: string; dir?: string }) =>
    sessions.ensureWorktree(args.sessionId).then((root) => files.listDir(root, args.dir ?? ""))
  );
  ipcMain.handle(
    "fs.savePasteImage",
    (_e, args: { projectId: string; mime: string; data: Uint8Array }) =>
      files.savePasteImage(sessions.rootForProject(args.projectId), args.mime, args.data)
  );
  ipcMain.handle(
    "fs.readImage",
    async (_e, args: { sessionId?: string; projectId?: string; path: string }) => {
      if (typeof args.path === "string" && isAbsolute(args.path) && isInsideAttachmentsDir(args.path)) {
        const ext = args.path.split(".").pop() ?? "";
        const mime = imageExtMime(ext);
        if (!mime) throw new Error(`not an image: ${args.path}`);
        let status: ReturnType<typeof statSync>;
        try {
          status = statSync(args.path);
        } catch {
          throw new Error(`file not found: ${args.path}`);
        }
        if (!status.isFile()) throw new Error(`not a file: ${args.path}`);
        if (status.size > IMAGE_MAX_BYTES) throw new Error(`image too large to preview: ${args.path}`);
        try {
          return { mime, base64: readFileSync(args.path).toString("base64") };
        } catch {
          throw new Error(`file not found: ${args.path}`);
        }
      }
      const roots: string[] = [];
      if (args.sessionId) {
        try {
          roots.push(await sessions.ensureWorktree(args.sessionId));
        } catch (err) {
          const message = (err as Error).message;
          if (message.includes("unknown session")) {
            console.warn(`readImage: unknown session ${args.sessionId}`);
          } else {
            console.warn(`readImage: worktree recovery failed for ${args.sessionId}: ${message}`);
          }
        }
      }
      if (args.projectId) roots.push(sessions.rootForProject(args.projectId));
      let lastError: Error | null = null;
      for (const root of roots) {
        try {
          return files.readImage(root, args.path);
        } catch (err) {
          lastError = err as Error;
        }
      }
      throw lastError ?? new Error("no root available to read image");
    }
  );
  ipcMain.handle("git.turnDiff", async (_e, args: { sessionId: string; since: number }) => {
    const root = await sessions.ensureWorktree(args.sessionId);
    return git.turnDiff(root, args.since, sessions.turnBaseSha(args.sessionId));
  });

  ipcMain.handle("pty.open", (_e, args: { sessionId: string; kind: PtyKind }) =>
    sessions.ensureWorktree(args.sessionId).then((root) =>
      ptys.open(
        args.sessionId,
        root,
        args.kind,
        sessions.resumeCursorFor(args.sessionId),
        sessions.turnEnv(args.sessionId, root),
        (id, data) => {
          mainWindow?.webContents.send("pty.data", { ptyId: id, data });
        }
      )
    )
  );
  ipcMain.on("pty.write", (_e, args: { ptyId: string; data: string }) => ptys.write(args.ptyId, args.data));
  ipcMain.on("pty.resize", (_e, args: { ptyId: string; cols: number; rows: number }) =>
    ptys.resize(args.ptyId, args.cols, args.rows)
  );
  ipcMain.on("pty.detach", (_e, args: { ptyId: string; token: string }) => ptys.detach(args.ptyId, args.token));
  ipcMain.on("pty.kill", (_e, args: { ptyId: string }) => ptys.kill(args.ptyId));

  ipcMain.handle("term.font", () => readWindowsTerminalFontFace());

  ipcMain.handle("debug.openTrace", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const tracePath = getHarnessTracePath();
    if (!tracePath) return { ok: false, error: "harness trace is not initialized" };
    try {
      appendFileSync(tracePath, "", "utf8");
    } catch (err) {
      return { ok: false, path: tracePath, error: (err as Error).message };
    }
    const failure = await shell.openPath(tracePath);
    if (failure) return { ok: false, path: tracePath, error: failure };
    return { ok: true, path: tracePath };
  });

  ipcMain.handle("projects.pick", async (e): Promise<string | null> => {
    const w = windowFromSender(e.sender);
    const res = w
      ? await dialog.showOpenDialog(w, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("shell.openPath", (_e, args: { path: string }): Promise<void> =>
    shell.openExternal(pathToFileURL(args.path).href).then(() => undefined)
  );

  ipcMain.handle("shell.openExternal", (_e, args: { url: string }): Promise<void> => {
    const target = new URL(args.url);
    if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("unsupported external URL");
    return shell.openExternal(target.href).then(() => undefined);
  });

  ipcMain.handle("shell.openHtml", (_e, args: { name: string; html: string }): Promise<void> => {
    const safe = args.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "preview";
    const dir = attachmentsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `cw-preview-${safe}.html`);
    writeFileSync(file, args.html, "utf8");
    return shell.openExternal(pathToFileURL(file).href).then(() => undefined);
  });
}

function reportFatalStartupError(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  appendCrashLog(`fatal startup error: ${detail}`);
  console.error(`fatal startup error: ${detail}`);
  dialog.showErrorBox(
    "cw-code could not start",
    `${error instanceof Error ? error.message : String(error)}\n\nDetails were written to ${join(logsDir(), "crash.log")}. Nothing in your data folder was deleted.`
  );
  app.exit(1);
}

async function startApp(): Promise<void> {
  ensureAppDirs();
  migrateFromUserData(app.getPath("userData"));
  try {
    const tracePath = initHarnessTrace({ logDir: logsDir() });
    console.warn(`harness trace: ${tracePath}`);
  } catch (err) {
    console.warn(`harness trace init failed: ${(err as Error).message}`);
  }
  initCrashLog(logsDir());
  process.on("uncaughtException", (err) => {
    appendCrashLog(`uncaughtException: ${err.stack ?? err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    appendCrashLog(`unhandledRejection: ${String(reason)}`);
  });
  const stores = openMetadataStores({ dbPath: sessionDbPath(), settingsPath: settingsFilePath() });
  if (stores.ok) {
    initOpencodeModelsCache(opencodeModelsCachePath());
    initClaudeCommandsCache(claudeCommandsCachePath());
    services = createServices(stores);
    services.sessions.warmOpencodeModels();
    reapOrphanedServers()
      .then((reaped) => {
        if (reaped.length > 0) console.warn(`reaped ${reaped.length} orphaned CLI server(s) from a previous run`);
      })
      .catch((err) => {
        console.warn(`orphan server sweep failed: ${(err as Error).message}`);
      });
    registerIpc(services);
  } else {
    startupState = { mode: "recovery", issues: stores.issues, dataDir: userdataDir() };
    for (const issue of stores.issues) {
      appendCrashLog(`metadata recovery required: ${issue.store} ${issue.file} (${issue.kind}): ${issue.message}`);
    }
  }
  registerWindowIpc();
  registerStartupIpc();
  const quitOnSignal = (): void => {
    app.quit();
  };
  process.once("SIGINT", quitOnSignal);
  process.once("SIGTERM", quitOnSignal);
  app.on("child-process-gone", (_e, details) => {
    appendCrashLog(
      `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    );
  });
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

app.whenReady().then(startApp).catch(reportFatalStartupError);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  services?.sessions.dispose();
  services?.ptys.dispose();
});
