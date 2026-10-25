import { DEFAULT_RUN_SORT, ME, RUN_SORTS, tokenProblem, tokenize } from "@cw-code/shared/githubQueryDsl";
import type { IssueSummary, PrSummary, RepoRef, WorkflowRunSummary } from "../cw.js";

export interface LocalFilter {
  key: "has" | "cloned" | "is";
  value: string;
  neg: boolean;
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

const OR_KEYS: ReadonlySet<string> = new Set(["repo", "org", "user", "author", "actor", "workflow", "branch", "event", "status"]);

export function applyLocalFilters<T extends PrSummary | IssueSummary>(items: T[], filters: LocalFilter[], ctx: LocalContext): T[] {
  if (filters.length === 0) return items;
  return items.filter((item) =>
    filters.every((filter) => {
      const pass = localFilterPasses(item, filter, ctx);
      return filter.neg ? !pass : pass;
    }),
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

function sameLogin(login: string | null, value: string, viewer: string): boolean {
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
      return sameLogin(run.actor, value, ctx.viewer);
    case "event":
      return run.event.toLowerCase() === lowered;
    case "status":
      return runStatusOf(run) === lowered;
    case "involves":
      if (sameLogin(run.actor, value, ctx.viewer)) return true;
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
