import type { TodoItem } from "@cw-code/contracts";
import { normalizeTodos } from "../todos.js";

interface ToolPartState {
  status?: string;
  input?: unknown;
  output?: string;
  error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
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

export function parseOpencodeSessionParent(event: unknown): { sessionID: string; parentID: string } | null {
  const args = asRecord(event);
  if (!args) return null;
  const type = args["type"];
  if (type !== "session.created" && type !== "session.updated") return null;
  const props = asRecord(args["properties"]) ?? asRecord(args["data"]);
  if (!props) return null;
  const info = asRecord(props["info"]) ?? props;
  const sessionID = asString(info["id"]) || asString(info["sessionID"]) || asString(props["sessionID"]);
  const parentID = asString(info["parentID"]) || asString(info["parentId"]);
  if (!sessionID || !parentID) return null;
  return { sessionID, parentID };
}

export function opencodeSessionParentId(payload: unknown): string | null {
  const record = asRecord(payload);
  const containers = [record, asRecord(record?.["data"]), asRecord(record?.["info"])];
  for (const container of containers) {
    const parentID = asString(container?.["parentID"]);
    if (parentID) return parentID;
  }
  return null;
}
