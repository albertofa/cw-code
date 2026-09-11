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

export function diffLiveTools(
  seen: Map<string, LiveSeen>,
  messages: LiveMessage[],
  turnId: string
): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type !== "tool") continue;
      const id = partCallId(part, turnId);
      const entry = seen.get(id) ?? { call: false, result: false };
      if (!entry.call) {
        entry.call = true;
        seen.set(id, entry);
        events.push({
          type: "tool.call",
          turnId,
          toolCallId: id,
          name: part.tool ?? "tool",
          input: partInput(part)
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
