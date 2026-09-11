import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AppSettings, ApprovalDecision, CliDriver, HistoryMessage, QuestionInfo, QuestionRequest, SessionMeta, ThreadEvent, TurnHandle, TurnRequest } from "@cw-code/contracts";
import { app } from "electron";
import { join } from "node:path";
import { parseOpencodeLine, summarizeRun } from "./opencodeEvents.js";
import {
  questionRequestOf,
  opencodeReplyPayload,
  opencodeSseEvent,
  parseOpencodeQuestionAsked,
  parseOpencodeQuestionReplied,
  type ParsedOpencodeQuestion
} from "./opencodeQuestions.js";
import {
  opencodePermissionReply,
  parseOpencodePermissionAsked,
  parseOpencodePermissionList,
  parseOpencodePermissionReplied,
  permissionApprovalOf,
  type ParsedOpencodePermission
} from "./opencodePermissions.js";
import { AskBridge } from "./askBridge.js";
import { writeAskBridgeTool } from "./askToolFile.js";
import { mapOpencodeMessages } from "./opencodeHistory.js";
import { listOpencodeModels, mapEffortToVariant } from "./opencodeModels.js";
import { assertInside } from "../../fs/FileService.js";
import { OpencodeServerPool } from "./opencodeServerPool.js";
import { killProcessTree } from "../../processTree.js";
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
  private pendingQuestions = new Map<string, ParsedOpencodeQuestion & { turnId: string; questions: QuestionInfo[]; cwd: string }>();
  private pendingApprovals = new Map<string, ParsedOpencodePermission & { turnId: string; cwd: string }>();
  private sessionAllows = new Map<string, Set<string>>();
  private watches = new Map<string, AbortController>();
  private watchInfo = new Map<string, { port: number; authHeader: string; cwd: string }>();
  private sessionIds = new Map<string, string>();
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private pool: OpencodeServerPool;
  private bridge: AskBridge | null = null;
  private bridgeStarting: Promise<void> | null = null;
  private bridgeEndpoint = "";

  constructor(
    private emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings,
    pool?: OpencodeServerPool
  ) {
    this.pool = pool ?? new OpencodeServerPool(() => this.configuredBinary());
  }

  private ensureBridge(): Promise<void> {
    if (this.bridgeStarting) return this.bridgeStarting;
    this.bridgeStarting = (async () => {
      const bridge = new AskBridge((sessionID, request) => this.routeBridgeQuestion(sessionID, request));
      const port = await bridge.start();
      this.bridge = bridge;
      this.bridgeEndpoint = `http://127.0.0.1:${port}/ask`;
      const dir = join(app.getPath("userData"), "cw-opencode");
      try {
        await writeAskBridgeTool(dir, this.bridgeEndpoint);
      } catch (err) {
        traceHarnessCall({
          harness: "opencode",
          operation: "askBridge.toolFile",
          ok: false,
          error: truncateError((err as Error).message)
        });
      }
    })();
    return this.bridgeStarting;
  }

  private async bridgeUrl(): Promise<string> {
    await this.ensureBridge();
    if (!this.bridgeEndpoint) throw new Error("opencode ask bridge failed to start");
    return this.bridgeEndpoint;
  }

  private routeBridgeQuestion(sessionID: string, request: QuestionRequest): void {
    let turnId = "";
    for (const [candidateTurnId, candidateSession] of this.sessionIds) {
      if (candidateSession === sessionID) {
        turnId = candidateTurnId;
        break;
      }
    }
    if (!turnId) {
      traceHarnessCall({
        harness: "opencode",
        operation: "askBridge.unrouted",
        resumeCursor: request.requestId,
        ok: false,
        error: `bridged question for unknown opencode session ${sessionID}`
      });
      this.bridge?.abandon(request.requestId);
      return;
    }
    this.pendingQuestions.set(request.requestId, {
      requestId: request.requestId,
      turnId,
      sessionID,
      questions: request.questions,
      cwd: ""
    });
    this.emit({ type: "question.request", turnId, request });
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
          status: "idle" as const,
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

  private async createSession(port: number, authHeader: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({})
    });
    if (!res.ok) throw new Error(`opencode session create failed: ${res.status}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("opencode session create returned no id");
    return data.id;
  }

  private watchQuestions(turnId: string, port: number, authHeader: string): void {
    void (async () => {
      const controller = new AbortController();
      this.watches.set(turnId, controller);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/event`, {
          headers: { Authorization: authHeader, Accept: "text/event-stream" },
          signal: controller.signal
        });
        if (!res.ok || !res.body) {
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.questions.watch",
            turnId,
            ok: false,
            error: `event stream failed: ${res.status}`
          });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            this.handleSseLine(turnId, line);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.questions.watch",
            turnId,
            ok: false,
            error: truncateError((err as Error).message)
          });
        }
      }
    })();
  }

  private handleSseLine(turnId: string, line: string): void {
    const event = opencodeSseEvent(line);
    if (event === null || typeof event !== "object" || Array.isArray(event)) return;
    const envelope = event as { type?: string };
    if (envelope.type === "question.asked") {
      const parsed = parseOpencodeQuestionAsked(event);
      if (!parsed) return;
      const known = this.sessionIds.get(turnId);
      if (!known || parsed.sessionID !== known) return;
      this.pendingQuestions.set(parsed.requestId, { ...parsed, turnId, questions: parsed.questions, cwd: this.watchInfo.get(turnId)?.cwd ?? "" });
      this.emit({ type: "question.request", turnId, request: questionRequestOf(parsed, turnId) });
      return;
    }
    if (envelope.type === "question.replied" || envelope.type === "question.rejected") {
      const parsed = parseOpencodeQuestionReplied(event);
      const entry = parsed ? this.pendingQuestions.get(parsed.requestID) : undefined;
      if (!parsed || !entry) return;
      this.pendingQuestions.delete(parsed.requestID);
      this.emit({ type: "question.resolved", turnId, requestId: parsed.requestID, answers: {} });
      return;
    }
    if (envelope.type === "permission.asked" || envelope.type === "permission.v2.asked") {
      const parsed = parseOpencodePermissionAsked(event);
      if (!parsed) {
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.permissions.parse",
          turnId,
          ok: false,
          error: truncateError("unparseable permission ask payload, approval not surfaced")
        });
        return;
      }
      const known = this.sessionIds.get(turnId);
      if (!known || parsed.sessionID !== known) return;
      if (this.pendingApprovals.has(parsed.requestId)) return;
      const info = this.watchInfo.get(turnId);
      if (info && this.isSessionAllowed(parsed)) {
        void this.replyPermission(info, parsed.sessionID, parsed.requestId, "once").catch((err) => {
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.permissions.autoReply",
            turnId,
            resumeCursor: parsed.requestId,
            ok: false,
            error: truncateError((err as Error).message)
          });
        });
        return;
      }
      const cwd = info?.cwd ?? "";
      this.pendingApprovals.set(parsed.requestId, { ...parsed, turnId, cwd });
      this.emit(permissionApprovalOf(parsed, turnId, cwd));
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.permissions.asked",
        turnId,
        resumeCursor: parsed.requestId,
        ok: true,
        extra: { permission: parsed.permission, patternCount: parsed.patterns.length }
      });
      return;
    }
    if (envelope.type === "permission.replied" || envelope.type === "permission.v2.replied" || envelope.type === "permission.updated") {
      const parsed = parseOpencodePermissionReplied(event);
      const entry = parsed ? this.pendingApprovals.get(parsed.requestID) : undefined;
      if (!parsed || !entry) return;
      this.pendingApprovals.delete(parsed.requestID);
      this.emit({ type: "approval.resolved", turnId: entry.turnId, requestId: parsed.requestID });
    }
  }

  private async runTurn(turnId: string, request: TurnRequest): Promise<void> {
    const start = Date.now();
    const binary = this.configuredBinary();
    let serverPort: number | null = null;
    let authHeader = "";
    let bridgeEnv: Record<string, string> | undefined;
    try {
      let handle = await this.pool.ensure(request.cwd);
      serverPort = handle.port;
      authHeader = handle.authHeader;
      if (request.resumeCursor) {
        const native = await this.nativeQuestionAvailable(request.resumeCursor, serverPort, authHeader);
        if (!native) {
          const dir = join(app.getPath("userData"), "cw-opencode");
          await writeAskBridgeTool(dir, await this.bridgeUrl());
          bridgeEnv = { OPENCODE_CONFIG_DIR: dir };
          handle = await this.pool.ensure(request.cwd, bridgeEnv);
          serverPort = handle.port;
          authHeader = handle.authHeader;
        }
      }
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
    if (!request.resumeCursor) {
      try {
        const created = await this.createSession(serverPort, authHeader);
        this.sessionIds.set(turnId, created);
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
          error: truncateError(`opencode session create failed: ${(err as Error).message}`)
        });
        this.emit({
          type: "turn.error",
          turnId,
          message: `opencode session create failed: ${(err as Error).message}`
        });
        return;
      }
    }
    const sessionId = this.sessionIds.get(turnId) ?? "";
    if (sessionId) baseArgs.push("--session", sessionId);
    if (request.permissionMode === "auto" || request.permissionMode === "bypassPermissions") baseArgs.push("--auto");
    if (request.model) baseArgs.push("--model", request.model);
    const variant = request.variant ?? (request.effort ? mapEffortToVariant(request.effort) : undefined);
    if (variant) baseArgs.push("--variant", variant);
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

    const child = spawn(binary, args, {
      cwd: request.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_ENABLE_QUESTION_TOOL: "true",
        ...(bridgeEnv ? { OPENCODE_CONFIG_DIR: bridgeEnv["OPENCODE_CONFIG_DIR"] } : {})
      }
    });
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
    if (request.resumeCursor) this.sessionIds.set(turnId, request.resumeCursor);
    this.watchInfo.set(turnId, { port: serverPort, authHeader, cwd: request.cwd });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const event of parseOpencodeLine(line, turnId, acc)) this.emit(event);
      if (acc.sessionId && this.sessionIds.get(turnId) !== acc.sessionId) {
        this.sessionIds.set(turnId, acc.sessionId);
      }
    });
    this.watchQuestions(turnId, serverPort, authHeader);

    const pollTimer = setInterval(() => {
      void this.pollSessionPermissions(turnId);
    }, 2000);
    pollTimer.unref?.();
    this.pollTimers.set(turnId, pollTimer);

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
      this.watches.get(turnId)?.abort();
      this.watches.delete(turnId);
      this.watchInfo.delete(turnId);
      this.sessionIds.delete(turnId);
      this.resolvePendingFor(turnId, null);
      this.resolveApprovalsFor(turnId);
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
    killProcessTree(this.procs.get(turnId));
    this.procs.delete(turnId);
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.pendingApprovals.get(requestId);
    if (!entry) return;
    const reply = opencodePermissionReply(decision);
    if (decision === "acceptForSession") {
      let allowed = this.sessionAllows.get(entry.sessionID);
      if (!allowed) {
        allowed = new Set();
        this.sessionAllows.set(entry.sessionID, allowed);
      }
      allowed.add(this.sessionAllowKey(entry));
    }
    const outcome = await this.replyPermission(this.watchInfo.get(entry.turnId), entry.sessionID, requestId, reply);
    this.pendingApprovals.delete(requestId);
    this.emit({ type: "approval.resolved", turnId: entry.turnId, requestId });
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.respondToApproval",
      turnId: entry.turnId,
      resumeCursor: requestId,
      ok: outcome === "replied",
      ...(outcome === "missing" ? { error: "permission already answered, resolved locally" } : {}),
      extra: { decision, reply, permission: entry.permission }
    });
  }

  async respondToQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    if (requestId.startsWith("bridge:")) {
      if (!this.bridge) return;
      const entry = this.pendingQuestions.get(requestId);
      if (!entry) {
        this.bridge.resolve(requestId, answers);
        return;
      }
      if (this.bridge.resolve(requestId, answers)) {
        this.pendingQuestions.delete(requestId);
        this.emit({ type: "question.resolved", turnId: entry.turnId, requestId, answers });
      }
      return;
    }
    const entry = this.pendingQuestions.get(requestId);
    if (!entry) return;
    const info = this.watchInfo.get(entry.turnId);
    if (!info) throw new Error("opencode question reply has no live server");
    const payload = JSON.stringify(opencodeReplyPayload(entry.questions, answers));
    const headers = { "Content-Type": "application/json", Authorization: info.authHeader };
    for (const base of [`/session/${entry.sessionID}/question/${requestId}/reply`, `/api/session/${entry.sessionID}/question/${requestId}/reply`]) {
      const res = await fetch(`http://127.0.0.1:${info.port}${base}`, { method: "POST", headers, body: payload });
      if (res.ok) {
        this.pendingQuestions.delete(requestId);
        this.emit({ type: "question.resolved", turnId: entry.turnId, requestId, answers });
        return;
      }
      if (res.status >= 500) throw new Error(`opencode question reply failed: ${res.status}`);
    }
    throw new Error("opencode question reply failed: no accepted route");
  }

  private sessionAllowKey(parsed: Pick<ParsedOpencodePermission, "permission" | "patterns">): string {
    return `${parsed.permission}\n${[...parsed.patterns].sort().join("\n")}`;
  }

  private isSessionAllowed(parsed: ParsedOpencodePermission): boolean {
    return this.sessionAllows.get(parsed.sessionID)?.has(this.sessionAllowKey(parsed)) ?? false;
  }

  private async replyPermission(
    info: { port: number; authHeader: string } | undefined,
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject"
  ): Promise<"replied" | "missing"> {
    if (!info) throw new Error("opencode permission reply has no live server");
    const payload = JSON.stringify({ reply });
    const headers = { "Content-Type": "application/json", Authorization: info.authHeader };
    for (const base of [
      `/session/${sessionID}/permission/${requestID}/reply`,
      `/api/session/${sessionID}/permission/${requestID}/reply`
    ]) {
      const res = await fetch(`http://127.0.0.1:${info.port}${base}`, { method: "POST", headers, body: payload });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`opencode permission reply failed: ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) continue;
      return "replied";
    }
    return "missing";
  }

  private async pollSessionPermissions(turnId: string): Promise<void> {
    if (!this.procs.has(turnId)) return;
    const info = this.watchInfo.get(turnId);
    const sessionID = this.sessionIds.get(turnId);
    if (!info || !sessionID) return;
    const headers = { Authorization: info.authHeader };
    const encoded = encodeURIComponent(sessionID);
    for (const path of [`/session/${encoded}/permission`, `/api/session/${encoded}/permission`, `/permission`]) {
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${info.port}${path}`, { headers });
      } catch {
        return;
      }
      if (!res.ok) continue;
      if ((res.headers.get("content-type") ?? "").includes("text/html")) continue;
      let payload: unknown;
      try {
        payload = (await res.json()) as unknown;
      } catch {
        continue;
      }
      for (const parsed of parseOpencodePermissionList(payload)) {
        if (parsed.sessionID !== sessionID) continue;
        if (this.pendingApprovals.has(parsed.requestId)) continue;
        if (this.isSessionAllowed(parsed)) {
          void this.replyPermission(info, parsed.sessionID, parsed.requestId, "once").catch(() => {});
          continue;
        }
        this.pendingApprovals.set(parsed.requestId, { ...parsed, turnId, cwd: info.cwd });
        this.emit(permissionApprovalOf(parsed, turnId, info.cwd));
      }
      return;
    }
  }

  private resolvePendingFor(turnId: string, answers: Record<string, string> | null): void {
    for (const [requestId, entry] of [...this.pendingQuestions]) {
      if (entry.turnId !== turnId) continue;
      this.pendingQuestions.delete(requestId);
      if (requestId.startsWith("bridge:")) this.bridge?.abandon(requestId);
      this.emit({ type: "question.resolved", turnId, requestId, answers });
    }
  }

  private resolveApprovalsFor(turnId: string): void {
    for (const [requestId, entry] of [...this.pendingApprovals]) {
      if (entry.turnId !== turnId) continue;
      this.pendingApprovals.delete(requestId);
      this.emit({ type: "approval.resolved", turnId, requestId });
    }
  }

  private async nativeQuestionAvailable(sessionId: string, port: number, authHeader: string): Promise<boolean> {
    if (!sessionId) return true;
    const res = await fetch(`http://127.0.0.1:${port}/session/${sessionId}`, {
      headers: { Authorization: authHeader }
    });
    if (!res.ok) return false;
    const info = (await res.json()) as { permission?: unknown };
    return !questionInfoDenied(info.permission);
  }

  private disposeBridge(): void {
    this.bridge?.dispose();
    this.bridge = null;
    this.bridgeStarting = null;
    this.bridgeEndpoint = "";
  }

  async renameSession(): Promise<void> {}

  async *events(): AsyncIterable<never> {}

  dispose(): void {
    for (const watch of this.watches.values()) watch.abort();
    this.watches.clear();
    this.disposeBridge();
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    this.pendingApprovals.clear();
    this.sessionAllows.clear();
    this.pool.dispose();
  }
}

function questionInfoDenied(permission: unknown): boolean {
  if (permission === null || permission === undefined) return false;
  if (typeof permission === "string") return permission.trim() === "deny";
  const p = permission as { question?: unknown };
  const question = p?.question;
  return typeof question === "string" ? question.trim() === "deny" : false;
}

