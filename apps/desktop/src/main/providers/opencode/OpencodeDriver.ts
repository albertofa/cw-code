import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { AccountUsageState, AppSettings, ApprovalDecision, CliDriver, CommandOption, ContextUsage, DriverActivity, HistoryMessage, PermissionMode, PermissionOption, QuestionInfo, QuestionRequest, RetryConnectionRequest, RetryConnectionResult, SessionMeta, ThreadEvent, TurnHandle, TurnModelUsage, TurnRequest } from "@cw-code/contracts";
import { isAbsolute, join } from "node:path";
import { opencodeConfigDir } from "../../paths/appPaths.js";
import {
  questionRequestOf,
  opencodeReplyPayload,
  opencodeSseEvent,
  parseOpencodeQuestionAsked,
  parseOpencodeQuestionReplied,
  type ParsedOpencodeQuestion
} from "./opencodeQuestions.js";
import {
  isEditLikePermission,
  opencodePermissionReply,
  opencodePermissionReplyBody,
  opencodePermissionReplyRoutes,
  parseOpencodePermissionAsked,
  parseOpencodePermissionList,
  parseOpencodePermissionReplied,
  permissionApprovalOf,
  type ParsedOpencodePermission
} from "./opencodePermissions.js";
import { opencodeSessionParentId, parseOpencodeSessionError, parseOpencodeSessionParent, parseOpencodeStatusRetry, parseOpencodeTodosUpdated } from "./opencodeEvents.js";
import { AskBridge } from "./askBridge.js";
import { writeAskBridgeTool } from "./askToolFile.js";
import { diffLiveTools, childModelOf, collectPartTypes, collectTaskParts, type LiveMessage, type LiveSeen } from "./opencodeLivePoll.js";
import {
  buildOpencodeMessageBody,
  isOpencodeCompactionMessage,
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
import {
  buildOpencodeCommandBody,
  lastOpencodeUserMessageId,
  mapOpencodeCommands,
  opencodeBuiltinCommandOf,
  opencodeRevertMessageId,
  type OpencodeBuiltinCommand
} from "./opencodeCommands.js";
import { assertInside } from "../../fs/FileService.js";
import { listOpencodeModels, peekOpencodeModels, resolveOpencodeVariant } from "./opencodeModels.js";
import { fetchOpencodeGoUsage } from "./opencodeAccountUsage.js";
import { opencodeFileArgs } from "./opencodeArgs.js";
import { OpencodeServerPool, type ServerHandle } from "./opencodeServerPool.js";
import {
  OPENCODE_LIST_TIMEOUT_MS,
  OPENCODE_NO_TIMEOUT,
  OPENCODE_REQUEST_TIMEOUT_MS,
  isConnectionError,
  opencodeFetch,
  withDirectoryQuery
} from "./opencodeFetch.js";
import { previewText, traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

type SessionCall = (path: string, init?: { method?: "POST"; body?: unknown; timeoutMs?: number }) => Promise<Response>;

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
  private sessionCwds = new Map<string, string>();
  private taskChildren = new Map<string, Map<string, string>>();
  private childToolSeen = new Map<string, Map<string, Map<string, LiveSeen>>>();
  private childPollDone = new Map<string, Set<string>>();
  private childModels = new Map<string, Map<string, string>>();
  private turnMeta = new Map<
    string,
    {
      localSessionId: string;
      beforeIds: Set<string> | null;
      startedAt: number;
      pollWarned: boolean;
      startedPort: number;
      compactionEmitted?: boolean;
      compactionTrigger?: "manual" | "auto";
    }
  >();
  private toolSeen = new Map<string, Map<string, LiveSeen>>();
  private partTypes = new Map<string, Map<string, string>>();
  private compactionMessageIds = new Map<string, Set<string>>();
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private pool: OpencodeServerPool;
  private disposed = false;
  private bridge: AskBridge | null = null;
  private bridgeStarting: Promise<void> | null = null;
  private bridgeEndpoint = "";
  private bridgeNeed = new Map<string, boolean>();
  private pendingAborts = new Set<Promise<void>>();

  constructor(
    private emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings,
    pool?: OpencodeServerPool,
    opts?: { sharedRoot?: string }
  ) {
    this.pool = pool ?? new OpencodeServerPool(() => this.configuredBinary(), {
      ...(opts?.sharedRoot ? { sharedRoot: opts.sharedRoot } : {}),
      onServerGone: (rootPath, port) => this.handleServerGone(rootPath, port)
    });
  }

  private handleServerGone(_rootPath: string, port: number): void {
    if (this.disposed) return;
    for (const [turnId, info] of [...this.watchInfo]) {
      if (info.port !== port) continue;
      const serverSessionId = this.sessionIds.get(turnId);
      if (!serverSessionId) continue;
      const localSessionId = this.turnMeta.get(turnId)?.localSessionId ?? "";
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serverGone",
        sessionId: localSessionId,
        turnId,
        cwd: info.cwd,
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
      const dir = opencodeConfigDir();
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
    const dir = opencodeConfigDir();
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
        port: handle.port,
        directory: cwd
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
        port: handle.port,
        directory: cwd
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

  private compactionMessagesFor(turnId: string): Set<string> {
    let set = this.compactionMessageIds.get(turnId);
    if (!set) {
      set = new Set();
      this.compactionMessageIds.set(turnId, set);
    }
    return set;
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
    this.sessionCwds.delete(params.localSessionId);
    if (this.sessionCwds.size >= 512) {
      const oldest = this.sessionCwds.keys().next();
      if (!oldest.done) this.sessionCwds.delete(oldest.value);
    }
    this.sessionCwds.set(params.localSessionId, params.cwd);
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
    info: { port: number; authHeader: string; cwd: string }
  ): Promise<string | undefined> {
    let current: string | undefined = sessionID;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      const owner = this.ownerTurnOf(current);
      if (owner) return owner;
      visited.add(current);
      const parentID = await this.fetchSessionParent(info.port, info.authHeader, current, info.cwd);
      if (!parentID) return undefined;
      this.rememberSessionParent(current, parentID);
      current = parentID;
    }
    return undefined;
  }

  private async fetchSessionParent(port: number, authHeader: string, sessionID: string, cwd: string): Promise<string | null> {
    const encoded = encodeURIComponent(sessionID);
    for (const path of [`/session/${encoded}`, `/api/session/${encoded}`]) {
      let res: Response;
      try {
        res = await opencodeFetch(`http://127.0.0.1:${port}${path}`, {
          headers: { Authorization: authHeader },
          timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
          port,
          directory: cwd
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

  private async sessionProbe(port: number, authHeader: string, serverSessionId: string, cwd: string): Promise<boolean> {
    const probe = await opencodeFetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(serverSessionId)}`, {
      headers: { Authorization: authHeader },
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
      port,
      directory: cwd
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
      const res = await this.fetchViaPool(projectRoot, withDirectoryQuery("/session", projectRoot), {}, OPENCODE_LIST_TIMEOUT_MS);
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

  async listCommands(cwd: string): Promise<CommandOption[]> {
    const start = Date.now();
    const operation = "opencode.listCommands";
    try {
      const res = await this.fetchViaPool(cwd, "/command", {}, OPENCODE_LIST_TIMEOUT_MS);
      const commands = mapOpencodeCommands(await opencodeJson<unknown>(res, "opencode command list failed"));
      traceHarnessCall({
        harness: "opencode",
        operation,
        cwd,
        durationMs: Date.now() - start,
        ok: true,
        extra: { count: commands.length }
      });
      return commands;
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`opencode command list unavailable, offering builtins only: ${message}`);
      traceHarnessCall({
        harness: "opencode",
        operation,
        cwd,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError(message)
      });
      return mapOpencodeCommands([]);
    }
  }

  async listPermissionModes(): Promise<PermissionOption[]> {
    return [
      { id: "manual", label: "Ask", description: "Prompt for approval on restricted actions.", native: true },
      { id: "auto", label: "Auto", description: "Auto-approve permissions that are not explicitly denied.", native: true }
    ];
  }

  startTurn(request: TurnRequest): TurnHandle {
    const turnId = randomUUID();
    const builtin = request.command ? opencodeBuiltinCommandOf(request.command.name) : null;
    if (builtin && !request.resumeCursor) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        ok: false,
        error: `/${builtin} needs an existing opencode session`
      });
      throw new Error(`Nothing to ${builtin} yet`);
    }
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
    const alive = await this.sessionProbe(handle.port, handle.authHeader, resumeCursor, cwd);
    if (!alive) throw new Error("opencode session no longer exists on the server");
    const res = await opencodeFetch(`http://127.0.0.1:${handle.port}/session/${encodeURIComponent(resumeCursor)}/message`, {
      headers: { Authorization: handle.authHeader },
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
      port: handle.port,
      directory: cwd
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

  private async createSession(port: number, authHeader: string, cwd: string): Promise<string> {
    const res = await opencodeFetch(withDirectoryQuery(`http://127.0.0.1:${port}/session`, cwd), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({}),
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
      port,
      directory: cwd
    });
    if (!res.ok) throw new Error(`opencode session create failed: ${res.status}`);
    const data = (await res.json()) as { id?: string; directory?: string };
    if (!data.id) throw new Error("opencode session create returned no id");
    if (!data.directory || !sameDirectory(data.directory, cwd)) {
      throw new Error(
        `opencode server ignored the session directory (wanted ${cwd}, got ${data.directory ?? "none"}); update the opencode CLI`
      );
    }
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
          port,
          directory: this.watchInfo.get(turnId)?.cwd
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
    if (envelope.type === "message.updated") {
      const known = this.sessionIds.get(turnId);
      if (!known) return;
      const props = eventProps(event);
      if (props?.["sessionID"] !== known) return;
      const info = props["info"];
      if (info === null || typeof info !== "object" || Array.isArray(info)) return;
      const record = info as Record<string, unknown>;
      const id = record["id"];
      if (typeof id !== "string" || !id) return;
      if (record["summary"] === true || record["mode"] === "compaction") {
        this.compactionMessagesFor(turnId).add(id);
      }
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
      const props = eventProps(event);
      const messageID = typeof props?.["messageID"] === "string" ? props["messageID"] : "";
      if (messageID && this.compactionMessagesFor(turnId).has(messageID)) return;
      const reasoning = isReasoningPartDelta(delta, this.partTypesFor(turnId).get(delta.partID));
      this.emit(
        reasoning
          ? { type: "reasoning.delta", turnId, text: delta.text }
          : { type: "assistant.delta", turnId, text: delta.text }
      );
      return;
    }
    if (envelope.type === "session.status") {
      const retry = parseOpencodeStatusRetry(event);
      if (retry) {
        if (this.ownerTurnOf(retry.sessionID) !== turnId) return;
        this.emit({
          type: "turn.retry",
          turnId,
          attempt: retry.attempt,
          message: retry.message,
          retryAt: retry.retryAt,
          ...(retry.detail ? { detail: retry.detail } : {}),
          ...(retry.link ? { link: retry.link } : {})
        });
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.turnRetry",
          turnId,
          ok: true,
          extra: { attempt: retry.attempt, retryAt: retry.retryAt, message: retry.message }
        });
        return;
      }
    }
    if (envelope.type === "session.error") {
      const parsed = parseOpencodeSessionError(event);
      if (!parsed || parsed.name === "ContextOverflowError") return;
      const known = this.sessionIds.get(turnId);
      if (!known || parsed.sessionID !== known) return;
      const meta = this.turnMeta.get(turnId);
      this.failTurn(turnId, meta?.localSessionId ?? "", known, new Error(parsed.message));
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
        const native = await this.nativeQuestionAvailable(request.resumeCursor, serverPort, authHeader, request.cwd);
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
        serverSessionId = await this.createSession(serverPort, authHeader, request.cwd);
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
            serverSessionId = await this.createSession(serverPort, authHeader, request.cwd);
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
        port: serverPort,
        directory: request.cwd
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

    const controller = new AbortController();
    this.sends.set(turnId, controller);
    const command = request.command;
    const builtin = command ? opencodeBuiltinCommandOf(command.name) : null;
    if (builtin) {
      if ((request.attachments ?? []).length > 0) {
        console.warn(`attachments ignored for /${builtin}`);
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.startTurn.attachments",
          sessionId: request.sessionId,
          turnId,
          cwd: request.cwd,
          ok: false,
          error: `attachments ignored for /${builtin}: ${(request.attachments ?? []).length}`
        });
      }
      void this.runBuiltinCommand(turnId, request.sessionId, builtin, {
        port: serverPort,
        authHeader,
        cwd: request.cwd,
        serverSessionId,
        model,
        signal: controller.signal
      });
      return;
    }
    const files = attachmentFilesOf(request.cwd, request.attachments ?? []);
    const send = (withFiles: boolean): Promise<Response> =>
      opencodeFetch(`http://127.0.0.1:${serverPort}/session/${encodeURIComponent(serverSessionId)}/${command ? "command" : "message"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(
          command
            ? buildOpencodeCommandBody(command, {
                model,
                ...(variant ? { variant } : {}),
                ...(withFiles && files.length > 0 ? { files } : {})
              })
            : buildOpencodeMessageBody(request.prompt, {
                ...(model ? { model } : {}),
                ...(variant ? { variant } : {}),
                ...(withFiles && files.length > 0 ? { files } : {})
              })
        ),
        signal: controller.signal,
        timeoutMs: OPENCODE_NO_TIMEOUT,
        port: serverPort,
        directory: request.cwd
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
        if (!res.ok) {
          throw new Error(
            command
              ? await opencodeFailureText(`opencode command /${command.name} failed`, res)
              : `opencode message send failed: ${res.status}`
          );
        }
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

  private async runBuiltinCommand(
    turnId: string,
    localSessionId: string,
    name: OpencodeBuiltinCommand,
    target: {
      port: number;
      authHeader: string;
      cwd: string;
      serverSessionId: string;
      model: { providerID: string; modelID: string } | null;
      signal: AbortSignal;
    }
  ): Promise<void> {
    const call: SessionCall = (path, init = {}) =>
      opencodeFetch(`http://127.0.0.1:${target.port}/session/${encodeURIComponent(target.serverSessionId)}${path}`, {
        method: init.method ?? "GET",
        headers:
          init.body !== undefined
            ? { "Content-Type": "application/json", Authorization: target.authHeader }
            : { Authorization: target.authHeader },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: target.signal,
        timeoutMs: init.timeoutMs ?? OPENCODE_REQUEST_TIMEOUT_MS,
        port: target.port,
        directory: target.cwd
      });
    const live = (): boolean => !target.signal.aborted && this.sessionIds.has(turnId);
    try {
      if (name === "compact") {
        const pending = this.turnMeta.get(turnId);
        if (pending) pending.compactionTrigger = "manual";
        await this.compactSession(call, target.model);
        if (!live()) return;
        const meta = this.turnMeta.get(turnId);
        if (meta) meta.compactionEmitted = true;
        this.emit({ type: "context.compacted", turnId, compaction: { trigger: "manual" } });
      } else {
        const notice = await this.builtinCommandNotice(name, call);
        if (!live()) return;
        this.emit({ type: "assistant.delta", turnId, text: notice });
      }
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.commandDone",
        sessionId: localSessionId,
        turnId,
        cwd: target.cwd,
        ok: true,
        extra: { command: name, serverSessionId: target.serverSessionId }
      });
      void this.finishTurn(turnId);
    } catch (err) {
      if (!live()) return;
      if (name === "compact" && isConnectionError(err)) {
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.send.detached",
          sessionId: localSessionId,
          turnId,
          cwd: target.cwd,
          ok: false,
          error: truncateError((err as Error).message)
        });
        return;
      }
      this.failTurn(turnId, localSessionId, target.serverSessionId, err as Error);
    }
  }

  private async compactSession(
    call: SessionCall,
    model: { providerID: string; modelID: string } | null
  ): Promise<void> {
    if (!model) throw new Error("Pick a model before compacting");
    const res = await call("/summarize", { method: "POST", body: model, timeoutMs: OPENCODE_NO_TIMEOUT });
    if (!res.ok) throw new Error(await opencodeFailureText("opencode compact failed", res));
  }

  private async builtinCommandNotice(
    name: Exclude<OpencodeBuiltinCommand, "compact">,
    call: SessionCall
  ): Promise<string> {
    const sessionRes = await call("");
    const revertId = opencodeRevertMessageId(await opencodeJson<unknown>(sessionRes, "opencode session lookup failed"));
    if (name === "redo") {
      if (!revertId) throw new Error("Nothing to redo");
      const res = await call("/unrevert", { method: "POST" });
      if (!res.ok) throw new Error(await opencodeFailureText("opencode redo failed", res));
      return "Restored the reverted messages.";
    }
    const messagesRes = await call("/message");
    const messageID = lastOpencodeUserMessageId(
      await opencodeJson<unknown>(messagesRes, "opencode history failed"),
      revertId
    );
    if (!messageID) throw new Error("Nothing to undo");
    const res = await call("/revert", { method: "POST", body: { messageID } });
    if (!res.ok) throw new Error(await opencodeFailureText("opencode undo failed", res));
    return "Reverted the last message and its file changes.";
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
    childModels: Map<string, string>;
    compactionEmitted: boolean;
    compactionTrigger?: "manual" | "auto";
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
    const childModels = this.childModels.get(turnId) ?? new Map<string, string>();
    this.toolSeen.delete(turnId);
    this.partTypes.delete(turnId);
    this.compactionMessageIds.delete(turnId);
    this.taskChildren.delete(turnId);
    this.childToolSeen.delete(turnId);
    this.childPollDone.delete(turnId);
    this.childModels.delete(turnId);
    return {
      localSessionId: meta.localSessionId,
      serverSessionId,
      port: info.port,
      authHeader: info.authHeader,
      cwd: info.cwd,
      beforeIds: meta.beforeIds,
      seen,
      childModels,
      compactionEmitted: meta.compactionEmitted === true,
      ...(meta.compactionTrigger ? { compactionTrigger: meta.compactionTrigger } : {})
    };
  }

  private async finishTurn(turnId: string): Promise<void> {
    const taken = this.takeTurn(turnId);
    if (!taken) return;
    let text = "";
    let usage: TurnModelUsage[] = [];
    let context: ContextUsage | undefined;
    let errorText = "";
    const resultPath = `/session/${encodeURIComponent(taken.serverSessionId)}/message`;
    const loadResult = (port: number, auth: string): Promise<Response> =>
      opencodeFetch(`http://127.0.0.1:${port}${resultPath}`, {
        headers: { Authorization: auth },
        timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS,
        port,
        directory: taken.cwd
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
      for (const event of diffLiveTools(
        taken.seen,
        messages,
        turnId,
        taken.beforeIds,
        undefined,
        (callId) => taken.childModels.get(callId)
      )) {
        this.emit(event);
      }
      const summary = summarizeOpencodeTurn(turnMessagesOf(messages), taken.beforeIds);
      text = summary.text;
      usage = summary.usage;
      errorText = summary.errorText;
      if (summary.compacted && !taken.compactionEmitted) {
        this.emit({
          type: "context.compacted",
          turnId,
          compaction: { trigger: taken.compactionTrigger ?? "auto" }
        });
      }
      if (summary.lastModel && summary.lastContextTokens !== undefined) {
        const cached = peekOpencodeModels(this.configuredBinary());
        const model = cached?.find((m) => m.id.toLowerCase() === summary.lastModel?.toLowerCase());
        if (model?.contextWindow) {
          context = { usedTokens: summary.lastContextTokens, windowTokens: model.contextWindow };
        }
      }
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
      resultText: errorText || text,
      usage,
      ...(context ? { context } : {}),
      numTurns: 1,
      isError: errorText !== "",
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
      const abort = opencodeFetch(`http://127.0.0.1:${info.port}/session/${encodeURIComponent(serverSessionId)}/abort`, {
        method: "POST",
        headers: { Authorization: info.authHeader },
        timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
        port: info.port,
        directory: info.cwd
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
      this.pendingAborts.add(abort);
      void abort.finally(() => this.pendingAborts.delete(abort));
    }
    this.discardTurn(turnId);
  }

  activity(): DriverActivity {
    const busySessionIds = new Set<string>();
    for (const meta of this.turnMeta.values()) {
      if (meta.localSessionId) busySessionIds.add(meta.localSessionId);
    }
    return { busySessionIds: [...busySessionIds], ownedProcesses: this.pool.ownedProcessCount() };
  }

  async shutdown({ timeoutMs }: { timeoutMs: number }): Promise<{ timedOut: boolean }> {
    const running = [...this.turnMeta.keys()];
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.shutdown",
      ok: true,
      extra: { turns: running.length, servers: this.pool.ownedProcessCount() }
    });
    for (const turnId of running) this.interrupt(turnId);
    const aborts = [...this.pendingAborts];
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
      timer.unref?.();
    });
    const outcome = await Promise.race([Promise.allSettled(aborts).then(() => "settled" as const), deadline]);
    clearTimeout(timer);
    if (outcome === "timeout") return { timedOut: true };
    this.dispose();
    return { timedOut: false };
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
          port,
          directory: entry.cwd || info.cwd
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
    if (info && info.permissionMode === "acceptEdits" && isEditLikePermission(parsed.permission)) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.permissions.autoApprove",
        turnId,
        resumeCursor: parsed.requestId,
        ok: true,
        extra: { permission: parsed.permission, reason: "acceptEdits" }
      });
      this.autoReplyPermission(turnId, parsed, info, "acceptEdits");
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
    info: { port: number; authHeader: string; cwd: string } | undefined,
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
        port: info.port,
        directory: info.cwd
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
    info: { port: number; authHeader: string; cwd: string },
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
      const childModel = childModelOf(childPayload);
      if (childModel) {
        let models = this.childModels.get(turnId);
        if (!models) {
          models = new Map();
          this.childModels.set(turnId, models);
        }
        models.set(task.callId, childModel);
      }
      for (const event of diffLiveTools(seen, childPayload, turnId, null, task.callId)) this.emit(event);
      if (task.status === "completed" || task.status === "error") done.add(task.callId);
    }
  }

  private async loadSessionMessages(
    info: { port: number; authHeader: string; cwd: string },
    sessionID: string
  ): Promise<LiveMessage[] | null> {
    try {
      const res = await opencodeFetch(
        `http://127.0.0.1:${info.port}/session/${encodeURIComponent(sessionID)}/message?limit=50`,
        {
          headers: { Authorization: info.authHeader },
          timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
          port: info.port,
          directory: info.cwd
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
        port: info.port,
        directory: info.cwd
      });
      if (res.ok && !((res.headers.get("content-type") ?? "").includes("text/html"))) {
        const payload = (await res.json()) as LiveMessage[];
        const seen = this.toolSeen.get(turnId);
        const partTypes = this.partTypes.get(turnId);
        if (partTypes) collectPartTypes(payload, partTypes);
        const meta = this.turnMeta.get(turnId);
        if (seen) {
          for (const event of diffLiveTools(
            seen,
            payload,
            turnId,
            meta?.beforeIds ?? null,
            undefined,
            (callId) => this.childModels.get(turnId)?.get(callId)
          )) {
            this.emit(event);
          }
        }
        if (meta?.beforeIds && !meta.compactionEmitted && meta.compactionTrigger !== "manual") {
          const fresh = turnMessagesOf(payload).find(
            (m) => !meta.beforeIds?.has(m.id) && isOpencodeCompactionMessage(m)
          );
          if (fresh) {
            meta.compactionEmitted = true;
            this.emit({ type: "context.compacted", turnId, compaction: { trigger: "auto" } });
          }
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
          port: info.port,
          directory: info.cwd
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

  private async nativeQuestionAvailable(sessionId: string, port: number, authHeader: string, cwd: string): Promise<boolean> {
    if (!sessionId) return true;
    const res = await opencodeFetch(`http://127.0.0.1:${port}/session/${sessionId}`, {
      headers: { Authorization: authHeader },
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS,
      port,
      directory: cwd
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

  async getAccountUsage(): Promise<AccountUsageState> {
    return fetchOpencodeGoUsage(this.getSettings().opencodeGoUsage === true, {
      fetchFn: fetch,
      env: process.env,
      home: homedir()
    });
  }

  stopSession(sessionId: string): void {
    const cwd = this.sessionCwds.get(sessionId);
    this.sessionCwds.delete(sessionId);
    if (!cwd) return;
    traceHarnessCall({ harness: "opencode", operation: "opencode.stopSession", sessionId, cwd, ok: true });
    this.pool.invalidate(cwd);
  }

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
    this.pendingQuestions.clear();
    this.pendingApprovals.clear();
    this.handledPermissions.clear();
    this.sessionAllows.clear();
    this.sessionIds.clear();
    this.sessionParents.clear();
    this.sessionChildren.clear();
    this.sessionCwds.clear();
    this.turnMeta.clear();
    this.toolSeen.clear();
    this.partTypes.clear();
    this.compactionMessageIds.clear();
    this.watchInfo.clear();
    this.taskChildren.clear();
    this.childToolSeen.clear();
    this.childPollDone.clear();
    this.childModels.clear();
    this.bridgeNeed.clear();
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

export function sameDirectory(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") return norm(a).toLowerCase() === norm(b).toLowerCase();
  return norm(a) === norm(b);
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

function attachmentFilesOf(cwd: string, attachments: string[]): Array<{ mime: string; url: string }> {
  const files: Array<{ mime: string; url: string }> = [];
  for (const rel of attachments) {
    if (!isAbsolute(rel)) {
      try {
        assertInside(cwd, rel);
      } catch {
        console.warn(`attachment escapes project root, skipped: ${rel}`);
        continue;
      }
    }
    const mime = mimeForOpencodeAttachment(rel);
    if (!mime) {
      console.warn(`attachment type unsupported, skipped: ${rel}`);
      continue;
    }
    files.push({ mime, url: isAbsolute(rel) ? rel : join(cwd, rel) });
  }
  return files;
}

async function opencodeFailureText(label: string, res: Response): Promise<string> {
  let detail = "";
  try {
    detail = (await res.text()).trim();
  } catch {
  }
  return `${label}: ${res.status}${detail ? ` ${detail.slice(0, 1000)}` : ""}`;
}

async function opencodeJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) throw new Error(await opencodeFailureText(label, res));
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error(`${label}: server returned an HTML page instead of JSON`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(`${label}: invalid JSON response (${(err as Error).message})`);
  }
}
