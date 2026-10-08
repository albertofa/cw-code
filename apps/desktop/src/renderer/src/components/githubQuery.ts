import type { GitHubKind, IssueSummary, PrSummary, RepoRef, RunSources, WorkflowRunSummary } from "../cw.js";

export interface QueryToken {
  kind: "space" | "text" | "qual";
  text: string;
  start: number;
  end: number;
  neg?: boolean;
  key?: string;
  rawKey?: string;
  value?: string;
  rawValue?: string;
}

export interface QualifierDef {
  key: string;
  description: string;
  local: boolean;
  enumValues?: Array<{ value: string; description: string; local?: boolean }>;
  valueSource?: "people" | "repo" | "org" | "label" | "milestone" | "workflow" | "branch";
  excludeLabel?: string;
}

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
  hasSession(run: WorkflowRunSummary): boolean;
}

export interface SuggestionSource {
  viewer: string | null;
  people: string[];
  repos: string[];
  orgs: string[];
  labels: string[];
  milestones: string[];
  workflows: string[];
  branches: string[];
}

export interface AutocompleteItem {
  kind: "key" | "value" | "exclude";
  key: string;
  neg: boolean;
  value?: string;
  label: string;
  description: string;
  local: boolean;
  avatarLogin?: string;
  labelColor?: string;
}

export interface AutocompleteResult {
  tokenStart: number;
  tokenEnd: number;
  heading: string | null;
  items: AutocompleteItem[];
  empty: string | null;
  invalid: boolean;
}

export type RunStatusKey = "failure" | "in_progress" | "queued" | "success" | "cancelled";

const TOKEN_RE = /\s+|-?[A-Za-z][\w-]*:(?:"[^"]*"?|\S*)|"[^"]*"?|\S+/g;
const QUALIFIER_RE = /^(-?)([A-Za-z][\w-]*):([\s\S]*)$/;
const OR_KEYS: ReadonlySet<string> = new Set(["repo", "org", "user", "author", "actor", "workflow", "branch", "event", "status"]);
const STATE_VALUES: ReadonlySet<string> = new Set(["open", "closed", "merged"]);
const KIND_VALUES: ReadonlySet<string> = new Set(["pr", "issue", "run"]);
const DEFAULT_REMOTE_SORT = "updated-desc";
const DEFAULT_RUN_SORT = "created-desc";
const DEFAULT_HOST = "github.com";
const ME = "@me";

const KIND_NOUN: Record<GitHubKind, string> = { pr: "pull requests", issue: "issues", run: "workflow runs" };

export const SORT_LABELS: Record<string, string> = {
  "updated-desc": "Recently updated",
  "updated-asc": "Least recently updated",
  "created-desc": "Newest",
  "created-asc": "Oldest",
  "comments-desc": "Most commented",
};

const REMOTE_SORTS = ["updated-desc", "updated-asc", "created-desc", "created-asc", "comments-desc"];
const RUN_SORTS = ["created-desc", "created-asc"];

export function sortKeysFor(kind: GitHubKind): string[] {
  return kind === "run" ? RUN_SORTS : REMOTE_SORTS;
}

export function tokenize(q: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const match of q.matchAll(TOKEN_RE)) {
    const text = match[0];
    const start = match.index ?? 0;
    const end = start + text.length;
    if (/^\s+$/.test(text)) {
      tokens.push({ kind: "space", text, start, end });
      continue;
    }
    const qual = QUALIFIER_RE.exec(text);
    if (qual) {
      tokens.push({
        kind: "qual",
        text,
        start,
        end,
        neg: qual[1] === "-",
        key: qual[2].toLowerCase(),
        rawKey: qual[2],
        value: unquote(qual[3]),
        rawValue: qual[3],
      });
    } else {
      tokens.push({ kind: "text", text, start, end, value: unquote(text) });
    }
  }
  return tokens;
}

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "");
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function joinTokens(tokens: QueryToken[]): string {
  return tokens
    .filter((t) => t.kind !== "space")
    .map((t) => t.text)
    .join(" ");
}

export function normalizeQuery(q: string): string {
  return joinTokens(tokenize(q));
}

const options = (values: string[], description = ""): Array<{ value: string; description: string }> =>
  values.map((value) => ({ value, description }));

const BOOLEAN_VALUES = options(["true", "false"]);

function sortDef(kind: GitHubKind): QualifierDef {
  return {
    key: "sort",
    description: "Sort order",
    local: false,
    enumValues: sortKeysFor(kind).map((value) => ({ value, description: SORT_LABELS[value] ?? "" })),
  };
}

const REPO_DEF: QualifierDef = { key: "repo", description: "In repository", local: false, valueSource: "repo", excludeLabel: "Exclude repo" };
const ORG_DEF: QualifierDef = { key: "org", description: "In organization", local: false, valueSource: "org", excludeLabel: "Exclude org" };
const ARCHIVED_DEF: QualifierDef = { key: "archived", description: "Archived repos", local: false, enumValues: options(["false", "true"]) };
const HAS_DEF: QualifierDef = {
  key: "has",
  description: "Has a cw session",
  local: true,
  enumValues: [{ value: "session", description: "linked cw session", local: true }],
};
const CLONED_DEF: QualifierDef = { key: "cloned", description: "Repo cloned locally", local: true, enumValues: BOOLEAN_VALUES };
const LABEL_DEF: QualifierDef = { key: "label", description: "Has label", local: false, valueSource: "label", excludeLabel: "Exclude label" };

function person(key: string, description: string): QualifierDef {
  return { key, description, local: false, valueSource: "people" };
}

const PR_QUALIFIERS: QualifierDef[] = [
  {
    key: "is",
    description: "Type or state",
    local: false,
    enumValues: [
      { value: "pr", description: "pull requests" },
      { value: "issue", description: "switch to Issues" },
      { value: "run", description: "switch to Actions" },
      { value: "open", description: "" },
      { value: "closed", description: "" },
      { value: "merged", description: "" },
      { value: "draft", description: "" },
      { value: "unread", description: "updated since you looked", local: true },
    ],
  },
  { key: "state", description: "open or closed", local: false, enumValues: [{ value: "open", description: "" }, { value: "closed", description: "includes merged" }] },
  person("author", "Opened by"),
  person("assignee", "Assigned to"),
  person("review-requested", "Review requested from"),
  person("reviewed-by", "Reviewed by"),
  person("involves", "Author, assignee, reviewer or mentioned"),
  person("mentions", "Mentions a user"),
  REPO_DEF,
  ORG_DEF,
  LABEL_DEF,
  { key: "no", description: "Missing a field", local: false, enumValues: options(["label", "assignee", "reviewers"]) },
  { key: "review", description: "Review decision", local: false, enumValues: options(["approved", "changes_requested", "required", "none"]) },
  { key: "status", description: "Checks", local: false, enumValues: options(["success", "failure", "pending"]) },
  { key: "draft", description: "Draft or ready", local: false, enumValues: BOOLEAN_VALUES },
  ARCHIVED_DEF,
  sortDef("pr"),
  HAS_DEF,
  CLONED_DEF,
];

const ISSUE_QUALIFIERS: QualifierDef[] = [
  {
    key: "is",
    description: "Type or state",
    local: false,
    enumValues: [
      { value: "issue", description: "issues" },
      { value: "pr", description: "switch to Pull requests" },
      { value: "run", description: "switch to Actions" },
      { value: "open", description: "" },
      { value: "closed", description: "" },
      { value: "unread", description: "updated since you looked", local: true },
    ],
  },
  { key: "state", description: "open or closed", local: false, enumValues: options(["open", "closed"]) },
  person("author", "Opened by"),
  person("assignee", "Assigned to"),
  person("mentions", "Mentions a user"),
  person("involves", "Author, assignee or mentioned"),
  REPO_DEF,
  ORG_DEF,
  LABEL_DEF,
  { key: "no", description: "Missing a field", local: false, enumValues: options(["label", "assignee", "milestone"]) },
  { key: "milestone", description: "In milestone", local: false, valueSource: "milestone" },
  { key: "linked", description: "Linked to a PR", local: false, enumValues: [{ value: "pr", description: "has a linked pull request" }] },
  { key: "reason", description: "Close reason", local: false, enumValues: options(["completed", "not_planned"]) },
  ARCHIVED_DEF,
  sortDef("issue"),
  HAS_DEF,
  CLONED_DEF,
];

const RUN_QUALIFIERS: QualifierDef[] = [
  {
    key: "is",
    description: "Type",
    local: false,
    enumValues: [
      { value: "run", description: "workflow runs" },
      { value: "pr", description: "switch to Pull requests" },
      { value: "issue", description: "switch to Issues" },
    ],
  },
  REPO_DEF,
  ORG_DEF,
  { key: "workflow", description: "Workflow name", local: false, valueSource: "workflow" },
  { key: "branch", description: "Head branch", local: false, valueSource: "branch" },
  person("actor", "Triggered by"),
  { key: "event", description: "Trigger event", local: false, enumValues: options(["push", "pull_request", "schedule", "workflow_dispatch"]) },
  { key: "status", description: "Run status", local: false, enumValues: options(["failure", "in_progress", "queued", "success", "cancelled"]) },
  { key: "involves", description: "Your actor, PRs or default branch", local: false, enumValues: [{ value: ME, description: "you" }] },
  sortDef("run"),
  HAS_DEF,
];

const QUALIFIERS_BY_KIND: Record<GitHubKind, QualifierDef[]> = {
  pr: PR_QUALIFIERS,
  issue: ISSUE_QUALIFIERS,
  run: RUN_QUALIFIERS,
};

export function qualifiersFor(kind: GitHubKind): QualifierDef[] {
  return QUALIFIERS_BY_KIND[kind];
}

function definitionOf(kind: GitHubKind, key: string): QualifierDef | undefined {
  return QUALIFIERS_BY_KIND[kind].find((def) => def.key === key);
}

function tokenProblem(kind: GitHubKind, token: QueryToken): string | null {
  if (token.kind !== "qual" || !token.key) return null;
  const def = definitionOf(kind, token.key);
  if (!def) return `Unknown qualifier ${token.key}:`;
  const value = token.value ?? "";
  if (value && def.enumValues && !def.enumValues.some((o) => o.value === value.toLowerCase())) {
    return `${value} isn't a valid value for ${token.key}:`;
  }
  return null;
}

export function queryProblems(kind: GitHubKind, q: string): string[] {
  const problems: string[] = [];
  for (const token of tokenize(q)) {
    const problem = tokenProblem(kind, token);
    if (problem && !problems.includes(problem)) problems.push(problem);
  }
  return problems;
}

export function kindFromQuery(q: string): GitHubKind | null {
  let found: GitHubKind | null = null;
  for (const t of tokenize(q)) {
    if (t.kind === "qual" && !t.neg && t.key === "is" && t.value && KIND_VALUES.has(t.value)) {
      found = t.value as GitHubKind;
    }
  }
  return found;
}

function isStateToken(t: QueryToken): boolean {
  if (t.kind !== "qual" || t.neg) return false;
  return t.key === "state" || (t.key === "is" && STATE_VALUES.has(t.value ?? ""));
}

function isLocalToken(t: QueryToken): boolean {
  if (t.kind !== "qual") return false;
  const value = t.value ?? "";
  if (t.key === "has") return value === "" || value === "session";
  if (t.key === "cloned") return true;
  return t.key === "is" && value === "unread";
}

function localFilterOf(t: QueryToken): LocalFilter | null {
  const value = (t.value ?? "").toLowerCase();
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
    if (t.kind === "qual" && (isLocalToken(t) || !t.value)) {
      const filter = localFilterOf(t);
      if (filter) local.push(filter);
      continue;
    }
    if (t.kind === "qual" && !t.neg && t.key === "sort" && t.value && validSorts.includes(t.value)) sort = t.value;
    remoteTokens.push(t);
  }
  return {
    remote: joinTokens(remoteTokens),
    countBase: joinTokens(remoteTokens.filter((t) => !isStateToken(t))),
    local,
    sort,
  };
}

export function stateOf(q: string): "open" | "closed" | null {
  let state: "open" | "closed" | null = null;
  for (const t of tokenize(q)) {
    if (t.kind !== "qual" || t.neg) continue;
    if (t.key === "state" && (t.value === "open" || t.value === "closed")) state = t.value;
    if (t.key === "is" && t.value === "open") state = "open";
    if (t.key === "is" && (t.value === "closed" || t.value === "merged")) state = "closed";
  }
  return state;
}

export function withState(q: string, state: "open" | "closed"): string {
  const base = joinTokens(tokenize(q).filter((t) => !isStateToken(t)));
  return `${base} state:${state}`.trim();
}

export function withQualifier(q: string, key: string, value: string | null): string {
  const base = joinTokens(tokenize(q).filter((t) => !(t.kind === "qual" && !t.neg && t.key === key)));
  return value ? `${base} ${key}:${quoteIfNeeded(value)}`.trim() : base;
}

export function addQualifier(q: string, key: string, value: string): string {
  const exists = tokenize(q).some((t) => t.kind === "qual" && !t.neg && t.key === key && t.value === value);
  if (exists) return q;
  return `${q.trim()} ${key}:${quoteIfNeeded(value)}`.trim();
}

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

function queryLogin(login: string): string {
  return login.endsWith("[bot]") ? `app/${login.slice(0, -"[bot]".length)}` : login;
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
      return run.event === value;
    case "status":
      return runStatusOf(run) === lowered;
    case "involves":
      if (sameLogin(run.actor, value, ctx.viewer)) return true;
      if (loginFromQuery(value, ctx.viewer).toLowerCase() !== ctx.viewer.toLowerCase()) return false;
      return run.prNumber !== null && ctx.involvedPrKeys.has(prKeyOf(run.ref, run.prNumber));
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

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function runSources(q: string, clonedRepos: RepoRef[]): RunSources {
  const tokens = tokenize(q).filter((t) => t.kind === "qual" && !t.neg && !!t.value);
  const orgs = uniqueBy(
    tokens.filter((t) => t.key === "org").map((t) => t.value ?? ""),
    (org) => org,
  );
  const repoNames = uniqueBy(
    tokens.map((t) => (t.key === "repo" ? (t.value ?? "") : "")).filter((v) => /^[^/\s]+\/[^/\s]+$/.test(v)),
    (name) => name,
  );

  if (orgs.length === 0 && repoNames.length === 0) {
    return {
      prSearchQuery: "is:pr is:open involves:@me archived:false",
      repos: uniqueBy(clonedRepos, (r) => `${r.host}/${r.owner}/${r.repo}`),
      orgs: [],
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

function hueOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function labelColorOf(label: string): string {
  return `hsl(${hueOf(label)},55%,58%)`;
}

interface ValueOption {
  value: string;
  description: string;
  local?: boolean;
  avatarLogin?: string;
  labelColor?: string;
}

function peopleOptions(source: SuggestionSource): ValueOption[] {
  const viewer = source.viewer;
  const others = uniqueBy(
    source.people.filter((login) => login && login.toLowerCase() !== viewer?.toLowerCase()),
    (login) => login,
  ).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const me: ValueOption = { value: ME, description: "you", ...(viewer ? { avatarLogin: viewer } : {}) };
  return [
    me,
    ...others.map((login) => ({
      value: queryLogin(login),
      description: login.endsWith("[bot]") ? "app" : "",
      avatarLogin: login,
    })),
  ];
}

function plainOptions(values: string[]): ValueOption[] {
  return uniqueBy(values.filter(Boolean), (v) => v)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((value) => ({ value, description: "" }));
}

function valueOptions(def: QualifierDef, source: SuggestionSource): ValueOption[] {
  if (def.enumValues) {
    return def.enumValues.map((o) => ({
      value: o.value,
      description: o.description,
      local: o.local ?? def.local,
      ...(o.value === ME && source.viewer ? { avatarLogin: source.viewer } : {}),
    }));
  }
  switch (def.valueSource) {
    case "people":
      return peopleOptions(source);
    case "repo":
      return plainOptions(source.repos);
    case "org":
      return plainOptions(source.orgs);
    case "label":
      return plainOptions(source.labels).map((o) => ({ ...o, labelColor: labelColorOf(o.value) }));
    case "milestone":
      return plainOptions(source.milestones);
    case "workflow":
      return plainOptions(source.workflows);
    case "branch":
      return plainOptions(source.branches);
    default:
      return [];
  }
}

function tokenAtCaret(q: string, caret: number): QueryToken {
  const found = tokenize(q).find((t) => t.kind !== "space" && t.start < caret && caret <= t.end);
  return found ?? { kind: "text", text: "", start: caret, end: caret, value: "" };
}

export function autocomplete(kind: GitHubKind, q: string, caret: number, source: SuggestionSource): AutocompleteResult {
  const token = tokenAtCaret(q, caret);
  const base = { tokenStart: token.start, tokenEnd: token.end };
  const typed = q.slice(token.start, caret);
  const qualifier = QUALIFIER_RE.exec(typed);

  if (qualifier) {
    const neg = qualifier[1] === "-";
    const key = qualifier[2].toLowerCase();
    const partial = qualifier[3].replace(/^"/, "").toLowerCase();
    const def = definitionOf(kind, key);
    if (!def) {
      return { ...base, heading: null, items: [], empty: `Unknown qualifier “${key}:” for ${KIND_NOUN[kind]}`, invalid: true };
    }
    const items: AutocompleteItem[] = [];
    if (def.excludeLabel && !neg && !partial) {
      items.push({ kind: "exclude", key, neg: false, label: def.excludeLabel, description: "", local: false });
    }
    for (const option of valueOptions(def, source)) {
      if (!option.value.toLowerCase().includes(partial)) continue;
      items.push({
        kind: "value",
        key,
        neg,
        value: option.value,
        label: option.value,
        description: option.description,
        local: option.local ?? false,
        ...(option.avatarLogin ? { avatarLogin: option.avatarLogin } : {}),
        ...(option.labelColor ? { labelColor: option.labelColor } : {}),
      });
    }
    const empty = items.length > 0 ? null : partial ? `No values match “${partial}”` : `No suggestions for ${key}:`;
    return { ...base, heading: `${neg ? "exclude " : ""}${key}`, items, empty, invalid: false };
  }

  const neg = typed.startsWith("-");
  const partial = typed.replace(/^-/, "").toLowerCase();
  const items: AutocompleteItem[] = qualifiersFor(kind)
    .filter((def) => def.key.startsWith(partial))
    .map((def) => ({
      kind: "key" as const,
      key: def.key,
      neg,
      label: `${neg ? "-" : ""}${def.key}:`,
      description: def.description,
      local: def.local,
    }));
  if (partial && items.length === 0) {
    return { ...base, heading: null, items, empty: `Searching titles for “${typed}”`, invalid: false };
  }
  return { ...base, heading: partial ? null : "Qualifiers", items, empty: null, invalid: false };
}

export function applyAutocomplete(
  q: string,
  result: AutocompleteResult,
  item: AutocompleteItem,
  currentKind: GitHubKind,
): { query: string; caret: number; reopen: boolean; switchKind: GitHubKind | null } {
  const before = q.slice(0, result.tokenStart);
  const after = q.slice(result.tokenEnd);
  const prefix = item.neg ? "-" : "";
  let replacement: string;
  let reopen = false;
  if (item.kind === "key") {
    replacement = `${prefix}${item.key}:`;
    reopen = true;
  } else if (item.kind === "exclude") {
    replacement = `-${item.key}:`;
    reopen = true;
  } else {
    const trailing = /^\s/.test(after) ? "" : " ";
    replacement = `${prefix}${item.key}:${quoteIfNeeded(item.value ?? "")}${trailing}`;
  }
  const value = item.value ?? "";
  const switchKind =
    item.kind === "value" && item.key === "is" && !item.neg && KIND_VALUES.has(value) && value !== currentKind
      ? (value as GitHubKind)
      : null;
  return {
    query: before + replacement + after,
    caret: (before + replacement).length,
    reopen: reopen && switchKind === null,
    switchKind,
  };
}
