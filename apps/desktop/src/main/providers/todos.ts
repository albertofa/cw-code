import type { TodoItem } from "@cw-code/contracts";

const STATUSES: readonly TodoItem["status"][] = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITIES: readonly NonNullable<TodoItem["priority"]>[] = ["high", "medium", "low"];

function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function statusOf(value: unknown): TodoItem["status"] {
  const status = textOf(value)?.toLowerCase();
  return STATUSES.find((candidate) => candidate === status) ?? "pending";
}

function priorityOf(value: unknown): TodoItem["priority"] {
  const priority = textOf(value)?.toLowerCase();
  return PRIORITIES.find((candidate) => candidate === priority);
}

function todoOf(entry: unknown): TodoItem | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const item = entry as Record<string, unknown>;
  const content = textOf(item["content"]) ?? textOf(item["label"]) ?? textOf(item["step"]);
  if (content === null) return null;
  const priority = priorityOf(item["priority"]);
  return {
    content,
    status: statusOf(item["status"]),
    ...(priority !== undefined ? { priority } : {})
  };
}

function todosOf(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(todoOf).filter((todo): todo is TodoItem => todo !== null);
}

export function normalizeTodos(input: unknown): TodoItem[] | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  return todosOf((input as Record<string, unknown>)["todos"]);
}

export function todosFromToolCall(toolName: string, input: unknown): TodoItem[] | null {
  const name = toolName.trim().toLowerCase();
  if (name !== "todowrite" && name !== "todo") return null;
  return normalizeTodos(input);
}

export function todosFromPlan(plan: unknown): TodoItem[] | null {
  if (Array.isArray(plan)) return todosOf(plan);
  if (plan === null || typeof plan !== "object") return null;
  return todosOf((plan as Record<string, unknown>)["plan"]);
}
