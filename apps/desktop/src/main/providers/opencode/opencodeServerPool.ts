import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

export interface ServerHandle {
  port: number;
  authHeader: string;
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
      const res = await fetch(`http://127.0.0.1:${port}/session`, {
        headers: { Authorization: authHeader }
      });
      if (res.ok) return;
    } catch {
    }
    if (Date.now() - start > timeoutMs) throw new Error(`opencode serve on ${port} did not become healthy`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export class OpencodeServerPool {
  private servers = new Map<string, { binary: string; proc: ChildProcess; handle: ServerHandle }>();

  constructor(private getBinary: () => string) {}

  async ensure(rootPath: string): Promise<ServerHandle> {
    const binary = this.getBinary();
    const existing = this.servers.get(rootPath);
    if (existing?.binary === binary) {
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
    if (existing) this.stop(rootPath);
    const start = Date.now();
    const port = await findFreePort();
    const password = process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
    const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const args = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
    const proc = spawn(binary, args, {
      cwd: rootPath,
      windowsHide: true
    });
    this.servers.set(rootPath, { binary, proc, handle: { port, authHeader } });
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
      this.stop(rootPath);
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
      extra: { serverPort: port }
    });
    return { port, authHeader };
  }

  stop(rootPath: string): void {
    const entry = this.servers.get(rootPath);
    entry?.proc.kill();
    this.servers.delete(rootPath);
  }

  dispose(): void {
    for (const rootPath of [...this.servers.keys()]) this.stop(rootPath);
  }
}
