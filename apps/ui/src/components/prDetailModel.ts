import type {
  GitPullRequestChecks,
  PrCheck,
  PrCiState,
  PrCommit,
  PrDetail,
  PrMergeable,
  PrRef,
  PrReviewState,
  PrReviewThread,
  PrSummary,
  PrWorkflow,
  SessionMeta,
  SubjectRelations
} from "@cw-code/contracts";
import { suggestedWorkflow } from "@cw-code/shared/workflowSuggestions";
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
  | { kind: "babysit"; session: SessionMeta; workflow: PrWorkflow }
  | { kind: "continue"; session: SessionMeta; workflowId: string }
  | { kind: "open"; session: SessionMeta; suggested: PrWorkflow | null }
  | { kind: "run"; workflowId: string }
  | { kind: "none" };

export function linkedBarState(
  pr: PrSummary,
  relations: SubjectRelations | undefined,
  sessionOf: (sessionId: string) => SessionMeta | undefined,
  workflows: PrWorkflow[]
): LinkedBarState {
  if (!relations) return { kind: "none" };
  const babysitter = pr.state === "OPEN" ? relations.babysitter : null;
  if (babysitter) {
    const session = sessionOf(babysitter.sessionId);
    const workflow = workflows.find((item) => item.id === babysitter.workflowId);
    if (session && workflow) return { kind: "babysit", session, workflow };
  }
  if (pr.state === "MERGED") return { kind: "none" };
  const action = relations.action;
  if (action.kind === "session") {
    const session = sessionOf(action.sessionId);
    if (!session) return { kind: "none" };
    return action.mode === "continue" && action.workflowId
      ? { kind: "continue", session, workflowId: action.workflowId }
      : { kind: "open", session, suggested: suggestedWorkflow(pr, workflows) };
  }
  const suggested = suggestedWorkflow(pr, workflows);
  return suggested ? { kind: "run", workflowId: suggested.id } : { kind: "none" };
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

const RELATIVE_UNITS: Array<[unit: string, ms: number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000]
];

export function relativeTime(ts: number, now: number): string {
  const elapsed = Math.max(0, now - ts);
  for (const [unit, ms] of RELATIVE_UNITS) {
    const count = Math.floor(elapsed / ms);
    if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

export interface CommitDayGroup {
  day: string;
  commits: PrCommit[];
}

export function groupCommitsByDay(commits: PrCommit[], formatDay: (ts: number) => string): CommitDayGroup[] {
  const groups: CommitDayGroup[] = [];
  for (const commit of commits) {
    const day = formatDay(commit.committedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.commits.push(commit);
    else groups.push({ day, commits: [commit] });
  }
  return groups;
}
