import type { PrWorkflow, SessionPrLink } from "@cw-code/contracts";

export function runsContinuously(workflow: PrWorkflow): boolean {
  return workflow.enabled && workflow.target === "pr" && workflow.autoFollowUp === true;
}

export function autoFollowUpWorkflow(link: SessionPrLink, workflows: PrWorkflow[]): PrWorkflow | null {
  if (!link.workflowId) return null;
  const workflow = workflows.find((w) => w.id === link.workflowId);
  return workflow && runsContinuously(workflow) ? workflow : null;
}
