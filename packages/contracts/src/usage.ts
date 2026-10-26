import type { DriverKind } from "./session.js";

/** `inputTokens` is uncached input; `outputTokens` includes reasoning; `reasoningTokens` is the reasoning subset of output. */
export interface TokenCounts {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** `costUsd` is an API-equivalent estimate reported by the CLI, or null when the CLI reports none. */
export interface TurnModelUsage extends TokenCounts {
  model: string;
  costUsd: number | null;
}

export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
}

/** Native compaction signal from a harness. `trigger` is omitted when the source does not expose it. */
export interface ContextCompactionInfo {
  trigger?: "manual" | "auto";
  preTokens?: number;
  postTokens?: number;
  droppedTokens?: number;
  durationMs?: number;
}

export type UsageSeverity = "normal" | "warning" | "blocked";

export interface UsageWindow {
  id: string;
  label: string;
  percent: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
  severity: UsageSeverity;
  active?: boolean;
}

export interface UsageBalance {
  id: string;
  label: string;
  enabled: boolean;
  usedMinor?: number;
  limitMinor?: number;
  currency?: string;
  detail?: string;
}

export type AccountUsageUnavailableReason =
  | "api-key"
  | "no-subscription"
  | "logged-out"
  | "unsupported-version"
  | "not-installed"
  | "consent-required"
  | "key-rejected";

export type AccountUsageOk = {
  status: "ok";
  plan?: string;
  windows: UsageWindow[];
  balances: UsageBalance[];
  notes: string[];
};

export type AccountUsageState =
  | AccountUsageOk
  | { status: "unavailable"; reason: AccountUsageUnavailableReason; message: string }
  | { status: "error"; message: string };

export interface AccountUsageSnapshot {
  driver: DriverKind;
  fetchedAt: number;
  state: AccountUsageState;
  lastGood?: { fetchedAt: number; state: AccountUsageOk };
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

export type UsageMetric = "all" | "fresh";

export interface DailyDriverPoint {
  day: string;
  byDriver: Record<DriverKind, number>;
  turns: number;
}

export interface ModelUsageRow {
  id: string;
  driver: DriverKind | null;
  value: number;
  freshTokens: number;
  cacheReadTokens: number;
  turns: number;
  costUsd: number | null;
}

export interface SessionUsageRow {
  sessionId: string;
  projectId: string;
  driver: DriverKind;
  turns: number;
  tokens: number;
  costUsd: number | null;
}

export interface AccountUsageEntry {
  snapshot: AccountUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

export type UsageTopicData = { account: Record<DriverKind, AccountUsageEntry>; accountFetchedAt: number | null; ledgerRev: number };

export interface UsageReportQuery {
  days: number;
  metric: UsageMetric;
  driver: DriverKind | "all";
  projectId: string;
}

export interface UsageReport {
  sinceDay: string;
  daily: DailyDriverPoint[];
  models: ModelUsageRow[];
  sessions: SessionUsageRow[];
  totals: UsageTotals;
  ledgerRev: number;
}
