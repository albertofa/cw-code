import type { WorkflowBase } from "@cw-code/contracts";
import type { IssueDetail, IssueRef, PrLinkOrigin, PrRef, RepoRef, RunRef, WorkflowSubject } from "../cw.js";
import { prKey } from "./prInbox.js";

interface SessionWithLinks {
  prs?: Array<{ ref: PrRef; origin: PrLinkOrigin }>;
  issues?: Array<{ ref: IssueRef; origin: PrLinkOrigin; lastSeenAt: number }>;
  runs?: Array<{ ref: RunRef; origin: PrLinkOrigin; lastSeenAt: number }>;
}

export function issueKey(ref: IssueRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`;
}

export function runKey(ref: RunRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}/runs/${ref.runId}`;
}

export function repoOf(subject: WorkflowSubject): RepoRef {
  const { host, owner, repo } = subject.ref;
  return { host, owner, repo };
}

export function subjectKey(subject: WorkflowSubject): string {
  switch (subject.kind) {
    case "pr":
      return prKey(subject.ref);
    case "issue":
      return issueKey(subject.ref);
    case "run":
      return runKey(subject.ref);
  }
}

export function subjectLink(
  session: SessionWithLinks,
  subject: WorkflowSubject
): { origin: PrLinkOrigin; lastSeenAt: number | null } | undefined {
  const key = subjectKey(subject);
  switch (subject.kind) {
    case "pr": {
      const link = session.prs?.find((item) => prKey(item.ref) === key);
      return link && { origin: link.origin, lastSeenAt: null };
    }
    case "issue": {
      const link = session.issues?.find((item) => issueKey(item.ref) === key);
      return link && { origin: link.origin, lastSeenAt: link.lastSeenAt };
    }
    case "run": {
      const link = session.runs?.find((item) => runKey(item.ref) === key);
      return link && { origin: link.origin, lastSeenAt: link.lastSeenAt };
    }
  }
}

export function isLinkedTo(session: SessionWithLinks, subject: WorkflowSubject): boolean {
  return subjectLink(session, subject) !== undefined;
}

export type WorkflowWorkspaceMode = "worktree" | "checkout";

export function baseWorkspaceHint(base: WorkflowBase, mode: WorkflowWorkspaceMode, projectName: string | null): string {
  if (mode === "worktree") return `isolated, from ${base.label}`;
  return `switches ${projectName ?? "the project"} to a new branch from ${base.label}`;
}

export function prWorkspaceHint(headRefName: string | null, mode: WorkflowWorkspaceMode, projectName: string | null): string {
  if (mode === "checkout") {
    return `switches ${projectName ?? "the project"} to the PR branch (or a new branch from the PR head)`;
  }
  return `isolated, from ${headRefName ?? "the PR head"}`;
}

export function issueDataTime(issue: Pick<IssueDetail, "updatedAt" | "comments">): number {
  return issue.comments.reduce((latest, comment) => Math.max(latest, comment.createdAt), issue.updatedAt);
}
