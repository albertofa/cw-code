import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "./GitService.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function configure(repository: string): void {
  git(repository, "config", "user.name", "t");
  git(repository, "config", "user.email", "t@local");
}

function commitFile(repository: string, file: string, content: string, message: string): void {
  writeFileSync(join(repository, file), content);
  git(repository, "add", file);
  git(repository, "commit", "-q", "-m", message);
}

function setup(): { origin: string; local: string; other: string } {
  const sandbox = mkdtempSync(join(realpathSync.native(tmpdir()), "cw-actions-"));
  sandboxes.push(sandbox);
  const origin = join(sandbox, "origin.git");
  git(sandbox, "init", "-q", "--bare", "-b", "main", origin);
  const other = join(sandbox, "other");
  git(sandbox, "clone", "-q", origin, other);
  configure(other);
  git(other, "checkout", "-q", "-b", "main");
  commitFile(other, "a.txt", "one\n", "first");
  git(other, "push", "-q", "origin", "main");
  const local = join(sandbox, "local");
  git(sandbox, "clone", "-q", origin, local);
  configure(local);
  return { origin, local, other };
}

describe("GitService.fetchAll", () => {
  it("updates the remote-tracking ref, prunes and writes FETCH_HEAD", async () => {
    const { local, other } = setup();
    commitFile(other, "b.txt", "two\n", "second");
    git(other, "push", "-q", "origin", "main");
    git(other, "push", "-q", "origin", "main:gone");
    await new GitService().fetchAll(local);
    expect(git(local, "log", "-1", "--format=%s", "origin/main")).toBe("second");
    expect(existsSync(join(local, ".git", "FETCH_HEAD"))).toBe(true);
    git(other, "push", "-q", "origin", "--delete", "gone");
    await new GitService().fetchAll(local);
    expect(git(local, "branch", "-r")).not.toContain("origin/gone");
  });

  it("reports a failure without an origin", async () => {
    const { local } = setup();
    git(local, "remote", "remove", "origin");
    await expect(new GitService().fetchAll(local)).rejects.toThrow(/^Fetch failed:/);
  });
});

describe("GitService.push", () => {
  it("pushes to the existing upstream", async () => {
    const { origin, local } = setup();
    commitFile(local, "b.txt", "two\n", "local work");
    await new GitService().push(local);
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("local work");
  });

  it("creates the upstream for a branch without one", async () => {
    const { origin, local } = setup();
    git(local, "checkout", "-q", "-b", "solo");
    commitFile(local, "b.txt", "two\n", "solo work");
    await new GitService().push(local);
    expect(git(origin, "log", "-1", "--format=%s", "solo")).toBe("solo work");
    expect(git(local, "rev-parse", "--abbrev-ref", "solo@{upstream}")).toBe("origin/solo");
  });

  it("refuses a detached HEAD", async () => {
    const { local } = setup();
    git(local, "checkout", "-q", "--detach");
    await expect(new GitService().push(local)).rejects.toThrow(/detached/);
  });
});

describe("GitService stash", () => {
  it("stashes tracked and untracked changes and pops them back", async () => {
    const { local } = setup();
    writeFileSync(join(local, "a.txt"), "edited\n");
    writeFileSync(join(local, "new.txt"), "fresh\n");
    await new GitService().stashPush(local, "my work");
    expect(git(local, "status", "--porcelain")).toBe("");
    expect(git(local, "stash", "list")).toContain("my work");
    await new GitService().stashPop(local);
    expect(readFileSync(join(local, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(local, "new.txt"), "utf8")).toBe("fresh\n");
    expect(git(local, "stash", "list")).toBe("");
  });

  it("refuses to stash a clean tree", async () => {
    const { local } = setup();
    await expect(new GitService().stashPush(local)).rejects.toThrow(/Nothing to stash/);
  });

  it("names the conflicting files and keeps the stash", async () => {
    const { local } = setup();
    writeFileSync(join(local, "a.txt"), "stashed\n");
    await new GitService().stashPush(local);
    commitFile(local, "a.txt", "committed\n", "diverge");
    await expect(new GitService().stashPop(local)).rejects.toThrow(/conflicts in a\.txt/);
    expect(git(local, "stash", "list")).not.toBe("");
  });

  it("fails clearly when there is no stash", async () => {
    const { local } = setup();
    await expect(new GitService().stashPop(local)).rejects.toThrow(/^Pop failed:/);
  });
});

describe("GitService.createBranch", () => {
  it("creates a branch at the given commit, optionally checking it out", async () => {
    const { local } = setup();
    const first = git(local, "rev-parse", "HEAD");
    commitFile(local, "b.txt", "two\n", "second");
    await new GitService().createBranch(local, "feature/x", first, false);
    expect(git(local, "rev-parse", "feature/x")).toBe(first);
    expect(git(local, "branch", "--show-current")).toBe("main");
    await new GitService().createBranch(local, "feature/y", first, true);
    expect(git(local, "branch", "--show-current")).toBe("feature/y");
  });

  it("rejects bad names, short shas and existing branches", async () => {
    const { local } = setup();
    const head = git(local, "rev-parse", "HEAD");
    const service = new GitService();
    await expect(service.createBranch(local, "bad name", head, false)).rejects.toThrow(/not a valid branch name/);
    await expect(service.createBranch(local, "-x", head, false)).rejects.toThrow(/invalid branch name/);
    await expect(service.createBranch(local, "ok", head.slice(0, 7), false)).rejects.toThrow(/full 40-character/);
    await expect(service.createBranch(local, "main", head, false)).rejects.toThrow(/^Branch failed:/);
  });
});
