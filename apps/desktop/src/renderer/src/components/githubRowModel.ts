import type {
  IssueLinkedPr,
  IssueSummary,
  PrLinkOrigin,
  PrReviewer,
  PrSummary,
  PrWorkflow,
  RunConclusion,
  RunJob,
  RunRef,
  SessionIssueLink,
  SessionMeta,
  SessionPrLink,
  SessionRunLink,
  WorkflowRunSummary
} from "@cw-code/contracts";
import { hasUnseen } from "./prUpdates.js";
import { babysittingSession, primaryAction, suggestedWorkflow } from "./prWorkflows.js";
import { prBucket } from "./prInbox.js";
import { formatRelativeAge } from "./prInboxModel.js";
import { linkFor, pickMainSession, sessionsLinkedTo } from "./sessionPrLinks.js";

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral" | "merged";

export type VerdictIcon =
  | "git-merge"
  | "git-pull-request"
  | "git-pull-request-closed"
  | "git-pull-request-draft"
  | "triangle-alert"
  | "circle-x"
  | "circle"
  | "circle-check"
  | "circle-check-big"
  | "circle-slash"
  | "circle-dot"
  | "circle-dashed"
  | "message-square-diff"
  | "loader"
  | "eye"
  | "clock"
  | "check";

export interface Verdict {
  tone: Tone;
  icon: VerdictIcon;
  text: string;
  spin?: boolean;
}

export interface PrGates {
  checks: Verdict;
  review: Verdict;
  merge: Verdict;
}

export interface StackPerson {
  login: string;
  badge: Tone | null;
  assignee: boolean;
  viewer: boolean;
}

export interface PeopleStack {
  author: string;
  others: StackPerson[];
  overflow: number;
}

export type IssueBucket = "assigned" | "mentioned" | "created" | "other" | "closed";
export type RunBucket = "failing" | "running" | "recent";

export type SuggestionSubject =
  | { kind: "pr"; pr: PrSummary }
  | { kind: "issue"; issue: IssueSummary; viewer: string | null }
  | { kind: "run"; run: WorkflowRunSummary };

export const MAX_STACK_PEOPLE = 3;
export const DIFF_BLOCKS = 5;
const SMALL_DIFF_LINES = 20;

const FAILED_CONCLUSIONS: ReadonlySet<RunConclusion> = new Set<RunConclusion>(["failure", "timed_out", "startup_failure"]);

export function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export { isBotLogin } from "./avatar.js";

function isViewerRequested(pr: PrSummary, viewer: string | null): boolean {
  return pr.reviewRequestedFromViewer || pr.reviewers.some((reviewer) => reviewer.state === "PENDING" && sameLogin(reviewer.login, viewer));
}

export function prVerdict(pr: PrSummary, viewer: string | null): Verdict {
  if (pr.state === "MERGED") return { tone: "merged", icon: "git-merge", text: "Merged" };
  if (pr.state === "CLOSED") return { tone: "bad", icon: "git-pull-request-closed", text: "Closed" };
  if (pr.isDraft) return { tone: "neutral", icon: "git-pull-request-draft", text: "Draft" };
  if (pr.mergeable === "CONFLICTING") return { tone: "bad", icon: "triangle-alert", text: "Conflicts" };
  if (pr.ci === "failing") {
    return { tone: "bad", icon: "circle-x", text: pr.checks.failed > 0 ? `CI failing · ${pr.checks.failed}` : "CI failing" };
  }
  if (pr.review === "changes_requested") return { tone: "bad", icon: "message-square-diff", text: "Changes requested" };
  if (pr.ci === "pending") return { tone: "warn", icon: "loader", text: "Checks running", spin: true };
  if (pr.review === "review_required" && isViewerRequested(pr, viewer)) return { tone: "info", icon: "eye", text: "Your review" };
  if (pr.review === "review_required") return { tone: "warn", icon: "clock", text: "Awaiting review" };
  if (pr.review === "approved" && (pr.ci === "passing" || pr.ci === "none")) return { tone: "ok", icon: "circle-check", text: "Ready to merge" };
  return { tone: "neutral", icon: "circle", text: "No reviewers" };
}

function checksGate(pr: PrSummary): Verdict {
  const { total, passed, failed, pending } = pr.checks;
  if (pr.ci === "failing") return { tone: "bad", icon: "circle-x", text: `${passed}/${total} passed · ${failed} failing` };
  if (pr.ci === "pending") return { tone: "warn", icon: "loader", text: `${passed}/${total} passed · ${pending} running`, spin: true };
  if (pr.ci === "passing") return { tone: "ok", icon: "circle-check", text: `${passed}/${total} passed` };
  return { tone: "neutral", icon: "circle", text: "No checks" };
}

function reviewGate(pr: PrSummary, viewer: string | null): Verdict {
  if (pr.review === "approved") return { tone: "ok", icon: "check", text: "Approved" };
  if (pr.review === "changes_requested") return { tone: "bad", icon: "message-square-diff", text: "Changes requested" };
  if (pr.review === "review_required") {
    return isViewerRequested(pr, viewer)
      ? { tone: "info", icon: "eye", text: "Your review is requested" }
      : { tone: "warn", icon: "clock", text: "Awaiting reviewers" };
  }
  return { tone: "neutral", icon: "circle", text: "No reviewers" };
}

function mergeGate(pr: PrSummary): Verdict {
  if (pr.state === "MERGED") return { tone: "merged", icon: "git-merge", text: `Merged into ${pr.baseRefName}` };
  if (pr.state === "CLOSED") return { tone: "bad", icon: "git-pull-request-closed", text: "Closed without merging" };
  if (pr.mergeable === "CONFLICTING") return { tone: "bad", icon: "triangle-alert", text: `Conflicts with ${pr.baseRefName}` };
  if (pr.isDraft) return { tone: "neutral", icon: "git-pull-request-draft", text: "Draft · can't merge yet" };
  if (pr.review === "approved" && pr.ci !== "failing" && pr.ci !== "pending") {
    return { tone: "ok", icon: "git-merge", text: `Can merge into ${pr.baseRefName}` };
  }
  return { tone: "neutral", icon: "git-merge", text: "Blocked by required checks or review" };
}

export function prGates(pr: PrSummary, viewer: string | null): PrGates {
  return { checks: checksGate(pr), review: reviewGate(pr, viewer), merge: mergeGate(pr) };
}

export function linkedPrVerdict(pr: IssueLinkedPr): Verdict {
  if (pr.state === "MERGED") return { tone: "merged", icon: "git-merge", text: `#${pr.number} · Merged` };
  if (pr.state === "CLOSED") return { tone: "bad", icon: "git-pull-request-closed", text: `#${pr.number} · Closed` };
  if (pr.isDraft) return { tone: "neutral", icon: "git-pull-request-draft", text: `#${pr.number} · Draft` };
  return { tone: "ok", icon: "git-pull-request", text: `#${pr.number} · Open` };
}

export function primaryLinkedPr(issue: IssueSummary): IssueLinkedPr | null {
  const open = issue.linkedPrs.find((pr) => pr.state === "OPEN");
  if (open) return open;
  const merged = issue.linkedPrs.find((pr) => pr.state === "MERGED");
  return merged ?? issue.linkedPrs[0] ?? null;
}

export function issueVerdict(issue: IssueSummary): Verdict {
  const linked = primaryLinkedPr(issue);
  if (issue.state === "CLOSED") {
    if (issue.stateReason === "NOT_PLANNED") return { tone: "neutral", icon: "circle-slash", text: "Not planned" };
    return { tone: "merged", icon: "circle-check-big", text: linked ? `Closed by #${linked.number}` : "Completed" };
  }
  if (linked) return linkedPrVerdict(linked);
  return { tone: "neutral", icon: "git-pull-request", text: "No linked PR" };
}

export function isRunFailed(run: Pick<WorkflowRunSummary, "status" | "conclusion">): boolean {
  return run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion);
}

export function isJobFailed(job: Pick<RunJob, "status" | "conclusion">): boolean {
  return job.status === "completed" && job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion);
}

export function isJobSuccessful(job: Pick<RunJob, "status" | "conclusion">): boolean {
  return job.status === "completed" && job.conclusion === "success";
}

export function runVerdict(run: WorkflowRunSummary): Verdict {
  const total = run.jobs.length;
  if (run.status === "queued") return { tone: "neutral", icon: "circle-dashed", text: "Queued" };
  if (run.status === "in_progress") {
    const done = run.jobs.filter((job) => job.status === "completed").length;
    return { tone: "warn", icon: "loader", text: total > 0 ? `Running · ${done}/${total} jobs` : "Running", spin: true };
  }
  if (isRunFailed(run)) {
    const failed = run.jobs.filter(isJobFailed).length;
    const label = run.conclusion === "timed_out" ? "Timed out" : run.conclusion === "startup_failure" ? "Startup failure" : "Failed";
    return { tone: "bad", icon: "circle-x", text: total > 0 && failed > 0 ? `${label} · ${failed} of ${total} jobs` : label };
  }
  switch (run.conclusion) {
    case "success":
      return { tone: "ok", icon: "circle-check", text: "Succeeded" };
    case "cancelled":
      return { tone: "neutral", icon: "circle-slash", text: "Cancelled" };
    case "skipped":
      return { tone: "neutral", icon: "circle-slash", text: "Skipped" };
    case "action_required":
      return { tone: "warn", icon: "triangle-alert", text: "Action required" };
    case "stale":
      return { tone: "neutral", icon: "circle-dashed", text: "Stale" };
    default:
      return { tone: "neutral", icon: "circle", text: "Completed" };
  }
}

export function diffBlocks(additions: number, deletions: number): { add: number; del: number; neutral: number } {
  const total = additions + deletions;
  if (total <= 0) return { add: 0, del: 0, neutral: DIFF_BLOCKS };
  let add = Math.round((additions / total) * DIFF_BLOCKS);
  let del = DIFF_BLOCKS - add;
  if (total < SMALL_DIFF_LINES) {
    add = Math.min(add, 1);
    del = Math.min(del, 1);
  }
  return { add, del, neutral: DIFF_BLOCKS - add - del };
}

export function reviewerBadge(state: PrReviewer["state"]): Tone {
  if (state === "APPROVED") return "ok";
  if (state === "CHANGES_REQUESTED") return "bad";
  if (state === "PENDING") return "warn";
  return "neutral";
}

export function peopleStack(item: PrSummary | IssueSummary, viewer: string | null): PeopleStack {
  const author = item.author.login;
  const reviewers: PrReviewer[] = "reviewers" in item ? item.reviewers : [];
  const all: StackPerson[] = reviewers.map((reviewer) => ({
    login: reviewer.login,
    badge: reviewerBadge(reviewer.state),
    assignee: false,
    viewer: sameLogin(reviewer.login, viewer)
  }));
  for (const login of item.assignees) {
    if (sameLogin(login, author)) continue;
    if (all.some((person) => sameLogin(person.login, login))) continue;
    all.push({ login, badge: null, assignee: true, viewer: sameLogin(login, viewer) });
  }
  const shown = all.length > MAX_STACK_PEOPLE ? MAX_STACK_PEOPLE - 1 : all.length;
  return { author, others: all.slice(0, shown), overflow: all.length - shown };
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

export function suggestedWorkflowFor(subject: SuggestionSubject, workflows: PrWorkflow[]): PrWorkflow | null {
  const candidates = workflows.filter((workflow) => workflow.target === subject.kind);
  if (subject.kind === "pr") return suggestedWorkflow(subject.pr, candidates);
  if (subject.kind === "issue") {
    return candidates.find((workflow) => workflow.enabled && workflow.suggestWhen.some((c) => issueMatches(subject.issue, subject.viewer, c))) ?? null;
  }
  const failed = isRunFailed(subject.run);
  return candidates.find((workflow) => workflow.enabled && workflow.suggestWhen.includes("run-failed") && failed) ?? null;
}

export function enabledWorkflowsFor(target: PrWorkflow["target"], workflows: PrWorkflow[]): PrWorkflow[] {
  return workflows.filter((workflow) => workflow.target === target && workflow.enabled);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function runDurationMs(run: WorkflowRunSummary, now: number): number | null {
  if (run.status === "queued") return null;
  const end = run.status === "in_progress" ? now : run.updatedAt;
  return Math.max(0, end - run.createdAt);
}

export interface LinkedSession {
  id: string;
  updatedAt: number;
  prs?: SessionPrLink[];
  issues?: SessionIssueLink[];
  runs?: SessionRunLink[];
}

function sameRepo(a: { host: string; owner: string; repo: string }, b: { host: string; owner: string; repo: string }): boolean {
  return sameLogin(a.host, b.host) && sameLogin(a.owner, b.owner) && sameLogin(a.repo, b.repo);
}

export function issueLinkFor(session: LinkedSession, ref: IssueSummary["ref"]): SessionIssueLink | undefined {
  return (session.issues ?? []).find((link) => sameRepo(link.ref, ref) && link.ref.number === ref.number);
}

export function runLinkFor(session: LinkedSession, ref: RunRef): SessionRunLink | undefined {
  return (session.runs ?? []).find((link) => sameRepo(link.ref, ref) && link.ref.runId === ref.runId);
}

export function runPrRef(run: WorkflowRunSummary): PrSummary["ref"] | null {
  if (run.prNumber === null) return null;
  return { host: run.ref.host, owner: run.ref.owner, repo: run.ref.repo, number: run.prNumber };
}

export function sessionsForPr<S extends LinkedSession>(pr: PrSummary, sessions: S[]): S[] {
  return sessionsLinkedTo(sessions, pr.ref);
}

export function sessionsForIssue<S extends LinkedSession>(issue: IssueSummary, sessions: S[]): S[] {
  return sessions.filter((session) => issueLinkFor(session, issue.ref) !== undefined);
}

export function sessionsForRun<S extends LinkedSession>(run: WorkflowRunSummary, sessions: S[]): S[] {
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

export function latestSession<S extends LinkedSession>(sessions: S[]): S | null {
  return sessions.reduce<S | null>((latest, session) => (latest === null || session.updatedAt > latest.updatedAt ? session : latest), null);
}

export function sessionHasUnseenIssue(issue: IssueSummary, session: LinkedSession): boolean {
  const link = issueLinkFor(session, issue.ref);
  return link !== undefined && issue.updatedAt > link.lastSeenAt;
}

export function sessionHasUnseenPr(pr: PrSummary, session: LinkedSession): boolean {
  const link = linkFor(session, pr.ref);
  return link !== undefined && hasUnseen(pr, link);
}

export function pickRowMainSession<S extends LinkedSession>(
  subject: { kind: "pr"; pr: PrSummary } | { kind: "issue" } | { kind: "run" },
  sessions: S[]
): S | null {
  if (subject.kind === "pr") return pickMainSession(sessions, subject.pr.ref);
  return latestSession(sessions);
}

export interface SessionOriginLink {
  origin: PrLinkOrigin;
  workflowId?: string;
}

export function originLabel(link: SessionOriginLink | undefined, subject: "pr" | "issue" | "run", workflows: PrWorkflow[]): string {
  if (!link) return "Linked";
  if (link.origin === "opened") return subject === "pr" ? "Opened this PR" : "Opened this";
  if (link.origin === "workflow") {
    const workflow = workflows.find((w) => w.id === link.workflowId);
    return `Workflow: ${workflow?.label ?? link.workflowId ?? "unknown"}`;
  }
  return "Linked";
}

export function sessionLinkOf(
  subject: { kind: "pr"; pr: PrSummary } | { kind: "issue"; issue: IssueSummary } | { kind: "run"; run: WorkflowRunSummary },
  session: LinkedSession
): SessionOriginLink | undefined {
  if (subject.kind === "pr") return linkFor(session, subject.pr.ref);
  if (subject.kind === "issue") return issueLinkFor(session, subject.issue.ref);
  const own = runLinkFor(session, subject.run.ref);
  if (own) return own;
  const prRef = runPrRef(subject.run);
  return prRef ? linkFor(session, prRef) : undefined;
}

export type RowSubject =
  | { kind: "pr"; pr: PrSummary }
  | { kind: "issue"; issue: IssueSummary }
  | { kind: "run"; run: WorkflowRunSummary };

export type SessionActivity = "working" | "new" | "unseen" | "idle";

export type RowActionModel<S> =
  | { kind: "session"; session: S; label: string; mode: "open" | "continue"; workflowId: string | null; meta: SessionActivity; count: number }
  | { kind: "workflow"; workflow: PrWorkflow; urgent: boolean }
  | { kind: "logs" }
  | { kind: "github" };

interface RowActionInput<S> {
  subject: RowSubject;
  viewer: string | null;
  sessions: S[];
  workflows: PrWorkflow[];
  unseen: ReadonlySet<string>;
}

type ActionSession = SessionMeta;

export function isFinished(subject: RowSubject): boolean {
  if (subject.kind === "pr") return subject.pr.state !== "OPEN";
  if (subject.kind === "issue") return subject.issue.state !== "OPEN";
  return false;
}

function isUrgent(subject: RowSubject, viewer: string | null): boolean {
  if (subject.kind === "pr") {
    const bucket = prBucket(subject.pr);
    return bucket === "review" || bucket === "action";
  }
  if (subject.kind === "issue") return issueBucket(subject.issue, viewer) === "assigned";
  return runBucket(subject.run) === "failing" && sameLogin(subject.run.actor, viewer);
}

function subjectSuggestion(subject: RowSubject, viewer: string | null): SuggestionSubject {
  if (subject.kind === "pr") return subject;
  if (subject.kind === "issue") return { ...subject, viewer };
  return subject;
}

function sessionAction<S extends ActionSession>(
  { subject, sessions, workflows, unseen }: RowActionInput<S>,
  session: S,
  mode: "open" | "continue",
  workflowId: string | null = null
): RowActionModel<S> {
  const link = sessionLinkOf(subject, session);
  const linked = workflows.find((workflow) => workflow.id === link?.workflowId);
  const label = mode === "continue" ? "Re-review" : (linked?.label ?? "Open session");
  let meta: SessionActivity = "idle";
  if (session.status === "working") meta = "working";
  else if (mode === "continue") meta = "new";
  else if (unseen.has(session.id)) meta = "unseen";
  return { kind: "session", session, label, mode, workflowId, meta, count: sessions.length };
}

export function babysitterFor<S extends ActionSession>(
  subject: RowSubject,
  sessions: S[],
  workflows: PrWorkflow[]
): { session: S; workflow: PrWorkflow } | null {
  if (subject.kind === "issue" || isFinished(subject)) return null;
  const ref = subject.kind === "pr" ? subject.pr.ref : runPrRef(subject.run);
  return ref ? babysittingSession(sessions, ref, workflows) : null;
}

export function rowAction<S extends ActionSession>(input: RowActionInput<S>): RowActionModel<S> {
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
    return suggested ? { kind: "workflow", workflow: suggested, urgent: isUrgent(subject, viewer) } : { kind: "logs" };
  }
  const workflow = suggested ?? targetWorkflows.find((candidate) => candidate.enabled) ?? null;
  if (workflow) return { kind: "workflow", workflow, urgent: suggested !== null && isUrgent(subject, viewer) };
  return { kind: "github" };
}

export function continueSessionFor<S extends LinkedSession>(subject: RowSubject, workflowTarget: PrWorkflow["target"], sessions: S[]): S | null {
  if (workflowTarget === "pr") {
    const ref = subject.kind === "pr" ? subject.pr.ref : subject.kind === "run" ? runPrRef(subject.run) : null;
    return ref ? pickMainSession(sessionsLinkedTo(sessions, ref), ref) : null;
  }
  if (workflowTarget === "issue") {
    return subject.kind === "issue" ? latestSession(sessions.filter((session) => issueLinkFor(session, subject.issue.ref) !== undefined)) : null;
  }
  return subject.kind === "run" ? latestSession(sessions.filter((session) => runLinkFor(session, subject.run.ref) !== undefined)) : null;
}

export function externalLinkOf(subject: RowSubject): string {
  if (subject.kind === "pr") return subject.pr.url;
  if (subject.kind === "issue") return subject.issue.url;
  return subject.run.url;
}

export function stateGlyph(subject: RowSubject): Verdict {
  if (subject.kind === "run") return runVerdict(subject.run);
  if (subject.kind === "pr") {
    const { pr } = subject;
    if (pr.state === "MERGED") return { tone: "merged", icon: "git-merge", text: "Merged" };
    if (pr.state === "CLOSED") return { tone: "bad", icon: "git-pull-request-closed", text: "Closed" };
    if (pr.isDraft) return { tone: "neutral", icon: "git-pull-request-draft", text: "Draft" };
    return { tone: "ok", icon: "git-pull-request", text: "Open" };
  }
  const { issue } = subject;
  if (issue.state === "OPEN") return { tone: "ok", icon: "circle-dot", text: "Open" };
  if (issue.stateReason === "NOT_PLANNED") return { tone: "neutral", icon: "circle-slash", text: "Closed as not planned" };
  return { tone: "merged", icon: "circle-check-big", text: "Closed as completed" };
}

export type PrLookup = (ref: PrSummary["ref"]) => PrSummary | undefined;

const NO_PR_LOOKUP: PrLookup = () => undefined;

export function unseenSessionIds(subject: RowSubject, sessions: LinkedSession[], lookupPr: PrLookup = NO_PR_LOOKUP): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (sessionIsUnseen(subject, session, lookupPr)) ids.add(session.id);
  }
  return ids;
}

function sessionIsUnseen(subject: RowSubject, session: LinkedSession, lookupPr: PrLookup): boolean {
  if (subject.kind === "pr") return sessionHasUnseenPr(subject.pr, session);
  if (subject.kind === "issue") return sessionHasUnseenIssue(subject.issue, session);
  const runLink = runLinkFor(session, subject.run.ref);
  if (runLink && runLink.lastSeenAt < subject.run.updatedAt) return true;
  const prRef = runPrRef(subject.run);
  const pr = prRef ? lookupPr(prRef) : undefined;
  return pr !== undefined && sessionHasUnseenPr(pr, session);
}

function rowHasUnseen(subject: RowSubject, sessions: LinkedSession[]): boolean {
  return sessions.some((session) => sessionIsUnseen(subject, session, NO_PR_LOOKUP));
}

export function rowDelta(subject: RowSubject, sessions: LinkedSession[], now: number): string | null {
  if (subject.kind === "run" || !rowHasUnseen(subject, sessions)) return null;
  if (subject.kind === "issue") return "new activity";
  const { pr } = subject;
  const main = pickMainSession(sessionsLinkedTo(sessions, pr.ref), pr.ref);
  const link = linkFor(main ?? undefined, pr.ref);
  if (!link) return null;
  if (link.lastSeenSha !== "" && pr.headRefOid !== link.lastSeenSha) return "new commits";
  return `updated ${formatRelativeAge(pr.updatedAt, now)}`;
}

export type JobPip = "ok" | "bad" | "warn" | "neutral";

export function jobPip(job: RunJob): JobPip {
  if (isJobSuccessful(job)) return "ok";
  if (isJobFailed(job)) return "bad";
  if (job.status === "in_progress") return "warn";
  return "neutral";
}
