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
}

interface ServerMessage {
  info?: { id?: string; role?: string };
  parts?: ServerPart[];
}

export function mapOpencodeMessages(messages: ServerMessage[], limit = 300): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const msg of messages) {
    const role = msg.info?.role === "assistant" ? "assistant" : "user";
    const turnId = msg.info?.id ?? `msg-${out.length}`;
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && part.text) {
        out.push({ id: part.id ?? `${turnId}-t`, role, text: part.text, turnId });
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
          ...(todos !== null ? { todos } : {})
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
            isError: part.state?.error != null || part.state?.status === "error"
          });
        }
      } else if (part.type === "file") {
        out.push({
          id: part.id ?? `${turnId}-f`,
          role,
          text: `[file ${part.filename ?? part.mime ?? part.url ?? "attachment"}]`,
          turnId
        });
      }
    }
  }
  return out.slice(-limit);
}
