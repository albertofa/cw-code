import type { PrRef, PrWorkflow, SessionPrLink } from "@cw-code/contracts";

export const AUTOMATED_WORKFLOW_NOTE = `This session runs as an automated workflow: cw-code sends you PR updates as new turns and nobody reads your end-of-turn message.
When you need a human decision or input, ask it with your ask-user question tool (AskUserQuestion) and wait for the answer. Never end the turn with a question.`;

export function runsContinuously(workflow: PrWorkflow): boolean {
  return workflow.enabled && workflow.target === "pr" && workflow.autoFollowUp === true;
}

export function autoFollowUpWorkflow(link: SessionPrLink, workflows: PrWorkflow[]): PrWorkflow | null {
  if (!link.workflowId) return null;
  const workflow = workflows.find((w) => w.id === link.workflowId);
  return workflow && runsContinuously(workflow) ? workflow : null;
}

export function babysitsOpenPr(prs: SessionPrLink[] | undefined, workflows: PrWorkflow[], isFinished: (ref: PrRef) => boolean): boolean {
  return (prs ?? []).some((link) => autoFollowUpWorkflow(link, workflows) !== null && !isFinished(link.ref));
}

export function withAutomatedWorkflowNote(workflow: PrWorkflow, prompt: string): string {
  return runsContinuously(workflow) ? `${prompt.trimEnd()}\n\n${AUTOMATED_WORKFLOW_NOTE}` : prompt;
}
