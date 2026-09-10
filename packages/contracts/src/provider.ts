import type { ModelOption, SessionMeta, TurnRequest } from "./session.js";
import type { ApprovalDecision, HistoryMessage, SessionEvent, ThreadEvent } from "./events.js";

export interface TurnHandle {
  turnId: string;
  events: AsyncIterable<ThreadEvent>;
}

export interface CliDriver {
  readonly kind: SessionMeta["driver"];
  listSessions(projectRoot: string, projectId?: string): Promise<SessionMeta[]>;
  getHistory(projectRoot: string, resumeCursor: string): Promise<HistoryMessage[]>;
  startTurn(request: TurnRequest): TurnHandle;
  interrupt(turnId: string): void;
  renameSession(sessionId: string, title: string): Promise<void>;
  events(): AsyncIterable<SessionEvent>;
  listModels?(cwd: string): Promise<ModelOption[]>;
  respondToApproval?(requestId: string, decision: ApprovalDecision): Promise<void>;
  dispose?(): void;
}

export type { SessionMeta, ThreadEvent, HistoryMessage, TurnRequest };
