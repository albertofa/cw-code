import type { PrSuggestCondition, PrWorkflow } from "@cw-code/contracts";
import { TEMPLATE_VARS_BY_TARGET } from "./prWorkflows.js";

export type WorkflowTarget = PrWorkflow["target"];

export const WORKFLOW_TARGETS: readonly WorkflowTarget[] = ["pr", "issue", "run"];

export const TARGET_HEADINGS: Record<WorkflowTarget, string> = {
  pr: "Pull requests",
  issue: "Issues",
  run: "Runs"
};

export const CONDITIONS_BY_TARGET: Record<WorkflowTarget, readonly PrSuggestCondition[]> = {
  pr: ["review-requested", "author", "checks-failing", "changes-requested", "conflicts", "bot-author", "draft"],
  issue: ["issue-assigned", "issue-bug"],
  run: ["run-failed"]
};

const TEMPLATE_VAR_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

const CUSTOM_ID_PATTERN = /^custom-(\d+)$/;

export function newWorkflowId(existing: PrWorkflow[]): string {
  const max = existing.reduce((highest, w) => {
    const match = CUSTOM_ID_PATTERN.exec(w.id);
    if (!match) return highest;
    return Math.max(highest, Number(match[1]));
  }, 0);
  return `custom-${max + 1}`;
}

export function createWorkflow(existing: PrWorkflow[], target: WorkflowTarget = "pr"): PrWorkflow[] {
  const workflow: PrWorkflow = {
    id: newWorkflowId(existing),
    label: "New workflow",
    description: "",
    icon: "sparkle",
    builtIn: false,
    enabled: true,
    target,
    suggestWhen: [],
    workspace: "checkout",
    startPrompt: "",
    updatePrompt: ""
  };
  return [...existing, workflow];
}

export function changeWorkflowTarget(workflow: PrWorkflow, target: WorkflowTarget): PrWorkflow {
  if (workflow.target === target) return workflow;
  const allowed = CONDITIONS_BY_TARGET[target];
  return {
    ...workflow,
    target,
    suggestWhen: workflow.suggestWhen.filter((condition) => allowed.includes(condition)),
    workspace: target !== "pr" && workflow.workspace === "linked" ? "worktree" : workflow.workspace
  };
}

export function groupWorkflowsByTarget(workflows: PrWorkflow[]): Array<{ target: WorkflowTarget; workflows: PrWorkflow[] }> {
  return WORKFLOW_TARGETS.map((target) => ({ target, workflows: workflows.filter((w) => w.target === target) })).filter(
    (group) => group.workflows.length > 0
  );
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
  const step = direction === "up" ? -1 : 1;
  let target = index + step;
  while (target >= 0 && target < existing.length && existing[target].target !== existing[index].target) target += step;
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

function unknownVars(template: string, target: WorkflowTarget): string[] {
  const allowed = TEMPLATE_VARS_BY_TARGET[target];
  const found = [...template.matchAll(TEMPLATE_VAR_PATTERN)].map((match) => match[1]);
  return [...new Set(found.filter((name) => !allowed.includes(name)))];
}

export function unknownTemplateVars(workflow: PrWorkflow): { startPrompt: string[]; updatePrompt: string[] } {
  return {
    startPrompt: unknownVars(workflow.startPrompt, workflow.target),
    updatePrompt: unknownVars(workflow.updatePrompt, workflow.target)
  };
}

export function unavailableVarsMessage(names: string[], target: WorkflowTarget): string {
  const list = names.map((name) => `{{${name}}}`).join(", ");
  return `${list} ${names.length === 1 ? "is" : "are"} not available for ${TARGET_HEADINGS[target].toLowerCase()} workflows.`;
}

export function workflowValidationError(workflow: PrWorkflow): string | null {
  const unknown = unknownTemplateVars(workflow);
  const names = [...new Set([...unknown.startPrompt, ...unknown.updatePrompt])];
  if (names.length === 0) return null;
  return `“${workflow.label}”: ${unavailableVarsMessage(names, workflow.target)}`;
}

export function workflowsValidationError(workflows: PrWorkflow[]): string | null {
  for (const workflow of workflows) {
    const error = workflowValidationError(workflow);
    if (error) return error;
  }
  return null;
}
