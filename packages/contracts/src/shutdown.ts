export type ShutdownReason = "quit" | "update";

export interface ShutdownActiveTurn {
  sessionId: string;
  turnId: string;
  title: string;
  startedAt: number;
}

export interface ShutdownTerminal {
  ptyId: string;
  sessionId: string;
  kind: string;
}

export interface ShutdownAssessment {
  activeTurns: ShutdownActiveTurn[];
  backgroundTasks: number;
  terminals: ShutdownTerminal[];
}

export type ShutdownPrepareResult =
  | { ok: true; token: string }
  | { ok: false; code: "blocked"; assessment: ShutdownAssessment }
  | { ok: false; code: "timeout"; pending: string[]; token: string }
  | { ok: false; code: "busy" };

export type ShutdownCommitResult = { ok: true } | { ok: false; message: string };

export interface ShutdownPrepareRequest {
  reason: ShutdownReason;
  stopActiveTurns: boolean;
  timeoutMs: number;
}

export interface ShutdownRequestedEvent {
  reason: ShutdownReason;
}
