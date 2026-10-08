import type {
  GitHubKind,
  GitHubViewGroup,
  IssueSummary,
  PrSummary,
  ProjectGitHubRepo,
  RepoRef,
  RunRef,
  WorkflowRunSummary
} from "../cw.js";
import type { GitHubView } from "../stores/githubStore.js";
import {
  normalizeQuery,
  prKeyOf,
  runMatches,
  sortKeysFor,
  tokenize,
  type LocalContext,
  type RunContext,
  type SuggestionSource
} from "./githubQuery.js";
import {
  isRunFailed,
  sameLogin,
  sessionHasUnseenIssue,
  sessionHasUnseenPr,
  sessionsForIssue,
  sessionsForPr,
  sessionsForRun,
  type LinkedSession
} from "./githubRowModel.js";
import { needsAttentionCount } from "./prInbox.js";

export type BucketTone = "info" | "warn" | "ok" | "neutral" | "bad" | "merged";

export interface BucketDef {
  id: string;
  title: string;
  icon: string;
  tone: BucketTone;
  hint: string;
}

export interface ResultGroup<T> {
  id: string;
  title: string;
  icon: string;
  tone: BucketTone;
  hint: string;
  flat: boolean;
  items: T[];
}

export interface TabBadge {
  count: number;
  tone: "default" | "quiet" | "bad";
}

export const PR_BUCKETS: BucketDef[] = [
  { id: "review", title: "Needs your review", icon: "Eye", tone: "info", hint: "review requested from you" },
  { id: "action", title: "Your PRs · needs action", icon: "TriangleAlert", tone: "warn", hint: "failing checks · changes requested · conflicts" },
  { id: "ready", title: "Ready to merge", icon: "GitMerge", tone: "ok", hint: "approved + green" },
  { id: "waiting", title: "Waiting", icon: "Clock", tone: "neutral", hint: "draft or awaiting reviewers" },
  { id: "merged", title: "Merged", icon: "GitMerge", tone: "merged", hint: "" },
  { id: "closed", title: "Closed", icon: "GitPullRequestClosed", tone: "bad", hint: "not merged" }
];

export const ISSUE_BUCKETS: BucketDef[] = [
  { id: "assigned", title: "Assigned to you", icon: "UserCheck", tone: "info", hint: "" },
  { id: "mentioned", title: "Mentions", icon: "AtSign", tone: "warn", hint: "" },
  { id: "created", title: "Created by you", icon: "Pencil", tone: "neutral", hint: "" },
  { id: "other", title: "Other", icon: "CircleDot", tone: "neutral", hint: "not involving you" },
  { id: "closed", title: "Closed", icon: "CircleCheckBig", tone: "merged", hint: "" }
];

export const RUN_BUCKETS: BucketDef[] = [
  { id: "failing", title: "Failing", icon: "CircleX", tone: "bad", hint: "" },
  { id: "running", title: "In progress", icon: "Loader", tone: "warn", hint: "running or queued" },
  { id: "recent", title: "Recent", icon: "History", tone: "neutral", hint: "" }
];

export const GROUP_LABELS: Record<GitHubKind, string> = { pr: "Triage", issue: "Involvement", run: "Status" };

export const KIND_LABELS: Record<GitHubKind, string> = { pr: "Pull requests", issue: "Issues", run: "Actions" };

export const KIND_NOUNS: Record<GitHubKind, string> = { pr: "pull requests", issue: "issues", run: "workflow runs" };

export const KIND_ORDER: GitHubKind[] = ["pr", "issue", "run"];

const DEFAULT_REMOTE_SORT = "updated-desc";
const DEFAULT_RUN_SORT = "created-desc";
const REPO_GROUP_ICON = "BookMarked";

export function repoNameOf(ref: { owner: string; repo: string }): string {
  return `${ref.owner}/${ref.repo}`;
}

export function groupItems<T>(
  items: T[],
  mode: GitHubViewGroup,
  options: { buckets: BucketDef[]; bucketOf(item: T): string; repoOf(item: T): RepoRef; isCloned(repo: RepoRef): boolean }
): ResultGroup<T>[] {
  if (mode === "none") {
    return [{ id: "all", title: "", icon: "", tone: "neutral", hint: "", flat: true, items }];
  }
  if (mode === "repo") {
    const byRepo = new Map<string, { repo: RepoRef; items: T[] }>();
    for (const item of items) {
      const repo = options.repoOf(item);
      const name = repoNameOf(repo);
      const entry = byRepo.get(name);
      if (entry) entry.items.push(item);
      else byRepo.set(name, { repo, items: [item] });
    }
    return [...byRepo.entries()].map(([name, entry]) => ({
      id: `repo:${name}`,
      title: name,
      icon: REPO_GROUP_ICON,
      tone: "neutral",
      hint: options.isCloned(entry.repo) ? "cloned" : "",
      flat: false,
      items: entry.items
    }));
  }
  return options.buckets
    .map((bucket) => ({ ...bucket, flat: false, items: items.filter((item) => options.bucketOf(item) === bucket.id) }))
    .filter((group) => group.items.length > 0);
}

export function mentionsMode(query: string): boolean {
  return tokenize(query).some((token) => token.kind === "qual" && !token.neg && token.key === "mentions" && (token.value ?? "").toLowerCase() === "@me");
}

export function sortOf(kind: GitHubKind, query: string): string {
  const valid = sortKeysFor(kind);
  let sort = kind === "run" ? DEFAULT_RUN_SORT : DEFAULT_REMOTE_SORT;
  for (const token of tokenize(query)) {
    const value = (token.value ?? "").toLowerCase();
    if (token.kind === "qual" && !token.neg && token.key === "sort" && valid.includes(value)) sort = value;
  }
  return sort;
}

export function currentViewOf(views: GitHubView[], viewId: string | null): GitHubView | null {
  return viewId === null ? null : (views.find((view) => view.id === viewId) ?? null);
}

export function isViewEdited(view: GitHubView | null, query: string): boolean {
  return view === null || normalizeQuery(view.query) !== normalizeQuery(query);
}

export function isPr(item: PrSummary | IssueSummary): item is PrSummary {
  return "headRefName" in item;
}

export function buildLocalContext(sessions: LinkedSession[], isCloned: (repo: RepoRef) => boolean): LocalContext {
  return {
    hasSession: (item) => (isPr(item) ? sessionsForPr(item, sessions) : sessionsForIssue(item, sessions)).length > 0,
    isCloned,
    isUnread: (item) =>
      isPr(item) ? sessions.some((session) => sessionHasUnseenPr(item, session)) : sessions.some((session) => sessionHasUnseenIssue(item, session))
  };
}

export function involvesViewer(pr: PrSummary, viewer: string | null): boolean {
  return (
    pr.viewerIsAuthor ||
    pr.reviewRequestedFromViewer ||
    pr.assignees.some((login) => sameLogin(login, viewer)) ||
    pr.reviewers.some((reviewer) => sameLogin(reviewer.login, viewer))
  );
}

export function involvedPrKeysOf(inboxItems: PrSummary[], cachedPrs: PrSummary[], viewer: string | null): Set<string> {
  const keys = new Set<string>();
  for (const pr of inboxItems) keys.add(prKeyOf(pr.ref, pr.ref.number));
  for (const pr of cachedPrs) {
    if (involvesViewer(pr, viewer)) keys.add(prKeyOf(pr.ref, pr.ref.number));
  }
  return keys;
}

export function buildRunContext(viewer: string | null, involvedPrKeys: ReadonlySet<string>, sessions: LinkedSession[]): RunContext {
  return {
    viewer: viewer ?? "",
    involvedPrKeys,
    isDefaultBranchRun: (run) => run.onDefaultBranch,
    hasSession: (run) => sessionsForRun(run, sessions).length > 0
  };
}

export function isLiveRun(run: WorkflowRunSummary): boolean {
  return run.status === "queued" || run.status === "in_progress";
}

export function liveRunRefs(runs: WorkflowRunSummary[]): RunRef[] {
  return runs.filter(isLiveRun).map((run) => run.ref);
}

export function runRefsSignature(refs: RunRef[]): string {
  return refs.map((ref) => `${ref.host}/${ref.owner}/${ref.repo}#${ref.runId}`).join("|");
}

export function assignedOpenIssueCount(issues: IssueSummary[], viewer: string | null): number {
  return issues.filter((issue) => issue.state === "OPEN" && issue.assignees.some((login) => sameLogin(login, viewer))).length;
}

export function failingInvolvedRunCount(runs: WorkflowRunSummary[], context: RunContext): number {
  return runs.filter((run) => isRunFailed(run) && runMatches(run, "involves:@me", context)).length;
}

export function prBadge(inboxItems: PrSummary[]): TabBadge {
  return { count: needsAttentionCount(inboxItems), tone: "default" };
}

export interface SuggestionInputs {
  viewer: string | null;
  prs: PrSummary[];
  issues: IssueSummary[];
  runs: WorkflowRunSummary[];
  repos: ProjectGitHubRepo[];
}

export function buildSuggestionSource({ viewer, prs, issues, runs, repos }: SuggestionInputs): SuggestionSource {
  const people = new Set<string>();
  const repoNames = new Set<string>();
  const labels = new Set<string>();
  const milestones = new Set<string>();
  const workflows = new Set<string>();
  const branches = new Set<string>();
  const addPerson = (login: string | null | undefined) => {
    if (login) people.add(login);
  };

  for (const repo of repos) repoNames.add(repoNameOf(repo));
  for (const pr of prs) {
    addPerson(pr.author.login);
    pr.assignees.forEach(addPerson);
    pr.reviewers.forEach((reviewer) => addPerson(reviewer.login));
    pr.labels.forEach((label) => labels.add(label));
    repoNames.add(repoNameOf(pr.ref));
  }
  for (const issue of issues) {
    addPerson(issue.author.login);
    issue.assignees.forEach(addPerson);
    issue.labels.forEach((label) => labels.add(label));
    if (issue.milestone) milestones.add(issue.milestone);
    repoNames.add(repoNameOf(issue.ref));
  }
  for (const run of runs) {
    addPerson(run.actor);
    workflows.add(run.workflowName);
    if (run.branch) branches.add(run.branch);
    repoNames.add(repoNameOf(run.ref));
  }

  const names = [...repoNames];
  return {
    viewer,
    people: [...people],
    repos: names,
    orgs: [...new Set(names.map((name) => name.split("/")[0]))],
    labels: [...labels],
    milestones: [...milestones],
    workflows: [...workflows],
    branches: [...branches]
  };
}
