import type {
  GitBranchInfo,
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

export function runBaseBranch(branches: GitBranchInfo[], branch: string | null): string | undefined {
  if (!branch) return undefined;
  const local = branches.find((item) => !item.remote && item.name === branch);
  if (local) return local.name;
  return branches.find((item) => item.remote && item.name.endsWith(`/${branch}`))?.name;
}
