import type {
  GitBranchInfo,
  IssueDetail,
  IssueRef,
  PrLinkOrigin,
  PrRef,
  PrWorkflow,
  RepoRef,
  RunRef,
  RunsResult,
  WorkflowRunSummary,
  WorkflowSubject
} from "../cw.js";
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

export function subjectLabel(subject: WorkflowSubject, runNumber: number | undefined): string {
  switch (subject.kind) {
    case "pr":
    case "issue":
      return `#${subject.ref.number}`;
    case "run":
      return runNumber === undefined ? `run ${subject.ref.runId}` : `run #${runNumber}`;
  }
}

export const OTHER_SESSIONS_LIMIT = 8;

interface CandidateSession extends SessionWithLinks {
  id: string;
  projectId: string;
  status: string;
  updatedAt: number;
}

export function otherSessionCandidates<S extends CandidateSession>(
  sessions: S[],
  subject: WorkflowSubject,
  projectId: string | null,
  pinnedId?: string,
  limit = OTHER_SESSIONS_LIMIT
): S[] {
  const eligible = sessions.filter((s) => s.status !== "archived" && !isLinkedTo(s, subject));
  const inProject =
    projectId === null
      ? []
      : eligible
          .filter((s) => s.projectId === projectId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit);
  const pinned = pinnedId === undefined || inProject.some((s) => s.id === pinnedId) ? undefined : eligible.find((s) => s.id === pinnedId);
  return pinned ? [pinned, ...inProject] : inProject;
}

export function findCachedRun(
  caches: Record<string, { data: RunsResult | null }>,
  ref: RunRef
): WorkflowRunSummary | undefined {
  const key = runKey(ref);
  for (const entry of Object.values(caches)) {
    const found = entry.data?.items.find((run) => runKey(run.ref) === key);
    if (found) return found;
  }
  return undefined;
}

export function prRefForRun(run: WorkflowRunSummary | undefined): PrRef | null {
  if (!run || run.prNumber === null) return null;
  return { host: run.ref.host, owner: run.ref.owner, repo: run.ref.repo, number: run.prNumber };
}

export function workflowsForSubject(
  workflows: PrWorkflow[],
  subject: WorkflowSubject,
  run: WorkflowRunSummary | undefined
): PrWorkflow[] {
  const runPr = subject.kind === "run" ? prRefForRun(run) : null;
  return workflows.filter((w) => w.target === subject.kind || (runPr !== null && w.target === "pr"));
}

export function effectiveSubject(
  subject: WorkflowSubject,
  workflow: PrWorkflow | undefined,
  run: WorkflowRunSummary | undefined
): WorkflowSubject {
  if (subject.kind !== "run" || workflow?.target !== "pr") return subject;
  const ref = prRefForRun(run);
  return ref ? { kind: "pr", ref } : subject;
}

export interface WorktreeBase {
  baseBranch: string | undefined;
  hint: string;
}

const ISSUE_BASE_CANDIDATES = ["origin/main", "main", "origin/master", "master"];

function currentBranchName(branches: GitBranchInfo[]): string {
  return branches.find((item) => item.current)?.name ?? "the current branch";
}

export function resolveRunBase(branches: GitBranchInfo[], branch: string | null): WorktreeBase {
  const fallback = currentBranchName(branches);
  if (!branch) return { baseBranch: undefined, hint: `isolated, from ${fallback} — the run has no branch` };
  const remote = branches.find((item) => item.remote && item.name === `origin/${branch}`);
  const local = branches.find((item) => !item.remote && item.name === branch);
  const found = remote ?? local;
  if (found) return { baseBranch: found.name, hint: `isolated, from ${found.name}` };
  return { baseBranch: undefined, hint: `isolated, from ${fallback} — run branch ${branch} not found locally or on origin` };
}

export function resolveIssueBase(branches: GitBranchInfo[]): WorktreeBase {
  for (const candidate of ISSUE_BASE_CANDIDATES) {
    if (branches.some((item) => item.name === candidate)) return { baseBranch: candidate, hint: `isolated, from ${candidate}` };
  }
  return {
    baseBranch: undefined,
    hint: `isolated, from ${currentBranchName(branches)} — none of ${ISSUE_BASE_CANDIDATES.join(", ")} exists`
  };
}

export function baseFailureHint(message: string): WorktreeBase {
  return { baseBranch: undefined, hint: `isolated, from the project's current branch — could not list branches: ${message}` };
}

export function issueDataTime(issue: Pick<IssueDetail, "updatedAt" | "comments">): number {
  return issue.comments.reduce((latest, comment) => Math.max(latest, comment.createdAt), issue.updatedAt);
}
