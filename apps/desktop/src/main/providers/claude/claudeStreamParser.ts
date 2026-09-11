import type { QuestionInfo, QuestionOption, QuestionRequest, ThreadEvent } from "@cw-code/contracts";

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
