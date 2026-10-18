import { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { killProcessTree } from "../../processTree.js";
import { execCliFile, spawnCli } from "../../cli/spawnCli.js";
import { withOwnerPid } from "../../orphanServers.js";
import { traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";
import {
  basicAuthHeader,
  identifyServer,
  newServerPassword,
  parseStdioServerUrl,
  protocolOfVersion,
  serverAuthEnv,
  waitForServerIdentity,
  type OpencodeProtocolVersion
} from "./opencodeServerProbe.js";
import { interruptActiveV2Sessions } from "./v2/opencodeV2Server.js";

export interface ServerHandle {
  port: number;
  authHeader: string;
  protocol?: OpencodeProtocolVersion;
  version?: string;
  password?: string;
}

const STARTUP_TIMEOUT_MS = 90_000;
const CLI_PROTOCOL_TTL_MS = 5 * 60_000;
const cliProtocols = new Map<string, { at: number; protocol: OpencodeProtocolVersion }>();

export async function opencodeCliProtocol(binary: string): Promise<OpencodeProtocolVersion> {
  const cached = cliProtocols.get(binary);
  if (cached && Date.now() - cached.at < CLI_PROTOCOL_TTL_MS) return cached.protocol;
  try {
    const { stdout } = await execCliFile(binary, ["--version"], { timeout: 15000 });
    const protocol = protocolOfVersion(/(\d+\.\d+\.\d+)/.exec(stdout)?.[1]) ?? "v1";
    cliProtocols.set(binary, { at: Date.now(), protocol });
    return protocol;
  } catch (err) {
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.cliProtocol",
      binary,
      ok: false,
      error: truncateError((err as Error).message)
    });
    return "v1";
  }
}

const SESSION_UNIQUE_ENV_KEYS = new Set(["CW_SESSION_ID", "CW_WORKTREE_PATH", "CW_PROJECT_ROOT"]);
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SERVERS = 4;
const SWEEP_INTERVAL_MS = 60_000;

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

function stdioServerPort(proc: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!proc.stdout) {
      reject(new Error("opencode serve --stdio has no stdout"));
      return;
    }
    const lines = createInterface({ input: proc.stdout });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error(`opencode serve did not report its address within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
    lines.on("line", (line) => {
      const port = parseStdioServerUrl(line);
      if (port === null) return;
      clearTimeout(timer);
      lines.close();
      proc.stdout?.resume();
      resolve(port);
    });
  });
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
  /** Extra spawn env for a CLI protocol, kept out of the pool key (v2 plugin injection). */
  spawnEnv?: (protocol: OpencodeProtocolVersion) => Promise<Record<string, string>>;
  /**
   * When set, every working directory shares a single server spawned at this
   * root. Callers must scope each request to its own directory (the opencode
   * server routes sessions by directory). Session-unique env vars are excluded
   * from the pool key and the spawn env so unrelated sessions keep sharing.
   */
  sharedRoot?: string;
}

export class OpencodeServerPool {
  private servers = new Map<string, PoolEntry>();
  private draining = 0;
  private pending = new Map<string, { envKey: string; promise: Promise<ServerHandle> }>();
  private inFlight = new Map<string, number>();
  private disposed = false;
  private idleTimeoutMs: number;
  private maxServers: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private getBinary: () => string,
    private deps?: OpencodeServerPoolDeps
  ) {
    this.idleTimeoutMs = deps?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxServers = deps?.maxServers ?? DEFAULT_MAX_SERVERS;
    const cadence = Math.max(1000, Math.min(this.idleTimeoutMs, SWEEP_INTERVAL_MS));
    this.sweepTimer = setInterval(() => {
      if (!this.disposed) this.sweep();
    }, cadence);
    this.sweepTimer.unref?.();
  }

  beginTurn(rootPath: string): void {
    rootPath = this.keyOf(rootPath);
    this.inFlight.set(rootPath, (this.inFlight.get(rootPath) ?? 0) + 1);
    if (this.servers.has(rootPath)) this.servers.get(rootPath)!.lastUsed = Date.now();
  }

  invalidate(rootPath: string): void {
    rootPath = this.keyOf(rootPath);
    if ((this.inFlight.get(rootPath) ?? 0) > 0) return;
    this.stop(rootPath);
  }

  async probe(rootPath: string): Promise<boolean> {
    rootPath = this.keyOf(rootPath);
    const entry = this.servers.get(rootPath);
    if (!entry) return false;
    if (entry.proc.exitCode != null || entry.proc.killed) return false;
    try {
      await identifyServer(entry.handle.port, entry.handle.authHeader);
      return true;
    } catch {
      return false;
    }
  }

  private trackProcess(rootPath: string, proc: ChildProcess): void {
    rootPath = this.keyOf(rootPath);
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

  async lease(rootPath: string): Promise<{ handle: ServerHandle; release: () => void }> {
    const handle = await this.ensure(rootPath);
    this.beginTurn(rootPath);
    let released = false;
    return {
      handle,
      release: () => {
        if (released) return;
        released = true;
        this.endTurn(rootPath);
      }
    };
  }

  endTurn(rootPath: string): void {
    rootPath = this.keyOf(rootPath);
    const count = (this.inFlight.get(rootPath) ?? 0) - 1;
    if (count <= 0) this.inFlight.delete(rootPath);
    else this.inFlight.set(rootPath, count);
    if (this.servers.has(rootPath)) this.servers.get(rootPath)!.lastUsed = Date.now();
  }

  private async ensureProcess(rootPath: string, binary: string, env: Record<string, string> | undefined): Promise<{ proc: ChildProcess; handle: ServerHandle }> {
    const start = Date.now();
    if (this.deps?.sharedRoot) mkdirSync(rootPath, { recursive: true });
    const cliProtocol = await opencodeCliProtocol(binary);
    const protocolEnv = await this.protocolSpawnEnv(rootPath, cliProtocol);
    const stdio = cliProtocol === "v2";
    const fixedPort = stdio ? 0 : await findFreePort();
    const password = newServerPassword();
    const authHeader = basicAuthHeader(password);
    const args = stdio
      ? ["serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"]
      : ["serve", "--port", String(fixedPort), "--hostname", "127.0.0.1"];
    const proc = spawnCli(binary, args, {
      cwd: rootPath,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: withOwnerPid({ ...process.env, ...env, ...protocolEnv, ...serverAuthEnv(password, cliProtocol) })
    });
    proc.stderr?.resume();
    if (!stdio) proc.stdout?.resume();
    let handle: ServerHandle = { port: fixedPort, authHeader, password };
    try {
      const processFailed = new Promise<never>((_, reject) => {
        proc.once("error", (err) => reject(new Error(`failed to spawn ${binary}: ${err.message}`)));
        proc.once("exit", (code) => reject(new Error(`${binary} serve exited before startup (code ${code ?? "unknown"})`)));
      });
      const startup = (async () => {
        const port = stdio ? await stdioServerPort(proc, STARTUP_TIMEOUT_MS) : fixedPort;
        const identity = await waitForServerIdentity(port, authHeader, STARTUP_TIMEOUT_MS - (Date.now() - start));
        handle = { ...handle, port, protocol: identity.protocol, version: identity.version };
      })();
      await Promise.race([startup, processFailed]);
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
      extra: {
        serverPort: handle.port,
        protocol: handle.protocol ?? null,
        serverVersion: handle.version ?? null,
        envKeys: env ? Object.keys(env).join(",") : ""
      }
    });
    return { proc, handle };
  }

  private async protocolSpawnEnv(rootPath: string, protocol: OpencodeProtocolVersion): Promise<Record<string, string>> {
    if (!this.deps?.spawnEnv) return {};
    try {
      return await this.deps.spawnEnv(protocol);
    } catch (err) {
      const message = truncateError((err as Error).message);
      console.warn(`opencode ${protocol} extensions unavailable, starting without them: ${message}`);
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.spawnEnv",
        cwd: rootPath,
        ok: false,
        error: message,
        extra: { protocol }
      });
      return {};
    }
  }

  async ensure(rootPath: string, env?: Record<string, string>): Promise<ServerHandle> {
    if (this.disposed) throw new Error("opencode server pool disposed");
    rootPath = this.keyOf(rootPath);
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
    rootPath = this.keyOf(rootPath);
    const entry = this.servers.get(rootPath);
    if (!entry) return;
    this.servers.delete(rootPath);
    this.deps?.onServerGone?.(rootPath, entry.handle.port);
    if (entry.handle.protocol !== "v2") {
      killProcessTree(entry.proc);
      return;
    }
    this.draining += 1;
    void interruptActiveV2Sessions(entry.handle).finally(() => {
      this.draining -= 1;
      killProcessTree(entry.proc);
    });
  }

  ownedProcessCount(): number {
    return this.servers.size + this.pending.size + this.draining;
  }

  dispose(): void {
    this.disposed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const rootPath of [...this.servers.keys()]) this.stop(rootPath);
  }

  private keyOf(rootPath: string): string {
    return this.deps?.sharedRoot ?? rootPath;
  }
}
