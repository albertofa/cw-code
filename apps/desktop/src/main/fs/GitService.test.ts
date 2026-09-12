import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, parseGitHubAccounts, parseGitHubRemote, parseNumstat, parsePrNumber, parsePullRequest, parseWorktreeList, selectGitHubAccount, worktreeNameFor } from "./GitService.js";

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
  it("sums text changes and ignores binary markers", () => {
    expect(parseNumstat("12\t3\tsrc/app.ts\n4\t0\tREADME.md\n-\t-\timage.png\n"))
      .toEqual({ addedLines: 16, deletedLines: 3 });
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
});
