import type { ThreadEvent } from "@cw-code/contracts";
import { toolResultFromState } from "./opencodeEvents.js";

export interface LiveToolPart {
  type?: string;
  tool?: string;
  callID?: string;
  id?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
}

export interface LiveMessage {
  info?: { id?: string };
  parts?: LiveToolPart[];
}

export interface LiveSeen {
  call: boolean;
  result: boolean;
  input: boolean;
}

function hasInput(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "string") return input.length > 0;
  if (typeof input === "object") return Object.keys(input).length > 0;
  return true;
}

function partCallId(part: LiveToolPart, turnId: string): string {
  if (typeof part.callID === "string" && part.callID) return part.callID;
  if (typeof part.id === "string" && part.id) return part.id;
  return `${turnId}-tool`;
}

function partInput(part: LiveToolPart): unknown {
  const state = part.state;
  if (state !== null && typeof state === "object" && !Array.isArray(state) && "input" in state) {
    return (state as { input?: unknown }).input ?? null;
  }
  return state ?? null;
}

export function collectPartTypes(messages: LiveMessage[], into: Map<string, string>): void {
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (typeof part.id === "string" && part.id && typeof part.type === "string" && part.type) {
        into.set(part.id, part.type);
      }
    }
  }
}

export function diffLiveTools(
  seen: Map<string, LiveSeen>,
  messages: LiveMessage[],
  turnId: string,
  beforeIds: Set<string> | null
): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  for (const msg of messages) {
    const msgId = msg.info?.id;
    if (beforeIds !== null && typeof msgId === "string" && beforeIds.has(msgId)) continue;
    for (const part of msg.parts ?? []) {
      if (part.type !== "tool") continue;
      const id = partCallId(part, turnId);
      const entry = seen.get(id) ?? { call: false, result: false, input: false };
      const input = partInput(part);
      if (!entry.call) {
        entry.call = true;
        entry.input = hasInput(input);
        seen.set(id, entry);
        events.push({
          type: "tool.call",
          turnId,
          toolCallId: id,
          name: part.tool ?? "tool",
          input
        });
      } else if (!entry.input && hasInput(input)) {
        entry.input = true;
        seen.set(id, entry);
        events.push({
          type: "tool.call",
          turnId,
          toolCallId: id,
          name: part.tool ?? "tool",
          input
        });
      }
      if (!entry.result) {
        const result = toolResultFromState(part.state);
        if (result) {
          entry.result = true;
          seen.set(id, entry);
          events.push({
            type: "tool.result",
            turnId,
            toolCallId: id,
            output: result.output,
            isError: result.isError
          });
        }
      }
    }
  }
  return events;
}
