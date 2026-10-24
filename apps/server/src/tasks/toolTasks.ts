import type { TaskEndReason, TaskSnapshot, ThreadEvent } from "@cw-code/contracts";
import { TaskTable } from "./TaskTable.js";

type ToolCallEvent = Extract<ThreadEvent, { type: "tool.call" }>;
type ToolResultEvent = Extract<ThreadEvent, { type: "tool.result" }>;

interface SessionTasks {
  table: TaskTable;
  turnByTask: Map<string, string>;
}

const SUBAGENT_TOOL_NAMES = new Set(["task", "agent", "subagent"]);

export function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase());
}

export class ToolTaskTracker {
  private readonly sessions = new Map<string, SessionTasks>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(event: ThreadEvent, sessionId: string | undefined): ThreadEvent[] {
    if (event.type === "turn.done") {
      return [...this.closeOpen(event.sessionId, "unknown", "no-record", event.turnId), event];
    }
    if (sessionId === undefined) return [event];
    switch (event.type) {
      case "tool.call":
        return [this.observeCall(event, sessionId)];
      case "tool.result":
        return [event, ...this.observeResult(event, sessionId)];
      case "turn.error":
        return [...this.closeOpen(sessionId, "interrupted", "process-exit", event.turnId), event];
      default:
        return [event];
    }
  }

  closeOpen(sessionId: string, state: "interrupted" | "unknown", reason: TaskEndReason, turnId?: string): ThreadEvent[] {
    const tasks = this.sessions.get(sessionId);
    if (!tasks) return [];
    const closed = tasks.table.closeOpen(
      state,
      reason,
      this.now(),
      (task) => turnId === undefined || tasks.turnByTask.get(task.id) === turnId
    );
    const updates = updatesOf(sessionId, tasks, closed);
    this.dropEnded(sessionId, tasks);
    return updates;
  }

  liveTasks(sessionId: string): TaskSnapshot[] {
    return this.sessions.get(sessionId)?.table.snapshots() ?? [];
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private observeCall(event: ToolCallEvent, sessionId: string): ThreadEvent {
    if (event.parentToolCallId !== undefined || !isSubagentToolName(event.name)) return event;
    const tasks = this.tasksOf(sessionId);
    tasks.table.apply({ kind: "call", toolUseId: event.toolCallId, taskKind: "agent", background: false, at: this.now() });
    if (!tasks.turnByTask.has(event.toolCallId)) tasks.turnByTask.set(event.toolCallId, event.turnId);
    const task = tasks.table.get(event.toolCallId);
    return task ? { ...event, task } : event;
  }

  private observeResult(event: ToolResultEvent, sessionId: string): ThreadEvent[] {
    const tasks = this.sessions.get(sessionId);
    if (!tasks?.turnByTask.has(event.toolCallId)) return [];
    const changed = tasks.table.apply({
      kind: "ended",
      ref: { toolUseId: event.toolCallId },
      state: event.isError ? "failed" : "completed",
      reason: "tool-result",
      output: event.output,
      outputSource: "result",
      at: this.now()
    });
    return updatesOf(sessionId, tasks, changed);
  }

  private dropEnded(sessionId: string, tasks: SessionTasks): void {
    const running = tasks.table.snapshots().filter((task) => task.state === "running");
    if (running.length === 0) {
      this.sessions.delete(sessionId);
      return;
    }
    const kept: SessionTasks = { table: new TaskTable(), turnByTask: new Map() };
    for (const task of running) {
      kept.table.apply({ kind: "call", toolUseId: task.id, taskKind: "agent", background: false, at: task.startedAt ?? this.now() });
      const turnId = tasks.turnByTask.get(task.id);
      if (turnId !== undefined) kept.turnByTask.set(task.id, turnId);
    }
    this.sessions.set(sessionId, kept);
  }

  private tasksOf(sessionId: string): SessionTasks {
    let tasks = this.sessions.get(sessionId);
    if (!tasks) {
      tasks = { table: new TaskTable(), turnByTask: new Map() };
      this.sessions.set(sessionId, tasks);
    }
    return tasks;
  }
}

function updatesOf(sessionId: string, tasks: SessionTasks, snapshots: TaskSnapshot[]): ThreadEvent[] {
  return snapshots.flatMap((task): ThreadEvent[] => {
    const turnId = tasks.turnByTask.get(task.id);
    return turnId === undefined ? [] : [{ type: "task.updated", turnId, sessionId, task }];
  });
}
