import type { DriverName, UsageLedgerRow } from "../cw.js";

export type UsageMetric = "all" | "fresh";

export interface DailyDriverPoint {
  day: string;
  byDriver: Record<DriverName, number>;
  turns: number;
}

export interface ModelUsageRow {
  id: string;
  driver: DriverName | null;
  value: number;
  freshTokens: number;
  cacheReadTokens: number;
  turns: number;
  costUsd: number | null;
}

export interface SessionUsageRow {
  sessionId: string;
  projectId: string;
  driver: DriverName;
  turns: number;
  tokens: number;
  costUsd: number | null;
}

export interface UsageTotals {
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number | null;
  turns: number;
  sessions: number;
  unpricedTurns: number;
}

function metricValue(row: UsageLedgerRow, metric: UsageMetric): number {
  return metric === "all"
    ? row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens
    : row.inputTokens + row.cacheWriteTokens + row.outputTokens;
}

export function localDayString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addCost(current: number | null, addend: number | null): number | null {
  if (addend === null) return current;
  return (current ?? 0) + addend;
}

export function dailyByDriver(rows: UsageLedgerRow[], days: number, metric: UsageMetric, today: Date): DailyDriverPoint[] {
  const byDay = new Map<string, UsageLedgerRow[]>();
  for (const row of rows) {
    const list = byDay.get(row.day);
    if (list) list.push(row);
    else byDay.set(row.day, [row]);
  }
  const points: DailyDriverPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = localDayString(d);
    const dayRows = byDay.get(day) ?? [];
    const byDriver: Record<DriverName, number> = { claude: 0, codex: 0, opencode: 0 };
    let turns = 0;
    for (const row of dayRows) {
      byDriver[row.driver] += metricValue(row, metric);
      turns += row.turns;
    }
    points.push({ day, byDriver, turns });
  }
  return points;
}

export function byModel(rows: UsageLedgerRow[], metric: UsageMetric, top = 6): ModelUsageRow[] {
  const byKey = new Map<string, ModelUsageRow>();
  for (const row of rows) {
    const existing = byKey.get(row.model);
    const entry: ModelUsageRow = existing ?? {
      id: row.model,
      driver: row.driver,
      value: 0,
      freshTokens: 0,
      cacheReadTokens: 0,
      turns: 0,
      costUsd: null
    };
    entry.value += metricValue(row, metric);
    entry.freshTokens += row.inputTokens + row.cacheWriteTokens + row.outputTokens;
    entry.cacheReadTokens += row.cacheReadTokens;
    entry.turns += row.turns;
    entry.costUsd = addCost(entry.costUsd, row.costUsd);
    byKey.set(row.model, entry);
  }
  const sorted = [...byKey.values()].sort((a, b) => b.value - a.value);
  if (sorted.length <= top) return sorted;
  const shown = sorted.slice(0, top);
  const rest = sorted.slice(top);
  const other: ModelUsageRow = rest.reduce<ModelUsageRow>(
    (acc, row) => ({
      id: acc.id,
      driver: null,
      value: acc.value + row.value,
      freshTokens: acc.freshTokens + row.freshTokens,
      cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
      turns: acc.turns + row.turns,
      costUsd: addCost(acc.costUsd, row.costUsd)
    }),
    { id: `Other (${rest.length})`, driver: null, value: 0, freshTokens: 0, cacheReadTokens: 0, turns: 0, costUsd: null }
  );
  return [...shown, other];
}

export function topSessions(rows: UsageLedgerRow[], limit = 5): SessionUsageRow[] {
  const byKey = new Map<string, SessionUsageRow>();
  for (const row of rows) {
    const existing = byKey.get(row.sessionId);
    const entry: SessionUsageRow = existing ?? {
      sessionId: row.sessionId,
      projectId: row.projectId,
      driver: row.driver,
      turns: 0,
      tokens: 0,
      costUsd: null
    };
    entry.turns += row.turns;
    entry.tokens += row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens;
    entry.costUsd = addCost(entry.costUsd, row.costUsd);
    byKey.set(row.sessionId, entry);
  }
  return [...byKey.values()].sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

export function totals(rows: UsageLedgerRow[]): UsageTotals {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let unpricedTurns = 0;
  let costUsd: number | null = null;
  const sessions = new Set<string>();
  for (const row of rows) {
    inputTokens += row.inputTokens;
    cacheReadTokens += row.cacheReadTokens;
    cacheWriteTokens += row.cacheWriteTokens;
    outputTokens += row.outputTokens;
    turns += row.turns;
    unpricedTurns += row.unpricedTurns;
    sessions.add(row.sessionId);
    costUsd = addCost(costUsd, row.costUsd);
  }
  return {
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    costUsd,
    turns,
    sessions: sessions.size,
    unpricedTurns
  };
}
