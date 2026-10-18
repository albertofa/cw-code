import type { PrSuggestCondition, PrWorkflow } from "@cw-code/contracts";
import { TEMPLATE_VARS_BY_TARGET } from "./prWorkflows.js";
import { INHERITED_HARNESS } from "./workflowHarness.js";

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
    harness: { ...INHERITED_HARNESS },
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

export function moveWorkflowTo(existing: PrWorkflow[], id: string, targetId: string): PrWorkflow[] {
  const from = existing.findIndex((w) => w.id === id);
  const to = existing.findIndex((w) => w.id === targetId);
  if (from === -1 || to === -1 || from === to || existing[from].target !== existing[to].target) return existing;
  const next = [...existing];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
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

function namespacesOf(target: WorkflowTarget): Set<string> {
  return new Set(TEMPLATE_VARS_BY_TARGET[target].filter((name) => name.includes(".")).map((name) => name.slice(0, name.indexOf("."))));
}

function foreignNamespaces(target: WorkflowTarget): Set<string> {
  const own = namespacesOf(target);
  const foreign = new Set<string>();
  for (const other of WORKFLOW_TARGETS) {
    if (other === target) continue;
    for (const namespace of namespacesOf(other)) if (!own.has(namespace)) foreign.add(namespace);
  }
  return foreign;
}

export interface TemplateVarIssues {
  foreign: string[];
  unknown: string[];
}

function classifyVars(template: string, target: WorkflowTarget): TemplateVarIssues {
  const allowed = TEMPLATE_VARS_BY_TARGET[target];
  const foreignSpaces = foreignNamespaces(target);
  const found = [...new Set([...template.matchAll(TEMPLATE_VAR_PATTERN)].map((match) => match[1]))];
  const outside = found.filter((name) => !allowed.includes(name));
  const isForeign = (name: string) => foreignSpaces.has(name.slice(0, Math.max(0, name.indexOf("."))));
  return { foreign: outside.filter(isForeign), unknown: outside.filter((name) => !isForeign(name)) };
}

export function templateVarIssues(workflow: PrWorkflow): { startPrompt: TemplateVarIssues; updatePrompt: TemplateVarIssues } {
  return {
    startPrompt: classifyVars(workflow.startPrompt, workflow.target),
    updatePrompt: classifyVars(workflow.updatePrompt, workflow.target)
  };
}

export function foreignVarsMessage(names: string[], target: WorkflowTarget): string {
  const list = names.map((name) => `{{${name}}}`).join(", ");
  return `${list} ${names.length === 1 ? "belongs" : "belong"} to another workflow target and is not available for ${TARGET_HEADINGS[target].toLowerCase()} workflows.`;
}

export function unknownVarsMessage(names: string[]): string {
  const list = names.map((name) => `{{${name}}}`).join(", ");
  return `${list} ${names.length === 1 ? "is" : "are"} not a built-in variable and will be sent as written.`;
}

function hasChanged(workflow: PrWorkflow, original: PrWorkflow[]): boolean {
  const before = original.find((w) => w.id === workflow.id);
  return (
    !before ||
    before.target !== workflow.target ||
    before.startPrompt !== workflow.startPrompt ||
    before.updatePrompt !== workflow.updatePrompt
  );
}

export function workflowValidationError(workflow: PrWorkflow): string | null {
  const issues = templateVarIssues(workflow);
  const names = [...new Set([...issues.startPrompt.foreign, ...issues.updatePrompt.foreign])];
  if (names.length === 0) return null;
  return `“${workflow.label}”: ${foreignVarsMessage(names, workflow.target)}`;
}

export function workflowsValidationError(
  workflows: PrWorkflow[],
  original: PrWorkflow[]
): { workflowId: string; message: string } | null {
  for (const workflow of workflows) {
    if (!hasChanged(workflow, original)) continue;
    const message = workflowValidationError(workflow);
    if (message) return { workflowId: workflow.id, message };
  }
  return null;
}
