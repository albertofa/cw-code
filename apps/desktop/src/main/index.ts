import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { getHarnessTracePath, initHarnessTrace } from "./debug/harnessTrace.js";
import { appendCrashLog, initCrashLog } from "./debug/crashLog.js";
import type { ApprovalDecision, CreateSessionOptions, GitDiffMode, SessionStatus, SettingsPatch } from "@cw-code/contracts";
import type { DriverKind } from "@cw-code/contracts";
import type { PtyKind } from "./pty/PtyPool.js";
import { SessionManager } from "./sessions/SessionManager.js";
import { FileService } from "./fs/FileService.js";
import { GitService } from "./fs/GitService.js";
import { PtyPool } from "./pty/PtyPool.js";
import { readWindowsTerminalFontFace } from "./pty/terminalFont.js";
import { configuredCliBinaryPath } from "./settings/settingsUtils.js";

type DriverName = DriverKind;

let mainWindow: BrowserWindow | null = null;
const sessions = new SessionManager();
const files = new FileService();
const git = new GitService(() => sessions.getSettings());
const ptys = new PtyPool(() => sessions.getSettings());

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    frame: false,
    backgroundColor: "#141212",
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
    void webContents.reload();
  });
  webContents.on("console-message", (event) => {
    if (event.level === "error") {
      appendCrashLog(`renderer error: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
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

function registerIpc(): void {
  sessions.setEmitter((sessionId, event) => {
    mainWindow?.webContents.send("turn.event", { sessionId, event });
  });
  ipcMain.handle("cli.checkVersions", () => {
    const s = sessions.getSettings();
    return checkCliVersions({
      claudeBinary: s.claudeBinaryPath,
      opencodeBinary: s.opencodeBinaryPath,
      codexBinary: s.codexBinaryPath
    });
  });
  ipcMain.handle("settings.get", () => sessions.getSettings());
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
    const failed = (await Promise.all(checks)).find((check) => check.error !== null);
    if (failed) {
      const name = failed.binary === "claude" ? "Claude" : failed.binary === "codex" ? "Codex" : "OpenCode";
      const reason = failed.available
        ? "The executable did not complete '--version' successfully."
        : "Choose a valid executable name or full path.";
      throw new Error(`${name} CLI could not be verified at '${failed.binaryPath}'. ${reason}`);
    }
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
  ipcMain.handle("sessions.setStatus", (_e, args: { sessionId: string; status: SessionStatus }) =>
    sessions.setSessionStatus(args.sessionId, args.status)
  );
  ipcMain.handle("sessions.history", (_e, args: { sessionId: string }) =>
    sessions.getHistory(args.sessionId)
  );
  ipcMain.handle(
    "turns.start",
    (
      _e,
      args: {
        sessionId: string;
        prompt: string;
        prefs?: { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; variant?: string; permissionMode?: "auto" | "acceptEdits" | "bypassPermissions" | "manual" | "plan" };
        attachments?: string[];
      }
    ) => sessions.startTurn(args.sessionId, args.prompt, { prefs: args.prefs, attachments: args.attachments })
  );
  ipcMain.handle("turns.interrupt", (_e, args: { turnId: string }) => sessions.interrupt(args.turnId));
  ipcMain.handle("models.list", (_e, args: { sessionId: string }) => sessions.listModels(args.sessionId));
  ipcMain.handle(
    "models.listFor",
    (_e, args: { projectId: string; driver: DriverName }) =>
      sessions.listModelsFor(args.projectId, args.driver)
  );
  ipcMain.handle("composer.get", (_e, args: { sessionId: string }) => sessions.getComposer(args.sessionId));
  ipcMain.handle(
    "composer.set",
    (_e, args: { sessionId: string; prefs: { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; variant?: string; permissionMode?: "auto" | "acceptEdits" | "bypassPermissions" | "manual" | "plan" } }) =>
      sessions.setComposer(args.sessionId, args.prefs)
  );
  ipcMain.handle("git.status", (_e, args: { sessionId: string }) =>
    git.status(sessions.rootFor(args.sessionId), sessions.projectForSession(args.sessionId))
  );
  ipcMain.handle("git.branches", (_e, args: { sessionId: string }) =>
    git.branches(sessions.rootFor(args.sessionId))
  );
  ipcMain.handle("git.projectBranches", (_e, args: { projectId: string }) =>
    git.branches(sessions.rootForProject(args.projectId))
  );
  ipcMain.handle("git.switchBranch", async (_e, args: { sessionId: string; branch: string }) => {
    const status = await git.switchBranch(sessions.rootFor(args.sessionId), args.branch, sessions.projectForSession(args.sessionId));
    sessions.updateSessionBranch(args.sessionId, status.branch);
    return status;
  });
  ipcMain.handle("git.diff", (_e, args: { sessionId: string; mode: GitDiffMode; baseRef?: string }) =>
    git.diff(sessions.rootFor(args.sessionId), args.mode, args.baseRef)
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

  ipcMain.handle("fs.readFile", (_e, args: { sessionId: string; path: string }) =>
    files.readFile(sessions.rootFor(args.sessionId), args.path)
  );
  ipcMain.handle("fs.readOutsideFile", (_e, args: { path: string }) => files.readOutsideFile(args.path));
  ipcMain.handle("fs.saveFile", (_e, args: { sessionId: string; path: string; content: string }) =>
    files.saveFile(sessions.rootFor(args.sessionId), args.path, args.content)
  );
  ipcMain.handle("fs.listFiles", (_e, args: { sessionId: string }) =>
    files.listFiles(sessions.rootFor(args.sessionId))
  );
  ipcMain.handle("fs.listProjectFiles", (_e, args: { projectId: string }) =>
    files.listFiles(sessions.rootForProject(args.projectId))
  );
  ipcMain.handle("fs.listDir", (_e, args: { sessionId: string; dir?: string }) =>
    files.listDir(sessions.rootFor(args.sessionId), args.dir ?? "")
  );
  ipcMain.handle(
    "fs.savePasteImage",
    (_e, args: { projectId: string; mime: string; data: Uint8Array }) =>
      files.savePasteImage(sessions.rootForProject(args.projectId), args.mime, args.data)
  );
  ipcMain.handle(
    "fs.readImage",
    (_e, args: { sessionId?: string; projectId?: string; path: string }) => {
      const roots: string[] = [];
      if (args.sessionId) {
        try {
          roots.push(sessions.rootFor(args.sessionId));
        } catch {
          console.warn(`readImage: unknown session ${args.sessionId}`);
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
  ipcMain.handle("git.turnDiff", (_e, args: { sessionId: string; since: number }) =>
    git.turnDiff(sessions.rootFor(args.sessionId), args.since)
  );

  ipcMain.handle("pty.open", (_e, args: { sessionId: string; kind: PtyKind }) =>
    ptys.open(args.sessionId, sessions.rootFor(args.sessionId), args.kind, (id, data) => {
      mainWindow?.webContents.send("pty.data", { ptyId: id, data });
    })
  );
  ipcMain.on("pty.write", (_e, args: { ptyId: string; data: string }) => ptys.write(args.ptyId, args.data));
  ipcMain.on("pty.resize", (_e, args: { ptyId: string; cols: number; rows: number }) =>
    ptys.resize(args.ptyId, args.cols, args.rows)
  );
  ipcMain.on("pty.kill", (_e, args: { ptyId: string }) => ptys.kill(args.ptyId));

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
    const file = join(tmpdir(), `cw-preview-${safe}.html`);
    writeFileSync(file, args.html, "utf8");
    return shell.openExternal(pathToFileURL(file).href).then(() => undefined);
  });
}

app.whenReady().then(async () => {
  try {
    const tracePath = initHarnessTrace({ userDataDir: app.getPath("userData") });
    console.warn(`harness trace: ${tracePath}`);
  } catch (err) {
    console.warn(`harness trace init failed: ${(err as Error).message}`);
  }
  initCrashLog(app.getPath("userData"));
  process.on("uncaughtException", (err) => {
    appendCrashLog(`uncaughtException: ${err.stack ?? err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    appendCrashLog(`unhandledRejection: ${String(reason)}`);
  });
  registerIpc();
  app.on("child-process-gone", (_e, details) => {
    appendCrashLog(
      `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    );
  });
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sessions.dispose();
  ptys.dispose();
});
