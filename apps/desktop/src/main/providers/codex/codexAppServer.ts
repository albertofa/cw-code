import { type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { spawnCli } from "../../cli/spawnCli.js";
import { hasExited, killProcessTree, waitForExit } from "../../processTree.js";

export class CodexAppServerError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

export interface CodexAppServerOptions {
  binary: string;
  args?: string[];
  clientInfo?: { name: string; title: string; version: string };
  env?: Record<string, string>;
  initializeTimeoutMs?: number;
}

export interface CodexAppServerLike {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  respond(id: string | number, result: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): void;
  onServerRequest(handler: (method: string, params: unknown, id: string | number) => void): void;
  /** Applies the spawn env for the next app-server launch; no effect on an already-running process. */
  setSpawnEnv?(env: Record<string, string> | undefined): void;
  ownedProcessCount?(): number;
  shutdown?(timeoutMs: number): Promise<{ timedOut: boolean }>;
  dispose(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Envelope {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const DEFAULT_CLIENT_INFO = { name: "cw_code", title: "cw-code", version: "0.1.0" };
const STDERR_TAIL_LINES = 20;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

export class CodexAppServer implements CodexAppServerLike {
  private proc: ChildProcess | null = null;
  private child: ChildProcess | null = null;
  private latest: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private serverRequestHandler: ((method: string, params: unknown, id: string | number) => void) | null = null;
  private stderrTail: string[] = [];
  private disposed = false;

  constructor(private opts: CodexAppServerOptions) {}

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: (method: string, params: unknown, id: string | number) => void): void {
    this.serverRequestHandler = handler;
  }

  setSpawnEnv(env: Record<string, string> | undefined): void {
    this.opts = { ...this.opts, env };
  }

  request<T>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    return this.withProcess(async (proc) => {
      const id = this.nextId++;
      const promise = new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new CodexAppServerError(`codex app-server request '${method}' timed out`));
        }, timeoutMs);
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      });
      this.writeLine(proc, { method, id, params });
      return promise;
    });
  }

  respond(id: string | number, result: unknown): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    this.writeLine(this.proc, { id, result });
  }

  ownedProcessCount(): number {
    return this.child && !hasExited(this.child) ? 1 : 0;
  }

  async shutdown(timeoutMs: number): Promise<{ timedOut: boolean }> {
    const child = this.child;
    if (!child || hasExited(child)) {
      this.dispose();
      return { timedOut: false };
    }
    this.disposed = true;
    this.proc = null;
    this.rejectAllPending(new CodexAppServerError("codex app-server is shutting down"));
    try {
      child.stdin?.end();
    } catch {
    }
    const exited = await waitForExit(child, timeoutMs);
    if (exited) this.forget(child);
    return { timedOut: !exited };
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAllPending(new CodexAppServerError("codex app-server disposed"));
    const child = this.child;
    this.proc = null;
    this.starting = null;
    if (child && !hasExited(child)) killProcessTree(child);
  }

  private forget(child: ChildProcess): void {
    if (this.child === child) this.child = null;
    if (this.proc === child) this.proc = null;
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private async withProcess<T>(fn: (proc: ChildProcess) => Promise<T>): Promise<T> {
    const proc = await this.ensureStarted();
    if (this.disposed) throw new CodexAppServerError("codex app-server disposed");
    return fn(proc);
  }

  private async ensureStarted(): Promise<ChildProcess> {
    if (this.disposed) throw new CodexAppServerError("codex app-server disposed");
    if (this.proc && this.proc.exitCode === null) return this.proc;
    if (this.starting) return this.starting;
    this.starting = this.spawnAndInitialize().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnAndInitialize(): Promise<ChildProcess> {
    const args = [...(this.opts.args ?? []), "app-server"];
    const proc = spawnCli(this.opts.binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(this.opts.env ? { env: this.opts.env } : {})
    });
    this.child = proc;
    this.latest = proc;
    this.stderrTail = [];

    proc.on("error", (err) => {
      if (this.latest === proc) this.rejectAllPending(new CodexAppServerError(`failed to spawn ${this.opts.binary}: ${err.message}`));
      if (this.proc === proc) this.proc = null;
      if (proc.pid === undefined || hasExited(proc)) this.forget(proc);
    });
    proc.on("exit", () => this.forget(proc));
    proc.on("close", (code) => {
      this.forget(proc);
      if (this.latest !== proc) return;
      this.rejectAllPending(
        new CodexAppServerError(
          `codex app-server exited (code ${code})${this.stderrTail.length ? `: ${this.stderrTail.join(" ")}` : ""}`
        )
      );
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.latest !== proc) return;
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    const id = this.nextId++;
    const initialized = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError("codex app-server initialize timed out"));
      }, this.opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
        timer
      });
    });
    try {
      this.writeLine(proc, {
        method: "initialize",
        id,
        params: {
          clientInfo: this.opts.clientInfo ?? DEFAULT_CLIENT_INFO,
          capabilities: { experimentalApi: true, requestAttestation: false }
        }
      });
      await initialized;
    } catch (err) {
      if (!this.disposed && this.child === proc && !hasExited(proc)) killProcessTree(proc);
      throw err;
    }
    if (this.disposed) throw new CodexAppServerError("codex app-server disposed");
    this.writeLine(proc, { method: "initialized" });
    this.proc = proc;
    return proc;
  }

  private writeLine(proc: ChildProcess, message: Envelope): void {
    if (!proc.stdin || proc.stdin.destroyed) {
      throw new CodexAppServerError("codex app-server stdin is not available");
    }
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Envelope;
    try {
      msg = JSON.parse(line) as Envelope;
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.serverRequestHandler?.(msg.method, msg.params, msg.id);
      return;
    }
    if (msg.method !== undefined) {
      this.notificationHandler?.(msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new CodexAppServerError(msg.error.message ?? "codex app-server error", msg.error.code ?? null));
      } else {
        pending.resolve(msg.result);
      }
    }
  }
}
