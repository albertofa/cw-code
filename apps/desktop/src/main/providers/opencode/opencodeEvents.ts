import type { ThreadEvent } from "@cw-code/contracts";

export interface OpencodeUsage {
  input: number;
  output: number;
  reasoning: number;
}

export interface OpencodeRunSummary {
  sessionId: string;
  resultText: string;
  usage: OpencodeUsage;
  cost: number;
}

interface RunEvent {
  type: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    reason?: string;
    tokens?: { input?: number; output?: number; reasoning?: number };
    cost?: number;
    tool?: string;
    state?: unknown;
    error?: unknown;
  };
  error?: unknown;
}

export function parseOpencodeLine(
  line: string,
  turnId: string,
  acc: { text: string[]; usage: OpencodeUsage; cost: number; sessionId: string }
): ThreadEvent[] {
  if (!line.trim()) return [];
  let event: RunEvent;
  try {
    event = JSON.parse(line) as RunEvent;
  } catch {
    return [{ type: "assistant.delta", turnId, text: line }];
  }
  if (event.sessionID && !acc.sessionId) acc.sessionId = event.sessionID;
  const part = event.part;

  if (event.type === "text" && part?.text) {
    acc.text.push(part.text);
    return [{ type: "assistant.delta", turnId, text: part.text }];
  }

  if (event.type === "tool_use" || part?.type === "tool") {
    return [
      {
        type: "tool.call",
        turnId,
        toolCallId: (part as { id?: string })?.id ?? `${turnId}-tool`,
        name: part?.tool ?? "tool",
        input: part?.state ?? null
      }
    ];
  }

  if (event.type === "tool_result" || part?.type === "tool-result") {
    const output =
      typeof part?.state === "string" ? part.state : JSON.stringify(part?.state ?? "");
    return [
      {
        type: "tool.result",
        turnId,
        toolCallId: (part as { id?: string })?.id ?? `${turnId}-tool`,
        output: output.slice(0, 8000),
        isError: part?.error != null
      }
    ];
  }

  if (event.type === "step_finish" && part?.tokens) {
    acc.usage.input += part.tokens.input ?? 0;
    acc.usage.output += part.tokens.output ?? 0;
    acc.usage.reasoning += part.tokens.reasoning ?? 0;
    acc.cost += part.cost ?? 0;
    return [];
  }

  if (event.type === "error") {
    const message =
      typeof event.error === "object" && event.error !== null
        ? JSON.stringify(event.error).slice(0, 2000)
        : String(event.error ?? "unknown error");
    return [{ type: "turn.error", turnId, message }];
  }

  if (part?.text) {
    acc.text.push(part.text);
    return [{ type: "assistant.delta", turnId, text: part.text }];
  }
  return [];
}

export function summarizeRun(
  turnId: string,
  sessionId: string,
  acc: { text: string[]; usage: OpencodeUsage; cost: number; sessionId: string }
): ThreadEvent {
  return {
    type: "turn.done",
    turnId,
    sessionId,
    resumeCursor: acc.sessionId || sessionId,
    resultText: acc.text.join(""),
    inputTokens: acc.usage.input,
    outputTokens: acc.usage.output,
    costUsd: acc.cost,
    numTurns: 1,
    isError: false
  };
}
