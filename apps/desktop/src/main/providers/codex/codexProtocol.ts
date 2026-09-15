import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  EffortLevel,
  HistoryMessage,
  ModelOption,
  PermissionMode,
  QuestionInfo,
  QuestionOption,
  QuestionRequest,
  SessionMeta,
  TodoItem
} from "@cw-code/contracts";
import { todosFromPlan } from "../todos.js";

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexTokenUsage {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export type CodexUserInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string };

export interface CodexFileUpdateChange {
  path: string;
  kind: string;
  diff: string;
}

export interface CodexThreadItem {
  type: string;
  id?: string;
  text?: string;
  phase?: string | null;
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  changes?: CodexFileUpdateChange[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  questions?: unknown;
  result?: unknown;
  content?: Array<{ type?: string; text?: string; path?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
}

export function codexReasoningText(item: CodexThreadItem): string {
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const text = value.trim();
    if (text && !parts.includes(text)) parts.push(text);
  };
  for (const entry of item.summary ?? []) push(entry.text);
  for (const entry of item.content ?? []) push(entry.text);
  push(item.text);
  return parts.join("\n\n");
}

export interface CodexTurnError {
  message?: string;
}

export interface CodexTurn {
  id: string;
  status?: string;
  error?: CodexTurnError | null;
  items?: CodexThreadItem[];
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface CodexThread {
  id: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  model?: string | null;
  createdAt?: number;
  updatedAt?: number;
  ephemeral?: boolean;
  turns?: CodexTurn[];
}

export interface CodexModel {
  id: string;
  displayName?: string;
  isDefault?: boolean;
  hidden?: boolean;
}

export interface CodexCommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}

export interface CodexFileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
}

export interface CodexPermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  permissions?: unknown;
}

export interface CodexPermissionOverrides {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalsReviewer?: "user" | "auto_review";
  planMode: boolean;
}

export function mapPermissionMode(mode: PermissionMode | undefined): CodexPermissionOverrides {
  if (mode === "bypassPermissions") {
    return { approvalPolicy: "never", sandbox: "danger-full-access", planMode: false };
  }
  if (mode === "auto") {
    return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", planMode: false };
  }
  if (mode === "acceptEdits") {
    return { approvalPolicy: "on-request", sandbox: "workspace-write", planMode: false };
  }
  return { approvalPolicy: "untrusted", sandbox: "read-only", planMode: false };
}

export function mapCodexEffort(effort: EffortLevel | string | undefined): string | null {
  if (effort === "minimal") return "low";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
    return effort;
  }
  return null;
}

export function mapCodexModel(model: CodexModel): ModelOption {
  return { id: model.id, label: model.displayName || model.id, source: "live" };
}

export function mapCodexThread(thread: CodexThread, projectId: string): SessionMeta {
  const title = (thread.name ?? "").trim() || (thread.preview ?? "").trim().slice(0, 80) || thread.id.slice(0, 8);
  return {
    id: `codex:${thread.id}`,
    projectId,
    driver: "codex",
    title,
    status: "idle",
    resumeCursor: thread.id,
    createdAt: (thread.createdAt ?? 0) * 1000,
    updatedAt: (thread.updatedAt ?? thread.createdAt ?? 0) * 1000,
    model: thread.model ?? undefined
  };
}

export interface CodexPlanUpdate {
  threadId?: string;
  turnId?: string;
  explanation?: string | null;
  plan?: Array<{ step?: unknown; status?: unknown }>;
}

export function mapCodexPlan(plan: unknown): TodoItem[] | null {
  return todosFromPlan(plan);
}

export function buildCodexUserInput(prompt: string, cwd: string, attachments: string[] | undefined): CodexUserInput[] {
  const input: CodexUserInput[] = [];
  if (prompt.trim()) input.push({ type: "text", text: prompt });
  for (const rel of attachments ?? []) {
    if (isImagePath(rel)) {
      input.push({ type: "localImage", path: joinImagePath(cwd, rel) });
    }
  }
  return input;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

function joinImagePath(cwd: string, rel: string): string {
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(rel)) return rel;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

export function mapCodexHistory(thread: CodexThread, limit = 300): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const turn of thread.turns ?? []) {
    const turnId = turn.id;
    const startedAt = turn.startedAt ?? null;
    const completedAt = turn.completedAt ?? null;
    const timestamp = startedAt != null ? startedAt * 1000 : undefined;
    const first = out.length;
    for (const item of turn.items ?? []) {
      pushHistoryItem(out, item, turnId, timestamp);
    }
    if (out.length > first && completedAt != null && timestamp !== undefined) {
      out[out.length - 1] = { ...out[out.length - 1], timestamp: completedAt * 1000 };
    }
  }
  return out.slice(-limit);
}

function pushHistoryItem(
  out: HistoryMessage[],
  item: CodexThreadItem,
  turnId: string,
  timestamp: number | undefined
): void {
  const id = item.id ?? `${turnId}-${out.length}`;
  switch (item.type) {
    case "userMessage": {
      const text = (item.content ?? [])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text as string)
        .join("\n");
      if (text) out.push({ id, role: "user", text, turnId, timestamp });
      break;
    }
    case "agentMessage":
    case "plan": {
      if (item.text) out.push({ id, role: "assistant", text: item.text, turnId, timestamp });
      break;
    }
    case "reasoning": {
      const text = codexReasoningText(item);
      if (text) out.push({ id, role: "reasoning", text, turnId, timestamp });
      break;
    }
    case "commandExecution": {
      const callId = `${id}-call`;
      out.push({ id: callId, role: "tool", text: item.command ?? "shell", turnId, toolName: "shell", timestamp });
      const output = (item.aggregatedOutput ?? "").trim();
      if (output) {
        out.push({
          id: `${callId}-r`,
          role: "tool",
          text: output.slice(0, 4000),
          turnId,
          toolName: "shell",
          isError: (item.exitCode ?? 0) > 0 || item.status === "failed" || item.status === "declined",
          timestamp
        });
      }
      break;
    }
    case "fileChange": {
      const callId = `${id}-call`;
      const paths = (item.changes ?? []).map((c) => c.path).join(", ");
      out.push({
        id: callId,
        role: "tool",
        text: paths ? `edit ${paths}` : "edit",
        turnId,
        toolName: "edit",
        timestamp
      });
      const diff = (item.changes ?? []).map((c) => c.diff).join("\n\n").trim();
      if (diff) {
        out.push({
          id: `${callId}-r`,
          role: "tool",
          text: diff.slice(0, 4000),
          turnId,
          toolName: "edit",
          isError: item.status === "failed" || item.status === "declined",
          timestamp
        });
      }
      break;
    }
    case "mcpToolCall": {
      const callId = `${id}-call`;
      const name = item.server ? `${item.server}: ${item.tool ?? "tool"}` : (item.tool ?? "mcp");
      out.push({ id: callId, role: "tool", text: name, turnId, toolName: item.tool ?? "mcp", timestamp });
      if (item.status === "failed") {
        out.push({
          id: `${callId}-r`,
          role: "tool",
          text: "MCP tool call failed",
          turnId,
          toolName: item.tool ?? "mcp",
          isError: true,
          timestamp
        });
      }
      break;
    }
    default:
      break;
  }
}

export function buildCommandApproval(
  requestId: string,
  params: CodexCommandApprovalParams
): ApprovalRequest {
  const command = (params.command ?? "").trim();
  const firstLine = command.split("\n")[0] ?? "";
  return {
    requestId,
    kind: "command",
    title: firstLine.slice(0, 120) || "Run command",
    reason: params.reason ?? undefined,
    details: [command, params.cwd ? `cwd: ${params.cwd}` : ""].filter(Boolean).join("\n"),
    decisions: ["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]
  };
}

export function buildFileChangeApproval(
  requestId: string,
  params: CodexFileChangeApprovalParams
): ApprovalRequest {
  return {
    requestId,
    kind: "fileChange",
    title: "Apply file changes",
    reason: params.reason ?? undefined,
    decisions: ["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]
  };
}

export function buildPermissionsApproval(
  requestId: string,
  params: CodexPermissionsApprovalParams
): ApprovalRequest {
  return {
    requestId,
    kind: "permissions",
    title: "Grant additional permissions",
    reason: params.reason ?? undefined,
    details: params.permissions ? JSON.stringify(params.permissions) : undefined,
    decisions: ["accept", "acceptForSession", "acceptGlobal", "decline", "cancel"]
  };
}

export interface CodexUserInputQuestionParams {
  header?: unknown;
  question?: unknown;
  options?: unknown;
  multiSelect?: unknown;
  isOther?: unknown;
  isSecret?: unknown;
}

export interface CodexUserInputParams {
  questions?: unknown[];
}

function codexOptionOf(entry: unknown): QuestionOption | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const args = entry as Record<string, unknown>;
  if (typeof args["label"] !== "string" || !args["label"]) return null;
  const description = args["description"];
  return {
    label: args["label"],
    ...(typeof description === "string" && description ? { description } : {})
  };
}

export function codexQuestionsFor(params: CodexUserInputParams): QuestionInfo[] {
  const raw = Array.isArray(params.questions) ? params.questions : [];
  const questions: QuestionInfo[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const args = entry as CodexUserInputQuestionParams;
    if (typeof args.question !== "string" || !args.question) continue;
    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const options = rawOptions.map(codexOptionOf).filter((o): o is QuestionOption => o !== null);
    questions.push({
      question: args.question,
      ...(typeof args.header === "string" && args.header ? { header: args.header } : {}),
      options,
      multiSelect: args.multiSelect === true,
      allowCustom: args.isOther !== false
    });
  }
  return questions;
}

export function buildUserInputQuestionRequest(requestId: string, turnId: string, params: CodexUserInputParams): QuestionRequest | null {
  const questions = codexQuestionsFor(params);
  if (questions.length === 0) return null;
  return { requestId, turnId, questions };
}

export function codexUserInputResult(answers: Record<string, string>): unknown {
  return { answers: Object.values(answers) };
}

export function approvalResultFor(
  kind: ApprovalKind,
  decision: ApprovalDecision,
  requestedPermissions?: unknown
): unknown {
  if (kind === "permissions") {
    if (decision === "accept" || decision === "acceptForSession" || decision === "acceptGlobal") {
      return {
        permissions: requestedPermissions ?? {},
        scope: decision === "accept" ? "turn" : "session"
      };
    }
    return { permissions: {}, scope: "turn" };
  }
  if (decision === "acceptGlobal") {
    return { decision: "acceptForSession" };
  }
  return { decision };
}

export function accumulateCodexUsage(
  acc: { inputTokens: number; outputTokens: number },
  usage: CodexTokenUsage
): void {
  const last = usage.last;
  acc.inputTokens +=
    (last.inputTokens ?? 0) + (last.cachedInputTokens ?? 0) + (last.cacheWriteInputTokens ?? 0);
  acc.outputTokens += (last.outputTokens ?? 0) + (last.reasoningOutputTokens ?? 0);
}
