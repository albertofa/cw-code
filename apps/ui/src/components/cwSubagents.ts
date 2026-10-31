import type { DriverKind, SessionStatus, SubagentResult, SubagentSummary, TaskState } from "@cw-code/contracts";
import { isDriverKind } from "@cw-code/shared/driverKinds";
import { cwSubagentToolOf, normalizeSubagentTitle, parseWakePrompt, type SubagentToolName, type WakeEntry } from "@cw-code/shared/subagents";

export type CwSubagentCardTool = Extract<SubagentToolName, "subagent_run" | "subagent_send" | "subagent_wait">;

const CARD_TOOLS: readonly SubagentToolName[] = ["subagent_run", "subagent_send", "subagent_wait"];

export function cwToolOf(toolName: string | undefined, sessionDriver?: DriverKind): SubagentToolName | null {
  if (!toolName) return null;
  return cwSubagentToolOf(toolName, sessionDriver);
}

export function cwSubagentCardTool(toolName: string | undefined, sessionDriver?: DriverKind): CwSubagentCardTool | null {
  const tool = cwToolOf(toolName, sessionDriver);
  return tool && CARD_TOOLS.includes(tool) ? (tool as CwSubagentCardTool) : null;
}

export interface CwSubagentOutput {
  subagentId?: string;
  status?: string;
  resultText?: string | null;
  timedOut?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function textBlocksOf(value: unknown): string | undefined {
  const blocks = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value["content"]) ? value["content"] : null;
  if (!blocks) return undefined;
  for (const block of blocks) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") return block["text"];
  }
  return undefined;
}

function outputOfRecord(value: Record<string, unknown>): CwSubagentOutput | null {
  if (!("subagentId" in value) && !("status" in value) && !("resultText" in value)) return null;
  const out: CwSubagentOutput = {};
  const subagentId = str(value["subagentId"]);
  if (subagentId) out.subagentId = subagentId;
  const status = str(value["status"]);
  if (status) out.status = status;
  if (typeof value["resultText"] === "string" || value["resultText"] === null) out.resultText = value["resultText"] as string | null;
  if (typeof value["timedOut"] === "boolean") out.timedOut = value["timedOut"];
  return out;
}

function fieldFragment(text: string, key: string): string | undefined {
  const match = new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*\\\\?"([A-Za-z0-9_.:-]+)`).exec(text);
  return match?.[1];
}

export function parseCwSubagentOutput(output: string | undefined): CwSubagentOutput | null {
  if (!output?.trim()) return null;
  let value = tryJson(output.trim());
  for (let depth = 0; depth < 3 && value !== undefined; depth++) {
    if (isRecord(value)) {
      const direct = outputOfRecord(value);
      if (direct) return direct;
      const structured = value["structuredContent"];
      if (isRecord(structured)) {
        const fromStructured = outputOfRecord(structured);
        if (fromStructured) return fromStructured;
      }
    }
    const inner = textBlocksOf(value);
    value = inner === undefined ? undefined : tryJson(inner.trim());
  }
  const subagentId = fieldFragment(output, "subagentId");
  const status = fieldFragment(output, "status");
  if (!subagentId && !status) return null;
  return { ...(subagentId ? { subagentId } : {}), ...(status ? { status } : {}) };
}

export interface CwSubagentCall {
  tool: CwSubagentCardTool;
  subagentId?: string;
  driver?: DriverKind;
  title?: string;
  prompt?: string;
  model?: string;
  output: CwSubagentOutput | null;
}

function argsOf(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const nested = input["input"];
  return isRecord(nested) ? { ...nested, ...input } : input;
}

export function describeCwSubagentCall(
  toolName: string | undefined,
  input: unknown,
  output: string | undefined,
  sessionDriver?: DriverKind
): CwSubagentCall | null {
  const tool = cwSubagentCardTool(toolName, sessionDriver);
  if (!tool) return null;
  const args = argsOf(input);
  const parsed = parseCwSubagentOutput(output);
  const driver = str(args["driver"]);
  const call: CwSubagentCall = { tool, output: parsed };
  const subagentId = parsed?.subagentId ?? str(args["subagentId"]);
  if (subagentId) call.subagentId = subagentId;
  if (isDriverKind(driver)) call.driver = driver;
  const title = str(args["title"]);
  if (title) call.title = title;
  const prompt = str(args["task"]) ?? str(args["prompt"]);
  if (prompt) call.prompt = prompt;
  const model = str(args["model"]);
  if (model) call.model = model;
  return call;
}

const CREATE_SLACK_MS = 2000;
const UNFINISHED_CALL_WINDOW_MS = 60_000;

export function matchCwSubagent(
  subagents: readonly SubagentSummary[],
  call: Pick<CwSubagentCall, "tool" | "subagentId" | "driver" | "title">,
  startedAt: number | undefined,
  completedAt?: number
): SubagentSummary | undefined {
  if (call.subagentId) return subagents.find((summary) => summary.id === call.subagentId);
  if (call.tool !== "subagent_run" || startedAt === undefined) return undefined;
  const windowEnd = completedAt ?? startedAt + UNFINISHED_CALL_WINDOW_MS;
  const title = call.title === undefined ? undefined : normalizeSubagentTitle(call.title);
  const candidates = subagents.filter(
    (summary) =>
      summary.createdAt >= startedAt - CREATE_SLACK_MS &&
      summary.createdAt <= windowEnd &&
      (call.driver === undefined || summary.driver === call.driver) &&
      (title === undefined || summary.title === title)
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function resultTextFor(
  call: Pick<CwSubagentCall, "output">,
  summary: Pick<SubagentSummary, "status" | "result"> | undefined,
  startedAt: number | undefined
): string | null {
  const own = call.output?.resultText;
  if (typeof own === "string" && own.trim()) return own;
  const result = summary?.result;
  if (!result?.text || summary?.status === "working") return null;
  return startedAt === undefined || result.at >= startedAt ? result.text : null;
}

export type CwSubagentState = TaskState | "waiting";

const FINISHED: readonly string[] = ["idle", "done", "holding", "babysit"] satisfies SessionStatus[];
const CLOSED: readonly string[] = ["resolved", "archived"] satisfies SessionStatus[];

export function cwSubagentState(status: string | undefined, outcome?: SubagentResult["outcome"]): CwSubagentState {
  if (status === "working") return "running";
  if (status === "input-required") return "waiting";
  if (outcome === "done") return "completed";
  if (outcome === "error") return "failed";
  if (outcome === "interrupted") return "interrupted";
  if (status && CLOSED.includes(status)) return "stopped";
  if (status && FINISHED.includes(status)) return "completed";
  return "unknown";
}

export function summaryState(summary: Pick<SubagentSummary, "status" | "result">): CwSubagentState {
  return cwSubagentState(summary.status, summary.status === "working" ? undefined : summary.result?.outcome);
}

function isOpenSubagent(summary: Pick<SubagentSummary, "status">): boolean {
  return !CLOSED.includes(summary.status);
}

export function hasPendingRequests(summary: Pick<SubagentSummary, "status" | "pendingRequests">): boolean {
  return summary.pendingRequests > 0 && isOpenSubagent(summary);
}

const wakeCache = new WeakMap<object, WakeEntry[] | null>();

export function wakeEntriesOf(item: { role: string; text: string }): WakeEntry[] | null {
  if (item.role !== "user") return null;
  const cached = wakeCache.get(item);
  if (cached !== undefined) return cached;
  const entries = parseWakePrompt(item.text);
  wakeCache.set(item, entries);
  return entries;
}

export const WAKE_OUTCOME_STATE: Record<WakeEntry["outcome"], CwSubagentState> = {
  done: "completed",
  error: "failed",
  interrupted: "interrupted"
};
