import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerEndpoint, ServerReady } from "@cw-code/contracts";
import { appendCrashLog } from "@cw-code/server/debug/crashLog";
import { cwCodeHome, userdataDir } from "@cw-code/server/paths/appPaths";
import { isServerReady, SERVER_READY_PREFIX, SERVER_RUNNING_PREFIX, SERVER_TOKEN_FILE } from "@cw-code/shared/protocol";
import { resolveBunBinary, type BunLookup } from "./bunBinary.js";

export const READY_TIMEOUT_MS = 60_000;
export const STOP_CALL_TIMEOUT_MS = 3_000;
export const STOP_EXIT_TIMEOUT_MS = 3_000;
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 60_000;
const ALREADY_RUNNING_RETRY_MS = 6_000;
const ALREADY_RUNNING_POLL_MS = 500;
const RESTART_DELAY_MS = 500;
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
  isQuitting(): boolean;
  onFatal(message: string): void;
}

const LINE_KINDS: ReadonlyArray<readonly [string, ServerLine["kind"]]> = [
  [SERVER_READY_PREFIX, "ready"],
  [SERVER_RUNNING_PREFIX, "running"]
];

class ServerAlreadyRunningError extends Error {
  constructor() {
    super(`Another cw-code instance is already using ${cwCodeHome()}. Close it first, or start this one with a different CW_CODE_HOME.`);
    this.name = "ServerAlreadyRunningError";
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

  start(): Promise<ServerReady> {
    this.stopRequested = false;
    this.stopping = null;
    return this.launchExclusive();
  }

  async endpoint(): Promise<ServerEndpoint> {
    const ready = this.current;
    if (!ready) throw new Error("the cw-code server is not running");
    const token = (await readFile(join(userdataDir(), SERVER_TOKEN_FILE), "utf8")).trim();
    return { url: ready.url, token };
  }

  onExit(cb: (expected: boolean) => void): () => void {
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  }

  stop(link?: ServerStopLink): Promise<void> {
    this.stopRequested = true;
    this.stopping ??= this.stopChild(link);
    return this.stopping;
  }

  private tailText(): string {
    return this.stderrTail.length > 0 ? `\n--- last server stderr ---\n${this.stderrTail.join("\n")}` : "";
  }

  private async launchExclusive(): Promise<ServerReady> {
    const deadline = Date.now() + ALREADY_RUNNING_RETRY_MS;
    for (;;) {
      try {
        return await this.launch();
      } catch (error) {
        if (!(error instanceof ServerAlreadyRunningError) || Date.now() >= deadline) throw error;
      }
      await delay(ALREADY_RUNNING_POLL_MS);
    }
  }

  private launch(): Promise<ServerReady> {
    const command = serverCommand(
      this.options.launch,
      process.platform,
      process.stdout.isTTY || process.stdin.isTTY ? { ...process.env, CW_LAUNCHED_FROM_TERMINAL: "1" } : process.env,
      ["--port", String(this.port), "--parent-pid", String(process.pid), "--legacy-user-data", this.options.launch.legacyUserData],
      { homeDir: homedir(), exists: existsSync }
    );
    this.stderrTail = [];
    return new Promise<ServerReady>((resolvePromise, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command.file, command.args, { env: command.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        reject(new Error(`could not start the cw-code server (${command.file}): ${errorMessage(error)}`));
        return;
      }
      this.child = child;
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
            settle(() => reject(new ServerAlreadyRunningError()));
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
    void this.recover(reason);
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
        lastFailure = errorMessage(error);
        appendCrashLog(`cw-code server restart failed: ${lastFailure}`);
      }
    }
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
