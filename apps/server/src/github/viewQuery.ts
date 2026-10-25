import type {
  GitHubKind,
  GitHubTabBadge,
  IssueSummary,
  PrSummary,
  ProjectGitHubRepo,
  RepoRef,
  RunRef,
  SessionMeta,
  WorkflowRunSummary
} from "@cw-code/contracts";
import {
  DEFAULT_REMOTE_SORT,
  DEFAULT_RUN_SORT,
  ME,
  RUN_SORTS,
  definitionOf,
  isStateToken,
  joinTokens,
  lowerValue,
  normalizeQuery,
  sortKeysFor,
  tokenProblem,
  tokenize,
  uniqueBy,
  type QueryToken
} from "@cw-code/shared/githubQueryDsl";
import { BUILTIN_VIEWS } from "@cw-code/shared/githubViews";
import {
  involvesViewer,
  isRunFailed,
  needsAttentionCount,
  sameLogin,
  sessionHasUnseenIssue,
  sessionHasUnseenPr,
  sessionsForIssue,
  sessionsForPr,
  sessionsForRun
} from "../prEngine/subjectRelations.js";
import { MAX_RUN_ORGS, MAX_RUN_REPOS } from "./runQueries.js";
import type { RunSources } from "./results.js";

export interface LocalFilter {
  key: "has" | "cloned" | "is";
  value: string;
  neg: boolean;
}

export interface SplitQuery {
  remote: string;
  countBase: string;
  local: LocalFilter[];
  sort: string;
}

export interface LocalContext {
  hasSession(item: PrSummary | IssueSummary): boolean;
  isCloned(repo: RepoRef): boolean;
  isUnread(item: PrSummary | IssueSummary): boolean;
}

export interface RunContext {
  viewer: string;
  involvedPrKeys: ReadonlySet<string>;
  isDefaultBranchRun(run: WorkflowRunSummary): boolean;
  hasSession(run: WorkflowRunSummary): boolean;
}

export type RunStatusKey = "failure" | "in_progress" | "queued" | "success" | "cancelled";

export type BadgeKind = "issue" | "run";

const OR_KEYS: ReadonlySet<string> = new Set(["repo", "org", "user", "author", "actor", "workflow", "branch", "event", "status"]);
const DEFAULT_HOST = "github.com";
const MENTION_KEYS: ReadonlySet<string> = new Set(["mentions", "involves"]);

const SCOPING_KEYS: ReadonlySet<string> = new Set([
  "author",
  "assignee",
  "involves",
  "mentions",
  "review-requested",
  "reviewed-by",
  "team-review-requested",
  "commenter",
  "org",
  "repo",
  "user",
  "head",
  "base"
]);
const SCOPE_QUALIFIER = "involves:@me";

function isLocalToken(t: QueryToken): boolean {
  if (t.kind !== "qual") return false;
  const value = lowerValue(t);
  if (t.key === "has") return value === "" || value === "session";
  if (t.key === "cloned") return true;
  return t.key === "is" && value === "unread";
}

function localFilterOf(t: QueryToken): LocalFilter | null {
  const value = lowerValue(t);
  if (t.key === "has" && value === "session") return { key: "has", value, neg: !!t.neg };
  if (t.key === "cloned" && (value === "true" || value === "false")) return { key: "cloned", value, neg: !!t.neg };
  if (t.key === "is" && value === "unread") return { key: "is", value, neg: !!t.neg };
  return null;
}

export function splitQuery(kind: "pr" | "issue", q: string): SplitQuery {
  const tokens = tokenize(q);
  const local: LocalFilter[] = [];
  const remoteTokens: QueryToken[] = [];
  let sort = DEFAULT_REMOTE_SORT;
  const validSorts = sortKeysFor(kind);
  for (const t of tokens) {
    if (t.kind === "space") continue;
    const invalidValue = t.kind === "qual" && !!t.key && !!definitionOf(kind, t.key) && !!tokenProblem(kind, t);
    if (t.kind === "qual" && (isLocalToken(t) || !t.value || invalidValue)) {
      const filter = localFilterOf(t);
      if (filter) local.push(filter);
      continue;
    }
    if (t.kind === "qual" && !t.neg && t.key === "sort" && validSorts.includes(lowerValue(t))) sort = lowerValue(t);
    remoteTokens.push(t);
  }
  return {
    remote: joinTokens(remoteTokens),
    countBase: joinTokens(remoteTokens.filter((t) => !isStateToken(t))),
    local,
    sort
  };
}

export function sortedRemoteOf(split: SplitQuery): string {
  const hasSort = tokenize(split.remote).some((t) => t.kind === "qual" && !t.neg && t.key === "sort");
  return hasSort ? split.remote : `${split.remote} sort:${split.sort}`.trim();
}

function scoped(query: string): string {
  const hasScope = tokenize(query).some((token) => token.kind === "qual" && !token.neg && SCOPING_KEYS.has(token.key ?? ""));
  return hasScope ? query : `${query} ${SCOPE_QUALIFIER}`.trim();
}

export function scopeSplitQuery(split: SplitQuery): SplitQuery {
  if (split.local.length === 0) return split;
  return { ...split, remote: scoped(split.remote), countBase: scoped(split.countBase) };
}

export function applyLocalFilters<T extends PrSummary | IssueSummary>(items: T[], filters: LocalFilter[], ctx: LocalContext): T[] {
  if (filters.length === 0) return items;
  return items.filter((item) =>
    filters.every((filter) => {
      const pass = localFilterPasses(item, filter, ctx);
      return filter.neg ? !pass : pass;
    })
  );
}

function localFilterPasses(item: PrSummary | IssueSummary, filter: LocalFilter, ctx: LocalContext): boolean {
  if (filter.key === "has") return ctx.hasSession(item);
  if (filter.key === "cloned") return ctx.isCloned(item.ref) === (filter.value === "true");
  return ctx.isUnread(item);
}

export function prKeyOf(repo: RepoRef, n: number): string {
  return `${repo.owner}/${repo.repo}#${n}`.toLowerCase();
}

export function runStatusOf(run: WorkflowRunSummary): RunStatusKey | null {
  if (run.status === "queued") return "queued";
  if (run.status === "in_progress") return "in_progress";
  switch (run.conclusion) {
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "success":
    case "neutral":
    case "skipped":
      return "success";
    default:
      return null;
  }
}

function loginFromQuery(value: string, viewer: string): string {
  if (value.toLowerCase() === ME) return viewer;
  if (value.toLowerCase().startsWith("app/")) return `${value.slice(4)}[bot]`;
  return value;
}

function matchesQueryLogin(login: string | null, value: string, viewer: string): boolean {
  return !!login && login.toLowerCase() === loginFromQuery(value, viewer).toLowerCase();
}

function runQualifierMatches(run: WorkflowRunSummary, key: string, value: string, ctx: RunContext): boolean {
  const lowered = value.toLowerCase();
  switch (key) {
    case "repo":
      return `${run.ref.owner}/${run.ref.repo}`.toLowerCase() === lowered;
    case "org":
      return run.ref.owner.toLowerCase() === lowered;
    case "workflow":
      return run.workflowName.toLowerCase() === lowered;
    case "branch":
      return run.branch === value;
    case "actor":
      return matchesQueryLogin(run.actor, value, ctx.viewer);
    case "event":
      return run.event.toLowerCase() === lowered;
    case "status":
      return runStatusOf(run) === lowered;
    case "involves":
      if (matchesQueryLogin(run.actor, value, ctx.viewer)) return true;
      if (loginFromQuery(value, ctx.viewer).toLowerCase() !== ctx.viewer.toLowerCase()) return false;
      if (run.prNumber !== null && ctx.involvedPrKeys.has(prKeyOf(run.ref, run.prNumber))) return true;
      return ctx.isDefaultBranchRun(run);
    case "has":
      return lowered === "session" && ctx.hasSession(run);
    default:
      return true;
  }
}

interface QualifierGroup {
  key: string;
  neg: boolean;
  values: string[];
}

export function runMatches(run: WorkflowRunSummary, q: string, ctx: RunContext): boolean {
  const groups = new Map<string, QualifierGroup>();
  const words: string[] = [];
  for (const t of tokenize(q)) {
    if (t.kind === "text") {
      words.push((t.value ?? "").toLowerCase());
      continue;
    }
    if (t.kind !== "qual" || !t.key || !t.value) continue;
    if (t.key === "sort" || t.key === "is" || tokenProblem("run", t)) continue;
    const id = `${t.neg ? "-" : ""}${t.key}`;
    const group = groups.get(id) ?? { key: t.key, neg: !!t.neg, values: [] };
    group.values.push(t.value);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    const test = (value: string) => runQualifierMatches(run, group.key, value, ctx);
    if (group.neg) {
      if (group.values.some(test)) return false;
    } else if (OR_KEYS.has(group.key)) {
      if (!group.values.some(test)) return false;
    } else if (!group.values.every(test)) {
      return false;
    }
  }
  if (words.length === 0) return true;
  const haystack = [run.title, run.workflowName, run.branch, `${run.ref.owner}/${run.ref.repo}`, `#${run.runNumber}`]
    .filter((part): part is string => !!part)
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function sortRuns(runs: WorkflowRunSummary[], sort: string): WorkflowRunSummary[] {
  const direction = (RUN_SORTS.includes(sort) ? sort : DEFAULT_RUN_SORT) === "created-asc" ? 1 : -1;
  return [...runs].sort((a, b) => direction * (a.createdAt - b.createdAt || a.ref.runId - b.ref.runId));
}

export function runSources(q: string, clonedRepos: RepoRef[]): RunSources {
  const tokens = tokenize(q).filter((t) => t.kind === "qual" && !t.neg && !!t.value);
  const orgs = uniqueBy(
    tokens.filter((t) => t.key === "org").map((t) => t.value ?? ""),
    (org) => org
  );
  const repoNames = uniqueBy(
    tokens.map((t) => (t.key === "repo" ? (t.value ?? "") : "")).filter((v) => /^[^/\s]+\/[^/\s]+$/.test(v)),
    (name) => name
  );

  if (orgs.length === 0 && repoNames.length === 0) {
    return {
      prSearchQuery: "is:pr is:open involves:@me archived:false",
      repos: uniqueBy(clonedRepos, (r) => `${r.host}/${r.owner}/${r.repo}`),
      orgs: []
    };
  }

  const repos = repoNames.map((name): RepoRef => {
    const [owner, repo] = name.split("/");
    const cloned = clonedRepos.find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase());
    return { host: cloned?.host ?? DEFAULT_HOST, owner, repo };
  });
  const scopes = [...orgs.map((org) => `org:${org}`), ...repoNames.map((name) => `repo:${name}`)];
  const archived = orgs.length > 0 ? " archived:false" : "";
  return { prSearchQuery: `is:pr is:open ${scopes.join(" ")}${archived}`, repos, orgs };
}

export function cappedRunSources(query: string, clonedRepos: RepoRef[]): RunSources {
  const sources = runSources(query, clonedRepos);
  return { ...sources, repos: sources.repos.slice(0, MAX_RUN_REPOS), orgs: sources.orgs.slice(0, MAX_RUN_ORGS) };
}

export function searchKey(kind: GitHubKind, query: string, clonedRepos: RepoRef[]): string {
  if (kind === "run") return `run:${JSON.stringify(cappedRunSources(query, clonedRepos))}`;
  return `${kind}:${normalizeQuery(scopeSplitQuery(splitQuery(kind, query)).remote)}`;
}

function builtinQuery(id: string): string {
  return BUILTIN_VIEWS.find((view) => view.id === id)?.query ?? "";
}

export const BADGE_KINDS: BadgeKind[] = ["issue", "run"];

export const BADGE_QUERIES: Record<BadgeKind, string> = {
  issue: builtinQuery("issue:inbox"),
  run: builtinQuery("run:watching")
};

export function badgeSearchKeys(clonedRepos: RepoRef[]): Record<BadgeKind, string> {
  return {
    issue: searchKey("issue", BADGE_QUERIES.issue, []),
    run: searchKey("run", BADGE_QUERIES.run, clonedRepos)
  };
}

export function involvedPrKeysOf(inboxItems: PrSummary[], cachedPrs: PrSummary[], viewer: string | null): Set<string> {
  const keys = new Set<string>();
  for (const pr of inboxItems) keys.add(prKeyOf(pr.ref, pr.ref.number));
  for (const pr of cachedPrs) {
    if (involvesViewer(pr, viewer)) keys.add(prKeyOf(pr.ref, pr.ref.number));
  }
  return keys;
}

export function isLiveRun(run: WorkflowRunSummary): boolean {
  return run.status === "queued" || run.status === "in_progress";
}

export function liveRunRefs(runs: WorkflowRunSummary[]): RunRef[] {
  return runs.filter(isLiveRun).map((run) => run.ref);
}

export function assignedOpenIssueCount(issues: IssueSummary[], viewer: string | null): number {
  return issues.filter((issue) => issue.state === "OPEN" && issue.assignees.some((login) => sameLogin(login, viewer))).length;
}

export function failingInvolvedRunCount(runs: WorkflowRunSummary[], context: RunContext): number {
  return runs.filter((run) => isRunFailed(run) && runMatches(run, "involves:@me", context)).length;
}

export function prBadge(inboxItems: PrSummary[]): GitHubTabBadge {
  return { count: needsAttentionCount(inboxItems), tone: "default" };
}

function isPr(item: PrSummary | IssueSummary): item is PrSummary {
  return "headRefName" in item;
}

export function buildLocalContext(sessions: SessionMeta[], isCloned: (repo: RepoRef) => boolean): LocalContext {
  return {
    hasSession: (item) => (isPr(item) ? sessionsForPr(item, sessions) : sessionsForIssue(item, sessions)).length > 0,
    isCloned,
    isUnread: (item) =>
      isPr(item) ? sessions.some((session) => sessionHasUnseenPr(item, session)) : sessions.some((session) => sessionHasUnseenIssue(item, session))
  };
}

export function buildRunContext(viewer: string | null, involvedPrKeys: ReadonlySet<string>, sessions: SessionMeta[]): RunContext {
  return {
    viewer: viewer ?? "",
    involvedPrKeys,
    isDefaultBranchRun: (run) => run.onDefaultBranch,
    hasSession: (run) => sessionsForRun(run, sessions).length > 0
  };
}

export function clonedReposOf(repos: ProjectGitHubRepo[]): RepoRef[] {
  return repos.filter((repo) => repo.host.toLowerCase() === DEFAULT_HOST).map((repo) => ({ host: repo.host, owner: repo.owner, repo: repo.repo }));
}

export function isClonedIn(repos: ProjectGitHubRepo[], ref: RepoRef): boolean {
  return repos.some((repo) => sameLogin(repo.host, ref.host) && sameLogin(repo.owner, ref.owner) && sameLogin(repo.repo, ref.repo));
}

export function mentionsMode(query: string): boolean {
  return tokenize(query).some((token) => token.kind === "qual" && !token.neg && MENTION_KEYS.has(token.key ?? "") && lowerValue(token) === ME);
}

export function viewSort(kind: GitHubKind, query: string): string {
  const valid = sortKeysFor(kind);
  let sort = kind === "run" ? DEFAULT_RUN_SORT : DEFAULT_REMOTE_SORT;
  for (const token of tokenize(query)) {
    if (token.kind === "qual" && !token.neg && token.key === "sort" && valid.includes(lowerValue(token))) sort = lowerValue(token);
  }
  return sort;
}

export function mergeRun(existing: WorkflowRunSummary, update: WorkflowRunSummary): WorkflowRunSummary {
  return { ...existing, status: update.status, conclusion: update.conclusion, jobs: update.jobs, updatedAt: update.updatedAt };
}

export function applyRunUpdates(runs: WorkflowRunSummary[], updates: ReadonlyMap<number, WorkflowRunSummary>): WorkflowRunSummary[] {
  if (!runs.some((run) => updates.has(run.ref.runId))) return runs;
  return runs.map((run) => {
    const update = updates.get(run.ref.runId);
    return update ? mergeRun(run, update) : run;
  });
}

export function reconcileRuns(incoming: WorkflowRunSummary[], known: Iterable<WorkflowRunSummary>): WorkflowRunSummary[] {
  const newest = new Map<number, WorkflowRunSummary>();
  for (const run of known) {
    const seen = newest.get(run.ref.runId);
    if (!seen || run.updatedAt > seen.updatedAt) newest.set(run.ref.runId, run);
  }
  return incoming.map((run) => {
    const latest = newest.get(run.ref.runId);
    return latest && latest.updatedAt > run.updatedAt ? mergeRun(run, latest) : run;
  });
}

function liveRank(run: WorkflowRunSummary): number {
  return run.status === "in_progress" ? 0 : 1;
}

function runRefKey(ref: RunRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.runId}`.toLowerCase();
}

export function watchedRunRefs(listings: WorkflowRunSummary[][], max: number): RunRef[] {
  const unique = new Map<string, WorkflowRunSummary>();
  for (const run of listings.flat()) {
    const key = runRefKey(run.ref);
    if (isLiveRun(run) && !unique.has(key)) unique.set(key, run);
  }
  return [...unique.values()]
    .map((run, index) => ({ run, index }))
    .sort((a, b) => liveRank(a.run) - liveRank(b.run) || b.run.updatedAt - a.run.updatedAt || a.index - b.index)
    .slice(0, max)
    .map(({ run }) => run.ref);
}
