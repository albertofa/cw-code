import { recoverToolInput } from "./toolSummaries.js";
import type { SubagentToolActivity, SubagentToolSummary, TaskSnapshot, TaskState, ToolUsage } from "../cw.js";

export interface SubagentMessage {
  id: string;
  role: string;
  text: string;
  turnId: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolDone?: boolean;
  isError?: boolean;
  timestamp?: number;
  subagentModel?: string;
  subagentTools?: SubagentToolSummary;
  subagentAgentId?: string;
  toolUsage?: ToolUsage;
  parentToolCallId?: string;
  toolStartedAt?: number;
  toolCompletedAt?: number;
  task?: TaskSnapshot;
}

export type SubagentStatus = TaskState;

export interface SubagentCounts {
  tokens?: number;
  tokensRaw?: string;
  tools?: number;
  model?: string;
  effort?: string;
}

export interface SubagentInfo {
  id: string;
  turnId: string;
  name: string;
  agentType?: string;
  prompt?: string;
  model?: string;
  agentId?: string;
  status: SubagentStatus;
  summary: string;
  output?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  counts?: SubagentCounts;
  tools: SubagentToolActivity[];
  toolCount: number;
}

export interface SubagentGroup {
  id: string;
  turnId: string;
  items: SubagentInfo[];
}

export interface SubagentGroupMetrics {
  tokens?: number;
  tools?: number;
  effort?: string;
}

const SUBAGENT_TOOLS = new Set(["task", "agent"]);

export function isSubagentTool(name?: string): boolean {
  return !!name && SUBAGENT_TOOLS.has(name.toLowerCase());
}

export function isSubagentMessage(m: Pick<SubagentMessage, "role" | "toolName">): boolean {
  return m.role === "tool" && isSubagentTool(m.toolName);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pick(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const s = str(args[k]);
    if (s) return s;
  }
  return undefined;
}

const FRAGMENT_FIELDS: Array<{ field: string; keys: string[] }> = [
  { field: "description", keys: ["description"] },
  { field: "prompt", keys: ["prompt"] },
  { field: "subagent_type", keys: ["subagent_type", "subagentType", "subagent", "agent", "mode"] },
  { field: "model", keys: ["model"] }
];

export function extractJsonStringFragment(text: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "s").exec(text);
    if (!match) continue;
    const raw = match[1];
    const closed = text[match.index + match[0].length] === '"';
    let value: string;
    try {
      const parsed: unknown = JSON.parse(`"${raw}"`);
      value = typeof parsed === "string" ? parsed : raw;
    } catch {
      value = raw
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\\n/g, "\n");
    }
    if (!value.trim()) continue;
    return closed ? value : `${value}…`;
  }
  return undefined;
}

function resolveInput(m: SubagentMessage): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (m.toolInput && typeof m.toolInput === "object" && !Array.isArray(m.toolInput)) {
    base = m.toolInput as Record<string, unknown>;
  } else {
    const recovered = recoverToolInput(m.toolName ?? "", m.text);
    if (recovered && typeof recovered === "object" && !Array.isArray(recovered)) {
      base = recovered as Record<string, unknown>;
    }
  }
  const merged: Record<string, unknown> = { ...base };
  for (const { field, keys } of FRAGMENT_FIELDS) {
    if (pick(merged, ...keys) !== undefined) continue;
    const fragment = extractJsonStringFragment(m.text, keys);
    if (fragment !== undefined) merged[field] = fragment;
  }
  return merged;
}

const TASK_TAG_RE = /<\/?task(?:\s[^>]*)?>/gi;
const TASK_RESULT_RE = /<task_result>([\s\S]*?)(?:<\/task_result>|$)/i;

export function unwrapTaskOutput(output: string | undefined): string | undefined {
  if (!output) return output;
  const text = output.trim();
  if (!text.startsWith("<task")) return output;
  const inner = TASK_RESULT_RE.exec(text)?.[1];
  if (inner !== undefined && inner.trim()) return inner.trim();
  return text.replace(TASK_TAG_RE, "").trim();
}

function firstLine(text: string, max: number): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function isDone(m: SubagentMessage): boolean {
  return m.toolDone === true || m.toolOutput !== undefined;
}

function resolveStatus(m: SubagentMessage): SubagentStatus {
  if (m.task) return m.task.state;
  if (m.isError === true) return "failed";
  return isDone(m) ? "completed" : "unknown";
}

function resolveBody(m: SubagentMessage): string {
  if (m.task?.output !== undefined) return unwrapTaskOutput(m.task.output) ?? "";
  if (m.task?.background) return "";
  return unwrapTaskOutput(m.toolOutput) ?? "";
}

function resolveUsage(m: SubagentMessage): ToolUsage | undefined {
  return m.task ? m.task.usage : m.toolUsage;
}

function resolveDuration(m: SubagentMessage, startedAt?: number, completedAt?: number): number | undefined {
  const reported = resolveUsage(m)?.durationMs;
  if (reported !== undefined) return reported;
  if (startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt) {
    return completedAt - startedAt;
  }
  return undefined;
}

function resolveCounts(m: SubagentMessage, body: string): SubagentCounts | undefined {
  const usage = resolveUsage(m);
  const counts: SubagentCounts = { ...parseResultCounts(body || undefined) };
  if (usage?.tokens !== undefined) counts.tokens = usage.tokens;
  if (usage?.toolUses !== undefined) counts.tools = usage.toolUses;
  if (m.subagentTools) {
    counts.tools = m.subagentTools.total;
    if (m.subagentTools.effort !== undefined) counts.effort = m.subagentTools.effort;
    if (m.subagentTools.totalTokens !== undefined) {
      counts.tokens = m.subagentTools.totalTokens;
      delete counts.tokensRaw;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function resolveAgentId(m: SubagentMessage): string | undefined {
  return m.subagentAgentId ?? (m.task?.kind === "agent" ? m.task.cliTaskId : undefined);
}

export function shortModelName(model: string | undefined): string | undefined {
  if (!model || !model.trim()) return undefined;
  const short = model.startsWith("claude-") ? model.slice("claude-".length) : model;
  return short || undefined;
}

export function parseResultCounts(output: string | undefined): SubagentCounts | undefined {
  if (!output) return undefined;
  const counts: SubagentCounts = {};
  const kTok = /(\d+(?:\.\d+)?)\s*k\s*tok(?:ens?)?\b/i.exec(output);
  if (kTok) {
    counts.tokens = Math.round(Number.parseFloat(kTok[1]) * 1000);
    counts.tokensRaw = kTok[0].replace(/\s+/g, " ");
  } else {
    const plainTok = /(\d[\d,]*)\s*tok(?:ens?)?\b/i.exec(output);
    if (plainTok) {
      counts.tokens = Number.parseInt(plainTok[1].replace(/,/g, ""), 10);
      counts.tokensRaw = plainTok[0].replace(/\s+/g, " ");
    }
  }
  const tools = /(\d+)\s+tools?\b/i.exec(output);
  if (tools) counts.tools = Number.parseInt(tools[1], 10);
  const model = /\bmodel\s*:\s*([A-Za-z0-9._/-]+)/i.exec(output);
  if (model) counts.model = model[1].replace(/[.]+$/, "");
  const effort = /\beffort\s*:\s*(low|medium|high|xhigh|max)\b/i.exec(output);
  if (effort) counts.effort = effort[1].toLowerCase();
  return Object.keys(counts).length > 0 ? counts : undefined;
}

export function describeSubagent(m: SubagentMessage): SubagentInfo {
  const args = resolveInput(m);
  const prompt = pick(args, "prompt");
  const name = pick(args, "description") || firstLine(prompt ?? "", 80) || "Subagent";
  const agentType = pick(args, "subagent_type", "subagentType", "subagent", "agent", "mode");
  const body = resolveBody(m);
  const summary = firstLine(body, 140) || firstLine(prompt ?? "", 140) || name;
  const startedAt = m.task?.startedAt ?? m.toolStartedAt;
  const completedAt = m.task ? m.task.endedAt : m.toolCompletedAt;
  const counts = resolveCounts(m, body);
  const agentId = resolveAgentId(m);
  const model = pick(args, "model") ?? shortModelName(m.subagentModel) ?? shortModelName(counts?.model);
  return {
    id: m.id,
    turnId: m.turnId,
    name,
    agentType,
    prompt,
    model,
    ...(agentId ? { agentId } : {}),
    status: resolveStatus(m),
    summary,
    output: body || undefined,
    startedAt,
    completedAt,
    durationMs: resolveDuration(m, startedAt, completedAt),
    counts,
    tools: m.subagentTools?.items ?? [],
    toolCount: m.subagentTools?.total ?? resolveUsage(m)?.toolUses ?? 0
  };
}

export function mergeSubagentTools(
  live: SubagentMessage[],
  fetched: SubagentToolActivity[]
): SubagentToolActivity[] {
  const byId = new Map<string, SubagentToolActivity>();
  for (const tool of fetched) byId.set(tool.id, tool);
  for (const message of live) {
    if (message.role !== "tool" || !message.toolName || message.toolName === "result") continue;
    byId.set(message.id, {
      id: message.id,
      name: message.toolName,
      input: message.toolInput,
      ...(message.toolStartedAt !== undefined
        ? { timestamp: message.toolStartedAt }
        : message.timestamp !== undefined
          ? { timestamp: message.timestamp }
          : {}),
      ...(message.toolCompletedAt !== undefined ? { completedAt: message.toolCompletedAt } : {}),
      ...(message.toolOutput !== undefined ? { output: message.toolOutput } : {}),
      ...(message.isError !== undefined ? { isError: message.isError } : {})
    });
  }
  return [...byId.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

export function groupSubagents(messages: SubagentMessage[]): SubagentGroup[] {
  const groups: SubagentGroup[] = [];
  let current: SubagentInfo[] = [];
  const flush = () => {
    if (current.length > 0) {
      groups.push({ id: current[0].id, turnId: current[0].turnId, items: current });
      current = [];
    }
  };
  for (const m of messages) {
    if (isSubagentMessage(m)) {
      current.push(describeSubagent(m));
    } else {
      flush();
    }
  }
  flush();
  return groups;
}

export function collectSubagents(messages: SubagentMessage[]): SubagentInfo[] {
  return messages.filter(isSubagentMessage).map(describeSubagent);
}

export function collectAgentMessages<T extends { parentToolCallId?: string }>(
  messages: T[],
  agentId: string
): T[] {
  return messages.filter((m) => m.parentToolCallId === agentId);
}

export interface SubagentActivity<T> {
  nested: T[];
  tools: SubagentToolActivity[];
  toolCount: number;
}

export function subagentActivity<T extends SubagentMessage>(
  messages: T[],
  item: Pick<SubagentInfo, "id" | "tools" | "toolCount">,
  fetched?: SubagentToolActivity[]
): SubagentActivity<T> {
  const nested = collectAgentMessages(messages, item.id);
  const tools = mergeSubagentTools(nested, [...item.tools, ...(fetched ?? [])]);
  return { nested, tools, toolCount: Math.max(item.toolCount, tools.length) };
}

const GROUP_STATUS_PRECEDENCE: readonly SubagentStatus[] = ["running", "failed", "stopped", "interrupted", "unknown"];

export function groupStatus(items: Pick<SubagentInfo, "status">[]): SubagentStatus {
  return GROUP_STATUS_PRECEDENCE.find((status) => items.some((i) => i.status === status)) ?? "completed";
}

export function groupSubagentMetrics(items: Pick<SubagentInfo, "counts">[]): SubagentGroupMetrics {
  let tokens = 0;
  let tools = 0;
  let hasTokens = false;
  let hasTools = false;
  const efforts = new Set<string>();
  for (const item of items) {
    if (item.counts?.tokens !== undefined) {
      tokens += item.counts.tokens;
      hasTokens = true;
    }
    if (item.counts?.tools !== undefined) {
      tools += item.counts.tools;
      hasTools = true;
    }
    if (item.counts?.effort) efforts.add(item.counts.effort);
  }
  return {
    ...(hasTokens ? { tokens } : {}),
    ...(hasTools ? { tools } : {}),
    ...(efforts.size > 0 ? { effort: efforts.size === 1 ? Array.from(efforts)[0] : "mixed" } : {})
  };
}

export function formatSubagentCount(n: number): string {
  return n === 1 ? "1 subagent" : `${n} subagents`;
}

export function formatTokensShort(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 1_000_000) {
    const m = Math.round((n / 1_000_000) * 10) / 10;
    return `${Number.isInteger(m) ? m.toFixed(0) : String(m)}M`;
  }
  const k = n / 1000;
  const rounded = Math.round(k * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}k`;
}
