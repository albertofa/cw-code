import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type {
  AppSettings,
  ApprovalDecision,
  CliDriver,
  EffortLevel,
  HistoryMessage,
  PermissionMode,
  PermissionOption,
  SubagentToolsResult,
  ThreadEvent,
  TurnHandle,
  TurnRequest
} from "@cw-code/contracts";
import { parseExtraArgs } from "../../settings/settingsUtils.js";
import { killProcessTree } from "../../processTree.js";
import { attributeClaudeSubagentEvent, buildClaudeAllowRule, claudeAllowResponse, claudeApprovalRequest, claudeQuestionRequest, claudeDenyResponse, claudeControlResponse, parseClaudeControlRequest, parseClaudeTaskSystemLine, parseStreamLine, type ClaudeControlRequest, type ClaudeTaskSystemInfo, type TurnDoneInfo } from "./claudeStreamParser.js";
import { claudeProjectSlug, listClaudeSessions } from "./claudeSessions.js";
import { readClaudeHistory, readSidecarAgent, readClaudeTaskResult, findSidecarModel, type SidecarAgent } from "./claudeHistory.js";
import { buildClaudeUserContent } from "./claudeUserContent.js";
import { previewText, traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";

export const CLAUDE_CURATED_MODELS = [
  { id: "sonnet", label: "Sonnet" },
  { id: "fable", label: "Fable 5.1" },
  { id: "haiku", label: "Haiku" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
];

export function mapClaudePermission(mode: PermissionMode | string): string {
  if (mode === "acceptEdits") return "acceptEdits";
  if (mode === "bypassPermissions") return "bypassPermissions";
  if (mode === "manual") return "manual";
  return "auto";
}

export function listClaudePermissionModes(): PermissionOption[] {
  return [
    { id: "manual", label: "Manual", description: "Reads only; asks before edits, commands, and network.", native: true },
    { id: "acceptEdits", label: "Accept edits", description: "Reads, file edits, and common filesystem commands run without asking.", native: true },
    { id: "auto", label: "Auto", description: "Everything runs with background safety checks instead of prompts.", native: true },
    { id: "bypassPermissions", label: "Bypass permissions", description: "Skips permission prompts. Isolated environments only.", native: true }
  ];
}

export function mapClaudeEffort(effort: EffortLevel | string): string {
  if (effort === "minimal") return "low";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
    return effort;
  }
  return "medium";
}

export function buildClaudeArgs(request: Pick<TurnRequest, "resumeCursor" | "model" | "effort" | "permissionMode" | "allowedTools" | "maxTurns">): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--permission-prompt-tool", "stdio"
  ];
  if (request.resumeCursor) args.push("--resume", request.resumeCursor);
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", mapClaudeEffort(request.effort));
  if (request.permissionMode) args.push("--permission-mode", mapClaudePermission(request.permissionMode));
  if (request.allowedTools?.length) args.push("--allowedTools", request.allowedTools.join(","));
  if (request.maxTurns) args.push("--max-turns", String(request.maxTurns));
  return args;
}

export interface PendingClaudeApproval {
  turnId: string;
  control: ClaudeControlRequest;
  cwd: string;
  localSessionId: string;
}

export function claudeSettingsPath(cwd: string): string {
  return join(normalize(cwd), ".claude", "settings.json");
}

export function mergeClaudeAllowRule(existing: unknown, rule: string): Record<string, unknown> {
  const base =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const permissions =
    base["permissions"] !== null && typeof base["permissions"] === "object" && !Array.isArray(base["permissions"])
      ? { ...(base["permissions"] as Record<string, unknown>) }
      : {};
  const allow = Array.isArray(permissions["allow"])
    ? [...(permissions["allow"] as unknown[])]
    : [];
  if (!allow.includes(rule)) allow.push(rule);
  return { ...base, permissions: { ...permissions, allow } };
}

export const CLAUDE_IDLE_EVICT_MS = 20 * 60_000;

const CLAUDE_ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CLAUDE_EXIT_BOILERPLATE_RE =
  /sandbox disabled|sandbox is (not active|enabled)|without sandboxing|restrictions will not be enforced/i;

export function describeClaudeExit(stderr: string, code: number | null): string {
  const cleaned = stderr
    .replace(CLAUDE_ANSI_RE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !CLAUDE_EXIT_BOILERPLATE_RE.test(line))
    .join("\n");
  if (cleaned) return cleaned.slice(0, 2000);
  return `claude exited before completing the turn (code ${code})`;
}

export function subagentToolsResult(agent: SidecarAgent | undefined): SubagentToolsResult {
  if (!agent) return { items: [] };
  return {
    items: agent.items,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.totalTokens !== undefined ? { tokens: agent.totalTokens } : {})
  };
}

interface ClaudeProcessState {
  sessionId: string;
  cwd: string;
  argsKey: string;
  binary: string;
  args: string[];
  child: ChildProcessWithoutNullStreams;
  resumeCursor: string;
  activeTurnId: string;
  liveTasks: number;
  completedTurn: boolean;
  errored: boolean;
  stderr: string;
  startedAt: number;
  agentByCall: Map<string, string>;
  taskToolCalls: Map<string, string>;
  permissionMode: PermissionMode;
  idleTimer?: NodeJS.Timeout;
}

export class ClaudeCliDriver implements CliDriver {
  readonly kind = "claude" as const;
  private processes = new Map<string, ClaudeProcessState>();
  private turnToSession = new Map<string, string>();
  private interruptedTurns = new Set<string>();
  private pendingQuestions = new Map<string, { turnId: string; sessionId: string; control: ClaudeControlRequest }>();
  private pendingApprovals = new Map<string, PendingClaudeApproval>();
  private sessionAllows = new Map<string, Set<string>>();

  constructor(
    private emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings,
    private spawnFn: typeof spawn = spawn,
    private killFn: (proc: ChildProcess | undefined) => void = killProcessTree
  ) {}

  private configuredBinary(): string {
    return this.getSettings().claudeBinaryPath;
  }

  private extraArgs(): string[] {
    return parseExtraArgs(this.getSettings().claudeExtraArgs);
  }

  private claudeArgsKey(request: TurnRequest): string {
    return JSON.stringify([
      request.cwd,
      request.model ?? "",
      request.effort ?? "",
      request.permissionMode ?? "",
      this.extraArgs()
    ]);
  }

  private writeControl(sessionId: string, line: string): void {
    const stdin = this.processes.get(sessionId)?.child.stdin;
    if (!stdin) return;
    stdin.write(`${line}\n`);
  }

  private writeUserMessage(state: ClaudeProcessState, request: TurnRequest): void {
    state.child.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: buildClaudeUserContent(request.cwd, request.prompt, request.attachments) } })}\n`
    );
  }

  private isProcessAlive(state: ClaudeProcessState): boolean {
    return !state.errored && state.child.exitCode === null && state.child.signalCode === null;
  }

  private terminate(state: ClaudeProcessState): void {
    this.clearIdleTimer(state);
    this.killFn(state.child);
    if (this.processes.get(state.sessionId) === state) this.processes.delete(state.sessionId);
  }

  private clearIdleTimer(state: ClaudeProcessState): void {
    if (!state.idleTimer) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  private armIdleTimer(state: ClaudeProcessState): void {
    this.clearIdleTimer(state);
    const timer = setTimeout(() => {
      state.idleTimer = undefined;
      if (this.processes.get(state.sessionId) !== state) return;
      if (state.liveTasks > 0 || !state.completedTurn || this.hasPendingForSession(state.sessionId)) {
        this.armIdleTimer(state);
        return;
      }
      traceHarnessCall({
        harness: "claude",
        operation: "claude.evict",
        sessionId: state.sessionId,
        cwd: state.cwd,
        binary: state.binary,
        ok: true
      });
      this.processes.delete(state.sessionId);
      this.killFn(state.child);
    }, CLAUDE_IDLE_EVICT_MS);
    timer.unref?.();
    state.idleTimer = timer;
  }

  private hasPendingForSession(sessionId: string): boolean {
    for (const entry of this.pendingQuestions.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    for (const entry of this.pendingApprovals.values()) {
      if (entry.localSessionId === sessionId) return true;
    }
    return false;
  }

  private resolvePendingForSession(sessionId: string, answers: Record<string, string> | null): void {
    for (const [requestId, entry] of [...this.pendingQuestions]) {
      if (entry.sessionId !== sessionId) continue;
      this.pendingQuestions.delete(requestId);
      this.emit({ type: "question.resolved", turnId: entry.turnId, requestId, answers });
    }
    for (const [requestId, entry] of [...this.pendingApprovals]) {
      if (entry.localSessionId !== sessionId) continue;
      this.pendingApprovals.delete(requestId);
      this.emit({ type: "approval.resolved", turnId: entry.turnId, requestId });
    }
  }

  private resolvePendingForTurn(turnId: string): void {
    for (const [requestId, entry] of [...this.pendingQuestions]) {
      if (entry.turnId !== turnId) continue;
      this.pendingQuestions.delete(requestId);
      this.emit({ type: "question.resolved", turnId, requestId, answers: null });
    }
    for (const [requestId, entry] of [...this.pendingApprovals]) {
      if (entry.turnId !== turnId) continue;
      this.pendingApprovals.delete(requestId);
      this.emit({ type: "approval.resolved", turnId, requestId });
    }
  }

  private handleProcessLine(state: ClaudeProcessState, line: string): void {
    const taskSystem = parseClaudeTaskSystemLine(line);
    if (taskSystem) {
      this.handleTaskSystem(state, taskSystem);
      return;
    }
    const control = parseClaudeControlRequest(line);
    if (control) {
      this.handleControl(control, state);
      return;
    }
    const events = parseStreamLine(
      line,
      state.activeTurnId,
      state.resumeCursor,
      (info) => this.handleTurnDone(state, info),
      () => this.clearIdleTimer(state)
    );
    for (const event of events) {
      this.emit(this.attributeSubagentResult(state, attributeClaudeSubagentEvent(event, state.agentByCall)));
    }
  }

  private subagentModel(state: ClaudeProcessState, agentId: string): string | undefined {
    if (!state.resumeCursor) return undefined;
    const transcriptDir = join(homedir(), ".claude", "projects", claudeProjectSlug(state.cwd), state.resumeCursor);
    return findSidecarModel(transcriptDir, agentId) ?? findSidecarModel(dirname(transcriptDir), agentId);
  }

  private attributeSubagentResult(state: ClaudeProcessState, event: ThreadEvent): ThreadEvent {
    if (event.type !== "tool.result") return event;
    const agentId = state.agentByCall.get(event.toolCallId);
    if (!agentId) return event;
    const model = this.subagentModel(state, agentId);
    return { ...event, agentId, ...(model ? { model } : {}) };
  }

  private handleTaskSystem(state: ClaudeProcessState, info: ClaudeTaskSystemInfo): void {
    if (info.kind === "tasks") {
      state.liveTasks = info.liveTasks ?? 0;
      return;
    }
    if (info.kind === "started") {
      if (info.taskId && info.toolUseId) {
        state.taskToolCalls.set(info.taskId, info.toolUseId);
        state.agentByCall.set(info.toolUseId, info.taskId);
      }
      return;
    }
    if (info.kind === "progress") return;
    const toolUseId = info.toolUseId ?? (info.taskId ? state.taskToolCalls.get(info.taskId) : undefined);
    if (!toolUseId) return;
    if (info.kind === "updated") {
      const status = (info.status ?? "").toLowerCase();
      if (status === "" || status === "completed" || status === "running" || status === "in_progress") return;
      this.emit({
        type: "tool.result",
        turnId: state.activeTurnId,
        toolCallId: toolUseId,
        output: `Subagent ${status}`,
        isError: true
      });
      return;
    }
    const transcript = readClaudeTaskResult(state.cwd, state.resumeCursor, toolUseId);
    const status = (transcript?.status ?? info.status ?? "completed").toLowerCase();
    const output = (transcript?.result ?? info.summary ?? status).slice(0, 8000);
    const agentId = state.agentByCall.get(toolUseId);
    this.emit(
      this.attributeSubagentResult(state, {
        type: "tool.result",
        turnId: state.activeTurnId,
        toolCallId: toolUseId,
        output,
        isError: status !== "completed",
        ...(info.usage ? { usage: info.usage } : {}),
        ...(agentId ? { agentId } : {})
      })
    );
    if (info.taskId) state.taskToolCalls.delete(info.taskId);
  }

  private handleTurnDone(state: ClaudeProcessState, info: TurnDoneInfo): void {
    const turnId = state.activeTurnId;
    const interrupted = this.interruptedTurns.delete(turnId);
    if (!interrupted) {
      this.emit({
        type: "turn.done",
        turnId,
        sessionId: state.sessionId,
        resumeCursor: info.resumeCursor,
        resultText: info.resultText,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
        costUsd: info.costUsd,
        numTurns: info.numTurns,
        isError: info.isError,
        backgroundTasks: state.liveTasks
      });
    }
    state.resumeCursor = info.resumeCursor;
    if (state.liveTasks > 0) {
      return;
    }
    state.completedTurn = true;
    this.turnToSession.delete(turnId);
    if (state.sessionId.startsWith("title:")) {
      this.terminate(state);
      return;
    }
    this.armIdleTimer(state);
  }

  private handleProcessClose(state: ClaudeProcessState, code: number | null): void {
    if (this.processes.get(state.sessionId) === state) this.processes.delete(state.sessionId);
    this.clearIdleTimer(state);
    this.resolvePendingForSession(state.sessionId, null);
    const turnId = state.activeTurnId;
    traceHarnessCall({
      harness: "claude",
      operation: "claude.processExit",
      sessionId: state.sessionId,
      turnId,
      cwd: state.cwd,
      binary: state.binary,
      durationMs: Date.now() - state.startedAt,
      ok: code === 0,
      exitCode: code,
      stderrPreview: state.stderr ? truncateError(state.stderr) : undefined
    });
    if (!state.completedTurn && !state.errored) {
      this.emit({ type: "turn.error", turnId, message: describeClaudeExit(state.stderr, code) });
    }
    this.turnToSession.delete(turnId);
    this.interruptedTurns.delete(turnId);
  }

  async listSessions(projectRoot: string, projectId = ""): Promise<import("@cw-code/contracts").SessionMeta[]> {
    const start = Date.now();
    try {
      const sessions = await listClaudeSessions(projectId, projectRoot);
      traceHarnessCall({
        harness: "claude",
        operation: "claude.listSessions",
        cwd: projectRoot,
        durationMs: Date.now() - start,
        ok: true,
        extra: { count: sessions.length }
      });
      return sessions;
    } catch (err) {
      traceHarnessCall({
        harness: "claude",
        operation: "claude.listSessions",
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
    try {
      const messages = await readClaudeHistory(projectRoot, resumeCursor);
      traceHarnessCall({
        harness: "claude",
        operation: "claude.getHistory",
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: true,
        extra: { messageCount: messages.length }
      });
      return messages;
    } catch (err) {
      traceHarnessCall({
        harness: "claude",
        operation: "claude.getHistory",
        cwd: projectRoot,
        resumeCursor,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError((err as Error).message)
      });
      throw err;
    }
  }

  async getSubagentTools(projectRoot: string, resumeCursor: string, agentId: string): Promise<SubagentToolsResult> {
    if (!resumeCursor || !agentId) return { items: [] };
    const transcriptDir = join(homedir(), ".claude", "projects", claudeProjectSlug(projectRoot), resumeCursor);
    const agent = readSidecarAgent(transcriptDir, agentId) ?? readSidecarAgent(dirname(transcriptDir), agentId);
    return subagentToolsResult(agent);
  }

  async listPermissionModes(): Promise<PermissionOption[]> {
    return listClaudePermissionModes();
  }

  startTurn(request: TurnRequest): TurnHandle {
    const turnId = randomUUID();
    const start = Date.now();
    const preview = previewText(request.prompt);
    const binary = this.configuredBinary();
    const argsKey = this.claudeArgsKey(request);
    const existing = this.processes.get(request.sessionId);

    if (!request.maxTurns && existing && existing.argsKey === argsKey && this.isProcessAlive(existing)) {
      existing.activeTurnId = turnId;
      existing.completedTurn = false;
      existing.permissionMode = request.permissionMode ?? "auto";
      this.clearIdleTimer(existing);
      this.turnToSession.set(turnId, request.sessionId);
      this.writeUserMessage(existing, request);
      traceHarnessCall({
        harness: "claude",
        operation: "claude.startTurn",
        sessionId: request.sessionId,
        turnId,
        cwd: request.cwd,
        binary: existing.binary,
        args: existing.args,
        model: request.model,
        promptPreview: preview.preview,
        promptLength: preview.length,
        resumeCursor: existing.resumeCursor,
        durationMs: Date.now() - start,
        ok: true,
        extra: { reused: true }
      });
      return { turnId, events: (async function* () {})() };
    }

    if (existing) this.terminate(existing);
    const args = [...this.extraArgs(), ...buildClaudeArgs(request)];
    const child = this.spawnFn(binary, args, {
      cwd: request.cwd,
      windowsHide: true,
      ...(request.env ? { env: request.env } : {})
    });
    const state: ClaudeProcessState = {
      sessionId: request.sessionId,
      cwd: request.cwd,
      argsKey,
      binary,
      args,
      child,
      resumeCursor: request.resumeCursor ?? "",
      activeTurnId: turnId,
      liveTasks: 0,
      completedTurn: false,
      errored: false,
      stderr: "",
      startedAt: start,
      agentByCall: new Map(),
      taskToolCalls: new Map(),
      permissionMode: request.permissionMode ?? "auto"
    };
    this.processes.set(request.sessionId, state);
    this.turnToSession.set(turnId, request.sessionId);

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleProcessLine(state, line));
    child.stderr.on("data", (chunk: Buffer) => {
      state.stderr += chunk.toString();
    });
    child.on("error", (err) => {
      state.errored = true;
      traceHarnessCall({
        harness: "claude",
        operation: "claude.startTurn",
        sessionId: request.sessionId,
        turnId: state.activeTurnId,
        cwd: request.cwd,
        binary,
        durationMs: Date.now() - start,
        ok: false,
        error: truncateError(`failed to spawn ${binary}: ${err.message}`)
      });
      this.emit({ type: "turn.error", turnId: state.activeTurnId, message: `failed to spawn ${binary}: ${err.message}` });
    });
    child.on("close", (code) => this.handleProcessClose(state, code));

    traceHarnessCall({
      harness: "claude",
      operation: "claude.startTurn",
      sessionId: request.sessionId,
      turnId,
      cwd: request.cwd,
      binary,
      args,
      model: request.model,
      promptPreview: preview.preview,
      promptLength: preview.length,
      resumeCursor: request.resumeCursor,
      durationMs: Date.now() - start,
      ok: true,
      extra: { reused: false }
    });
    this.writeUserMessage(state, request);

    return { turnId, events: (async function* () {})() };
  }

  interrupt(turnId: string): void {
    traceHarnessCall({ harness: "claude", operation: "claude.interrupt", turnId, ok: true });
    const sessionId = this.turnToSession.get(turnId);
    const state = sessionId ? this.processes.get(sessionId) : undefined;
    if (!state) {
      this.resolvePendingForTurn(turnId);
      this.turnToSession.delete(turnId);
      return;
    }
    this.interruptedTurns.add(turnId);
    const line = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" }
    });
    try {
      if (!state.child.stdin) throw new Error("stdin unavailable");
      state.child.stdin.write(`${line}\n`);
    } catch {
      this.killFn(state.child);
    }
    this.resolvePendingForTurn(turnId);
    state.completedTurn = true;
    this.turnToSession.delete(turnId);
  }

  stopSession(sessionId: string): void {
    const state = this.processes.get(sessionId);
    if (!state) return;
    traceHarnessCall({ harness: "claude", operation: "claude.stopSession", sessionId, ok: true });
    this.clearIdleTimer(state);
    this.processes.delete(sessionId);
    this.killFn(state.child);
  }

  dispose(): void {
    for (const sessionId of [...this.processes.keys()]) this.stopSession(sessionId);
  }

  private handleControl(control: ClaudeControlRequest, state: ClaudeProcessState): void {
    const turnId = state.activeTurnId;
    if (control.toolName.toLowerCase() === "askuserquestion") {
      const question = claudeQuestionRequest(control, turnId);
      if (question) {
        this.pendingQuestions.set(control.requestId, { turnId, sessionId: state.sessionId, control });
        this.emit({ type: "question.request", turnId, request: question });
      } else {
        this.writeControl(state.sessionId, claudeDenyResponse(control.requestId, "Denied automatically: AskUserQuestion arrived without usable questions."));
      }
      return;
    }
    if (state.permissionMode === "bypassPermissions") {
      this.writeControl(state.sessionId, claudeAllowResponse(control.requestId, control.input));
      traceHarnessCall({
        harness: "claude",
        operation: "claude.autoAllowBypass",
        turnId,
        cwd: state.cwd || undefined,
        ok: true,
        extra: { requestId: control.requestId, toolName: control.toolName }
      });
      return;
    }
    if (this.sessionAllows.get(state.sessionId)?.has(control.toolName)) {
      this.writeControl(state.sessionId, claudeAllowResponse(control.requestId, control.input));
      traceHarnessCall({
        harness: "claude",
        operation: "claude.autoAllowSession",
        turnId,
        cwd: state.cwd || undefined,
        ok: true,
        extra: { requestId: control.requestId, toolName: control.toolName }
      });
      return;
    }
    this.pendingApprovals.set(control.requestId, {
      turnId,
      control,
      cwd: state.cwd,
      localSessionId: state.sessionId
    });
    this.emit({
      type: "approval.request",
      turnId,
      request: claudeApprovalRequest(control, turnId, state.cwd || undefined)
    });
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.pendingApprovals.get(requestId);
    if (!entry) return;
    this.pendingApprovals.delete(requestId);
    const { turnId, control, cwd, localSessionId } = entry;
    if (decision === "accept" || decision === "acceptForSession" || decision === "acceptGlobal") {
      if (localSessionId && (decision === "acceptForSession" || decision === "acceptGlobal")) {
        let allowed = this.sessionAllows.get(localSessionId);
        if (!allowed) {
          allowed = new Set<string>();
          this.sessionAllows.set(localSessionId, allowed);
        }
        allowed.add(control.toolName);
      }
      if (decision === "acceptGlobal") {
        await this.persistGlobalAllow(control.toolName, control.input, cwd, turnId);
      }
      this.writeControl(localSessionId, claudeAllowResponse(requestId, control.input));
    } else {
      const message = decision === "cancel" ? "Cancelled by user." : "Denied by user.";
      this.writeControl(localSessionId, claudeDenyResponse(requestId, message));
    }
    this.emit({ type: "approval.resolved", turnId, requestId });
    traceHarnessCall({
      harness: "claude",
      operation: "claude.respondToApproval",
      turnId,
      cwd: cwd || undefined,
      ok: true,
      extra: { requestId, decision, toolName: control.toolName }
    });
  }

  private async persistGlobalAllow(toolName: string, input: unknown, cwd: string, turnId: string): Promise<void> {
    const rule = buildClaudeAllowRule(toolName, input);
    if (!cwd.trim()) {
      const message = `Could not save global allow rule "${rule}": turn has no cwd, refusing to write settings to the process cwd.`;
      traceHarnessCall({
        harness: "claude",
        operation: "claude.persistGlobalAllow",
        turnId,
        ok: false,
        error: truncateError(message)
      });
      this.emit({ type: "turn.error", turnId, message });
      return;
    }
    const filePath = claudeSettingsPath(cwd);
    try {
      let raw: string | null = null;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      }
      let existing: unknown = null;
      if (raw !== null) {
        try {
          existing = JSON.parse(raw);
        } catch (err) {
          throw new Error(`existing settings are not valid JSON: ${(err as Error).message}`);
        }
        if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
          throw new Error("existing settings are not a JSON object; refusing to overwrite");
        }
      }
      const next = mergeClaudeAllowRule(existing, rule);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
      traceHarnessCall({
        harness: "claude",
        operation: "claude.persistGlobalAllow",
        turnId,
        cwd: cwd || undefined,
        ok: true,
        extra: { rule, filePath }
      });
    } catch (err) {
      const message = `Could not save global allow rule "${rule}" to ${filePath}: ${(err as Error).message}`;
      traceHarnessCall({
        harness: "claude",
        operation: "claude.persistGlobalAllow",
        turnId,
        cwd: cwd || undefined,
        ok: false,
        error: truncateError(message)
      });
      this.emit({ type: "turn.error", turnId, message });
    }
  }

  async respondToQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const entry = this.pendingQuestions.get(requestId);
    if (!entry) return;
    this.pendingQuestions.delete(requestId);
    this.writeControl(entry.sessionId, claudeControlResponse(requestId, entry.control.input, answers));
    this.emit({
      type: "question.resolved",
      turnId: entry.turnId,
      requestId,
      answers
    });
  }

  async renameSession(): Promise<void> {}

  async *events(): AsyncIterable<never> {}
}
