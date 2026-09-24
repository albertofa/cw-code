import type { PrWorkflow } from "@cw-code/contracts";

const CUSTOM_ID_PATTERN = /^custom-(\d+)$/;

export function newWorkflowId(existing: PrWorkflow[]): string {
  const max = existing.reduce((highest, w) => {
    const match = CUSTOM_ID_PATTERN.exec(w.id);
    if (!match) return highest;
    return Math.max(highest, Number(match[1]));
  }, 0);
  return `custom-${max + 1}`;
}

export function createWorkflow(existing: PrWorkflow[]): PrWorkflow[] {
  const workflow: PrWorkflow = {
    id: newWorkflowId(existing),
    label: "New workflow",
    description: "",
    icon: "sparkle",
    builtIn: false,
    enabled: true,
    suggestWhen: [],
    workspace: "checkout",
    startPrompt: "",
    updatePrompt: ""
  };
  return [...existing, workflow];
}

export function duplicateWorkflow(existing: PrWorkflow[], id: string): PrWorkflow[] {
  const index = existing.findIndex((w) => w.id === id);
  if (index === -1) return existing;
  const source = existing[index];
  const copy: PrWorkflow = { ...source, id: newWorkflowId(existing), builtIn: false, label: `${source.label} copy` };
  const next = [...existing];
  next.splice(index + 1, 0, copy);
  return next;
}

export function moveWorkflow(existing: PrWorkflow[], id: string, direction: "up" | "down"): PrWorkflow[] {
  const index = existing.findIndex((w) => w.id === id);
  if (index === -1) return existing;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= existing.length) return existing;
  const next = [...existing];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function deleteWorkflow(existing: PrWorkflow[], id: string): PrWorkflow[] {
  const entry = existing.find((w) => w.id === id);
  if (!entry || entry.builtIn) return existing;
  return existing.filter((w) => w.id !== id);
}

export function resetWorkflowTo(existing: PrWorkflow[], id: string, defaults: PrWorkflow[]): PrWorkflow[] {
  const index = existing.findIndex((w) => w.id === id);
  const entry = existing[index];
  if (!entry || !entry.builtIn) return existing;
  const fallback = defaults.find((w) => w.id === id);
  if (!fallback) return existing;
  const next = [...existing];
  next[index] = { ...fallback, enabled: entry.enabled };
  return next;
}

export function insertAtCursor(value: string, insertText: string, start: number, end: number): { value: string; cursor: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const next = value.slice(0, from) + insertText + value.slice(to);
  return { value: next, cursor: from + insertText.length };
}
