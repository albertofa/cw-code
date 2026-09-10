import type { ThreadEvent } from "@cw-code/contracts";

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
    content?: Array<{
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
}

interface ResultMsg {
  type: "result";
  subtype?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  num_turns?: number;
  is_error?: boolean;
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
  done: (info: TurnDoneInfo) => void
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
      }
    }
    return out;
  }

  if (msg.type === "user") {
    const out: ThreadEvent[] = [];
    for (const block of msg.message?.content ?? []) {
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
