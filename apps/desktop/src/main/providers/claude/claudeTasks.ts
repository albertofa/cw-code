import type { ToolUsage } from "@cw-code/contracts";
import { mapCliTaskStatus, type TaskObservation, type TaskOutputSource, type TaskRef } from "../../tasks/TaskTable.js";
import {
  AGENT_ID_RE,
  CLAUDE_COMMAND_TOOLS,
  CLAUDE_SHELL_TASK_TYPE,
  parseTaskNotificationUsage,
  type ClaudeTaskSystemInfo
} from "./claudeStreamParser.js";

export interface ClaudeNotificationXml {
  toolUseId?: string;
  taskId?: string;
  status?: string;
  result?: string;
  summary?: string;
  usage?: ToolUsage;
}

const NOTIFICATION_OPEN = "<task-notification>";
const NOTIFICATION_CLOSE = "</task-notification>";

function tagPattern(tag: string): RegExp {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
}

const NOTIFICATION_TAG_RE = {
  toolUseId: tagPattern("tool-use-id"),
  taskId: tagPattern("task-id"),
  status: tagPattern("status"),
  summary: tagPattern("summary"),
  result: tagPattern("result"),
  usage: tagPattern("usage")
};

const LAUNCH_STATUSES = new Set(["async_launched", "remote_launched"]);
const ASYNC_ACK_PREFIX = "Async agent launched";
const RESUME_TEXT_RE = /resuming agent/i;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function trimmedTag(body: string, pattern: RegExp): string | undefined {
  return pattern.exec(body)?.[1]?.trim() || undefined;
}

function refOf(toolUseId: string | undefined, cliTaskId: string | undefined, runId: string | undefined): TaskRef {
  return {
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(cliTaskId !== undefined ? { cliTaskId } : {}),
    ...(runId !== undefined ? { runId } : {})
  };
}

function runInBackground(input: unknown): boolean | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)["run_in_background"];
  return typeof value === "boolean" ? value : undefined;
}

function isLaunchAck(output: string, structured: Record<string, unknown> | undefined): boolean {
  const status = structured?.["status"];
  return (
    (typeof status === "string" && LAUNCH_STATUSES.has(status)) ||
    structured?.["isAsync"] === true ||
    output.trimStart().startsWith(ASYNC_ACK_PREFIX)
  );
}

function launchedAgentId(output: string, structured: Record<string, unknown> | undefined): string | undefined {
  return str(structured?.["agentId"]) ?? AGENT_ID_RE.exec(output)?.[1];
}

function notificationOutput(n: ClaudeNotificationXml): { output?: string; outputSource?: TaskOutputSource } {
  if (hasText(n.result)) return { output: n.result, outputSource: "result" };
  if (hasText(n.summary)) return { output: n.summary, outputSource: "summary" };
  return {};
}

export function isClaudeSubagentTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "agent" || lower === "task";
}

export function findClaudeTaskNotification(text: string): ClaudeNotificationXml | null {
  const start = text.indexOf(NOTIFICATION_OPEN);
  if (start < 0) return null;
  const bodyStart = start + NOTIFICATION_OPEN.length;
  const end = text.indexOf(NOTIFICATION_CLOSE, bodyStart);
  const body = text.slice(bodyStart, end < 0 ? undefined : end);
  const toolUseId = trimmedTag(body, NOTIFICATION_TAG_RE.toolUseId);
  const taskId = trimmedTag(body, NOTIFICATION_TAG_RE.taskId);
  if (!toolUseId && !taskId) return null;
  const status = trimmedTag(body, NOTIFICATION_TAG_RE.status);
  const summary = trimmedTag(body, NOTIFICATION_TAG_RE.summary);
  const result = NOTIFICATION_TAG_RE.result.exec(body)?.[1];
  const usageBody = NOTIFICATION_TAG_RE.usage.exec(body)?.[1];
  const usage = usageBody !== undefined ? parseTaskNotificationUsage(usageBody) : undefined;
  return {
    ...(toolUseId ? { toolUseId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(status ? { status } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(summary ? { summary } : {}),
    ...(usage ? { usage } : {})
  };
}

export function claudeCallObservation(
  name: string,
  toolUseId: string,
  input: unknown,
  at: number
): TaskObservation | null {
  const background = runInBackground(input);
  if (isClaudeSubagentTool(name)) {
    return { kind: "call", toolUseId, taskKind: "agent", ...(background !== undefined ? { background } : {}), at };
  }
  if (CLAUDE_COMMAND_TOOLS.has(name.toLowerCase()) && background === true) {
    return { kind: "call", toolUseId, taskKind: "shell", background: true, at };
  }
  return null;
}

export function claudeToolResultObservation(
  toolUseId: string,
  output: string,
  isError: boolean,
  structured: Record<string, unknown> | undefined,
  at: number
): TaskObservation {
  if (isLaunchAck(output, structured)) {
    return { kind: "background", ref: refOf(toolUseId, launchedAgentId(output, structured), undefined), background: true };
  }
  return {
    kind: "ended",
    ref: { toolUseId },
    state: isError ? "failed" : "completed",
    reason: "tool-result",
    ...(hasText(output) ? { output } : {}),
    outputSource: "result",
    at
  };
}

export function claudeNotificationObservation(
  n: ClaudeNotificationXml,
  at: number,
  runId?: string
): TaskObservation | null {
  const state = mapCliTaskStatus(n.status) ?? "completed";
  if (state === "running") return null;
  return {
    kind: "ended",
    ref: refOf(n.toolUseId, n.taskId, runId),
    state,
    reason: "cli",
    ...notificationOutput(n),
    ...(n.usage !== undefined ? { usage: n.usage } : {}),
    at
  };
}

export function claudeSystemTaskObservation(info: ClaudeTaskSystemInfo, at: number): TaskObservation | null {
  switch (info.kind) {
    case "tasks":
      return {
        kind: "roster",
        tasks: (info.liveTaskEntries ?? []).map(({ taskId, runId }) => ({
          cliTaskId: taskId,
          ...(runId ? { runId } : {})
        }))
      };
    case "started":
      return {
        kind: "started",
        ref: refOf(info.toolUseId, info.taskId, info.runId),
        taskKind: info.taskType === CLAUDE_SHELL_TASK_TYPE ? "shell" : "agent",
        ...(info.background !== undefined ? { background: info.background } : {}),
        at
      };
    case "updated": {
      const state = mapCliTaskStatus(info.status);
      if (state === undefined || state === "running") return null;
      return {
        kind: "ended",
        ref: refOf(undefined, info.taskId, info.runId),
        state,
        reason: "cli",
        at: info.endTime ?? at
      };
    }
    case "notification":
      return claudeNotificationObservation(
        {
          toolUseId: info.toolUseId,
          taskId: info.taskId,
          status: info.status,
          summary: info.summary,
          usage: info.usage
        },
        at,
        info.runId
      );
    case "progress":
      return null;
  }
}

export function claudeHandbackObservation(originId: string, message: string, at: number): TaskObservation {
  return {
    kind: "ended",
    ref: { originId },
    state: "completed",
    reason: "cli",
    output: message,
    outputSource: "report",
    at
  };
}

export function claudeResumeObservation(
  sendToolUseId: string,
  to: string,
  resultText: string,
  structured: Record<string, unknown> | undefined,
  at: number
): TaskObservation | null {
  const resumedAgentId = str(structured?.["resumedAgentId"]);
  if (resumedAgentId === undefined && !RESUME_TEXT_RE.test(resultText)) return null;
  return {
    kind: "started",
    ref: { toolUseId: sendToolUseId, cliTaskId: resumedAgentId ?? to },
    taskKind: "agent",
    background: true,
    at
  };
}
