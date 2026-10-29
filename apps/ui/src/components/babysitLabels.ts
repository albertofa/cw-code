import type { BabysitPhase, BabysitState, PrSummary, PrWorkflow, SessionPrLink } from "@cw-code/contracts";
import { AUTO_FOLLOW_UP_LIMIT } from "@cw-code/shared/autoFollowUp";

export function babysitPhaseLabel(phase: BabysitPhase["kind"]): string {
  switch (phase) {
    case "working":
      return "Babysitting";
    case "watching":
      return "Watching";
    case "done":
      return "Ready to merge";
    case "paused":
      return "Paused";
  }
}

export function babysitStatusText(state: Pick<BabysitState, "phase">): string {
  switch (state.phase.kind) {
    case "working":
      return "Working on the PR";
    case "watching":
      return "Watching for failed checks, change requests and comments";
    case "done":
      return "Final review done, ready to merge";
    case "paused":
      switch (state.phase.reason) {
        case "user":
          return "Paused";
        case "interrupted":
          return "Paused because the turn was stopped";
        case "error":
          return "Paused because the last turn failed";
        case "limit":
          return `Paused after ${AUTO_FOLLOW_UP_LIMIT} automatic turns in a row`;
      }
  }
}

export function whyLinkedText(link: SessionPrLink, pr: Pick<PrSummary, "headRefName"> | null, workflows: PrWorkflow[]): string {
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
