import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DriverKind, TurnModelUsage, UsageLedgerQuery, UsageLedgerRow } from "@cw-code/contracts";

interface MonthFile {
  version: 1;
  rows: UsageLedgerRow[];
}

interface MonthState {
  data: MonthFile;
  dirty: boolean;
  timer: NodeJS.Timeout | null;
}

export interface UsageRecordInput {
  turnId: string;
  sessionId: string;
  projectId: string;
  driver: DriverKind;
  at: Date;
  usage: TurnModelUsage[];
}

const DEBOUNCE_MS = 2000;
const MONTH_FILE_RE = /^(\d{4}-\d{2})\.json$/;

function emptyMonth(): MonthFile {
  return { version: 1, rows: [] };
}

function localDay(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthOf(day: string): string {
  return day.slice(0, 7);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidRow(value: unknown): value is UsageLedgerRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const stringFields = ["day", "sessionId", "projectId", "driver", "model"] as const;
  if (!stringFields.every((field) => typeof row[field] === "string")) return false;
  const numberFields = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "turns", "unpricedTurns"] as const;
  if (!numberFields.every((field) => isFiniteNumber(row[field]))) return false;
  return row.costUsd === null || isFiniteNumber(row.costUsd);
}

export class UsageLedger {
  private months = new Map<string, MonthState>();

  constructor(private dir: string) {}

  record(input: UsageRecordInput): void {
    if (input.usage.length === 0) return;
    const day = localDay(input.at);
    const month = monthOf(day);
    const state = this.loadMonth(month);
    const turnEntry = input.usage.reduce((largest, entry) => (entry.outputTokens > largest.outputTokens ? entry : largest));
    for (const modelUsage of input.usage) {
      const row = this.rowFor(state, day, input, modelUsage.model);
      row.inputTokens += modelUsage.inputTokens;
      row.cacheReadTokens += modelUsage.cacheReadTokens;
      row.cacheWriteTokens += modelUsage.cacheWriteTokens;
      row.outputTokens += modelUsage.outputTokens;
      row.reasoningTokens += modelUsage.reasoningTokens;
      if (modelUsage.costUsd !== null) row.costUsd = (row.costUsd ?? 0) + modelUsage.costUsd;
      if (modelUsage === turnEntry) {
        row.turns += 1;
        if (modelUsage.costUsd === null) row.unpricedTurns += 1;
      }
    }
    this.scheduleWrite(month, state);
  }

  private rowFor(state: MonthState, day: string, input: UsageRecordInput, model: string): UsageLedgerRow {
    const existing = state.data.rows.find((row) => row.day === day && row.sessionId === input.sessionId && row.model === model);
    if (existing) return existing;
    const row: UsageLedgerRow = {
      day,
      sessionId: input.sessionId,
      projectId: input.projectId,
      driver: input.driver,
      model,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      turns: 0,
      costUsd: null,
      unpricedTurns: 0
    };
    state.data.rows.push(row);
    return row;
  }

  query(q: UsageLedgerQuery): UsageLedgerRow[] {
    const rows: UsageLedgerRow[] = [];
    for (const month of this.monthsToScan(q)) {
      const state = this.loadMonth(month);
      for (const row of state.data.rows) {
        if (q.sinceDay && row.day < q.sinceDay) continue;
        if (q.sessionId && row.sessionId !== q.sessionId) continue;
        rows.push({ ...row });
      }
    }
    return rows;
  }

  flush(): void {
    for (const [month, state] of this.months) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      this.writeMonth(month, state);
    }
  }

  private monthsToScan(q: UsageLedgerQuery): string[] {
    const all = this.allMonths();
    if (q.sessionId) return all;
    if (q.sinceDay) {
      const sinceMonth = monthOf(q.sinceDay);
      return all.filter((month) => month >= sinceMonth);
    }
    return all;
  }

  private allMonths(): string[] {
    const onDisk = existsSync(this.dir)
      ? readdirSync(this.dir)
          .map((name) => MONTH_FILE_RE.exec(name)?.[1])
          .filter((month): month is string => Boolean(month))
      : [];
    return [...new Set([...onDisk, ...this.months.keys()])].sort();
  }

  private monthPath(month: string): string {
    return join(this.dir, `${month}.json`);
  }

  private loadMonth(month: string): MonthState {
    const cached = this.months.get(month);
    if (cached) return cached;
    const state: MonthState = { data: this.readMonth(month), dirty: false, timer: null };
    this.months.set(month, state);
    return state;
  }

  private readMonth(month: string): MonthFile {
    const path = this.monthPath(month);
    if (!existsSync(path)) return emptyMonth();
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; rows?: unknown };
      if (parsed?.version !== 1 || !Array.isArray(parsed.rows)) {
        console.warn(`usage ledger month file is malformed, quarantining and treating as empty: ${path}`);
        this.quarantine(path);
        return emptyMonth();
      }
      const rows: UsageLedgerRow[] = [];
      for (const row of parsed.rows) {
        if (isValidRow(row)) rows.push(row);
        else console.warn(`usage ledger dropped a malformed row in ${path}`);
      }
      return { version: 1, rows };
    } catch (err) {
      console.warn(`usage ledger month file unreadable, quarantining and treating as empty ${path}: ${(err as Error).message}`);
      this.quarantine(path);
      return emptyMonth();
    }
  }

  private quarantine(path: string): void {
    const dest = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, dest);
    } catch (err) {
      console.warn(`usage ledger could not quarantine corrupt file ${path}: ${(err as Error).message}`);
    }
  }

  private writeMonth(month: string, state: MonthState): void {
    if (!state.dirty) return;
    mkdirSync(this.dir, { recursive: true });
    const path = this.monthPath(month);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state.data), "utf8");
    renameSync(tmp, path);
    state.dirty = false;
  }

  private scheduleWrite(month: string, state: MonthState): void {
    state.dirty = true;
    if (state.timer) return;
    const timer = setTimeout(() => {
      state.timer = null;
      this.writeMonth(month, state);
    }, DEBOUNCE_MS);
    timer.unref?.();
    state.timer = timer;
  }
}
