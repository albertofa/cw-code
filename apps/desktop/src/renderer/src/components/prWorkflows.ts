import type {
  AppSettings,
  IssueComment,
  IssueDetail,
  PrCheck,
  PrDetail,
  PrRef,
  PrSuggestCondition,
  PrSummary,
  PrUpdate,
  PrWorkflow,
  RunJob,
  RunRef,
  SessionIssueLink,
  SessionMeta,
  SessionPrLink,
  WorkflowRunSummary
} from "@cw-code/contracts";
import { autoFollowUpWorkflow } from "@cw-code/shared/autoFollowUp";
import { linkFor, pickMainSession } from "./sessionPrLinks.js";

export const TEMPLATE_VARS = [
  "pr.number",
  "pr.title",
  "pr.body",
  "pr.url",
  "pr.repo",
  "pr.head",
  "pr.base",
  "pr.sha",
  "pr.diffStat",
  "pr.threads",
  "pr.unresolvedThreads",
  "checks.summary",
  "checks.failedLogs",
  "pr.delta",
  "session.lastSeenSha",
  "attribution",
  "harness"
] as const;

export const ISSUE_TEMPLATE_VARS = [
  "issue.number",
  "issue.title",
  "issue.body",
  "issue.url",
  "issue.repo",
  "issue.labels",
  "issue.comments",
  "issue.delta",
  "attribution",
  "harness"
] as const;

export const RUN_TEMPLATE_VARS = [
  "run.id",
  "run.number",
  "run.workflow",
  "run.url",
  "run.repo",
  "run.branch",
  "run.sha",
  "run.event",
  "run.failedJobs",
  "run.failedLogs",
  "attribution",
  "harness"
] as const;

export const TEMPLATE_VARS_BY_TARGET: Record<PrWorkflow["target"], readonly string[]> = {
  pr: TEMPLATE_VARS,
  issue: ISSUE_TEMPLATE_VARS,
  run: RUN_TEMPLATE_VARS
};

const ISSUE_COMMENTS_LIMIT = 10;

const ISSUE_BODY_MAX_CHARS = 8_000;

const ISSUE_COMMENT_MAX_CHARS = 2_000;

const TRUNCATION_MARKER = "[…truncated]";

const FAILED_JOB_CONCLUSIONS: ReadonlySet<RunJob["conclusion"]> = new Set(["failure", "timed_out", "startup_failure"]);

export function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => (name in vars ? vars[name] : match));
}

function formatThreads(threads: PrDetail["threads"]): string {
  return threads
    .map((thread) => {
      const first = thread.comments[0];
      const location = thread.line !== null ? `${thread.path}:${thread.line}` : thread.path;
      return `- ${location} — ${first ? `${first.author}: ${first.body}` : "no comments"}`;
    })
    .join("\n");
}

function formatChecksSummary(checkRuns: PrDetail["checkRuns"]): string {
  if (checkRuns.length === 0) return "no checks";
  const passed = checkRuns.filter((c) => c.status === "success" || c.status === "skipped").length;
  const failing = checkRuns.filter((c) => c.status === "failure");
  const pending = checkRuns.filter((c) => c.status === "pending").length;
  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failing.length > 0) parts.push(`${failing.length} failing (${failing.map((c) => c.name).join(", ")})`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.length > 0 ? parts.join(", ") : "no checks";
}

export function templateVars(
  pr: PrDetail,
  opts: { link?: SessionPrLink; updates?: PrUpdate[]; failedLogs?: string; attribution: string; harness: string }
): Record<string, string> {
  const unresolved = pr.threads.filter((t) => !t.isResolved);
  return {
    "pr.number": String(pr.ref.number),
    "pr.title": pr.title,
    "pr.body": pr.body,
    "pr.url": pr.url,
    "pr.repo": `${pr.ref.owner}/${pr.ref.repo}`,
    "pr.head": pr.headRefName,
    "pr.base": pr.baseRefName,
    "pr.sha": pr.headRefOid,
    "pr.diffStat": `+${pr.additions} −${pr.deletions}, ${pr.changedFiles} files`,
    "pr.threads": formatThreads(pr.threads),
    "pr.unresolvedThreads": formatThreads(unresolved),
    "checks.summary": formatChecksSummary(pr.checkRuns),
    "checks.failedLogs": opts.failedLogs ?? "",
    "pr.delta": (opts.updates ?? []).map((u) => u.summary).join("\n"),
    "session.lastSeenSha": opts.link?.lastSeenSha ?? "",
    attribution: opts.attribution,
    harness: opts.harness
  };
}

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n${TRUNCATION_MARKER}` : text;
}

function formatComments(comments: IssueComment[]): string {
  return comments.map((comment) => `${comment.author}: ${capText(comment.body, ISSUE_COMMENT_MAX_CHARS)}`).join("\n");
}

export function issueTemplateVars(
  issue: IssueDetail,
  opts: { link?: SessionIssueLink; attribution: string; harness: string }
): Record<string, string> {
  const lastSeenAt = opts.link?.lastSeenAt;
  const fresh = lastSeenAt === undefined ? [] : issue.comments.filter((comment) => comment.createdAt > lastSeenAt);
  return {
    "issue.number": String(issue.ref.number),
    "issue.title": issue.title,
    "issue.body": capText(issue.body, ISSUE_BODY_MAX_CHARS),
    "issue.url": issue.url,
    "issue.repo": `${issue.ref.owner}/${issue.ref.repo}`,
    "issue.labels": issue.labels.join(", "),
    "issue.comments": formatComments(issue.comments.slice(-ISSUE_COMMENTS_LIMIT)),
    "issue.delta": formatComments(fresh),
    attribution: opts.attribution,
    harness: opts.harness
  };
}

export function failedJobNames(jobs: RunJob[]): string[] {
  return jobs.filter((job) => FAILED_JOB_CONCLUSIONS.has(job.conclusion)).map((job) => job.name);
}

export function runTemplateVars(
  run: WorkflowRunSummary,
  opts: { failedLogs?: string; attribution: string; harness: string }
): Record<string, string> {
  return {
    "run.id": String(run.ref.runId),
    "run.number": String(run.runNumber),
    "run.workflow": run.workflowName,
    "run.url": run.url,
    "run.repo": `${run.ref.owner}/${run.ref.repo}`,
    "run.branch": run.branch ?? "",
    "run.sha": run.headSha,
    "run.event": run.event,
    "run.failedJobs": failedJobNames(run.jobs).join(", "),
    "run.failedLogs": opts.failedLogs ?? "",
    attribution: opts.attribution,
    harness: opts.harness
  };
}

export function runRefTemplateVars(
  ref: RunRef,
  opts: { failedLogs?: string; attribution: string; harness: string }
): Record<string, string> {
  return {
    "run.id": String(ref.runId),
    "run.number": "",
    "run.workflow": "",
    "run.url": "",
    "run.repo": `${ref.owner}/${ref.repo}`,
    "run.branch": "",
    "run.sha": "",
    "run.event": "",
    "run.failedJobs": "",
    "run.failedLogs": opts.failedLogs ?? "",
    attribution: opts.attribution,
    harness: opts.harness
  };
}

const FAILED_LOG_TAIL_CHARS = 12_000;

const FAILED_LOGS_TOTAL_CHARS = 30_000;

export type CheckLogFetcher = (ref: PrRef, runId: number) => Promise<string>;

function failingRuns(checks: PrCheck[]): Array<{ runId: number; names: string[] }> {
  const byRun = new Map<number, string[]>();
  for (const check of checks) {
    if (check.status !== "failure" || check.runId === null) continue;
    byRun.set(check.runId, [...(byRun.get(check.runId) ?? []), check.name]);
  }
  return [...byRun.entries()].map(([runId, names]) => ({ runId, names }));
}

function tail(text: string): string {
  return text.length > FAILED_LOG_TAIL_CHARS ? `${TRUNCATION_MARKER}\n${text.slice(-FAILED_LOG_TAIL_CHARS)}` : text;
}

export async function loadFailedLogs(
  detail: PrDetail,
  fetchLog: CheckLogFetcher = (ref, runId) => window.cw.getPrCheckLog(ref, runId)
): Promise<string> {
  const runs = failingRuns(detail.checkRuns);
  const logs = await Promise.all(
    runs.map(async (run) => `### ${run.names.join(", ")} (run ${run.runId})\n${tail((await fetchLog(detail.ref, run.runId)).trim())}`)
  );
  return capFailedLogs(logs);
}

export async function loadRunFailedLogs(ref: RunRef, fetchLog: (ref: RunRef) => Promise<string> = (run) => window.cw.getRunLog(run)): Promise<string> {
  return capFailedLogs([tail((await fetchLog(ref)).trim())]);
}

function capFailedLogs(sections: string[]): string {
  const joined = sections.join("\n\n");
  return joined.length > FAILED_LOGS_TOTAL_CHARS ? `${joined.slice(0, FAILED_LOGS_TOTAL_CHARS)}\n[…more logs truncated]` : joined;
}

export function attributionText(settings: Pick<AppSettings, "prAttributionEnabled" | "prAttributionText">, harness: string): string {
  if (!settings.prAttributionEnabled) return "";
  return resolveTemplate(settings.prAttributionText, { harness });
}

export function matchesCondition(pr: PrSummary, c: PrSuggestCondition): boolean {
  switch (c) {
    case "review-requested":
      return !pr.viewerIsAuthor && pr.reviewRequestedFromViewer;
    case "author":
      return pr.viewerIsAuthor;
    case "checks-failing":
      return pr.ci === "failing";
    case "changes-requested":
      return pr.review === "changes_requested";
    case "conflicts":
      return pr.mergeable === "CONFLICTING";
    case "bot-author":
      return pr.author.isBot;
    case "draft":
      return pr.isDraft;
    default:
      return false;
  }
}

export function suggestedWorkflow(pr: PrSummary, workflows: PrWorkflow[]): PrWorkflow | null {
  return workflows.find((w) => w.enabled && w.suggestWhen.some((c) => matchesCondition(pr, c))) ?? null;
}

export function babysittingSession<S extends Pick<SessionMeta, "status" | "prs">>(
  sessions: S[],
  ref: PrRef,
  workflows: PrWorkflow[]
): { session: S; workflow: PrWorkflow } | null {
  for (const session of sessions) {
    if (session.status === "resolved" || session.status === "archived") continue;
    const link = linkFor(session, ref);
    const workflow = link ? autoFollowUpWorkflow(link, workflows) : null;
    if (workflow) return { session, workflow };
  }
  return null;
}

export type PrPrimaryAction =
  | { kind: "open"; sessionId: string }
  | { kind: "continue"; sessionId: string; workflowId: string }
  | { kind: "run"; workflowId: string }
  | { kind: "none" };

export function primaryAction(pr: PrSummary, linked: SessionMeta[], workflows: PrWorkflow[]): PrPrimaryAction {
  if (pr.state === "MERGED") return { kind: "none" };
  const session = pickMainSession(linked, pr.ref);
  const link = session ? linkFor(session, pr.ref) : undefined;
  if (session && link?.workflowId === "review" && pr.headRefOid !== link.lastSeenSha) {
    return { kind: "continue", sessionId: session.id, workflowId: "review" };
  }
  if (session) return { kind: "open", sessionId: session.id };
  const suggested = suggestedWorkflow(pr, workflows);
  if (suggested) return { kind: "run", workflowId: suggested.id };
  return { kind: "none" };
}
