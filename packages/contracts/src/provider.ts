import type { ModelOption, PermissionMode, SessionMeta, TurnRequest } from "./session.js";
import type { ApprovalDecision, HistoryMessage, SessionEvent, ThreadEvent } from "./events.js";

export interface TurnHandle {
  turnId: string;
  events: AsyncIterable<ThreadEvent>;
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

export interface CliDriver {
  readonly kind: SessionMeta["driver"];
  listSessions(projectRoot: string, projectId?: string): Promise<SessionMeta[]>;
  getHistory(projectRoot: string, resumeCursor: string): Promise<HistoryMessage[]>;
  startTurn(request: TurnRequest): TurnHandle;
  interrupt(turnId: string): void;
  /** Force-stop all work for a local session (kill the underlying process). */
  stopSession?(sessionId: string): void;
  /** Re-establish the CLI connection for a session after a disconnect and refetch its state. */
  retryConnection?(request: RetryConnectionRequest): Promise<RetryConnectionResult>;
  renameSession(sessionId: string, title: string): Promise<void>;
  events(): AsyncIterable<SessionEvent>;
  listModels?(cwd: string): Promise<ModelOption[]>;
  respondToApproval?(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondToQuestion?(requestId: string, answers: Record<string, string>): Promise<void>;
  dispose?(): void;
}

export type { SessionMeta, ThreadEvent, HistoryMessage, TurnRequest };
