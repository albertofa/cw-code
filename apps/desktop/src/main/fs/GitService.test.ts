import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, countUntrackedLines, isAppManagedPath, mapLimit, parseGitHubAccounts, parseGitHubRemote, parseNumstat, parsePrNumber, parsePullRequest, parseWorktreeList, selectGitHubAccount, worktreeNameFor } from "./GitService.js";

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
});
