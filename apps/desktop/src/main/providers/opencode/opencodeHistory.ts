import type { HistoryMessage } from "@cw-code/contracts";
import { todosFromToolCall } from "../todos.js";

interface ServerPart {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: unknown; output?: string; error?: unknown };
  filename?: string;
  mime?: string;
  url?: string;
  time?: { start?: number; end?: number };
}

interface ServerMessage {
  info?: { id?: string; role?: string; time?: { created?: number; completed?: number } };
  parts?: ServerPart[];
}

function stamp(value: unknown): { timestamp?: number } {
  return typeof value === "number" && Number.isFinite(value) ? { timestamp: value } : {};
}

export function mapOpencodeMessages(messages: ServerMessage[], limit = 300): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const msg of messages) {
    const role = msg.info?.role === "assistant" ? "assistant" : "user";
    const turnId = msg.info?.id ?? `msg-${out.length}`;
    const created = msg.info?.time?.created;
    const completed = msg.info?.time?.completed;
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
        out.push({
          id: callId,
          role: "tool",
          text: `${part.tool ?? "tool"} ${input}`,
          turnId,
          toolName: part.tool ?? "tool",
          ...(todos !== null ? { todos } : {}),
          ...partStamp
        });
        const output = part.state?.output;
        const errorText =
          typeof part.state?.error === "string" && part.state.error.trim()
            ? part.state.error
            : undefined;
        const resultText =
          typeof output === "string" && output.trim()
            ? output.slice(0, 4000)
            : (errorText?.slice(0, 4000) ?? "");
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
  }
  return out.slice(-limit);
}
