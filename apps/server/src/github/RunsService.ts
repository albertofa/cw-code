import { homedir } from "node:os";
import type { AppSettings, GitHubAccountRef, RepoRef, RunRef, RunSources, RunsResult, WorkflowRunSummary } from "@cw-code/contracts";
import { authenticatedEnvironment, execText, execWithStatus, type ExecStatusResult } from "../fs/GitService.js";
import { assertSearchQuery, withTypeQualifier } from "./GitHubSearchService.js";
import { githubCliBinary, resolveGitHubAccount } from "./githubAccount.js";
import { assertOwnerLogin, assertRepoRef, assertRunRef } from "./githubRefs.js";
import { MAX_RUN_ORGS, MAX_RUN_REPOS, RUNS_PR_QUERY, runsSourcesQuery } from "./runQueries.js";
import { graphqlOutcome, graphqlPartialFailure } from "./prParsers.js";
import { parseRunSuites } from "./runParsers.js";

const RUNS_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

export type GhExec = (args: string[]) => Promise<ExecStatusResult>;

export function createGhExec(settings: () => AppSettings): GhExec {
  return async (args) => {
    const resolution = await resolveGitHubAccount(settings);
    if ("error" in resolution) throw new Error(resolution.error);
    return execWithStatus(
      githubCliBinary(settings),
      args,
      homedir(),
      REQUEST_TIMEOUT_MS,
      authenticatedEnvironment(resolution.account.host, resolution.token)
    );
  };
}

interface NormalizedSources {
  prSearchQuery: string | null;
  repos: RepoRef[];
  orgs: string[];
}

function normalizeSources(sources: RunSources): NormalizedSources {
  const query = sources.prSearchQuery;
  if (query !== null) assertSearchQuery(query);
  const repos = new Map<string, RepoRef>();
  for (const repo of Array.isArray(sources.repos) ? sources.repos : []) {
    assertRepoRef(repo);
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (!repos.has(key) && repos.size < MAX_RUN_REPOS) repos.set(key, { host: repo.host, owner: repo.owner, repo: repo.repo });
  }
  const orgs = new Map<string, string>();
  for (const org of Array.isArray(sources.orgs) ? sources.orgs : []) {
    assertOwnerLogin(org);
    if (!orgs.has(org.toLowerCase()) && orgs.size < MAX_RUN_ORGS) orgs.set(org.toLowerCase(), org);
  }
  return {
    prSearchQuery: query === null ? null : withTypeQualifier("pr", query.trim().replace(/\s+/g, " ")),
    repos: [...repos.values()].sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`)),
    orgs: [...orgs.values()].sort((a, b) => a.localeCompare(b))
  };
}

function cacheKey(login: string, sources: NormalizedSources): string {
  return JSON.stringify([
    login.toLowerCase(),
    sources.prSearchQuery,
    sources.repos.map((repo) => `${repo.owner}/${repo.repo}`.toLowerCase()),
    sources.orgs.map((org) => org.toLowerCase())
  ]);
}

interface SourceRuns {
  runs: WorkflowRunSummary[];
  warning: string | null;
}

export class RunsService {
  private cache = new Map<string, { expiresAt: number; value: RunsResult }>();
  private inFlight = new Map<string, Promise<RunsResult>>();
  private exec: GhExec;

  constructor(private settings: () => AppSettings, exec?: GhExec) {
    this.exec = exec ?? createGhExec(settings);
  }

  async runs(sources: RunSources, force = false): Promise<RunsResult> {
    const normalized = normalizeSources(sources);
    const resolution = await resolveGitHubAccount(this.settings);
    if ("error" in resolution) return { account: null, items: [], fetchedAt: Date.now(), error: resolution.error };
    const account: GitHubAccountRef = { host: resolution.account.host, login: resolution.account.login };
    const key = cacheKey(account.login, normalized);
    const cached = this.cache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const promise = this.compute(normalized, account)
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

  private remember(key: string, value: RunsResult): void {
    const now = Date.now();
    for (const [entryKey, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(entryKey);
    }
    this.cache.set(key, { expiresAt: now + RUNS_CACHE_TTL_MS, value });
  }

  private async compute(sources: NormalizedSources, account: GitHubAccountRef): Promise<RunsResult> {
    const fetchedAt = Date.now();
    const requests: Array<Promise<SourceRuns>> = [];
    if (sources.prSearchQuery !== null) {
      requests.push(this.request(["-f", `query=${RUNS_PR_QUERY}`, "-f", `q=${sources.prSearchQuery}`]));
    }
    if (sources.repos.length > 0 || sources.orgs.length > 0) {
      const variables = [
        ...sources.repos.flatMap((repo, index) => ["-f", `ro${index}=${repo.owner}`, "-f", `rn${index}=${repo.repo}`]),
        ...sources.orgs.flatMap((org, index) => ["-f", `ol${index}=${org}`])
      ];
      requests.push(this.request(["-f", `query=${runsSourcesQuery(sources.repos.length, sources.orgs.length)}`, ...variables]));
    }
    const settled = await Promise.allSettled(requests);
    const items = new Map<number, WorkflowRunSummary>();
    const problems: string[] = [];
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        problems.push((outcome.reason as Error).message || "GitHub CLI error");
        continue;
      }
      if (outcome.value.warning) problems.push(outcome.value.warning);
      for (const run of outcome.value.runs) {
        if (!items.has(run.ref.runId)) items.set(run.ref.runId, run);
      }
    }
    return { account, items: [...items.values()], fetchedAt, error: problems[0] ?? null };
  }

  private async request(graphqlArgs: string[]): Promise<SourceRuns> {
    const { code, stdout, stderr } = await this.exec(["api", "graphql", ...graphqlArgs]);
    const outcome = graphqlOutcome(stdout);
    if (!outcome.hasData) throw new Error(outcome.message || stderr.trim() || `GitHub CLI exited with code ${code}`);
    return { runs: parseRunSuites(stdout), warning: graphqlPartialFailure(stdout, "sources") };
  }

  async runLog(ref: RunRef): Promise<string> {
    assertRunRef(ref);
    const resolution = await resolveGitHubAccount(this.settings);
    if ("error" in resolution) throw new Error(resolution.error);
    return execText(
      githubCliBinary(this.settings),
      ["run", "view", String(ref.runId), "--log-failed", "-R", `${ref.owner}/${ref.repo}`],
      homedir(),
      REQUEST_TIMEOUT_MS,
      authenticatedEnvironment(resolution.account.host, resolution.token)
    );
  }
}
