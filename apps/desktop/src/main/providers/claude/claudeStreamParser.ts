import type { ApprovalDecision, ApprovalRequest, QuestionInfo, QuestionOption, QuestionRequest, ThreadEvent } from "@cw-code/contracts";
import { todosFromToolCall } from "../todos.js";

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
    delta?: { type?: string; text?: string };
  };
}

interface AssistantMsg {
  type: "assistant";
  message?: {
    content?: Array<
      | { type: "text"; text?: string }
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
  usage?: { input_tokens?: number; output_tokens?: number };
  num_turns?: number;
  is_error?: boolean;
}

export interface ClaudeTasksInfo {
  liveTasks: number;
}

interface SystemTasksMsg {
  type: "system";
  subtype?: string;
  tasks?: unknown;
}

export function parseClaudeSystemLine(line: string): ClaudeTasksInfo | null {
  let msg: SystemTasksMsg;
  try {
    msg = JSON.parse(line) as SystemTasksMsg;
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== "object") return null;
  if (msg.type !== "system" || msg.subtype !== "background_tasks_changed") return null;
  if (!Array.isArray(msg.tasks)) return null;
  return { liveTasks: msg.tasks.length };
}

export interface TurnDoneInfo {
  resumeCursor: string;
  resultText: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  numTurns: number;
  isError: boolean;
}

const AGENT_ID_RE = /\bagentId:\s*([0-9a-f]{8,64})\b/;

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
  onNotificationAck?: () => void
): ThreadEvent[] {
  if (!line.trim()) return [];
  let msg: TextDelta | AssistantMsg | UserMsg | ResultMsg;
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return [{ type: "assistant.delta", turnId, text: line }];
  }

  if (msg.type === "stream_event") {
    const text = msg.event?.delta?.type === "text_delta" ? (msg.event.delta.text ?? "") : "";
    return text ? [{ type: "assistant.delta", turnId, text }] : [];
  }

  if (msg.type === "assistant") {
    const out: ThreadEvent[] = [];
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && "text" in block && block.text) {
        out.push({ type: "assistant.delta", turnId, text: block.text });
      } else if (block.type === "tool_use" && "id" in block) {
        out.push({
          type: "tool.call",
          turnId,
          toolCallId: block.id ?? `${turnId}-tool`,
          name: block.name ?? "unknown",
          input: block.input ?? null
        });
        const todos = todosFromToolCall(block.name ?? "", block.input ?? null);
        if (todos !== null) out.push({ type: "todo.updated", turnId, todos });
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
        const content =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
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
    if (msg.origin?.kind === "task-notification" && (msg.num_turns ?? 0) === 0) {
      onNotificationAck?.();
      return [];
    }
    done({
      resumeCursor: msg.session_id ?? sessionId,
      resultText: msg.result ?? "",
      inputTokens: msg.usage?.input_tokens ?? 0,
      outputTokens: msg.usage?.output_tokens ?? 0,
      costUsd: msg.total_cost_usd ?? 0,
      numTurns: msg.num_turns ?? 0,
      isError: msg.is_error === true || msg.subtype === "error"
    });
    return [];
  }

  return [];
}
