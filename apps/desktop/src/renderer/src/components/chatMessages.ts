import type { ChatMessage } from "../stores/appStore.js";
import type { TurnEvent } from "../cw.js";

export type ToolCallEvent = Extract<TurnEvent, { type: "tool.call" }>;

function toolCallText(name: string, input: unknown): string {
  return `${name} ${JSON.stringify(input)?.slice(0, 300) ?? ""}`;
}

function hasInput(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "string") return input.length > 0;
  if (typeof input === "object") return Object.keys(input).length > 0;
  return true;
}

export function upsertToolCall(messages: ChatMessage[], event: ToolCallEvent, startedAt: number): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === event.toolCallId && m.role === "tool");
  if (idx >= 0) {
    const existing = messages[idx];
    const updated: ChatMessage = {
      ...existing,
      toolName: event.name,
      ...(hasInput(event.input)
        ? { toolInput: event.input, text: toolCallText(event.name, event.input) }
        : {}),
      ...(event.parentToolCallId && !existing.parentToolCallId
        ? { parentToolCallId: event.parentToolCallId }
        : {})
    };
    return [...messages.slice(0, idx), updated, ...messages.slice(idx + 1)];
  }
  return [
    ...messages,
    {
      id: event.toolCallId,
      role: "tool",
      text: toolCallText(event.name, event.input),
      turnId: event.turnId,
      toolName: event.name,
      toolInput: event.input,
      toolStartedAt: startedAt,
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {})
    }
  ];
}

export function appendAssistantText(messages: ChatMessage[], turnId: string, text: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.turnId === turnId) {
    return [...messages.slice(0, -1), { ...last, text: last.text + text }];
  }
  const existing = new Set(messages.map((m) => m.id));
  let id = `${turnId}-a`;
  for (let n = 2; existing.has(id); n++) {
    id = `${turnId}-a${n}`;
  }
  return [...messages, { id, role: "assistant", text, turnId }];
}

export function appendReasoningText(
  messages: ChatMessage[],
  turnId: string,
  text: string,
  startedAt: number
): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "reasoning" && last.turnId === turnId && last.reasoningMs === undefined) {
    return [...messages.slice(0, -1), { ...last, text: last.text + text }];
  }
  const existing = new Set(messages.map((m) => m.id));
  let id = `${turnId}-th`;
  for (let n = 2; existing.has(id); n++) {
    id = `${turnId}-th${n}`;
  }
  return [...messages, { id, role: "reasoning", text, turnId, reasoningStartedAt: startedAt }];
}

export function closeReasoning(messages: ChatMessage[], now: number): ChatMessage[] {
  let out: ChatMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "reasoning" || m.reasoningMs !== undefined || m.reasoningStartedAt === undefined) continue;
    if (!out) out = [...messages];
    out[i] = { ...m, reasoningMs: Math.max(0, now - m.reasoningStartedAt) };
  }
  return out ?? messages;
}
