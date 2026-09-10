import { recoverToolInput } from "./toolSummaries.js";
import type { SubagentToolActivity, SubagentToolSummary } from "../cw.js";

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
  parentToolCallId?: string;
  toolStartedAt?: number;
  toolCompletedAt?: number;
}

export type SubagentStatus = "running" | "completed" | "error";

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
  runInBackground?: boolean;
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

export function describeSubagentStatus(m: SubagentMessage): SubagentStatus {
  if (m.isError === true) return "error";
  return isDone(m) ? "completed" : "running";
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
  const model = pick(args, "model") ?? shortModelName(m.subagentModel);
  const runRaw = args["run_in_background"] ?? args["runInBackground"];
  const runInBackground = typeof runRaw === "boolean" ? runRaw : undefined;
  const status = describeSubagentStatus(m);
  const summary = firstLine(m.toolOutput ?? "", 140) || firstLine(prompt ?? "", 140) || name;
  const startedAt = typeof m.toolStartedAt === "number" ? m.toolStartedAt : undefined;
  const completedAt = typeof m.toolCompletedAt === "number" ? m.toolCompletedAt : undefined;
  const durationMs =
    startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
      ? completedAt - startedAt
      : undefined;
  const resultCounts = parseResultCounts(m.toolOutput);
  const counts: SubagentCounts = { ...resultCounts };
  if (m.subagentTools) {
    counts.tools = m.subagentTools.total;
    if (m.subagentTools.effort !== undefined) counts.effort = m.subagentTools.effort;
    if (m.subagentTools.totalTokens !== undefined) {
      counts.tokens = m.subagentTools.totalTokens;
      delete counts.tokensRaw;
    }
  }
  return {
    id: m.id,
    turnId: m.turnId,
    name,
    agentType,
    prompt,
    model,
    runInBackground,
    status,
    summary,
    output: m.toolOutput,
    startedAt,
    completedAt,
    durationMs,
    counts: Object.keys(counts).length > 0 ? counts : undefined,
    tools: m.subagentTools?.items ?? [],
    toolCount: m.subagentTools?.total ?? 0
  };
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

export function groupStatus(items: Pick<SubagentInfo, "status">[]): SubagentStatus {
  if (items.some((i) => i.status === "running")) return "running";
  if (items.some((i) => i.status === "error")) return "error";
  return "completed";
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
