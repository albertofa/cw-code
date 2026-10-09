import type { ChatMessage } from "../stores/appStore.js";
import { describeSubagent, isSubagentMessage, type SubagentGroup } from "./subagents.js";
import { isRunningTool, orderToolsForDisplay } from "./toolSummaries.js";

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
  pinned?: ChatMessage[];
}

export function groupTurns(messages: ChatMessage[]): TurnSlice[] {
  const out: TurnSlice[] = [];
  let anchor: TurnSlice | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      anchor = { turnId: m.turnId, messages: [m] };
      out.push(anchor);
      continue;
    }
    if (anchor) {
      anchor.messages.push(m);
      continue;
    }
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

function isSkillTool(m: ChatMessage): boolean {
  return (m.toolName ?? "").toLowerCase() === "skill";
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
      if (isRunningTool(m) || isSkillTool(m)) {
        flushTools();
        out.push({ kind: "msg", msg: m });
      } else {
        toolRun.push(m);
      }
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

export function countActivityTools(nodes: ThreadNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.kind === "tools") count += n.items.length;
    else if (n.kind === "sub") count += n.group.items.length;
    else if (n.msg.role === "tool") count++;
  }
  return count;
}

/**
 * Reasoning and a tool call that completed without producing anything are
 * transparent to the answer: the model's reply flows straight through them. A
 * tool call that returned something, or a compaction boundary, ends it.
 */
function endsAnswer(m: ChatMessage): boolean {
  if (m.compaction) return true;
  if (m.role !== "tool") return false;
  if (m.toolOutputEmpty === true) return false;
  return !(m.toolDone === true && (m.toolOutput ?? "").trim() === "");
}

/**
 * The pinned answer is the trailing run of top-level assistant messages. A model
 * that answers, then runs a tool that returns nothing, then speaks again has not
 * started a new answer, so both halves stay visible. Interim text that the model
 * wrote *before* real work resumed stays folded.
 */
export function splitTurn(messages: ChatMessage[], nestedIds: Set<string>, running = false): TurnPieces {
  const lead: ChatMessage[] = [];
  const system: ChatMessage[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") lead.push(m);
    else if (m.role === "system" && !m.compaction) system.push(m);
    else rest.push(m);
  }
  const pinned: ChatMessage[] = [];
  const taken = new Set<number>();
  const isNested = (i: number): boolean => {
    const m = rest[i];
    return Boolean(m.parentToolCallId && nestedIds.has(m.parentToolCallId));
  };

  let anchor = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (isNested(i)) continue;
    if (rest[i].role === "assistant") {
      anchor = i;
      break;
    }
    if (running) break;
  }

  if (anchor >= 0) {
    pinned.push(rest[anchor]);
    taken.add(anchor);
    for (let i = anchor - 1; i >= 0; i--) {
      if (isNested(i)) continue;
      const m = rest[i];
      if (m.role === "assistant") {
        pinned.unshift(m);
        taken.add(i);
        continue;
      }
      if (endsAnswer(m)) break;
    }
  }

  const activity = buildThreadNodes(
    rest.filter((_, i) => !taken.has(i)),
    nestedIds
  );
  return pinned.length > 0 ? { lead, activity, system, pinned } : { lead, activity, system };
}
