import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import type { AccountUsageState, AppSettings, ApprovalDecision, CliDriver, CommandOption, ContextUsage, DriverActivity, HistoryMessage, ModelOption, NativeSession, PermissionMode, PermissionOption, QuestionInfo, QuestionRequest, RetryConnectionRequest, RetryConnectionResult, SessionMeta, TaskEndReason, TaskSnapshot, TerminalLaunch, ThreadEvent, TurnHandle, TurnModelUsage, TurnRequest } from "@cw-code/contracts";
import { isAbsolute, join } from "node:path";
import { harnessDir, opencodeConfigDir, opencodePluginDir } from "../../paths/appPaths.js";
import { tokensEqual } from "../../transport/ownerToken.js";
import { questionRequestOf, opencodeSseEvent, type ParsedOpencodeQuestion } from "./opencodeQuestions.js";
import {
  isEditLikePermission,
  opencodePermissionReply,
  permissionApprovalOf,
  type ParsedOpencodePermission
} from "./opencodePermissions.js";
import { AskBridge } from "./askBridge.js";
import { writeAskBridgeTool } from "./askToolFile.js";
import { diffLiveTools, childModelOf, collectPartTypes, collectTaskParts, type LiveMessage, type LiveSeen } from "./opencodeLivePoll.js";
import {
  isOpencodeCompactionMessage,
  isReasoningPartDelta,
  mimeForOpencodeAttachment,
  splitOpencodeModel,
  summarizeOpencodeTurn,
  turnMessagesOf
} from "./opencodeMessage.js";
import { mapOpencodeMessages } from "./opencodeHistory.js";
import { ToolTaskTracker } from "../../tasks/toolTasks.js";
import { mapOpencodeCommands, opencodeBuiltinCommandOf, type OpencodeBuiltinCommand } from "./opencodeCommands.js";
import { assertInside } from "../../fs/FileService.js";
import { listOpencodeModels, loadOpencodeModels, peekOpencodeModels, resolveOpencodeVariant } from "./opencodeModels.js";
import { fetchOpencodeGoUsage } from "./opencodeAccountUsage.js";
import { OpencodeServerPool, opencodeCliProtocol, type ServerHandle } from "./opencodeServerPool.js";
import {
  OPENCODE_LIST_TIMEOUT_MS,
  OPENCODE_REQUEST_TIMEOUT_MS,
  isConnectionError,
  opencodeFetch
} from "./opencodeFetch.js";
import { previewText, traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";
import { todosFromToolCall } from "../todos.js";
import {
  opencodeFailureText,
  type OpencodeAttachment,
  type OpencodeClient,
  type OpencodeEvent,
  type OpencodeEventDecoder,
  type OpencodeMessage,
  type OpencodeProtocol,
  type OpencodeProtocolVersion,
  type OpencodeRequestInit,
  type OpencodeToolUpdate
} from "./opencodeProtocol.js";
import { ActivityNotifier } from "../ActivityNotifier.js";
import { opencodeV1Protocol } from "./v1/opencodeV1Protocol.js";
import { opencodeV2Protocol } from "./v2/opencodeV2Protocol.js";
import { opencodeV2PluginEnv, sweepStaleOpencodeSecretFiles, writeOpencodeSecretFile } from "./v2/opencodeV2Plugin.js";

export { sameDirectory } from "./opencodePaths.js";

interface WatchInfo {
  port: number;
  authHeader: string;
  cwd: string;
  permissionMode?: PermissionMode;
  protocol?: OpencodeProtocolVersion;
}

interface ServerTarget {
  port: number;
  authHeader: string;
  cwd: string;
  protocol?: OpencodeProtocolVersion;
}

const V2_STREAM_RESUBSCRIBE_MS = 1000;
const HANDLED_FORMS_LIMIT = 256;
const UNSUPPORTED_FORM_MESSAGE = "The user cannot answer this form from cw-code. Continue without it.";

/** Tracks when a v2 server delivers this turn's own input, so end events of an earlier run are not taken as ours. */
interface TurnInput {
  delivered: boolean;
  seen: Set<string> | null;
  admitted?: string | "any";
}

function protocolOf(version: OpencodeProtocolVersion | undefined): OpencodeProtocol {
  return version === "v2" ? opencodeV2Protocol : opencodeV1Protocol;
}

function requestInitOf(init: OpencodeRequestInit, authHeader: string): RequestInit {
  const headers: Record<string, string> = { Authorization: authHeader };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.accept) headers["Accept"] = init.accept;
  return {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {})
  };
}

export class OpencodeDriver implements CliDriver {
  readonly kind = "opencode" as const;
  private pendingQuestions = new Map<string, ParsedOpencodeQuestion & { turnId: string; questions: QuestionInfo[]; cwd: string }>();
  private pendingApprovals = new Map<string, ParsedOpencodePermission & { turnId: string; cwd: string }>();
  private handledPermissions = new Map<string, string>();
  private sessionAllows = new Map<string, Set<string>>();
  private watches = new Map<string, AbortController>();
  private sends = new Map<string, AbortController>();
  private watchInfo = new Map<string, WatchInfo>();
  private decoders = new Map<string, OpencodeEventDecoder>();
  private sessionIds = new Map<string, string>();
  private sessionParents = new Map<string, string>();
  private sessionChildren = new Map<string, string[]>();
  private sessionCwds = new Map<string, string>();
  private taskChildren = new Map<string, Map<string, string>>();
  private childToolSeen = new Map<string, Map<string, Map<string, LiveSeen>>>();
  private childPollDone = new Map<string, Set<string>>();
  private childModels = new Map<string, Map<string, string>>();
  private readonly activityNotifier = new ActivityNotifier();
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
      holding?: boolean;
      input: TurnInput;
      agent: boolean;
    }
  >();
  private handledForms = new Set<string>();
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
  private readonly toolTasks = new ToolTaskTracker();
  private readonly emitRaw: (event: ThreadEvent) => void;
  private readonly emit: (event: ThreadEvent) => void;
  private readonly agentSecret = randomBytes(32).toString("base64url");
  private readonly agentMcpUrl: () => string | null;
  private secretFiles = new Set<string>();
  private secretFileOfEnv = new WeakMap<Record<string, string>, string>();
  private staleSecretsSwept: Promise<void> | null = null;

  constructor(
    emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings,
    pool?: OpencodeServerPool,
    opts?: { sharedRoot?: string; agentMcpUrl?: () => string | null }
  ) {
    this.agentMcpUrl = opts?.agentMcpUrl ?? (() => null);
    this.emitRaw = emit;
    this.emit = (event) => this.emitTracked(this.sessionFor(event), event);
    this.pool = pool ?? new OpencodeServerPool(() => this.configuredBinary(), {
      ...(opts?.sharedRoot ? { sharedRoot: opts.sharedRoot } : {}),
      onServerGone: (rootPath, port) => this.handleServerGone(rootPath, port),
      spawnEnv: (protocol) => this.spawnEnvFor(protocol),
      spawnFailed: (protocolEnv) => this.discardSecretFileOf(protocolEnv)
    });
  }

  private sessionFor(event: ThreadEvent): string | undefined {
    if (event.type === "turn.done") return event.sessionId;
    return this.turnMeta.get(event.turnId)?.localSessionId || undefined;
  }

  private emitTracked(sessionId: string | undefined, event: ThreadEvent): void {
    for (const tracked of this.toolTasks.observe(event, sessionId)) this.emitRaw(tracked);
  }

  private closeTasks(sessionId: string, reason: TaskEndReason, turnId?: string): void {
    for (const update of this.toolTasks.closeOpen(sessionId, "interrupted", reason, turnId)) this.emitRaw(update);
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
      const bridge = new AskBridge(
        (sessionID, request) => this.routeBridgeQuestion(sessionID, request),
        (sessionID, bearer) => this.authorizeBridge(sessionID, bearer)
      );
      const port = await bridge.start();
      this.bridge = bridge;
      this.bridgeEndpoint = `http://127.0.0.1:${port}/ask`;
      if (await this.cliIsV2()) return;
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

  private authorizeBridge(sessionID: string, bearer: string | null): boolean {
    if (bearer !== null) return tokensEqual(this.agentSecret, bearer);
    const owner = this.ownerTurnOf(sessionID);
    return owner !== undefined && this.protocolForTurn(owner).version === "v1";
  }

  resolveAgentSession(secret: string, opencodeSessionId: string): { sessionId: string } | null {
    if (!tokensEqual(this.agentSecret, secret)) return null;
    const turnId = this.ownerTurnOf(opencodeSessionId);
    const meta = turnId === undefined ? undefined : this.turnMeta.get(turnId);
    return meta?.agent ? { sessionId: meta.localSessionId } : null;
  }

  private routeBridgeQuestion(sessionID: string, request: QuestionRequest): void {
    const turnId = this.ownerTurnOf(sessionID) ?? "";
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

  private async cliIsV2(): Promise<boolean> {
    return (await opencodeCliProtocol(this.configuredBinary())) === "v2";
  }

  private async spawnEnvFor(protocol: OpencodeProtocolVersion): Promise<Record<string, string>> {
    if (protocol !== "v2") return {};
    const askBridge = await this.bridgeUrl();
    const secretFile = await this.writeSecretFile();
    const cwMcpUrl = this.agentMcpUrl();
    if (cwMcpUrl === null) console.warn("opencode starts without cw tools: the cw-code MCP endpoint is not listening yet");
    try {
      const env = await opencodeV2PluginEnv(
        opencodePluginDir(),
        { askBridge, ...(secretFile ? { secretFile } : {}), ...(cwMcpUrl ? { cwMcpUrl } : {}) },
        process.env["OPENCODE_CONFIG_CONTENT"]
      );
      if (secretFile) this.secretFileOfEnv.set(env, secretFile);
      return env;
    } catch (err) {
      if (secretFile) this.discardSecretFile(secretFile);
      throw err;
    }
  }

  private discardSecretFileOf(protocolEnv: Record<string, string>): void {
    const file = this.secretFileOfEnv.get(protocolEnv);
    if (file) this.discardSecretFile(file);
  }

  private discardSecretFile(file: string): void {
    this.secretFiles.delete(file);
    rm(file, { force: true }).catch((err: Error) => console.warn(`could not remove the opencode plugin secret ${file}: ${err.message}`));
  }

  private sweepStaleSecretFiles(): Promise<void> {
    this.staleSecretsSwept ??= sweepStaleOpencodeSecretFiles(harnessDir(), Date.now() - process.uptime() * 1000).then(
      (removed) => {
        if (removed.length > 0) traceHarnessCall({ harness: "opencode", operation: "opencode.v2.secretSweep", ok: true, extra: { removed: removed.length } });
      },
      (err: Error) => {
        const message = truncateError(err.message);
        console.warn(`could not sweep stale opencode plugin secrets: ${message}`);
        traceHarnessCall({ harness: "opencode", operation: "opencode.v2.secretSweep", ok: false, error: message });
      }
    );
    return this.staleSecretsSwept;
  }

  private async writeSecretFile(): Promise<string | null> {
    await this.sweepStaleSecretFiles();
    try {
      const file = await writeOpencodeSecretFile(harnessDir(), this.agentSecret);
      this.secretFiles.add(file);
      return file;
    } catch (err) {
      const message = truncateError((err as Error).message);
      console.warn(`opencode starts without cw tools or cw_ask: could not write the plugin secret: ${message}`);
      traceHarnessCall({ harness: "opencode", operation: "opencode.v2.secret", ok: false, error: message });
      return null;
    }
  }

  private removeSecretFiles(): void {
    for (const file of [...this.secretFiles]) this.discardSecretFile(file);
  }

  private async bridgeEnvVars(): Promise<Record<string, string>> {
    if (await this.cliIsV2()) return {};
    const dir = opencodeConfigDir();
    await writeAskBridgeTool(dir, await this.bridgeUrl());
    return { OPENCODE_CONFIG_DIR: dir };
  }

  private clientFor(target: ServerTarget): OpencodeClient {
    return {
      cwd: target.cwd,
      request: (path, init = {}) =>
        opencodeFetch(`http://127.0.0.1:${target.port}${path}`, {
          ...requestInitOf(init, target.authHeader),
          timeoutMs: init.timeoutMs ?? OPENCODE_REQUEST_TIMEOUT_MS,
          port: target.port,
          directory: target.cwd
        })
    };
  }

  private poolClient(cwd: string, env?: Record<string, string>, turnId?: string): OpencodeClient {
    return {
      cwd,
      request: (path, init = {}) => this.fetchViaPool(cwd, path, init, env, turnId)
    };
  }

  private async poolProtocol(cwd: string): Promise<OpencodeProtocol> {
    return protocolOf((await this.pool.ensure(cwd)).protocol);
  }

  private async fetchViaPool(
    cwd: string,
    path: string,
    init: OpencodeRequestInit,
    env?: Record<string, string>,
    turnId?: string
  ): Promise<Response> {
    let handle: ServerHandle = await this.pool.ensure(cwd, env);
    const timeoutMs = init.timeoutMs ?? OPENCODE_REQUEST_TIMEOUT_MS;
    try {
      return await opencodeFetch(`http://127.0.0.1:${handle.port}${path}`, {
        ...requestInitOf(init, handle.authHeader),
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
      if (turnId) this.refreshWatchHandle(turnId, handle, cwd);
      return await opencodeFetch(`http://127.0.0.1:${handle.port}${path}`, {
        ...requestInitOf(init, handle.authHeader),
        timeoutMs,
        port: handle.port,
        directory: cwd
      });
    }
  }

  private refreshWatchHandle(turnId: string, handle: ServerHandle, cwd: string): void {
    const info = this.watchInfo.get(turnId);
    if (info) {
      this.watchInfo.set(turnId, {
        ...info,
        port: handle.port,
        authHeader: handle.authHeader,
        cwd,
        ...(handle.protocol ? { protocol: handle.protocol } : {})
      });
    }
  }

  private protocolForTurn(turnId: string): OpencodeProtocol {
    return protocolOf(this.watchInfo.get(turnId)?.protocol);
  }

  private decoderFor(turnId: string): OpencodeEventDecoder {
    let decoder = this.decoders.get(turnId);
    if (!decoder) {
      decoder = this.protocolForTurn(turnId).decoder();
      this.decoders.set(turnId, decoder);
    }
    return decoder;
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
    protocol?: OpencodeProtocolVersion;
    beforeIds: Set<string> | null;
    startedAt: number;
    permissionMode?: PermissionMode;
    inputDelivered?: boolean;
    agent: boolean;
  }): void {
    this.sessionIds.set(params.turnId, params.serverSessionId);
    this.turnMeta.set(params.turnId, {
      localSessionId: params.localSessionId,
      beforeIds: params.beforeIds,
      startedAt: params.startedAt,
      pollWarned: false,
      startedPort: params.port,
      input: { delivered: params.inputDelivered === true, seen: null },
      agent: params.agent
    });
    this.watchInfo.set(params.turnId, {
      port: params.port,
      authHeader: params.authHeader,
      cwd: params.cwd,
      permissionMode: params.permissionMode,
      ...(params.protocol ? { protocol: params.protocol } : {})
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

  private rootTurnOf(sessionID: string): string | undefined {
    return [...this.sessionIds].find(([, s]) => s === sessionID)?.[0];
  }

  private async resolveOwnerTurn(sessionID: string, info: ServerTarget): Promise<string | undefined> {
    let current: string | undefined = sessionID;
    const visited = new Set<string>();
    const protocol = protocolOf(info.protocol);
    while (current && !visited.has(current)) {
      const owner = this.ownerTurnOf(current);
      if (owner) return owner;
      visited.add(current);
      const parentID = await protocol.sessionParent(this.clientFor(info), current);
      if (!parentID) return undefined;
      this.rememberSessionParent(current, parentID);
      current = parentID;
    }
    return undefined;
  }

  private startPolling(turnId: string): void {
    const pollTimer = setInterval(() => {
      void this.pollSessionState(turnId);
    }, 2000);
    pollTimer.unref?.();
    this.pollTimers.set(turnId, pollTimer);
  }

  async listSessions(projectRoot: string, projectId = ""): Promise<SessionMeta[]> {
    const start = Date.now();
    const operation = "opencode.listSessions";
    try {
      const protocol = await this.poolProtocol(projectRoot);
      const sessions = await protocol.listSessions(this.poolClient(projectRoot));
      const mapped = sessions
        .map((s) => ({
          id: `opencode:${s.id}`,
          projectId,
          driver: "opencode" as const,
          title: s.title || s.id.slice(0, 8),
          status: "idle" as const,
          resumeCursor: s.id,
          createdAt: s.created,
          updatedAt: s.updated
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

  async listNativeSessions(): Promise<NativeSession[]> {
    const home = homedir();
    const protocol = await this.poolProtocol(home);
    const sessions = await protocol.listNativeSessions(this.poolClient(home));
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getHistory(projectRoot: string, resumeCursor: string): Promise<HistoryMessage[]> {
    if (!resumeCursor) return [];
    const start = Date.now();
    const operation = "opencode.getHistory";
    try {
      const protocol = await this.poolProtocol(projectRoot);
      const raw = await protocol.messages(this.poolClient(projectRoot), resumeCursor, { label: "opencode history failed" });
      const messages = mapOpencodeMessages(raw);
      traceHarnessCall({
        harness: "opencode",
        operation,
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: true,
        extra: { messageCount: messages.length, protocol: protocol.version }
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

  async listModels(cwd: string): Promise<ModelOption[]> {
    const binary = this.configuredBinary();
    const models = (await this.cliIsV2())
      ? await loadOpencodeModels(cwd, binary, async () => {
          const protocol = await this.poolProtocol(cwd);
          if (!protocol.listModels) throw new Error(`opencode ${protocol.version} server lists no models`);
          return protocol.listModels(this.poolClient(cwd));
        })
      : await listOpencodeModels(cwd, binary);
    for (const model of models) {
      this.modelVariants.set(model.id.toLowerCase(), model.variants);
    }
    return models;
  }

  async listCommands(cwd: string): Promise<CommandOption[]> {
    const start = Date.now();
    const operation = "opencode.listCommands";
    try {
      const protocol = await this.poolProtocol(cwd);
      const commands = await protocol.listCommands(this.poolClient(cwd));
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
    const protocol = protocolOf(handle.protocol);
    const client = this.clientFor({ ...handle, cwd });
    const alive = await protocol.sessionExists(client, resumeCursor);
    if (!alive) throw new Error("opencode session no longer exists on the server");
    const raw = await protocol.messages(client, resumeCursor, {
      label: "opencode reconnect history failed",
      timeoutMs: OPENCODE_LIST_TIMEOUT_MS
    });
    const history = mapOpencodeMessages(raw);
    const state = await protocol.reattachState(client, resumeCursor, raw);
    if (!state.running) return { status: "done", history };
    const turnId = `retry:${randomUUID()}`;
    const beforeIds = new Set(turnMessagesOf(raw).map((m) => m.id));
    for (const id of state.runIds) beforeIds.delete(id);
    this.trackTurn({
      turnId,
      localSessionId: sessionId,
      serverSessionId: resumeCursor,
      cwd,
      port: handle.port,
      authHeader: handle.authHeader,
      ...(handle.protocol ? { protocol: handle.protocol } : {}),
      beforeIds,
      startedAt: Date.now(),
      permissionMode,
      inputDelivered: true,
      agent: true
    });
    this.startPolling(turnId);
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.turnReattached",
      sessionId,
      turnId,
      cwd,
      ok: true,
      extra: { serverSessionId: resumeCursor, serverPort: handle.port, protocol: protocol.version }
    });
    return { status: "running", turnId, history };
  }

  private watchQuestions(turnId: string, port: number, authHeader: string): void {
    void (async () => {
      const controller = new AbortController();
      this.watches.set(turnId, controller);
      const info = this.watchInfo.get(turnId);
      const protocol = this.protocolForTurn(turnId);
      let ended = false;
      try {
        const res = await protocol.subscribe(
          this.clientFor({ port, authHeader, cwd: info?.cwd ?? "", ...(info?.protocol ? { protocol: info.protocol } : {}) }),
          controller.signal
        );
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
        ended = true;
      } catch (err) {
        if (!controller.signal.aborted && this.watches.get(turnId) === controller) {
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.questions.watch",
            turnId,
            ok: false,
            error: truncateError((err as Error).message)
          });
          this.rewatchLater(turnId, controller, port, authHeader, 2000);
        }
      }
      if (ended && protocol.version === "v2" && !controller.signal.aborted && this.watches.get(turnId) === controller) {
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.questions.watch",
          turnId,
          ok: false,
          error: "event stream closed by the server, resubscribing"
        });
        this.rewatchLater(turnId, controller, port, authHeader, V2_STREAM_RESUBSCRIBE_MS);
      }
    })();
  }

  private rewatchLater(turnId: string, controller: AbortController, port: number, authHeader: string, delayMs: number): void {
    if (!this.sessionIds.has(turnId)) return;
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
    }, delayMs).unref?.();
  }

  private handleSseLine(turnId: string, line: string): void {
    const event = opencodeSseEvent(line);
    if (event === null || typeof event !== "object" || Array.isArray(event)) return;
    for (const decoded of this.decoderFor(turnId).decode(event)) this.handleEvent(turnId, decoded);
  }

  private handleEvent(turnId: string, event: OpencodeEvent): void {
    const known = this.sessionIds.get(turnId);
    switch (event.kind) {
      case "question.asked":
        this.routeToOwner(turnId, event.question.sessionID, (owner) => this.surfaceQuestion(owner, event.question));
        return;
      case "form.unsupported":
        this.routeToOwner(turnId, event.sessionID, (owner) => this.dismissUnsupportedForm(owner, event.sessionID, event.formId, event.title));
        return;
      case "input.delivered":
        if (!known || event.sessionID !== known) return;
        this.noteInputDelivered(turnId, event.inboxID);
        return;
      case "question.resolved": {
        const entry = this.pendingQuestions.get(event.requestId);
        if (!entry) return;
        this.pendingQuestions.delete(event.requestId);
        this.emit({ type: "question.resolved", turnId, requestId: event.requestId, answers: {} });
        return;
      }
      case "session.parent":
        this.rememberSessionParent(event.sessionID, event.parentID);
        return;
      case "permission.asked": {
        const parsed = event.permission;
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
        this.routeToOwner(turnId, parsed.sessionID, (owner) => this.surfacePermission(owner, parsed));
        return;
      }
      case "permission.replied": {
        const entry = this.pendingApprovals.get(event.requestId);
        if (!entry) return;
        this.pendingApprovals.delete(event.requestId);
        this.emit({ type: "approval.resolved", turnId: entry.turnId, requestId: event.requestId });
        return;
      }
      case "todos":
        if (!known || event.sessionID !== known) return;
        this.emit({ type: "todo.updated", turnId, todos: event.todos });
        return;
      case "message.compaction":
        if (!known || event.sessionID !== known) return;
        this.compactionMessagesFor(turnId).add(event.messageID);
        return;
      case "part.type":
        if (!known || event.sessionID !== known) return;
        this.partTypesFor(turnId).set(event.partID, event.partType);
        return;
      case "delta": {
        if (!known || event.sessionID !== known) return;
        if (event.messageID && this.compactionMessagesFor(turnId).has(event.messageID)) return;
        const reasoning = isReasoningPartDelta(event, this.partTypesFor(turnId).get(event.partID));
        this.emit(
          reasoning
            ? { type: "reasoning.delta", turnId, text: event.text }
            : { type: "assistant.delta", turnId, text: event.text }
        );
        return;
      }
      case "retry": {
        const retry = event.retry;
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
      case "tool":
        if (!known || event.tool.sessionID !== known) return;
        this.emitLiveTool(turnId, event.tool);
        return;
      case "turn.ended": {
        const owner = this.rootTurnOf(event.sessionID);
        if (!owner) return;
        const input = this.turnMeta.get(owner)?.input;
        if (this.protocolForTurn(owner).version === "v2" && input && !input.delivered) {
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.turnEnd.stale",
            turnId: owner,
            ok: true,
            extra: { reason: event.reason }
          });
          return;
        }
        if (event.reason === "failed") {
          const meta = this.turnMeta.get(owner);
          this.failTurn(owner, meta?.localSessionId ?? "", event.sessionID, new Error(event.error || "opencode turn failed"));
          return;
        }
        if (event.reason === "completed" && this.protocolForTurn(owner).version === "v2") {
          void this.settleTurn(owner);
          return;
        }
        void this.finishTurn(owner);
        return;
      }
    }
  }

  private routeToOwner(streamTurnId: string, sessionID: string, deliver: (owner: string) => void): void {
    const owner = this.ownerTurnOf(sessionID);
    if (owner) {
      deliver(owner);
      return;
    }
    const info = this.watchInfo.get(streamTurnId);
    if (!info) return;
    void this.resolveOwnerTurn(sessionID, info).then((resolved) => {
      if (resolved) deliver(resolved);
    });
  }

  private armTurnInput(turnId: string): void {
    const meta = this.turnMeta.get(turnId);
    if (meta) meta.input = { delivered: false, seen: new Set() };
  }

  private admitTurnInput(turnId: string, admittedId: string | undefined): void {
    const input = this.turnMeta.get(turnId)?.input;
    if (!input || input.delivered) return;
    input.admitted = admittedId ?? "any";
    input.delivered = admittedId ? (input.seen?.has(admittedId) ?? false) : (input.seen?.size ?? 0) > 0;
  }

  private noteInputDelivered(turnId: string, inboxID: string): void {
    const input = this.turnMeta.get(turnId)?.input;
    if (!input || input.delivered || !input.seen) return;
    input.seen.add(inboxID);
    if (input.admitted === "any" || input.admitted === inboxID) input.delivered = true;
  }

  private dismissUnsupportedForm(turnId: string, sessionID: string, formId: string, title: string): void {
    if (this.handledForms.has(formId)) return;
    if (this.handledForms.size >= HANDLED_FORMS_LIMIT) {
      const oldest = this.handledForms.values().next();
      if (!oldest.done) this.handledForms.delete(oldest.value);
    }
    this.handledForms.add(formId);
    const info = this.watchInfo.get(turnId);
    if (!info) return;
    this.emit({
      type: "assistant.delta",
      turnId,
      text: `\n\nopencode asked for input cw-code cannot show${title ? ` (${title})` : ""}; it was dismissed. Open the terminal tab to answer prompts like this one.\n\n`
    });
    traceHarnessCall({ harness: "opencode", operation: "opencode.v2.formDismissed", turnId, resumeCursor: formId, ok: true, extra: { title } });
    void protocolOf(info.protocol)
      .dismissForm(this.clientFor(info), sessionID, formId, UNSUPPORTED_FORM_MESSAGE)
      .catch((err) => {
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.v2.formDismissed",
          turnId,
          resumeCursor: formId,
          ok: false,
          error: truncateError((err as Error).message)
        });
      });
  }

  private emitLiveTool(turnId: string, tool: OpencodeToolUpdate): void {
    const seen = this.toolSeen.get(turnId);
    if (!seen) return;
    const message: LiveMessage = {
      info: { id: tool.messageID, role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: tool.name,
          callID: tool.callId,
          state: {
            status: tool.status,
            input: tool.input ?? {},
            ...(tool.output !== undefined ? { output: tool.output } : {}),
            ...(tool.status === "error" ? { error: tool.output ?? "tool failed" } : {})
          }
        }
      ]
    };
    this.emitToolDiff(turnId, diffLiveTools(seen, [message], turnId, null, undefined, (callId) => this.childModels.get(turnId)?.get(callId)));
  }

  private emitToolDiff(turnId: string, events: ThreadEvent[], localSessionId?: string): void {
    const todosFromTools = this.protocolForTurn(turnId).todosFromTools;
    for (const event of events) {
      if (localSessionId !== undefined) this.emitTracked(localSessionId || undefined, event);
      else this.emit(event);
      if (!todosFromTools || event.type !== "tool.call" || event.parentToolCallId !== undefined) continue;
      const todos = todosFromToolCall(event.name, event.input);
      if (todos) this.emit({ type: "todo.updated", turnId, todos });
    }
  }

  private surfaceQuestion(turnId: string, question: ParsedOpencodeQuestion): void {
    if (this.pendingQuestions.has(question.requestId)) return;
    this.pendingQuestions.set(question.requestId, {
      ...question,
      turnId,
      questions: question.questions,
      cwd: this.watchInfo.get(turnId)?.cwd ?? ""
    });
    this.emit({ type: "question.request", turnId, request: questionRequestOf(question, turnId) });
  }

  private async runTurn(turnId: string, request: TurnRequest): Promise<void> {
    const start = Date.now();
    const binary = this.configuredBinary();
    let handle: ServerHandle;
    try {
      let env = request.env;
      if (request.resumeCursor && this.bridgeNeed.get(request.cwd) === true) {
        env = { ...(request.env ?? {}), ...(await this.bridgeEnvVars()) };
      }
      handle = await this.pool.ensure(request.cwd, env);
      if (request.resumeCursor) {
        const native = await protocolOf(handle.protocol).nativeQuestionAvailable(
          this.clientFor({ ...handle, cwd: request.cwd }),
          request.resumeCursor
        );
        const needsBridge = !native;
        const previouslyNeeded = this.bridgeNeed.get(request.cwd);
        this.bridgeNeed.set(request.cwd, needsBridge);
        if (needsBridge && previouslyNeeded !== true) {
          handle = await this.pool.ensure(request.cwd, { ...(request.env ?? {}), ...(await this.bridgeEnvVars()) });
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
    let protocol = protocolOf(handle.protocol);
    let serverSessionId: string;
    if (request.resumeCursor) {
      serverSessionId = request.resumeCursor;
    } else {
      try {
        serverSessionId = await protocol.createSession(this.clientFor({ ...handle, cwd: request.cwd }));
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
              extra: { deadPort: handle.port, reason: truncateError((err as Error).message) }
            });
            this.pool.invalidate(request.cwd);
            handle = await this.pool.ensure(request.cwd, request.env);
            protocol = protocolOf(handle.protocol);
            serverSessionId = await protocol.createSession(this.clientFor({ ...handle, cwd: request.cwd }));
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
    const target: ServerTarget = { port: handle.port, authHeader: handle.authHeader, cwd: request.cwd, ...(handle.protocol ? { protocol: handle.protocol } : {}) };
    this.trackTurn({
      turnId,
      localSessionId: request.sessionId,
      serverSessionId,
      cwd: request.cwd,
      port: handle.port,
      authHeader: handle.authHeader,
      ...(handle.protocol ? { protocol: handle.protocol } : {}),
      beforeIds: null,
      startedAt: start,
      permissionMode: request.permissionMode,
      agent: request.agent !== undefined
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
      extra: {
        serverPort: handle.port,
        protocol: protocol.version,
        variant: variant ?? null,
        permissionMode: request.permissionMode ?? null
      }
    });

    const client = this.clientFor(target);
    if (request.resumeCursor) {
      try {
        await protocol.awaitSession(client, serverSessionId);
      } catch (err) {
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.startTurn.awaitSession",
          sessionId: request.sessionId,
          turnId,
          cwd: request.cwd,
          ok: false,
          error: truncateError((err as Error).message)
        });
      }
    }
    try {
      const baseline = await protocol.messages(client, serverSessionId, {
        label: "opencode baseline history failed",
        timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS
      });
      const seen = new Set<string>();
      for (const m of turnMessagesOf(baseline)) seen.add(m.id);
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
      this.armTurnInput(turnId);
      void this.runBuiltinCommand(turnId, request.sessionId, builtin, {
        protocol,
        client,
        cwd: request.cwd,
        serverSessionId,
        model,
        signal: controller.signal
      });
      return;
    }
    const files = attachmentFilesOf(request.cwd, request.attachments ?? []);
    this.armTurnInput(turnId);
    const send = (withFiles: boolean) =>
      protocol.send(client, serverSessionId, {
        prompt: request.prompt,
        ...(command ? { command } : {}),
        ...(!command && request.skills?.length ? { skills: request.skills } : {}),
        model,
        ...(variant ? { variant } : {}),
        files: withFiles ? files : [],
        signal: controller.signal
      });
    void send(files.length > 0)
      .then(async (first) => {
        if (controller.signal.aborted || !this.sessionIds.has(turnId)) return;
        let result = first;
        if (!result.response.ok && result.response.status === 400 && files.length > 0) {
          console.warn(`attachment message rejected, retrying text-only`);
          traceHarnessCall({
            harness: "opencode",
            operation: "opencode.startTurn.attachments",
            sessionId: request.sessionId,
            turnId,
            cwd: request.cwd,
            ok: false,
            error: `file parts rejected: ${result.response.status}, retried text-only`
          });
          result = await send(false);
        }
        if (controller.signal.aborted || !this.sessionIds.has(turnId)) return;
        const res = result.response;
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
          extra: { serverSessionId, settled: result.settled, admittedId: result.admittedId ?? null }
        });
        if (result.notice) this.emit({ type: "assistant.delta", turnId, text: result.notice });
        if (result.settled) {
          void this.finishTurn(turnId);
          return;
        }
        this.admitTurnInput(turnId, result.admittedId);
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
      protocol: OpencodeProtocol;
      client: OpencodeClient;
      cwd: string;
      serverSessionId: string;
      model: { providerID: string; modelID: string } | null;
      signal: AbortSignal;
    }
  ): Promise<void> {
    const live = (): boolean => !target.signal.aborted && this.sessionIds.has(turnId);
    try {
      if (name === "compact") {
        const pending = this.turnMeta.get(turnId);
        if (pending) pending.compactionTrigger = "manual";
      }
      const outcome = await target.protocol.builtin(target.client, target.serverSessionId, name, {
        model: target.model,
        signal: target.signal
      });
      if (!live()) return;
      if (!outcome.settled) this.admitTurnInput(turnId, outcome.admittedId);
      if (name === "compact" && outcome.settled) {
        const meta = this.turnMeta.get(turnId);
        if (meta) meta.compactionEmitted = true;
        this.emit({ type: "context.compacted", turnId, compaction: { trigger: "manual" } });
      }
      if (outcome.notice) this.emit({ type: "assistant.delta", turnId, text: outcome.notice });
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.commandDone",
        sessionId: localSessionId,
        turnId,
        cwd: target.cwd,
        ok: true,
        extra: { command: name, serverSessionId: target.serverSessionId, settled: outcome.settled }
      });
      if (outcome.settled) void this.finishTurn(turnId);
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
    target: ServerTarget;
    beforeIds: Set<string> | null;
    seen: Map<string, LiveSeen>;
    childModels: Map<string, string>;
    compactionEmitted: boolean;
    compactionTrigger?: "manual" | "auto";
    todosFromTools: boolean;
  } | null {
    for (const [requestId, ownerTurnId] of this.handledPermissions) {
      if (ownerTurnId === turnId) this.handledPermissions.delete(requestId);
    }
    const meta = this.turnMeta.get(turnId);
    const serverSessionId = this.sessionIds.get(turnId);
    const info = this.watchInfo.get(turnId);
    if (!meta || !serverSessionId || !info) return null;
    const todosFromTools = this.protocolForTurn(turnId).todosFromTools;
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
    this.activityNotifier.notify();
    this.watchInfo.delete(turnId);
    this.decoders.delete(turnId);
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
      target: { port: info.port, authHeader: info.authHeader, cwd: info.cwd, ...(info.protocol ? { protocol: info.protocol } : {}) },
      beforeIds: meta.beforeIds,
      seen,
      childModels,
      compactionEmitted: meta.compactionEmitted === true,
      ...(meta.compactionTrigger ? { compactionTrigger: meta.compactionTrigger } : {}),
      todosFromTools
    };
  }

  private async settleTurn(turnId: string): Promise<void> {
    const info = this.watchInfo.get(turnId);
    const sessionID = this.sessionIds.get(turnId);
    const meta = this.turnMeta.get(turnId);
    if (!info || !sessionID || !meta) return;
    const protocol = protocolOf(info.protocol);
    let pending: string[];
    try {
      const messages = await protocol.messages(this.clientFor(info), sessionID, {
        label: "opencode turn settle failed"
      });
      pending = protocol.pendingChildren(messages, meta.beforeIds);
    } catch (err) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.turnSettle",
        turnId,
        ok: false,
        error: truncateError((err as Error).message)
      });
      pending = [];
    }
    if (!this.sessionIds.has(turnId)) return;
    if (pending.length === 0) {
      void this.finishTurn(turnId);
      return;
    }
    if (meta.holding) return;
    meta.holding = true;
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.turnHeld",
      sessionId: meta.localSessionId,
      turnId,
      ok: true,
      extra: { backgroundChildren: pending.length }
    });
  }

  private async finishTurn(turnId: string): Promise<void> {
    const taken = this.takeTurn(turnId);
    if (!taken) return;
    let text = "";
    let usage: TurnModelUsage[] = [];
    let context: ContextUsage | undefined;
    let errorText = "";
    const protocol = protocolOf(taken.target.protocol);
    const loadResult = (target: ServerTarget): Promise<OpencodeMessage[]> =>
      protocol.messages(this.clientFor(target), taken.serverSessionId, {
        label: "opencode result history failed",
        timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS
      });
    try {
      let messages: OpencodeMessage[];
      try {
        messages = await loadResult(taken.target);
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        traceHarnessCall({
          harness: "opencode",
          operation: "opencode.serve.reconnect",
          sessionId: taken.localSessionId,
          turnId,
          cwd: taken.target.cwd,
          ok: true,
          extra: { deadPort: taken.target.port, reason: truncateError((err as Error).message) }
        });
        this.pool.invalidate(taken.target.cwd);
        const fresh = await this.pool.ensure(taken.target.cwd);
        messages = await loadResult({ ...taken.target, port: fresh.port, authHeader: fresh.authHeader });
      }
      const toolEvents = diffLiveTools(
        taken.seen,
        messages as LiveMessage[],
        turnId,
        taken.beforeIds,
        undefined,
        (callId) => taken.childModels.get(callId)
      );
      for (const event of toolEvents) {
        this.emitTracked(taken.localSessionId || undefined, event);
        if (!taken.todosFromTools || event.type !== "tool.call" || event.parentToolCallId !== undefined) continue;
        const todos = todosFromToolCall(event.name, event.input);
        if (todos) this.emitTracked(taken.localSessionId || undefined, { type: "todo.updated", turnId, todos });
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
      const protocol = protocolOf(info.protocol);
      const client = this.clientFor(info);
      const children = protocol.version === "v2" ? this.knownChildren(turnId, serverSessionId) : [];
      const abort = Promise.all(children.map((child) => protocol.interrupt(client, child).catch(() => undefined)))
        .then(() => protocol.interrupt(client, serverSessionId))
        .then(
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
    const localSessionId = this.turnMeta.get(turnId)?.localSessionId;
    if (localSessionId) this.closeTasks(localSessionId, "interrupt", turnId);
    this.discardTurn(turnId);
  }

  private knownChildren(turnId: string, rootSessionId: string): string[] {
    const children = new Set(this.sessionChildren.get(rootSessionId) ?? []);
    for (const child of this.taskChildren.get(turnId)?.values() ?? []) children.add(child);
    return [...children];
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
    const protocol = protocolOf(info.protocol);
    const cwd = entry.cwd || info.cwd;
    const attempt = (port: number, authHeader: string): Promise<boolean> =>
      protocol.replyQuestion(this.clientFor({ port, authHeader, cwd }), entry, answers);
    try {
      if (await attempt(info.port, info.authHeader)) {
        this.pendingQuestions.delete(requestId);
        this.emit({ type: "question.resolved", turnId: entry.turnId, requestId, answers });
        return;
      }
    } catch (err) {
      if (!isConnectionError(err)) throw err;
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
    info: ServerTarget,
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
    info: ServerTarget | undefined,
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject"
  ): Promise<"replied" | "missing"> {
    if (!info) throw new Error("opencode permission reply has no live server");
    return protocolOf(info.protocol).replyPermission(this.clientFor(info), sessionID, requestID, reply);
  }

  private async pollChildTools(
    turnId: string,
    info: ServerTarget,
    rootSessionId: string,
    payload: OpencodeMessage[]
  ): Promise<void> {
    const tasks = collectTaskParts(payload as LiveMessage[]);
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
      let child = assigned.get(task.callId) ?? task.childSessionId;
      if (!child) {
        const used = new Set(assigned.values());
        child = children.find((id) => !used.has(id));
        if (!child) continue;
      }
      assigned.set(task.callId, child);
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

  private async loadSessionMessages(info: ServerTarget, sessionID: string): Promise<LiveMessage[] | null> {
    try {
      return (await protocolOf(info.protocol).messages(this.clientFor(info), sessionID, {
        label: "opencode subagent poll failed",
        recent: true
      })) as LiveMessage[];
    } catch {
      return null;
    }
  }

  private async pollSessionState(turnId: string): Promise<void> {
    if (!this.sessionIds.has(turnId)) return;
    let info = this.watchInfo.get(turnId);
    const sessionID = this.sessionIds.get(turnId);
    if (!info || !sessionID) return;
    const protocol = protocolOf(info.protocol);
    try {
      const payload = await protocol.messages(this.clientFor(info), sessionID, {
        label: "opencode live poll failed",
        recent: true
      });
      const seen = this.toolSeen.get(turnId);
      const partTypes = this.partTypes.get(turnId);
      if (partTypes) collectPartTypes(payload as LiveMessage[], partTypes);
      const meta = this.turnMeta.get(turnId);
      if (seen) {
        this.emitToolDiff(
          turnId,
          diffLiveTools(
            seen,
            payload as LiveMessage[],
            turnId,
            meta?.beforeIds ?? null,
            undefined,
            (callId) => this.childModels.get(turnId)?.get(callId)
          )
        );
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
      if (meta?.beforeIds && protocol.turnEnded(payload, meta.beforeIds)) {
        void (protocol.version === "v2" ? this.settleTurn(turnId) : this.finishTurn(turnId));
        return;
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
    const client = this.clientFor(info);
    let forms: OpencodeEvent[] = [];
    let permissions: ParsedOpencodePermission[] | null;
    try {
      forms = await protocol.pendingForms(client, sessionID);
      permissions = await protocol.listPermissions(client, sessionID);
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
    if (!this.sessionIds.has(turnId)) return;
    for (const form of forms) this.handleEvent(turnId, form);
    for (const parsed of permissions ?? []) {
      const owner = await this.resolveOwnerTurn(parsed.sessionID, info);
      if (owner !== turnId) continue;
      this.surfacePermission(turnId, parsed);
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

  async terminalLaunch(cwd: string): Promise<TerminalLaunch | null> {
    if (!(await this.cliIsV2())) return null;
    let lease: Awaited<ReturnType<OpencodeServerPool["lease"]>>;
    try {
      lease = await this.pool.lease(cwd);
    } catch (err) {
      const message = truncateError((err as Error).message);
      console.warn(`opencode terminal opens without cw-code's server: ${message}`);
      traceHarnessCall({ harness: "opencode", operation: "opencode.terminalAttach", cwd, ok: false, error: message });
      return null;
    }
    const { handle, release } = lease;
    if (handle.protocol !== "v2" || !handle.password) {
      release();
      return null;
    }
    traceHarnessCall({ harness: "opencode", operation: "opencode.terminalAttach", cwd, ok: true, extra: { serverPort: handle.port } });
    return {
      args: ["--server", `http://127.0.0.1:${handle.port}`],
      env: { OPENCODE_PASSWORD: handle.password },
      release
    };
  }

  liveTasks(sessionId: string): TaskSnapshot[] {
    return this.toolTasks.liveTasks(sessionId);
  }

  stopSession(sessionId: string): void {
    this.closeTasks(sessionId, "process-exit");
    this.toolTasks.forget(sessionId);
    const cwd = this.sessionCwds.get(sessionId);
    this.sessionCwds.delete(sessionId);
    if (!cwd) return;
    traceHarnessCall({ harness: "opencode", operation: "opencode.stopSession", sessionId, cwd, ok: true });
    this.pool.invalidate(cwd);
  }

  onActivityChanged(listener: () => void): () => void {
    return this.activityNotifier.subscribe(listener);
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
    this.handledForms.clear();
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
    this.decoders.clear();
    this.taskChildren.clear();
    this.childToolSeen.clear();
    this.childPollDone.clear();
    this.childModels.clear();
    this.bridgeNeed.clear();
    this.pool.dispose();
    this.removeSecretFiles();
    this.activityNotifier.notify();
  }
}

function attachmentFilesOf(cwd: string, attachments: string[]): OpencodeAttachment[] {
  const files: OpencodeAttachment[] = [];
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
    files.push({ mime, path: isAbsolute(rel) ? rel : join(cwd, rel) });
  }
  return files;
}
