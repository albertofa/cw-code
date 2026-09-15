import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { killProcessTree } from "../../processTree.js";
import { traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";
import { OPENCODE_HEALTH_TIMEOUT_MS, opencodeFetch } from "./opencodeFetch.js";

export interface ServerHandle {
  port: number;
  authHeader: string;
}

const SESSION_UNIQUE_ENV_KEYS = new Set(["CW_SESSION_ID"]);
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SERVERS = 8;

export function poolEnvKey(env: Record<string, string> | undefined): string {
  if (!env) return "";
  const relevant = Object.entries(env)
    .filter(([key]) => !SESSION_UNIQUE_ENV_KEYS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

export function stripSessionEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SESSION_UNIQUE_ENV_KEYS.has(key)) out[key] = value;
  }
  return out;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 4096));
    });
  });
}

async function waitHealthy(port: number, authHeader: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await opencodeFetch(`http://127.0.0.1:${port}/session`, {
        headers: { Authorization: authHeader },
        timeoutMs: OPENCODE_HEALTH_TIMEOUT_MS,
        port
      });
      if (res.ok) return;
    } catch {
    }
    if (Date.now() - start > timeoutMs) throw new Error(`opencode serve on ${port} did not become healthy`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

interface StartedServer {
  proc: ChildProcess;
  handle: ServerHandle;
}

interface PoolEntry {
  binary: string;
  proc: ChildProcess;
  handle: ServerHandle;
  envKey: string;
  lastUsed: number;
}

export interface OpencodeServerPoolDeps {
  startServer?: (rootPath: string, binary: string, env: Record<string, string> | undefined) => Promise<StartedServer>;
  idleTimeoutMs?: number;
  maxServers?: number;
  onServerGone?: (rootPath: string, port: number) => void;
}

export class OpencodeServerPool {
  private servers = new Map<string, PoolEntry>();
  private pending = new Map<string, { envKey: string; promise: Promise<ServerHandle> }>();
  private inFlight = new Map<string, number>();
  private disposed = false;
  private idleTimeoutMs: number;
  private maxServers: number;

  constructor(
    private getBinary: () => string,
    private deps?: OpencodeServerPoolDeps
  ) {
    this.idleTimeoutMs = deps?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxServers = deps?.maxServers ?? DEFAULT_MAX_SERVERS;
  }

  beginTurn(rootPath: string): void {
    this.inFlight.set(rootPath, (this.inFlight.get(rootPath) ?? 0) + 1);
    if (this.servers.has(rootPath)) this.servers.get(rootPath)!.lastUsed = Date.now();
  }

  invalidate(rootPath: string): void {
    if ((this.inFlight.get(rootPath) ?? 0) > 0) return;
    this.stop(rootPath);
  }

  async probe(rootPath: string): Promise<boolean> {
    const entry = this.servers.get(rootPath);
    if (!entry) return false;
    if (entry.proc.exitCode != null || entry.proc.killed) return false;
    try {
      await opencodeFetch(`http://127.0.0.1:${entry.handle.port}/session`, {
        headers: { Authorization: entry.handle.authHeader },
        timeoutMs: OPENCODE_HEALTH_TIMEOUT_MS,
        port: entry.handle.port
      });
      return true;
    } catch {
      return false;
    }
  }

  private trackProcess(rootPath: string, proc: ChildProcess): void {
    if (typeof proc.once !== "function") return;
    const evict = (): void => {
      const entry = this.servers.get(rootPath);
      if (entry?.proc === proc) {
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.serve.evict",
          cwd: rootPath,
          ok: true,
          extra: { reason: "exit", exitCode: proc.exitCode ?? undefined }
        });
        this.servers.delete(rootPath);
        this.deps?.onServerGone?.(rootPath, entry.handle.port);
      }
    };
    proc.once("exit", evict);
    proc.once("error", evict);
  }

  private isDead(proc: ChildProcess): boolean {
    return proc.exitCode != null || proc.killed === true;
  }

  endTurn(rootPath: string): void {
    const count = (this.inFlight.get(rootPath) ?? 0) - 1;
    if (count <= 0) this.inFlight.delete(rootPath);
    else this.inFlight.set(rootPath, count);
    if (this.servers.has(rootPath)) this.servers.get(rootPath)!.lastUsed = Date.now();
  }

  private async ensureProcess(rootPath: string, binary: string, env: Record<string, string> | undefined): Promise<{ proc: ChildProcess; handle: ServerHandle }> {
    const start = Date.now();
    const port = await findFreePort();
    const password = process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
    const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const args = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
    const proc = spawn(binary, args, {
      cwd: rootPath,
      windowsHide: true,
      ...(env && Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {})
    });
    const handle: ServerHandle = { port, authHeader };
    try {
      const processFailed = new Promise<never>((_, reject) => {
        proc.once("error", (err) => reject(new Error(`failed to spawn ${binary}: ${err.message}`)));
        proc.once("exit", (code) => reject(new Error(`${binary} serve exited before startup (code ${code ?? "unknown"})`)));
      });
      await Promise.race([waitHealthy(port, authHeader, 90000), processFailed]);
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.ensure",
        cwd: rootPath,
        binary,
        args,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      killProcessTree(proc);
      throw err;
    }
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.serve.ensure",
      cwd: rootPath,
      binary,
      args,
      durationMs: Date.now() - start,
      ok: true,
      extra: { serverPort: port, envKeys: env ? Object.keys(env).join(",") : "" }
    });
    return { proc, handle };
  }

  async ensure(rootPath: string, env?: Record<string, string>): Promise<ServerHandle> {
    if (this.disposed) throw new Error("opencode server pool disposed");
    this.sweep();
    const envKey = poolEnvKey(env);
    const pending = this.pending.get(rootPath);
    if (pending) {
      if (pending.envKey === envKey) return pending.promise;
      await pending.promise.catch(() => undefined);
      return this.ensure(rootPath, env);
    }
    const promise = this.ensureUncached(rootPath, env, envKey).finally(() => {
      this.pending.delete(rootPath);
    });
    this.pending.set(rootPath, { envKey, promise });
    return promise;
  }

  private async ensureUncached(rootPath: string, env: Record<string, string> | undefined, envKey: string): Promise<ServerHandle> {
    const binary = this.getBinary();
    const existing = this.servers.get(rootPath);
    if (existing && this.isDead(existing.proc)) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.evict",
        cwd: rootPath,
        ok: true,
        extra: { reason: "dead", serverPort: existing.handle.port }
      });
      this.stop(rootPath);
    } else if (existing?.binary === binary && (env === undefined || existing.envKey === envKey)) {
      existing.lastUsed = Date.now();
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.ensure",
        cwd: rootPath,
        binary,
        ok: true,
        extra: { cached: true, serverPort: existing.handle.port }
      });
      return existing.handle;
    }
    const live = this.servers.get(rootPath);
    if (live) {
      if ((this.inFlight.get(rootPath) ?? 0) > 0) {
        live.lastUsed = Date.now();
        return live.handle;
      }
      this.stop(rootPath);
    }
    const spawnEnv = stripSessionEnv(env);
    const started = this.deps?.startServer
      ? await this.deps.startServer(rootPath, binary, spawnEnv)
      : await this.ensureProcess(rootPath, binary, spawnEnv);
    if (this.disposed) {
      killProcessTree(started.proc);
      throw new Error("opencode server pool disposed");
    }
    this.trackProcess(rootPath, started.proc);
    this.servers.set(rootPath, { binary, proc: started.proc, handle: started.handle, envKey, lastUsed: Date.now() });
    return started.handle;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [rootPath, entry] of [...this.servers]) {
      if ((this.inFlight.get(rootPath) ?? 0) > 0) continue;
      if (now - entry.lastUsed <= this.idleTimeoutMs) continue;
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.evict",
        cwd: rootPath,
        ok: true,
        extra: { reason: "idle", idleMs: now - entry.lastUsed }
      });
      this.stop(rootPath);
    }
    const evictable = [...this.servers.entries()]
      .filter(([rootPath]) => (this.inFlight.get(rootPath) ?? 0) === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.servers.size > this.maxServers && evictable.length > 0) {
      const [rootPath] = evictable.shift()!;
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.evict",
        cwd: rootPath,
        ok: true,
        extra: { reason: "capacity" }
      });
      this.stop(rootPath);
    }
  }

  stop(rootPath: string): void {
    const entry = this.servers.get(rootPath);
    if (!entry) return;
    this.servers.delete(rootPath);
    this.deps?.onServerGone?.(rootPath, entry.handle.port);
    killProcessTree(entry.proc);
  }

  dispose(): void {
    this.disposed = true;
    for (const rootPath of [...this.servers.keys()]) this.stop(rootPath);
  }
}
