import type { ApprovalDecision, ApprovalRequest, ContextUsage, QuestionInfo, QuestionOption, QuestionRequest, ThreadEvent, ToolUsage, TurnModelUsage } from "@cw-code/contracts";
import { todosFromToolCall } from "../todos.js";
import { claudeTurnUsage, type ClaudeModelUsageSnapshot } from "./claudeUsage.js";

interface ControlRequestMsg {
  type: "control_request";
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    tool_use_id?: string;
    input?: unknown;
  };
}

export interface ClaudeControlRequest {
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: unknown;
}

export function parseClaudeControlRequest(line: string): ClaudeControlRequest | null {
  if (!line.trim().startsWith("{")) return null;
  let msg: ControlRequestMsg;
  try {
    msg = JSON.parse(line) as ControlRequestMsg;
  } catch {
    return null;
  }
  if (msg.type !== "control_request" || typeof msg.request_id !== "string") return null;
  if (msg.request?.subtype !== "can_use_tool" || typeof msg.request.tool_name !== "string") return null;
  return {
    requestId: msg.request_id,
    toolName: msg.request.tool_name,
    toolUseId: typeof msg.request.tool_use_id === "string" ? msg.request.tool_use_id : undefined,
    input: msg.request.input ?? null
  };
}

function optionOf(entry: unknown): QuestionOption | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const label = (entry as Record<string, unknown>)["label"];
  if (typeof label !== "string" || !label) return null;
  const description = (entry as Record<string, unknown>)["description"];
  return {
    label,
    ...(typeof description === "string" && description ? { description } : {})
  };
}

export function claudeQuestionRequest(control: ClaudeControlRequest, turnId: string): QuestionRequest | null {
  if (control.toolName.toLowerCase() !== "askuserquestion") return null;
  const input = control.input as { questions?: unknown } | null;
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  const questions: QuestionInfo[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const args = entry as Record<string, unknown>;
    if (typeof args["question"] !== "string" || !args["question"]) continue;
    const rawOptions = Array.isArray(args["options"]) ? args["options"] : [];
    const options = rawOptions
      .map(optionOf)
      .filter((o): o is QuestionOption => o !== null);
    questions.push({
      question: args["question"],
      ...(typeof args["header"] === "string" && args["header"] ? { header: args["header"] } : {}),
      options,
      multiSelect: args["multiSelect"] === true,
      allowCustom: true
    });
  }
  if (questions.length === 0) return null;
  return { requestId: control.requestId, turnId, questions };
}

interface ControlResponseEnvelope {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response:
      | { behavior: "allow"; updatedInput: unknown }
      | { behavior: "deny"; message: string };
  };
}

export function claudeControlResponse(
  requestId: string,
  originalInput: unknown,
  answers: Record<string, string>
): string {
  const input = originalInput as { questions?: unknown } | null;
  const body: ControlResponseEnvelope["response"]["response"] = {
    behavior: "allow",
    updatedInput: {
      ...(input?.questions !== undefined ? { questions: input.questions } : {}),
      answers
    }
  };
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: body }
  } satisfies ControlResponseEnvelope);
}

export function claudeDenyResponse(requestId: string, message: string): string {
  const body: ControlResponseEnvelope["response"]["response"] = {
    behavior: "deny",
    message
  };
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: body }
  } satisfies ControlResponseEnvelope);
}

export function claudeAllowResponse(requestId: string, input: unknown): string {
  const body: ControlResponseEnvelope["response"]["response"] = {
    behavior: "allow",
    updatedInput: input ?? {}
  };
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: body }
  } satisfies ControlResponseEnvelope);
}

export function buildClaudeAllowRule(toolName: string, input: unknown): string {
  void input;
  return toolName.trim() || "unknown";
}

const CLAUDE_APPROVAL_DECISIONS: ApprovalDecision[] = [
  "accept",
  "acceptForSession",
  "acceptGlobal",
  "decline",
  "cancel"
];

const CLAUDE_COMMAND_TOOLS = new Set(["bash", "powershell"]);
const CLAUDE_FILE_TOOLS = new Set(["edit", "write", "multiedit"]);

const CLAUDE_DETAIL_MAX = 2000;

function truncateClaudeDetail(text: string): string {
  return text.length <= CLAUDE_DETAIL_MAX ? text : `${text.slice(0, CLAUDE_DETAIL_MAX)}…[len=${text.length}]`;
}

function claudeInputCommand(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const command = (input as Record<string, unknown>)["command"];
    if (typeof command === "string") return command;
  }
  return "";
}

function claudeInputFilePath(input: unknown): string {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ["file_path", "filePath", "path"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return "";
}

function claudeInputJson(input: unknown): string {
  if (input === null || input === undefined) return "";
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

export function claudeApprovalRequest(
  control: ClaudeControlRequest,
  turnId: string,
  cwd?: string
): ApprovalRequest {
  void turnId;
  const toolName = control.toolName;
  const lower = toolName.toLowerCase();
  const decisions = [...CLAUDE_APPROVAL_DECISIONS];
  const base = {
    requestId: control.requestId,
    decisions,
    toolName,
    ...(cwd ? { cwd } : {})
  };
  if (CLAUDE_COMMAND_TOOLS.has(lower)) {
    const command = claudeInputCommand(control.input);
    const firstLine = command.split("\n").map((line) => line.trim()).find((line) => line) ?? "";
    const title = (firstLine || toolName).slice(0, 120);
    const parts = [command, cwd ? `cwd: ${cwd}` : ""].filter(Boolean);
    const details = parts.length > 0 ? truncateClaudeDetail(parts.join("\n")) : undefined;
    return { ...base, kind: "command", title, ...(details ? { details } : {}) };
  }
  if (CLAUDE_FILE_TOOLS.has(lower)) {
    const filePath = claudeInputFilePath(control.input);
    const title = (filePath ? `${toolName} ${filePath}` : toolName).slice(0, 120);
    const json = claudeInputJson(control.input);
    return { ...base, kind: "fileChange", title, ...(json ? { details: truncateClaudeDetail(json) } : {}) };
  }
  const json = claudeInputJson(control.input);
  return { ...base, kind: "permissions", title: toolName, ...(json ? { details: truncateClaudeDetail(json) } : {}) };
}


interface TextDelta {
  type: "stream_event";
  event?: {
    delta?: { type?: string; text?: string; thinking?: string };
  };
}

interface AssistantMsg {
  type: "assistant";
  parent_tool_use_id?: string | null;
  message?: {
    content?: Array<
      | { type: "text"; text?: string }
      | { type: "thinking"; thinking?: string }
      | { type: "tool_use"; id?: string; name?: string; input?: unknown }
      | { type?: string }
    >;
  };
}

interface UserMsg {
  type: "user";
  message?: {
    content?: unknown;
  };
}

export interface ClaudeTaskNotification {
  toolUseId: string;
  status?: string;
  result: string;
}

const TASK_NOTIFY_RE = {
  toolUseId: /<tool-use-id>([\s\S]*?)<\/tool-use-id>/,
  status: /<status>([\s\S]*?)<\/status>/,
  result: /<result>([\s\S]*?)<\/result>/
};

export function parseClaudeTaskNotification(text: string): ClaudeTaskNotification | null {
  if (!text.trimStart().startsWith("<task-notification>")) return null;
  const toolUseId = TASK_NOTIFY_RE.toolUseId.exec(text)?.[1]?.trim();
  const result = TASK_NOTIFY_RE.result.exec(text)?.[1];
  if (!toolUseId || result === undefined) return null;
  const status = TASK_NOTIFY_RE.status.exec(text)?.[1]?.trim();
  return { toolUseId, ...(status ? { status } : {}), result };
}

interface ResultMsg {
  type: "result";
  subtype?: string;
  subkind?: string;
  origin?: { kind?: string };
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; iterations?: unknown };
  modelUsage?: unknown;
  num_turns?: number;
  is_error?: boolean;
}

export interface ClaudeTaskSystemInfo {
  kind: "tasks" | "started" | "progress" | "updated" | "notification";
  liveTasks?: number;
  liveTaskIds?: string[];
  taskId?: string;
  toolUseId?: string;
  taskType?: string;
  description?: string;
  subagentType?: string;
  background?: boolean;
  prompt?: string;
  status?: string;
  summary?: string;
  endTime?: number;
  lastToolName?: string;
  usage?: ToolUsage;
}

interface TaskUsageMsg {
  total_tokens?: unknown;
  tool_uses?: unknown;
  duration_ms?: unknown;
}

interface TaskPatchMsg {
  status?: unknown;
  end_time?: unknown;
}

interface SystemTaskMsg {
  type?: unknown;
  subtype?: unknown;
  tasks?: unknown;
  task_id?: unknown;
  tool_use_id?: unknown;
  task_type?: unknown;
  description?: unknown;
  subagent_type?: unknown;
  is_backgrounded?: unknown;
  prompt?: unknown;
  status?: unknown;
  summary?: unknown;
  last_tool_name?: unknown;
  usage?: unknown;
  patch?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function taskNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function taskUsage(value: unknown): ToolUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as TaskUsageMsg;
  const mapped: ToolUsage = {};
  const tokens = taskNumber(usage.total_tokens);
  if (tokens !== undefined) mapped.tokens = tokens;
  const toolUses = taskNumber(usage.tool_uses);
  if (toolUses !== undefined) mapped.toolUses = toolUses;
  const durationMs = taskNumber(usage.duration_ms);
  if (durationMs !== undefined) mapped.durationMs = durationMs;
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function claudeToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
        const record = block as Record<string, unknown>;
        if (record["type"] !== "text" || typeof record["text"] !== "string") return undefined;
        return record["text"];
      })
      .filter((value): value is string => value !== undefined);
    if (text.length === content.length) return text.join("\n");
  }
  return JSON.stringify(content ?? "");
}

export function parseClaudeTaskSystemLine(line: string): ClaudeTaskSystemInfo | null {
  if (!line.trim().startsWith("{") || !line.includes('"type":"system"')) return null;
  let msg: SystemTaskMsg;
  try {
    msg = JSON.parse(line) as SystemTaskMsg;
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== "object" || msg.type !== "system") return null;
  const taskId = str(msg.task_id);
  const toolUseId = str(msg.tool_use_id);
  const taskType = str(msg.task_type);
  const description = str(msg.description);
  const usage = taskUsage(msg.usage);
  switch (msg.subtype) {
    case "background_tasks_changed": {
      if (!Array.isArray(msg.tasks)) return null;
      const liveTaskIds = msg.tasks
        .map((task) => {
          if (task !== null && typeof task === "object" && !Array.isArray(task)) {
            const record = task as Record<string, unknown>;
            return str(record["id"]) ?? str(record["task_id"]);
          }
          return str(task);
        })
        .filter((id): id is string => id !== undefined);
      return { kind: "tasks", liveTasks: msg.tasks.length, liveTaskIds };
    }
    case "task_started": {
      if (!taskId && !toolUseId) return null;
      const prompt = str(msg.prompt);
      const subagentType = str(msg.subagent_type);
      return {
        kind: "started",
        ...(taskId ? { taskId } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        ...(taskType ? { taskType } : {}),
        ...(description ? { description } : {}),
        ...(subagentType ? { subagentType } : {}),
        ...(typeof msg.is_backgrounded === "boolean" ? { background: msg.is_backgrounded } : {}),
        ...(prompt ? { prompt } : {})
      };
    }
    case "task_progress": {
      if (!taskId) return null;
      const lastToolName = str(msg.last_tool_name);
      return {
        kind: "progress",
        taskId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(description ? { description } : {}),
        ...(lastToolName ? { lastToolName } : {}),
        ...(usage ? { usage } : {})
      };
    }
    case "task_updated": {
      if (!taskId) return null;
      const patch =
        msg.patch !== null && typeof msg.patch === "object" && !Array.isArray(msg.patch)
          ? (msg.patch as TaskPatchMsg)
          : {};
      const status = str(patch.status);
      const endTime = taskNumber(patch.end_time);
      if (!status && endTime === undefined) return null;
      return {
        kind: "updated",
        taskId,
        ...(status ? { status } : {}),
        ...(endTime !== undefined ? { endTime } : {})
      };
    }
    case "task_notification": {
      if (!taskId) return null;
      const status = str(msg.status);
      const summary = str(msg.summary);
      return {
        kind: "notification",
        taskId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(status ? { status } : {}),
        ...(summary ? { summary } : {}),
        ...(usage ? { usage } : {})
      };
    }
    default:
      return null;
  }
}

export interface ClaudeSystemInitInfo {
  terminalSlashCommands: string[];
  model?: string;
}

interface SystemInitMsg {
  type?: unknown;
  subtype?: unknown;
  terminal_slash_commands?: unknown;
  model?: unknown;
}

export function parseClaudeSystemInit(line: string): ClaudeSystemInitInfo | null {
  if (!line.trim().startsWith("{") || !line.includes('"subtype":"init"')) return null;
  let msg: SystemInitMsg;
  try {
    msg = JSON.parse(line) as SystemInitMsg;
  } catch {
    return null;
  }
  if (msg.type !== "system" || msg.subtype !== "init") return null;
  const terminalSlashCommands = Array.isArray(msg.terminal_slash_commands)
    ? msg.terminal_slash_commands.filter((c): c is string => typeof c === "string")
    : [];
  const model = typeof msg.model === "string" && msg.model ? msg.model : undefined;
  return { terminalSlashCommands, ...(model ? { model } : {}) };
}

const TASK_NOTIFY_USAGE_RE = {
  tokens: /<subagent_tokens>(\d+)<\/subagent_tokens>/,
  toolUses: /<tool_uses>(\d+)<\/tool_uses>/,
  durationMs: /<duration_ms>(\d+)<\/duration_ms>/
};

export function parseTaskNotificationUsage(text: string): ToolUsage | undefined {
  const usage: ToolUsage = {};
  const tokens = TASK_NOTIFY_USAGE_RE.tokens.exec(text)?.[1];
  if (tokens !== undefined) usage.tokens = Number.parseInt(tokens, 10);
  const toolUses = TASK_NOTIFY_USAGE_RE.toolUses.exec(text)?.[1];
  if (toolUses !== undefined) usage.toolUses = Number.parseInt(toolUses, 10);
  const durationMs = TASK_NOTIFY_USAGE_RE.durationMs.exec(text)?.[1];
  if (durationMs !== undefined) usage.durationMs = Number.parseInt(durationMs, 10);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export interface TurnDoneInfo {
  resumeCursor: string;
  resultText: string;
  usage: TurnModelUsage[];
  context?: ContextUsage;
  modelUsage: ClaudeModelUsageSnapshot;
  numTurns: number;
  isError: boolean;
}

const AGENT_ID_RE = /\bagentId:\s*([0-9a-f]{8,64})\b/;

export function parseClaudeSubagentHandback(
  event: ThreadEvent
): Extract<ThreadEvent, { type: "tool.result" }> | null {
  if (event.type !== "tool.call" || event.name.toLowerCase() !== "subagenthandback" || !event.parentToolCallId) return null;
  if (event.input === null || typeof event.input !== "object" || Array.isArray(event.input)) return null;
  const message = (event.input as Record<string, unknown>)["message"];
  if (typeof message !== "string" || !message.trim()) return null;
  return {
    type: "tool.result",
    turnId: event.turnId,
    toolCallId: event.parentToolCallId,
    output: message.slice(0, 8000),
    isError: false
  };
}

export function attributeClaudeSubagentEvent(
  event: ThreadEvent,
  agentByCall: Map<string, string>
): ThreadEvent {
  if (event.type === "tool.result") {
    const agentId = AGENT_ID_RE.exec(event.output)?.[1];
    if (agentId) agentByCall.set(event.toolCallId, agentId);
    return event;
  }
  if (
    event.type !== "tool.call" ||
    event.parentToolCallId ||
    event.name.toLowerCase() !== "sendmessage" ||
    !event.input ||
    typeof event.input !== "object" ||
    Array.isArray(event.input)
  ) {
    return event;
  }
  const recipient = (event.input as Record<string, unknown>)["to"];
  if (typeof recipient !== "string") return event;
  for (const [callId, agentId] of agentByCall) {
    if (agentId === recipient) return { ...event, parentToolCallId: callId };
  }
  return event;
}

export function parseStreamLine(
  line: string,
  turnId: string,
  sessionId: string,
  done: (info: TurnDoneInfo) => void,
  onNotificationAck?: () => void,
  shouldIgnoreTaskNotification?: () => boolean,
  prevModelUsage: ClaudeModelUsageSnapshot = {},
  mainModel?: string
): ThreadEvent[] {
  if (!line.trim()) return [];
  let msg: TextDelta | AssistantMsg | UserMsg | ResultMsg;
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return [{ type: "assistant.delta", turnId, text: line }];
  }

  if (msg.type === "stream_event") {
    const delta = msg.event?.delta;
    if (delta?.type === "thinking_delta") {
      return delta.thinking ? [{ type: "reasoning.delta", turnId, text: delta.thinking }] : [];
    }
    const text = delta?.type === "text_delta" ? (delta.text ?? "") : "";
    return text ? [{ type: "assistant.delta", turnId, text }] : [];
  }

  if (msg.type === "assistant") {
    const parentToolCallId = msg.parent_tool_use_id ?? undefined;
    const out: ThreadEvent[] = [];
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_use" && "id" in block) {
        out.push({
          type: "tool.call",
          turnId,
          toolCallId: block.id ?? `${turnId}-tool`,
          name: block.name ?? "unknown",
          input: block.input ?? null,
          ...(parentToolCallId ? { parentToolCallId } : {})
        });
        if (!parentToolCallId) {
          const todos = todosFromToolCall(block.name ?? "", block.input ?? null);
          if (todos !== null) out.push({ type: "todo.updated", turnId, todos });
        }
        continue;
      }
      if (parentToolCallId) continue;
      if (block.type === "text" && "text" in block && block.text) {
        out.push({ type: "assistant.delta", turnId, text: block.text });
      } else if (block.type === "thinking" && "thinking" in block && block.thinking) {
        out.push({ type: "reasoning.delta", turnId, text: block.thinking });
      }
    }
    return out;
  }

  if (msg.type === "user") {
    const raw = (msg as UserMsg).message?.content;
    if (typeof raw === "string") {
      const notif = parseClaudeTaskNotification(raw);
      if (!notif) return [];
      return [
        {
          type: "tool.result",
          turnId,
          toolCallId: notif.toolUseId,
          output: notif.result.slice(0, 8000),
          isError: notif.status ? notif.status.toLowerCase() !== "completed" : false
        }
      ];
    }
    const out: ThreadEvent[] = [];
    const blocks = Array.isArray(raw) ? raw : [];
    for (const block of blocks as Array<{ tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.tool_use_id) {
        const content = claudeToolResultText(block.content);
        out.push({
          type: "tool.result",
          turnId,
          toolCallId: block.tool_use_id,
          output: content.slice(0, 8000),
          isError: block.is_error === true
        });
      }
    }
    return out;
  }

  if (msg.type === "result") {
    if (msg.origin?.kind === "task-notification" && (shouldIgnoreTaskNotification?.() ?? true)) {
      onNotificationAck?.();
      return [];
    }
    const { usage, context, next } = claudeTurnUsage(prevModelUsage, msg, mainModel);
    done({
      resumeCursor: msg.session_id ?? sessionId,
      resultText: msg.result ?? "",
      usage,
      ...(context ? { context } : {}),
      modelUsage: next,
      numTurns: msg.num_turns ?? 0,
      isError: msg.is_error === true || msg.subtype === "error"
    });
    return [];
  }

  return [];
}
