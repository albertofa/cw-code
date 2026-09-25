import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AccountUsageState,
  AppSettings,
  ApprovalDecision,
  ApprovalKind,
  CliDriver,
  CommandInvocation,
  CommandOption,
  HistoryMessage,
  ModelOption,
  PermissionMode,
  PermissionOption,
  SessionMeta,
  SubagentToolsResult,
  ThreadEvent,
  TurnHandle,
  TurnModelUsage,
  TurnRequest
} from "@cw-code/contracts";
import { isFullAccessMode } from "../permissions.js";
import { assertInside } from "../../fs/FileService.js";
import { parseExtraArgs } from "../../settings/settingsUtils.js";
import { previewText, traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";
import { CodexAppServer, type CodexAppServerLike } from "./codexAppServer.js";
import { mapCodexAccountGate, mapCodexUsage } from "./codexAccountUsage.js";
import {
  accumulateCodexTurnUsage,
  approvalResultFor,
  buildCodexSkillInput,
  buildCodexUserInput,
  buildCommandApproval,
  buildFileChangeApproval,
  buildPermissionsApproval,
  buildUserInputQuestionRequest,
  codexCollabTool,
  codexReasoningText,
  codexReviewTarget,
  codexUserInputResult,
  mapCodexEffort,
  mapCodexHistory,
  mapCodexModel,
  mapCodexPlan,
  mapCodexSkillCommands,
  mapCodexSubagentTools,
  mapCodexThread,
  mapPermissionMode,
  listCodexPermissionModes,
  type CodexCommandApprovalParams,
  type CodexFileChangeApprovalParams,
  type CodexModel,
  type CodexPermissionsApprovalParams,
  type CodexPlanUpdate,
  type CodexThread,
  type CodexThreadItem,
  type CodexTokenUsage,
  type CodexTurn,
  type CodexTurnUsageAcc,
  type CodexUserInputParams
} from "./codexProtocol.js";

const CODEX_BUILTIN_COMMANDS: CommandOption[] = [
  { name: "compact", description: "Summarize the thread to free context", dispatch: "native" },
  {
    name: "review",
    description: "Review uncommitted changes, or follow custom instructions",
    argumentHint: "[instructions]",
    dispatch: "native"
  }
];

type CodexCollaborationMode = {
  mode: "plan";
  settings: { model: string; reasoning_effort: string | null; developer_instructions: null };
} | null;

interface ActiveTurn {
  turnId: string;
  localSessionId: string;
  threadId: string;
  requestedModel: string;
  usageAcc: CodexTurnUsageAcc;
  numTurns: number;
  permissionMode?: PermissionMode;
  command?: string;
  hasAssistantText?: boolean;
}

interface PendingApproval {
  serverId: string | number;
  kind: ApprovalKind;
  requestedPermissions?: unknown;
}

interface ThreadStartResponse {
  thread: { id: string };
}

interface TurnStartResponse {
  turn: { id: string };
}

interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
}

interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

interface ThreadReadResponse {
  thread: CodexThread;
}

const THREAD_LIST_PAGE = 50;
const THREAD_LIST_MAX = 200;
const MODEL_LIST_PAGE = 50;
const MODEL_LIST_MAX = 500;

export class CodexCliDriver implements CliDriver {
  readonly kind = "codex" as const;
  private client: CodexAppServerLike;
  private ownsClient: boolean;
  private turns = new Map<string, ActiveTurn>();
  private turnByCodexId = new Map<string, string>();
  private threadLastTotal = new Map<string, number>();
  private approvals = new Map<string, PendingApproval>();
  private pendingQuestions = new Map<string, { serverId: string | number; turnId: string }>();
  private reasoningKinds = new Map<string, Map<string, "summary" | "text">>();
  private defaultModelIdCache: string | null = null;
  private skillPaths = new Map<string, Map<string, string>>();

  constructor(
    private emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings,
    client?: CodexAppServerLike
  ) {
    this.client = client ?? new CodexAppServer({ binary: this.configuredBinary(), args: this.extraArgs() });
    this.ownsClient = client === undefined;
    this.client.onNotification((method, params) => this.handleNotification(method, params));
    this.client.onServerRequest((method, params, id) => this.handleServerRequest(method, params, id));
  }

  private configuredBinary(): string {
    return this.getSettings().codexBinaryPath;
  }

  private extraArgs(): string[] {
    return parseExtraArgs(this.getSettings().codexExtraArgs);
  }

  async listSessions(projectRoot: string, projectId = ""): Promise<SessionMeta[]> {
    const start = Date.now();
    const operation = "codex.listSessions";
    try {
      const sessions: SessionMeta[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page * THREAD_LIST_PAGE < THREAD_LIST_MAX; page++) {
        const res: ThreadListResponse = await this.client.request<ThreadListResponse>("thread/list", {
          cwd: projectRoot,
          limit: THREAD_LIST_PAGE,
          ...(cursor ? { cursor } : {})
        });
        for (const thread of res.data ?? []) {
          if (seen.has(thread.id) || thread.ephemeral) continue;
          seen.add(thread.id);
          sessions.push(mapCodexThread(thread, projectId));
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      traceHarnessCall({
        harness: "codex",
        operation,
        cwd: projectRoot,
        durationMs: Date.now() - start,
        ok: true,
        extra: { count: sessions.length }
      });
      return sessions;
    } catch (err) {
      traceHarnessCall({
        harness: "codex",
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
    const operation = "codex.getHistory";
    try {
      const res = await this.client.request<ThreadReadResponse>("thread/read", {
        threadId: resumeCursor,
        includeTurns: true
      });
      const messages = mapCodexHistory(res.thread);
      traceHarnessCall({
        harness: "codex",
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
        harness: "codex",
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

  async getSubagentTools(_projectRoot: string, _resumeCursor: string, agentId: string): Promise<SubagentToolsResult> {
    if (!agentId) return { items: [] };
    const res = await this.client.request<ThreadReadResponse>("thread/read", {
      threadId: agentId,
      includeTurns: true
    });
    return {
      items: mapCodexSubagentTools(res.thread),
      ...(res.thread.model ? { model: res.thread.model } : {})
    };
  }

  async listModels(_cwd: string): Promise<ModelOption[]> {
    const start = Date.now();
    const operation = "codex.listModels";
    try {
      const models: ModelOption[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page * MODEL_LIST_PAGE < MODEL_LIST_MAX; page++) {
        const res: ModelListResponse = await this.client.request<ModelListResponse>("model/list", {
          limit: MODEL_LIST_PAGE,
          ...(cursor ? { cursor } : {})
        });
        for (const model of res.data ?? []) {
          if (model.isDefault) this.defaultModelIdCache = model.id;
          if (seen.has(model.id) || model.hidden) continue;
          seen.add(model.id);
          models.push(mapCodexModel(model));
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      traceHarnessCall({
        harness: "codex",
        operation,
        durationMs: Date.now() - start,
        ok: true,
        extra: { count: models.length }
      });
      return models;
    } catch (err) {
      traceHarnessCall({
        harness: "codex",
        operation,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  async listCommands(cwd: string): Promise<CommandOption[]> {
    const start = Date.now();
    const operation = "codex.listCommands";
    try {
      const res = await this.client.request<unknown>("skills/list", { cwds: [cwd] });
      const { commands, paths } = mapCodexSkillCommands(res);
      this.skillPaths.set(cwd, paths);
      traceHarnessCall({
        harness: "codex",
        operation,
        cwd,
        durationMs: Date.now() - start,
        ok: true,
        extra: { count: commands.length }
      });
      return [...CODEX_BUILTIN_COMMANDS, ...commands];
    } catch (err) {
      const message = truncateError((err as Error).message);
      console.warn(`codex skills/list failed, falling back to built-in commands: ${message}`);
      traceHarnessCall({
        harness: "codex",
        operation,
        cwd,
        durationMs: Date.now() - start,
        ok: false,
        error: message
      });
      return [...CODEX_BUILTIN_COMMANDS];
    }
  }

  private async resolveSkillPath(cwd: string, name: string): Promise<string | null> {
    const cached = this.skillPaths.get(cwd)?.get(name);
    if (cached) return cached;
    const res = await this.client.request<unknown>("skills/list", { cwds: [cwd], forceReload: true });
    const { paths } = mapCodexSkillCommands(res);
    this.skillPaths.set(cwd, paths);
    return paths.get(name) ?? null;
  }

  startTurn(request: TurnRequest): TurnHandle {
    const turnId = randomUUID();
    if (request.command?.name === "compact" && !request.resumeCursor) {
      traceHarnessCall({
        harness: "codex",
        operation: "codex.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        ok: false,
        error: "Nothing to compact yet"
      });
      throw new Error("Nothing to compact yet");
    }
    const preview = previewText(request.prompt);
    traceHarnessCall({
      harness: "codex",
      operation: "codex.startTurn",
      sessionId: request.sessionId,
      turnId,
      cwd: request.cwd,
      model: request.model,
      promptPreview: preview.preview,
      promptLength: preview.length,
      resumeCursor: request.resumeCursor,
      ok: true
    });
    if (request.env) this.client.setSpawnEnv?.(request.env);
    void this.runTurn(turnId, request);
    return { turnId, events: (async function* () {})() };
  }

  private async runTurn(turnId: string, request: TurnRequest): Promise<void> {
    const start = Date.now();
    const perms = mapPermissionMode(request.permissionMode);
    const effort = mapCodexEffort(request.effort);
    try {
      const threadId = request.resumeCursor
        ? await this.resumeThread(request, perms)
        : await this.startThread(request, perms);
      const active: ActiveTurn = {
        turnId,
        localSessionId: request.sessionId,
        threadId,
        requestedModel: request.model ?? "",
        usageAcc: {
          counts: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          lastTotal: this.threadLastTotal.get(threadId)
        },
        numTurns: 0,
        ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
        ...(request.command ? { command: request.command.name } : {})
      };
      this.turns.set(turnId, active);
      const collaborationMode: CodexCollaborationMode = perms.planMode
        ? {
            mode: "plan" as const,
            settings: {
              model: request.model ?? (await this.defaultModelId()) ?? "",
              reasoning_effort: effort,
              developer_instructions: null
            }
          }
        : null;

      if (request.command) {
        const codexTurnId = await this.startCommandTurn(threadId, request, collaborationMode);
        if (codexTurnId) this.turnByCodexId.set(codexTurnId, turnId);
        traceHarnessCall({
          harness: "codex",
          operation: "codex.turnStarted",
          sessionId: request.sessionId,
          turnId,
          cwd: request.cwd,
          durationMs: Date.now() - start,
          ok: true,
          extra: { threadId, command: request.command.name, ...(codexTurnId ? { codexTurnId } : {}) }
        });
        return;
      }

      const attachments = (request.attachments ?? []).filter((rel) => {
        if (isAbsolute(rel)) {
          if (existsSync(rel)) return true;
          console.warn(`attachment escapes project root, skipped: ${rel}`);
          return false;
        }
        try {
          assertInside(request.cwd, rel);
          return true;
        } catch {
          console.warn(`attachment escapes project root, skipped: ${rel}`);
          return false;
        }
      });
      // turn/start only acks with the turn id; completion arrives via the
      // turn/completed notification, so approval waits never hit the request timeout.
      const res = await this.client.request<TurnStartResponse>("turn/start", {
        threadId,
        input: buildCodexUserInput(request.prompt, request.cwd, attachments),
        ...(request.model ? { model: request.model } : {}),
        ...(effort ? { effort } : {}),
        ...(collaborationMode ? { collaborationMode } : {})
      });
      this.turnByCodexId.set(res.turn.id, turnId);
      traceHarnessCall({
        harness: "codex",
        operation: "codex.turnStarted",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        durationMs: Date.now() - start,
        ok: true,
        extra: { threadId, codexTurnId: res.turn.id, planMode: perms.planMode }
      });
    } catch (err) {
      this.turns.delete(turnId);
      this.reasoningKinds.delete(turnId);
      traceHarnessCall({
        harness: "codex",
        operation: "codex.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      this.emit({ type: "turn.error", turnId, message: truncateError((err as Error).message) });
    }
  }

  private async startCommandTurn(
    threadId: string,
    request: TurnRequest,
    collaborationMode: CodexCollaborationMode
  ): Promise<string | null> {
    const command = request.command as CommandInvocation;
    if (command.name === "compact") {
      await this.client.request<unknown>("thread/compact/start", { threadId });
      return null;
    }
    if (command.name === "review") {
      const res = await this.client.request<{ turn: { id: string }; reviewThreadId: string }>("review/start", {
        threadId,
        target: codexReviewTarget(command.args),
        delivery: "inline"
      });
      return res.turn.id;
    }
    const path = await this.resolveSkillPath(request.cwd, command.name);
    if (!path) throw new Error(`Unknown command: /${command.name}`);
    const effort = mapCodexEffort(request.effort);
    const res = await this.client.request<TurnStartResponse>("turn/start", {
      threadId,
      input: buildCodexSkillInput(command.name, path, command.args),
      ...(request.model ? { model: request.model } : {}),
      ...(effort ? { effort } : {}),
      ...(collaborationMode ? { collaborationMode } : {})
    });
    return res.turn.id;
  }

  private async startThread(
    request: TurnRequest,
    perms: ReturnType<typeof mapPermissionMode>
  ): Promise<string> {
    const res = await this.client.request<ThreadStartResponse>("thread/start", {
      cwd: request.cwd,
      approvalPolicy: perms.approvalPolicy,
      sandbox: perms.sandbox,
      ...(perms.approvalsReviewer ? { approvalsReviewer: perms.approvalsReviewer } : {}),
      ...(request.model ? { model: request.model } : {})
    });
    return res.thread.id;
  }

  private async resumeThread(
    request: TurnRequest,
    perms: ReturnType<typeof mapPermissionMode>
  ): Promise<string> {
    const threadId = request.resumeCursor as string;
    const res = await this.client.request<{ thread: { id: string } }>("thread/resume", {
      threadId,
      cwd: request.cwd,
      approvalPolicy: perms.approvalPolicy,
      sandbox: perms.sandbox,
      ...(perms.approvalsReviewer ? { approvalsReviewer: perms.approvalsReviewer } : {}),
      ...(request.model ? { model: request.model } : {})
    });
    return res.thread.id || threadId;
  }

  private async defaultModelId(): Promise<string | null> {
    if (this.defaultModelIdCache) return this.defaultModelIdCache;
    try {
      const res = await this.client.request<ModelListResponse>("model/list", { limit: MODEL_LIST_PAGE });
      const def = (res.data ?? []).find((m) => m.isDefault) ?? (res.data ?? [])[0];
      this.defaultModelIdCache = def?.id ?? null;
    } catch {
      this.defaultModelIdCache = null;
    }
    return this.defaultModelIdCache;
  }

  interrupt(turnId: string): void {
    const turn = this.turns.get(turnId);
    traceHarnessCall({ harness: "codex", operation: "codex.interrupt", turnId, ok: Boolean(turn) });
    if (!turn) return;
    void this.client
      .request<unknown>("turn/interrupt", { threadId: turn.threadId, turnId: this.codexTurnId(turn) ?? "" })
      .catch((err) => {
        traceHarnessCall({
          harness: "codex",
          operation: "codex.interrupt",
          turnId,
          ok: false,
          error: truncateError((err as Error).message)
        });
      });
  }

  private codexTurnId(turn: ActiveTurn): string | undefined {
    for (const [codexId, driverTurnId] of this.turnByCodexId) {
      if (driverTurnId === turn.turnId) return codexId;
    }
    return undefined;
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const approval = this.approvals.get(requestId);
    if (!approval) return;
    this.approvals.delete(requestId);
    const result = approvalResultFor(approval.kind, decision, approval.requestedPermissions);
    if (decision === "acceptGlobal" && approval.kind !== "permissions") {
      traceHarnessCall({
        harness: "codex",
        operation: "codex.respondToApproval.globalFallback",
        resumeCursor: requestId,
        ok: false,
        error: `app-server has no global approval scope; downgraded acceptGlobal to session scope for ${approval.kind}`,
        extra: { kind: approval.kind, requested: decision, fallback: "session" }
      });
    }
    this.client.respond(approval.serverId, result);
    this.emitApprovalResolved(requestId);
    traceHarnessCall({
      harness: "codex",
      operation: "codex.respondToApproval",
      resumeCursor: requestId,
      ok: true,
      extra: { decision, kind: approval.kind }
    });
  }

  async respondToQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const question = this.pendingQuestions.get(requestId);
    if (!question) return;
    this.pendingQuestions.delete(requestId);
    this.client.respond(question.serverId, codexUserInputResult(answers));
    this.emit({ type: "question.resolved", turnId: question.turnId, requestId, answers });
    traceHarnessCall({
      harness: "codex",
      operation: "codex.respondToQuestion",
      resumeCursor: requestId,
      ok: true,
      extra: { questionCount: Object.keys(answers).length }
    });
  }

  private emitApprovalResolved(requestId: string): void {
    const turnId = requestId.split(":")[0] ?? "";
    this.emit({ type: "approval.resolved", turnId, requestId });
  }

  private turnForCodexId(codexTurnId: string, threadId?: string): ActiveTurn | undefined {
    const driverTurnId = this.turnByCodexId.get(codexTurnId);
    if (driverTurnId) return this.turns.get(driverTurnId);
    if (!threadId) return undefined;
    for (const turn of this.turns.values()) {
      if (turn.threadId === threadId) return turn;
    }
    return undefined;
  }

  private handleNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown> | null;
    if (!p) return;
    switch (method) {
      case "turn/started": {
        const turn = p["turn"] as CodexTurn | undefined;
        const threadId = typeof p["threadId"] === "string" ? p["threadId"] : undefined;
        if (turn?.id && threadId && !this.turnByCodexId.has(turn.id)) {
          const active = this.turnForCodexId(turn.id, threadId);
          if (active) this.turnByCodexId.set(turn.id, active.turnId);
        }
        break;
      }
      case "item/agentMessage/delta": {
        const active = this.turnForCodexId(String(p["turnId"] ?? ""), typeof p["threadId"] === "string" ? p["threadId"] : undefined);
        const delta = typeof p["delta"] === "string" ? p["delta"] : "";
        if (active && delta) {
          active.hasAssistantText = true;
          this.emit({ type: "assistant.delta", turnId: active.turnId, text: delta });
        }
        break;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const active = this.turnForCodexId(String(p["turnId"] ?? ""), typeof p["threadId"] === "string" ? p["threadId"] : undefined);
        const delta = typeof p["delta"] === "string" ? p["delta"] : "";
        if (!active || !delta) break;
        const kind = method === "item/reasoning/summaryTextDelta" ? "summary" : "text";
        const itemId = String(p["itemId"] ?? "");
        let kinds = this.reasoningKinds.get(active.turnId);
        if (!kinds) {
          kinds = new Map();
          this.reasoningKinds.set(active.turnId, kinds);
        }
        const seen = kinds.get(itemId);
        if (seen !== undefined && seen !== kind) break;
        kinds.set(itemId, kind);
        this.emit({ type: "reasoning.delta", turnId: active.turnId, text: delta });
        break;
      }
      case "item/started": {
        const item = p["item"] as CodexThreadItem | undefined;
        const active = this.turnForCodexId(String(p["turnId"] ?? ""), typeof p["threadId"] === "string" ? p["threadId"] : undefined);
        if (!item || !active) break;
        const call = this.toolCallFor(item, active.turnId);
        if (call) this.emit(call);
        break;
      }
      case "item/completed": {
        const item = p["item"] as CodexThreadItem | undefined;
        const active = this.turnForCodexId(String(p["turnId"] ?? ""), typeof p["threadId"] === "string" ? p["threadId"] : undefined);
        if (!item || !active) break;
        if (item.type === "reasoning") {
          const kinds = this.reasoningKinds.get(active.turnId);
          const streamed = typeof item.id === "string" && kinds?.has(item.id) === true;
          const text = streamed ? "" : codexReasoningText(item);
          if (text) this.emit({ type: "reasoning.delta", turnId: active.turnId, text });
          break;
        }
        if (item.type === "contextCompaction") {
          this.emit({
            type: "context.compacted",
            turnId: active.turnId,
            compaction: { trigger: active.command === "compact" ? "manual" : "auto" }
          });
          break;
        }
        if (item.type === "exitedReviewMode") {
          if (item.review && !active.hasAssistantText) {
            active.hasAssistantText = true;
            this.emit({ type: "assistant.delta", turnId: active.turnId, text: item.review });
          }
          break;
        }
        const result = this.toolResultFor(item, active.turnId);
        if (result) this.emit(result);
        break;
      }
      case "turn/plan/updated": {
        const active = this.turnForCodexId(String(p["turnId"] ?? ""), typeof p["threadId"] === "string" ? p["threadId"] : undefined);
        if (!active) break;
        const todos = mapCodexPlan((p as unknown as CodexPlanUpdate)["plan"]);
        if (todos !== null) this.emit({ type: "todo.updated", turnId: active.turnId, todos });
        break;
      }
      case "thread/tokenUsage/updated": {
        const active = this.turnForCodexId(String(p["turnId"] ?? ""), typeof p["threadId"] === "string" ? p["threadId"] : undefined);
        const usage = p["tokenUsage"] as CodexTokenUsage | undefined;
        if (active && usage?.last) {
          const applied = accumulateCodexTurnUsage(active.usageAcc, usage);
          if (active.usageAcc.lastTotal !== undefined) this.threadLastTotal.set(active.threadId, active.usageAcc.lastTotal);
          if (applied) active.numTurns += 1;
        }
        break;
      }
      case "turn/completed": {
        this.completeTurn(p);
        break;
      }
      case "serverRequest/resolved": {
        const serverId = p["requestId"];
        if (serverId === undefined || serverId === null) break;
        const entry = [...this.approvals.entries()].find(([, a]) => String(a.serverId) === String(serverId));
        if (entry) {
          this.approvals.delete(entry[0]);
          this.emit({ type: "approval.resolved", turnId: entry[0].split(":")[0] ?? "", requestId: entry[0] });
          break;
        }
        const questionEntry = [...this.pendingQuestions.entries()].find(([, q]) => String(q.serverId) === String(serverId));
        if (questionEntry) {
          this.pendingQuestions.delete(questionEntry[0]);
          this.emit({ type: "question.resolved", turnId: questionEntry[0].split(":")[0] ?? "", requestId: questionEntry[0], answers: null });
        }
        break;
      }
      default:
        break;
    }
  }

  private completeTurn(params: Record<string, unknown>): void {
    const threadId = typeof params["threadId"] === "string" ? params["threadId"] : "";
    const turn = params["turn"] as CodexTurn | undefined;
    if (!turn) return;
    const active = this.turnForCodexId(turn.id, threadId);
    if (!active) return;
    const driverTurnId = active.turnId;
    this.turns.delete(driverTurnId);
    this.reasoningKinds.delete(driverTurnId);
    for (const codexId of [...this.turnByCodexId].filter(([, id]) => id === driverTurnId).map(([codexId]) => codexId)) {
      this.turnByCodexId.delete(codexId);
    }
    for (const [requestId, question] of [...this.pendingQuestions]) {
      if (question.turnId !== driverTurnId) continue;
      this.pendingQuestions.delete(requestId);
      this.emit({ type: "question.resolved", turnId: driverTurnId, requestId, answers: null });
    }
    if (turn.status === "failed") {
      this.emit({
        type: "turn.error",
        turnId: driverTurnId,
        message: truncateError(turn.error?.message ?? "Codex turn failed")
      });
      return;
    }
    const { counts } = active.usageAcc;
    const hasUsage =
      counts.inputTokens > 0 ||
      counts.cacheReadTokens > 0 ||
      counts.cacheWriteTokens > 0 ||
      counts.outputTokens > 0 ||
      counts.reasoningTokens > 0;
    const model = active.requestedModel || this.defaultModelIdCache || "codex";
    const usage: TurnModelUsage[] = hasUsage ? [{ ...counts, model, costUsd: null }] : [];
    this.emit({
      type: "turn.done",
      turnId: driverTurnId,
      sessionId: active.localSessionId,
      resumeCursor: threadId || active.threadId,
      resultText: "",
      usage,
      ...(active.usageAcc.context ? { context: active.usageAcc.context } : {}),
      numTurns: Math.max(1, active.numTurns),
      isError: false,
      backgroundTasks: 0
    });
  }

  private toolCallFor(item: CodexThreadItem, turnId: string): ThreadEvent | null {
    switch (item.type) {
      case "commandExecution":
        return {
          type: "tool.call",
          turnId,
          toolCallId: item.id ?? "codex-command",
          name: "shell",
          input: { command: item.command ?? "", cwd: item.cwd ?? "" }
        };
      case "fileChange":
        return {
          type: "tool.call",
          turnId,
          toolCallId: item.id ?? "codex-fileChange",
          name: "edit",
          input: { changes: item.changes ?? [] }
        };
      case "mcpToolCall":
        return {
          type: "tool.call",
          turnId,
          toolCallId: item.id ?? "codex-mcp",
          name: item.tool ?? "mcp",
          input: item.arguments ?? null
        };
      case "webSearch":
        return {
          type: "tool.call",
          turnId,
          toolCallId: item.id ?? "codex-webSearch",
          name: "websearch",
          input: item
        };
      case "userInput":
      case "requestUserInput":
        return {
          type: "tool.call",
          turnId,
          toolCallId: item.id ?? "codex-userInput",
          name: "request_user_input",
          input: item.questions ?? null
        };
      default: {
        const collab = codexCollabTool(item);
        if (!collab) return null;
        return {
          type: "tool.call",
          turnId,
          toolCallId: item.id ?? `codex-collab-${collab.tool}`,
          name: `collab:${collab.tool}`,
          input: {
            tool: collab.tool,
            prompt: collab.prompt ?? "",
            receiverThreadIds: collab.receiverThreadIds,
            ...(collab.senderThreadId ? { senderThreadId: collab.senderThreadId } : {}),
            ...(collab.agentsStates !== undefined ? { agentsStates: collab.agentsStates } : {})
          }
        };
      }
    }
  }

  private toolResultFor(item: CodexThreadItem, turnId: string): ThreadEvent | null {
    switch (item.type) {
      case "commandExecution": {
        const output = (item.aggregatedOutput ?? "").trim();
        const isError = (item.exitCode ?? 0) > 0 || item.status === "failed" || item.status === "declined";
        if (!output && !isError) return null;
        return {
          type: "tool.result",
          turnId,
          toolCallId: item.id ?? "codex-command",
          output: output.slice(0, 8000),
          isError
        };
      }
      case "fileChange": {
        const changes = item.changes ?? [];
        const output = changes.map((c) => `${c.kind} ${c.path}`).join("\n");
        const isError = item.status === "failed" || item.status === "declined";
        if (!output && !isError) return null;
        return {
          type: "tool.result",
          turnId,
          toolCallId: item.id ?? "codex-fileChange",
          output: output.slice(0, 8000),
          isError
        };
      }
      case "mcpToolCall": {
        const isError = item.status === "failed";
        if (item.status !== "completed" && item.status !== "failed" && item.status !== "inProgress") return null;
        return {
          type: "tool.result",
          turnId,
          toolCallId: item.id ?? "codex-mcp",
          output: isError ? "MCP tool call failed" : truncateError(JSON.stringify(item.result ?? ""), 8000),
          isError
        };
      }
      default: {
        const collab = codexCollabTool(item);
        if (!collab) return null;
        const isError = item.status === "failed" || item.status === "declined";
        const target = collab.receiverThreadIds[0];
        const output =
          collab.agentsStates !== undefined
            ? truncateError(JSON.stringify(collab.agentsStates), 8000)
            : `${collab.tool}${target ? ` → ${target}` : ""}`;
        return {
          type: "tool.result",
          turnId,
          toolCallId: item.id ?? `codex-collab-${collab.tool}`,
          output,
          isError,
          ...(target ? { agentId: target } : {})
        };
      }
    }
  }

  private handleServerRequest(method: string, params: unknown, id: string | number): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const codexTurnId = typeof p["turnId"] === "string" ? p["turnId"] : "";
    const threadId = typeof p["threadId"] === "string" ? p["threadId"] : "";
    const active = this.turnForCodexId(codexTurnId, threadId);
    if (!active) {
      this.client.respond(
        id,
        method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : method === "item/tool/requestUserInput" || method === "requestUserInput"
            ? { answers: [] }
            : { decision: "decline" }
      );
      traceHarnessCall({
        harness: "codex",
        operation: "codex.approval.unrouted",
        resumeCursor: String(id),
        ok: false,
        error: `approval for unknown turn (${codexTurnId || threadId}) auto-declined`
      });
      return;
    }
    const requestId = `${active.turnId}:${id}`;
    let approval: PendingApproval;
    let requestEvent: ThreadEvent;
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval": {
        const commandParams = p as unknown as CodexCommandApprovalParams;
        approval = { serverId: id, kind: "command" };
        requestEvent = {
          type: "approval.request",
          turnId: active.turnId,
          request: buildCommandApproval(requestId, commandParams)
        };
        break;
      }
      case "item/fileChange/requestApproval":
      case "applyPatchApproval": {
        const fileParams = p as unknown as CodexFileChangeApprovalParams;
        approval = { serverId: id, kind: "fileChange" };
        requestEvent = {
          type: "approval.request",
          turnId: active.turnId,
          request: buildFileChangeApproval(requestId, fileParams)
        };
        break;
      }
      case "item/permissions/requestApproval": {
        const permParams = p as unknown as CodexPermissionsApprovalParams;
        approval = { serverId: id, kind: "permissions", requestedPermissions: permParams.permissions };
        requestEvent = {
          type: "approval.request",
          turnId: active.turnId,
          request: buildPermissionsApproval(requestId, permParams)
        };
        break;
      }
      case "item/tool/requestUserInput":
      case "requestUserInput": {
        const questionRequest = buildUserInputQuestionRequest(requestId, active.turnId, p as unknown as CodexUserInputParams);
        if (!questionRequest) {
          this.client.respond(id, { answers: [] });
          traceHarnessCall({
            harness: "codex",
            operation: "codex.userInput.invalid",
            resumeCursor: String(id),
            ok: false,
            error: "requestUserInput params carried no usable questions"
          });
          return;
        }
        this.pendingQuestions.set(requestId, { serverId: id, turnId: active.turnId });
        this.emit({ type: "question.request", turnId: active.turnId, request: questionRequest });
        return;
      }
      default:
        this.client.respond(id, {});
        traceHarnessCall({
          harness: "codex",
          operation: "codex.approval.unknownMethod",
          resumeCursor: String(id),
          ok: false,
          error: method
        });
        return;
    }
    this.approvals.set(requestId, approval);
    if (isFullAccessMode(active.permissionMode)) {
      this.approvals.delete(requestId);
      this.client.respond(id, approvalResultFor(approval.kind, "accept", approval.requestedPermissions));
      this.emit({ type: "approval.resolved", turnId: active.turnId, requestId });
      traceHarnessCall({
        harness: "codex",
        operation: "codex.permissions.autoApprove",
        resumeCursor: String(id),
        ok: true,
        extra: { kind: approval.kind }
      });
      return;
    }
    this.emit(requestEvent);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    if (!sessionId) return;
    try {
      await this.client.request<unknown>("thread/name/set", { threadId: sessionId, name: title });
    } catch (err) {
      traceHarnessCall({
        harness: "codex",
        operation: "codex.renameSession",
        resumeCursor: sessionId,
        ok: false,
        error: truncateError((err as Error).message)
      });
    }
  }

  async *events(): AsyncIterable<never> {}

  async listPermissionModes(): Promise<PermissionOption[]> {
    return listCodexPermissionModes();
  }

  async getAccountUsage(): Promise<AccountUsageState> {
    try {
      const accountRes = await this.client.request<unknown>("account/read", { refreshToken: false });
      const gate = mapCodexAccountGate(accountRes);
      if (gate) return gate;
      const rateLimitsRes = await this.client.request<unknown>("account/rateLimits/read", {});
      return mapCodexUsage(accountRes, rateLimitsRes, Date.now());
    } catch (err) {
      const message = truncateError((err as Error).message);
      if (/ENOENT|failed to spawn/i.test((err as Error).message ?? "")) {
        return { status: "unavailable", reason: "not-installed", message: "Codex isn't installed. Set its path in Settings → Harnesses → Codex." };
      }
      return { status: "error", message };
    }
  }

  dispose(): void {
    if (this.ownsClient) this.client.dispose();
  }
}
