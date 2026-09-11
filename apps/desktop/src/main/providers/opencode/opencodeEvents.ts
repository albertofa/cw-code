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
