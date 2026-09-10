import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AppSettings, CliDriver, HistoryMessage, SessionMeta, ThreadEvent, TurnHandle, TurnRequest } from "@cw-code/contracts";
import { parseOpencodeLine, summarizeRun } from "./opencodeEvents.js";
import { mapOpencodeMessages } from "./opencodeHistory.js";
import { listOpencodeModels, mapEffortToVariant } from "./opencodeModels.js";
import { assertInside } from "../../fs/FileService.js";
import { OpencodeServerPool } from "./opencodeServerPool.js";
import { parseExtraArgs } from "../../settings/settingsUtils.js";
import { previewText, traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

interface ServerSession {
  id: string;
  directory: string;
  title: string;
  time: { created: number; updated: number };
}

export class OpencodeDriver implements CliDriver {
  readonly kind = "opencode" as const;
  private procs = new Map<string, ChildProcess>();
  private pool: OpencodeServerPool;

  constructor(
    private emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings,
    pool?: OpencodeServerPool
  ) {
    this.pool = pool ?? new OpencodeServerPool(() => this.configuredBinary());
  }

  private configuredBinary(): string {
    return this.getSettings().opencodeBinaryPath;
  }

  private extraArgs(): string[] {
    return parseExtraArgs(this.getSettings().opencodeExtraArgs);
  }

  async listSessions(projectRoot: string, projectId = ""): Promise<SessionMeta[]> {
    const start = Date.now();
    const operation = "opencode.listSessions";
    try {
      const { port, authHeader } = await this.pool.ensure(projectRoot);
      const res = await fetch(`http://127.0.0.1:${port}/session`, {
        headers: { Authorization: authHeader }
      });
      if (!res.ok) throw new Error(`opencode session list failed: ${res.status}`);
      const sessions = (await res.json()) as ServerSession[];
      const mapped = sessions
        .filter((s) => s.directory.toLowerCase() === projectRoot.toLowerCase())
        .map((s) => ({
          id: `opencode:${s.id}`,
          projectId,
          driver: "opencode" as const,
          title: s.title || s.id.slice(0, 8),
          resumeCursor: s.id,
          createdAt: s.time.created,
          updatedAt: s.time.updated
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      traceHarnessCall({
        harness: "opencode",
        operation,
        cwd: projectRoot,
        durationMs: Date.now() - start,
        ok: true,
        extra: { count: mapped.length, serverPort: port }
      });
      return mapped;
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation,
        cwd: projectRoot,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  async getHistory(projectRoot: string, resumeCursor: string): Promise<HistoryMessage[]> {
    if (!resumeCursor) return [];
    const start = Date.now();
    const operation = "opencode.getHistory";
    try {
      const { port, authHeader } = await this.pool.ensure(projectRoot);
      const res = await fetch(`http://127.0.0.1:${port}/session/${resumeCursor}/message`, {
        headers: { Authorization: authHeader }
      });
      if (!res.ok) throw new Error(`opencode history failed: ${res.status}`);
      const messages = mapOpencodeMessages((await res.json()) as never[]);
      traceHarnessCall({
        harness: "opencode",
        operation,
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: true,
        extra: { messageCount: messages.length, serverPort: port }
      });
      return messages;
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation,
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  async listModels(cwd: string): Promise<import("@cw-code/contracts").ModelOption[]> {
    return listOpencodeModels(cwd, this.configuredBinary());
  }

  startTurn(request: TurnRequest): TurnHandle {
    const turnId = randomUUID();
    void this.runTurn(turnId, request);
    return { turnId, events: (async function* () {})() };
  }

  private async runTurn(turnId: string, request: TurnRequest): Promise<void> {
    const start = Date.now();
    const binary = this.configuredBinary();
    let serverPort: number | null = null;
    try {
      serverPort = (await this.pool.ensure(request.cwd)).port;
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        binary,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError(`opencode serve failed: ${(err as Error).message}`)
      });
      this.emit({
        type: "turn.error",
        turnId,
        message: `opencode serve failed: ${(err as Error).message}`
      });
      return;
    }
    const baseArgs = [
      "run",
      "--format",
      "json",
      "--attach",
      `http://127.0.0.1:${serverPort}`,
      "--dir",
      request.cwd
    ];
    if (request.resumeCursor) baseArgs.push("--session", request.resumeCursor);
    if (request.model) baseArgs.push("--model", request.model);
    const variant = request.variant ?? (request.effort ? mapEffortToVariant(request.effort) : undefined);
    if (variant) baseArgs.push("--variant", variant);
    if (request.permissionMode === "auto" || request.permissionMode === "bypassPermissions") baseArgs.push("--auto");
    for (const rel of request.attachments ?? []) {
      try {
        assertInside(request.cwd, rel);
        baseArgs.push("-f", rel);
      } catch {
        console.warn(`attachment escapes project root, skipped: ${rel}`);
      }
    }
    baseArgs.push(request.prompt);
    const args = [...this.extraArgs(), ...baseArgs];

    const child = spawn(binary, args, { cwd: request.cwd, windowsHide: true });
    this.procs.set(turnId, child);
    const preview = previewText(request.prompt);
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.startTurn",
      sessionId: request.sessionId,
      turnId,
      cwd: request.cwd,
      binary,
      args,
      model: request.model,
      promptPreview: preview.preview,
      promptLength: preview.length,
      resumeCursor: request.resumeCursor,
      ok: true,
      extra: { serverPort, variant: variant ?? null }
    });
    const acc = {
      text: [] as string[],
      usage: { input: 0, output: 0, reasoning: 0 },
      cost: 0,
      sessionId: ""
    };

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const event of parseOpencodeLine(line, turnId, acc)) this.emit(event);
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        binary,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError(`failed to spawn ${binary}: ${err.message}`)
      });
      this.emit({ type: "turn.error", turnId, message: `failed to spawn ${binary}: ${err.message}` });
    });
    child.on("close", (code) => {
      this.procs.delete(turnId);
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        binary,
        durationMs: Date.now() - start,
        ok: code === 0 || acc.text.length > 0 || Boolean(acc.sessionId),
        exitCode: code,
        stderrPreview: stderr ? truncateError(stderr) : undefined
      });
      if (!child.killed) {
        if (code === 0 || acc.text.length > 0 || acc.sessionId) {
          this.emit(summarizeRun(turnId, request.sessionId, acc));
        } else if (stderr) {
          this.emit({ type: "turn.error", turnId, message: stderr.slice(0, 2000) });
        }
      }
    });
  }

  interrupt(turnId: string): void {
    traceHarnessCall({ harness: "opencode", operation: "opencode.interrupt", turnId, ok: true });
    this.procs.get(turnId)?.kill();
    this.procs.delete(turnId);
  }

  async renameSession(): Promise<void> {}

  async *events(): AsyncIterable<never> {}

  dispose(): void {
    this.pool.dispose();
  }
}
