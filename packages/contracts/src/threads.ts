import type { ApprovalRequest, HistoryMessage, QuestionRequest, TodoItem } from "./events.js";
import type { BabysitState, PrDockEntry, SessionPrItem } from "./pullRequests.js";
import type { SubagentSummary, TurnChanges } from "./session.js";
import type { ContextUsage, TokenCounts, UsageTotals } from "./usage.js";

export interface ThreadItem extends HistoryMessage {
  seq: number;
  toolInput?: unknown;
  toolOutput?: string;
  toolDone?: boolean;
  toolStartedAt?: number;
  toolCompletedAt?: number;
  reasoningStartedAt?: number;
  retryable?: boolean;
  severity?: "warning";
  pending?: true;
}

export interface ThreadTurn {
  phase: "starting" | "running";
  turnId: string | null;
  startedAt: number;
  auto: boolean;
}

export interface ThreadHistory {
  state: "loading" | "loaded" | "error";
  error: string | null;
  retrying: boolean;
}

export interface ThreadLastTurn extends TokenCounts {
  costUsd: number | null;
  durationMs: number | null;
  tokens: number;
}

export interface ContextMeter {
  percent: number;
  severity: "warn" | "danger" | null;
}

export interface ThreadUsage {
  context: ContextUsage | null;
  meter: ContextMeter | null;
  lastTurn: ThreadLastTurn | null;
}

/** Set while the session's own turn has ended but it stays working for subagents it dispatched. */
export interface ThreadSubagentWait {
  since: number;
}

/** A message the user sent while the session was busy that the harness has not received yet. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: string[];
  skills?: string[];
  createdAt: number;
  /** sending: delivered without user action. held: waits for "Send now" or "Remove". */
  state: "sending" | "held";
  /** false once it sits inside a harness that cannot take it back. */
  removable: boolean;
}

export interface ThreadTurnChanges {
  changes: TurnChanges | null;
  error: string | null;
  turnId: string | null;
  rootSessionIds: string[];
}

export type ThreadTopicData = {
  history: ThreadHistory;
  turn: ThreadTurn | null;
  durations: Record<string, number>;
  usage: ThreadUsage;
  usageTotals: UsageTotals | null;
  usageTotalsError: string | null;
  todos: TodoItem[];
  approvals: ApprovalRequest[];
  questions: QuestionRequest[];
  babysit: BabysitState | null;
  prItems: SessionPrItem[];
  prDock: PrDockEntry[];
  turnChanges: ThreadTurnChanges | null;
  subagents: SubagentSummary[];
  subagentWait: ThreadSubagentWait | null;
  queuedMessages: QueuedMessage[];
} &{ [key: `item/${string}`]: ThreadItem };
