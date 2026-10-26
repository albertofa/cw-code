import type {
  GitHubSubject,
  IssueRef,
  IssueSummary,
  PrBucket,
  PrLinkOrigin,
  PrRef,
  PrSummary,
  PrWorkflow,
  RunConclusion,
  RunRef,
  SessionIssueLink,
  SessionMeta,
  SubjectAction,
  SubjectRelations,
  SubjectSessionActivity,
  WorkflowRunSummary
} from "@cw-code/contracts";
import { hasUnseen } from "./prUpdates.js";
import { suggestedWorkflow } from "@cw-code/shared/workflowSuggestions";
import { babysittingSession, primaryAction } from "./prWorkflows.js";
import { linkFor, pickMainSession, sessionsLinkedTo } from "./sessionPrLinks.js";

export type IssueBucket = "assigned" | "mentioned" | "created" | "other" | "closed";

export type RunBucket = "failing" | "running" | "recent";

export type PrLookup = (ref: PrRef) => PrSummary | undefined;

export interface RowActionInput {
  subject: GitHubSubject;
  viewer: string | null;
  sessions: SessionMeta[];
  workflows: PrWorkflow[];
  unseen: ReadonlySet<string>;
}

interface SessionOriginLink {
  origin: PrLinkOrigin;
  workflowId?: string;
}

type SuggestionSubject =
  | { kind: "pr"; pr: PrSummary }
  | { kind: "issue"; issue: IssueSummary; viewer: string | null }
  | { kind: "run"; run: WorkflowRunSummary };

const FAILED_CONCLUSIONS: ReadonlySet<RunConclusion> = new Set<RunConclusion>(["failure", "timed_out", "startup_failure"]);

const NO_PR_LOOKUP: PrLookup = () => undefined;

export function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function sameRepo(a: { host: string; owner: string; repo: string }, b: { host: string; owner: string; repo: string }): boolean {
  return sameLogin(a.host, b.host) && sameLogin(a.owner, b.owner) && sameLogin(a.repo, b.repo);
}

export function isRunFailed(run: Pick<WorkflowRunSummary, "status" | "conclusion">): boolean {
  return run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion);
}

export function involvesViewer(pr: PrSummary, viewer: string | null): boolean {
  return (
    pr.viewerIsAuthor ||
    pr.reviewRequestedFromViewer ||
    pr.assignees.some((login) => sameLogin(login, viewer)) ||
    pr.reviewers.some((reviewer) => sameLogin(reviewer.login, viewer))
  );
}

export function prBucket(pr: PrSummary): PrBucket {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (!pr.viewerIsAuthor && pr.reviewRequestedFromViewer) return "review";
  if (pr.viewerIsAuthor && (pr.ci === "failing" || pr.review === "changes_requested" || pr.mergeable === "CONFLICTING")) return "action";
  if (pr.viewerIsAuthor && pr.review === "approved" && pr.ci === "passing") return "ready";
  return "waiting";
}

export function needsAttentionCount(items: PrSummary[]): number {
  return items.filter((pr) => {
    const bucket = prBucket(pr);
    return bucket === "review" || bucket === "action";
  }).length;
}

export function issueBucket(issue: IssueSummary, viewer: string | null, mentionsMode = false): IssueBucket {
  if (issue.state === "CLOSED") return "closed";
  if (issue.assignees.some((login) => sameLogin(login, viewer))) return "assigned";
  if (sameLogin(issue.author.login, viewer)) return "created";
  return mentionsMode ? "mentioned" : "other";
}

export function runBucket(run: WorkflowRunSummary): RunBucket {
  if (isRunFailed(run)) return "failing";
  if (run.status === "queued" || run.status === "in_progress") return "running";
  return "recent";
}

function issueMatches(issue: IssueSummary, viewer: string | null, condition: PrWorkflow["suggestWhen"][number]): boolean {
  if (issue.state !== "OPEN") return false;
  if (condition === "issue-assigned") return issue.assignees.some((login) => sameLogin(login, viewer));
  if (condition === "issue-bug") return issue.labels.some((label) => label.toLowerCase() === "bug");
  return false;
}

function suggestedWorkflowFor(subject: SuggestionSubject, workflows: PrWorkflow[]): PrWorkflow | null {
  const candidates = workflows.filter((workflow) => workflow.target === subject.kind);
  if (subject.kind === "pr") return suggestedWorkflow(subject.pr, candidates);
  if (subject.kind === "issue") {
    return candidates.find((workflow) => workflow.enabled && workflow.suggestWhen.some((c) => issueMatches(subject.issue, subject.viewer, c))) ?? null;
  }
  const failed = isRunFailed(subject.run);
  return candidates.find((workflow) => workflow.enabled && workflow.suggestWhen.includes("run-failed") && failed) ?? null;
}

function issueLinkFor(session: SessionMeta, ref: IssueRef): SessionIssueLink | undefined {
  return (session.issues ?? []).find((link) => sameRepo(link.ref, ref) && link.ref.number === ref.number);
}

function runLinkFor(session: SessionMeta, ref: RunRef) {
  return (session.runs ?? []).find((link) => sameRepo(link.ref, ref) && link.ref.runId === ref.runId);
}

function runPrRef(run: WorkflowRunSummary): PrRef | null {
  if (run.prNumber === null) return null;
  return { host: run.ref.host, owner: run.ref.owner, repo: run.ref.repo, number: run.prNumber };
}

export function sessionsForPr(pr: PrSummary, sessions: SessionMeta[]): SessionMeta[] {
  return sessionsLinkedTo(sessions, pr.ref);
}

export function sessionsForIssue(issue: IssueSummary, sessions: SessionMeta[]): SessionMeta[] {
  return sessions.filter((session) => issueLinkFor(session, issue.ref) !== undefined);
}

export function sessionsForRun(run: WorkflowRunSummary, sessions: SessionMeta[]): SessionMeta[] {
  const prRef = runPrRef(run);
  const viaPr = prRef ? sessionsLinkedTo(sessions, prRef) : [];
  const viaRun = sessions.filter((session) => runLinkFor(session, run.ref) !== undefined);
  const seen = new Set<string>();
  return [...viaPr, ...viaRun].filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

function sessionsForSubject(subject: GitHubSubject, sessions: SessionMeta[]): SessionMeta[] {
  if (subject.kind === "pr") return sessionsForPr(subject.pr, sessions);
  if (subject.kind === "issue") return sessionsForIssue(subject.issue, sessions);
  return sessionsForRun(subject.run, sessions);
}

function latestSession(sessions: SessionMeta[]): SessionMeta | null {
  return sessions.reduce<SessionMeta | null>((latest, session) => (latest === null || session.updatedAt > latest.updatedAt ? session : latest), null);
}

export function sessionHasUnseenIssue(issue: IssueSummary, session: SessionMeta): boolean {
  const link = issueLinkFor(session, issue.ref);
  return link !== undefined && issue.updatedAt > link.lastSeenAt;
}

export function sessionHasUnseenPr(pr: PrSummary, session: SessionMeta): boolean {
  const link = linkFor(session, pr.ref);
  return link !== undefined && hasUnseen(pr, link);
}

function pickRowMainSession(subject: GitHubSubject, sessions: SessionMeta[]): SessionMeta | null {
  if (subject.kind === "pr") return pickMainSession(sessions, subject.pr.ref);
  return latestSession(sessions);
}

function sessionLinkOf(subject: GitHubSubject, session: SessionMeta): SessionOriginLink | undefined {
  if (subject.kind === "pr") return linkFor(session, subject.pr.ref);
  if (subject.kind === "issue") return issueLinkFor(session, subject.issue.ref);
  const own = runLinkFor(session, subject.run.ref);
  if (own) return own;
  const prRef = runPrRef(subject.run);
  return prRef ? linkFor(session, prRef) : undefined;
}

function isFinished(subject: GitHubSubject): boolean {
  if (subject.kind === "pr") return subject.pr.state !== "OPEN";
  if (subject.kind === "issue") return subject.issue.state !== "OPEN";
  return false;
}

function isUrgent(subject: GitHubSubject, viewer: string | null): boolean {
  if (subject.kind === "pr") {
    const bucket = prBucket(subject.pr);
    return bucket === "review" || bucket === "action";
  }
  if (subject.kind === "issue") return issueBucket(subject.issue, viewer) === "assigned";
  return runBucket(subject.run) === "failing" && sameLogin(subject.run.actor, viewer);
}

function subjectSuggestion(subject: GitHubSubject, viewer: string | null): SuggestionSubject {
  if (subject.kind === "pr") return subject;
  if (subject.kind === "issue") return { ...subject, viewer };
  return subject;
}

function sessionAction(
  { subject, sessions, workflows, unseen }: RowActionInput,
  session: SessionMeta,
  mode: "open" | "continue",
  workflowId: string | null = null
): SubjectAction {
  const link = sessionLinkOf(subject, session);
  const linked = workflows.find((workflow) => workflow.id === link?.workflowId);
  const label = mode === "continue" ? "Re-review" : (linked?.label ?? "Open session");
  let meta: SubjectSessionActivity = "idle";
  if (session.status === "working") meta = "working";
  else if (mode === "continue") meta = "new";
  else if (unseen.has(session.id)) meta = "unseen";
  return { kind: "session", sessionId: session.id, mode, workflowId, label, meta, count: sessions.length };
}

export function babysitterFor(
  subject: GitHubSubject,
  sessions: SessionMeta[],
  workflows: PrWorkflow[]
): { session: SessionMeta; workflow: PrWorkflow } | null {
  if (subject.kind === "issue" || isFinished(subject)) return null;
  const ref = subject.kind === "pr" ? subject.pr.ref : runPrRef(subject.run);
  return ref ? babysittingSession(sessions, ref, workflows) : null;
}

export function rowAction(input: RowActionInput): SubjectAction {
  const { subject, viewer, sessions, workflows } = input;
  const babysitter = babysitterFor(subject, sessions, workflows);
  if (babysitter) return sessionAction(input, babysitter.session, "open");
  const targetWorkflows = workflows.filter((workflow) => workflow.target === subject.kind);
  if (subject.kind === "pr" && subject.pr.state !== "MERGED") {
    const action = primaryAction(subject.pr, sessions, targetWorkflows);
    if (action.kind === "continue" || action.kind === "open") {
      const session = sessions.find((candidate) => candidate.id === action.sessionId);
      if (session) {
        return action.kind === "continue" ? sessionAction(input, session, "continue", action.workflowId) : sessionAction(input, session, "open");
      }
    }
  } else {
    const main = pickRowMainSession(subject, sessions);
    if (main) return sessionAction(input, main, "open");
  }
  if (isFinished(subject)) return { kind: "github" };
  const suggested = suggestedWorkflowFor(subjectSuggestion(subject, viewer), targetWorkflows);
  if (subject.kind === "run") {
    return suggested ? { kind: "workflow", workflowId: suggested.id, urgent: isUrgent(subject, viewer) } : { kind: "logs" };
  }
  const workflow = suggested ?? targetWorkflows.find((candidate) => candidate.enabled) ?? null;
  if (workflow) return { kind: "workflow", workflowId: workflow.id, urgent: suggested !== null && isUrgent(subject, viewer) };
  return { kind: "github" };
}

export function continueSessionFor(subject: GitHubSubject, workflowTarget: PrWorkflow["target"], sessions: SessionMeta[]): SessionMeta | null {
  if (workflowTarget === "pr") {
    const ref = subject.kind === "pr" ? subject.pr.ref : subject.kind === "run" ? runPrRef(subject.run) : null;
    return ref ? pickMainSession(sessionsLinkedTo(sessions, ref), ref) : null;
  }
  if (workflowTarget === "issue") {
    return subject.kind === "issue" ? latestSession(sessions.filter((session) => issueLinkFor(session, subject.issue.ref) !== undefined)) : null;
  }
  return subject.kind === "run" ? latestSession(sessions.filter((session) => runLinkFor(session, subject.run.ref) !== undefined)) : null;
}

function sessionIsUnseen(subject: GitHubSubject, session: SessionMeta, lookupPr: PrLookup): boolean {
  if (subject.kind === "pr") return sessionHasUnseenPr(subject.pr, session);
  if (subject.kind === "issue") return sessionHasUnseenIssue(subject.issue, session);
  const runLink = runLinkFor(session, subject.run.ref);
  if (runLink && runLink.lastSeenAt < subject.run.updatedAt) return true;
  const prRef = runPrRef(subject.run);
  const pr = prRef ? lookupPr(prRef) : undefined;
  return pr !== undefined && sessionHasUnseenPr(pr, session);
}

export function unseenSessionIds(subject: GitHubSubject, sessions: SessionMeta[], lookupPr: PrLookup = NO_PR_LOOKUP): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (sessionIsUnseen(subject, session, lookupPr)) ids.add(session.id);
  }
  return ids;
}

export function rowDelta(subject: GitHubSubject, sessions: SessionMeta[]): SubjectRelations["delta"] {
  if (subject.kind === "run" || !sessions.some((session) => sessionIsUnseen(subject, session, NO_PR_LOOKUP))) return null;
  if (subject.kind === "issue") return { kind: "activity" };
  const { pr } = subject;
  const main = pickMainSession(sessionsLinkedTo(sessions, pr.ref), pr.ref);
  const link = linkFor(main ?? undefined, pr.ref);
  if (!link) return null;
  if (link.lastSeenSha !== "" && pr.headRefOid !== link.lastSeenSha) return { kind: "commits" };
  return { kind: "updated", at: pr.updatedAt };
}

export function subjectRelations(
  subject: GitHubSubject,
  sessions: SessionMeta[],
  workflows: PrWorkflow[],
  viewer: string | null,
  lookupPr: PrLookup
): SubjectRelations {
  const linked = sessionsForSubject(subject, sessions);
  const unseen = unseenSessionIds(subject, linked, lookupPr);
  const babysitter = babysitterFor(subject, linked, workflows);
  return {
    linkedSessionIds: linked.map((session) => session.id),
    unseenSessionIds: [...unseen],
    mainSessionId: pickRowMainSession(subject, linked)?.id ?? null,
    babysitter: babysitter ? { sessionId: babysitter.session.id, workflowId: babysitter.workflow.id } : null,
    action: rowAction({ subject, viewer, sessions: linked, workflows, unseen }),
    delta: rowDelta(subject, linked)
  };
}
