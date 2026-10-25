import type { GitHubKind, GitHubViewGroup, SavedGitHubView } from "@cw-code/contracts";
import { normalizeQuery } from "@cw-code/shared/githubQueryDsl";
import { MAX_QUERY_LENGTH, MAX_SAVED_VIEWS, MAX_VIEW_NAME_LENGTH } from "@cw-code/shared/githubViews";

export interface SaveViewInput {
  kind: GitHubKind;
  name: string;
  query: string;
  group: GitHubViewGroup;
}

const KINDS: ReadonlySet<string> = new Set<GitHubKind>(["pr", "issue", "run"]);
const GROUPS: ReadonlySet<string> = new Set<GitHubViewGroup>(["triage", "repo", "none"]);

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-argument" });
}

export function isGitHubKind(value: unknown): value is GitHubKind {
  return typeof value === "string" && KINDS.has(value);
}

export function assertGitHubKind(value: unknown): asserts value is GitHubKind {
  if (!isGitHubKind(value)) throw invalid("kind must be pr, issue or run");
}

export function assertViewGroup(value: unknown): asserts value is GitHubViewGroup {
  if (typeof value !== "string" || !GROUPS.has(value)) throw invalid("group must be triage, repo or none");
}

export function viewName(value: unknown): string {
  if (typeof value !== "string") throw invalid("View name must be a string");
  const name = value.trim();
  if (!name) throw invalid("View name cannot be empty");
  if (name.length > MAX_VIEW_NAME_LENGTH) throw invalid(`View name is limited to ${MAX_VIEW_NAME_LENGTH} characters`);
  return name;
}

function viewQuery(value: unknown): string {
  if (typeof value !== "string") throw invalid("Query must be a string");
  const query = normalizeQuery(value);
  if (!query) throw invalid("Query cannot be empty");
  if (query.length > MAX_QUERY_LENGTH) throw invalid(`Query is limited to ${MAX_QUERY_LENGTH} characters`);
  return query;
}

function requireView(views: SavedGitHubView[], id: unknown): SavedGitHubView {
  const view = typeof id === "string" ? views.find((item) => item.id === id) : undefined;
  if (!view) throw Object.assign(new Error("View not found"), { code: "not-found" });
  return view;
}

export function addSavedView(views: SavedGitHubView[], input: Record<string, unknown>, id: string): { views: SavedGitHubView[]; view: SavedGitHubView } {
  const { kind, group } = input;
  assertGitHubKind(kind);
  assertViewGroup(group);
  const name = viewName(input.name);
  const query = viewQuery(input.query);
  if (views.length >= MAX_SAVED_VIEWS) throw invalid(`At most ${MAX_SAVED_VIEWS} saved views are allowed`);
  const view: SavedGitHubView = { id, kind, name, query, group };
  return { views: [...views, view], view };
}

export function renameSavedView(views: SavedGitHubView[], id: unknown, name: unknown): SavedGitHubView[] {
  const target = requireView(views, id);
  const trimmed = viewName(name);
  return views.map((view) => (view === target ? { ...view, name: trimmed } : view));
}

export function deleteSavedView(views: SavedGitHubView[], id: unknown): SavedGitHubView[] {
  const target = requireView(views, id);
  return views.filter((view) => view !== target);
}
