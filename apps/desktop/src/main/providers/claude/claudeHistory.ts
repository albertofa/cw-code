import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextCompactionInfo, HistoryMessage } from "@cw-code/contracts";
import { todosFromToolCall } from "../todos.js";
import { claudeCommandText } from "./claudeCommands.js";
import { parseClaudeTaskNotification, parseTaskNotificationUsage } from "./claudeStreamParser.js";
import { claudeTranscriptProjectDir } from "./claudeSessions.js";

type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown };

interface TranscriptLine {
  type: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  compactMetadata?: unknown;
  logicalParentUuid?: string;
  uuid?: string;
  timestamp?: unknown;
  perTurnEffort?: unknown;
  effort?: unknown;
  message?: {
    id?: unknown;
    role?: string;
    content?: string | ContentBlock[];
    usage?: unknown;
  };
}

export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

const AGENT_ID_RE = /\bagentId:\s*([0-9a-f]{8,64})\b/;

export function extractAgentId(text: string): string | undefined {
  return AGENT_ID_RE.exec(text)?.[1];
}

export function findSidecarModel(transcriptDir: string, agentId: string): string | undefined {
  return readSidecarAgent(transcriptDir, agentId)?.model;
}

export interface SidecarTool {
  id: string;
  name: string;
  input: unknown;
  timestamp?: number;
  completedAt?: number;
  output?: string;
  isError?: boolean;
}

export interface SidecarAgent {
  model?: string;
  total: number;
  items: SidecarTool[];
  effort?: string;
  totalTokens?: number;
}

const SIDECAR_MAX_LINES = 20000;
const SIDECAR_MAX_TOOLS = 200;
const SIDECAR_MAX_STRING = 1000;
const SIDECAR_MAX_OUTPUT = 600;

function truncateSidecarValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > SIDECAR_MAX_STRING ? `${value.slice(0, SIDECAR_MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) return value.map(truncateSidecarValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateSidecarValue(v);
    return out;
  }
  return value;
}

const USAGE_FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens"
] as const;

function readUsageTotal(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  let total = 0;
  let found = false;
  for (const field of USAGE_FIELDS) {
    const amount = usage[field];
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
    total += amount;
    found = true;
  }
  return found ? total : undefined;
}

export function readSidecarAgent(transcriptDir: string, agentId: string): SidecarAgent | undefined {
  if (!/^[0-9a-f]{8,64}$/.test(agentId)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(transcriptDir, "subagents", `agent-${agentId}.jsonl`), "utf8");
  } catch {
    return undefined;
  }
  let model: string | undefined;
  let perTurnEffort: string | undefined;
  let fallbackEffort: string | undefined;
  const usageByMessage = new Map<string, number>();
  const items: SidecarTool[] = [];
  const indexById = new Map<string, number>();
  let total = 0;
  let lines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (++lines > SIDECAR_MAX_LINES) break;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (parsed.isMeta) continue;
    if (!perTurnEffort && typeof parsed.perTurnEffort === "string" && parsed.perTurnEffort.trim()) {
      perTurnEffort = parsed.perTurnEffort.trim();
    }
    if (!fallbackEffort && typeof parsed.effort === "string" && parsed.effort.trim()) {
      fallbackEffort = parsed.effort.trim();
    }
    if (!model && parsed.message && typeof parsed.message === "object") {
      const msgModel = (parsed.message as { model?: unknown }).model;
      if (typeof msgModel === "string" && msgModel) model = msgModel;
    }
    const messageId = parsed.message?.id;
    const usageTotal = readUsageTotal(parsed.message?.usage);
    if (typeof messageId === "string" && messageId && usageTotal !== undefined) {
      usageByMessage.set(messageId, Math.max(usageByMessage.get(messageId) ?? -Infinity, usageTotal));
    }
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    const timestamp = toEpochMs(parsed.timestamp);
    for (const block of content) {
      if (block.type === "tool_use") {
        total++;
        const tool = block as { id?: string; name?: string; input?: unknown };
        const id = tool.id ?? `${agentId}-t${total}`;
        if (items.length < SIDECAR_MAX_TOOLS && !indexById.has(id)) {
          indexById.set(id, items.length);
          items.push({
            id,
            name: tool.name ?? "tool",
            input: truncateSidecarValue(tool.input ?? null),
            ...(timestamp !== undefined ? { timestamp } : {})
          });
        }
      } else if (block.type === "tool_result") {
        const result = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (!result.tool_use_id) continue;
        const idx = indexById.get(result.tool_use_id);
        if (idx === undefined) continue;
        items[idx] = {
          ...items[idx],
          output: blockText(result.content).slice(0, SIDECAR_MAX_OUTPUT),
          isError: result.is_error === true,
          ...(timestamp !== undefined ? { completedAt: timestamp } : {})
        };
      }
    }
  }
  if (!model) {
    const fallback = /"model"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
    if (fallback) model = fallback;
  }
  const totalTokens = usageByMessage.size > 0
    ? Array.from(usageByMessage.values()).reduce((sum, value) => sum + value, 0)
    : undefined;
  const effort = perTurnEffort ?? fallbackEffort;
  return {
    ...(model ? { model } : {}),
    total,
    items,
    ...(effort ? { effort } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
          return (b as { text?: string }).text ?? "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function claudeCompactInfo(metadata: unknown): ContextCompactionInfo {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const record = metadata as Record<string, unknown>;
  const number = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const trigger = record["trigger"] === "manual" || record["trigger"] === "auto" ? record["trigger"] : undefined;
  const preTokens = number(record["preTokens"]);
  const postTokens = number(record["postTokens"]);
  const droppedTokens = number(record["cumulativeDroppedTokens"]);
  const durationMs = number(record["durationMs"]);
  return {
    ...(trigger ? { trigger } : {}),
    ...(preTokens !== undefined ? { preTokens } : {}),
    ...(postTokens !== undefined ? { postTokens } : {}),
    ...(droppedTokens !== undefined ? { droppedTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  };
}

export function parseClaudeTranscriptLine(line: TranscriptLine): HistoryMessage[] {
  if (line.isSidechain || line.isMeta) return [];
  const timestamp = toEpochMs(line.timestamp);
  const stamp = timestamp !== undefined ? { timestamp } : {};
  if (line.type === "system") {
    if (line.subtype !== "compact_boundary") return [];
    const id = line.uuid ?? "system-compact";
    return [
      {
        id,
        role: "system",
        text: "Context compacted",
        turnId: line.logicalParentUuid ?? id,
        compaction: claudeCompactInfo(line.compactMetadata),
        ...stamp
      }
    ];
  }
  if (line.isCompactSummary || line.isVisibleInTranscriptOnly) return [];
  const content = line.message?.content;
  if (content === undefined) return [];
  const out: HistoryMessage[] = [];
  const baseId = line.uuid ?? `${line.type}-${out.length}`;

  if (line.type === "user") {
    if (typeof content === "string") {
      if (!content.trim()) return out;
      const commandText = claudeCommandText(content);
      if (commandText !== null) {
        out.push({ id: baseId, role: "user", text: commandText, turnId: baseId, ...stamp });
      } else if (content.trimStart().startsWith("<task-notification>")) {
        out.push({ id: `${baseId}-n`, role: "tool", text: content, turnId: baseId, toolName: "task-notification", ...stamp });
      } else {
        out.push({ id: baseId, role: "user", text: content, turnId: baseId, ...stamp });
      }
      return out;
    }
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block.type === "text") {
        const text = (block as { text?: string }).text ?? "";
        if (text.trim()) out.push({ id: `${baseId}-u${i}`, role: "user", text, turnId: baseId, ...stamp });
      } else if (block.type === "tool_result") {
        const result = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
        const text = blockText(result.content).slice(0, 4000);
        out.push({
          id: result.tool_use_id ? `${result.tool_use_id}-r` : `${baseId}-t${i}`,
          role: "tool",
          text,
          turnId: baseId,
          toolName: "result",
          isError: result.is_error === true,
          ...stamp
        });
      }
    }
    return out;
  }

  if (line.type === "assistant") {
    if (!Array.isArray(content)) return [];
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block.type === "text") {
        const text = (block as { text?: string }).text ?? "";
        if (text) out.push({ id: `${baseId}-a${i}`, role: "assistant", text, turnId: baseId, ...stamp });
      } else if (block.type === "thinking") {
        const text = (block as { thinking?: string }).thinking ?? "";
        if (text) out.push({ id: `${baseId}-th${i}`, role: "reasoning", text, turnId: baseId, ...stamp });
      } else if (block.type === "tool_use") {
        const tool = block as { id?: string; name?: string; input?: unknown };
        const todos = todosFromToolCall(tool.name ?? "", tool.input ?? null);
        out.push({
          id: tool.id ?? `${baseId}-c${i}`,
          role: "tool",
          text: `${tool.name ?? "tool"} ${JSON.stringify(tool.input ?? null)?.slice(0, 2000) ?? ""}`,
          turnId: baseId,
          toolName: tool.name ?? "tool",
          ...(todos !== null ? { todos } : {}),
          ...stamp
        });
      }
    }
    return out;
  }

  return [];
}

export function assignReasoningDurations(
  reasoningByMsgId: Map<string, HistoryMessage[]>,
  thinkingStart: Map<string, number>,
  lastStamp: Map<string, number>
): void {
  for (const [msgId, messages] of reasoningByMsgId) {
    const start = thinkingStart.get(msgId);
    const end = lastStamp.get(msgId);
    if (start === undefined || end === undefined || end <= start) continue;
    for (const msg of messages) msg.reasoningMs = end - start;
  }
}

export function readClaudeHistory(rootPath: string, resumeCursor: string, limit = 300): HistoryMessage[] {
  const file = join(claudeTranscriptProjectDir(rootPath, resumeCursor), `${resumeCursor}.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    console.warn(`claude history not found: ${file}`);
    return [];
  }
  const out: HistoryMessage[] = [];
  const reasoningByMsgId = new Map<string, HistoryMessage[]>();
  const thinkingStart = new Map<string, number>();
  const lastStamp = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as TranscriptLine;
      const msgId = typeof parsed.message?.id === "string" ? parsed.message.id : "";
      const stamp = toEpochMs(parsed.timestamp);
      if (msgId && stamp !== undefined) {
        const blocks = Array.isArray(parsed.message?.content) ? parsed.message.content : [];
        if (blocks.some((block) => block.type === "thinking") && !thinkingStart.has(msgId)) {
          thinkingStart.set(msgId, stamp);
        }
        lastStamp.set(msgId, Math.max(lastStamp.get(msgId) ?? 0, stamp));
      }
      for (const msg of parseClaudeTranscriptLine(parsed)) {
        if (msg.role === "reasoning" && msgId) {
          const group = reasoningByMsgId.get(msgId);
          if (group) group.push(msg);
          else reasoningByMsgId.set(msgId, [msg]);
        }
        out.push(msg);
        if (out.length > limit * 2) out.splice(0, out.length - limit * 2);
      }
    } catch {
      continue;
    }
  }
  assignReasoningDurations(reasoningByMsgId, thinkingStart, lastStamp);
  const trimmed = out.slice(-limit);
  const agentByCall = mapAgentCalls(trimmed);
  attachSidecarInfo(file, resumeCursor, trimmed, agentByCall);
  attributeSendMessages(trimmed, agentByCall);
  return foldTaskNotifications(trimmed);
}

export function mapAgentCalls(messages: HistoryMessage[]): Map<string, string> {
  const agentByCall = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.id.endsWith("-r")) {
      const agentId = extractAgentId(m.text);
      if (agentId) agentByCall.set(m.id.slice(0, -2), agentId);
    }
  }
  return agentByCall;
}

const SENDMESSAGE_TO_RE = /"to"\s*:\s*"([^"]+)"/;

export function attributeSendMessages(messages: HistoryMessage[], agentByCall: Map<string, string>): void {
  if (agentByCall.size === 0) return;
  const callByAgent = new Map<string, string>();
  for (const [callId, agentId] of agentByCall) {
    if (!callByAgent.has(agentId)) callByAgent.set(agentId, callId);
  }
  for (const m of messages) {
    if (m.parentToolCallId || m.role !== "tool" || m.toolName?.toLowerCase() !== "sendmessage") continue;
    const to = SENDMESSAGE_TO_RE.exec(m.text)?.[1];
    if (!to) continue;
    const callId = callByAgent.get(to);
    if (callId) m.parentToolCallId = callId;
  }
}

const TASK_RESULT_SCAN_LINES = 400;

export function readClaudeTaskResult(
  rootPath: string,
  resumeCursor: string,
  toolUseId: string
): { result?: string; status?: string } | undefined {
  if (!resumeCursor || !toolUseId || !/^[\w-]+$/.test(resumeCursor)) return undefined;
  const file = join(claudeTranscriptProjectDir(rootPath, resumeCursor), `${resumeCursor}.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1, scanned = 0; i >= 0 && scanned < TASK_RESULT_SCAN_LINES; i--) {
    const line = lines[i];
    if (!line.includes("<task-notification>") || !line.includes(toolUseId)) continue;
    scanned++;
    let content: unknown;
    try {
      content = (JSON.parse(line) as TranscriptLine).message?.content;
    } catch {
      continue;
    }
    if (typeof content !== "string") continue;
    const notification = parseClaudeTaskNotification(content);
    if (!notification || notification.toolUseId !== toolUseId) continue;
    return {
      result: notification.result,
      ...(notification.status ? { status: notification.status } : {})
    };
  }
  return undefined;
}

export function foldTaskNotifications(messages: HistoryMessage[]): HistoryMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const drop = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool" || m.toolName !== "task-notification") continue;
    const notification = parseClaudeTaskNotification(m.text);
    const toolUseId = notification?.toolUseId;
    const result = notification?.result;
    const target = toolUseId ? byId.get(`${toolUseId}-r`) : undefined;
    const isError = notification?.status ? notification.status.toLowerCase() !== "completed" : undefined;
    const usage = parseTaskNotificationUsage(m.text);
    if (target && result !== undefined) {
      target.text = result.slice(0, 8000);
      if (m.timestamp !== undefined) target.timestamp = m.timestamp;
      if (isError !== undefined) target.isError = isError;
      if (usage) target.toolUsage = usage;
      drop.add(m.id);
      continue;
    }
    const call = toolUseId ? byId.get(toolUseId) : undefined;
    if (call?.role === "tool" && result !== undefined) {
      m.id = `${toolUseId}-r`;
      m.text = result.slice(0, 8000);
      m.turnId = call.turnId;
      m.toolName = "result";
      if (isError !== undefined) m.isError = isError;
      if (usage) m.toolUsage = usage;
      byId.set(m.id, m);
      continue;
    }
    drop.add(m.id);
  }
  if (drop.size === 0) return messages;
  return messages.filter((m) => !drop.has(m.id));
}

function attachSidecarInfo(
  transcriptFile: string,
  resumeCursor: string,
  messages: HistoryMessage[],
  agentByCall: Map<string, string>
): void {
  if (agentByCall.size === 0) return;
  const base = dirname(transcriptFile);
  const infoByAgent = new Map<string, SidecarAgent | null>();
  for (const m of messages) {
    const agentId = agentByCall.get(m.id);
    if (!agentId) continue;
    let info = infoByAgent.get(agentId);
    if (info === undefined) {
      info =
        readSidecarAgent(join(base, resumeCursor), agentId) ?? readSidecarAgent(base, agentId) ?? null;
      infoByAgent.set(agentId, info);
    }
    if (!info) continue;
    if (!m.subagentModel && info.model) m.subagentModel = info.model;
    if (!m.subagentTools) {
      m.subagentTools = {
        total: info.total,
        items: info.items.map((t) => ({
          id: t.id,
          name: t.name,
          input: t.input,
          ...(t.timestamp !== undefined ? { timestamp: t.timestamp } : {}),
          ...(t.completedAt !== undefined ? { completedAt: t.completedAt } : {}),
          ...(t.output !== undefined ? { output: t.output } : {}),
          ...(t.isError !== undefined ? { isError: t.isError } : {})
        })),
        ...(info.effort !== undefined ? { effort: info.effort } : {}),
        ...(info.totalTokens !== undefined ? { totalTokens: info.totalTokens } : {})
      };
    }
  }
}
