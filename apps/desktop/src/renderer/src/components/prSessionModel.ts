import type { AppSettings, PrDetail, PrSummary, PrUpdate, PrWorkflow, SessionPrLink } from "@cw-code/contracts";
import { attributionText, resolveTemplate, templateVars } from "./prWorkflows.js";

const FAILED_LOGS_PATTERN = /\{\{\s*checks\.failedLogs\s*\}\}/;

function fallbackWorkflowId(pr: Pick<PrSummary, "viewerIsAuthor"> | null): string {
  return pr !== null && !pr.viewerIsAuthor ? "review" : "babysit";
}

export function defaultFollowUpWorkflowId(link: SessionPrLink, pr: Pick<PrSummary, "viewerIsAuthor"> | null): string {
  return link.workflowId || fallbackWorkflowId(pr);
}

export function followUpWorkflow(
  link: SessionPrLink,
  pr: Pick<PrSummary, "viewerIsAuthor"> | null,
  workflows: PrWorkflow[]
): PrWorkflow | null {
  const own = link.workflowId ? workflows.find((w) => w.id === link.workflowId) : undefined;
  return own ?? workflows.find((w) => w.id === fallbackWorkflowId(pr)) ?? null;
}

export function needsFailedLogs(template: string): boolean {
  return FAILED_LOGS_PATTERN.test(template);
}

export function followUpPrompt(
  detail: PrDetail,
  link: SessionPrLink,
  workflow: PrWorkflow,
  updates: PrUpdate[],
  settings: Pick<AppSettings, "prAttributionEnabled" | "prAttributionText">,
  harness: string
): string {
  const vars = templateVars(detail, { link, updates, attribution: attributionText(settings, harness), harness });
  return resolveTemplate(workflow.updatePrompt, vars);
}

export function whyLinkedText(
  link: SessionPrLink,
  pr: Pick<PrSummary, "headRefName"> | null,
  workflows: PrWorkflow[]
): string {
  const number = link.ref.number;
  switch (link.origin) {
    case "opened":
      return pr ? `Branch ${pr.headRefName} is the head of #${number}` : `This session's branch is the head of #${number}`;
    case "workflow": {
      if (!link.workflowId) return `Started from a workflow on #${number}`;
      const label = workflows.find((w) => w.id === link.workflowId)?.label ?? link.workflowId;
      return `Started from the ${label} workflow`;
    }
    case "linked":
      return "Linked manually";
  }
}
