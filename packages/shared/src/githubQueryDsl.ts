import type { GitHubKind } from "@cw-code/contracts";

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

const TOKEN_RE = /\s+|-?[A-Za-z][\w-]*:(?:"[^"]*"?|\S*)|"[^"]*"?|\S+/g;
export const QUALIFIER_RE = /^(-?)([A-Za-z][\w-]*):([\s\S]*)$/;
const STATE_VALUES: ReadonlySet<string> = new Set(["open", "closed", "merged"]);
export const KIND_VALUES: ReadonlySet<string> = new Set(["pr", "issue", "run"]);
export const DEFAULT_REMOTE_SORT = "updated-desc";
export const DEFAULT_RUN_SORT = "created-desc";
export const ME = "@me";

export const SORT_LABELS: Record<string, string> = {
  "updated-desc": "Recently updated",
  "updated-asc": "Least recently updated",
  "created-desc": "Newest",
  "created-asc": "Oldest",
  "comments-desc": "Most commented",
};

const REMOTE_SORTS = ["updated-desc", "updated-asc", "created-desc", "created-asc", "comments-desc"];
export const RUN_SORTS = ["created-desc", "created-asc"];

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

export function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function joinTokens(tokens: QueryToken[]): string {
  return tokens
    .filter((t) => t.kind !== "space")
    .map((t) => t.text)
    .join(" ");
}

export function normalizeQuery(q: string): string {
  return joinTokens(tokenize(q));
}

export function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function freeText(key: string, description: string): QualifierDef {
  return { key, description, local: false };
}

const GITHUB_SEARCH_QUALIFIERS: QualifierDef[] = [
  freeText("created", "Created date, e.g. >2026-01-01"),
  freeText("updated", "Updated date, e.g. >2026-01-01"),
  freeText("closed", "Closed date, e.g. >2026-01-01"),
  freeText("comments", "Comment count, e.g. >10"),
  person("commenter", "Commented by"),
  { key: "in", description: "Search in", local: false, enumValues: options(["title", "body", "comments"]) },
  person("user", "Owned by user or org"),
  freeText("language", "Repository language"),
];

const GITHUB_PR_SEARCH_QUALIFIERS: QualifierDef[] = [
  freeText("head", "Head branch"),
  freeText("base", "Base branch"),
  freeText("merged", "Merged date, e.g. >2026-01-01"),
  freeText("team-review-requested", "Review requested from a team"),
];

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
      { value: "locked", description: "" },
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
  { key: "no", description: "Missing a field", local: false, enumValues: options(["label", "assignee", "milestone"]) },
  { key: "review", description: "Review decision", local: false, enumValues: options(["approved", "changes_requested", "required", "none"]) },
  { key: "status", description: "Checks", local: false, enumValues: options(["success", "failure", "pending"]) },
  { key: "draft", description: "Draft or ready", local: false, enumValues: BOOLEAN_VALUES },
  ARCHIVED_DEF,
  sortDef("pr"),
  ...GITHUB_SEARCH_QUALIFIERS,
  ...GITHUB_PR_SEARCH_QUALIFIERS,
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
      { value: "locked", description: "" },
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
  { key: "reason", description: "Close reason", local: false, enumValues: options(["completed", "not planned"]) },
  ARCHIVED_DEF,
  sortDef("issue"),
  ...GITHUB_SEARCH_QUALIFIERS,
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

export function definitionOf(kind: GitHubKind, key: string): QualifierDef | undefined {
  return QUALIFIERS_BY_KIND[kind].find((def) => def.key === key);
}

export function tokenProblem(kind: GitHubKind, token: QueryToken): string | null {
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

export function lowerValue(t: QueryToken): string {
  return (t.value ?? "").toLowerCase();
}

export function kindFromQuery(q: string): GitHubKind | null {
  let found: GitHubKind | null = null;
  for (const t of tokenize(q)) {
    if (t.kind === "qual" && !t.neg && t.key === "is" && KIND_VALUES.has(lowerValue(t))) {
      found = lowerValue(t) as GitHubKind;
    }
  }
  return found;
}

export function isStateToken(t: QueryToken): boolean {
  if (t.kind !== "qual" || t.neg) return false;
  return t.key === "state" || (t.key === "is" && STATE_VALUES.has(lowerValue(t)));
}

export function stateOf(q: string): "open" | "closed" | null {
  let state: "open" | "closed" | null = null;
  for (const t of tokenize(q)) {
    if (t.kind !== "qual" || t.neg) continue;
    const value = lowerValue(t);
    if (t.key === "state" && (value === "open" || value === "closed")) state = value;
    if (t.key === "is" && value === "open") state = "open";
    if (t.key === "is" && (value === "closed" || value === "merged")) state = "closed";
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
