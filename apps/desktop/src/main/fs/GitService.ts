import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import type { GitBranchInfo, GitDiffMode, GitDiffResult, GitPullRequest, GitStatus } from "@cw-code/contracts";

export interface CreatedWorktree {
  path: string;
  branch: string;
  repositoryRoot: string;
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

export function parsePrNumber(stdout: string): number | null {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function worktreeNameFor(root: string): string {
  const stripped = root.replace(/[\\/]+$/, "");
  return stripped.split(/[/\\]/).filter(Boolean).pop() ?? stripped;
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

function execText(command: string, args: string[], cwd: string, timeout = 10_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim()));
      resolvePromise(String(stdout));
    });
  });
}

function execDiff(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as unknown as { code?: unknown } | null)?.code;
      if (error && code !== 1) return reject(new Error(String(stderr || error.message).trim()));
      resolvePromise(String(stdout));
    });
  });
}

async function queryPullRequest(root: string): Promise<{ pullRequest: GitPullRequest | null; error: string | null }> {
  try {
    const stdout = await execText("gh", [
      "pr", "view", "--json",
      "number,title,url,state,isDraft,reviewDecision,mergeStateStatus,headRefName,baseRefName,statusCheckRollup"
    ], root, 8_000);
    return { pullRequest: parsePullRequest(stdout), error: null };
  } catch (error) {
    const message = (error as Error).message;
    if (/no pull requests? found/i.test(message)) return { pullRequest: null, error: null };
    return { pullRequest: null, error: message || "GitHub CLI unavailable" };
  }
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a).replace(/[\\/]+$/, "");
  const right = resolve(b).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workspace";
}

export class GitService {
  async isRepository(root: string): Promise<boolean> {
    try {
      return await simpleGit(root).checkIsRepo();
    } catch {
      return false;
    }
  }

  async repositoryRoot(root: string): Promise<string> {
    const value = (await simpleGit(root).revparse(["--show-toplevel"])).trim();
    if (!value) throw new Error(`${root} is not a Git repository`);
    return resolve(value);
  }

  async createWorktree(projectRoot: string, projectKey: string, sessionId: string, worktreesRoot: string, requestedBase?: string): Promise<CreatedWorktree> {
    const repositoryRoot = await this.repositoryRoot(projectRoot);
    const git = simpleGit(repositoryRoot);
    const branches = await this.branches(repositoryRoot);
    const current = branches.find((item) => item.current)?.name;
    const base = requestedBase?.trim() || current || "HEAD";
    if (base !== "HEAD" && !branches.some((item) => item.name === base)) throw new Error(`unknown base branch '${base}'`);
    const branch = `cw/${safeSegment(sessionId.replace(/^sess_/, ""))}`;
    const parent = join(worktreesRoot, safeSegment(projectKey));
    const target = join(parent, safeSegment(sessionId));
    mkdirSync(parent, { recursive: true });
    try {
      await git.raw(["worktree", "add", "-b", branch, target, base]);
    } catch (error) {
      throw new Error(`could not create worktree from '${base}': ${(error as Error).message}`);
    }
    return { path: resolve(target), branch, repositoryRoot };
  }

  async branches(root: string): Promise<GitBranchInfo[]> {
    const git = simpleGit(root);
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

  async switchBranch(root: string, name: string): Promise<GitStatus> {
    if (!name || name.startsWith("-")) throw new Error("invalid branch name");
    const branches = await this.branches(root);
    const target = branches.find((item) => item.name === name);
    if (!target) throw new Error(`unknown branch '${name}'`);
    if (target.worktreePath && !samePath(target.worktreePath, root)) throw new Error(`'${target.label}' is already checked out at ${target.worktreePath}`);
    const git = simpleGit(root);
    if (target.remote) await git.raw(["checkout", "--track", target.name]);
    else await git.checkout(target.name);
    return this.status(root);
  }

  async diff(root: string, mode: GitDiffMode, requestedBase?: string): Promise<GitDiffResult> {
    const git = simpleGit(root);
    const headRef = (await git.revparse(["--abbrev-ref", "HEAD"])).trim() || "HEAD";
    let patch = "";
    let baseRef: string | null = null;
    if (mode === "staged") {
      patch = await execDiff(["diff", "--cached", "--no-ext-diff", "--binary", "--find-renames", "--"], root);
    } else if (mode === "branch") {
      const branches = await this.branches(root);
      if (requestedBase && !branches.some((item) => item.name === requestedBase)) throw new Error(`unknown comparison branch '${requestedBase}'`);
      baseRef = requestedBase || await this.defaultBase(root, headRef, branches);
      patch = await execDiff(["diff", "--no-ext-diff", "--binary", "--find-renames", `${baseRef}...HEAD`, "--"], root);
    } else {
      patch = await execDiff(["diff", "HEAD", "--no-ext-diff", "--binary", "--find-renames", "--"], root);
      const summary = await git.status();
      for (const file of summary.not_added) {
        const untracked = await execDiff(["diff", "--no-index", "--binary", "--", "/dev/null", file], root);
        patch += `${patch && !patch.endsWith("\n") ? "\n" : ""}${untracked}`;
      }
    }
    return { mode, patch, baseRef, headRef };
  }

  private async defaultBase(root: string, headRef: string, branches: GitBranchInfo[]): Promise<string> {
    try {
      const upstream = (await simpleGit(root).revparse(["--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
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

  async turnDiff(root: string, _since: number): Promise<string> {
    try {
      return (await this.diff(root, "working")).patch;
    } catch (err) {
      return `diff unavailable: ${(err as Error).message}`;
    }
  }

  async status(root: string): Promise<GitStatus> {
    const fallback: GitStatus = {
      available: false,
      branch: "not a repository",
      dirtyCount: 0,
      stagedCount: 0,
      ahead: 0,
      behind: 0,
      worktreeName: worktreeNameFor(root),
      worktreePath: resolve(root),
      repositoryRoot: resolve(root),
      prNumber: null,
      pullRequest: null,
      githubError: null,
      clean: true
    };
    try {
      const git = simpleGit(root);
      if (!(await git.checkIsRepo())) return fallback;
      const [repositoryRoot, branch, summary, github] = await Promise.all([
        this.repositoryRoot(root),
        git.revparse(["--abbrev-ref", "HEAD"]).then((value) => value.trim() || "detached"),
        git.status(),
        queryPullRequest(root)
      ]);
      const dirtyCount = summary.files.length;
      const stagedCount = summary.files.filter((file) => file.index !== " " && file.index !== "?").length;
      return {
        available: true,
        branch,
        dirtyCount,
        stagedCount,
        ahead: summary.ahead,
        behind: summary.behind,
        worktreeName: basename(resolve(root)),
        worktreePath: resolve(root),
        repositoryRoot,
        prNumber: github.pullRequest?.number ?? null,
        pullRequest: github.pullRequest,
        githubError: github.error,
        clean: dirtyCount === 0
      };
    } catch (err) {
      console.warn(`git status failed for ${root}: ${(err as Error).message}`);
      return fallback;
    }
  }
}
