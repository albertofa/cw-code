import type { AppNotice, DeviceInfo, ServerReady, ShutdownCommitResult, ShutdownExpiredEvent, ShutdownReason, ShutdownStatus, StartupState } from "@cw-code/contracts";
import { CLOSE_UNAUTHORIZED, PROTOCOL_VERSION, SERVER_READY_PREFIX } from "@cw-code/shared/protocol";
import { appendCrashLog, initCrashLog } from "../debug/crashLog.js";
import { initHarnessTrace } from "../debug/harnessTrace.js";
import { initSessionStatusTrace } from "../debug/sessionStatusTrace.js";
import { sweepStaleSnapshotIndexes } from "../fs/GitService.js";
import { registerHandlers } from "../handlers/index.js";
import { reapOrphanedServers } from "../orphanServers.js";
import { claudeCommandsCachePath, logsDir, opencodeModelsCachePath, sessionDbPath, settingsFilePath, userdataDir } from "../paths/appPaths.js";
import { initClaudeCommandsCache } from "../providers/claude/claudeCommands.js";
import { initOpencodeModelsCache } from "../providers/opencode/opencodeModels.js";
import { openMetadataStores } from "../storage/metadataStores.js";
import type { ServerArgs } from "../transport/args.js";
import { removeEndpoint, writeEndpoint } from "../transport/endpointFile.js";
import { DeviceTokens } from "../transport/deviceTokens.js";
import { loadOrCreateOwnerToken, tokensEqual } from "../transport/ownerToken.js";
import { Router, type ClientAuth } from "../transport/Router.js";
import { TopicRegistry } from "../transport/TopicRegistry.js";
import { WsServer } from "../transport/WsServer.js";
import { eventAudience } from "./eventAudience.js";
import { eventTopic } from "./eventTopics.js";
import { createServices, type Services } from "./services.js";
import { wireTopics } from "./topicWiring.js";

const SESSION_SETTLE_INTERVAL_MS = 60_000;
const SESSION_SETTLE_INITIAL_DELAY_MS = 5_000;
const PARENT_CHECK_INTERVAL_MS = 2_000;
const STOP_AFTER_REPLY_MS = 50;
const STOP_DEADLINE_MS = 5_000;

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export class ServerApp {
  readonly router = new Router();
  readonly topics = new TopicRegistry();
  private readonly topicWiring = wireTopics(this);
  private deviceTokens: DeviceTokens | null = null;
  private services: Services | null = null;
  private state: StartupState = { mode: "ready" };
  private servicesDisposed = false;
  private ws: WsServer | null = null;
  private sessionSettleTimer: ReturnType<typeof setInterval> | null = null;
  private sessionSettleInitialTimer: ReturnType<typeof setTimeout> | null = null;
  private parentTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private lastShutdownStatus: ShutdownStatus = { idle: true, committed: false, reason: null };

  constructor(
    private readonly args: ServerArgs,
    private readonly version: string
  ) {}

  get startupState(): StartupState {
    return this.state;
  }

  requireServices(): Services {
    if (!this.services) throw new Error("cw-code is in recovery mode");
    return this.services;
  }

  emit(channel: string, payload?: unknown): void {
    const topic = eventTopic(channel, payload);
    if (topic === null) {
      this.ws?.broadcast(channel, payload, eventAudience(channel));
      return;
    }
    const subscribers = this.topics.subscribers(topic);
    if (subscribers.size === 0) return;
    this.ws?.sendTo(subscribers, channel, payload);
  }

  sendTo(clientId: string, channel: string, payload?: unknown): void {
    this.ws?.sendTo([clientId], channel, payload);
  }

  get devices(): DeviceTokens {
    if (!this.deviceTokens) throw new Error("device tokens are not loaded");
    return this.deviceTokens;
  }

  deviceInfos(): DeviceInfo[] {
    const connected = new Set(this.ws?.clients().flatMap((ctx) => (ctx.auth.kind === "device" ? [ctx.auth.deviceId] : [])));
    return this.devices.list().map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt, connected: connected.has(id) }));
  }

  emitDevicesChanged(): void {
    this.emit("devices.changed", this.deviceInfos());
  }

  revokeDevice(id: string): void {
    if (!this.devices.revoke(id)) throw Object.assign(new Error(`unknown device '${id}'`), { code: "not-found" });
    this.ws?.closeClients((ctx) => ctx.auth.kind === "device" && ctx.auth.deviceId === id, CLOSE_UNAUTHORIZED, "device revoked");
    this.emitDevicesChanged();
  }

  currentServices(): Services | null {
    return this.services;
  }

  start(loginShellWarnings: string[]): ServerReady {
    try {
      const tracePath = initHarnessTrace({ logDir: logsDir() });
      console.warn(`harness trace: ${tracePath}`);
    } catch (err) {
      console.warn(`harness trace init failed: ${(err as Error).message}`);
    }
    try {
      const statusTracePath = initSessionStatusTrace({ logDir: logsDir() });
      console.warn(`session status trace: ${statusTracePath}`);
    } catch (err) {
      console.warn(`session status trace init failed: ${(err as Error).message}`);
    }
    initCrashLog(logsDir(), "server");
    for (const warning of loginShellWarnings) {
      console.warn(`[shell-env] ${warning}`);
      appendCrashLog(`[shell-env] ${warning}`);
    }
    process.on("uncaughtException", (err) => {
      appendCrashLog(`uncaughtException: ${err.stack ?? err.message}`);
    });
    process.on("unhandledRejection", (reason) => {
      appendCrashLog(`unhandledRejection: ${String(reason)}`);
    });
    const ownerToken = loadOrCreateOwnerToken(userdataDir());
    const devices = new DeviceTokens(userdataDir());
    this.deviceTokens = devices;
    registerHandlers(this.router, this);
    const authorize = (token: string): ClientAuth | null => {
      const device = devices.verify(token);
      if (tokensEqual(ownerToken, token)) return { kind: "owner" };
      if (!device) return null;
      devices.touch(device.id, Date.now());
      return { kind: "device", deviceId: device.id };
    };
    const ws = new WsServer({ host: this.args.host, port: this.args.port, authorize, version: this.version, router: this.router });
    const { url, port } = this.bind(ws);
    this.ws = ws;
    this.openStores();
    ws.onClientClosed((ctx) => {
      this.topics.dropClient(ctx.clientId);
      if (ctx.client === "desktop-ui" && !this.stopping) this.handleUiDisconnected(ws);
    });
    const ready: ServerReady = { url, port, pid: process.pid, protocol: PROTOCOL_VERSION, version: this.version };
    writeEndpoint(userdataDir(), ready);
    process.stdout.write(`CW_SERVER_READY ${JSON.stringify(ready)}\n`);
    this.watchParent();
    process.once("SIGINT", () => void this.stop(0));
    process.once("SIGTERM", () => void this.stop(0));
    return ready;
  }

  reboot(): StartupState {
    this.openStores();
    this.emit("startup.changed", this.state);
    return this.state;
  }

  shutdownStatus(): ShutdownStatus {
    const shutdown = this.services?.shutdown;
    return {
      idle: shutdown?.isIdle() ?? true,
      committed: shutdown?.isCommitted() ?? false,
      reason: shutdown?.currentReason() ?? null
    };
  }

  emitShutdownChanged(): void {
    const status = this.shutdownStatus();
    const last = this.lastShutdownStatus;
    if (last.idle === status.idle && last.committed === status.committed && last.reason === status.reason) return;
    this.lastShutdownStatus = status;
    this.emit("shutdown.changed", status);
  }

  private bind(ws: WsServer): { url: string; port: number } {
    try {
      return ws.start();
    } catch (err) {
      const message = `could not listen on ${this.args.host}:${this.args.port}: ${(err as Error).message}`;
      appendCrashLog(message);
      console.error(message);
      process.exit(1);
    }
  }

  private async commitShutdown(token: string, action: () => Promise<void> | void): Promise<ShutdownCommitResult> {
    if (!this.services) return { ok: false, message: "cw-code services are not running" };
    const result = await this.services.shutdown.commit(token, action);
    if (!result.ok && !this.services.shutdown.isCommitted()) this.servicesDisposed = false;
    return result;
  }

  async quit(token: string): Promise<ShutdownCommitResult> {
    let disposed: (result: ShutdownCommitResult) => void = () => {};
    const actionDone = new Promise<ShutdownCommitResult>((resolve) => {
      disposed = resolve;
    });
    const committing = this.commitShutdown(token, () => {
      this.disposeServices();
      disposed({ ok: true });
    });
    const result = await Promise.race([committing, actionDone]);
    this.emitShutdownChanged();
    if (result.ok) this.scheduleStop(0);
    return result;
  }

  scheduleStop(exitCode: number): void {
    setTimeout(() => void this.stop(exitCode), STOP_AFTER_REPLY_MS);
  }

  async stop(exitCode: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    setTimeout(() => {
      appendCrashLog(`server did not stop within ${STOP_DEADLINE_MS}ms; exiting`);
      process.exit(exitCode);
    }, STOP_DEADLINE_MS);
    if (this.parentTimer) clearInterval(this.parentTimer);
    this.parentTimer = null;
    try {
      this.stopSessionSweeps();
      this.disposeServices();
    } catch (err) {
      console.warn(`service disposal failed: ${(err as Error).message}`);
    }
    try {
      await this.ws?.stop();
    } catch (err) {
      console.warn(`websocket server stop failed: ${(err as Error).message}`);
    }
    try {
      removeEndpoint(userdataDir(), process.pid);
    } catch (err) {
      console.warn(`could not remove the server endpoint file: ${(err as Error).message}`);
    }
    process.exit(exitCode);
  }

  private openStores(): void {
    const stores = openMetadataStores({ dbPath: sessionDbPath(), settingsPath: settingsFilePath() });
    if (!stores.ok) {
      this.state = { mode: "recovery", issues: stores.issues, dataDir: userdataDir() };
      for (const issue of stores.issues) {
        appendCrashLog(`metadata recovery required: ${issue.store} ${issue.file} (${issue.kind}): ${issue.message}`);
      }
      return;
    }
    initOpencodeModelsCache(opencodeModelsCachePath());
    initClaudeCommandsCache(claudeCommandsCachePath());
    const services = createServices(stores, {
      emit: (channel, payload) => this.emit(channel, payload),
      legacyAppRoots: this.args.legacyUserData,
      onShutdownRecovered: (failure) => this.handleShutdownRecovered(failure),
      onShutdownExpired: (reason) => this.handleShutdownExpired(reason)
    });
    this.services = services;
    this.servicesDisposed = false;
    this.state = { mode: "ready" };
    services.sessions.warmOpencodeModels();
    reapOrphanedServers()
      .then((reaped) => {
        if (reaped.length > 0) console.warn(`reaped ${reaped.length} orphaned CLI server(s) from a previous run`);
      })
      .catch((err) => {
        console.warn(`orphan server sweep failed: ${(err as Error).message}`);
      });
    sweepStaleSnapshotIndexes()
      .then((removed) => {
        if (removed > 0) console.warn(`removed ${removed} stale turn snapshot index file(s)`);
      })
      .catch((err) => {
        console.warn(`turn snapshot index sweep failed: ${(err as Error).message}`);
      });
    this.startSessionSweeps();
    this.topicWiring.resync();
  }

  private handleShutdownRecovered(failure: string | null): void {
    this.servicesDisposed = false;
    this.startSessionSweeps();
    this.emitShutdownChanged();
    if (!failure) return;
    appendCrashLog(`shutdown recovery could not restart CLI drivers: ${failure}`);
    const notice: AppNotice = { level: "error", title: "cw-code", message: "cw-code could not restart its CLI drivers", detail: failure };
    this.emit("app.notice", notice);
  }

  private handleShutdownExpired(reason: ShutdownReason): void {
    const event: ShutdownExpiredEvent = { reason };
    this.emit("shutdown.expired", event);
    this.emitShutdownChanged();
  }

  private handleUiDisconnected(ws: WsServer): void {
    this.recoverAbandonedShutdown();
    if (ws.clients().some((client) => client.client === "desktop-ui")) return;
    this.services?.ptys.detachAll();
  }

  private recoverAbandonedShutdown(): void {
    const services = this.services;
    if (!services || services.shutdown.isIdle() || services.shutdown.isCommitted()) return;
    services.shutdown.recover();
  }

  private runSessionSweeps(): void {
    const running = this.services;
    if (!running || !running.shutdown.isIdle()) return;
    void running.sessions.settleFinishedPrSessions();
    void running.sessions.resolveExpiredIdleSessions();
  }

  private startSessionSweeps(): void {
    this.stopSessionSweeps();
    this.sessionSettleInitialTimer = setTimeout(() => {
      this.sessionSettleInitialTimer = null;
      this.runSessionSweeps();
    }, SESSION_SETTLE_INITIAL_DELAY_MS);
    this.sessionSettleInitialTimer.unref?.();
    this.sessionSettleTimer = setInterval(() => this.runSessionSweeps(), SESSION_SETTLE_INTERVAL_MS);
    this.sessionSettleTimer.unref?.();
    this.services?.prTracker.start();
    this.services?.sourceControl.start();
  }

  private stopSessionSweeps(): void {
    if (this.sessionSettleInitialTimer) {
      clearTimeout(this.sessionSettleInitialTimer);
      this.sessionSettleInitialTimer = null;
    }
    if (this.sessionSettleTimer) {
      clearInterval(this.sessionSettleTimer);
      this.sessionSettleTimer = null;
    }
    this.services?.prTracker.stop();
  }

  private disposeServices(): void {
    const services = this.services;
    if (!services || this.servicesDisposed) return;
    this.servicesDisposed = true;
    this.stopSessionSweeps();
    try {
      services.sessions.flush();
    } catch (err) {
      console.warn(`flush before exit failed: ${(err as Error).message}`);
    }
    void services.sourceControl.dispose();
    services.runWatcher.dispose();
    void services.fileWatcher.dispose();
    services.sessions.dispose();
    services.ptys.dispose();
  }

  private watchParent(): void {
    const parentPid = this.args.parentPid;
    if (parentPid === null) return;
    this.parentTimer = setInterval(() => {
      if (!isProcessGone(parentPid)) return;
      console.warn(`parent process ${parentPid} is gone; stopping`);
      void this.stop(0);
    }, PARENT_CHECK_INTERVAL_MS);
    this.parentTimer.unref?.();
  }
}
