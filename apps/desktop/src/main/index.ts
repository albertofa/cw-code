import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, safeStorage, shell, type MessageBoxOptions, type WebContents } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AppNotice,
  AppSettings,
  ConnectionList,
  ConnectionProfile,
  ConnectionTestResult,
  DesktopConnection,
  ServerEndpoint,
  ServerReady,
  ServerPackageProbe,
  ShutdownAssessment,
  ShutdownCommitResult,
  ShutdownPrepareRequest,
  ShutdownPrepareResult,
  ShutdownRequestedEvent,
  ShutdownScope,
  ShutdownStatus,
  UpdateActionResult,
  UpdateState
} from "@cw-code/contracts";
import { appendCrashLog, initCrashLog } from "@cw-code/server/debug/crashLog";
import { attachmentsDir, cwCodeHome, logsDir } from "@cw-code/server/paths/appPaths";
import { readBytesIfExists, writeFileAtomic } from "@cw-code/server/storage/atomicFile";
import { PROTOCOL_VERSION } from "@cw-code/shared/protocol";
import { windowBackgroundColor } from "@cw-code/shared/themes";
import { channelOfVersion } from "@cw-code/shared/updateChannel";
import { attentionDescription, shouldFlash } from "./attention.js";
import { badgeLabel, renderBadge } from "./badgeImage.js";
import {
  ConnectionStore,
  LOCAL_PROFILE,
  parseConnectionTestInput,
  parseRemoteProfileInput,
  testConnection,
  type ConnectionsFs,
  type TokenCipher
} from "./connections.js";
import { failedServerProbe, RendererProbeTracker, runPackageProbe } from "./debug/packageProbe.js";
import { readOrCreateInstallId } from "./installId.js";
import { assertLocalAbsolutePath, resolveOpenTarget } from "./openPathPolicy.js";
import { claimParent } from "./serverAttach.js";
import { ServerLink, type ServerLinkChange } from "./serverLink.js";
import { ServerProcess, ServerStartDeclinedError } from "./serverProcess.js";
import { ServerTray } from "./tray.js";
import { ElectronUpdaterAdapter } from "./updates/ElectronUpdaterAdapter.js";
import { UpdateService } from "./updates/UpdateService.js";
import { createUpdateLogFile } from "./updates/updateLog.js";
import { firstRunChannelPatch, updatePreferences, type UpdatePreferences } from "./updates/updatePreferences.js";
import { initialUpdateState, isUpdateChannel } from "./updates/updateState.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RENDERER_SHUTDOWN_ACK_MS = 5_000;
const INSTALL_EXIT_TIMEOUT_MS = 30_000;
const UPDATES_PENDING_MESSAGE = "Updates are unavailable until the cw-code server is ready";

if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", "cw-code");
}

if (process.platform === "win32") {
  const disabledFeatures = app.commandLine.getSwitchValue("disable-features");
  app.commandLine.appendSwitch(
    "disable-features",
    disabledFeatures ? `${disabledFeatures},CalculateNativeWinOcclusion` : "CalculateNativeWinOcclusion"
  );
}

if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", join(app.getPath("appData"), "@cw-code", "desktop-dev"));
}

if (!app.isPackaged && !process.env["CW_CODE_HOME"]?.trim()) {
  process.env["CW_CODE_HOME"] = join(homedir(), ".cw-code-dev");
}

let mainWindow: BrowserWindow | null = null;
let attentionCount: number | null = null;
let quitApproved = false;
let shutdownAckTimer: NodeJS.Timeout | null = null;
let updates: UpdateService | null = null;
let appliedPreferences: UpdatePreferences | null = null;
let serverFailure: string | null = null;
let restartAfterFailedInstall = false;
let serverStop: Promise<void> | null = null;
let serverStopped = false;
let tray: ServerTray | null = null;
let pendingActivation: string | null = null;

const electronCipher: TokenCipher = {
  storage: () => {
    if (!safeStorage.isEncryptionAvailable()) return "plain";
    return process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text" ? "basic" : "os";
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data))
};

const connectionsFs: ConnectionsFs = {
  read: (path) => readBytesIfExists(path)?.toString("utf8") ?? null,
  write: (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, data);
  }
};

const connections = new ConnectionStore({ userDataDir: app.getPath("userData"), cipher: electronCipher, fs: connectionsFs });
const runningProfile: ConnectionProfile = packageProbeOutPath() ? LOCAL_PROFILE : (connections.profile(connections.activeId) ?? LOCAL_PROFILE);
const remoteMode = runningProfile.kind === "remote";

const serverProcess: ServerProcess = new ServerProcess({
  launch: {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    legacyUserData: app.getPath("userData")
  },
  identity: { installId: readOrCreateInstallId(app.getPath("userData")), version: app.getVersion(), protocol: PROTOCOL_VERSION },
  confirmReplace: confirmServerReplace,
  onAttached: (endpoint) => claimParent(endpoint, process.pid),
  onDeclined: () => exitApp(0),
  isQuitting: (): boolean => quitApproved || (link.shutdown.committed && !restartAfterFailedInstall),
  onFatal: (message) => reportFatalError("cw-code server stopped", new Error(message))
});

const link: ServerLink = new ServerLink(serverEndpoint);

async function serverEndpoint(): Promise<ServerEndpoint> {
  return remoteMode ? connections.endpoint(runningProfile.id) : serverProcess.endpoint();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolvePreload(): string {
  const candidates = ["index.js", "index.mjs", "index.cjs"].map((f) => join(__dirname, "..", "preload", f));
  const found = candidates.find((p) => existsSync(p));
  if (!found) console.warn(`preload not found (tried ${candidates.join(", ")})`);
  return found ?? candidates[0];
}

function liveMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function sendToMainWindow(channel: string, payload?: unknown): void {
  liveMainWindow()?.webContents.send(channel, payload);
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function createUpdateService(settings: AppSettings): UpdateService {
  const logger = createUpdateLogFile({
    filePath: join(logsDir(), "updater.log"),
    console: { info: (message) => console.warn(message), warn: (message) => console.warn(message) }
  });
  const preferences = updatePreferences(settings, app.getVersion());
  return new UpdateService({
    runningVersion: app.getVersion(),
    channel: preferences.channel,
    autoDownload: preferences.autoDownload,
    environment: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
      platform: process.platform,
      appImagePath: process.env.APPIMAGE ?? null,
      appDir: process.env.APPDIR ?? null
    },
    files: { fileExists: existsSync, listDirectory: (path) => readdirSync(path), readText: readTextOrNull },
    createAdapter: (kind) => new ElectronUpdaterAdapter({ kind, homeDir: homedir(), sink: logger }),
    logger,
    homeDir: homedir(),
    canRunScheduledCheck: () => link.shutdown.idle
  });
}

function ensureUpdateService(): void {
  const settings = link.settings;
  if (updates || link.startup?.mode !== "ready" || !settings) return;
  const service = createUpdateService(settings);
  updates = service;
  appliedPreferences = updatePreferences(settings, app.getVersion());
  service.subscribe((state) => sendToMainWindow("updates.changed", state));
  sendToMainWindow("updates.changed", service.getState());
  service.start();
  const firstRunChannel = firstRunChannelPatch(settings, app.getVersion(), service.getState().phase !== "disabled");
  if (firstRunChannel && !remoteMode) {
    link.call("settings.set", firstRunChannel).catch((error: unknown) => {
      console.warn(`could not save the default update channel: ${errorMessage(error)}`);
    });
  }
}

function applyUpdatePreferences(): void {
  const settings = link.settings;
  if (!updates || !settings) return;
  const next = updatePreferences(settings, app.getVersion());
  if (appliedPreferences?.channel === next.channel && appliedPreferences.autoDownload === next.autoDownload) return;
  appliedPreferences = next;
  updates.setAutoDownload(next.autoDownload);
  void updates.setChannel(next.channel).then((result) => {
    if (!result.ok && result.code !== "disabled") console.warn(`[updates] could not apply the saved channel: ${result.message}`);
  });
}

async function confirmServerReplace(running: ServerReady): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "cw-code",
    message: `A cw-code server from version ${running.version} is still running in the background. Restart it with version ${app.getVersion()}?`,
    detail: "Running turns will stop.",
    buttons: ["Restart", "Quit"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  return response === 0;
}

function syncTray(): void {
  const wanted = !remoteMode && link.settings?.keepServerRunning === true && !isQuitApproved();
  if (wanted && !tray) {
    tray = new ServerTray({ iconPath: brandingIconPath(), open: focusMainWindow, stopAndQuit: stopServerAndQuit }, link.attentionCount);
    return;
  }
  if (wanted || !tray) return;
  destroyTray();
  if (liveMainWindow()?.isVisible() === false) focusMainWindow();
}

function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

function exitApp(code: number): void {
  destroyTray();
  app.exit(code);
}

function stopServerAndQuit(): void {
  if (remoteMode) return;
  focusMainWindow();
  requestShutdown("server");
}

function handleLinkChange(change: ServerLinkChange): void {
  if (change === "shutdown" && !link.shutdown.committed) restartAfterFailedInstall = false;
  if (change === "settings") {
    syncWindowBackground();
    syncTray();
  }
  if (change === "attention") {
    if (link.attentionCount === null) clearAttention();
    else applyAttention(link.attentionCount);
    tray?.setAttention(link.attentionCount);
  }
  if (change === "settings" || change === "startup") {
    ensureUpdateService();
    applyUpdatePreferences();
  }
}

function showNotice(notice: AppNotice): void {
  const options: MessageBoxOptions = {
    type: notice.level,
    title: notice.title,
    message: notice.message,
    ...(notice.detail ? { detail: notice.detail } : {})
  };
  const window = liveMainWindow();
  void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
}

function isQuitApproved(): boolean {
  return quitApproved || link.shutdown.committed;
}

function clearShutdownAck(): void {
  if (!shutdownAckTimer) return;
  clearTimeout(shutdownAckTimer);
  shutdownAckTimer = null;
}

function stopServer(): Promise<void> {
  if (serverStop) return serverStop;
  const stopping = (remoteMode ? Promise.resolve() : serverProcess.stop(link.isOpen ? link : undefined))
    .catch((error: unknown) => console.warn(`[server] stop failed: ${errorMessage(error)}`))
    .finally(() => {
      serverStopped = true;
      link.close();
      updates?.dispose();
    });
  serverStop = stopping;
  return stopping;
}

function quitWithoutDialog(): void {
  clearShutdownAck();
  quitApproved = true;
  void stopServer().then(() => app.quit());
}

function closeScope(): ShutdownScope {
  return remoteMode ? "window" : "server";
}

function requestShutdown(scope: ShutdownScope = closeScope(), activation: string | null = null): void {
  if (!isQuitApproved()) pendingActivation = activation;
  const window = liveMainWindow();
  if (!link.isOpen || link.startup?.mode !== "ready" || !window || window.webContents.isCrashed()) {
    quitWithoutDialog();
    return;
  }
  if (isQuitApproved()) return;
  const event: ShutdownRequestedEvent = { reason: "quit", scope };
  window.webContents.send("shutdown.requested", event);
  clearShutdownAck();
  shutdownAckTimer = setTimeout(() => {
    shutdownAckTimer = null;
    appendCrashLog(`renderer did not answer shutdown.requested within ${RENDERER_SHUTDOWN_ACK_MS}ms; quitting without the shutdown dialog`);
    quitWithoutDialog();
  }, RENDERER_SHUTDOWN_ACK_MS);
}

function endOfSession(): void {
  pendingActivation = null;
  clearShutdownAck();
  quitApproved = true;
  void stopServer();
}

function focusMainWindow(): void {
  const window = liveMainWindow();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function windowIconFile(): string {
  return process.platform === "linux" ? "icon.png" : "icon.ico";
}

function brandingIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "branding", windowIconFile()) : join(app.getAppPath(), "resources", windowIconFile());
}

function currentWindowBackground(): string {
  const settings = link.settings;
  return windowBackgroundColor(settings?.themeId ?? "dark", settings?.customThemes ?? [], !nativeTheme.shouldUseDarkColors);
}

function syncWindowBackground(): void {
  liveMainWindow()?.setBackgroundColor(currentWindowBackground());
}

function createBrowserWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1440,
    height: 900,
    frame: false,
    title: "cw-code",
    icon: brandingIconPath(),
    backgroundColor: currentWindowBackground(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      sandbox: false,
      ...(process.env["ELECTRON_RENDERER_URL"] ? { partition: "dev" } : {})
    }
  });
}

function wireWindow(window: BrowserWindow): void {
  window.on("focus", () => window.flashFrame(false));
  window.on("maximize", () => window.webContents.send("win.maximized", true));
  window.on("unmaximize", () => window.webContents.send("win.maximized", false));
  window.on("unresponsive", () => appendCrashLog("window unresponsive"));

  const webContents = window.webContents;
  webContents.on("render-process-gone", (_e, details) => {
    appendCrashLog(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
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
}

function devWindowCount(): number {
  if (app.isPackaged) return 0;
  const count = Number(process.env["CW_DEV_WINDOWS"]);
  return Number.isInteger(count) && count >= 2 && count <= 4 ? count : 0;
}

async function openDevWindows(): Promise<void> {
  const extraCount = devWindowCount() - 1;
  for (let index = 0; index < extraCount; index += 1) {
    const window = createBrowserWindow();
    wireWindow(window);
    await loadRenderer(window);
  }
}

async function createWindow(): Promise<void> {
  const window = createBrowserWindow();
  mainWindow = window;
  wireWindow(window);
  window.on("close", (event) => {
    if (process.platform === "darwin" || isQuitApproved()) return;
    event.preventDefault();
    if (tray) window.hide();
    else requestShutdown();
  });
  window.on("session-end", endOfSession);
  if (link.attentionCount !== null) applyAttention(link.attentionCount);

  const probeOutPath = packageProbeOutPath();
  if (probeOutPath) {
    await startPackageProbe(window, probeOutPath);
    return;
  }

  await loadRenderer(window);
  await openDevWindows();
}

function packageProbeOutPath(): string | undefined {
  return app.isPackaged ? process.env["CW_PACKAGE_PROBE_OUT"] : undefined;
}

async function probeServer(): Promise<ServerPackageProbe> {
  if (serverFailure !== null) return failedServerProbe(`server did not start: ${serverFailure}`);
  try {
    return await link.call<ServerPackageProbe>("debug.packageProbe");
  } catch (error) {
    return failedServerProbe(`server package probe failed: ${errorMessage(error)}`);
  }
}

async function startPackageProbe(window: BrowserWindow, outPath: string): Promise<void> {
  const renderer = new RendererProbeTracker();
  window.webContents.on("render-process-gone", (_e, details) => {
    renderer.markFailed(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  window.webContents.on("did-fail-load", (_e, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame) renderer.markFailed(`did-fail-load: ${errorCode} ${errorDescription}`);
  });
  try {
    await loadRenderer(window);
    renderer.markLoaded();
  } catch (err) {
    const message = `renderer failed to load: ${(err as Error).message}`;
    renderer.markFailed(message);
    appendCrashLog(message);
  }
  setTimeout(() => {
    runPackageProbe({
      outPath,
      appVersion: app.getVersion(),
      startupMode: link.startup?.mode ?? "ready",
      electronVersion: process.versions.electron,
      noSandboxSwitch: app.commandLine.hasSwitch("no-sandbox"),
      renderer,
      probeServer
    }).then(
      (result) => exitApp(result.rendererLoaded ? 0 : 1),
      (err: unknown) => {
        appendCrashLog(`package probe failed: ${errorMessage(err)}`);
        exitApp(1);
      }
    );
  }, 3000);
}

function loadRenderer(window: BrowserWindow): Promise<void> {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  return devUrl ? window.loadURL(devUrl) : window.loadFile(rendererIndexPath());
}

function rendererIndexPath(): string {
  return app.isPackaged ? join(process.resourcesPath, "server", "ui", "index.html") : resolve(app.getAppPath(), "..", "ui", "dist", "index.html");
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
const ZOOM_STEP = 0.5;

function bumpZoom(sender: WebContents, delta: number): void {
  const w = windowFromSender(sender);
  if (!w) return;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, w.webContents.getZoomLevel() + delta));
  w.webContents.setZoomLevel(next);
}

const BADGE_SIZE = 32;

function showAttentionIndicators(win: BrowserWindow, count: number): void {
  if (process.platform === "win32") {
    const overlay =
      count > 0 ? nativeImage.createFromBitmap(renderBadge(badgeLabel(count), BADGE_SIZE), { width: BADGE_SIZE, height: BADGE_SIZE }) : null;
    win.setOverlayIcon(overlay, attentionDescription(count));
  } else {
    app.setBadgeCount(count);
  }
}

function clearAttention(): void {
  const win = liveMainWindow();
  attentionCount = null;
  if (!win) {
    if (process.platform !== "win32") app.setBadgeCount(0);
    return;
  }
  showAttentionIndicators(win, 0);
  win.flashFrame(false);
}

function applyAttention(count: number): void {
  const win = liveMainWindow();
  if (!win) {
    if (process.platform !== "win32") app.setBadgeCount(count);
    attentionCount = count;
    return;
  }
  const flash = shouldFlash(attentionCount, count, win.isFocused());
  attentionCount = count;
  showAttentionIndicators(win, count);
  if (count === 0) win.flashFrame(false);
  else if (flash) win.flashFrame(true);
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

  ipcMain.on("win.zoom-in", (e) => bumpZoom(e.sender, ZOOM_STEP));
  ipcMain.on("win.zoom-out", (e) => bumpZoom(e.sender, -ZOOM_STEP));
  ipcMain.on("win.zoom-reset", (e) => windowFromSender(e.sender)?.webContents.setZoomLevel(0));
}

function registerShellIpc(): void {
  ipcMain.handle("desktop.connection", async (): Promise<DesktopConnection> => {
    const profile = connections.profile(runningProfile.id) ?? runningProfile;
    const endpoint = await serverEndpoint();
    connectRemoteLink();
    return { profile, endpoint };
  });
  ipcMain.handle("desktop.connections.list", (): ConnectionList => connections.list());
  ipcMain.handle("desktop.connections.save", (_e, args: unknown): ConnectionProfile => connections.save(parseRemoteProfileInput(args)));
  ipcMain.handle("desktop.connections.remove", (_e, args: { id?: unknown } | undefined): void => {
    if (typeof args?.id !== "string") throw new Error("desktop.connections.remove requires { id }");
    connections.remove(args.id);
  });
  ipcMain.handle("desktop.connections.test", (_e, args: unknown): Promise<ConnectionTestResult> => testConnectionInput(args));
  ipcMain.on("desktop.connections.activate", (_e, args: { id?: unknown } | undefined) => activateConnection(args));

  ipcMain.handle("projects.pick", async (e): Promise<string | null> => {
    const w = windowFromSender(e.sender);
    const res = w
      ? await dialog.showOpenDialog(w, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("shell.openPath", async (_e, args: { path: string }): Promise<void> => {
    const target = resolveOpenTarget(args.path, logsDir());
    if (target.kind === "external") {
      await shell.openExternal(pathToFileURL(target.path).href);
      return;
    }
    const failure = await shell.openPath(target.path);
    if (failure) throw new Error(failure);
  });

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

  ipcMain.handle("shell.showItemInFolder", (_e, args: { path?: unknown } | undefined): void => {
    shell.showItemInFolder(assertLocalAbsolutePath(args?.path));
  });
}

function applyPendingActivation(): void {
  const id = pendingActivation;
  pendingActivation = null;
  if (!id) return;
  try {
    connections.setActive(id);
    app.relaunch();
  } catch (error) {
    console.warn(`[connections] could not switch connections: ${errorMessage(error)}`);
  }
}

function activateConnection(args: { id?: unknown } | undefined): void {
  const id = typeof args?.id === "string" ? args.id : "";
  if (!connections.profile(id)) {
    console.warn("[connections] cannot switch to a connection that does not exist");
    return;
  }
  if (id === runningProfile.id) return;
  requestShutdown(runningProfile.kind === "local" ? "server" : "window", id);
}

function connectRemoteLink(): void {
  if (!remoteMode || link.isOpen || isQuitApproved()) return;
  link.connect().catch((error: unknown) => console.warn(`[server] could not connect to ${runningProfile.name}: ${errorMessage(error)}`));
}

function storedTestToken(input: { token?: string; id?: string }): string | null {
  if (input.token) return input.token;
  return input.id && connections.profile(input.id)?.kind === "remote" ? connections.token(input.id) : null;
}

async function testConnectionInput(args: unknown): Promise<ConnectionTestResult> {
  const input = parseConnectionTestInput(args);
  let token: string | null;
  try {
    token = storedTestToken(input);
  } catch (error) {
    return { ok: false, code: "unauthorized", message: errorMessage(error) };
  }
  return testConnection(input.url, token);
}

function parseShutdownToken(args: unknown, channel: string): string {
  const token = args && typeof args === "object" ? (args as Record<string, unknown>).token : undefined;
  if (typeof token !== "string" || token.length === 0) throw new Error(`${channel} requires { token }`);
  return token;
}

function pendingUpdateState(): UpdateState {
  return initialUpdateState({
    runningVersion: app.getVersion(),
    channel: channelOfVersion(app.getVersion()),
    autoDownload: false,
    disabledReason: UPDATES_PENDING_MESSAGE
  });
}

function pendingUpdateResult(): Promise<UpdateActionResult> {
  return Promise.resolve({ ok: false, code: "disabled", message: UPDATES_PENDING_MESSAGE, state: pendingUpdateState() });
}

async function commitInstall(token: string, action: () => void): Promise<ShutdownCommitResult> {
  const result = await link.call<ShutdownCommitResult>("shutdown.quit", { token });
  if (!result.ok) return result;
  clearShutdownAck();
  quitApproved = true;
  try {
    action();
  } catch (error) {
    quitApproved = false;
    restartAfterFailedInstall = true;
    throw error;
  }
  await delay(INSTALL_EXIT_TIMEOUT_MS);
  appendCrashLog(`cw-code did not exit within ${INSTALL_EXIT_TIMEOUT_MS}ms after starting the installer; restarting the server`);
  await restoreAfterFailedInstall();
  return { ok: false, message: `cw-code did not exit within ${Math.round(INSTALL_EXIT_TIMEOUT_MS / 1000)}s. Normal use has been restored.` };
}

async function commitWindowInstall(action: () => void): Promise<ShutdownCommitResult> {
  clearShutdownAck();
  quitApproved = true;
  try {
    action();
  } catch (error) {
    quitApproved = false;
    throw error;
  }
  await delay(INSTALL_EXIT_TIMEOUT_MS);
  appendCrashLog(`cw-code did not exit within ${INSTALL_EXIT_TIMEOUT_MS}ms after starting the installer`);
  quitApproved = false;
  return { ok: false, message: `cw-code did not exit within ${Math.round(INSTALL_EXIT_TIMEOUT_MS / 1000)}s. Normal use has been restored.` };
}

async function startAndConnectServer(): Promise<void> {
  if (remoteMode) {
    connectRemoteLink();
    return;
  }
  await serverProcess.start();
  await link.connect();
}

async function restoreAfterFailedInstall(): Promise<void> {
  quitApproved = false;
  restartAfterFailedInstall = true;
  serverStop = null;
  serverStopped = false;
  try {
    await startAndConnectServer();
  } catch (error) {
    reportFatalError("cw-code server stopped", error);
  }
}

async function installUpdate(service: UpdateService, args: unknown): Promise<UpdateActionResult> {
  pendingActivation = null;
  if (remoteMode) return service.install(args, { commit: commitWindowInstall, reason: () => "update", release: () => undefined });
  const token = parseShutdownToken(args, "updates.install");
  const status = await link.call<ShutdownStatus>("shutdown.status").catch(() => link.shutdown);
  return service.install(args, {
    commit: (action) => commitInstall(token, action),
    reason: () => status.reason,
    release: () => {
      link.call("shutdown.cancel", { token }).catch((error: unknown) => {
        console.warn(`[updates] could not release the restart request: ${errorMessage(error)}`);
      });
    }
  });
}

function registerUpdateIpc(): void {
  ipcMain.handle("updates.state", (): UpdateState => updates?.getState() ?? pendingUpdateState());
  ipcMain.handle("updates.check", (): Promise<UpdateActionResult> => updates?.check() ?? pendingUpdateResult());
  ipcMain.handle("updates.download", (): Promise<UpdateActionResult> => updates?.download() ?? pendingUpdateResult());
  ipcMain.handle("updates.install", (_e, args: unknown): Promise<UpdateActionResult> =>
    updates ? installUpdate(updates, args) : pendingUpdateResult()
  );
  ipcMain.handle("updates.setChannel", async (_e, args: unknown): Promise<UpdateActionResult> => {
    if (!updates) return pendingUpdateResult();
    const channel = args && typeof args === "object" ? (args as { channel?: unknown }).channel : undefined;
    const result = await updates.setChannel(channel);
    if (result.ok && isUpdateChannel(channel)) await link.call("settings.set", { updateChannel: channel });
    return result;
  });
}

function registerShutdownIpc(): void {
  ipcMain.on("shutdown.ack", () => clearShutdownAck());
  ipcMain.on("app.stop-server-and-quit", () => stopServerAndQuit());
  ipcMain.on("app.quit", () => {
    clearShutdownAck();
    quitApproved = true;
    app.quit();
  });
}

function reportFatalError(title: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  appendCrashLog(`fatal error: ${detail}`);
  console.error(`fatal error: ${detail}`);
  dialog.showErrorBox(
    title,
    `${errorMessage(error)}\n\nDetails were written to ${join(logsDir(), "crash.log")}. Nothing in your data folder was deleted.`
  );
  exitApp(1);
}

function reportFatalStartupError(error: unknown): void {
  if (error instanceof ServerStartDeclinedError) {
    exitApp(0);
    return;
  }
  reportFatalError("cw-code could not start", error);
}

interface PendingUpdateAutotest {
  autotest: typeof import("./updates/updateAutotest.js");
  config: import("./updates/updateAutotest.js").UpdateAutotestConfig;
}

async function prepareUpdateAutotest(): Promise<PendingUpdateAutotest | null> {
  if (__CW_UPDATE_TEST_BUILD__) {
    const autotest = await import("./updates/updateAutotest.js");
    const resolution = autotest.loadUpdateAutotest({ env: process.env, userDataDir: app.getPath("userData"), homeDir: homedir() });
    if (resolution.problem) console.warn(`[updates] update autotest not started: ${resolution.problem}`);
    return resolution.config ? { autotest, config: resolution.config } : null;
  }
  return null;
}

function startUpdateAutotest(pending: PendingUpdateAutotest | null): void {
  if (__CW_UPDATE_TEST_BUILD__ && pending) {
    const service = updates;
    const startupMode = link.startup?.mode ?? "recovery";
    void pending.autotest.runUpdateAutotest(pending.config, {
      version: app.getVersion(),
      pid: process.pid,
      launchedByInstaller: process.argv.includes("--updated"),
      startupMode,
      userDataDir: app.getPath("userData"),
      cwCodeHome: cwCodeHome(),
      updates: service,
      shutdown:
        startupMode === "ready"
          ? {
              assess: () => link.call<ShutdownAssessment>("shutdown.assess"),
              prepare: (request: ShutdownPrepareRequest) => link.call<ShutdownPrepareResult>("shutdown.prepare", request),
              force: (token) => link.call<ShutdownPrepareResult>("shutdown.force", { token }),
              cancel: async (token) => {
                await link.call("shutdown.cancel", { token });
              },
              isIdle: async () => link.shutdown.idle
            }
          : null,
      install: (request) => (service ? installUpdate(service, request) : Promise.reject(new Error("cw-code services are not running"))),
      startTurn: (sessionId, prompt) => link.call<string>("turns.start", { sessionId, prompt }),
      quit: quitWithoutDialog
    });
  }
}

async function connectServer(): Promise<void> {
  try {
    await startAndConnectServer();
  } catch (error) {
    if (!packageProbeOutPath() || error instanceof ServerStartDeclinedError) throw error;
    serverFailure = errorMessage(error);
    appendCrashLog(`server did not start: ${serverFailure}`);
  }
}

async function startApp(): Promise<void> {
  const updateAutotest = await prepareUpdateAutotest();
  mkdirSync(logsDir(), { recursive: true });
  initCrashLog(logsDir(), "shell");
  process.on("uncaughtException", (err) => {
    appendCrashLog(`uncaughtException: ${err.stack ?? err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    appendCrashLog(`unhandledRejection: ${String(reason)}`);
  });
  registerWindowIpc();
  registerShellIpc();
  registerUpdateIpc();
  registerShutdownIpc();
  link.onChange(handleLinkChange);
  link.on("app.notice", (payload) => showNotice(payload as AppNotice));
  serverProcess.onExit((expected) => {
    if (expected && !quitApproved) quitWithoutDialog();
  });
  await connectServer();
  ensureUpdateService();
  process.once("SIGINT", quitWithoutDialog);
  process.once("SIGTERM", quitWithoutDialog);
  powerMonitor.on("shutdown", endOfSession);
  nativeTheme.on("updated", syncWindowBackground);
  app.on("child-process-gone", (_e, details) => {
    appendCrashLog(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
  startUpdateAutotest(updateAutotest);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);

  app.whenReady().then(startApp).catch(reportFatalStartupError);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (!isQuitApproved() && link.isOpen && liveMainWindow()) {
      event.preventDefault();
      focusMainWindow();
      requestShutdown();
      return;
    }
    clearShutdownAck();
    quitApproved = true;
    destroyTray();
    if (serverStopped) {
      applyPendingActivation();
      return;
    }
    event.preventDefault();
    void stopServer().then(() => app.quit());
  });
}
