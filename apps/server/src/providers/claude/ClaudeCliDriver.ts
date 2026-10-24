import type { ChildProcess, ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type {
  AccountUsageState,
  AppSettings,
  ApprovalDecision,
  CliDriver,
  CommandOption,
  DriverActivity,
  EffortLevel,
  HistoryMessage,
  NativeSession,
  PermissionMode,
  PermissionOption,
  SubagentToolsResult,
  TaskEndReason,
  TaskSnapshot,
  TaskState,
  ThreadEvent,
  TurnHandle,
  TurnRequest
} from "@cw-code/contracts";
import { parseExtraArgs } from "../../settings/settingsUtils.js";
import { detachProcessGroup, hasExited, killProcessTree, waitForExit } from "../../processTree.js";
import { sanitizedChildEnv } from "../../shellEnvironment.js";
import { spawnCli } from "../../cli/spawnCli.js";
import { TaskTable, type TaskObservation } from "../../tasks/TaskTable.js";
import { SYNTHETIC_FULL_ACCESS_DESCRIPTION } from "../permissions.js";
import { attributeClaudeSubagentEvent, buildClaudeAllowRule, claudeAllowResponse, claudeApprovalRequest, claudeQuestionRequest, claudeDenyResponse, claudeControlResponse, parseClaudeCompactBoundary, parseClaudeControlRequest, parseClaudeSubagentHandback, parseClaudeSystemInit, parseClaudeTaskNotificationLine, parseClaudeTaskSystemLine, parseClaudeToolUseResult, parseStreamLine, type ClaudeControlRequest, type ClaudeTaskNotificationLine, type ClaudeTaskSystemInfo, type TurnDoneInfo } from "./claudeStreamParser.js";
import { claudeCallObservation, claudeHandbackObservation, claudeNotificationObservation, claudeSystemTaskObservation, claudeToolResultObservation, findClaudeTaskNotification } from "./claudeTasks.js";
import {
  CLAUDE_COMMANDS_PROBE_ARGS,
  listClaudeCommands,
  probeClaudeCommands,
  recordClaudeSkills,
  recordClaudeTerminalCommands
} from "./claudeCommands.js";
import { CLAUDE_ACCOUNT_USAGE_PROBE_ARGS, probeClaudeAccountUsage } from "./claudeAccountUsage.js";
import { describeClaudeExit } from "./claudeExit.js";
import { claudeTranscriptProjectDir, listClaudeSessions, listNativeClaudeSessions } from "./claudeSessions.js";
import { readClaudeHistory, readSidecarAgent, readClaudeTaskResult, findSidecarModel, type SidecarAgent } from "./claudeHistory.js";
import { buildClaudeUserContent, claudePromptText } from "./claudeUserContent.js";
import { previewText, traceHarnessCall, truncateError } from "../../debug/harnessTrace.js";
import type { ClaudeModelUsageSnapshot } from "./claudeUsage.js";

export const CLAUDE_CURATED_MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "fable", label: "Fable 5.1" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
];

export function mapClaudePermission(mode: PermissionMode | string): string {
  if (mode === "acceptEdits") return "acceptEdits";
  if (mode === "bypassPermissions") return "manual";
  if (mode === "manual") return "manual";
  return "auto";
}

export function listClaudePermissionModes(): PermissionOption[] {
  return [
    { id: "manual", label: "Manual", description: "Reads only; asks before edits, commands, and network.", native: true },
    { id: "acceptEdits", label: "Accept edits", description: "Reads, file edits, and common filesystem commands run without asking.", native: true },
    { id: "auto", label: "Auto", description: "Everything runs with background safety checks instead of prompts.", native: true },
    { id: "bypassPermissions", label: "Bypass permissions", description: SYNTHETIC_FULL_ACCESS_DESCRIPTION, native: false }
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

const CLI_TERMINAL_TASK_STATES = new Set<TaskState>(["completed", "failed", "stopped"]);

function hasCallRow(task: TaskSnapshot): boolean {
  return task.id !== task.cliTaskId;
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
  tasks: TaskTable;
  completedTurn: boolean;
  heldByBackgroundWork: boolean;
  errored: boolean;
  stderr: string;
  startedAt: number;
  lastActivityAt: number;
  postCompletionOutputPending: boolean;
  agentByCall: Map<string, string>;
  suppressedCallIds: Set<string>;
  topLevelAgentCalls: Set<string>;
  childCalls: Map<string, string[]>;
  turnStartedAt: number;
  shellResults: Map<string, string>;
  permissionMode: PermissionMode;
  reportedPermissionMode?: string;
  idleTimer?: NodeJS.Timeout;
  modelUsage: ClaudeModelUsageSnapshot;
  mainModel?: string;
  compactedPostTokens?: number;
  apiErrorMessage?: string;
  lastWindowTokens?: number;
}

export class ClaudeCliDriver implements CliDriver {
  readonly kind = "claude" as const;
  private processes = new Map<string, ClaudeProcessState>();
  private turnToSession = new Map<string, string>();
  private interruptedTurns = new Set<string>();
  private pendingQuestions = new Map<string, { turnId: string; sessionId: string; control: ClaudeControlRequest }>();
  private pendingApprovals = new Map<string, PendingClaudeApproval>();
  private sessionAllows = new Map<string, Set<string>>();
  private shuttingDown = false;

  constructor(
    private emit: (event: ThreadEvent) => void,
    private getSettings: () => AppSettings,
    private spawnFn: typeof spawn = spawnCli as typeof spawn,
    private killFn: (proc: ChildProcess | undefined) => void = killProcessTree,
    private isInWorkingSet: (sessionId: string) => boolean = () => false
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
      `${JSON.stringify({ type: "user", message: { role: "user", content: buildClaudeUserContent(request.cwd, claudePromptText(request), request.attachments) } })}\n`
    );
  }

  private isProcessAlive(state: ClaudeProcessState): boolean {
    return !state.errored && state.child.exitCode === null && state.child.signalCode === null;
  }

  private killChild(state: ClaudeProcessState): void {
    if (hasExited(state.child)) return;
    this.killFn(state.child);
  }

  private terminate(state: ClaudeProcessState): void {
    this.clearIdleTimer(state);
    this.closeTasks(state, "interrupted", "process-exit");
    this.killChild(state);
    if (this.processes.get(state.sessionId) === state) this.processes.delete(state.sessionId);
  }

  private clearIdleTimer(state: ClaudeProcessState): void {
    if (!state.idleTimer) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  private isTopLevelAssistantActivity(line: string): boolean {
    try {
      const message = JSON.parse(line) as { type?: unknown; parent_tool_use_id?: unknown };
      if (message.type !== "assistant" && message.type !== "stream_event") return false;
      return typeof message.parent_tool_use_id !== "string" || message.parent_tool_use_id.length === 0;
    } catch {
      return false;
    }
  }

  private noteProcessActivity(state: ClaudeProcessState, line: string): void {
    state.lastActivityAt = Date.now();
    if (state.completedTurn && this.isTopLevelAssistantActivity(line)) {
      state.postCompletionOutputPending = true;
    }
    if (state.idleTimer && (state.completedTurn || state.postCompletionOutputPending)) {
      this.armIdleTimer(state);
    }
  }

  private noteTaskNotificationActivity(state: ClaudeProcessState): void {
    state.lastActivityAt = Date.now();
    if (state.completedTurn || state.postCompletionOutputPending) this.armIdleTimer(state);
  }

  private armIdleTimer(state: ClaudeProcessState, delayMs = CLAUDE_IDLE_EVICT_MS): void {
    this.clearIdleTimer(state);
    if (this.shuttingDown) return;
    const timer = setTimeout(() => {
      if (state.idleTimer !== timer) return;
      state.idleTimer = undefined;
      if (this.processes.get(state.sessionId) !== state) return;
      if (!this.isProcessAlive(state)) {
        this.processes.delete(state.sessionId);
        return;
      }
      if (
        state.tasks.liveCount() > 0 ||
        !state.completedTurn ||
        (state.postCompletionOutputPending && Date.now() - state.lastActivityAt < CLAUDE_IDLE_EVICT_MS) ||
        this.hasPendingForSession(state.sessionId) ||
        this.isInWorkingSet(state.sessionId)
      ) {
        this.armIdleTimer(state);
        return;
      }
      const idleForMs = Date.now() - state.lastActivityAt;
      if (idleForMs < CLAUDE_IDLE_EVICT_MS) {
        this.armIdleTimer(state, CLAUDE_IDLE_EVICT_MS - idleForMs);
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
      this.killChild(state);
    }, delayMs);
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

  private observeTask(state: ClaudeProcessState, obs: TaskObservation | null): void {
    if (!obs) return;
    this.emitTaskUpdates(state, state.tasks.apply(obs));
    this.noteBackgroundWork(state);
  }

  private closeTasks(
    state: ClaudeProcessState,
    taskState: "interrupted" | "unknown",
    reason: TaskEndReason,
    filter?: (task: TaskSnapshot) => boolean
  ): void {
    this.emitTaskUpdates(state, state.tasks.closeOpen(taskState, reason, Date.now(), filter));
  }

  private noteBackgroundWork(state: ClaudeProcessState): void {
    if (state.tasks.liveCount() > 0) state.heldByBackgroundWork = true;
  }

  private emitTaskUpdates(state: ClaudeProcessState, tasks: TaskSnapshot[]): void {
    const ended = new Set<string>();
    for (const task of tasks) {
      this.emit({ type: "task.updated", turnId: state.activeTurnId, sessionId: state.sessionId, task });
      this.emitShellResult(state, task);
      if (task.state !== "running") ended.add(task.id);
    }
    const orphaned = this.descendantsOf(state, ended);
    if (orphaned.size > 0) this.closeTasks(state, "unknown", "no-record", (task) => orphaned.has(task.id));
  }

  private descendantsOf(state: ClaudeProcessState, parents: Set<string>): Set<string> {
    const found = new Set<string>();
    const pending = [...parents];
    while (pending.length > 0) {
      for (const child of state.childCalls.get(pending.pop() ?? "") ?? []) {
        if (found.has(child)) continue;
        found.add(child);
        pending.push(child);
      }
    }
    return found;
  }

  private emitShellResult(state: ClaudeProcessState, task: TaskSnapshot): void {
    if (task.kind !== "shell" || !hasCallRow(task) || !CLI_TERMINAL_TASK_STATES.has(task.state)) return;
    const output = task.output ?? (task.state === "completed" ? undefined : `Background task ${task.state}`);
    if (output === undefined || state.shellResults.get(task.id) === output) return;
    state.shellResults.set(task.id, output);
    this.emit({
      type: "tool.result",
      turnId: state.activeTurnId,
      toolCallId: task.id,
      output,
      isError: task.state !== "completed",
      ...(task.usage ? { usage: task.usage } : {})
    });
  }

  private shouldIgnoreTaskNotification(state: ClaudeProcessState): boolean {
    return state.tasks.liveCount() > 0 || (!state.completedTurn && !state.heldByBackgroundWork);
  }

  private handleToolCall(state: ClaudeProcessState, event: Extract<ThreadEvent, { type: "tool.call" }>): void {
    const handback = parseClaudeSubagentHandback(event);
    if (handback) {
      state.suppressedCallIds.add(event.toolCallId);
      this.observeTask(state, claudeHandbackObservation(handback.toolCallId, handback.output, Date.now()));
      return;
    }
    const call = claudeCallObservation(event.name, event.toolCallId, event.input, Date.now());
    const obs =
      call?.kind === "call" && event.parentToolCallId && call.taskKind === "agent" && call.background === undefined
        ? { ...call, background: false }
        : call;
    if (obs && event.parentToolCallId) {
      state.childCalls.set(event.parentToolCallId, [...(state.childCalls.get(event.parentToolCallId) ?? []), event.toolCallId]);
    }
    if (obs) {
      state.tasks.apply(obs);
      if (obs.kind === "call" && obs.taskKind === "agent" && !event.parentToolCallId) state.topLevelAgentCalls.add(event.toolCallId);
      this.noteBackgroundWork(state);
    }
    const task = obs ? state.tasks.get(event.toolCallId) : undefined;
    this.emit(attributeClaudeSubagentEvent(task ? { ...event, task } : event, state.agentByCall));
  }

  private handleToolResult(
    state: ClaudeProcessState,
    event: Extract<ThreadEvent, { type: "tool.result" }>,
    line: string
  ): void {
    if (state.suppressedCallIds.delete(event.toolCallId)) return;
    this.emit(this.attributeSubagentResult(state, attributeClaudeSubagentEvent(event, state.agentByCall)));
    const kind = state.tasks.get(event.toolCallId)?.kind;
    const endsTaskStartedByThisCall = kind === "agent" || (kind === "shell" && event.isError);
    if (!endsTaskStartedByThisCall) return;
    const structured = parseClaudeToolUseResult(line);
    this.observeTask(
      state,
      claudeToolResultObservation(
        event.toolCallId,
        event.output,
        event.isError,
        structured?.toolUseId === event.toolCallId ? structured.result : undefined,
        Date.now()
      )
    );
  }

  private handleTaskNotificationLine(state: ClaudeProcessState, line: ClaudeTaskNotificationLine): void {
    const notification = findClaudeTaskNotification(line.text);
    if (!notification) return;
    this.observeTask(state, claudeNotificationObservation(notification, Date.now(), line.runId));
  }

  private handleProcessLine(state: ClaudeProcessState, line: string): void {
    this.noteProcessActivity(state, line);
    try {
      const message = JSON.parse(line);
      if (message?.type === "assistant" && message.isApiErrorMessage === true && !message.parent_tool_use_id) {
        const content = message.message?.content;
        const text = Array.isArray(content)
          ? content.filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text).join("\n\n")
          : "";
        state.apiErrorMessage = text || "Claude reported an API error with no output.";
        return;
      }
    } catch {
      // Non-JSON output is handled by the stream parser below.
    }
    const compactBoundary = parseClaudeCompactBoundary(line);
    if (compactBoundary) {
      state.compactedPostTokens = compactBoundary.postTokens;
      const windowTokens = state.lastWindowTokens;
      this.emit({
        type: "context.compacted",
        turnId: state.activeTurnId,
        compaction: compactBoundary,
        ...(compactBoundary.postTokens !== undefined && windowTokens !== undefined
          ? { context: { usedTokens: compactBoundary.postTokens, windowTokens } }
          : {})
      });
      return;
    }
    const taskSystem = parseClaudeTaskSystemLine(line);
    if (taskSystem) {
      this.handleTaskSystem(state, taskSystem);
      return;
    }
    const systemInit = parseClaudeSystemInit(line);
    if (systemInit) {
      recordClaudeTerminalCommands(state.binary, state.cwd, systemInit.terminalSlashCommands);
      if (systemInit.skills) recordClaudeSkills(state.binary, systemInit.skills);
      if (systemInit.model) state.mainModel = systemInit.model;
      if (systemInit.sessionId) state.resumeCursor = systemInit.sessionId;
      if (state.reportedPermissionMode !== systemInit.permissionMode) {
        state.reportedPermissionMode = systemInit.permissionMode;
        this.emit({ type: "permission.mode.reported", turnId: state.activeTurnId, mode: systemInit.permissionMode ?? null });
      }
      return;
    }
    const control = parseClaudeControlRequest(line);
    if (control) {
      this.handleControl(control, state);
      return;
    }
    const notificationLine = parseClaudeTaskNotificationLine(line);
    if (notificationLine) {
      this.handleTaskNotificationLine(state, notificationLine);
      return;
    }
    const events = parseStreamLine(
      line,
      state.activeTurnId,
      state.resumeCursor,
      (info) => this.handleTurnDone(state, info),
      () => this.noteTaskNotificationActivity(state),
      () => this.shouldIgnoreTaskNotification(state),
      state.modelUsage,
      state.mainModel
    );
    for (const event of events) {
      if (event.type === "tool.call") this.handleToolCall(state, event);
      else if (event.type === "tool.result") this.handleToolResult(state, event, line);
      else this.emit(event);
    }
  }

  private subagentModel(state: ClaudeProcessState, agentId: string): string | undefined {
    if (!state.resumeCursor) return undefined;
    const transcriptDir = join(claudeTranscriptProjectDir(state.cwd, state.resumeCursor), state.resumeCursor);
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
    const now = Date.now();
    if (info.kind === "notification") {
      this.observeTask(state, this.taskNotificationObservation(state, info, now));
      return;
    }
    this.observeTask(state, claudeSystemTaskObservation(info, now));
    if (info.kind === "started" && info.taskId && info.toolUseId && state.tasks.get(info.toolUseId)?.kind === "agent") {
      state.agentByCall.set(info.toolUseId, info.taskId);
    }
  }

  private taskNotificationObservation(
    state: ClaudeProcessState,
    info: ClaudeTaskSystemInfo,
    now: number
  ): TaskObservation | null {
    const transcript = info.toolUseId ? readClaudeTaskResult(state.cwd, state.resumeCursor, info.toolUseId) : undefined;
    if (!transcript) return claudeSystemTaskObservation(info, now);
    return claudeNotificationObservation(
      {
        toolUseId: info.toolUseId,
        taskId: info.taskId,
        status: transcript.status ?? info.status,
        result: transcript.result,
        summary: info.summary,
        usage: info.usage
      },
      now,
      info.runId
    );
  }

  private handleTurnDone(state: ClaudeProcessState, info: TurnDoneInfo): void {
    if (state.apiErrorMessage) {
      info = { ...info, isError: true, resultText: state.apiErrorMessage };
    }
    const turnId = state.activeTurnId;
    const interrupted = this.interruptedTurns.delete(turnId);
    const isTurnForeground = (task: TaskSnapshot) => !task.background && state.topLevelAgentCalls.has(task.id);
    if (interrupted) this.closeTasks(state, "interrupted", "interrupt", isTurnForeground);
    else this.closeTasks(state, "unknown", "no-record", isTurnForeground);
    if (state.completedTurn) {
      state.resumeCursor = info.resumeCursor;
      state.modelUsage = info.modelUsage;
      if (interrupted) {
        state.postCompletionOutputPending = false;
        this.armIdleTimer(state);
        return;
      }
      if (state.postCompletionOutputPending) {
        const backgroundTasks = state.tasks.liveCount();
        if (backgroundTasks === 0) {
          this.emit({
            type: "turn.done",
            turnId,
            sessionId: state.sessionId,
            resumeCursor: info.resumeCursor,
            resultText: info.resultText || state.tasks.latestOutput(state.turnStartedAt),
            usage: info.usage,
            ...(info.context ? { context: info.context } : {}),
            numTurns: info.numTurns,
            isError: info.isError,
            backgroundTasks
          });
          state.postCompletionOutputPending = false;
        }
      }
      this.armIdleTimer(state);
      return;
    }
    const backgroundTasks = state.tasks.liveCount();
    state.modelUsage = info.modelUsage;
    if (info.windowTokens !== undefined) state.lastWindowTokens = info.windowTokens;
    const compactedPostTokens = state.compactedPostTokens;
    state.compactedPostTokens = undefined;
    if (!interrupted) {
      const context =
        info.context ??
        (compactedPostTokens !== undefined && info.windowTokens !== undefined
          ? { usedTokens: compactedPostTokens, windowTokens: info.windowTokens }
          : undefined);
      this.emit({
        type: "turn.done",
        turnId,
        sessionId: state.sessionId,
        resumeCursor: info.resumeCursor,
        resultText: info.resultText || state.tasks.latestOutput(state.turnStartedAt),
        usage: info.usage,
        ...(context ? { context } : {}),
        numTurns: info.numTurns,
        isError: info.isError,
        backgroundTasks
      });
    }
    state.resumeCursor = info.resumeCursor;
    state.postCompletionOutputPending = false;
    if (backgroundTasks > 0) {
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
    this.closeTasks(state, "interrupted", "process-exit");
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
      this.emit({
        type: "turn.error",
        turnId,
        message: describeClaudeExit(state.stderr, code),
        ...(state.resumeCursor ? { resumeCursor: state.resumeCursor } : {})
      });
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

  listNativeSessions(): Promise<NativeSession[]> {
    return listNativeClaudeSessions();
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
    const transcriptDir = join(claudeTranscriptProjectDir(projectRoot, resumeCursor), resumeCursor);
    const agent = readSidecarAgent(transcriptDir, agentId) ?? readSidecarAgent(dirname(transcriptDir), agentId);
    return subagentToolsResult(agent);
  }

  async listPermissionModes(): Promise<PermissionOption[]> {
    return listClaudePermissionModes();
  }

  async listCommands(cwd: string): Promise<CommandOption[]> {
    const binary = this.configuredBinary();
    const args = [...this.extraArgs(), ...CLAUDE_COMMANDS_PROBE_ARGS];
    return listClaudeCommands(cwd, binary, args, (b, a, c) => probeClaudeCommands(b, a, c, this.spawnFn, this.killFn));
  }

  startTurn(request: TurnRequest): TurnHandle {
    const turnId = randomUUID();
    const start = Date.now();
    const preview = previewText(request.prompt);
    const binary = this.configuredBinary();
    const argsKey = this.claudeArgsKey(request);
    const existing = this.processes.get(request.sessionId);

    if (existing?.postCompletionOutputPending) {
      throw new Error("Claude is still finishing output for this session");
    }

    if (!request.maxTurns && existing && existing.argsKey === argsKey && this.isProcessAlive(existing)) {
      existing.activeTurnId = turnId;
      existing.completedTurn = false;
      existing.postCompletionOutputPending = false;
      existing.lastActivityAt = Date.now();
      this.compactTasks(existing);
      existing.turnStartedAt = existing.lastActivityAt;
      existing.heldByBackgroundWork = existing.tasks.liveCount() > 0;
      existing.permissionMode = request.permissionMode ?? "auto";
      existing.compactedPostTokens = undefined;
      existing.apiErrorMessage = undefined;
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
      detached: detachProcessGroup,
      env: sanitizedChildEnv(request.env ?? process.env, process.platform)
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
      tasks: new TaskTable(),
      completedTurn: false,
      heldByBackgroundWork: false,
      errored: false,
      stderr: "",
      startedAt: start,
      lastActivityAt: start,
      postCompletionOutputPending: false,
      agentByCall: new Map(),
      suppressedCallIds: new Set(),
      topLevelAgentCalls: new Set(),
      childCalls: new Map(),
      turnStartedAt: start,
      shellResults: new Map(),
      permissionMode: request.permissionMode ?? "auto",
      modelUsage: {}
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
      this.killChild(state);
    }
    this.resolvePendingForTurn(turnId);
    state.completedTurn = true;
    state.postCompletionOutputPending = false;
    this.turnToSession.delete(turnId);
  }

  stopSession(sessionId: string): void {
    const state = this.processes.get(sessionId);
    if (!state) return;
    traceHarnessCall({ harness: "claude", operation: "claude.stopSession", sessionId, ok: true });
    this.clearIdleTimer(state);
    this.processes.delete(sessionId);
    this.closeTasks(state, "interrupted", "process-exit");
    this.killChild(state);
  }

  liveTasks(sessionId: string): TaskSnapshot[] {
    const state = this.processes.get(sessionId);
    if (!state) return [];
    return state.tasks.recentSnapshots(state.turnStartedAt);
  }

  private compactTasks(state: ClaudeProcessState): void {
    for (const id of state.tasks.compact(state.turnStartedAt)) {
      state.shellResults.delete(id);
      state.childCalls.delete(id);
      state.topLevelAgentCalls.delete(id);
    }
  }

  async getAccountUsage(): Promise<AccountUsageState> {
    const binary = this.configuredBinary();
    const args = [...this.extraArgs(), ...CLAUDE_ACCOUNT_USAGE_PROBE_ARGS];
    try {
      return await probeClaudeAccountUsage(binary, args, this.spawnFn, this.killFn);
    } catch (err) {
      const enoent = (err as NodeJS.ErrnoException).code === "ENOENT";
      return enoent
        ? { status: "unavailable", reason: "not-installed", message: "Claude isn't installed. Set its path in Settings → Harnesses → Claude." }
        : { status: "error", message: `failed to spawn ${binary}: ${(err as Error).message}` };
    }
  }

  activity(): DriverActivity {
    const busySessionIds = new Set<string>();
    for (const state of this.processes.values()) {
      const settled = state.completedTurn && !state.postCompletionOutputPending && !this.interruptedTurns.has(state.activeTurnId);
      if (settled && state.tasks.liveCount() === 0) continue;
      busySessionIds.add(state.sessionId);
    }
    return { busySessionIds: [...busySessionIds], ownedProcesses: this.processes.size };
  }

  async shutdown({ timeoutMs }: { timeoutMs: number }): Promise<{ timedOut: boolean }> {
    const states = [...this.processes.values()];
    traceHarnessCall({ harness: "claude", operation: "claude.shutdown", ok: true, extra: { processes: states.length } });
    this.shuttingDown = true;
    for (const state of states) {
      this.clearIdleTimer(state);
      try {
        state.child.stdin.end();
      } catch {
      }
    }
    const exited = await Promise.all(states.map((state) => waitForExit(state.child, timeoutMs)));
    return { timedOut: exited.some((done) => !done) };
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
