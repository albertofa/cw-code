import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AppSettings, GitHubAccountInfo, PrDetail, PrInboxResult, PrRef, PrSummary, Project } from "@cw-code/contracts";
import {
  authenticatedEnvironment,
  defaultBinary,
  execText,
  fetchGhAuthStatus,
  fetchGhToken,
  selectGitHubAccount,
  type GitService
} from "../fs/GitService.js";
import { expandHome } from "../skills/skillPaths.js";
import { DETAIL_QUERY, HEAD_QUERY, INBOX_QUERY, INBOX_SEARCH_LIMIT, inboxSearchQueries } from "./prQueries.js";
import { parseDetail, parseHead, parseInbox, prKey } from "./prParsers.js";

const GH_HOST = "github.com";
const INBOX_CACHE_TTL_MS = 30_000;
const ACCOUNT_CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const CLONE_TIMEOUT_MS = 5 * 60_000;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

function isMissingBinaryError(message: string): boolean {
  return /ENOENT|not recognized as an internal or external command|command not found|no such file or directory/i.test(message);
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function assertPrRef(ref: PrRef): void {
  if (!ref || typeof ref !== "object") throw new Error("invalid pull request reference");
  if (ref.host !== GH_HOST) throw new Error(`unsupported GitHub host '${String(ref.host)}'`);
  if (typeof ref.owner !== "string" || !OWNER_RE.test(ref.owner)) throw new Error(`invalid repository owner '${String(ref.owner)}'`);
  if (typeof ref.repo !== "string" || !REPO_RE.test(ref.repo) || ref.repo === "." || ref.repo === "..") {
    throw new Error(`invalid repository name '${String(ref.repo)}'`);
  }
  if (!isSafePositiveInt(ref.number)) throw new Error(`invalid pull request number '${String(ref.number)}'`);
}

export function assertRunId(runId: number): void {
  if (!isSafePositiveInt(runId)) throw new Error(`invalid check run id '${String(runId)}'`);
}

export function mergeInboxItems(lists: PrSummary[][]): PrSummary[] {
  const seen = new Set<string>();
  const merged: PrSummary[] = [];
  for (const list of lists) {
    for (const item of list) {
      const key = prKey(item.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

export function cloneTargetPath(cloneRoot: string, ref: Pick<PrRef, "owner" | "repo">, homeDir: string = homedir()): string {
  const trimmed = cloneRoot.trim();
  if (!trimmed || trimmed.startsWith("-")) throw new Error(`invalid clone root '${cloneRoot}'`);
  const expanded = expandHome(trimmed, homeDir);
  if (!isAbsolute(expanded)) throw new Error(`clone root must be an absolute path: '${cloneRoot}'`);
  const root = resolve(expanded);
  const target = resolve(root, ref.owner, ref.repo);
  const rel = relative(root, target);
  if (rel === "" || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`invalid clone target for ${ref.owner}/${ref.repo}`);
  }
  return target;
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const stripped = resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? stripped.toLowerCase() : stripped;
  };
  return normalize(a) === normalize(b);
}

type AccountResolution = { account: GitHubAccountInfo; token: string } | { error: string };

export class PullRequestService {
  private inboxCache: { expiresAt: number; value: PrInboxResult } | null = null;
  private inboxInFlight: Promise<PrInboxResult> | null = null;
  private accountCache = new Map<string, { expiresAt: number; value: { account: GitHubAccountInfo; token: string } }>();
  private cloneInFlight = new Map<string, Promise<Project>>();
  private knownHeads = new Map<string, string>();
  private knownStates = new Map<string, PrSummary["state"]>();

  constructor(
    private git: GitService,
    private settings: () => AppSettings,
    private addProject: (rootPath: string) => Project
  ) {}

  private githubCliBinary(): string {
    return this.settings().githubCliBinaryPath?.trim() || defaultBinary("gh");
  }

  private async resolveAccount(): Promise<AccountResolution> {
    const cached = this.accountCache.get(GH_HOST);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const binary = this.githubCliBinary();
    let accounts: GitHubAccountInfo[];
    try {
      accounts = await fetchGhAuthStatus(binary, homedir());
    } catch (error) {
      const message = (error as Error).message;
      return { error: isMissingBinaryError(message) ? "GitHub CLI not found" : message || "GitHub CLI unavailable" };
    }
    const selection = selectGitHubAccount(accounts, GH_HOST, "");
    if (!selection.account) return { error: selection.error ?? "No authenticated github.com account in gh" };
    try {
      const token = await fetchGhToken(binary, homedir(), GH_HOST, selection.account.login);
      if (!token) return { error: `No token available for ${selection.account.login}` };
      const resolution = { account: selection.account, token };
      this.accountCache.set(GH_HOST, { expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS, value: resolution });
      return resolution;
    } catch (error) {
      return { error: (error as Error).message || "GitHub CLI unavailable" };
    }
  }

  async inbox(force = false): Promise<PrInboxResult> {
    if (!force && this.inboxCache && this.inboxCache.expiresAt > Date.now()) return this.inboxCache.value;
    if (this.inboxInFlight) return this.inboxInFlight;
    const promise = this.computeInbox()
      .then((value) => {
        if (value.error === null) this.inboxCache = { expiresAt: Date.now() + INBOX_CACHE_TTL_MS, value };
        return value;
      })
      .finally(() => {
        if (this.inboxInFlight === promise) this.inboxInFlight = null;
      });
    this.inboxInFlight = promise;
    return promise;
  }

  private async computeInbox(): Promise<PrInboxResult> {
    const fetchedAt = Date.now();
    const resolution = await this.resolveAccount();
    if ("error" in resolution) return { account: null, items: [], fetchedAt, error: resolution.error };
    const { account, token } = resolution;
    const env = authenticatedEnvironment(account.host, token);
    const binary = this.githubCliBinary();
    const accountInfo = { host: account.host, login: account.login };
    try {
      const results = await Promise.all(
        inboxSearchQueries(fetchedAt).map((q) =>
          execText(binary, ["api", "graphql", "-f", `query=${INBOX_QUERY}`, "-f", `q=${q}`], homedir(), REQUEST_TIMEOUT_MS, env)
        )
      );
      const parsed = results.map((json) => parseInbox(json));
      if (parsed.some((entry) => entry.viewer === null)) {
        return { account: accountInfo, items: [], fetchedAt, error: "Unexpected response from GitHub" };
      }
      const items = mergeInboxItems(parsed.map((entry) => entry.items));
      for (const item of items) this.remember(item.ref, item.headRefOid, item.state);
      const truncated = parsed.some((entry) => entry.truncated);
      return { account: accountInfo, items, fetchedAt, error: null, truncated, limit: INBOX_SEARCH_LIMIT };
    } catch (error) {
      return { account: accountInfo, items: [], fetchedAt, error: (error as Error).message || "GitHub CLI error" };
    }
  }

  async detail(ref: PrRef): Promise<PrDetail> {
    assertPrRef(ref);
    const resolution = await this.resolveAccount();
    if ("error" in resolution) throw new Error(resolution.error);
    const { account, token } = resolution;
    const stdout = await execText(
      this.githubCliBinary(),
      ["api", "graphql", "-f", `query=${DETAIL_QUERY}`, "-f", `owner=${ref.owner}`, "-f", `repo=${ref.repo}`, "-F", `number=${ref.number}`],
      homedir(),
      REQUEST_TIMEOUT_MS,
      authenticatedEnvironment(account.host, token)
    );
    const detail = parseDetail(stdout, account.login);
    if (!detail) throw new Error(`Could not load pull request #${ref.number}`);
    this.remember(ref, detail.headRefOid, detail.state);
    return detail;
  }

  async diff(ref: PrRef): Promise<string> {
    assertPrRef(ref);
    const resolution = await this.resolveAccount();
    if ("error" in resolution) throw new Error(resolution.error);
    const { account, token } = resolution;
    return execText(
      this.githubCliBinary(),
      ["pr", "diff", String(ref.number), "-R", `${ref.owner}/${ref.repo}`],
      homedir(),
      REQUEST_TIMEOUT_MS,
      authenticatedEnvironment(account.host, token)
    );
  }

  async failedCheckLog(ref: PrRef, runId: number): Promise<string> {
    assertPrRef(ref);
    assertRunId(runId);
    const resolution = await this.resolveAccount();
    if ("error" in resolution) throw new Error(resolution.error);
    const { account, token } = resolution;
    return execText(
      this.githubCliBinary(),
      ["run", "view", String(runId), "--log-failed", "-R", `${ref.owner}/${ref.repo}`],
      homedir(),
      REQUEST_TIMEOUT_MS,
      authenticatedEnvironment(account.host, token)
    );
  }

  async clone(ref: PrRef): Promise<Project> {
    assertPrRef(ref);
    const target = cloneTargetPath(this.settings().prCloneRoot, ref);
    const inFlight = this.cloneInFlight.get(target);
    if (inFlight) return inFlight;
    const promise = this.computeClone(ref, target).finally(() => {
      if (this.cloneInFlight.get(target) === promise) this.cloneInFlight.delete(target);
    });
    this.cloneInFlight.set(target, promise);
    return promise;
  }

  private async computeClone(ref: PrRef, target: string): Promise<Project> {
    if (existsSync(target)) {
      const repositoryRoot = await this.git.repositoryRoot(target).catch(() => null);
      if (repositoryRoot && samePath(repositoryRoot, target)) {
        return this.addProject(target);
      }
      let entries: string[];
      try {
        entries = await readdir(target);
      } catch (error) {
        throw new Error(`'${target}' already exists and is not a usable directory: ${(error as Error).message}`);
      }
      if (entries.length > 0) {
        throw new Error(`'${target}' already exists and is not the repository root for ${ref.owner}/${ref.repo}`);
      }
    }
    const resolution = await this.resolveAccount();
    if ("error" in resolution) throw new Error(resolution.error);
    const { account, token } = resolution;
    await mkdir(dirname(target), { recursive: true });
    await execText(
      this.githubCliBinary(),
      ["repo", "clone", `${ref.owner}/${ref.repo}`, target],
      homedir(),
      CLONE_TIMEOUT_MS,
      authenticatedEnvironment(account.host, token)
    );
    return this.addProject(target);
  }

  knownHead(ref: PrRef): string | null {
    return this.knownHeads.get(prKey(ref)) ?? null;
  }

  knownState(ref: PrRef): PrSummary["state"] | null {
    return this.knownStates.get(prKey(ref)) ?? null;
  }

  private remember(ref: PrRef, head: string | null, state: PrSummary["state"] | null): void {
    const key = prKey(ref);
    if (head) this.knownHeads.set(key, head);
    if (state) this.knownStates.set(key, state);
  }

  async refreshHead(ref: PrRef): Promise<string | null> {
    try {
      assertPrRef(ref);
      const resolution = await this.resolveAccount();
      if ("error" in resolution) return null;
      const { account, token } = resolution;
      const stdout = await execText(
        this.githubCliBinary(),
        ["api", "graphql", "-f", `query=${HEAD_QUERY}`, "-f", `owner=${ref.owner}`, "-f", `repo=${ref.repo}`, "-F", `number=${ref.number}`],
        homedir(),
        REQUEST_TIMEOUT_MS,
        authenticatedEnvironment(account.host, token)
      );
      const { headRefOid, state } = parseHead(stdout);
      this.remember(ref, headRefOid, state);
      return headRefOid;
    } catch {
      return null;
    }
  }
}
