import type { HistoryMessage, TaskSnapshot } from "@cw-code/contracts";
import { isSubagentToolName } from "../../tasks/toolTasks.js";
import { todosFromToolCall } from "../todos.js";
import { errorMessageOf } from "./opencodeMessage.js";

interface ServerPart {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: unknown;
    metadata?: { model?: { modelID?: unknown; providerID?: unknown } };
    time?: { start?: number; end?: number };
  };
  filename?: string;
  mime?: string;
  url?: string;
  time?: { start?: number; end?: number };
}

interface ServerMessage {
  info?: {
    id?: string;
    role?: string;
    mode?: string;
    summary?: boolean;
    time?: { created?: number; completed?: number };
    error?: unknown;
  };
  parts?: ServerPart[];
}

const ABORTED_ERROR_NAMES = new Set(["AbortedError", "MessageAbortedError"]);

function isAbortedError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || Array.isArray(error)) return false;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && ABORTED_ERROR_NAMES.has(name);
}

function taskModelOf(part: ServerPart): string | undefined {
  const modelID = part.state?.metadata?.model?.modelID;
  return typeof modelID === "string" && modelID ? modelID : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stamp(value: unknown): { timestamp?: number } {
  const timestamp = finiteNumber(value);
  return timestamp !== undefined ? { timestamp } : {};
}

function subagentTaskOf(
  part: ServerPart,
  id: string,
  output: string | undefined,
  errorText: string | undefined,
  aborted: boolean
): TaskSnapshot {
  const startedAt = finiteNumber(part.state?.time?.start);
  const endedAt = finiteNumber(part.state?.time?.end);
  const base = {
    id,
    kind: "agent" as const,
    background: false,
    runCount: 1,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {})
  };
  switch (part.state?.status) {
    case "completed":
      return { ...base, state: "completed", endReason: "tool-result", ...(output !== undefined ? { output } : {}) };
    case "error":
      return {
        ...base,
        state: aborted ? "interrupted" : "failed",
        endReason: aborted ? "interrupt" : "tool-result",
        ...(errorText !== undefined ? { output: errorText } : {})
      };
    default:
      return { ...base, state: "unknown", endReason: "no-record" };
  }
}

export function mapOpencodeMessages(messages: ServerMessage[], limit = 300): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const msg of messages) {
    const role = msg.info?.role === "assistant" ? "assistant" : "user";
    const turnId = msg.info?.id ?? `msg-${out.length}`;
    const created = msg.info?.time?.created;
    const completed = msg.info?.time?.completed;
    const aborted = isAbortedError(msg.info?.error);
    if (msg.info?.summary === true || msg.info?.mode === "compaction") {
      out.push({
        id: `${turnId}-compact`,
        role: "system",
        text: "Context compacted",
        turnId,
        compaction: {},
        ...stamp(completed ?? created)
      });
      continue;
    }
    for (const part of msg.parts ?? []) {
      const partStamp =
        role === "user"
          ? stamp(created)
          : stamp(part.time?.end ?? part.time?.start ?? completed ?? created);
      if (part.type === "text" && part.text) {
        out.push({ id: part.id ?? `${turnId}-t`, role, text: part.text, turnId, ...partStamp });
      } else if (part.type === "reasoning" && part.text) {
        const start = part.time?.start;
        const end = part.time?.end;
        const reasoningMs =
          typeof start === "number" && typeof end === "number" && end > start ? end - start : undefined;
        out.push({
          id: part.id ?? `${turnId}-th`,
          role: "reasoning",
          text: part.text,
          turnId,
          ...(reasoningMs !== undefined ? { reasoningMs } : {}),
          ...partStamp
        });
      } else if (part.type === "tool") {
        const input = JSON.stringify(part.state?.input ?? null)?.slice(0, 2000) ?? "";
        const callId = part.callID ?? part.id ?? `${turnId}-tool`;
        const todos = todosFromToolCall(part.tool ?? "tool", part.state?.input);
        const subagentModel = taskModelOf(part);
        const rawOutput = part.state?.output;
        const output = typeof rawOutput === "string" && rawOutput.trim() ? rawOutput.slice(0, 4000) : undefined;
        const errorText =
          typeof part.state?.error === "string" && part.state.error.trim()
            ? part.state.error.slice(0, 4000)
            : undefined;
        const resultText = output ?? errorText ?? "";
        out.push({
          id: callId,
          role: "tool",
          text: `${part.tool ?? "tool"} ${input}`,
          turnId,
          toolName: part.tool ?? "tool",
          ...(todos !== null ? { todos } : {}),
          ...(subagentModel ? { subagentModel } : {}),
          ...(isSubagentToolName(part.tool ?? "") ? { task: subagentTaskOf(part, callId, output, errorText, aborted) } : {}),
          ...partStamp
        });
        if (resultText) {
          out.push({
            id: `${callId}-r`,
            role: "tool",
            text: resultText,
            turnId,
            toolName: part.tool ?? "tool",
            isError: part.state?.error != null || part.state?.status === "error",
            ...partStamp
          });
        }
      } else if (part.type === "file") {
        out.push({
          id: part.id ?? `${turnId}-f`,
          role,
          text: `[file ${part.filename ?? part.mime ?? part.url ?? "attachment"}]`,
          turnId,
          ...partStamp
        });
      }
    }
    const errorText = role === "assistant" && !aborted ? errorMessageOf(msg.info?.error) : "";
    if (errorText) {
      out.push({
        id: `${turnId}-e`,
        role: "system",
        text: errorText,
        turnId,
        isError: true,
        ...stamp(completed ?? created)
      });
    }
  }
  return out.slice(-limit);
}
