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

export type ApprovalDecision = "accept" | "acceptForSession" | "acceptGlobal" | "decline" | "cancel";

export type ApprovalKind = "command" | "fileChange" | "permissions";

export interface ApprovalRequest {
  requestId: string;
  kind: ApprovalKind;
  title: string;
  reason?: string;
  details?: string;
  decisions: ApprovalDecision[];
  permission?: string;
  patterns?: string[];
  always?: string[];
  toolName?: string;
  cwd?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
}

export interface QuestionRequest {
  requestId: string;
  turnId: string;
  questions: QuestionInfo[];
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
  | { type: "question.request"; turnId: string; request: QuestionRequest }
  | {
      type: "question.resolved";
      turnId: string;
      requestId: string;
      answers: Record<string, string> | null;
    } | {
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
  | { type: "turn.error"; turnId: string; message: string }
  | { type: "session.branch.updated"; turnId: string; sessionId: string; branch: string };

export type SessionEvent =
  | { type: "session.list.changed"; projectRoot: string }
  | { type: "cli.version.drift"; binary: string; minimum: string; actual: string };
