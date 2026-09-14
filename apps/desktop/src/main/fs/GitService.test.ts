import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, countUntrackedLines, isAppManagedPath, mapLimit, parseGitHubAccounts, parseGitHubRemote, parseNumstat, parsePrNumber, parsePullRequest, parseWorktreeList, selectGitHubAccount, worktreeNameFor } from "./GitService.js";

function initSandbox(): { sandbox: string; repository: string; service: GitService } {
  const sandbox = mkdtempSync(join(tmpdir(), "cw-git-"));
  const repository = join(sandbox, "repo");
  execFileSync("git", ["init", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "base\n", "utf8");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);
  return { sandbox, repository, service: new GitService() };
}

describe("parsePrNumber", () => {
  it("parses a PR number", () => {
    expect(parsePrNumber("21\n")).toBe(21);
  });

  it("returns null for empty or invalid output", () => {
    expect(parsePrNumber("")).toBeNull();
    expect(parsePrNumber("nope")).toBeNull();
  });
});

describe("worktreeNameFor", () => {
  it("takes the last path segment", () => {
    expect(worktreeNameFor("C:\\Projects\\cw-code")).toBe("cw-code");
    expect(worktreeNameFor("/repo/my-worktree/")).toBe("my-worktree");
  });
});

describe("isAppManagedPath", () => {
  it("matches the .cw app-managed directory in posix and windows forms", () => {
    expect(isAppManagedPath(".cw")).toBe(true);
    expect(isAppManagedPath(".cw/pastes/x.png")).toBe(true);
    expect(isAppManagedPath(".cw\\pastes\\x.png")).toBe(true);
    expect(isAppManagedPath("src/.cw/x.png")).toBe(false);
    expect(isAppManagedPath(".cwutils/x.png")).toBe(false);
    expect(isAppManagedPath("src/main.ts")).toBe(false);
  });
});

describe("parseWorktreeList", () => {
  it("maps checked out branches to their worktree paths", () => {
    expect(parseWorktreeList([
      "worktree C:/repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree C:/repo-feature",
      "HEAD def",
      "branch refs/heads/feature/topic",
      ""
    ].join("\n"))).toEqual([
      { path: "C:/repo", branch: "main" },
      { path: "C:/repo-feature", branch: "feature/topic" }
    ]);
  });
});

describe("parsePullRequest", () => {
  it("summarizes PR state and checks", () => {
    const parsed = parsePullRequest(JSON.stringify({
      number: 42,
      title: "Worktrees",
      url: "https://github.com/acme/repo/pull/42",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      headRefName: "feature",
      baseRefName: "main",
      statusCheckRollup: [
        { conclusion: "SUCCESS" },
        { conclusion: "FAILURE" },
        { status: "IN_PROGRESS" }
      ]
    }));
    expect(parsed).toMatchObject({
      number: 42,
      state: "OPEN",
      checks: { total: 3, passed: 1, failed: 1, pending: 1 }
    });
  });

  it("degrades gracefully for invalid gh output", () => {
    expect(parsePullRequest("not-json")).toBeNull();
  });
});

describe("parseNumstat", () => {
  it("sums text changes and counts each binary file as one addition", () => {
    expect(parseNumstat("12\t3\tsrc/app.ts\n4\t0\tREADME.md\n-\t-\timage.png\n-\t-\tfont.woff2\n"))
      .toEqual({ addedLines: 18, deletedLines: 3 });
  });
});

describe("GitHub account discovery", () => {
  const accounts = parseGitHubAccounts(JSON.stringify({ hosts: { "github.com": [
    { login: "personal", active: true, state: "success" },
    { login: "acme", active: false, state: "success" }
  ] } }));

  it("parses HTTPS and SSH remotes", () => {
    expect(parseGitHubRemote("https://github.com/acme/app.git")).toMatchObject({ host: "github.com", owner: "acme", repository: "app", slug: "acme/app" });
    expect(parseGitHubRemote("git@github.example.com:team/service.git")).toMatchObject({ host: "github.example.com", owner: "team", repository: "service" });
  });

  it("prefers a matching repository owner without changing the active account", () => {
    expect(selectGitHubAccount(accounts, "github.com", "acme")).toMatchObject({ account: { login: "acme" }, source: "owner", error: null });
  });

  it("honors a project override and reports stale selections", () => {
    expect(selectGitHubAccount(accounts, "github.com", "org", { host: "github.com", login: "personal" })).toMatchObject({ account: { login: "personal" }, source: "project" });
    expect(selectGitHubAccount(accounts, "github.com", "org", { host: "github.com", login: "missing" })).toMatchObject({ account: null, source: "project" });
  });

  it("selects the only account with repository access", () => {
    const checked = accounts.map((account) => ({ ...account, hasRepositoryAccess: account.login === "acme" }));
    expect(selectGitHubAccount(checked, "github.com", "company-org")).toMatchObject({ account: { login: "acme" }, source: "access" });
    expect(selectGitHubAccount(checked, "github.com", "company-org", { host: "github.com", login: "personal" })).toMatchObject({ account: null, source: "project" });
  });
});

describe("mapLimit", () => {
  it("never exceeds the concurrency limit and preserves input order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const results = await mapLimit(items, 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return item * 10;
    });
    expect(maxInFlight).toBe(3);
    expect(results).toEqual(items.map((item) => item * 10));
  });

  it("clamps a non-positive limit to one concurrent invocation", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapLimit([1, 2, 3], 0, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item;
    });
    expect(maxInFlight).toBe(1);
    expect(results).toEqual([1, 2, 3]);
  });

  it("handles a limit larger than the item count", async () => {
    const results = await mapLimit(["a", "b", "c"], 50, async (item) => item.toUpperCase());
    expect(results).toEqual(["A", "B", "C"]);
  });
});

describe("countUntrackedLines", () => {
  it("counts lines like git numstat would for a new file", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-lines-"));
    writeFileSync(join(sandbox, "trailing.txt"), "a\nb\nc\n");
    writeFileSync(join(sandbox, "no-trailing.txt"), "a\nb\nc");
    writeFileSync(join(sandbox, "empty.txt"), "");

    expect(await countUntrackedLines(sandbox, "trailing.txt")).toEqual({ addedLines: 3, deletedLines: 0 });
    expect(await countUntrackedLines(sandbox, "no-trailing.txt")).toEqual({ addedLines: 3, deletedLines: 0 });
    expect(await countUntrackedLines(sandbox, "empty.txt")).toEqual({ addedLines: 0, deletedLines: 0 });
  });

  it("counts CRLF lines and a bare newline like git numstat", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-lines-"));
    writeFileSync(join(sandbox, "crlf.txt"), "a\r\nb\r\nc\r\n");
    writeFileSync(join(sandbox, "bare.txt"), "\n");

    expect(await countUntrackedLines(sandbox, "crlf.txt")).toEqual({ addedLines: 3, deletedLines: 0 });
    expect(await countUntrackedLines(sandbox, "bare.txt")).toEqual({ addedLines: 1, deletedLines: 0 });
  });

  it("treats UTF-16 content as a single added line", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-lines-"));
    writeFileSync(join(sandbox, "utf16.txt"), Buffer.from("a\nb\n", "utf16le"));

    expect(await countUntrackedLines(sandbox, "utf16.txt")).toEqual({ addedLines: 1, deletedLines: 0 });
  });

  it("treats a symbolic link as a single added line", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-lines-"));
    writeFileSync(join(sandbox, "target.txt"), "a\nb\nc\nd\ne\n");
    try {
      symlinkSync(join(sandbox, "target.txt"), join(sandbox, "link.txt"));
    } catch {
      return;
    }

    expect(await countUntrackedLines(sandbox, "link.txt")).toEqual({ addedLines: 1, deletedLines: 0 });
  });

  it("treats binary content as a single added line", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-lines-"));
    writeFileSync(join(sandbox, "blob.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));

    expect(await countUntrackedLines(sandbox, "blob.bin")).toEqual({ addedLines: 1, deletedLines: 0 });
  });

  it("treats an oversized text file as a single added line", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-lines-"));
    const chunk = "x".repeat(1024) + "\n";
    writeFileSync(join(sandbox, "huge.txt"), chunk.repeat(11 * 1024));

    expect(await countUntrackedLines(sandbox, "huge.txt")).toEqual({ addedLines: 1, deletedLines: 0 });
  });

  it("rejects for a missing file", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-lines-"));
    await expect(countUntrackedLines(sandbox, "gone.txt")).rejects.toThrow();
  });
});

describe("GitService worktrees", () => {
  it("creates an isolated session branch and includes untracked files in its diff", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-git-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

    const service = new GitService();
    expect(await service.status(repository)).toMatchObject({ available: true, isWorktree: false });
    const created = await service.createWorktree(repository, "project", "sess_1234abcd", join(sandbox, "worktrees"), "main");
    expect(created.branch).toBe("cw/1234abcd");
    expect(existsSync(created.path)).toBe(true);

    writeFileSync(join(created.path, "README.md"), "updated\nsecond line\n", "utf8");
    writeFileSync(join(created.path, "new-file.txt"), "untracked\n", "utf8");
    const diff = await service.diff(created.path, "working");
    expect(diff.patch).toContain("new-file.txt");
    expect(diff.patch).toContain("+untracked");

    const status = await service.status(created.path);
    expect(status).toMatchObject({
      available: true,
      branch: "cw/1234abcd",
      dirtyCount: 2,
      addedLines: 3,
      deletedLines: 1,
      isWorktree: true
    });
    const branches = await service.branches(created.path);
    expect(branches.find((branch) => branch.name === "cw/1234abcd")?.worktreePath).toBe(created.path.replace(/\\/g, "/"));
  });

  it("removes a clean worktree and its empty session directory", async () => {
    const { sandbox, repository, service } = initSandbox();
    const worktreesRoot = join(sandbox, "worktrees");
    const created = await service.createWorktree(repository, "project", "sess_clean1", worktreesRoot, "main");
    expect(existsSync(created.path)).toBe(true);

    const result = await service.removeWorktree(repository, created.path);
    expect(result).toEqual({ removed: true });
    expect(existsSync(created.path)).toBe(false);
  });

  it("refuses a dirty worktree without force and removes it with force", async () => {
    const { sandbox, repository, service } = initSandbox();
    const worktreesRoot = join(sandbox, "worktrees");
    const created = await service.createWorktree(repository, "project", "sess_dirty1", worktreesRoot, "main");
    writeFileSync(join(created.path, "README.md"), "dirty\n", "utf8");

    const blocked = await service.removeWorktree(repository, created.path);
    expect(blocked).toEqual({ removed: false, dirtyBlocked: true });
    expect(existsSync(created.path)).toBe(true);

    const forced = await service.removeWorktree(repository, created.path, { force: true });
    expect(forced).toEqual({ removed: true });
    expect(existsSync(created.path)).toBe(false);
  });

  it("treats an already-gone worktree path as a no-op prune", async () => {
    const { sandbox, repository, service } = initSandbox();
    const worktreesRoot = join(sandbox, "worktrees");
    const created = await service.createWorktree(repository, "project", "sess_gone1", worktreesRoot, "main");
    execFileSync("git", ["-C", repository, "worktree", "remove", "--force", created.path]);

    const result = await service.removeWorktree(repository, created.path);
    expect(result).toEqual({ removed: false });
    const recreated = await service.createWorktree(repository, "project", "sess_gone1", worktreesRoot, "main");
    expect(existsSync(recreated.path)).toBe(true);
  });

  it("suffixed the session branch when the cw/<id> branch already exists", async () => {
    const { sandbox, repository, service } = initSandbox();
    execFileSync("git", ["-C", repository, "branch", "cw/1234abcd"]);
    const created = await service.createWorktree(repository, "project", "sess_1234abcd", join(sandbox, "worktrees"), "main");
    expect(created.branch).toBe("cw/1234abcd-1");
    const branches = await service.branches(repository);
    expect(branches.some((branch) => branch.name === "cw/1234abcd-1")).toBe(true);
  });

  it("renames a branch and suffixes the target on collision", async () => {
    const { repository, service } = initSandbox();
    execFileSync("git", ["-C", repository, "branch", "feature"]);
    expect(await service.renameBranch(repository, "feature", "renamed")).toBe("renamed");
    const branches = await service.branches(repository);
    expect(branches.some((branch) => branch.name === "renamed")).toBe(true);
    expect(branches.some((branch) => branch.name === "feature")).toBe(false);

    execFileSync("git", ["-C", repository, "branch", "other"]);
    expect(await service.renameBranch(repository, "other", "renamed")).toBe("renamed-1");
    const after = await service.branches(repository);
    expect(after.some((branch) => branch.name === "renamed-1")).toBe(true);
    expect(after.some((branch) => branch.name === "other")).toBe(false);
  });

  it("returns the target unchanged when renaming a branch to its own name", async () => {
    const { repository, service } = initSandbox();
    expect(await service.renameBranch(repository, "main", "main")).toBe("main");
    const branches = await service.branches(repository);
    expect(branches.some((branch) => branch.name === "main")).toBe(true);
    expect(branches.some((branch) => branch.name === "main-1")).toBe(false);
  });

  it("refreshes the worktree-path caches when renaming a checked-out branch", async () => {
    const { sandbox, repository, service } = initSandbox();
    const created = await service.createWorktree(repository, "project", "sess_rename1", join(sandbox, "worktrees"), "main");
    expect(await service.status(created.path)).toMatchObject({ branch: created.branch });
    const before = await service.branches(created.path);
    expect(before.some((branch) => branch.name === created.branch)).toBe(true);

    const renamed = await service.renameBranch(repository, created.branch, "cw/renamed", { worktreePath: created.path });
    expect(renamed).toBe("cw/renamed");
    expect(await service.status(created.path)).toMatchObject({ branch: "cw/renamed" });
    const after = await service.branches(created.path);
    expect(after.some((branch) => branch.name === "cw/renamed")).toBe(true);
    expect(after.some((branch) => branch.name === created.branch)).toBe(false);
  });

  it("leaves no orphan branch when the worktree target directory is occupied", async () => {
    const { sandbox, repository, service } = initSandbox();
    const worktreesRoot = join(sandbox, "worktrees");
    const target = join(worktreesRoot, "project", "sess_orphan1");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "blocker.txt"), "occupied\n", "utf8");

    await expect(service.createWorktree(repository, "project", "sess_orphan1", worktreesRoot, "main")).rejects.toThrow("could not create worktree from 'main'");
    const refs = execFileSync("git", ["-C", repository, "for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding: "utf8" });
    expect(refs.split("\n")).not.toContain("cw/orphan1");
  });

  it("prunes stale worktree admin entries so the same path can be reused", async () => {
    const { sandbox, repository, service } = initSandbox();
    const worktreesRoot = join(sandbox, "worktrees");
    const created = await service.createWorktree(repository, "project", "sess_prune1", worktreesRoot, "main");
    execFileSync("git", ["-C", repository, "worktree", "remove", "--force", created.path]);
    writeFileSync(join(repository, "README.md"), "dirty\n", "utf8");

    const stale = await service.createWorktree(repository, "project", "sess_prune1", worktreesRoot, "main");
    expect(existsSync(stale.path)).toBe(true);
    expect(stale.branch).toBe("cw/prune1-1");
    await service.removeWorktree(repository, stale.path, { force: true });
    expect(existsSync(stale.path)).toBe(false);
    await service.pruneWorktrees(repository, worktreesRoot);
    expect(existsSync(join(worktreesRoot, "project"))).toBe(false);
    const recreated = await service.createWorktree(repository, "project", "sess_prune1", worktreesRoot, "main");
    expect(existsSync(recreated.path)).toBe(true);
    expect(recreated.branch).toBe("cw/prune1-2");
    expect(await service.removeWorktree(repository, recreated.path, { force: true })).toEqual({ removed: true });
  });

  it("removes empty project and session directories when pruning", async () => {
    const { repository, service } = initSandbox();
    const worktreesRoot = join(repository, "wt-root");
    const projectDir = join(worktreesRoot, "project");
    const sessionDir = join(projectDir, "sess_empty1");
    execFileSync("git", ["-C", repository, "worktree", "add", "-b", "cw/empty1", sessionDir, "main"]);
    execFileSync("git", ["-C", repository, "worktree", "remove", "--force", sessionDir]);
    mkdirSync(sessionDir, { recursive: true });

    await service.pruneWorktrees(repository, worktreesRoot);
    expect(existsSync(sessionDir)).toBe(false);
    expect(existsSync(projectDir)).toBe(false);
  });

  it("counts untracked files in status", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-git-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

    let expectedAdded = 0;
    for (let i = 1; i <= 25; i++) {
      writeFileSync(join(repository, `untracked-${i}.txt`), Array.from({ length: i }, (_, line) => `line ${line}`).join("\n") + "\n", "utf8");
      expectedAdded += i;
    }

    const service = new GitService();
    const status = await service.status(repository);
    expect(status).toMatchObject({
      available: true,
      addedLines: expectedAdded,
      deletedLines: 0
    });
  });

  it("shares one computation for concurrent status calls on the same root", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-git-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

    const service = new GitService();
    const [first, second] = await Promise.all([service.status(repository), service.status(repository)]);
    const third = await service.status(repository);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("recomputes status after a branch switch instead of serving cache", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-git-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);
    execFileSync("git", ["-C", repository, "branch", "feature"]);

    const service = new GitService();
    expect((await service.status(repository)).branch).toBe("main");
    const switched = await service.switchBranch(repository, "feature");
    expect(switched.branch).toBe("feature");
    expect((await service.status(repository)).branch).toBe("feature");
  });

  it("deletes merged branches with -d and reports unmergedCommits when forced", async () => {
    const { repository, service } = initSandbox();

    execFileSync("git", ["-C", repository, "branch", "cw/merged"]);
    expect(await service.deleteBranch(repository, "cw/merged")).toEqual({ deleted: true, unmergedCommits: false });

    execFileSync("git", ["-C", repository, "checkout", "-b", "cw/unmerged"]);
    writeFileSync(join(repository, "wip.txt"), "work\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "wip.txt"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "wip"]);
    execFileSync("git", ["-C", repository, "checkout", "main"]);

    expect(await service.deleteBranch(repository, "cw/unmerged")).toEqual({ deleted: false, unmergedCommits: false });
    expect(execFileSync("git", ["-C", repository, "branch", "--list", "cw/unmerged"], { encoding: "utf8" }).trim()).not.toBe("");

    expect(await service.deleteBranch(repository, "cw/unmerged", { force: true })).toEqual({ deleted: true, unmergedCommits: true });
    expect(execFileSync("git", ["-C", repository, "branch", "--list", "cw/unmerged"], { encoding: "utf8" }).trim()).toBe("");
  });

  it("turnDiff scopes changes to the recorded base sha and falls back when it is invalid", async () => {
    const { sandbox, repository, service } = initSandbox();
    const created = await service.createWorktree(repository, "project", "sess_turndiff", join(sandbox, "worktrees"), "main");
    const baseSha = await service.headSha(created.path);

    writeFileSync(join(created.path, "README.md"), "turn\n", "utf8");
    writeFileSync(join(created.path, "new-file.txt"), "untracked\n", "utf8");
    const patch = await service.turnDiff(created.path, Date.now(), baseSha);
    expect(patch).toBe((await service.diff(created.path, "working", baseSha)).patch);
    expect(patch).toContain("+turn");
    expect(patch).toContain("new-file.txt");
    expect(patch).toContain("+untracked");

    execFileSync("git", ["-C", created.path, "add", "-A"]);
    execFileSync("git", ["-C", created.path, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "turn commit"]);
    writeFileSync(join(created.path, "later.txt"), "after commit\n", "utf8");

    const turnPatch = await service.turnDiff(created.path, Date.now(), baseSha);
    expect(turnPatch).toContain("README.md");
    expect(turnPatch).toContain("later.txt");

    const fallback = await service.turnDiff(created.path, Date.now(), "0".repeat(40));
    expect(fallback).toBe((await service.diff(created.path, "working")).patch);
    expect(fallback).not.toContain("README.md");
    expect(fallback).toContain("later.txt");

    const noBase = await service.turnDiff(created.path, Date.now(), null);
    expect(noBase).toBe(fallback);
  });
});
