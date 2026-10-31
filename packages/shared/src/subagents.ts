import type { DriverKind, SubagentResult } from "@cw-code/contracts";

export const SUBAGENT_TOOL_NAMES = ["subagent_run", "subagent_wait", "subagent_send", "subagent_stop", "subagents_list", "subagent_targets"] as const;

export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

const CW_TOOL_PREFIXES = ["mcp__plugin_cw-code_cw__", "mcp__cw__", "cw_"] as const;

export function cwSubagentToolOf(toolName: string): SubagentToolName | null {
  for (const prefix of CW_TOOL_PREFIXES) {
    if (!toolName.startsWith(prefix)) continue;
    const tool = toolName.slice(prefix.length);
    return SUBAGENT_TOOL_NAMES.find((name) => name === tool) ?? null;
  }
  return null;
}

export interface WakeEntry {
  subagentId: string;
  driver: DriverKind;
  title: string;
  outcome: SubagentResult["outcome"];
  text: string | null;
}

const WAKE_OPEN = "<cw-subagent-results>";
const WAKE_CLOSE = "</cw-subagent-results>";
const WAKE_INSTRUCTION = "These are the results of the subagents you dispatched. Continue your task using them.";
const DRIVERS: readonly string[] = ["claude", "opencode", "codex"] satisfies DriverKind[];
const OUTCOMES: readonly string[] = ["done", "error", "interrupted"] satisfies SubagentResult["outcome"][];

export function buildWakePrompt(entries: WakeEntry[]): string {
  const json = JSON.stringify(entries).replaceAll("<", "\\u003c");
  return `${WAKE_INSTRUCTION}\n\n${WAKE_OPEN}\n${json}\n${WAKE_CLOSE}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wakeEntryOf(value: unknown): WakeEntry | null {
  if (!isRecord(value)) return null;
  const { subagentId, driver, title, outcome, text } = value;
  if (typeof subagentId !== "string" || typeof title !== "string") return null;
  if (typeof driver !== "string" || !DRIVERS.includes(driver)) return null;
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) return null;
  if (text !== null && typeof text !== "string") return null;
  return { subagentId, driver: driver as DriverKind, title, outcome: outcome as WakeEntry["outcome"], text };
}

export function parseWakePrompt(text: string): WakeEntry[] | null {
  const start = text.indexOf(WAKE_OPEN);
  if (start < 0) return null;
  const bodyStart = start + WAKE_OPEN.length;
  const end = text.indexOf(WAKE_CLOSE, bodyStart);
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(bodyStart, end));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entries: WakeEntry[] = [];
  for (const item of parsed) {
    const entry = wakeEntryOf(item);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}
