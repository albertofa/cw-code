import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, parsePrNumber, parsePullRequest, parseWorktreeList, worktreeNameFor } from "./GitService.js";

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

describe("GitService worktrees", () => {
  it("creates an isolated session branch and includes untracked files in its diff", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "cw-git-"));
    const repository = join(sandbox, "repo");
    execFileSync("git", ["init", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "base\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "commit", "-m", "initial"]);

    const service = new GitService();
    const created = await service.createWorktree(repository, "project", "sess_1234abcd", join(sandbox, "worktrees"), "main");
    expect(created.branch).toBe("cw/1234abcd");
    expect(existsSync(created.path)).toBe(true);

    writeFileSync(join(created.path, "new-file.txt"), "untracked\n", "utf8");
    const diff = await service.diff(created.path, "working");
    expect(diff.patch).toContain("new-file.txt");
    expect(diff.patch).toContain("+untracked");

    const status = await service.status(created.path);
    expect(status).toMatchObject({ available: true, branch: "cw/1234abcd", dirtyCount: 1 });
    const branches = await service.branches(created.path);
    expect(branches.find((branch) => branch.name === "cw/1234abcd")?.worktreePath).toBe(created.path.replace(/\\/g, "/"));
  });
});
