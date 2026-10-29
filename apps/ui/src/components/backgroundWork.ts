import type { TaskKind } from "../cw.js";
import type { ChatMessage } from "../stores/appStore.js";

export interface BackgroundWork {
  id: string;
  kind: TaskKind;
  label: string;
  detail?: string;
  startedAt?: number;
}

function inputArgs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const args = input as Record<string, unknown>;
  const nested = args["input"];
  return nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? { ...(nested as Record<string, unknown>), ...args }
    : args;
}

function pickText(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

function describe(m: ChatMessage, kind: TaskKind): Pick<BackgroundWork, "label" | "detail"> {
  const args = inputArgs(m.toolInput);
  const description = pickText(args, "description");
  const body = kind === "shell" ? pickText(args, "command", "cmd") : pickText(args, "prompt");
  const label = description ?? body ?? m.toolName ?? (kind === "shell" ? "Shell command" : "Subagent");
  return body && body !== label ? { label, detail: body } : { label };
}

export function liveBackgroundWork(items: ChatMessage[]): BackgroundWork[] {
  const work: BackgroundWork[] = [];
  for (const m of items) {
    const task = m.task;
    if (m.role !== "tool" || !task?.background || task.state !== "running") continue;
    work.push({
      id: m.id,
      kind: task.kind,
      ...describe(m, task.kind),
      ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {})
    });
  }
  return work;
}

export function sameBackgroundWork(a: BackgroundWork[], b: BackgroundWork[]): boolean {
  return (
    a.length === b.length &&
    a.every((w, i) => {
      const o = b[i];
      return w.id === o.id && w.kind === o.kind && w.label === o.label && w.detail === o.detail && w.startedAt === o.startedAt;
    })
  );
}

export function backgroundWaitLabel(work: BackgroundWork[]): string | undefined {
  if (work.length === 0) return undefined;
  const kind = work.every((w) => w.kind === "shell") ? "command" : work.every((w) => w.kind === "agent") ? "subagent" : "task";
  return `waiting on ${work.length} background ${kind}${work.length === 1 ? "" : "s"}`;
}
