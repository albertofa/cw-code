import { randomUUID } from "node:crypto";
import type { AppSettings, ApprovalDecision, CliDriver, HistoryMessage, PermissionMode, QuestionInfo, QuestionRequest, SessionMeta, ThreadEvent, TurnHandle, TurnRequest } from "@cw-code/contracts";
import { app } from "electron";
import { join } from "node:path";
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
  opencodePermissionReplyBody,
  opencodePermissionReplyRoutes,
  parseOpencodePermissionAsked,
  parseOpencodePermissionList,
  parseOpencodePermissionReplied,
  permissionApprovalOf,
  type ParsedOpencodePermission
} from "./opencodePermissions.js";
import { AskBridge } from "./askBridge.js";
import { writeAskBridgeTool } from "./askToolFile.js";
import { diffLiveTools, type LiveMessage, type LiveSeen } from "./opencodeLivePoll.js";
import {
  assistantDeltaOf,
  buildOpencodeMessageBody,
  mimeForOpencodeAttachment,
  splitOpencodeModel,
  summarizeOpencodeTurn,
  turnMessagesOf
} from "./opencodeMessage.js";
import { mapOpencodeMessages } from "./opencodeHistory.js";
import { assertInside } from "../../fs/FileService.js";
import { listOpencodeModels, mapEffortToVariant } from "./opencodeModels.js";
import { opencodeFileArgs } from "./opencodeArgs.js";
import { OpencodeServerPool, type ServerHandle } from "./opencodeServerPool.js";
import {
  OPENCODE_LIST_TIMEOUT_MS,
  OPENCODE_NO_TIMEOUT,
  OPENCODE_REQUEST_TIMEOUT_MS,
  isConnectionError,
  opencodeFetch
} from "./opencodeFetch.js";
import { previewText, traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

interface ServerSession {
  id: string;
  directory: string;
  title: string;
  time: { created: number; updated: number };
}

export class OpencodeDriver implements CliDriver {
  readonly kind = "opencode" as const;
  private pendingQuestions = new Map<string, ParsedOpencodeQuestion & { turnId: string; questions: QuestionInfo[]; cwd: string }>();
  private pendingApprovals = new Map<string, ParsedOpencodePermission & { turnId: string; cwd: string }>();
  private sessionAllows = new Map<string, Set<string>>();
  private watches = new Map<string, AbortController>();
  private watchInfo = new Map<string, { port: number; authHeader: string; cwd: string; permissionMode?: PermissionMode }>();
  private sessionIds = new Map<string, string>();
  private turnMeta = new Map<string, { localSessionId: string; beforeIds: Set<string> | null; startedAt: number; pollWarned: boolean }>();
  private toolSeen = new Map<string, Map<string, LiveSeen>>();
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private pool: OpencodeServerPool;
  private bridge: AskBridge | null = null;
  private bridgeStarting: Promise<void> | null = null;
  private bridgeEndpoint = "";
  private bridgeNeed = new Map<string, boolean>();

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

  private async bridgeEnvVars(): Promise<Record<string, string>> {
    const dir = join(app.getPath("userData"), "cw-opencode");
    await writeAskBridgeTool(dir, await this.bridgeUrl());
    return { OPENCODE_CONFIG_DIR: dir };
  }

  private async fetchViaPool(
    cwd: string,
    path: string,
    init: RequestInit = {},
    timeoutMs: number = OPENCODE_REQUEST_TIMEOUT_MS,
    env?: Record<string, string>,
    turnId?: string
  ): Promise<Response> {
    let handle: ServerHandle = await this.pool.ensure(cwd, env);
    const withAuth = (h: ServerHandle): RequestInit => ({
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: h.authHeader }
    });
    try {
      return await opencodeFetch(`http://127.0.0.1:${handle.port}${path}`, {
        ...withAuth(handle),
        timeoutMs,
        port: handle.port
      });
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.reconnect",
        cwd,
        turnId,
        ok: true,
        extra: { deadPort: handle.port, reason: truncateError((err as Error).message) }
      });
      this.pool.invalidate(cwd);
      handle = await this.pool.ensure(cwd, env);
      if (turnId) {
        const info = this.watchInfo.get(turnId);
        if (info) this.watchInfo.set(turnId, { ...info, port: handle.port, authHeader: handle.authHeader, cwd });
      }
      return await opencodeFetch(`http://127.0.0.1:${handle.port}${path}`, {
        ...withAuth(handle),
        timeoutMs,
        port: handle.port
      });
    }
  }

  private refreshWatchHandle(turnId: string, handle: ServerHandle, cwd: string): void {
    const info = this.watchInfo.get(turnId);
    if (info) this.watchInfo.set(turnId, { ...info, port: handle.port, authHeader: handle.authHeader, cwd });
  }

  async listSessions(projectRoot: string, projectId = ""): Promise<SessionMeta[]> {
    const start = Date.now();
    const operation = "opencode.listSessions";
    try {
      const res = await this.fetchViaPool(projectRoot, "/session", {}, OPENCODE_LIST_TIMEOUT_MS);
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
        extra: { count: mapped.length }
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
      const res = await this.fetchViaPool(projectRoot, `/session/${resumeCursor}/message`, {});
      if (!res.ok) throw new Error(`opencode history failed: ${res.status}`);
      const messages = mapOpencodeMessages((await res.json()) as never[]);
      traceHarnessCall({
        harness: "opencode",
        operation,
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: true,
        extra: { messageCount: messages.length }
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
    const res = await opencodeFetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({}),
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
      port
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
        const res = await opencodeFetch(`http://127.0.0.1:${port}/event`, {
          headers: { Authorization: authHeader, Accept: "text/event-stream" },
          signal: controller.signal,
          timeoutMs: 0,
          port
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
          if (this.sessionIds.has(turnId)) {
            setTimeout(() => {
              if (!this.sessionIds.has(turnId)) return;
              const info = this.watchInfo.get(turnId);
              if (!info) return;
              void this.pool
                .ensure(info.cwd)
                .then((fresh) => {
                  if (!this.sessionIds.has(turnId)) return;
                  this.refreshWatchHandle(turnId, fresh, info.cwd);
                  this.watchQuestions(turnId, fresh.port, fresh.authHeader);
                })
                .catch(() => {
                  if (this.sessionIds.has(turnId)) this.watchQuestions(turnId, port, authHeader);
                });
            }, 2000).unref?.();
          }
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
      if (info && (info.permissionMode === "auto" || info.permissionMode === "bypassPermissions")) {
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.permissions.autoApprove",
          turnId,
          resumeCursor: parsed.requestId,
          ok: true,
          extra: { permission: parsed.permission }
        });
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
      return;
    }
    if (envelope.type === "message.part.delta") {
      const known = this.sessionIds.get(turnId);
      if (!known) return;
      const text = assistantDeltaOf(event, known);
      if (text) this.emit({ type: "assistant.delta", turnId, text });
      return;
    }
    if (envelope.type === "session.idle" || envelope.type === "session.status") {
      if (envelope.type === "session.status" && !isIdleStatus(event)) return;
      const sid = sessionIdOf(event);
      if (!sid) return;
      const owner = [...this.sessionIds].find(([, s]) => s === sid)?.[0];
      if (!owner) return;
      void this.finishTurn(owner);
    }
  }

  private async runTurn(turnId: string, request: TurnRequest): Promise<void> {
    const start = Date.now();
    const binary = this.configuredBinary();
    let serverPort: number | null = null;
    let authHeader = "";
    try {
      let env = request.env;
      if (request.resumeCursor && this.bridgeNeed.get(request.cwd) === true) {
        env = { ...(request.env ?? {}), ...(await this.bridgeEnvVars()) };
      }
      let handle = await this.pool.ensure(request.cwd, env);
      serverPort = handle.port;
      authHeader = handle.authHeader;
      if (request.resumeCursor) {
        const native = await this.nativeQuestionAvailable(request.resumeCursor, serverPort, authHeader);
        const needsBridge = !native;
        const previouslyNeeded = this.bridgeNeed.get(request.cwd);
        this.bridgeNeed.set(request.cwd, needsBridge);
        if (needsBridge && previouslyNeeded !== true) {
          handle = await this.pool.ensure(request.cwd, { ...(request.env ?? {}), ...(await this.bridgeEnvVars()) });
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
    let serverSessionId: string;
    if (request.resumeCursor) {
      serverSessionId = request.resumeCursor;
    } else {
      try {
        serverSessionId = await this.createSession(serverPort, authHeader);
      } catch (err) {
        if (isConnectionError(err)) {
          try {
            traceHarnessCall({
              harness: "opencode",
              operation: "opencode.serve.reconnect",
              sessionId: request.sessionId,
              turnId,
              cwd: request.cwd,
              ok: true,
              extra: { deadPort: serverPort, reason: truncateError((err as Error).message) }
            });
            this.pool.invalidate(request.cwd);
            const fresh = await this.pool.ensure(request.cwd, request.env);
            serverPort = fresh.port;
            authHeader = fresh.authHeader;
            serverSessionId = await this.createSession(serverPort, authHeader);
          } catch (retryErr) {
            traceHarnessCall({
              harness: "opencode",
              operation: "opencode.startTurn",
              sessionId: request.sessionId,
              turnId,
              cwd: request.cwd,
              durationMs: Date.now() - start,
              ok: false,
              error: truncateError(`opencode session create failed: ${(retryErr as Error).message}`)
            });
            this.emit({
              type: "turn.error",
              turnId,
              message: `opencode session create failed: ${(retryErr as Error).message}`
            });
            return;
          }
        } else {
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.startTurn",
            sessionId: request.sessionId,
            turnId,
            cwd: request.cwd,
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
    }
    this.sessionIds.set(turnId, serverSessionId);
    this.turnMeta.set(turnId, { localSessionId: request.sessionId, beforeIds: null, startedAt: start, pollWarned: false });
    this.watchInfo.set(turnId, { port: serverPort, authHeader, cwd: request.cwd, permissionMode: request.permissionMode });
    this.pool.beginTurn(request.cwd);
    this.toolSeen.set(turnId, new Map());
    const preview = previewText(request.prompt);
    const model = splitOpencodeModel(request.model);
    const variant = request.variant ?? (request.effort ? mapEffortToVariant(request.effort) : undefined);
    if (request.model && !model) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.startTurn.model",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        ok: false,
        error: `ignoring unparseable model id "${request.model}", using server default`
      });
    }
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.startTurn",
      sessionId: request.sessionId,
      turnId,
      cwd: request.cwd,
      model: request.model,
      promptPreview: preview.preview,
      promptLength: preview.length,
      resumeCursor: request.resumeCursor,
      ok: true,
      extra: { serverPort, variant: variant ?? null, permissionMode: request.permissionMode ?? null }
    });
    this.watchQuestions(turnId, serverPort, authHeader);

    const pollTimer = setInterval(() => {
      void this.pollSessionState(turnId);
    }, 2000);
    pollTimer.unref?.();
    this.pollTimers.set(turnId, pollTimer);

    try {
      const res = await opencodeFetch(`http://127.0.0.1:${serverPort}/session/${encodeURIComponent(serverSessionId)}/message`, {
        headers: { Authorization: authHeader },
        timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS,
        port: serverPort
      });
      if (!res.ok) throw new Error(`opencode baseline history failed: ${res.status}`);
      const seen = new Set<string>();
      for (const m of turnMessagesOf(await res.json())) seen.add(m.id);
      const meta = this.turnMeta.get(turnId);
      if (meta) meta.beforeIds = seen;
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.startTurn.baseline",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        ok: false,
        error: truncateError((err as Error).message)
      });
    }

    const files: Array<{ mime: string; url: string }> = [];
    for (const rel of request.attachments ?? []) {
      try {
        assertInside(request.cwd, rel);
      } catch {
        console.warn(`attachment escapes project root, skipped: ${rel}`);
        continue;
      }
      const mime = mimeForOpencodeAttachment(rel);
      if (!mime) {
        console.warn(`attachment type unsupported, skipped: ${rel}`);
        continue;
      }
      files.push({ mime, url: join(request.cwd, rel) });
    }
    const send = (port: number, auth: string, withFiles: boolean): Promise<Response> =>
      opencodeFetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(serverSessionId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(
          buildOpencodeMessageBody(request.prompt, {
            ...(model ? { model } : {}),
            ...(variant ? { variant } : {}),
            ...(withFiles && files.length > 0 ? { files } : {})
          })
        ),
        // The send stays open until the turn completes, including indefinite
        // waits on permission/question replies. A timeout here kills slow turns,
        // so liveness is left to the SSE watch and poll loop instead.
        timeoutMs: OPENCODE_NO_TIMEOUT,
        port
      });
    try {
      let res: Response;
      try {
        res = await send(serverPort, authHeader, files.length > 0);
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.serve.reconnect",
          sessionId: request.sessionId,
          turnId,
          cwd: request.cwd,
          ok: true,
          extra: { deadPort: serverPort, reason: truncateError((err as Error).message) }
        });
        this.pool.invalidate(request.cwd);
        const fresh = await this.pool.ensure(request.cwd);
        serverPort = fresh.port;
        authHeader = fresh.authHeader;
        this.refreshWatchHandle(turnId, fresh, request.cwd);
        res = await send(serverPort, authHeader, files.length > 0);
      }
      if (!res.ok && res.status === 400 && files.length > 0) {
        console.warn(`attachment message rejected, retrying text-only`);
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.startTurn.attachments",
          sessionId: request.sessionId,
          turnId,
          cwd: request.cwd,
          ok: false,
          error: `file parts rejected: ${res.status}, retried text-only`
        });
        res = await send(serverPort, authHeader, false);
      }
      if (!res.ok) throw new Error(`opencode message send failed: ${res.status}`);
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.messageSent",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        ok: true,
        extra: { serverSessionId }
      });
    } catch (err) {
      if (!this.sessionIds.has(turnId)) return;
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      this.emit({ type: "turn.error", turnId, message: (err as Error).message.slice(0, 2000) });
      this.takeTurn(turnId);
      this.resolvePendingFor(turnId, null);
      this.resolveApprovalsFor(turnId);
    }
  }

  private takeTurn(turnId: string): {
    localSessionId: string;
    serverSessionId: string;
    port: number;
    authHeader: string;
    cwd: string;
    beforeIds: Set<string> | null;
    seen: Map<string, LiveSeen>;
  } | null {
    const meta = this.turnMeta.get(turnId);
    const serverSessionId = this.sessionIds.get(turnId);
    const info = this.watchInfo.get(turnId);
    if (!meta || !serverSessionId || !info) return null;
    this.pool.endTurn(info.cwd);
    const timer = this.pollTimers.get(turnId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(turnId);
    }
    this.watches.get(turnId)?.abort();
    this.watches.delete(turnId);
    this.sessionIds.delete(turnId);
    this.turnMeta.delete(turnId);
    this.watchInfo.delete(turnId);
    const seen = this.toolSeen.get(turnId) ?? new Map<string, LiveSeen>();
    this.toolSeen.delete(turnId);
    return {
      localSessionId: meta.localSessionId,
      serverSessionId,
      port: info.port,
      authHeader: info.authHeader,
      cwd: info.cwd,
      beforeIds: meta.beforeIds,
      seen
    };
  }

  private async finishTurn(turnId: string): Promise<void> {
    const taken = this.takeTurn(turnId);
    if (!taken) return;
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    const resultPath = `/session/${encodeURIComponent(taken.serverSessionId)}/message`;
    const loadResult = (port: number, auth: string): Promise<Response> =>
      opencodeFetch(`http://127.0.0.1:${port}${resultPath}`, {
        headers: { Authorization: auth },
        timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS,
        port
      });
    try {
      let res: Response;
      try {
        res = await loadResult(taken.port, taken.authHeader);
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.serve.reconnect",
          sessionId: taken.localSessionId,
          turnId,
          cwd: taken.cwd,
          ok: true,
          extra: { deadPort: taken.port, reason: truncateError((err as Error).message) }
        });
        this.pool.invalidate(taken.cwd);
        const fresh = await this.pool.ensure(taken.cwd);
        res = await loadResult(fresh.port, fresh.authHeader);
      }
      if (!res.ok) throw new Error(`opencode result history failed: ${res.status}`);
      const messages = (await res.json()) as LiveMessage[];
      for (const event of diffLiveTools(taken.seen, messages, turnId)) this.emit(event);
      const summary = summarizeOpencodeTurn(turnMessagesOf(messages), taken.beforeIds);
      text = summary.text;
      inputTokens = summary.inputTokens;
      outputTokens = summary.outputTokens;
      costUsd = summary.costUsd;
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.turnDone",
        sessionId: taken.localSessionId,
        turnId,
        ok: false,
        error: truncateError((err as Error).message)
      });
    }
    this.resolvePendingFor(turnId, null);
    this.resolveApprovalsFor(turnId);
    this.emit({
      type: "turn.done",
      turnId,
      sessionId: taken.localSessionId,
      resumeCursor: taken.serverSessionId,
      resultText: text,
      inputTokens,
      outputTokens,
      costUsd,
      numTurns: 1,
      isError: false
    });
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.turnDone",
      sessionId: taken.localSessionId,
      turnId,
      ok: true,
      extra: { serverSessionId: taken.serverSessionId }
    });
  }

  interrupt(turnId: string): void {
    traceHarnessCall({ harness: "opencode", operation: "opencode.interrupt", turnId, ok: true });
    const serverSessionId = this.sessionIds.get(turnId);
    const info = this.watchInfo.get(turnId);
    if (serverSessionId && info) {
      void opencodeFetch(`http://127.0.0.1:${info.port}/session/${encodeURIComponent(serverSessionId)}/abort`, {
        method: "POST",
        headers: { Authorization: info.authHeader },
        timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
        port: info.port
      }).then(
        (res) => {
          if (!res.ok) {
            traceHarnessCall({
              harness: "opencode",
              operation: "opencode.interrupt",
              turnId,
              ok: false,
              error: `abort failed: ${res.status}`
            });
          }
        },
        (err) => {
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.interrupt",
            turnId,
            ok: false,
            error: truncateError((err as Error).message)
          });
        }
      );
    }
    this.takeTurn(turnId);
    this.resolvePendingFor(turnId, null);
    this.resolveApprovalsFor(turnId);
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.pendingApprovals.get(requestId);
    if (!entry) return;
    this.pendingApprovals.delete(requestId);
    const reply = opencodePermissionReply(decision);
    if (decision === "acceptForSession") {
      let allowed = this.sessionAllows.get(entry.sessionID);
      if (!allowed) {
        allowed = new Set();
        if (this.sessionAllows.size >= 100) {
          const oldest = this.sessionAllows.keys().next();
          if (!oldest.done) this.sessionAllows.delete(oldest.value);
        }
        this.sessionAllows.set(entry.sessionID, allowed);
      }
      allowed.add(this.sessionAllowKey(entry));
    }
    try {
      const outcome = await this.replyPermission(this.watchInfo.get(entry.turnId), entry.sessionID, requestId, reply);
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
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.respondToApproval",
        turnId: entry.turnId,
        resumeCursor: requestId,
        ok: false,
        error: truncateError((err as Error).message),
        extra: { decision, reply, permission: entry.permission }
      });
      this.pendingApprovals.set(requestId, entry);
      this.emit(permissionApprovalOf(entry, entry.turnId, entry.cwd));
    }
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
      const res = await opencodeFetch(`http://127.0.0.1:${info.port}${base}`, {
        method: "POST",
        headers,
        body: payload,
        timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
        port: info.port
      });
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
    const headers = { "Content-Type": "application/json", Authorization: info.authHeader };
    for (const route of opencodePermissionReplyRoutes(sessionID, requestID)) {
      const res = await opencodeFetch(`http://127.0.0.1:${info.port}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(opencodePermissionReplyBody(route, reply)),
        timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
        port: info.port
      });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`opencode permission reply failed: ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) continue;
      return "replied";
    }
    return "missing";
  }

  private async pollSessionState(turnId: string): Promise<void> {
    if (!this.sessionIds.has(turnId)) return;
    let info = this.watchInfo.get(turnId);
    const sessionID = this.sessionIds.get(turnId);
    if (!info || !sessionID) return;
    const headers = { Authorization: info.authHeader };
    const encoded = encodeURIComponent(sessionID);
    try {
      const res = await opencodeFetch(`http://127.0.0.1:${info.port}/session/${encoded}/message?limit=50`, {
        headers,
        timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
        port: info.port
      });
      if (res.ok && !((res.headers.get("content-type") ?? "").includes("text/html"))) {
        const seen = this.toolSeen.get(turnId);
        if (seen) {
          for (const event of diffLiveTools(seen, (await res.json()) as LiveMessage[], turnId)) this.emit(event);
        }
      }
    } catch (err) {
      if (isConnectionError(err)) {
        try {
          const fresh = await this.pool.ensure(info.cwd);
          this.refreshWatchHandle(turnId, fresh, info.cwd);
          info = this.watchInfo.get(turnId) ?? { ...info, port: fresh.port, authHeader: fresh.authHeader };
        } catch {
          return;
        }
      } else {
        const meta = this.turnMeta.get(turnId);
        if (meta && !meta.pollWarned) {
          meta.pollWarned = true;
          console.warn(`opencode live tool poll failed, retrying: ${(err as Error).message}`);
        }
      }
    }
    for (const path of [`/session/${encoded}/permission`, `/api/session/${encoded}/permission`, `/permission`]) {
      let res: Response;
      try {
        res = await opencodeFetch(`http://127.0.0.1:${info.port}${path}`, {
          headers,
          timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
          port: info.port
        });
      } catch (err) {
        if (isConnectionError(err)) {
          try {
            const fresh = await this.pool.ensure(info.cwd);
            this.refreshWatchHandle(turnId, fresh, info.cwd);
          } catch {
          }
        }
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
        if (this.isSessionAllowed(parsed) || info.permissionMode === "auto" || info.permissionMode === "bypassPermissions") {
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
    const res = await opencodeFetch(`http://127.0.0.1:${port}/session/${sessionId}`, {
      headers: { Authorization: authHeader },
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
      port
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

function eventProps(event: unknown): Record<string, unknown> | null {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const envelope = event as { properties?: unknown; data?: unknown };
  for (const candidate of [envelope.properties, envelope.data]) {
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

function sessionIdOf(event: unknown): string {
  const sid = eventProps(event)?.["sessionID"];
  return typeof sid === "string" ? sid : "";
}

function isIdleStatus(event: unknown): boolean {
  const status = eventProps(event)?.["status"];
  if (typeof status === "string") return status === "idle";
  if (status !== null && typeof status === "object" && !Array.isArray(status)) {
    return (status as Record<string, unknown>)["type"] === "idle";
  }
  return false;
}

