import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, countUntrackedLines, gitPathTarget, isAppManagedPath, mapLimit, parseGitHubAccounts, parseGitHubRemote, parseNumstat, parsePorcelainV2Status, parsePrNumber, parsePullRequest, parseWorktreeList, selectGitHubAccount, sweepStaleSnapshotIndexes, worktreeNameFor } from "./GitService.js";

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

  it("reports commits ahead of the base branch in status", async () => {
    const { sandbox, repository, service } = initSandbox();
    const created = await service.createWorktree(repository, "project", "sess_baseahead1", join(sandbox, "worktrees"), "main");

    const fresh = await service.status(created.path);
    expect(fresh).toMatchObject({ available: true, baseRef: "main", baseAhead: 0, baseBehind: 0 });

    writeFileSync(join(created.path, "feature.txt"), "work\n", "utf8");
    execFileSync("git", ["-C", created.path, "add", "feature.txt"]);
    execFileSync("git", ["-C", created.path, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "feature work"]);
    const afterCommit = await new GitService().status(created.path);
    expect(afterCommit).toMatchObject({ available: true, baseRef: "main", baseAhead: 1, baseBehind: 0 });

    const branchDiff = await service.diff(created.path, "branch", "main");
    expect(branchDiff.baseRef).toBe("main");
    expect(branchDiff.patch).toContain("feature.txt");
  });

  it("reports working, staged and branch paths relative to a subfolder root", async () => {
    const { repository, service } = initSandbox();
    const app = join(repository, "app");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "src", "main.ts"), "one\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "app"]);
    execFileSync("git", ["-C", repository, "checkout", "-b", "feature"]);
    writeFileSync(join(app, "src", "main.ts"), "two\n", "utf8");
    writeFileSync(join(repository, "README.md"), "outside\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "feature"]);
    writeFileSync(join(app, "src", "main.ts"), "three\n", "utf8");
    writeFileSync(join(app, "staged.txt"), "staged\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "app/staged.txt"]);
    writeFileSync(join(app, "fresh.txt"), "untracked\n", "utf8");
    writeFileSync(join(repository, "top.txt"), "top\n", "utf8");

    const working = await service.diff(app, "working");
    expect(working.patch).toContain("+++ b/src/main.ts");
    expect(working.patch).toContain("+++ b/staged.txt");
    expect(working.patch).toContain("fresh.txt");
    expect(working.patch).not.toContain("app/");
    expect(working.patch).not.toContain("top.txt");

    const staged = await service.diff(app, "staged");
    expect(staged.patch).toContain("+++ b/staged.txt");
    expect(staged.patch).not.toContain("app/");

    const branch = await service.diff(app, "branch", "main");
    expect(branch.patch).toContain("+++ b/src/main.ts");
    expect(branch.patch).not.toContain("app/");
    expect(branch.patch).not.toContain("README.md");
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
});

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
}

function commitAll(repository: string, message: string): void {
  git(repository, "add", "-A");
  git(repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", message);
}

function repoState(repository: string): Record<string, string> {
  return {
    index: git(repository, "ls-files", "-s"),
    cached: git(repository, "diff", "--cached", "--name-status"),
    stash: git(repository, "stash", "list"),
    refs: git(repository, "for-each-ref"),
    head: git(repository, "rev-parse", "HEAD"),
    symbolicRef: git(repository, "symbolic-ref", "HEAD"),
    reflog: git(repository, "reflog", "--all")
  };
}

function change(path: string, kind: "modified" | "added" | "deleted"): { path: string; change: "modified" | "added" | "deleted"; added: number; deleted: number; binary: boolean } {
  return { path, change: kind, added: 0, deleted: 0, binary: false };
}

function installMarkerHooks(repository: string): string {
  const marker = join(repository, ".git", "hook-fired");
  const hooks = join(repository, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const name of ["post-index-change", "post-checkout", "pre-commit", "post-commit"]) {
    const hook = join(hooks, name);
    writeFileSync(hook, `#!/bin/sh\necho ${name} >> .git/hook-fired\n`, "utf8");
    chmodSync(hook, 0o755);
  }
  return marker;
}

async function undoTurn(service: GitService, repository: string, startSha: string, endSha: string): Promise<void> {
  const { files, gitlinks } = await service.snapshotChanges(repository, startSha, endSha);
  expect(gitlinks).toEqual([]);
  expect(await service.snapshotConflicts(repository, startSha, endSha, files.map((file) => file.path))).toEqual([]);
  await service.restoreSnapshot(repository, startSha, files);
}

describe("turn snapshots", () => {
  it("captures dirty tracked and untracked files without touching the index, stash, refs, HEAD or reflog", async () => {
    const { repository, service } = initSandbox();
    writeFileSync(join(repository, "README.md"), "dirty\n", "utf8");
    writeFileSync(join(repository, "staged.txt"), "staged\n", "utf8");
    git(repository, "add", "staged.txt");
    writeFileSync(join(repository, "notes.txt"), "untracked\n", "utf8");
    mkdirSync(join(repository, ".cw", "pastes"), { recursive: true });
    writeFileSync(join(repository, ".cw", "pastes", "x.png"), "png", "utf8");
    const before = repoState(repository);
    const status = git(repository, "status", "--porcelain");

    const sha = await service.snapshotWorkingTree(repository);

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repository, "show", `${sha}:README.md`)).toBe("dirty\n");
    expect(git(repository, "show", `${sha}:notes.txt`)).toBe("untracked\n");
    expect(git(repository, "show", `${sha}:staged.txt`)).toBe("staged\n");
    expect(git(repository, "ls-tree", "-r", "--name-only", sha)).not.toContain(".cw/");
    expect(git(repository, "rev-parse", `${sha}^`).trim()).toBe(git(repository, "rev-parse", "HEAD").trim());
    expect(repoState(repository)).toEqual(before);
    expect(git(repository, "status", "--porcelain")).toBe(status);
  });

  it("takes concurrent snapshots of a checkout and its linked worktree without object write races", async () => {
    const { sandbox, repository, service } = initSandbox();
    const linked = join(sandbox, "linked");
    git(repository, "worktree", "add", "-b", "linked", linked);
    for (const root of [repository, linked]) {
      for (let i = 0; i < 20; i += 1) writeFileSync(join(root, `shared-${i}.txt`), `same content ${i}\n`, "utf8");
    }
    const before = repoState(repository);

    const roots = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? repository : linked));
    const shas = await Promise.all(roots.map((root) => service.snapshotWorkingTree(root)));

    const trees = new Set(shas.map((sha) => git(repository, "rev-parse", `${sha}^{tree}`).trim()));
    expect(trees.size).toBe(1);
    expect(git(repository, "show", `${shas[1]}:shared-3.txt`)).toBe("same content 3\n");
    expect(repoState(repository)).toEqual(before);
  });

  it("runs snapshot, restore and diff git calls without firing repository hooks", async () => {
    const { repository, service } = initSandbox();
    const marker = installMarkerHooks(repository);
    writeFileSync(join(repository, "README.md"), "hooked\n", "utf8");
    git(repository, "add", "README.md");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const startSha = await service.snapshotWorkingTree(repository);
    writeFileSync(join(repository, "README.md"), "turn\n", "utf8");
    writeFileSync(join(repository, "added.txt"), "added\n", "utf8");
    const endSha = await service.snapshotWorkingTree(repository);
    await service.diffSnapshot(repository, startSha, endSha);
    await undoTurn(service, repository, startSha, endSha);

    expect(readFileSync(join(repository, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe("hooked\n");
    expect(existsSync(join(repository, "added.txt"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("diffs start to end without binary patches or rename detection, matching the change list", async () => {
    const { repository, service } = initSandbox();
    writeFileSync(join(repository, "README.md"), "pre-existing\n", "utf8");
    writeFileSync(join(repository, "old-name.txt"), "same content for rename detection\nline two\nline three\n", "utf8");
    commitAll(repository, "rename source");
    const startSha = await service.snapshotWorkingTree(repository);
    writeFileSync(join(repository, "turn.txt"), "made by turn\n", "utf8");
    writeFileSync(join(repository, "blob.bin"), Buffer.from([0, 1, 2, 0, 3, 4]));
    renameSync(join(repository, "old-name.txt"), join(repository, "new-name.txt"));
    const endSha = await service.snapshotWorkingTree(repository);
    writeFileSync(join(repository, "after.txt"), "after the turn\n", "utf8");

    const patch = await service.diffSnapshot(repository, startSha, endSha);
    expect(patch).toContain("+made by turn");
    expect(patch).not.toContain("README.md");
    expect(patch).not.toContain("after.txt");
    expect(patch).not.toContain("GIT binary patch");
    expect(patch).toContain("Binary files");
    expect(patch).not.toContain("rename from");
    expect(patch).toContain("deleted file mode");

    const { files } = await service.snapshotChanges(repository, startSha, endSha);
    expect(files.map((file) => `${file.change}:${file.path}`)).toEqual([
      "added:blob.bin",
      "added:new-name.txt",
      "deleted:old-name.txt",
      "added:turn.txt"
    ]);
    for (const file of files) expect(patch).toContain(file.path);

    const live = await service.diffSnapshot(repository, startSha);
    expect(live).toContain("after.txt");

    const result = await service.diff(repository, "turn", startSha, endSha);
    expect(result).toMatchObject({ mode: "turn", baseRef: startSha, headRef: "main" });
    expect(result.patch).toBe(patch);
    await expect(service.diff(repository, "turn")).rejects.toThrow("No snapshot for the last turn");
  });

  it("classifies modified, added and deleted files with numstat", async () => {
    const { repository, service } = initSandbox();
    writeFileSync(join(repository, "a.txt"), "one\ntwo\n", "utf8");
    writeFileSync(join(repository, "b.txt"), "b\n", "utf8");
    commitAll(repository, "files");
    const sha = await service.snapshotWorkingTree(repository);

    writeFileSync(join(repository, "a.txt"), "one\nthree\nfour\n", "utf8");
    rmSync(join(repository, "b.txt"));
    writeFileSync(join(repository, "c.txt"), "1\n2\n3\n", "utf8");
    writeFileSync(join(repository, "bin.dat"), Buffer.from([0, 1, 2, 0, 3]));

    expect(await service.snapshotChanges(repository, sha)).toEqual({
      files: [
        { path: "a.txt", change: "modified", added: 2, deleted: 1, binary: false },
        { path: "b.txt", change: "deleted", added: 0, deleted: 1, binary: false },
        { path: "bin.dat", change: "added", added: 0, deleted: 0, binary: true },
        { path: "c.txt", change: "added", added: 3, deleted: 0, binary: false }
      ],
      gitlinks: []
    });
  });

  it("restores the snapshot byte for byte, keeps pre-snapshot work and leaves the index untouched", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.autocrlf", "false");
    writeFileSync(join(repository, "tracked.txt"), "tracked\n", "utf8");
    commitAll(repository, "tracked");
    writeFileSync(join(repository, "README.md"), "pre\n", "utf8");
    writeFileSync(join(repository, "keep.txt"), "keep\n", "utf8");
    writeFileSync(join(repository, "staged.txt"), "staged\n", "utf8");
    git(repository, "add", "staged.txt");
    const sha = await service.snapshotWorkingTree(repository);
    const before = repoState(repository);

    writeFileSync(join(repository, "README.md"), "turn\n", "utf8");
    rmSync(join(repository, "keep.txt"));
    rmSync(join(repository, "tracked.txt"));
    mkdirSync(join(repository, "src", "deep"), { recursive: true });
    writeFileSync(join(repository, "src", "deep", "new.txt"), "new\n", "utf8");

    const { files } = await service.snapshotChanges(repository, sha);
    const restored = await service.restoreSnapshot(repository, sha, files);

    expect(restored.map((file) => `${file.change}:${file.path}`)).toEqual([
      "modified:README.md",
      "deleted:keep.txt",
      "added:src/deep/new.txt",
      "deleted:tracked.txt"
    ]);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("pre\n");
    expect(readFileSync(join(repository, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(repository, "tracked.txt"), "utf8")).toBe("tracked\n");
    expect(readFileSync(join(repository, "staged.txt"), "utf8")).toBe("staged\n");
    expect(existsSync(join(repository, "src"))).toBe(false);
    expect(repoState(repository)).toEqual(before);
    expect((await service.snapshotChanges(repository, sha)).files).toEqual([]);
  });

  it("restores content equal modulo line endings when core.autocrlf is true", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.autocrlf", "true");
    writeFileSync(join(repository, "lf.txt"), "one\ntwo\n", "utf8");
    writeFileSync(join(repository, "crlf.txt"), "one\r\ntwo\r\n", "utf8");
    const sha = await service.snapshotWorkingTree(repository);

    writeFileSync(join(repository, "lf.txt"), "changed\n", "utf8");
    writeFileSync(join(repository, "crlf.txt"), "changed\r\n", "utf8");
    const { files } = await service.snapshotChanges(repository, sha);
    await service.restoreSnapshot(repository, sha, files);

    expect(readFileSync(join(repository, "lf.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\ntwo\n");
    expect(readFileSync(join(repository, "crlf.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\ntwo\n");
    expect(readFileSync(join(repository, "crlf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
    expect((await service.snapshotChanges(repository, sha)).files).toEqual([]);
  });

  it("undoes a file replaced by a directory and a directory replaced by a file", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.autocrlf", "false");
    writeFileSync(join(repository, "f"), "file\n", "utf8");
    mkdirSync(join(repository, "d"));
    writeFileSync(join(repository, "d", "a.txt"), "inside\n", "utf8");
    commitAll(repository, "shapes");
    const startSha = await service.snapshotWorkingTree(repository);

    rmSync(join(repository, "f"));
    mkdirSync(join(repository, "f", "nested"), { recursive: true });
    writeFileSync(join(repository, "f", "nested", "x.txt"), "x\n", "utf8");
    rmSync(join(repository, "d"), { recursive: true });
    writeFileSync(join(repository, "d"), "now a file\n", "utf8");
    const endSha = await service.snapshotWorkingTree(repository);

    await undoTurn(service, repository, startSha, endSha);

    expect(readFileSync(join(repository, "f"), "utf8")).toBe("file\n");
    expect(readFileSync(join(repository, "d", "a.txt"), "utf8")).toBe("inside\n");
    expect((await service.snapshotChanges(repository, startSha)).files).toEqual([]);
  });

  it("keeps gitignored content when pruning directories and refuses to overwrite it", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.autocrlf", "false");
    writeFileSync(join(repository, ".gitignore"), "*.log\n", "utf8");
    writeFileSync(join(repository, "f"), "file\n", "utf8");
    commitAll(repository, "ignore");
    writeFileSync(join(repository, "keep.log"), "ignored\n", "utf8");
    const startSha = await service.snapshotWorkingTree(repository);

    mkdirSync(join(repository, "gen"));
    writeFileSync(join(repository, "gen", "out.txt"), "generated\n", "utf8");
    writeFileSync(join(repository, "gen", "debug.log"), "ignored\n", "utf8");
    const endSha = await service.snapshotWorkingTree(repository);
    await undoTurn(service, repository, startSha, endSha);
    expect(existsSync(join(repository, "gen", "out.txt"))).toBe(false);
    expect(readFileSync(join(repository, "gen", "debug.log"), "utf8")).toBe("ignored\n");
    expect(readFileSync(join(repository, "keep.log"), "utf8")).toBe("ignored\n");

    const secondStart = await service.snapshotWorkingTree(repository);
    rmSync(join(repository, "f"));
    mkdirSync(join(repository, "f"));
    writeFileSync(join(repository, "f", "x.txt"), "x\n", "utf8");
    writeFileSync(join(repository, "f", "y.log"), "ignored\n", "utf8");
    const secondEnd = await service.snapshotWorkingTree(repository);
    const { files } = await service.snapshotChanges(repository, secondStart, secondEnd);
    await expect(service.restoreSnapshot(repository, secondStart, files)).rejects.toThrow("'f/y.log' would be overwritten");
    expect(readFileSync(join(repository, "f", "x.txt"), "utf8")).toBe("x\n");
    expect(readFileSync(join(repository, "f", "y.log"), "utf8")).toBe("ignored\n");
  });

  it("restores paths with spaces, unicode, a leading dash and tabs in one batch", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.autocrlf", "false");
    const names = ["with space.txt", "ünïcødé 文字.txt", "-leading-dash.txt", ...(process.platform === "win32" ? [] : ["tab\there.txt", "star*.txt", ":(glob)magic.txt"])];
    for (const name of names) writeFileSync(join(repository, name), `${name}\n`, "utf8");
    commitAll(repository, "odd names");
    const startSha = await service.snapshotWorkingTree(repository);

    const [modified, deleted, ...rest] = names;
    writeFileSync(join(repository, modified), "changed\n", "utf8");
    rmSync(join(repository, deleted));
    for (const name of rest) writeFileSync(join(repository, name), "changed\n", "utf8");
    writeFileSync(join(repository, "-new dash ü.txt"), "added\n", "utf8");
    const endSha = await service.snapshotWorkingTree(repository);

    await undoTurn(service, repository, startSha, endSha);

    for (const name of names) expect(readFileSync(join(repository, name), "utf8")).toBe(`${name}\n`);
    expect(existsSync(join(repository, "-new dash ü.txt"))).toBe(false);
  });

  it("retries a restore briefly while index.lock is held and reports a lock that stays", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.autocrlf", "false");
    writeFileSync(join(repository, "README.md"), "pre\n", "utf8");
    const sha = await service.snapshotWorkingTree(repository);
    const lock = join(repository, ".git", "index.lock");

    writeFileSync(join(repository, "README.md"), "turn\n", "utf8");
    writeFileSync(lock, "", "utf8");
    const release = setTimeout(() => rmSync(lock, { force: true }), 250);
    await service.restoreSnapshot(repository, sha, [change("README.md", "modified")]);
    clearTimeout(release);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("pre\n");

    writeFileSync(join(repository, "README.md"), "turn again\n", "utf8");
    writeFileSync(lock, "", "utf8");
    try {
      await expect(service.restoreSnapshot(repository, sha, [change("README.md", "modified")])).rejects.toThrow(/index is locked/);
      expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("turn again\n");
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it("reports paths changed since the end snapshot as conflicts, including parent and child paths", async () => {
    const { repository, service } = initSandbox();
    writeFileSync(join(repository, "foo"), "file\n", "utf8");
    commitAll(repository, "foo");
    const startSha = await service.snapshotWorkingTree(repository);
    writeFileSync(join(repository, "README.md"), "turn\n", "utf8");
    writeFileSync(join(repository, "turn.txt"), "turn\n", "utf8");
    rmSync(join(repository, "foo"));
    const endSha = await service.snapshotWorkingTree(repository);
    const { files } = await service.snapshotChanges(repository, startSha, endSha);
    const paths = files.map((file) => file.path);

    expect(await service.snapshotConflicts(repository, startSha, endSha, paths)).toEqual([]);
    writeFileSync(join(repository, "README.md"), "user edit\n", "utf8");
    mkdirSync(join(repository, "foo"));
    writeFileSync(join(repository, "foo", "bar.txt"), "user\n", "utf8");
    writeFileSync(join(repository, "unrelated.txt"), "user\n", "utf8");
    expect(await service.snapshotConflicts(repository, startSha, endSha, paths)).toEqual(["README.md", "foo"]);
  });

  it("refuses to remove or restore through a symlinked directory", async () => {
    const { sandbox, repository, service } = initSandbox();
    const outside = join(sandbox, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "victim.txt"), "keep me\n", "utf8");
    const sha = await service.snapshotWorkingTree(repository);
    try {
      symlinkSync(outside, join(repository, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    await expect(service.restoreSnapshot(repository, sha, [change("link/victim.txt", "added")])).rejects.toThrow(/symlinked directory 'link'/);
    await expect(service.restoreSnapshot(repository, sha, [change("link/victim.txt", "modified")])).rejects.toThrow(/symlinked directory 'link'/);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("keep me\n");
  });

  it("rejects restoring a path outside the root before touching anything", async () => {
    const { sandbox, repository, service } = initSandbox();
    const outside = join(sandbox, "outside.txt");
    writeFileSync(outside, "outside\n", "utf8");
    writeFileSync(join(repository, "inside.txt"), "inside\n", "utf8");
    const sha = await service.snapshotWorkingTree(repository);

    await expect(service.restoreSnapshot(repository, sha, [
      change("inside.txt", "added"),
      change("../outside.txt", "added")
    ])).rejects.toThrow(/escapes project root/);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(repository, "inside.txt"))).toBe(true);
  });

  it("excludes gitlinks from changes and explains a nested repository without commits", async () => {
    const { repository, service } = initSandbox();
    const startSha = await service.snapshotWorkingTree(repository);
    const nested = join(repository, "nested");
    execFileSync("git", ["init", "-b", "main", nested]);

    await expect(service.snapshotWorkingTree(repository)).rejects.toThrow(/'nested\/?' is a nested git repository without commits/);

    writeFileSync(join(nested, "inner.txt"), "inner\n", "utf8");
    commitAll(nested, "inner");
    writeFileSync(join(repository, "outer.txt"), "outer\n", "utf8");
    const endSha = await service.snapshotWorkingTree(repository);
    const comparison = await service.snapshotChanges(repository, startSha, endSha);
    expect(comparison.gitlinks).toEqual(["nested"]);
    expect(comparison.files.map((file) => file.path)).toEqual(["outer.txt"]);
  });

  it("works on an unborn HEAD", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-git-unborn-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    const service = new GitService();
    writeFileSync(join(repository, "first.txt"), "first\n", "utf8");

    const sha = await service.snapshotWorkingTree(repository);
    expect(git(repository, "rev-list", "--parents", "-n", "1", sha).trim()).toBe(sha);
    expect(git(repository, "show", `${sha}:first.txt`)).toBe("first\n");

    writeFileSync(join(repository, "second.txt"), "second\n", "utf8");
    const { files } = await service.snapshotChanges(repository, sha);
    expect(files).toEqual([{ path: "second.txt", change: "added", added: 1, deleted: 0, binary: false }]);
    await service.restoreSnapshot(repository, sha, files);
    expect(existsSync(join(repository, "second.txt"))).toBe(false);
    expect(readFileSync(join(repository, "first.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("first\n");
    expect(git(repository, "ls-files", "-s")).toBe("");
  });

  it("resumes an undo that stopped after removing added files and keeps directories from the start snapshot", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.autocrlf", "false");
    mkdirSync(join(repository, "dir"));
    writeFileSync(join(repository, "dir", "old.txt"), "old\n", "utf8");
    commitAll(repository, "dir");
    const startSha = await service.snapshotWorkingTree(repository);
    const before = repoState(repository);
    const status = git(repository, "status", "--porcelain");

    writeFileSync(join(repository, "README.md"), "turn\n", "utf8");
    rmSync(join(repository, "dir", "old.txt"));
    writeFileSync(join(repository, "dir", "new.txt"), "new\n", "utf8");
    mkdirSync(join(repository, "fresh", "deep"), { recursive: true });
    writeFileSync(join(repository, "fresh", "deep", "x.txt"), "x\n", "utf8");
    const endSha = await service.snapshotWorkingTree(repository);
    const { files } = await service.snapshotChanges(repository, startSha, endSha);
    const paths = files.map((file) => file.path);

    const lock = join(repository, ".git", "index.lock");
    writeFileSync(lock, "", "utf8");
    try {
      await expect(service.restoreSnapshot(repository, startSha, files)).rejects.toThrow(/Retrying Undo is safe/);
    } finally {
      rmSync(lock, { force: true });
    }
    expect(existsSync(join(repository, "dir", "new.txt"))).toBe(false);
    expect(existsSync(join(repository, "fresh"))).toBe(false);
    expect(existsSync(join(repository, "dir"))).toBe(true);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("turn\n");
    expect(await service.snapshotConflicts(repository, startSha, endSha, paths)).toEqual([]);

    await service.restoreSnapshot(repository, startSha, files);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("base\n");
    expect(readFileSync(join(repository, "dir", "old.txt"), "utf8")).toBe("old\n");
    expect(repoState(repository)).toEqual(before);
    expect(git(repository, "status", "--porcelain")).toBe(status);
    expect((await service.snapshotChanges(repository, startSha)).files).toEqual([]);

    await service.restoreSnapshot(repository, startSha, files);
    expect((await service.snapshotChanges(repository, startSha)).files).toEqual([]);
  });

  it("still reports a conflict when a partially undone path was edited again", async () => {
    const { repository, service } = initSandbox();
    const startSha = await service.snapshotWorkingTree(repository);
    writeFileSync(join(repository, "README.md"), "turn\n", "utf8");
    writeFileSync(join(repository, "added.txt"), "turn\n", "utf8");
    const endSha = await service.snapshotWorkingTree(repository);
    const paths = ["README.md", "added.txt"];

    rmSync(join(repository, "added.txt"));
    expect(await service.snapshotConflicts(repository, startSha, endSha, paths)).toEqual([]);
    writeFileSync(join(repository, "added.txt"), "user\n", "utf8");
    writeFileSync(join(repository, "README.md"), "user\n", "utf8");
    expect(await service.snapshotConflicts(repository, startSha, endSha, paths)).toEqual(["README.md", "added.txt"]);
  });

  it.runIf(process.platform === "win32" || process.platform === "darwin")("restores the original name when an added path only differs in case from a file that existed before the turn", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.ignorecase", "false");
    git(repository, "config", "core.autocrlf", "false");
    const startSha = await service.snapshotWorkingTree(repository);
    renameSync(join(repository, "README.md"), join(repository, "Readme.md"));

    await service.restoreSnapshot(repository, startSha, [change("Readme.md", "added")]);

    expect(readdirSync(repository).filter((name) => name.toLowerCase() === "readme.md")).toEqual(["README.md"]);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("base\n");
  });

  it.runIf(process.platform !== "win32")("treats a backslash in a git path as part of the file name", async () => {
    const { repository, service } = initSandbox();
    git(repository, "config", "core.autocrlf", "false");
    mkdirSync(join(repository, "a"));
    writeFileSync(join(repository, "a", "b.txt"), "keep\n", "utf8");
    const startSha = await service.snapshotWorkingTree(repository);
    writeFileSync(join(repository, "a\\b.txt"), "turn\n", "utf8");
    const endSha = await service.snapshotWorkingTree(repository);

    await undoTurn(service, repository, startSha, endSha);

    expect(existsSync(join(repository, "a\\b.txt"))).toBe(false);
    expect(readFileSync(join(repository, "a", "b.txt"), "utf8")).toBe("keep\n");
  });
});

describe("gitPathTarget", () => {
  const base = join(tmpdir(), "cw-git-target");

  it("splits git paths on forward slashes and stays inside the root", () => {
    expect(gitPathTarget(base, "src/a.txt")).toBe(join(base, "src", "a.txt"));
    expect(() => gitPathTarget(base, "../outside.txt")).toThrow(/escapes project root/);
    expect(() => gitPathTarget(base, "src/../../outside.txt")).toThrow(/escapes project root/);
    expect(() => gitPathTarget(base, "")).toThrow(/escapes project root/);
  });

  it.runIf(process.platform !== "win32")("keeps a backslash inside a single path segment", () => {
    expect(gitPathTarget(base, "a\\b.txt")).toBe(`${base}/a\\b.txt`);
  });
});

describe("sweepStaleSnapshotIndexes", () => {
  it("removes only snapshot index files older than the cutoff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-sweep-"));
    const id = "0123abcd-0123-4abc-8def-0123456789ab";
    const stale = [`cw-snapshot-${id}.index`, `cw-snapshot-${id}.index.lock`];
    const fresh = "cw-snapshot-11111111-2222-4333-8444-555555555555.index";
    const unrelated = "cw-snapshot-notes.txt";
    for (const name of [...stale, fresh, unrelated]) writeFileSync(join(dir, name), "", "utf8");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    for (const name of [...stale, unrelated]) utimesSync(join(dir, name), old, old);

    expect(await sweepStaleSnapshotIndexes(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([fresh, unrelated].sort());
  });
});

describe("parsePorcelainV2Status", () => {
  it("reads branch, upstream, tracking and every entry kind", () => {
    const stdout = [
      "# branch.oid 0123456789abcdef0123456789abcdef01234567",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaa bbb staged file.ts",
      "1 .M N... 100644 100644 100644 aaa aaa unstaged.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 renamed new.ts",
      "old.ts",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts",
      "? notes with space.md",
      ""
    ].join("\0");
    expect(parsePorcelainV2Status(stdout)).toEqual({
      branch: "feature/x",
      upstream: "origin/feature/x",
      tracking: { ahead: 2, behind: 1 },
      files: [
        { path: "staged file.ts", index: "M", untracked: false },
        { path: "unstaged.ts", index: ".", untracked: false },
        { path: "renamed new.ts", index: "R", untracked: false },
        { path: "conflict.ts", index: "U", untracked: false },
        { path: "notes with space.md", index: "?", untracked: true }
      ]
    });
  });

  it("reports detached HEAD and missing tracking", () => {
    const stdout = ["# branch.oid 0123", "# branch.head (detached)", "# branch.upstream origin/gone", ""].join("\0");
    expect(parsePorcelainV2Status(stdout)).toEqual({ branch: "HEAD", upstream: "origin/gone", tracking: null, files: [] });
  });
});
