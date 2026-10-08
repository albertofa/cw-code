import { homedir } from "node:os";
import type { AppSettings, GitHubSearchResult, IssueDetail, IssueRef, IssueSummary, PrSummary } from "@cw-code/contracts";
import { authenticatedEnvironment, execText } from "../fs/GitService.js";
import { githubCliBinary, resolveGitHubAccount } from "./githubAccount.js";
import { ISSUE_DETAIL_QUERY, ISSUE_SEARCH_QUERY, MAX_COUNT_QUERIES, countsQuery } from "./issueQueries.js";
import { parseCounts, parseIssueDetail, parseIssueSearch } from "./issueParsers.js";
import { INBOX_SEARCH_LIMIT, PR_SEARCH_QUERY } from "./prQueries.js";
import { parsePrSearch } from "./prParsers.js";
import { assertIssueRef } from "./githubRefs.js";

const SEARCH_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_QUERY_LENGTH = 512;

type SearchKind = "pr" | "issue";

export function assertSearchQuery(query: unknown): asserts query is string {
  if (typeof query !== "string") throw new Error("search query must be a string");
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new Error("search query must not be empty");
  if (trimmed.length > MAX_QUERY_LENGTH) throw new Error(`search query must be at most ${MAX_QUERY_LENGTH} characters`);
}

export function assertCountBase(countBase: unknown): asserts countBase is string {
  if (typeof countBase !== "string") throw new Error("count base must be a string");
  if (countBase.trim().length > MAX_QUERY_LENGTH) throw new Error(`count base must be at most ${MAX_QUERY_LENGTH} characters`);
}

export function assertSearchKind(kind: unknown): asserts kind is SearchKind {
  if (kind !== "pr" && kind !== "issue") throw new Error(`invalid search kind '${String(kind)}'`);
}

const TYPE_QUALIFIER_PATTERNS: Record<SearchKind, RegExp> = {
  pr: /(^|\s)(is|type):pr(?=\s|$)/i,
  issue: /(^|\s)(is|type):issue(?=\s|$)/i
};

export function withTypeQualifier(kind: SearchKind, query: string): string {
  const trimmed = query.trim();
  return TYPE_QUALIFIER_PATTERNS[kind].test(trimmed) ? trimmed : `${trimmed} is:${kind}`.trim();
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

export class GitHubSearchService {
  private cache = new Map<string, { expiresAt: number; value: GitHubSearchResult<PrSummary | IssueSummary> }>();
  private inFlight = new Map<string, Promise<GitHubSearchResult<PrSummary | IssueSummary>>>();

  constructor(private settings: () => AppSettings) {}

  search(kind: "pr", query: string, countBase: string, force?: boolean): Promise<GitHubSearchResult<PrSummary>>;
  search(kind: "issue", query: string, countBase: string, force?: boolean): Promise<GitHubSearchResult<IssueSummary>>;
  async search(kind: SearchKind, query: string, countBase: string, force = false): Promise<GitHubSearchResult<PrSummary | IssueSummary>> {
    assertSearchKind(kind);
    assertSearchQuery(query);
    assertCountBase(countBase);
    const remote = withTypeQualifier(kind, normalizeQuery(query));
    const base = withTypeQualifier(kind, normalizeQuery(countBase));
    const key = `${kind}\n${remote}\n${base}`;
    const cached = this.cache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const promise = this.compute(kind, remote, base)
      .then((value) => {
        if (value.error === null) this.remember(key, value);
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  private remember(key: string, value: GitHubSearchResult<PrSummary | IssueSummary>): void {
    const now = Date.now();
    for (const [entryKey, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(entryKey);
    }
    this.cache.set(key, { expiresAt: now + SEARCH_CACHE_TTL_MS, value });
  }

  private async compute(kind: SearchKind, remote: string, base: string): Promise<GitHubSearchResult<PrSummary | IssueSummary>> {
    const fetchedAt = Date.now();
    const empty = { items: [], openCount: null, closedCount: null, truncated: false, limit: INBOX_SEARCH_LIMIT, fetchedAt };
    const resolution = await resolveGitHubAccount(this.settings);
    if ("error" in resolution) return { ...empty, account: null, error: resolution.error };
    const { account, token } = resolution;
    const accountInfo = { host: account.host, login: account.login };
    try {
      const stdout = await execText(
        githubCliBinary(this.settings),
        [
          "api",
          "graphql",
          "-f",
          `query=${kind === "pr" ? PR_SEARCH_QUERY : ISSUE_SEARCH_QUERY}`,
          "-f",
          `q=${remote}`,
          "-f",
          `open=${base} is:open`,
          "-f",
          `closed=${base} is:closed`
        ],
        homedir(),
        REQUEST_TIMEOUT_MS,
        authenticatedEnvironment(account.host, token)
      );
      const parsed = kind === "pr" ? parsePrSearch(stdout) : parseIssueSearch(stdout);
      if (parsed.viewer === null) return { ...empty, account: accountInfo, error: "Unexpected response from GitHub" };
      return {
        account: accountInfo,
        items: parsed.items,
        openCount: parsed.openCount,
        closedCount: parsed.closedCount,
        truncated: parsed.truncated,
        limit: INBOX_SEARCH_LIMIT,
        fetchedAt,
        error: null
      };
    } catch (error) {
      return { ...empty, account: accountInfo, error: (error as Error).message || "GitHub CLI error" };
    }
  }

  async counts(kind: SearchKind, queries: string[]): Promise<Array<number | null>> {
    assertSearchKind(kind);
    if (!Array.isArray(queries) || queries.length > MAX_COUNT_QUERIES) throw new Error(`counts accepts at most ${MAX_COUNT_QUERIES} queries`);
    if (queries.length === 0) return [];
    queries.forEach(assertSearchQuery);
    const resolution = await resolveGitHubAccount(this.settings);
    if ("error" in resolution) throw new Error(resolution.error);
    const { account, token } = resolution;
    const variables = queries.flatMap((query, index) => ["-f", `c${index}=${withTypeQualifier(kind, normalizeQuery(query))}`]);
    const stdout = await execText(
      githubCliBinary(this.settings),
      ["api", "graphql", "-f", `query=${countsQuery(queries.length)}`, ...variables],
      homedir(),
      REQUEST_TIMEOUT_MS,
      authenticatedEnvironment(account.host, token)
    );
    return parseCounts(stdout, queries.length);
  }

  async issueDetail(ref: IssueRef): Promise<IssueDetail> {
    assertIssueRef(ref);
    const resolution = await resolveGitHubAccount(this.settings);
    if ("error" in resolution) throw new Error(resolution.error);
    const { account, token } = resolution;
    const stdout = await execText(
      githubCliBinary(this.settings),
      ["api", "graphql", "-f", `query=${ISSUE_DETAIL_QUERY}`, "-f", `owner=${ref.owner}`, "-f", `repo=${ref.repo}`, "-F", `number=${ref.number}`],
      homedir(),
      REQUEST_TIMEOUT_MS,
      authenticatedEnvironment(account.host, token)
    );
    const detail = parseIssueDetail(stdout, account.login);
    if (!detail) throw new Error(`Could not load issue #${ref.number}`);
    return detail;
  }
}
