import type { TodoItem } from "@cw-code/contracts";
import { normalizeTodos } from "../todos.js";

interface ToolPartState {
  status?: string;
  input?: unknown;
  output?: string;
  error?: unknown;
}

function errorText(error: unknown): string | undefined {
  if (typeof error === "string" && error.trim()) return error;
  if (error !== null && typeof error === "object") {
    const text = JSON.stringify(error);
    if (text && text !== "{}") return text;
  }
  return undefined;
}

export function toolResultFromState(
  state: unknown
): { output: string; isError: boolean } | null {
  if (typeof state === "string") return { output: state, isError: false };
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  const typed = state as ToolPartState;
  if (typed.status !== "completed" && typed.status !== "error") return null;
  const raw = typed.output;
  if (typeof raw === "string") {
    if (raw.trim()) {
      return { output: raw.slice(0, 8000), isError: typed.status === "error" || typed.error != null };
    }
  } else if (raw !== undefined && raw !== null) {
    return {
      output: JSON.stringify(raw).slice(0, 8000),
      isError: typed.status === "error" || typed.error != null
    };
  }
  const err = errorText(typed.error);
  if (err !== undefined) return { output: err.slice(0, 8000), isError: true };
  return { output: "", isError: typed.status === "error" };
}

export function parseOpencodeTodosUpdated(
  event: unknown
): { sessionID: string; todos: TodoItem[] } | null {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
  const args = event as Record<string, unknown>;
  if (args["type"] !== "todo.updated") return null;
  const props = args["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props)) return null;
  const sessionID = (props as Record<string, unknown>)["sessionID"];
  if (typeof sessionID !== "string" || !sessionID) return null;
  const todos = normalizeTodos(props);
  if (todos === null) return null;
  return { sessionID, todos };
}
