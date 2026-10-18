import type { ToolUsage } from "./events.js";

export type TaskState = "running" | "completed" | "failed" | "stopped" | "interrupted" | "unknown";

export type TaskKind = "agent" | "shell";

export type TaskEndReason = "cli" | "tool-result" | "sidecar" | "roster" | "process-exit" | "interrupt" | "no-record";

/** Lifecycle of work a tool call started (a subagent or a background shell), keyed by that call's id. */
export interface TaskSnapshot {
  id: string;
  cliTaskId?: string;
  kind: TaskKind;
  background: boolean;
  state: TaskState;
  endReason?: TaskEndReason;
  runCount: number;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  usage?: ToolUsage;
}
