import type {
  GitPullRequestChecks,
  PrBucket,
  PrCheck,
  PrCiState,
  PrCommit,
  PrDetail,
  PrMergeable,
  PrRef,
  PrReviewState,
  PrReviewThread,
  PrReviewer,
  PrSummary,
  PrThreadComment,
  PrTimelineItem
} from "@cw-code/contracts";
import { INBOX_SEARCH_LIMIT } from "./prQueries.js";

const PASSING_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILING_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"]);
const REVIEW_TIMELINE_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);
const REVIEWER_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "PENDING"]);

const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asNodes(value: unknown): Record<string, unknown>[] {
  const list = asRecord(value).nodes;
  return Array.isArray(list) ? list.map(asRecord) : [];
}

function asEpochMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function rollupStates(statusCheckRollup: unknown): string[] {
  return asNodes(asRecord(statusCheckRollup).contexts).map((context) => asString(context.conclusion) || asString(context.status) || asString(context.state));
}

export function ciFromRollup(states: string[]): { ci: PrCiState; checks: GitPullRequestChecks } {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const raw of states) {
    const state = raw.toUpperCase();
    if (PASSING_STATES.has(state)) passed += 1;
    else if (FAILING_STATES.has(state)) failed += 1;
    else pending += 1;
  }
  const total = states.length;
  const ci: PrCiState = total === 0 ? "none" : failed > 0 ? "failing" : pending > 0 ? "pending" : "passing";
  return { ci, checks: { total, passed, failed, pending } };
}

export function prKey(ref: PrRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`;
}

export function prRefFromUrl(url: string): PrRef | null {
  const match = PR_URL_RE.exec(url.trim());
  if (!match) return null;
  const number = Number.parseInt(match[4], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { host: match[1].toLowerCase(), owner: match[2], repo: match[3], number };
}

export function bucketFor(pr: PrSummary): PrBucket {
  if (pr.state === "MERGED") return "merged";
  if (!pr.viewerIsAuthor && pr.reviewRequestedFromViewer) return "review";
  if (pr.viewerIsAuthor && (pr.ci === "failing" || pr.review === "changes_requested" || pr.mergeable === "CONFLICTING")) return "action";
  if (pr.viewerIsAuthor && pr.review === "approved" && pr.ci === "passing") return "ready";
  return "waiting";
}

function reviewStateFrom(value: unknown): PrReviewState {
  const decision = asString(value);
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes_requested";
  if (decision === "REVIEW_REQUIRED") return "review_required";
  return "none";
}

function mergeableFrom(value: unknown): PrMergeable {
  const state = asString(value);
  return state === "MERGEABLE" || state === "CONFLICTING" ? state : "UNKNOWN";
}

function prStateFrom(value: unknown): PrSummary["state"] {
  const state = asString(value);
  return state === "CLOSED" || state === "MERGED" ? state : "OPEN";
}

function parseSummaryNode(node: Record<string, unknown>, viewer: string | null): PrSummary | null {
  const url = asString(node.url);
  const ref = prRefFromUrl(url);
  const number = asNumber(node.number);
  if (!ref || number <= 0) return null;
  const author = asRecord(node.author);
  const login = asString(author.login);
  const reviewerLogins = asNodes(node.reviewRequests)
    .map((request) => asString(asRecord(request.requestedReviewer).login))
    .filter(Boolean);
  const ciCommit = asNodes(node.ciCommits)[0];
  const { ci, checks } = ciFromRollup(rollupStates(asRecord(ciCommit?.commit).statusCheckRollup));
  return {
    ref,
    url,
    title: asString(node.title, `Pull request #${number}`),
    state: prStateFrom(node.state),
    isDraft: asBool(node.isDraft),
    author: { login, isBot: asString(author.__typename) === "Bot" },
    viewerIsAuthor: asBool(node.viewerDidAuthor),
    reviewRequestedFromViewer: viewer !== null && reviewerLogins.includes(viewer),
    headRefName: asString(node.headRefName),
    headRefOid: asString(node.headRefOid),
    baseRefName: asString(node.baseRefName),
    additions: asNumber(node.additions),
    deletions: asNumber(node.deletions),
    changedFiles: asNumber(node.changedFiles),
    commentsCount: asNumber(asRecord(node.comments).totalCount),
    unresolvedThreads: asNodes(node.reviewThreads).filter((thread) => thread.isResolved !== true).length,
    ci,
    checks,
    review: reviewStateFrom(node.reviewDecision),
    mergeable: mergeableFrom(node.mergeable),
    labels: asNodes(node.labels).map((label) => asString(label.name)).filter(Boolean),
    updatedAt: asEpochMs(node.updatedAt)
  };
}

export function parseInbox(json: string): { viewer: string | null; items: PrSummary[]; truncated: boolean } {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { viewer: null, items: [], truncated: false };
  }
  const data = asRecord(root.data);
  const viewer = asString(asRecord(data.viewer).login) || null;
  const nodes = asNodes(data.search);
  const items: PrSummary[] = [];
  for (const node of nodes) {
    const summary = parseSummaryNode(node, viewer);
    if (summary) items.push(summary);
  }
  return { viewer, items, truncated: nodes.length >= INBOX_SEARCH_LIMIT };
}

function commentAuthor(commit: Record<string, unknown>): string {
  const author = asRecord(commit.author);
  return asString(asRecord(author.user).login) || asString(author.name);
}

function parseCommitNode(node: Record<string, unknown>): PrCommit {
  const commit = asRecord(node.commit);
  const { ci } = ciFromRollup(rollupStates(commit.statusCheckRollup));
  return {
    oid: asString(commit.oid),
    headline: asString(commit.messageHeadline),
    author: commentAuthor(commit),
    committedAt: asEpochMs(commit.committedDate),
    ci
  };
}

function parseThreadComments(value: unknown): PrThreadComment[] {
  return asNodes(value).map((comment) => ({
    author: asString(asRecord(comment.author).login),
    body: asString(comment.body),
    createdAt: asEpochMs(comment.createdAt)
  }));
}

function parseThreads(value: unknown): PrReviewThread[] {
  return asNodes(value)
    .filter((thread) => asString(thread.id))
    .map((thread) => {
      const comments = asNodes(thread.comments);
      return {
        id: asString(thread.id),
        path: asString(thread.path),
        line: typeof thread.line === "number" ? thread.line : null,
        isResolved: asBool(thread.isResolved),
        diffHunk: asString(comments[0]?.diffHunk),
        comments: parseThreadComments(thread.comments)
      };
    });
}

function parseReviewers(value: unknown): PrReviewer[] {
  const reviewers: PrReviewer[] = [];
  for (const node of asNodes(value)) {
    const login = asString(asRecord(node.author).login);
    if (!login) continue;
    const state = asString(node.state);
    reviewers.push({ login, state: (REVIEWER_STATES.has(state) ? state : "PENDING") as PrReviewer["state"] });
  }
  return reviewers;
}

function checkStatusFrom(conclusion: string, status: string): PrCheck["status"] {
  const state = (conclusion || status).toUpperCase();
  if (state === "SKIPPED") return "skipped";
  if (PASSING_STATES.has(state)) return "success";
  if (FAILING_STATES.has(state)) return "failure";
  return "pending";
}

function parseCheckRuns(value: unknown): PrCheck[] {
  const commit = asRecord(asNodes(value)[0]?.commit);
  const checks: PrCheck[] = [];
  for (const suite of asNodes(commit.checkSuites)) {
    const workflowRun = asRecord(suite.workflowRun);
    const workflow = asString(asRecord(workflowRun.workflow).name) || null;
    const runId = typeof workflowRun.databaseId === "number" ? workflowRun.databaseId : null;
    for (const run of asNodes(suite.checkRuns)) {
      checks.push({
        name: asString(run.name),
        workflow,
        status: checkStatusFrom(asString(run.conclusion), asString(run.status)),
        url: asString(run.detailsUrl) || null,
        runId,
        completedAt: run.completedAt ? asEpochMs(run.completedAt) : null
      });
    }
  }
  return checks;
}

function actorLogin(node: Record<string, unknown>): string {
  return asString(asRecord(node.actor).login);
}

const TIMELINE_EVENT_KINDS: Record<string, "merged" | "closed" | "reopened" | "ready_for_review"> = {
  MergedEvent: "merged",
  ClosedEvent: "closed",
  ReopenedEvent: "reopened",
  ReadyForReviewEvent: "ready_for_review"
};

function threadReviewIndex(value: unknown): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const thread of asNodes(value)) {
    const threadId = asString(thread.id);
    if (!threadId) continue;
    const firstComment = asNodes(thread.comments)[0];
    const reviewId = firstComment ? asString(asRecord(firstComment.pullRequestReview).id) : "";
    if (!reviewId) continue;
    const threadIds = index.get(reviewId);
    if (threadIds) threadIds.push(threadId);
    else index.set(reviewId, [threadId]);
  }
  return index;
}

function parseTimeline(value: unknown, threadIndex: Map<string, string[]>): PrTimelineItem[] {
  const items: PrTimelineItem[] = [];
  let pendingCommits: PrCommit[] = [];
  let pendingActor = "";
  const flushCommits = (): void => {
    if (pendingCommits.length === 0) return;
    items.push({ kind: "commits", at: pendingCommits[pendingCommits.length - 1].committedAt, actor: pendingActor, commits: pendingCommits });
    pendingCommits = [];
    pendingActor = "";
  };
  for (const node of asNodes(value)) {
    const typename = asString(node.__typename);
    if (typename === "PullRequestCommit") {
      const commit = parseCommitNode(node);
      if (!commit.oid) continue;
      pendingCommits.push(commit);
      pendingActor = commit.author;
      continue;
    }
    flushCommits();
    if (typename === "PullRequestReview") {
      const state = asString(node.state);
      if (!REVIEW_TIMELINE_STATES.has(state)) continue;
      items.push({
        kind: "review",
        at: asEpochMs(node.createdAt),
        actor: asString(asRecord(node.author).login),
        state: state as "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED",
        body: asString(node.body),
        threadIds: threadIndex.get(asString(node.id)) ?? []
      });
    } else if (typename === "IssueComment") {
      items.push({ kind: "comment", at: asEpochMs(node.createdAt), actor: asString(asRecord(node.author).login), body: asString(node.body) });
    } else if (typename === "ReviewRequestedEvent") {
      items.push({ kind: "review_requested", at: asEpochMs(node.createdAt), actor: actorLogin(node), reviewer: asString(asRecord(node.requestedReviewer).login) });
    } else if (typename in TIMELINE_EVENT_KINDS) {
      items.push({ kind: TIMELINE_EVENT_KINDS[typename], at: asEpochMs(node.createdAt), actor: actorLogin(node) });
    }
  }
  flushCommits();
  return items;
}

export interface PrHeadInfo {
  headRefOid: string | null;
  state: PrSummary["state"] | null;
  updatedAt: number | null;
}

export function parseHead(json: string): PrHeadInfo {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { headRefOid: null, state: null, updatedAt: null };
  }
  const pr = asRecord(asRecord(asRecord(root.data).repository).pullRequest);
  const state = asString(pr.state);
  return {
    headRefOid: asString(pr.headRefOid) || null,
    state: state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : null,
    updatedAt: asEpochMs(pr.updatedAt) || null
  };
}

export function parseDetail(json: string, viewer: string): PrDetail | null {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pr = asRecord(asRecord(asRecord(root.data).repository).pullRequest);
  if (Object.keys(pr).length === 0) return null;
  const summary = parseSummaryNode({ ...pr, reviewThreads: pr.threads }, viewer || null);
  if (!summary) return null;
  return {
    ...summary,
    body: asString(pr.body),
    createdAt: asEpochMs(pr.createdAt),
    timeline: parseTimeline(pr.timelineItems, threadReviewIndex(pr.threads)),
    threads: parseThreads(pr.threads),
    checkRuns: parseCheckRuns(pr.checkRunCommits),
    commits: asNodes(pr.commits).map(parseCommitNode).filter((commit) => commit.oid),
    reviewers: parseReviewers(pr.latestReviews),
    viewerLogin: viewer
  };
}
