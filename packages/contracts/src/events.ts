export interface HistoryMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  turnId: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  subagentModel?: string;
  subagentTools?: SubagentToolSummary;
  parentToolCallId?: string;
}

export interface SubagentToolActivity {
  id: string;
  name: string;
  input: unknown;
  timestamp?: number;
  completedAt?: number;
  output?: string;
  isError?: boolean;
}

export interface SubagentToolSummary {
  total: number;
  items: SubagentToolActivity[];
  effort?: string;
  totalTokens?: number;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type ApprovalKind = "command" | "fileChange" | "permissions";

export interface ApprovalRequest {
  requestId: string;
  kind: ApprovalKind;
  title: string;
  reason?: string;
  details?: string;
  decisions: ApprovalDecision[];
}

export type ThreadEvent =
  | { type: "assistant.delta"; turnId: string; text: string }
  | {
      type: "tool.call";
      turnId: string;
      toolCallId: string;
      name: string;
      input: unknown;
      parentToolCallId?: string;
    }
  | { type: "tool.result"; turnId: string; toolCallId: string; output: string; isError: boolean }
  | { type: "approval.request"; turnId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; turnId: string; requestId: string }
  | {
      type: "turn.done";
      turnId: string;
      sessionId: string;
      resumeCursor: string;
      resultText: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      numTurns: number;
      isError: boolean;
    }
  | { type: "turn.error"; turnId: string; message: string };

export type SessionEvent =
  | { type: "session.list.changed"; projectRoot: string }
  | { type: "cli.version.drift"; binary: string; minimum: string; actual: string };
