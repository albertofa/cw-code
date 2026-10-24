import type { RepoRef, RunSources, TextSearchQuery } from "@cw-code/contracts";
import { assertSearchQuery } from "../github/GitHubSearchService.js";
import { assertOwnerLogin, assertRepoRef } from "../github/githubRefs.js";
import { MAX_RUN_ORGS, MAX_RUN_REPOS } from "../github/runQueries.js";
import type { CallContext, Router } from "../transport/Router.js";

export function handle<T = unknown>(router: Router, method: string, handler: (args: T, ctx: CallContext) => unknown): void {
  router.handle(method, (params, ctx) => handler(params as T, ctx));
}

export function parseArgs(args: unknown, channel: string): Record<string, unknown> {
  if (!args || typeof args !== "object") throw new Error(`${channel} requires an argument object`);
  return args as Record<string, unknown>;
}

export function parseOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("expected a string");
}

export function parseString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export function parseOptionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : parseString(value, name);
}

export function parseOptionalNumber(value: unknown, name: string): number | undefined {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${name} must be a finite number`);
  return value;
}

export function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function parseTextSearchQuery(value: unknown): TextSearchQuery {
  const query = parseArgs(value, "fs.searchText query");
  const include = parseOptionalString(query.include, "include");
  const exclude = parseOptionalString(query.exclude, "exclude");
  const maxResults = parseOptionalNumber(query.maxResults, "maxResults");
  return {
    query: parseString(query.query, "query"),
    isRegex: parseBoolean(query.isRegex, "isRegex"),
    matchCase: parseBoolean(query.matchCase, "matchCase"),
    wholeWord: parseBoolean(query.wholeWord, "wholeWord"),
    ...(include !== undefined ? { include } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
    ...(maxResults !== undefined ? { maxResults } : {})
  };
}

export function parseList<T>(value: unknown, max: number, name: string, assertItem: (item: unknown) => asserts item is T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max} items`);
  const items: T[] = [];
  for (const item of value) {
    assertItem(item);
    items.push(item);
  }
  return items;
}

export function parseRunSources(value: unknown): RunSources {
  const { prSearchQuery, repos, orgs } = parseArgs(value, "github.runs sources");
  let query: string | null = null;
  if (prSearchQuery !== null) {
    assertSearchQuery(prSearchQuery);
    query = prSearchQuery;
  }
  return {
    prSearchQuery: query,
    repos: parseList<RepoRef>(repos, MAX_RUN_REPOS, "repos", assertRepoRef),
    orgs: parseList<string>(orgs, MAX_RUN_ORGS, "orgs", assertOwnerLogin)
  };
}
