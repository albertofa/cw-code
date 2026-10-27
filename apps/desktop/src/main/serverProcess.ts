import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerEndpoint, ServerReady } from "@cw-code/contracts";
import { appendCrashLog } from "@cw-code/server/debug/crashLog";
import { cwCodeHome, userdataDir } from "@cw-code/server/paths/appPaths";
import { confirmLiveEndpoint, isProcessAlive, readLiveEndpoint } from "@cw-code/server/transport/endpointFile";
import { isServerReady, SERVER_READY_PREFIX, SERVER_RUNNING_PREFIX, SERVER_TOKEN_FILE } from "@cw-code/shared/protocol";
import { resolveBunBinary, type BunLookup } from "./bunBinary.js";
import { decideServerStart, killAndWait, requestServerStop, waitForPidExit, type LauncherIdentity, type StartDecision } from "./serverAttach.js";

export const READY_TIMEOUT_MS = 60_000;
export const STOP_CALL_TIMEOUT_MS = 3_000;
export const STOP_EXIT_TIMEOUT_MS = 3_000;
export const REPLACE_EXIT_TIMEOUT_MS = 15_000;
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 60_000;
const ALREADY_RUNNING_RETRY_MS = 6_000;
const ALREADY_RUNNING_POLL_MS = 500;
const RESTART_DELAY_MS = 500;
const ATTACHED_POLL_MS = 1_000;
const STDERR_TAIL_LINES = 50;

export interface ServerLine {
  kind: "ready" | "running";
  ready: ServerReady;
}

export interface ServerLaunch {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  legacyUserData: string;
}

export interface ServerCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ServerStopLink {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface ServerProcessOptions {
  launch: ServerLaunch;
  identity: LauncherIdentity;
  isQuitting(): boolean;
  onFatal(message: string): void;
  confirmReplace(running: ServerReady): Promise<boolean>;
  onAttached(endpoint: ServerEndpoint): Promise<void>;
  onDeclined(): void;
}

const LINE_KINDS: ReadonlyArray<readonly [string, ServerLine["kind"]]> = [
  [SERVER_READY_PREFIX, "ready"],
  [SERVER_RUNNING_PREFIX, "running"]
];

class ServerAlreadyRunningError extends Error {
  constructor(
    readonly running: ServerReady,
    foreign: boolean
  ) {
    super(
      `Another cw-code instance is already using ${cwCodeHome()}. Close it first, or start this one with a different CW_CODE_HOME.` +
        (foreign ? " It was started by another cw-code install or from the command line; connect to it as a remote server instead." : "")
    );
    this.name = "ServerAlreadyRunningError";
  }
}

export class ServerStartDeclinedError extends Error {
  constructor() {
    super("the background cw-code server was left running");
    this.name = "ServerStartDeclinedError";
  }
}

export function parseServerLine(line: string): ServerLine | null {
  for (const [prefix, kind] of LINE_KINDS) {
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(prefix.length));
      return isServerReady(parsed) ? { kind, ready: parsed } : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function splitLines(pending: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (pending + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.replace(/\r$/, "")), rest };
}

export function allowRestart(history: readonly number[], now: number, max = MAX_RESTARTS, windowMs = RESTART_WINDOW_MS): number[] | null {
  const recent = history.filter((at) => now - at < windowMs);
  return recent.length >= max ? null : [...recent, now];
}

export function serverArgs(port: number, parentPid: number, legacyUserData: string, env: NodeJS.ProcessEnv, launcherId?: string): string[] {
  const args = ["--port", String(port), "--parent-pid", String(parentPid), "--legacy-user-data", legacyUserData];
  if (launcherId) args.push("--launcher-id", launcherId);
  const rendererUrl = env.ELECTRON_RENDERER_URL?.trim();
  if (!rendererUrl) return args;
  try {
    return [...args, "--allow-origin", new URL(rendererUrl).origin];
  } catch {
    console.warn(`[server] ignoring invalid ELECTRON_RENDERER_URL: ${rendererUrl}`);
    return args;
  }
}

export function serverCommand(
  launch: ServerLaunch,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  args: string[],
  files: Pick<BunLookup, "homeDir" | "exists">
): ServerCommand {
  if (launch.isPackaged) {
    const dir = join(launch.resourcesPath, "server");
    return {
      file: join(dir, platform === "win32" ? "cw-code-server.exe" : "cw-code-server"),
      args,
      env: { ...env, CW_NODE_PTY: join(dir, "node_modules", "node-pty", "lib", "index.js") }
    };
  }
  const entry = env.CW_SERVER_ENTRY?.trim() || resolve(launch.appPath, "..", "server", "src", "index.ts");
  return { file: resolveBunBinary({ env, platform, ...files }), args: [entry, ...args], env: { ...env } };
}

async function readOwnerToken(): Promise<string> {
  return (await readFile(join(userdataDir(), SERVER_TOKEN_FILE), "utf8")).trim();
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolvePromise(true);
      },
      () => {
        clearTimeout(timer);
        resolvePromise(true);
      }
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class ServerProcess {
  private current: ServerReady | null = null;
  private child: ChildProcess | null = null;
  private attachedPid: number | null = null;
  private attachedWatch: NodeJS.Timeout | null = null;
  private port = 0;
  private stderrTail: string[] = [];
  private restarts: number[] = [];
  private stopRequested = false;
  private stopping: Promise<void> | null = null;
  private readonly exitListeners = new Set<(expected: boolean) => void>();

  constructor(private readonly options: ServerProcessOptions) {}

  get ready(): ServerReady | null {
    return this.current;
  }

  get attached(): boolean {
    return this.attachedPid !== null;
  }

  start(): Promise<ServerReady> {
    this.stopRequested = false;
    this.stopping = null;
    return this.launchExclusive();
  }

  async endpoint(): Promise<ServerEndpoint> {
    const ready = this.current;
    if (!ready) throw new Error("the cw-code server is not running");
    return { url: ready.url, token: await readOwnerToken() };
  }

  onExit(cb: (expected: boolean) => void): () => void {
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  }

  stop(link?: ServerStopLink): Promise<void> {
    this.stopRequested = true;
    this.stopping ??= this.attachedPid !== null ? this.stopAttached(this.attachedPid, link) : this.stopChild(link);
    return this.stopping;
  }

  private tailText(): string {
    return this.stderrTail.length > 0 ? `\n--- last server stderr ---\n${this.stderrTail.join("\n")}` : "";
  }

  private async launchExclusive(): Promise<ServerReady> {
    const deadline = Date.now() + ALREADY_RUNNING_RETRY_MS;
    for (;;) {
      const lastTry = Date.now() >= deadline;
      const decision = await this.decide();
      if (decision.kind === "attach") return this.attach(decision.ready);
      if (decision.kind === "replace") {
        await this.replace(decision.ready);
        continue;
      }
      if (decision.kind === "foreign") {
        if (lastTry) throw new ServerAlreadyRunningError(decision.ready, true);
      } else {
        try {
          return await this.launch();
        } catch (error) {
          if (!(error instanceof ServerAlreadyRunningError) || lastTry) throw error;
        }
      }
      await delay(ALREADY_RUNNING_POLL_MS);
    }
  }

  private isForeign(running: ServerReady): boolean {
    return decideServerStart(running, this.options.identity).kind === "foreign";
  }

  private async decide(): Promise<StartDecision> {
    const existing = readLiveEndpoint(userdataDir());
    if (!existing || !(await confirmLiveEndpoint(existing))) return { kind: "spawn" };
    return decideServerStart(existing, this.options.identity);
  }

  private async attach(ready: ServerReady): Promise<ServerReady> {
    this.child = null;
    this.current = ready;
    this.port = ready.port;
    this.attachedPid = ready.pid;
    this.clearAttachedWatch();
    const watch = setInterval(() => {
      if (isProcessAlive(ready.pid)) return;
      this.clearAttachedWatch();
      if (this.attachedPid !== ready.pid) return;
      this.attachedPid = null;
      this.handleExit(`the background server (pid ${ready.pid}) exited`);
    }, ATTACHED_POLL_MS);
    watch.unref();
    this.attachedWatch = watch;
    console.warn(`[server] attached to the background server on ${ready.url} (pid ${ready.pid})`);
    try {
      await this.options.onAttached(await this.endpoint());
    } catch (error) {
      console.warn(`[server] could not take over the background server's parent watch: ${errorMessage(error)}`);
    }
    return ready;
  }

  private clearAttachedWatch(): void {
    if (this.attachedWatch) clearInterval(this.attachedWatch);
    this.attachedWatch = null;
  }

  private async replace(running: ServerReady): Promise<void> {
    if (!(await this.options.confirmReplace(running))) throw new ServerStartDeclinedError();
    const requested = await readOwnerToken()
      .then((token) => requestServerStop(running, token))
      .then(
        () => true,
        (error: unknown) => {
          console.warn(`[server] could not ask the old server to stop: ${errorMessage(error)}`);
          return false;
        }
      );
    if (requested && (await waitForPidExit(running.pid, REPLACE_EXIT_TIMEOUT_MS))) return;
    if (await killAndWait(running.pid, STOP_EXIT_TIMEOUT_MS)) return;
    throw new Error(`the cw-code server from version ${running.version} (pid ${running.pid}) did not stop within ${REPLACE_EXIT_TIMEOUT_MS / 1000}s`);
  }

  private launch(): Promise<ServerReady> {
    const command = serverCommand(
      this.options.launch,
      process.platform,
      process.stdout.isTTY || process.stdin.isTTY ? { ...process.env, CW_LAUNCHED_FROM_TERMINAL: "1" } : process.env,
      serverArgs(this.port, process.pid, this.options.launch.legacyUserData, process.env, this.options.identity.installId),
      { homeDir: homedir(), exists: existsSync }
    );
    this.stderrTail = [];
    return new Promise<ServerReady>((resolvePromise, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command.file, command.args, { env: command.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: true });
      } catch (error) {
        reject(new Error(`could not start the cw-code server (${command.file}): ${errorMessage(error)}`));
        return;
      }
      child.unref();
      this.child = child;
      this.attachedPid = null;
      this.clearAttachedWatch();
      let settled = false;
      let started = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
      };
      const timer = setTimeout(() => {
        settle(() => {
          child.kill();
          reject(new Error(`the cw-code server did not report ready within ${READY_TIMEOUT_MS / 1000}s${this.tailText()}`));
        });
      }, READY_TIMEOUT_MS);

      let stdoutRest = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        const { lines, rest } = splitLines(stdoutRest, chunk);
        stdoutRest = rest;
        for (const line of lines) {
          const parsed = settled ? null : parseServerLine(line);
          if (!parsed) {
            if (line) console.log(`[server] ${line}`);
            continue;
          }
          if (parsed.kind === "running") {
            settle(() => reject(new ServerAlreadyRunningError(parsed.ready, this.isForeign(parsed.ready))));
            continue;
          }
          this.current = parsed.ready;
          this.port = parsed.ready.port;
          started = true;
          settle(() => resolvePromise(parsed.ready));
        }
      });
      let stderrRest = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        const { lines, rest } = splitLines(stderrRest, chunk);
        stderrRest = rest;
        for (const line of lines) {
          if (!line) continue;
          console.warn(`[server] ${line}`);
          this.stderrTail.push(line);
          if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
        }
      });
      child.on("error", (error) => {
        settle(() => reject(new Error(`could not start the cw-code server (${command.file}): ${error.message}`)));
      });
      child.on("close", (code, signal) => {
        if (this.child === child) this.child = null;
        const exit = describeExit(code, signal);
        if (!settled) {
          settle(() => reject(new Error(`the cw-code server exited before it was ready (${exit})${this.tailText()}`)));
          return;
        }
        if (!started) return;
        this.handleExit(exit);
      });
    });
  }

  private notifyExit(expected: boolean): void {
    for (const cb of [...this.exitListeners]) cb(expected);
  }

  private handleExit(reason: string): void {
    const expected = this.stopRequested || this.options.isQuitting();
    this.notifyExit(expected);
    if (expected) return;
    appendCrashLog(`cw-code server exited unexpectedly: ${reason}${this.tailText()}`);
    this.recover(reason).catch((error: unknown) => {
      if (error instanceof ServerStartDeclinedError) this.options.onDeclined();
      else this.options.onFatal(errorMessage(error));
    });
  }

  private abandonRecovery(): boolean {
    if (!this.stopRequested && !this.options.isQuitting()) return false;
    this.notifyExit(true);
    return true;
  }

  private async recover(reason: string): Promise<void> {
    let lastFailure = reason;
    for (;;) {
      if (this.abandonRecovery()) return;
      const history = allowRestart(this.restarts, Date.now());
      if (!history) {
        this.options.onFatal(
          `The cw-code server stopped ${MAX_RESTARTS + 1} times within ${RESTART_WINDOW_MS / 1000}s. Last failure: ${lastFailure}`
        );
        return;
      }
      this.restarts = history;
      await delay(RESTART_DELAY_MS);
      if (this.abandonRecovery()) return;
      try {
        const ready = await this.launchExclusive();
        console.warn(`[server] restarted on ${ready.url}`);
        return;
      } catch (error) {
        if (error instanceof ServerStartDeclinedError) throw error;
        lastFailure = errorMessage(error);
        appendCrashLog(`cw-code server restart failed: ${lastFailure}`);
      }
    }
  }

  private async stopAttached(pid: number, link?: ServerStopLink): Promise<void> {
    const running = this.current;
    const request = link
      ? link.call("server.stop")
      : running
        ? readOwnerToken().then((token) => requestServerStop(running, token))
        : Promise.resolve();
    const stopCall = request.catch((error: unknown) => {
      console.warn(`[server] server.stop failed: ${errorMessage(error)}`);
    });
    if (!(await settlesWithin(stopCall, STOP_CALL_TIMEOUT_MS))) console.warn(`[server] server.stop did not answer within ${STOP_CALL_TIMEOUT_MS}ms`);
    let exited = await waitForPidExit(pid, STOP_EXIT_TIMEOUT_MS);
    if (!exited) {
      console.warn(`[server] the background server (pid ${pid}) did not exit within ${STOP_EXIT_TIMEOUT_MS}ms; killing it`);
      exited = await killAndWait(pid, STOP_EXIT_TIMEOUT_MS);
    }
    if (this.attachedPid !== pid) return;
    this.clearAttachedWatch();
    this.attachedPid = null;
    if (exited) this.notifyExit(true);
  }

  private async stopChild(link?: ServerStopLink): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
    if (link) {
      const stopCall = link.call("server.stop").catch((error: unknown) => {
        console.warn(`[server] server.stop failed: ${errorMessage(error)}`);
      });
      if (!(await settlesWithin(stopCall, STOP_CALL_TIMEOUT_MS))) console.warn(`[server] server.stop did not answer within ${STOP_CALL_TIMEOUT_MS}ms`);
    } else {
      child.kill("SIGTERM");
    }
    if (await settlesWithin(closed, STOP_EXIT_TIMEOUT_MS)) return;
    console.warn(`[server] did not exit within ${STOP_EXIT_TIMEOUT_MS}ms; killing it`);
    child.kill("SIGKILL");
    await settlesWithin(closed, STOP_EXIT_TIMEOUT_MS);
  }
}
