import type { ChatMessage } from "../stores/appStore.js";
import { describeSubagent, isSubagentMessage, type SubagentGroup } from "./subagents.js";
import { orderToolsForDisplay } from "./toolSummaries.js";

export interface TurnSlice {
  turnId: string;
  messages: ChatMessage[];
}

export type ThreadNode =
  | { kind: "msg"; msg: ChatMessage }
  | { kind: "sub"; key: string; group: SubagentGroup }
  | { kind: "tools"; key: string; items: ChatMessage[] };

export interface TurnPieces {
  lead: ChatMessage[];
  activity: ThreadNode[];
  system: ChatMessage[];
  pinned?: ChatMessage;
}

export function groupTurns(messages: ChatMessage[]): TurnSlice[] {
  const out: TurnSlice[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.turnId === m.turnId) last.messages.push(m);
    else out.push({ turnId: m.turnId, messages: [m] });
  }
  return out;
}

function isTodoTool(m: ChatMessage): boolean {
  const n = (m.toolName ?? "").toLowerCase();
  return n === "todowrite" || n === "todo";
}

export function buildThreadNodes(messages: ChatMessage[], nestedIds: Set<string>): ThreadNode[] {
  const out: ThreadNode[] = [];
  let pending: ChatMessage[] = [];
  let toolRun: ChatMessage[] = [];
  const flushTools = () => {
    if (toolRun.length === 1) out.push({ kind: "msg", msg: toolRun[0] });
    else if (toolRun.length > 1) out.push({ kind: "tools", key: toolRun[0].id, items: toolRun });
    toolRun = [];
  };
  const flushSubs = () => {
    if (pending.length > 0) {
      out.push({
        kind: "sub",
        key: pending[0].id,
        group: { id: pending[0].id, turnId: pending[0].turnId, items: pending.map(describeSubagent) }
      });
      pending = [];
    }
  };
  for (const m of orderToolsForDisplay(messages)) {
    if (isTodoTool(m)) continue;
    if (isSubagentMessage(m)) {
      flushTools();
      pending.push(m);
    } else if (m.parentToolCallId && nestedIds.has(m.parentToolCallId)) continue;
    else if (m.role === "tool") {
      flushSubs();
      toolRun.push(m);
    } else {
      flushSubs();
      flushTools();
      out.push({ kind: "msg", msg: m });
    }
  }
  flushSubs();
  flushTools();
  return out;
}

export function splitTurn(messages: ChatMessage[], nestedIds: Set<string>): TurnPieces {
  const lead: ChatMessage[] = [];
  const system: ChatMessage[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") lead.push(m);
    else if (m.role === "system") system.push(m);
    else rest.push(m);
  }
  let pinned: ChatMessage | undefined;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].role === "assistant") {
      pinned = rest[i];
      rest.splice(i, 1);
      break;
    }
  }
  const activity = buildThreadNodes(rest, nestedIds);
  return pinned ? { lead, activity, system, pinned } : { lead, activity, system };
}
