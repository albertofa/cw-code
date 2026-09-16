import { randomUUID } from "node:crypto";
import type { AppSettings, ApprovalDecision, CliDriver, HistoryMessage, PermissionMode, QuestionInfo, QuestionRequest, RetryConnectionRequest, RetryConnectionResult, SessionMeta, ThreadEvent, TurnHandle, TurnRequest } from "@cw-code/contracts";
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
import { opencodeSessionParentId, parseOpencodeSessionParent, parseOpencodeTodosUpdated } from "./opencodeEvents.js";
import { AskBridge } from "./askBridge.js";
import { writeAskBridgeTool } from "./askToolFile.js";
import { diffLiveTools, collectPartTypes, collectTaskParts, type LiveMessage, type LiveSeen } from "./opencodeLivePoll.js";
import {
  buildOpencodeMessageBody,
  isReasoningPartDelta,
  latestAssistantOf,
  mimeForOpencodeAttachment,
  partDeltaOf,
  runEnded,
  splitOpencodeModel,
  summarizeOpencodeTurn,
  turnMessagesOf
} from "./opencodeMessage.js";
import { mapOpencodeMessages } from "./opencodeHistory.js";
import { assertInside } from "../../fs/FileService.js";
import { listOpencodeModels, resolveOpencodeVariant } from "./opencodeModels.js";
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
  private handledPermissions = new Map<string, string>();
  private sessionAllows = new Map<string, Set<string>>();
  private watches = new Map<string, AbortController>();
  private sends = new Map<string, AbortController>();
  private watchInfo = new Map<string, { port: number; authHeader: string; cwd: string; permissionMode?: PermissionMode }>();
  private sessionIds = new Map<string, string>();
  private sessionParents = new Map<string, string>();
  private sessionChildren = new Map<string, string[]>();
  private taskChildren = new Map<string, Map<string, string>>();
  private childToolSeen = new Map<string, Map<string, Map<string, LiveSeen>>>();
  private childPollDone = new Map<string, Set<string>>();
  private turnMeta = new Map<string, { localSessionId: string; beforeIds: Set<string> | null; startedAt: number; pollWarned: boolean; startedPort: number }>();
  private toolSeen = new Map<string, Map<string, LiveSeen>>();
  private partTypes = new Map<string, Map<string, string>>();
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private pool: OpencodeServerPool;
  private disposed = false;
  private bridge: AskBridge | null = null;
  private bridgeStarting: Promise<void> | null = null;
  private bridgeEndpoint = "";
  private bridgeNeed = new Map<string, boolean>();

  constructor(
    private emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings,
    pool?: OpencodeServerPool
  ) {
    this.pool = pool ?? new OpencodeServerPool(() => this.configuredBinary(), {
      onServerGone: (rootPath, port) => this.handleServerGone(rootPath, port)
    });
  }

  private handleServerGone(rootPath: string, port: number): void {
    if (this.disposed) return;
    for (const [turnId, info] of [...this.watchInfo]) {
      if (info.port !== port || info.cwd !== rootPath) continue;
      const serverSessionId = this.sessionIds.get(turnId);
      if (!serverSessionId) continue;
      const localSessionId = this.turnMeta.get(turnId)?.localSessionId ?? "";
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serverGone",
        sessionId: localSessionId,
        turnId,
        cwd: rootPath,
        ok: false,
        extra: { serverPort: port }
      });
      this.emit({
        type: "turn.error",
        turnId,
        message:
          "opencode server exited while the turn was running; the run was lost. Retry the connection or send a message to resume this session.",
        resumeCursor: serverSessionId,
        retryable: true
      });
      this.discardTurn(turnId);
    }
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

  private partTypesFor(turnId: string): Map<string, string> {
    let map = this.partTypes.get(turnId);
    if (!map) {
      map = new Map();
      this.partTypes.set(turnId, map);
    }
    return map;
  }

  private trackTurn(params: {
    turnId: string;
    localSessionId: string;
    serverSessionId: string;
    cwd: string;
    port: number;
    authHeader: string;
    beforeIds: Set<string> | null;
    startedAt: number;
    permissionMode?: PermissionMode;
  }): void {
    this.sessionIds.set(params.turnId, params.serverSessionId);
    this.turnMeta.set(params.turnId, {
      localSessionId: params.localSessionId,
      beforeIds: params.beforeIds,
      startedAt: params.startedAt,
      pollWarned: false,
      startedPort: params.port
    });
    this.watchInfo.set(params.turnId, {
      port: params.port,
      authHeader: params.authHeader,
      cwd: params.cwd,
      permissionMode: params.permissionMode
    });
    this.pool.beginTurn(params.cwd);
    this.toolSeen.set(params.turnId, new Map());
    this.watchQuestions(params.turnId, params.port, params.authHeader);
  }

  private rememberSessionParent(sessionID: string, parentID: string): void {
    this.sessionParents.delete(sessionID);
    if (this.sessionParents.size >= 256) {
      const oldest = this.sessionParents.keys().next();
      if (!oldest.done) this.sessionParents.delete(oldest.value);
    }
    this.sessionParents.set(sessionID, parentID);
    const siblings = this.sessionChildren.get(parentID) ?? [];
    if (!siblings.includes(sessionID)) {
      siblings.push(sessionID);
      if (siblings.length > 32) siblings.shift();
      this.sessionChildren.set(parentID, siblings);
    }
  }

  private ownerTurnOf(sessionID: string): string | undefined {
    let current: string | undefined = sessionID;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      for (const [turnId, known] of this.sessionIds) {
        if (known === current) return turnId;
      }
      current = this.sessionParents.get(current);
    }
    return undefined;
  }

  private async resolveOwnerTurn(
    sessionID: string,
    info: { port: number; authHeader: string }
  ): Promise<string | undefined> {
    let current: string | undefined = sessionID;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      const owner = this.ownerTurnOf(current);
      if (owner) return owner;
      visited.add(current);
      const parentID = await this.fetchSessionParent(info.port, info.authHeader, current);
      if (!parentID) return undefined;
      this.rememberSessionParent(current, parentID);
      current = parentID;
    }
    return undefined;
  }

  private async fetchSessionParent(port: number, authHeader: string, sessionID: string): Promise<string | null> {
    const encoded = encodeURIComponent(sessionID);
    for (const path of [`/session/${encoded}`, `/api/session/${encoded}`]) {
      let res: Response;
      try {
        res = await opencodeFetch(`http://127.0.0.1:${port}${path}`, {
          headers: { Authorization: authHeader },
          timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
          port
        });
      } catch {
        return null;
      }
      if (!res.ok) continue;
      if ((res.headers.get("content-type") ?? "").includes("text/html")) continue;
      try {
        return opencodeSessionParentId((await res.json()) as unknown);
      } catch {
        continue;
      }
    }
    return null;
  }

  private startPolling(turnId: string): void {
    const pollTimer = setInterval(() => {
      void this.pollSessionState(turnId);
    }, 2000);
    pollTimer.unref?.();
    this.pollTimers.set(turnId, pollTimer);
  }

  private async sessionProbe(port: number, authHeader: string, serverSessionId: string): Promise<boolean> {
    const probe = await opencodeFetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(serverSessionId)}`, {
      headers: { Authorization: authHeader },
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
      port
    });
    if (probe.status === 404) return false;
    if (!probe.ok) throw new Error(`opencode session probe failed: ${probe.status}`);
    if ((probe.headers.get("content-type") ?? "").includes("text/html")) return false;
    return true;
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

  private modelVariants = new Map<string, string[] | undefined>();

  async listModels(cwd: string): Promise<import("@cw-code/contracts").ModelOption[]> {
    const models = await listOpencodeModels(cwd, this.configuredBinary());
    for (const model of models) {
      this.modelVariants.set(model.id.toLowerCase(), model.variants);
    }
    return models;
  }

  startTurn(request: TurnRequest): TurnHandle {
    const turnId = randomUUID();
    void this.runTurn(turnId, request);
    return { turnId, events: (async function* () {})() };
  }

  async retryConnection(request: RetryConnectionRequest): Promise<RetryConnectionResult> {
    const { sessionId, cwd, resumeCursor, permissionMode } = request;
    if (!resumeCursor) throw new Error("this session has no opencode history to reconnect to");
    let handle = await this.pool.ensure(cwd);
    if (!(await this.pool.probe(cwd))) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.reconnect",
        sessionId,
        cwd,
        ok: true,
        extra: { deadPort: handle.port, reason: "retry connection" }
      });
      this.pool.invalidate(cwd);
      handle = await this.pool.ensure(cwd);
    }
    const alive = await this.sessionProbe(handle.port, handle.authHeader, resumeCursor);
    if (!alive) throw new Error("opencode session no longer exists on the server");
    const res = await opencodeFetch(`http://127.0.0.1:${handle.port}/session/${encodeURIComponent(resumeCursor)}/message`, {
      headers: { Authorization: handle.authHeader },
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
      port: handle.port
    });
    if (!res.ok) throw new Error(`opencode reconnect history failed: ${res.status}`);
    const raw = (await res.json()) as unknown;
    const history = mapOpencodeMessages(raw as never[]);
    const latest = latestAssistantOf(raw);
    if (!latest || latest.terminal) return { status: "done", history };
    const turnId = `retry:${randomUUID()}`;
    const beforeIds = new Set(turnMessagesOf(raw).map((m) => m.id));
    beforeIds.delete(latest.id);
    this.trackTurn({
      turnId,
      localSessionId: sessionId,
      serverSessionId: resumeCursor,
      cwd,
      port: handle.port,
      authHeader: handle.authHeader,
      beforeIds,
      startedAt: Date.now(),
      permissionMode
    });
    this.startPolling(turnId);
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.turnReattached",
      sessionId,
      turnId,
      cwd,
      ok: true,
      extra: { serverSessionId: resumeCursor, serverPort: handle.port }
    });
    return { status: "running", turnId, history };
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
        if (!controller.signal.aborted && this.watches.get(turnId) === controller) {
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
              if (this.watches.get(turnId) !== controller) return;
              const info = this.watchInfo.get(turnId);
              if (!info) return;
              void this.pool
                .ensure(info.cwd)
                .then((fresh) => {
                  if (!this.sessionIds.has(turnId)) return;
                  if (this.watches.get(turnId) !== controller) return;
                  this.refreshWatchHandle(turnId, fresh, info.cwd);
                  this.watchQuestions(turnId, fresh.port, fresh.authHeader);
                })
                .catch(() => {
                  if (!this.sessionIds.has(turnId)) return;
                  if (this.watches.get(turnId) !== controller) return;
                  this.watchQuestions(turnId, port, authHeader);
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
      if (this.pendingQuestions.has(parsed.requestId)) return;
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
    if (envelope.type === "session.created" || envelope.type === "session.updated") {
      const lineage = parseOpencodeSessionParent(event);
      if (lineage) this.rememberSessionParent(lineage.sessionID, lineage.parentID);
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
      const owner = this.ownerTurnOf(parsed.sessionID);
      if (owner) {
        this.surfacePermission(owner, parsed);
        return;
      }
      const info = this.watchInfo.get(turnId);
      if (!info) return;
      void this.resolveOwnerTurn(parsed.sessionID, info).then((resolved) => {
        if (resolved) this.surfacePermission(resolved, parsed);
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
    if (envelope.type === "todo.updated") {
      const parsed = parseOpencodeTodosUpdated(event);
      if (!parsed) return;
      const known = this.sessionIds.get(turnId);
      if (!known || parsed.sessionID !== known) return;
      this.emit({ type: "todo.updated", turnId, todos: parsed.todos });
      return;
    }
    if (envelope.type === "message.part.updated") {
      const known = this.sessionIds.get(turnId);
      if (!known) return;
      const props = eventProps(event);
      if (props?.["sessionID"] !== known) return;
      const part = props["part"];
      if (part === null || typeof part !== "object" || Array.isArray(part)) return;
      const typed = part as { id?: unknown; type?: unknown };
      if (typeof typed.id !== "string" || !typed.id) return;
      if (typeof typed.type === "string" && typed.type) this.partTypesFor(turnId).set(typed.id, typed.type);
      return;
    }
    if (envelope.type === "message.part.delta") {
      const known = this.sessionIds.get(turnId);
      if (!known) return;
      const delta = partDeltaOf(event, known);
      if (!delta) return;
      const reasoning = isReasoningPartDelta(delta, this.partTypesFor(turnId).get(delta.partID));
      this.emit(
        reasoning
          ? { type: "reasoning.delta", turnId, text: delta.text }
          : { type: "assistant.delta", turnId, text: delta.text }
      );
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
    this.trackTurn({
      turnId,
      localSessionId: request.sessionId,
      serverSessionId,
      cwd: request.cwd,
      port: serverPort,
      authHeader,
      beforeIds: null,
      startedAt: start,
      permissionMode: request.permissionMode
    });
    const preview = previewText(request.prompt);
    const model = splitOpencodeModel(request.model);
    const knownVariants = request.model ? this.modelVariants.get(request.model.toLowerCase()) : undefined;
    const variant = resolveOpencodeVariant(knownVariants, request.effort, request.variant);
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

    this.startPolling(turnId);

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
    const controller = new AbortController();
    this.sends.set(turnId, controller);
    const send = (withFiles: boolean): Promise<Response> =>
      opencodeFetch(`http://127.0.0.1:${serverPort}/session/${encodeURIComponent(serverSessionId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(
          buildOpencodeMessageBody(request.prompt, {
            ...(model ? { model } : {}),
            ...(variant ? { variant } : {}),
            ...(withFiles && files.length > 0 ? { files } : {})
          })
        ),
        // This request stays open until the turn completes and its connection
        // is cut around the 5-minute mark while the server keeps running the
        // turn. The outcome is advisory: completion is driven by the SSE watch
        // and the poll loop, and a dead server surfaces through handleServerGone.
        signal: controller.signal,
        timeoutMs: OPENCODE_NO_TIMEOUT,
        port: serverPort
      });
    void send(files.length > 0)
      .then(async (first) => {
        if (controller.signal.aborted || !this.sessionIds.has(turnId)) return;
        let res = first;
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
          res = await send(false);
        }
        if (controller.signal.aborted || !this.sessionIds.has(turnId)) return;
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
        void this.finishTurn(turnId);
      })
      .catch((err) => {
        if (controller.signal.aborted || !this.sessionIds.has(turnId)) return;
        if (isConnectionError(err)) {
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.send.detached",
            sessionId: request.sessionId,
            turnId,
            cwd: request.cwd,
            ok: false,
            error: truncateError((err as Error).message)
          });
          return;
        }
        this.failTurn(turnId, request.sessionId, serverSessionId, err as Error);
      });
  }

  private failTurn(turnId: string, localSessionId: string, serverSessionId: string, err: Error): void {
    if (!this.sessionIds.has(turnId)) return;
    const meta = this.turnMeta.get(turnId);
    const info = this.watchInfo.get(turnId);
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.startTurn",
      sessionId: localSessionId,
      turnId,
      cwd: info?.cwd,
      durationMs: Date.now() - (meta?.startedAt ?? Date.now()),
      ok: false,
      error: truncateError(err.message)
    });
    this.emit({
      type: "turn.error",
      turnId,
      message: err.message.slice(0, 2000),
      resumeCursor: serverSessionId
    });
    this.discardTurn(turnId);
  }

  private discardTurn(turnId: string): void {
    this.takeTurn(turnId);
    this.resolvePendingFor(turnId, null);
    this.resolveApprovalsFor(turnId);
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
    for (const [requestId, ownerTurnId] of this.handledPermissions) {
      if (ownerTurnId === turnId) this.handledPermissions.delete(requestId);
    }
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
    const send = this.sends.get(turnId);
    if (send) {
      this.sends.delete(turnId);
      try {
        send.abort();
      } catch {
      }
    }
    this.sessionIds.delete(turnId);
    this.turnMeta.delete(turnId);
    this.watchInfo.delete(turnId);
    const seen = this.toolSeen.get(turnId) ?? new Map<string, LiveSeen>();
    this.toolSeen.delete(turnId);
    this.partTypes.delete(turnId);
    this.taskChildren.delete(turnId);
    this.childToolSeen.delete(turnId);
    this.childPollDone.delete(turnId);
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
      for (const event of diffLiveTools(taken.seen, messages, turnId, taken.beforeIds)) this.emit(event);
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
      isError: false,
      backgroundTasks: 0
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
    this.discardTurn(turnId);
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
    const sid = encodeURIComponent(entry.sessionID);
    const rid = encodeURIComponent(requestId);
    const routes = [`/api/session/${sid}/question/${rid}/reply`, `/question/${rid}/reply`];
    const attempt = async (port: number, authHeader: string): Promise<boolean> => {
      const headers = { "Content-Type": "application/json", Authorization: authHeader };
      for (const base of routes) {
        const res = await opencodeFetch(`http://127.0.0.1:${port}${base}`, {
          method: "POST",
          headers,
          body: payload,
          timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
          port
        });
        if ((res.headers.get("content-type") ?? "").includes("text/html")) continue;
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`opencode question reply failed: ${res.status}`);
        return true;
      }
      return false;
    };
    try {
      if (await attempt(info.port, info.authHeader)) {
        this.pendingQuestions.delete(requestId);
        this.emit({ type: "question.resolved", turnId: entry.turnId, requestId, answers });
        return;
      }
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      const cwd = entry.cwd || info.cwd;
      if (!cwd) throw err;
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.reconnect",
        turnId: entry.turnId,
        cwd,
        ok: true,
        extra: { deadPort: info.port, reason: truncateError((err as Error).message) }
      });
      this.pool.invalidate(cwd);
      const fresh = await this.pool.ensure(cwd);
      this.refreshWatchHandle(entry.turnId, fresh, cwd);
      if (await attempt(fresh.port, fresh.authHeader)) {
        this.pendingQuestions.delete(requestId);
        this.emit({ type: "question.resolved", turnId: entry.turnId, requestId, answers });
        return;
      }
    }
    throw new Error("opencode question reply failed: no accepted route");
  }

  private sessionAllowKey(parsed: Pick<ParsedOpencodePermission, "permission" | "patterns">): string {
    return `${parsed.permission}\n${[...parsed.patterns].sort().join("\n")}`;
  }

  private isSessionAllowed(parsed: ParsedOpencodePermission): boolean {
    return this.sessionAllows.get(parsed.sessionID)?.has(this.sessionAllowKey(parsed)) ?? false;
  }

  private surfacePermission(turnId: string, parsed: ParsedOpencodePermission): void {
    if (
      !this.sessionIds.has(turnId) ||
      this.pendingApprovals.has(parsed.requestId) ||
      this.handledPermissions.has(parsed.requestId)
    ) {
      return;
    }
    this.handledPermissions.set(parsed.requestId, turnId);
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
      this.autoReplyPermission(turnId, parsed, info, "permission mode");
      return;
    }
    if (info && this.isSessionAllowed(parsed)) {
      this.autoReplyPermission(turnId, parsed, info, "session allow");
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
  }

  private autoReplyPermission(
    turnId: string,
    parsed: ParsedOpencodePermission,
    info: { port: number; authHeader: string; cwd: string },
    reason: string
  ): void {
    void this.replyPermission(info, parsed.sessionID, parsed.requestId, "once")
      .then((outcome) => {
        if (outcome === "replied") return;
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.permissions.autoReply",
          turnId,
          resumeCursor: parsed.requestId,
          ok: false,
          error: "no permission reply route accepted, surfacing approval",
          extra: { permission: parsed.permission, reason }
        });
        if (!this.sessionIds.has(turnId) || this.pendingApprovals.has(parsed.requestId)) return;
        this.pendingApprovals.set(parsed.requestId, { ...parsed, turnId, cwd: info.cwd });
        this.emit(permissionApprovalOf(parsed, turnId, info.cwd));
      })
      .catch((err) => {
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.permissions.autoReply",
          turnId,
          resumeCursor: parsed.requestId,
          ok: false,
          error: truncateError((err as Error).message),
          extra: { permission: parsed.permission, reason }
        });
      });
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

  private async pollChildTools(
    turnId: string,
    info: { port: number; authHeader: string },
    rootSessionId: string,
    payload: LiveMessage[]
  ): Promise<void> {
    const tasks = collectTaskParts(payload);
    if (tasks.length === 0) return;
    let assigned = this.taskChildren.get(turnId);
    if (!assigned) {
      assigned = new Map();
      this.taskChildren.set(turnId, assigned);
    }
    const children = this.sessionChildren.get(rootSessionId) ?? [];
    const done = this.childPollDone.get(turnId) ?? new Set<string>();
    this.childPollDone.set(turnId, done);
    for (const task of tasks) {
      let child = assigned.get(task.callId);
      if (!child) {
        const used = new Set(assigned.values());
        child = children.find((id) => !used.has(id));
        if (!child) continue;
        assigned.set(task.callId, child);
      }
      if (done.has(task.callId)) continue;
      let seenByCall = this.childToolSeen.get(turnId);
      if (!seenByCall) {
        seenByCall = new Map();
        this.childToolSeen.set(turnId, seenByCall);
      }
      let seen = seenByCall.get(task.callId);
      if (!seen) {
        seen = new Map();
        seenByCall.set(task.callId, seen);
      }
      const childPayload = await this.loadSessionMessages(info, child);
      if (!childPayload) {
        const meta = this.turnMeta.get(turnId);
        if (meta && !meta.pollWarned) {
          meta.pollWarned = true;
          console.warn(`opencode subagent tool poll failed for session ${child}`);
        }
        continue;
      }
      for (const event of diffLiveTools(seen, childPayload, turnId, null, task.callId)) this.emit(event);
      if (task.status === "completed" || task.status === "error") done.add(task.callId);
    }
  }

  private async loadSessionMessages(
    info: { port: number; authHeader: string },
    sessionID: string
  ): Promise<LiveMessage[] | null> {
    try {
      const res = await opencodeFetch(
        `http://127.0.0.1:${info.port}/session/${encodeURIComponent(sessionID)}/message?limit=50`,
        {
          headers: { Authorization: info.authHeader },
          timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
          port: info.port
        }
      );
      if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) return null;
      return (await res.json()) as LiveMessage[];
    } catch {
      return null;
    }
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
        const payload = (await res.json()) as LiveMessage[];
        const seen = this.toolSeen.get(turnId);
        const partTypes = this.partTypes.get(turnId);
        if (partTypes) collectPartTypes(payload, partTypes);
        const meta = this.turnMeta.get(turnId);
        if (seen) {
          for (const event of diffLiveTools(seen, payload, turnId, meta?.beforeIds ?? null)) this.emit(event);
        }
        await this.pollChildTools(turnId, info, sessionID, payload);
        if (meta?.beforeIds && runEnded(payload, meta.beforeIds)) {
          void this.finishTurn(turnId);
          return;
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
        const owner = await this.resolveOwnerTurn(parsed.sessionID, info);
        if (owner !== turnId) continue;
        this.surfacePermission(turnId, parsed);
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
    this.disposed = true;
    for (const watch of this.watches.values()) watch.abort();
    this.watches.clear();
    for (const send of this.sends.values()) {
      try {
        send.abort();
      } catch {
      }
    }
    this.sends.clear();
    this.disposeBridge();
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    this.pendingApprovals.clear();
    this.handledPermissions.clear();
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

