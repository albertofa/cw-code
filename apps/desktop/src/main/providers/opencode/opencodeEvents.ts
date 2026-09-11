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
    id?: string;
    callID?: string;
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

interface ToolPartState {
  status?: string;
  input?: unknown;
  output?: string;
  error?: unknown;
}

function toolCallId(part: Record<string, unknown> | undefined, turnId: string): string {
  const callID = (part?.["callID"] ?? part?.["callId"]) as string | undefined;
  if (typeof callID === "string" && callID) return callID;
  const id = part?.["id"] as string | undefined;
  if (typeof id === "string" && id) return id;
  return `${turnId}-tool`;
}

function toolInputOf(part: { tool?: string; state?: unknown } | undefined): unknown {
  const state = part?.state as ToolPartState | string | null | undefined;
  if (state !== null && typeof state === "object" && !Array.isArray(state) && "input" in state) {
    return (state as ToolPartState).input ?? null;
  }
  return state ?? null;
}

function errorText(error: unknown): string | undefined {
  if (typeof error === "string" && error.trim()) return error;
  if (error !== null && typeof error === "object") {
    const text = JSON.stringify(error);
    if (text && text !== "{}") return text;
  }
  return undefined;
}

export function toolResultFromState(
  state: unknown
): { output: string; isError: boolean } | null {
  if (typeof state === "string") return { output: state, isError: false };
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  const typed = state as ToolPartState;
  if (typed.status !== "completed" && typed.status !== "error") return null;
  const raw = typed.output;
  if (typeof raw === "string") {
    if (raw.trim()) {
      return { output: raw.slice(0, 8000), isError: typed.status === "error" || typed.error != null };
    }
  } else if (raw !== undefined && raw !== null) {
    return {
      output: JSON.stringify(raw).slice(0, 8000),
      isError: typed.status === "error" || typed.error != null
    };
  }
  const err = errorText(typed.error);
  if (err !== undefined) return { output: err.slice(0, 8000), isError: true };
  return { output: "", isError: typed.status === "error" };
}

function toolResultOf(part: { state?: unknown } | undefined): { output: string; isError: boolean } | null {
  return toolResultFromState(part?.state);
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
    const id = toolCallId(part as Record<string, unknown> | undefined, turnId);
    const call: ThreadEvent = {
      type: "tool.call",
      turnId,
      toolCallId: id,
      name: part?.tool ?? "tool",
      input: toolInputOf(part)
    };
    const result = toolResultOf(part);
    if (!result) return [call];
    return [
      call,
      { type: "tool.result", turnId, toolCallId: id, output: result.output, isError: result.isError }
    ];
  }

  if (event.type === "tool_result" || part?.type === "tool-result") {
    const output =
      typeof part?.state === "string" ? part.state : JSON.stringify(part?.state ?? "");
    return [
      {
        type: "tool.result",
        turnId,
        toolCallId: toolCallId(part as Record<string, unknown> | undefined, turnId),
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
