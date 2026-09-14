import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import { sameWorktreePath } from "../sessions/worktreeCleanup.js";
import type {
  AppSettings,
  GitBranchInfo,
  GitDiffMode,
  GitDiffResult,
  GitHubAccountInfo,
  GitHubAccountSelectionSource,
  GitPullRequest,
  GitStatus,
  Project,
  SourceControlBinaryHealth,
  SourceControlHealth
} from "@cw-code/contracts";

export interface CreatedWorktree {
  path: string;
  branch: string;
  repositoryRoot: string;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  dirtyBlocked?: boolean;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

interface GhCheck {
  conclusion?: string;
  status?: string;
  state?: string;
}

export interface ParsedGitHubRemote {
  host: string;
  owner: string;
  repository: string;
  slug: string;
  url: string;
}

interface AccountSelection {
  account: GitHubAccountInfo | null;
  source: GitHubAccountSelectionSource;
  error: string | null;
}

type SourceControlSettings = Pick<AppSettings, "gitBinaryPath" | "githubCliBinaryPath">;

function defaultBinary(name: "git" | "gh"): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function cleanAuthEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["GH_TOKEN"];
  delete env["GITHUB_TOKEN"];
  delete env["GH_ENTERPRISE_TOKEN"];
  delete env["GITHUB_ENTERPRISE_TOKEN"];
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GCM_INTERACTIVE"] = "never";
  env["GIT_ASKPASS"] = "";
  env["SSH_ASKPASS"] = "";
  return env;
}

function authenticatedEnvironment(host: string, token: string): NodeJS.ProcessEnv {
  const env = cleanAuthEnvironment();
  env["GH_HOST"] = host;
  if (host === "github.com" || host.endsWith(".ghe.com")) env["GH_TOKEN"] = token;
  else env["GH_ENTERPRISE_TOKEN"] = token;
  return withNonInteractiveEnv(env);
}

function withNonInteractiveEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = base ?? { ...process.env };
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GCM_INTERACTIVE"] = "never";
  env["GIT_ASKPASS"] = "";
  env["SSH_ASKPASS"] = "";
  return env;
}

export function parseGitHubRemote(url: string): ParsedGitHubRemote | null {
  const value = url.trim();
  if (!value || /^[a-zA-Z]:[\\/]/.test(value)) return null;
  let host = "";
  let path = "";
  try {
    const parsed = new URL(value);
    host = parsed.hostname;
    path = parsed.pathname;
  } catch {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (!host || parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repository = parts[parts.length - 1];
  return { host: host.toLowerCase(), owner, repository, slug: `${owner}/${repository}`, url: value };
}

export function parseGitHubAccounts(stdout: string): GitHubAccountInfo[] {
  try {
    const parsed = JSON.parse(stdout) as { hosts?: Record<string, unknown> };
    const result: GitHubAccountInfo[] = [];
    for (const [host, rawAccounts] of Object.entries(parsed.hosts ?? {})) {
      if (!Array.isArray(rawAccounts)) continue;
      for (const raw of rawAccounts) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.login !== "string" || !item.login.trim()) continue;
        const state = typeof item.state === "string" ? item.state.toLowerCase() : "success";
        result.push({
          host,
          login: item.login,
          active: item.active === true,
          authenticated: !["failure", "error", "invalid"].includes(state),
          hasRepositoryAccess: null
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function selectGitHubAccount(
  accounts: GitHubAccountInfo[],
  host: string,
  owner: string,
  configured?: { host: string; login: string }
): AccountSelection {
  const candidates = accounts.filter((account) => account.host.toLowerCase() === host.toLowerCase() && account.authenticated);
  if (configured) {
    const match = candidates.find((account) =>
      account.host.toLowerCase() === configured.host.toLowerCase() && account.login.toLowerCase() === configured.login.toLowerCase()
    );
    if (!match) return { account: null, source: "project", error: `Configured GitHub account '${configured.login}' is not authenticated for ${configured.host}` };
    if (match.hasRepositoryAccess === false) return { account: null, source: "project", error: `GitHub account '${configured.login}' cannot access ${owner} on ${host}` };
    return { account: match, source: "project", error: null };
  }
  const usable = candidates.filter((account) => account.hasRepositoryAccess !== false);
  const ownerMatch = usable.find((account) => account.login.toLowerCase() === owner.toLowerCase());
  if (ownerMatch) return { account: ownerMatch, source: "owner", error: null };
  if (candidates.length === 1 && candidates[0].hasRepositoryAccess !== false) return { account: candidates[0], source: "single", error: null };
  const accessible = candidates.filter((account) => account.hasRepositoryAccess === true);
  if (accessible.length === 1) return { account: accessible[0], source: "access", error: null };
  const active = accessible.find((account) => account.active) ?? candidates.find((account) => account.active);
  if (active && active.hasRepositoryAccess !== false) return { account: active, source: "active", error: null };
  if (candidates.length === 0) return { account: null, source: "none", error: `No authenticated GitHub account found for ${host}` };
  if (usable.length === 0) return { account: null, source: "none", error: `No authenticated GitHub account can access ${owner} on ${host}` };
  return { account: null, source: "none", error: `Multiple GitHub accounts match ${host}; choose one in Source Control settings` };
}

export function parsePrNumber(stdout: string): number | null {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function worktreeNameFor(root: string): string {
  const stripped = root.replace(/[\\/]+$/, "");
  return stripped.split(/[/\\]/).filter(Boolean).pop() ?? stripped;
}

export function isAppManagedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized === ".cw" || normalized.startsWith(".cw/");
}

export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  const push = () => {
    if (path) entries.push({ path, branch });
    path = null;
    branch = null;
  };
  for (const line of stdout.replace(/\r/g, "").split("\n")) {
    if (!line) push();
    else if (line.startsWith("worktree ")) {
      if (path) push();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    }
  }
  push();
  return entries;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 1, items.length));
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
  return results;
}

export function parseNumstat(stdout: string): { addedLines: number; deletedLines: number } {
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of stdout.replace(/\r/g, "").split("\n")) {
    const [added, deleted] = line.split("\t", 2);
    if (added === "-" && deleted === "-") {
      // Git has no meaningful line count for binary content, but the changed file
      // should still be represented in the additions total.
      addedLines += 1;
      continue;
    }
    const addedValue = Number.parseInt(added, 10);
    const deletedValue = Number.parseInt(deleted, 10);
    if (Number.isFinite(addedValue)) addedLines += addedValue;
    if (Number.isFinite(deletedValue)) deletedLines += deletedValue;
  }
  return { addedLines, deletedLines };
}

export const UNTRACKED_COUNT_MAX_BYTES = 10 * 1024 * 1024;
const BINARY_SCAN_BYTES = 8000;
const READ_CHUNK_BYTES = 64 * 1024;

function countNewlines(buffer: Buffer): number {
  let count = 0;
  let index = buffer.indexOf(0x0a);
  while (index >= 0) {
    count += 1;
    index = buffer.indexOf(0x0a, index + 1);
  }
  return count;
}

export async function countUntrackedLines(root: string, file: string): Promise<{ addedLines: number; deletedLines: number }> {
  const linkStat = await lstat(join(root, file));
  if (linkStat.isSymbolicLink()) return { addedLines: 1, deletedLines: 0 };
  const handle = await open(join(root, file), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return { addedLines: 0, deletedLines: 0 };
    if (stat.size > UNTRACKED_COUNT_MAX_BYTES) return { addedLines: 1, deletedLines: 0 };
    let lines = 0;
    let scanned = 0;
    let lastByte = -1;
    let firstChunk = true;
    const buffer = Buffer.alloc(Math.min(stat.size, READ_CHUNK_BYTES));
    while (scanned < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, scanned);
      if (bytesRead === 0) break;
      const view = buffer.subarray(0, bytesRead);
      if (firstChunk && view.subarray(0, BINARY_SCAN_BYTES).includes(0)) return { addedLines: 1, deletedLines: 0 };
      firstChunk = false;
      lines += countNewlines(view);
      lastByte = view[bytesRead - 1];
      scanned += bytesRead;
    }
    if (lastByte !== -1 && lastByte !== 0x0a) lines += 1;
    return { addedLines: lines, deletedLines: 0 };
  } finally {
    await handle.close();
  }
}

export function parsePullRequest(stdout: string): GitPullRequest | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  const number = typeof raw.number === "number" ? raw.number : 0;
  const url = typeof raw.url === "string" ? raw.url : "";
  if (number <= 0 || !url) return null;
  const rollup = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup as GhCheck[] : [];
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const check of rollup) {
    const state = (check.conclusion || check.state || check.status || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) passed += 1;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"].includes(state)) failed += 1;
    else pending += 1;
  }
  const rawState = typeof raw.state === "string" ? raw.state : "OPEN";
  const state = rawState === "MERGED" || rawState === "CLOSED" ? rawState : "OPEN";
  return {
    number,
    title: typeof raw.title === "string" ? raw.title : `Pull request #${number}`,
    url,
    state,
    isDraft: raw.isDraft === true,
    reviewDecision: typeof raw.reviewDecision === "string" && raw.reviewDecision ? raw.reviewDecision : null,
    mergeStateStatus: typeof raw.mergeStateStatus === "string" && raw.mergeStateStatus ? raw.mergeStateStatus : null,
    headRefName: typeof raw.headRefName === "string" ? raw.headRefName : "",
    baseRefName: typeof raw.baseRefName === "string" ? raw.baseRefName : "",
    checks: { total: rollup.length, passed, failed, pending }
  };
}

function execText(command: string, args: string[], cwd: string, timeout = 10_000, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: env ?? withNonInteractiveEnv() }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim()));
      resolvePromise(String(stdout));
    });
  });
}

function execDiff(binary: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(binary, args, { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: withNonInteractiveEnv() }, (error, stdout, stderr) => {
      const code = (error as unknown as { code?: unknown } | null)?.code;
      if (error && code !== 1) return reject(new Error(String(stderr || error.message).trim()));
      resolvePromise(String(stdout));
    });
  });
}

function exitCode(binary: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    execFile(binary, args, { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024, env: withNonInteractiveEnv() }, (error) => {
      const code = (error as unknown as { code?: unknown } | null)?.code;
      if (error && typeof code !== "number") return reject(new Error(String(error.message).trim()));
      resolvePromise(typeof code === "number" ? code : 0);
    });
  });
}

async function queryPullRequest(root: string, ghBinary: string, remote: ParsedGitHubRemote, account: GitHubAccountInfo): Promise<{ pullRequest: GitPullRequest | null; error: string | null }> {
  try {
    const token = (await execText(ghBinary, ["auth", "token", "--hostname", remote.host, "--user", account.login], root, 8_000, cleanAuthEnvironment())).trim();
    if (!token) throw new Error(`No token available for ${account.login}`);
    const stdout = await execText(ghBinary, [
      "pr", "view", "--json",
      "number,title,url,state,isDraft,reviewDecision,mergeStateStatus,headRefName,baseRefName,statusCheckRollup"
    ], root, 8_000, authenticatedEnvironment(remote.host, token));
    return { pullRequest: parsePullRequest(stdout), error: null };
  } catch (error) {
    const message = (error as Error).message;
    if (/no pull requests? found/i.test(message)) return { pullRequest: null, error: null };
    return { pullRequest: null, error: message || "GitHub CLI unavailable" };
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workspace";
}

function nextBranchCandidate(base: string, branch: string): string | null {
  if (branch === base) return `${base}-1`;
  if (!branch.startsWith(`${base}-`)) return null;
  const suffix = Number(branch.slice(base.length + 1));
  if (!Number.isInteger(suffix) || suffix < 1 || suffix >= 100) return null;
  return `${base}-${suffix + 1}`;
}

function isBranchCollision(message: string, branch: string): boolean {
  return message.replace(/\r/g, "").split("\n").some((line) => line.includes(branch) && /already exists/i.test(line));
}

function cacheKey(root: string): string {
  const normalized = resolve(root).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export const STATUS_CACHE_TTL_MS = 5_000;
export const PR_CACHE_TTL_MS = 60_000;
export const BRANCH_CACHE_TTL_MS = 15_000;
const DIFF_PATCH_MAX_BYTES = 400_000;
const UNTRACKED_DIFF_MAX_FILES = 50;
const UNTRACKED_DIFF_MAX_BYTES_PER_FILE = 60_000;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export interface DeleteBranchResult {
  deleted: boolean;
  unmergedCommits: boolean;
}

export class GitService {
  private accountCache = new Map<string, { expiresAt: number; accounts: GitHubAccountInfo[] }>();
  private statusInFlight = new Map<string, { generation: number; promise: Promise<GitStatus> }>();
  private statusDone = new Map<string, CacheEntry<GitStatus>>();
  private statusGeneration = new Map<string, number>();
  private prCache = new Map<string, CacheEntry<{ pullRequest: GitPullRequest | null; error: string | null }>>();
  private branchDone = new Map<string, CacheEntry<GitBranchInfo[]>>();
  private branchInFlight = new Map<string, Promise<GitBranchInfo[]>>();
  private diffInFlight = new Map<string, Promise<GitDiffResult>>();

  constructor(private getSettings: () => SourceControlSettings = () => ({
    gitBinaryPath: defaultBinary("git"),
    githubCliBinaryPath: defaultBinary("gh")
  })) {}

  private settings(): SourceControlSettings {
    const settings = this.getSettings();
    return {
      gitBinaryPath: settings.gitBinaryPath?.trim() || defaultBinary("git"),
      githubCliBinaryPath: settings.githubCliBinaryPath?.trim() || defaultBinary("gh")
    };
  }

  private git(root: string) {
    return simpleGit({ baseDir: root, binary: this.settings().gitBinaryPath });
  }

  private async lineCounts(root: string): Promise<{ addedLines: number; deletedLines: number }> {
    const binary = this.settings().gitBinaryPath;
    let tracked = { addedLines: 0, deletedLines: 0 };
    try {
      tracked = parseNumstat(await execDiff(binary, ["diff", "--numstat", "HEAD", "--"], root));
    } catch {
      // An unborn repository has no HEAD. Count its staged and unstaged changes separately.
      const [staged, unstaged] = await Promise.all([
        execDiff(binary, ["diff", "--cached", "--numstat", "--"], root).catch(() => ""),
        execDiff(binary, ["diff", "--numstat", "--"], root).catch(() => "")
      ]);
      const stagedCounts = parseNumstat(staged);
      const unstagedCounts = parseNumstat(unstaged);
      tracked = {
        addedLines: stagedCounts.addedLines + unstagedCounts.addedLines,
        deletedLines: stagedCounts.deletedLines + unstagedCounts.deletedLines
      };
    }
    const untrackedFiles = await execText(binary, ["ls-files", "--others", "--exclude-standard", "-z"], root)
      .then((output) => output.split("\0").filter((file) => file && !isAppManagedPath(file)))
      .catch(() => []);
    const untracked = await mapLimit(untrackedFiles, 32, (file) =>
      countUntrackedLines(root, file).catch(() => ({ addedLines: 0, deletedLines: 0 }))
    );
    return untracked.reduce((total, counts) => ({
      addedLines: total.addedLines + counts.addedLines,
      deletedLines: total.deletedLines + counts.deletedLines
    }), tracked);
  }

  private async isLinkedWorktree(root: string): Promise<boolean> {
    const output = (await this.git(root).raw(["rev-parse", "--git-dir", "--git-common-dir"]))
      .replace(/\r/g, "").split("\n").filter(Boolean);
    if (output.length < 2) return false;
    return !sameWorktreePath(resolve(root, output[0]), resolve(root, output[1]));
  }

  async isRepository(root: string): Promise<boolean> {
    try {
      return await this.git(root).checkIsRepo();
    } catch {
      return false;
    }
  }

  async repositoryRoot(root: string): Promise<string> {
    const value = (await this.git(root).revparse(["--show-toplevel"])).trim();
    if (!value) throw new Error(`${root} is not a Git repository`);
    return resolve(value);
  }

  private async uniqueBranchName(git: ReturnType<GitService["git"]>, base: string): Promise<string> {
    const existing = new Set((await git.raw(["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
      .replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean));
    for (let suffix = 0; suffix <= 100; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error(`no free branch name derived from '${base}'`);
  }

  private async withUniqueBranchName<T>(git: ReturnType<GitService["git"]>, base: string, run: (branch: string) => Promise<T>): Promise<T> {
    let branch = await this.uniqueBranchName(git, base);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run(branch);
      } catch (error) {
        const next = attempt < 100 ? nextBranchCandidate(base, branch) : null;
        if (!next || !isBranchCollision((error as Error).message, branch)) throw error;
        branch = next;
      }
    }
  }

  private async discardBranch(git: ReturnType<GitService["git"]>, branch: string): Promise<void> {
    try {
      await git.raw(["branch", "-D", branch]);
    } catch {
      // The branch may not exist when git failed before creating it.
    }
  }

  private async addWorktree(git: ReturnType<GitService["git"]>, branch: string, target: string, base: string): Promise<string> {
    try {
      await git.raw(["worktree", "add", "-b", branch, target, base]);
      return branch;
    } catch (error) {
      const message = (error as Error).message;
      if (isBranchCollision(message, branch)) throw error;
      const registered = /missing but already registered worktree|already exists/i.test(message) && !existsSync(join(target, ".git"));
      if (registered) {
        await git.raw(["worktree", "prune"]);
        if (existsSync(target) && readdirSync(target).length === 0) {
          rmdirSync(target);
          try {
            await git.raw(["worktree", "add", "-b", branch, target, base]);
            return branch;
          } catch (retryError) {
            await this.discardBranch(git, branch);
            throw new Error(`could not create worktree from '${base}': ${(retryError as Error).message}`);
          }
        }
      }
      await this.discardBranch(git, branch);
      throw new Error(`could not create worktree from '${base}': ${message}`);
    }
  }

  private invalidateStatus(root: string): void {
    const key = cacheKey(root);
    this.statusGeneration.set(key, (this.statusGeneration.get(key) ?? 0) + 1);
    this.statusDone.delete(key);
    this.statusInFlight.delete(key);
  }

  private async initSubmodules(worktreePath: string): Promise<void> {
    if (!existsSync(join(worktreePath, ".gitmodules"))) return;
    try {
      await execText(this.settings().gitBinaryPath, ["-C", worktreePath, "submodule", "update", "--init", "--recursive"], worktreePath, 120_000);
    } catch (error) {
      console.warn(`submodule init failed for ${worktreePath}: ${(error as Error).message}`);
    }
  }

  async createWorktree(projectRoot: string, projectKey: string, sessionId: string, worktreesRoot: string, requestedBase?: string): Promise<CreatedWorktree> {
    const repositoryRoot = await this.repositoryRoot(projectRoot);
    const git = this.git(repositoryRoot);
    const branches = await this.branches(repositoryRoot);
    const current = branches.find((item) => item.current)?.name;
    const base = requestedBase?.trim() || current || "HEAD";
    if (base !== "HEAD" && !branches.some((item) => item.name === base)) throw new Error(`unknown base branch '${base}'`);
    const parent = join(worktreesRoot, safeSegment(projectKey));
    const target = join(parent, safeSegment(sessionId));
    mkdirSync(parent, { recursive: true });
    if (existsSync(target) && readdirSync(target).length === 0) rmdirSync(target);
    const branch = await this.withUniqueBranchName(git, `cw/${safeSegment(sessionId.replace(/^sess_/, ""))}`,
      (name) => this.addWorktree(git, name, target, base));
    await this.initSubmodules(target);
    this.invalidateStatus(repositoryRoot);
    this.invalidateBranches(repositoryRoot);
    return { path: resolve(target), branch, repositoryRoot };
  }

  async removeWorktree(repoRoot: string, path: string, opts: { force?: boolean } = {}): Promise<RemoveWorktreeResult> {
    const repositoryRoot = await this.repositoryRoot(repoRoot);
    const git = this.git(repositoryRoot);
    const target = resolve(path);
    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(target);
    try {
      await git.raw(args);
    } catch (error) {
      const message = (error as Error).message;
      if (!opts.force && existsSync(target) && await this.isDirtyWorktree(target)) {
        return { removed: false, dirtyBlocked: true };
      }
      const alreadyGone = !existsSync(target);
      if (!alreadyGone || !/not a working tree|cannot remove/i.test(message)) {
        throw new Error(`could not remove worktree '${target}': ${message}`);
      }
      await git.raw(["worktree", "prune"]);
      this.invalidateStatus(repositoryRoot);
      this.invalidateBranches(repositoryRoot);
      return { removed: false };
    }
    this.invalidateStatus(repositoryRoot);
    this.invalidateBranches(repositoryRoot);
    return { removed: true };
  }

  private async isDirtyWorktree(path: string): Promise<boolean> {
    try {
      return (await this.git(path).raw(["status", "--porcelain"])).trim().length > 0;
    } catch {
      return false;
    }
  }

  async pruneWorktrees(repoRoot: string, worktreesRoot: string): Promise<void> {
    const repositoryRoot = await this.repositoryRoot(repoRoot);
    await this.git(repositoryRoot).raw(["worktree", "prune"]);
    this.removeEmptyWorktreeDirs(worktreesRoot);
    this.invalidateStatus(repositoryRoot);
    this.invalidateBranches(repositoryRoot);
  }

  private removeEmptyWorktreeDirs(worktreesRoot: string): void {
    if (!existsSync(worktreesRoot)) return;
    for (const projectDir of readdirSync(worktreesRoot, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = join(worktreesRoot, projectDir.name);
      for (const sessionDir of readdirSync(projectPath, { withFileTypes: true })) {
        if (!sessionDir.isDirectory()) continue;
        const sessionPath = join(projectPath, sessionDir.name);
        try {
          if (readdirSync(sessionPath).length === 0) rmdirSync(sessionPath);
        } catch {
          // Leave in-use directories in place.
        }
      }
      try {
        if (readdirSync(projectPath).length === 0) rmdirSync(projectPath);
      } catch {
        // Leave in-use directories in place.
      }
    }
  }

  async deleteBranch(repoRoot: string, branch: string, opts: { force?: boolean } = {}): Promise<DeleteBranchResult> {
    const repositoryRoot = await this.repositoryRoot(repoRoot);
    const git = this.git(repositoryRoot);
    try {
      await git.raw(["branch", "-d", branch]);
    } catch (error) {
      if (!opts.force) {
        console.warn(`branch delete failed for '${branch}': ${(error as Error).message}`);
        return { deleted: false, unmergedCommits: false };
      }
      try {
        await git.raw(["branch", "-D", branch]);
      } catch (forceError) {
        console.warn(`branch delete failed for '${branch}': ${(forceError as Error).message}`);
        return { deleted: false, unmergedCommits: false };
      }
      this.invalidateBranches(repositoryRoot);
      return { deleted: true, unmergedCommits: true };
    }
    this.invalidateBranches(repositoryRoot);
    return { deleted: true, unmergedCommits: false };
  }

  async renameBranch(repoRoot: string, from: string, to: string, opts: { worktreePath?: string } = {}): Promise<string> {
    const name = to.trim();
    if (!name || name.startsWith("-")) throw new Error("invalid branch name");
    if (from.trim() === name) return name;
    const repositoryRoot = await this.repositoryRoot(repoRoot);
    const git = this.git(repositoryRoot);
    const target = await this.withUniqueBranchName(git, name, async (branch) => {
      await git.raw(["branch", "-m", from, branch]);
      return branch;
    });
    this.invalidateStatus(repositoryRoot);
    this.invalidateBranches(repositoryRoot);
    if (opts.worktreePath) {
      this.invalidateStatus(opts.worktreePath);
      this.invalidateBranches(opts.worktreePath);
    }
    return target;
  }

  async branches(root: string): Promise<GitBranchInfo[]> {
    const key = cacheKey(root);
    const cached = this.branchDone.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.branchInFlight.get(key);
    if (inFlight) return inFlight;
    const promise = this.computeBranches(root).then((value) => {
      this.branchDone.set(key, { expiresAt: Date.now() + BRANCH_CACHE_TTL_MS, value });
      return value;
    }).finally(() => {
      if (this.branchInFlight.get(key) === promise) this.branchInFlight.delete(key);
    });
    this.branchInFlight.set(key, promise);
    return promise;
  }

  private invalidateBranches(root: string): void {
    const key = cacheKey(root);
    this.branchDone.delete(key);
    this.branchInFlight.delete(key);
  }

  private async computeBranches(root: string): Promise<GitBranchInfo[]> {
    const git = this.git(root);
    const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    const refs = (await git.raw(["for-each-ref", "--format=%(refname)%09%(refname:short)", "refs/heads", "refs/remotes"]))
      .replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [fullName, shortName] = line.split("\t");
        return { fullName, name: shortName };
      }).filter((ref) => ref.name && !ref.name.endsWith("/HEAD"));
    const worktrees = parseWorktreeList(await git.raw(["worktree", "list", "--porcelain"]));
    const locals = new Set(refs.filter((ref) => ref.fullName.startsWith("refs/heads/")).map((ref) => ref.name));
    const result: GitBranchInfo[] = [];
    for (const ref of refs) {
      const name = ref.name;
      const remote = ref.fullName.startsWith("refs/remotes/");
      const label = remote ? name.slice(name.indexOf("/") + 1) : name;
      if (remote && locals.has(label)) continue;
      result.push({ name, label, current: name === current, remote, worktreePath: worktrees.find((entry) => entry.branch === name)?.path ?? null });
    }
    return result.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || a.label.localeCompare(b.label));
  }

  async switchBranch(root: string, name: string, project?: Project): Promise<GitStatus> {
    if (!name || name.startsWith("-")) throw new Error("invalid branch name");
    const branches = await this.branches(root);
    const target = branches.find((item) => item.name === name);
    if (!target) throw new Error(`unknown branch '${name}'`);
    if (target.worktreePath && !sameWorktreePath(target.worktreePath, root)) throw new Error(`'${target.label}' is already checked out at ${target.worktreePath}`);
    const git = this.git(root);
    if (target.remote) await git.raw(["checkout", "--track", target.name]);
    else await git.checkout(target.name);
    const key = cacheKey(root);
    this.statusGeneration.set(key, (this.statusGeneration.get(key) ?? 0) + 1);
    this.statusDone.delete(key);
    this.statusInFlight.delete(key);
    this.invalidateBranches(root);
    return this.status(root, project);
  }

  async diff(root: string, mode: GitDiffMode, requestedBase?: string): Promise<GitDiffResult> {
    const key = `${cacheKey(root)}|${mode}|${requestedBase ?? ""}`;
    const inFlight = this.diffInFlight.get(key);
    if (inFlight) return inFlight;
    const promise = this.computeDiff(root, mode, requestedBase).finally(() => {
      if (this.diffInFlight.get(key) === promise) this.diffInFlight.delete(key);
    });
    this.diffInFlight.set(key, promise);
    return promise;
  }

  private truncatePatch(patch: string): string {
    if (patch.length <= DIFF_PATCH_MAX_BYTES) return patch;
    return `${patch.slice(0, DIFF_PATCH_MAX_BYTES)}\n…(truncated ${patch.length - DIFF_PATCH_MAX_BYTES} chars)`;
  }

  private async computeDiff(root: string, mode: GitDiffMode, requestedBase?: string): Promise<GitDiffResult> {
    const git = this.git(root);
    const binary = this.settings().gitBinaryPath;
    const headRef = (await git.revparse(["--abbrev-ref", "HEAD"])).trim() || "HEAD";
    let patch = "";
    let baseRef: string | null = null;
    if (mode === "staged") {
      patch = await execDiff(binary, ["diff", "--cached", "--no-ext-diff", "--binary", "--find-renames", "--"], root);
    } else if (mode === "branch") {
      const branches = await this.branches(root);
      if (requestedBase && !branches.some((item) => item.name === requestedBase)) throw new Error(`unknown comparison branch '${requestedBase}'`);
      baseRef = requestedBase || await this.defaultBase(root, headRef, branches);
      patch = await execDiff(binary, ["diff", "--no-ext-diff", "--binary", "--find-renames", `${baseRef}...HEAD`, "--"], root);
    } else {
      const base = requestedBase && (await this.isCommitAncestor(root, requestedBase)) ? requestedBase : "HEAD";
      patch = await execDiff(binary, ["diff", base, "--no-ext-diff", "--binary", "--find-renames", "--"], root);
      const summary = await git.status();
      const untracked = summary.not_added.filter((file) => !isAppManagedPath(file)).slice(0, UNTRACKED_DIFF_MAX_FILES);
      const parts = await mapLimit(untracked, 8, (file) =>
        execDiff(binary, ["diff", "--no-index", "--binary", "--", "/dev/null", file], root)
          .then((out) => (out.length > UNTRACKED_DIFF_MAX_BYTES_PER_FILE ? `${out.slice(0, UNTRACKED_DIFF_MAX_BYTES_PER_FILE)}\n…(truncated)` : out))
          .catch(() => "")
      );
      for (const part of parts) {
        if (!part) continue;
        patch += `${patch && !patch.endsWith("\n") ? "\n" : ""}${part}`;
        if (patch.length > DIFF_PATCH_MAX_BYTES) break;
      }
    }
    return { mode, patch: this.truncatePatch(patch), baseRef, headRef };
  }

  private async isCommitAncestor(root: string, sha: string): Promise<boolean> {
    const code = await exitCode(this.settings().gitBinaryPath, ["-C", root, "merge-base", "--is-ancestor", sha, "HEAD"]);
    if (code === 0) return true;
    if (code === 1) return false;
    throw new Error(`git merge-base failed with exit code ${code}`);
  }

  async headSha(repoRoot: string): Promise<string> {
    return (await this.git(repoRoot).revparse(["HEAD"])).trim();
  }

  private async defaultBase(root: string, headRef: string, branches: GitBranchInfo[]): Promise<string> {
    try {
      const upstream = (await this.git(root).revparse(["--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
      if (upstream) return upstream;
    } catch {
      // No upstream yet; prefer the repository's primary branch below.
    }
    for (const candidate of ["main", "master", "origin/main", "origin/master"]) {
      if (candidate !== headRef && branches.some((item) => item.name === candidate)) return candidate;
    }
    const fallback = branches.find((item) => !item.current);
    if (!fallback) throw new Error("no branch is available to compare against");
    return fallback.name;
  }

  async turnDiff(root: string, _since: number, baseSha?: string | null): Promise<string> {
    try {
      let base: string | undefined;
      if (baseSha) {
        try {
          if (await this.isCommitAncestor(root, baseSha)) base = baseSha;
        } catch (err) {
          console.warn(`git: unable to validate turn base sha in ${root}: ${(err as Error).message}`);
        }
      }
      return (await this.diff(root, "working", base)).patch;
    } catch (err) {
      return `diff unavailable: ${(err as Error).message}`;
    }
  }

  private async remote(root: string): Promise<ParsedGitHubRemote | null> {
    const git = this.git(root);
    let url = "";
    try {
      url = (await git.raw(["remote", "get-url", "origin"])).trim();
    } catch {
      try {
        const first = (await git.raw(["remote"])).replace(/\r/g, "").split("\n").find(Boolean);
        if (first) url = (await git.raw(["remote", "get-url", first])).trim();
      } catch {
        return null;
      }
    }
    return parseGitHubRemote(url);
  }

  private async tokenFor(root: string, remote: ParsedGitHubRemote, login: string): Promise<string> {
    return (await execText(this.settings().githubCliBinaryPath, ["auth", "token", "--hostname", remote.host, "--user", login], root, 8_000, cleanAuthEnvironment())).trim();
  }

  private async accountsFor(root: string, remote: ParsedGitHubRemote): Promise<GitHubAccountInfo[]> {
    const key = `${this.settings().githubCliBinaryPath}|${remote.host}|${remote.slug}`;
    const cached = this.accountCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.accounts.map((account) => ({ ...account }));
    const stdout = await execText(this.settings().githubCliBinaryPath, ["auth", "status", "--json", "hosts"], root, 10_000, cleanAuthEnvironment());
    const accounts = parseGitHubAccounts(stdout).filter((account) => account.host.toLowerCase() === remote.host);
    await Promise.all(accounts.map(async (account) => {
      if (!account.authenticated) {
        account.hasRepositoryAccess = false;
        return;
      }
      try {
        const token = await this.tokenFor(root, remote, account.login);
        if (!token) throw new Error("empty token");
        await execText(this.settings().githubCliBinaryPath, ["repo", "view", `${remote.host}/${remote.slug}`, "--json", "nameWithOwner"], root, 8_000, authenticatedEnvironment(remote.host, token));
        account.hasRepositoryAccess = true;
      } catch {
        account.hasRepositoryAccess = false;
      }
    }));
    this.accountCache.set(key, { expiresAt: Date.now() + 5 * 60_000, accounts: accounts.map((account) => ({ ...account })) });
    return accounts;
  }

  private async githubContext(root: string, project?: Project): Promise<{ remote: ParsedGitHubRemote | null; accounts: GitHubAccountInfo[]; selection: AccountSelection }> {
    const remote = await this.remote(root);
    if (!remote) return { remote: null, accounts: [], selection: { account: null, source: "none", error: null } };
    try {
      const accounts = await this.accountsFor(root, remote);
      return { remote, accounts, selection: selectGitHubAccount(accounts, remote.host, remote.owner, project?.githubAccount) };
    } catch (error) {
      return { remote, accounts: [], selection: { account: null, source: "none", error: (error as Error).message || "GitHub CLI unavailable" } };
    }
  }

  private async binaryHealth(binary: string, args: string[], cwd: string): Promise<SourceControlBinaryHealth> {
    try {
      const stdout = await execText(binary, args, cwd, 10_000);
      return { path: binary, available: true, version: stdout.replace(/\r/g, "").split("\n")[0]?.trim() || null, error: null };
    } catch (error) {
      return { path: binary, available: false, version: null, error: (error as Error).message || `Could not run ${binary}` };
    }
  }

  async health(root?: string, project?: Project): Promise<SourceControlHealth> {
    const settings = this.settings();
    const cwd = root || process.cwd();
    const [gitHealth, githubCli] = await Promise.all([
      this.binaryHealth(settings.gitBinaryPath, ["--version"], cwd),
      this.binaryHealth(settings.githubCliBinaryPath, ["--version"], cwd)
    ]);
    const repository: SourceControlHealth["repository"] = {
      available: false, root: null, branch: null, remoteUrl: null, githubHost: null,
      githubRepository: null, userName: null, userEmail: null, error: null
    };
    let github: SourceControlHealth["github"] = { accounts: [], selectedAccount: null, selectionSource: "none", error: null };
    if (root && gitHealth.available) {
      try {
        const git = this.git(root);
        if (!(await git.checkIsRepo())) repository.error = "The selected project is not a Git repository";
        else {
          repository.available = true;
          repository.root = await this.repositoryRoot(root);
          repository.branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim() || "detached";
          const remote = await this.remote(root);
          repository.remoteUrl = remote?.url ?? null;
          repository.githubHost = remote?.host ?? null;
          repository.githubRepository = remote?.slug ?? null;
          const readConfig = async (key: string): Promise<string | null> => {
            try { return (await git.raw(["config", "--get", key])).trim() || null; } catch { return null; }
          };
          [repository.userName, repository.userEmail] = await Promise.all([readConfig("user.name"), readConfig("user.email")]);
          if (remote && githubCli.available) {
            const context = await this.githubContext(root, project);
            github = { accounts: context.accounts, selectedAccount: context.selection.account?.login ?? null, selectionSource: context.selection.source, error: context.selection.error };
          }
        }
      } catch (error) {
        repository.error = (error as Error).message;
      }
    }
    const issues: SourceControlHealth["issues"] = [];
    if (!gitHealth.available) issues.push({ level: "error", message: `Git CLI not found at '${gitHealth.path}'` });
    if (!githubCli.available) issues.push({ level: "error", message: `GitHub CLI not found at '${githubCli.path}'` });
    if (root && gitHealth.available && !repository.available) issues.push({ level: "warning", message: repository.error || "Project is not a Git repository" });
    if (repository.available && !repository.remoteUrl) issues.push({ level: "warning", message: "No parseable Git remote was found" });
    if (repository.available && (!repository.userName || !repository.userEmail)) issues.push({ level: "warning", message: "Git commit name or email is not configured" });
    if (github.error) issues.push({ level: "error", message: github.error });
    return { git: gitHealth, githubCli, repository, github, issues };
  }

  async setRepositoryIdentity(root: string, name: string, email: string): Promise<void> {
    const git = this.git(root);
    const setOrUnset = async (key: string, value: string): Promise<void> => {
      const trimmed = value.trim();
      if (trimmed) await git.raw(["config", "--local", key, trimmed]);
      else {
        try { await git.raw(["config", "--local", "--unset-all", key]); } catch { /* Already unset. */ }
      }
    };
    await Promise.all([setOrUnset("user.name", name), setOrUnset("user.email", email)]);
  }

  async status(root: string, project?: Project): Promise<GitStatus> {
    const key = cacheKey(root);
    const cached = this.statusDone.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.statusInFlight.get(key);
    if (inFlight) return inFlight.promise;
    const generation = this.statusGeneration.get(key) ?? 0;
    const promise = this.computeStatus(root, project).then((value) => {
      if ((this.statusGeneration.get(key) ?? 0) === generation) {
        this.statusDone.set(key, { expiresAt: Date.now() + STATUS_CACHE_TTL_MS, value });
      }
      return value;
    }).finally(() => {
      const current = this.statusInFlight.get(key);
      if (current?.generation === generation) this.statusInFlight.delete(key);
    });
    this.statusInFlight.set(key, { generation, promise });
    return promise;
  }

  private async cachedPullRequest(root: string, branch: string, remote: ParsedGitHubRemote, account: GitHubAccountInfo): Promise<{ pullRequest: GitPullRequest | null; error: string | null }> {
    const key = `${cacheKey(root)}|${branch}|${account.login}`;
    const cached = this.prCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await queryPullRequest(root, this.settings().githubCliBinaryPath, remote, account);
    if (value.error === null) this.prCache.set(key, { expiresAt: Date.now() + PR_CACHE_TTL_MS, value });
    return value;
  }

  private async computeStatus(root: string, project?: Project): Promise<GitStatus> {
    const fallback: GitStatus = {
      available: false,
      branch: "not a repository",
      dirtyCount: 0,
      addedLines: 0,
      deletedLines: 0,
      stagedCount: 0,
      ahead: 0,
      behind: 0,
      isWorktree: false,
      worktreeName: worktreeNameFor(root),
      worktreePath: resolve(root),
      repositoryRoot: resolve(root),
      prNumber: null,
      pullRequest: null,
      githubError: null,
      githubHost: null,
      githubAccount: null,
      githubAccountSource: "none",
      clean: true
    };
    try {
      const git = this.git(root);
      if (!(await git.checkIsRepo())) return fallback;
      const [repositoryRoot, branch, summary, context, isWorktree] = await Promise.all([
        this.repositoryRoot(root),
        git.revparse(["--abbrev-ref", "HEAD"]).then((value) => value.trim() || "detached"),
        git.status(),
        this.githubContext(root, project),
        this.isLinkedWorktree(root)
      ]);
      const [github, lineCounts] = await Promise.all([
        context.remote && context.selection.account
          ? this.cachedPullRequest(root, branch, context.remote, context.selection.account)
          : Promise.resolve({ pullRequest: null, error: context.selection.error }),
        this.lineCounts(root)
      ]);
      const visibleFiles = summary.files.filter((file) => !isAppManagedPath(file.path));
      const dirtyCount = visibleFiles.length;
      const stagedCount = visibleFiles.filter((file) => file.index !== " " && file.index !== "?").length;
      return {
        available: true,
        branch,
        dirtyCount,
        addedLines: lineCounts.addedLines,
        deletedLines: lineCounts.deletedLines,
        stagedCount,
        ahead: summary.ahead,
        behind: summary.behind,
        isWorktree,
        worktreeName: basename(resolve(root)),
        worktreePath: resolve(root),
        repositoryRoot,
        prNumber: github.pullRequest?.number ?? null,
        pullRequest: github.pullRequest,
        githubError: github.error,
        githubHost: context.remote?.host ?? null,
        githubAccount: context.selection.account?.login ?? null,
        githubAccountSource: context.selection.source,
        clean: dirtyCount === 0
      };
    } catch (err) {
      console.warn(`git status failed for ${root}: ${(err as Error).message}`);
      return fallback;
    }
  }
}
