import type { CommandOption } from "./commands.js";
import type { NativeSession } from "./importer.js";
import type { AccountUsageState } from "./usage.js";
import type { ModelOption, PermissionMode, PermissionOption, SessionMeta, TurnRequest } from "./session.js";
import type { TaskSnapshot } from "./tasks.js";
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

/** How an interactive terminal joins a server the driver already runs instead of starting its own. */
export interface TerminalLaunch {
  /** Arguments placed before the resume arguments. */
  args: string[];
  env: Record<string, string>;
  /** Lets the driver stop the server again once the terminal exits. */
  release(): void;
}

export interface CliDriver {
  readonly kind: SessionMeta["driver"];
  listSessions(projectRoot: string, projectId?: string): Promise<SessionMeta[]>;
  /** Every session the harness has recorded, across all working directories. */
  listNativeSessions?(): Promise<NativeSession[]>;
  getHistory(projectRoot: string, resumeCursor: string): Promise<HistoryMessage[]>;
  /** Tool activity and metrics recorded for a subagent spawned by a session, when the provider exposes it. */
  getSubagentTools?(projectRoot: string, resumeCursor: string, agentId: string): Promise<SubagentToolsResult>;
  /** Tasks the driver's live CLI processes are tracking for a session; empty when the session has no live process. */
  liveTasks?(sessionId: string): TaskSnapshot[];
  startTurn(request: TurnRequest): TurnHandle;
  interrupt(turnId: string): void;
  /** Force-stop all work for a local session (kill the underlying process). Callers await the result before deleting session resources. */
  stopSession?(sessionId: string): void | Promise<void>;
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
  terminalLaunch?(cwd: string): Promise<TerminalLaunch | null>;
  /** Snapshot of the sessions this driver is busy for (including internal ones) and the processes it currently owns. */
  activity?(): DriverActivity;
  onActivityChanged?(listener: () => void): () => void;
  /** Maps a harness-side session that presented the driver's agent secret to the cw-code session whose in-flight turn owns it. */
  resolveAgentSession?(secret: string, harnessSessionId: string): { sessionId: string } | null;
  /**
   * Asks every owned process to exit and waits up to `timeoutMs`. Processes still alive at the deadline are
   * left for `dispose()` to force-stop, and the result reports `timedOut`. Never touches processes it did not spawn.
   */
  shutdown?(opts: { timeoutMs: number }): Promise<{ timedOut: boolean }>;
  dispose?(): void;
}

export type { SessionMeta, ThreadEvent, HistoryMessage, TurnRequest };
