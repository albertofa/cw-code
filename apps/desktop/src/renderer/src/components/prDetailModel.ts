import type {
  GitPullRequestChecks,
  PrCheck,
  PrCiState,
  PrDetail,
  PrMergeable,
  PrRef,
  PrReviewState,
  PrReviewThread,
  PrSummary,
  PrWorkflow,
  SessionMeta
} from "@cw-code/contracts";
import { primaryAction, suggestedWorkflow } from "./prWorkflows.js";
import { linkFor } from "./sessionPrLinks.js";

export interface MergeRow {
  ok: boolean;
  label: string;
  detail: string;
}

export interface MergeBoxState {
  review: MergeRow;
  ci: MergeRow;
  conflicts: MergeRow;
  overallOk: boolean;
}

function reviewRow(review: PrReviewState, approvedCount: number, changesCount: number): MergeRow {
  switch (review) {
    case "approved":
      return { ok: true, label: "Approved", detail: `${approvedCount} approving ${approvedCount === 1 ? "review" : "reviews"}` };
    case "changes_requested":
      return {
        ok: false,
        label: "Changes requested",
        detail: `${changesCount} ${changesCount === 1 ? "review" : "reviews"} requested changes${
          approvedCount > 0 ? ` · ${approvedCount} ${approvedCount === 1 ? "approval" : "approvals"}` : ""
        }`
      };
    case "review_required":
      return { ok: false, label: "Review required", detail: "At least 1 approving review is required." };
    case "none":
      return { ok: false, label: "No reviewers yet", detail: "No reviewers have been requested." };
  }
}

function ciRow(ci: PrCiState, checks: GitPullRequestChecks, checkRuns: PrCheck[]): MergeRow {
  if (ci === "passing") {
    return { ok: true, label: "All checks have passed", detail: `${checks.passed}/${checks.total} checks passed` };
  }
  if (ci === "pending") {
    return { ok: false, label: "Checks running", detail: `${checks.pending} check${checks.pending === 1 ? "" : "s"} pending` };
  }
  if (ci === "failing") {
    const failing = checkRuns.filter((c) => c.status === "failure");
    const names = failing.map((c) => c.name).join(", ");
    return { ok: false, label: "Some checks were not successful", detail: names.length > 0 ? names : `${checks.failed} failing` };
  }
  return { ok: true, label: "No checks reported", detail: "This pull request has no status checks." };
}

function conflictRow(mergeable: PrMergeable): MergeRow {
  if (mergeable === "CONFLICTING") {
    return { ok: false, label: "This branch has conflicts that must be resolved", detail: "" };
  }
  if (mergeable === "UNKNOWN") {
    return { ok: true, label: "Merge conflict status unknown", detail: "" };
  }
  return { ok: true, label: "No conflicts with base branch", detail: "" };
}

export function mergeBoxState(pr: PrDetail): MergeBoxState {
  const approvedCount = pr.reviewers.filter((r) => r.state === "APPROVED").length;
  const changesCount = pr.reviewers.filter((r) => r.state === "CHANGES_REQUESTED").length;
  const review = reviewRow(pr.review, approvedCount, changesCount);
  const ci = ciRow(pr.ci, pr.checks, pr.checkRuns);
  const conflicts = conflictRow(pr.mergeable);
  return { review, ci, conflicts, overallOk: review.ok && ci.ok && conflicts.ok };
}

export function threadQuoteText(thread: PrReviewThread, ref: PrRef): string {
  const location = thread.line !== null ? `${thread.path}:${thread.line}` : thread.path;
  const header = `Address this review thread on ${ref.owner}/${ref.repo}#${ref.number} (${location}):`;
  const body = thread.comments.map((c) => `${c.author}: ${c.body}`).join("\n\n");
  return body.length > 0 ? `${header}\n\n${body}` : header;
}

export type LinkedBarState =
  | { kind: "continue"; session: SessionMeta; workflowId: string }
  | { kind: "open"; session: SessionMeta; suggested: PrWorkflow | null }
  | { kind: "run"; workflowId: string }
  | { kind: "none" };

export function linkedSessionsBarState(pr: PrSummary, linkedSessions: SessionMeta[], workflows: PrWorkflow[]): LinkedBarState {
  const action = primaryAction(pr, linkedSessions, workflows);
  if (action.kind === "continue" || action.kind === "open") {
    const session = linkedSessions.find((s) => s.id === action.sessionId);
    if (!session) return { kind: "none" };
    return action.kind === "continue"
      ? { kind: "continue", session, workflowId: action.workflowId }
      : { kind: "open", session, suggested: suggestedWorkflow(pr, workflows) };
  }
  if (action.kind === "run") return { kind: "run", workflowId: action.workflowId };
  return { kind: "none" };
}

export interface ThreadSendTarget {
  workflowId: string;
  continueSessionId?: string;
}

export function threadSendTarget(mainSession: SessionMeta | null, ref: PrRef, suggested: PrWorkflow | null): ThreadSendTarget {
  if (mainSession) {
    return { workflowId: linkFor(mainSession, ref)?.workflowId ?? "babysit", continueSessionId: mainSession.id };
  }
  return { workflowId: suggested?.id ?? "review" };
}
