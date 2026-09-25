import type { CommandOption } from "./commands.js";
import type { AccountUsageState } from "./usage.js";
import type { ModelOption, PermissionMode, PermissionOption, SessionMeta, TurnRequest } from "./session.js";
import type {
  ApprovalDecision,
  HistoryMessage,
  SessionEvent,
  SubagentToolActivity,
  ThreadEvent
} from "./events.js";

export interface TurnHandle {
  turnId: string;
  events: AsyncIterable<ThreadEvent>;
}

export interface SubagentToolsResult {
  items: SubagentToolActivity[];
  model?: string;
  effort?: string;
  tokens?: number;
}

export interface RetryConnectionRequest {
  sessionId: string;
  cwd: string;
  resumeCursor: string;
  permissionMode?: PermissionMode;
}

export interface RetryConnectionResult {
  status: "running" | "done";
  turnId?: string;
  history: HistoryMessage[];
}

export interface DriverActivity {
  busySessionIds: string[];
  ownedProcesses: number;
}

export interface CliDriver {
  readonly kind: SessionMeta["driver"];
  listSessions(projectRoot: string, projectId?: string): Promise<SessionMeta[]>;
  getHistory(projectRoot: string, resumeCursor: string): Promise<HistoryMessage[]>;
  /** Tool activity and metrics recorded for a subagent spawned by a session, when the provider exposes it. */
  getSubagentTools?(projectRoot: string, resumeCursor: string, agentId: string): Promise<SubagentToolsResult>;
  startTurn(request: TurnRequest): TurnHandle;
  interrupt(turnId: string): void;
  /** Force-stop all work for a local session (kill the underlying process). */
  stopSession?(sessionId: string): void;
  /** Re-establish the CLI connection for a session after a disconnect and refetch its state. */
  retryConnection?(request: RetryConnectionRequest): Promise<RetryConnectionResult>;
  renameSession(sessionId: string, title: string): Promise<void>;
  events(): AsyncIterable<SessionEvent>;
  listModels?(cwd: string): Promise<ModelOption[]>;
  listPermissionModes?(cwd: string): Promise<PermissionOption[]>;
  listCommands?(cwd: string): Promise<CommandOption[]>;
  respondToApproval?(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondToQuestion?(requestId: string, answers: Record<string, string>): Promise<void>;
  getAccountUsage?(): Promise<AccountUsageState>;
  /** Snapshot of the sessions this driver is busy for (including internal ones) and the processes it currently owns. */
  activity?(): DriverActivity;
  /**
   * Asks every owned process to exit and waits up to `timeoutMs`. Processes still alive at the deadline are
   * left for `dispose()` to force-stop, and the result reports `timedOut`. Never touches processes it did not spawn.
   */
  shutdown?(opts: { timeoutMs: number }): Promise<{ timedOut: boolean }>;
  dispose?(): void;
}

export type { SessionMeta, ThreadEvent, HistoryMessage, TurnRequest };
