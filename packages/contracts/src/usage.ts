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

export interface UsageLedgerRow extends TokenCounts {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  sessionId: string;
  projectId: string;
  driver: DriverKind;
  model: string;
  turns: number;
  /** Sum over priced turns; null when no turn in the row was priced. */
  costUsd: number | null;
  unpricedTurns: number;
}

export interface UsageLedgerQuery {
  sinceDay?: string;
  sessionId?: string;
}
