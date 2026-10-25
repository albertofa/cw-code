import type { IssueRef, PrRef, PrWorkflow, RepoRef, RunRef, WorkflowBase, WorkflowRunSummary, WorkflowSubject } from "@cw-code/contracts";
import { prKey } from "@cw-code/shared/prRef";
import { issueKey, runKey } from "../github/prLinks.js";

interface SessionWithLinks {
  prs?: Array<{ ref: PrRef }>;
  issues?: Array<{ ref: IssueRef }>;
  runs?: Array<{ ref: RunRef }>;
}

interface CandidateSession extends SessionWithLinks {
  id: string;
  projectId: string;
  status: string;
  updatedAt: number;
}

export const OTHER_SESSIONS_LIMIT = 8;

const RUN_BASE_FALLBACK = "falls back to the default branch if it no longer exists";
const DEFAULT_BASE_LABEL = "the default branch (fetched from origin)";

export function repoOf(subject: WorkflowSubject): RepoRef {
  const { host, owner, repo } = subject.ref;
  return { host, owner, repo };
}

export function isLinkedTo(session: SessionWithLinks, subject: WorkflowSubject): boolean {
  switch (subject.kind) {
    case "pr": {
      const key = prKey(subject.ref);
      return session.prs?.some((item) => prKey(item.ref) === key) ?? false;
    }
    case "issue": {
      const key = issueKey(subject.ref);
      return session.issues?.some((item) => issueKey(item.ref) === key) ?? false;
    }
    case "run": {
      const key = runKey(subject.ref);
      return session.runs?.some((item) => runKey(item.ref) === key) ?? false;
    }
  }
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
  const pinned =
    pinnedId === undefined || inProject.some((s) => s.id === pinnedId)
      ? undefined
      : sessions.find((s) => s.id === pinnedId && !isLinkedTo(s, subject));
  return pinned ? [pinned, ...inProject] : inProject;
}

export function prRefForRun(run: WorkflowRunSummary | undefined): PrRef | null {
  if (!run || run.prNumber === null) return null;
  return { host: run.ref.host, owner: run.ref.owner, repo: run.ref.repo, number: run.prNumber };
}

export function workflowsForSubject(workflows: PrWorkflow[], subject: WorkflowSubject, run: WorkflowRunSummary | undefined): PrWorkflow[] {
  const runPr = subject.kind === "run" ? prRefForRun(run) : null;
  return workflows.filter((w) => w.target === subject.kind || (runPr !== null && w.target === "pr"));
}

export function effectiveSubject(subject: WorkflowSubject, workflow: PrWorkflow | undefined, run: WorkflowRunSummary | undefined): WorkflowSubject {
  if (subject.kind !== "run" || workflow?.target !== "pr") return subject;
  const ref = prRefForRun(run);
  return ref ? { kind: "pr", ref } : subject;
}

export function resolveIssueBase(): WorkflowBase {
  return { baseBranch: null, label: DEFAULT_BASE_LABEL };
}

export function resolveRunBase(run: Pick<WorkflowRunSummary, "branch"> | undefined): WorkflowBase {
  if (!run) return { baseBranch: null, label: `${DEFAULT_BASE_LABEL} — the run's branch is unknown` };
  if (!run.branch) return { baseBranch: null, label: `${DEFAULT_BASE_LABEL} — the run has no branch` };
  return { baseBranch: run.branch, label: `${run.branch} (fetched from origin; ${RUN_BASE_FALLBACK})` };
}
