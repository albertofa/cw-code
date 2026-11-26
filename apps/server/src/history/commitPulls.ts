import { homedir } from "node:os";
import type { AppSettings, HistoryCommitPull, HistoryCommitPulls } from "@cw-code/contracts";
import { COMMIT_PULLS_NO_GITHUB_REMOTE } from "@cw-code/shared/commitPulls";
import { authenticatedEnvironment, execText, redactUrlCredentials } from "../fs/GitService.js";
import { GH_HOST, githubCliBinary, withGitHubAccount } from "../github/githubAccount.js";
import { OWNER_RE, REPO_RE } from "../github/githubRefs.js";
import { AvatarNotFoundError, classifyAvatarFailure } from "./HistoryAvatars.js";
import { isFullSha } from "./historyParsers.js";

export interface CommitPullsRemote {
  host: string;
  owner: string;
  repository: string;
}

export type CommitPullsLookup = (owner: string, repo: string, sha: string) => Promise<string>;

export interface CommitPullsOptions {
  remote: (root: string) => Promise<CommitPullsRemote | null>;
  lookup: CommitPullsLookup;
  now?: () => number;
}

const CACHE_TTL_MS = 600_000;
const CACHE_MAX_ENTRIES = 500;
const GH_TIMEOUT_MS = 15_000;
const MAX_UNAVAILABLE_LENGTH = 160;
const NO_REMOTE = COMMIT_PULLS_NO_GITHUB_REMOTE;
const STATE_RANK = { MERGED: 0, OPEN: 1, CLOSED: 2 } as const;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The PR store keys refs case-sensitively, so use GitHub's own casing rather than the remote URL's.
function canonicalRepo(value: unknown, owner: string, repo: string): { owner: string; repo: string } {
  const fullName = value !== null && typeof value === "object" ? text((value as Record<string, unknown>).full_name) : null;
  const [canonicalOwner, canonicalName, ...rest] = fullName?.split("/") ?? [];
  if (!canonicalOwner || !canonicalName || rest.length > 0) return { owner, repo };
  if (canonicalOwner.toLowerCase() !== owner.toLowerCase() || canonicalName.toLowerCase() !== repo.toLowerCase()) return { owner, repo };
  return { owner: canonicalOwner, repo: canonicalName };
}

function parseCommitPull(value: unknown, host: string, owner: string, repo: string): HistoryCommitPull | null {
  if (value === null || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const number = item.number;
  const title = text(item.title);
  const url = text(item.html_url);
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0 || title === null || url === null) return null;
  const mergedAt = typeof item.merged_at === "string" ? Date.parse(item.merged_at) : Number.NaN;
  const merged = Number.isFinite(mergedAt);
  const head = (item.head ?? {}) as Record<string, unknown>;
  const base = (item.base ?? {}) as Record<string, unknown>;
  const canonical = canonicalRepo(base.repo, owner, repo);
  return {
    ref: { host, owner: canonical.owner, repo: canonical.repo, number },
    title,
    url,
    state: merged ? "MERGED" : item.state === "open" ? "OPEN" : "CLOSED",
    isDraft: item.draft === true,
    mergedAt: merged ? mergedAt : null,
    headRefName: text(head.ref) ?? "",
    baseRefName: text(base.ref) ?? ""
  };
}

export function parseCommitPulls(stdout: string, host: string, owner: string, repo: string): HistoryCommitPull[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const pulls: HistoryCommitPull[] = [];
  for (const value of parsed) {
    const pull = parseCommitPull(value, host, owner, repo);
    if (pull !== null) pulls.push(pull);
  }
  return pulls.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.ref.number - a.ref.number);
}

export function ghCommitPullsLookup(settings: () => AppSettings): CommitPullsLookup {
  return (owner, repo, sha) => {
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || !isFullSha(sha)) return Promise.resolve("[]");
    return withGitHubAccount(settings, GH_HOST, owner, ({ account, token }) =>
      execText(
        githubCliBinary(settings),
        ["api", `repos/${owner}/${repo}/commits/${sha}/pulls`],
        homedir(),
        GH_TIMEOUT_MS,
        authenticatedEnvironment(account.host, token)
      )
    );
  };
}

function unavailableReason(error: unknown): string {
  const message = redactUrlCredentials(error instanceof Error ? error.message : String(error));
  const line = message.replace(/\r/g, "").split("\n").map((part) => part.trim()).find(Boolean) ?? "unknown error";
  return line.slice(0, MAX_UNAVAILABLE_LENGTH);
}

export class CommitPullsService {
  private readonly now: () => number;
  private readonly cache = new Map<string, { pulls: HistoryCommitPull[]; expiresAt: number }>();

  constructor(private readonly options: CommitPullsOptions) {
    this.now = options.now ?? Date.now;
  }

  async resolve(root: string, sha: string): Promise<HistoryCommitPulls> {
    let remote: CommitPullsRemote | null;
    try {
      remote = await this.options.remote(root);
    } catch (error) {
      return { pulls: [], unavailable: unavailableReason(error) };
    }
    const host = remote?.host.toLowerCase() ?? "";
    if (remote === null || host !== GH_HOST) return { pulls: [], unavailable: NO_REMOTE };
    const key = `${host}/${remote.owner}/${remote.repository}@${sha}`.toLowerCase();
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expiresAt > this.now()) return { pulls: hit.pulls, unavailable: null };
    try {
      const stdout = await this.options.lookup(remote.owner, remote.repository, sha);
      return { pulls: this.remember(key, parseCommitPulls(stdout, host, remote.owner, remote.repository)), unavailable: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (classifyAvatarFailure(message) instanceof AvatarNotFoundError) {
        return { pulls: this.remember(key, []), unavailable: null };
      }
      return { pulls: [], unavailable: unavailableReason(error) };
    }
  }

  private remember(key: string, pulls: HistoryCommitPull[]): HistoryCommitPull[] {
    const now = this.now();
    for (const [entryKey, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(entryKey);
    this.cache.delete(key);
    this.cache.set(key, { pulls, expiresAt: now + CACHE_TTL_MS });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return pulls;
  }
}
