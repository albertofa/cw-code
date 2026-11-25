import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "./GitService.js";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function commitFile(repository: string, file: string, content: string, message: string): void {
  writeFileSync(join(repository, file), content);
  git(repository, "add", file);
  git(repository, "commit", "-q", "-m", message);
}

function setup(): { local: string; other: string } {
  const sandbox = mkdtempSync(join(realpathSync.native(tmpdir()), "cw-pull-"));
  sandboxes.push(sandbox);
  const origin = join(sandbox, "origin.git");
  git(sandbox, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(sandbox, "seed");
  git(sandbox, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  commitFile(seed, "a.txt", "one\n", "first");
  git(seed, "push", "-q", "origin", "main");
  const local = join(sandbox, "local");
  git(sandbox, "clone", "-q", origin, local);
  return { local, other: seed };
}

describe("GitService.pullFastForward", () => {
  it("fast-forwards the current branch from its upstream", async () => {
    const { local, other } = setup();
    commitFile(other, "b.txt", "two\n", "second");
    git(other, "push", "-q", "origin", "main");
    await new GitService().pullFastForward(local);
    expect(git(local, "log", "-1", "--format=%s")).toBe("second");
  });

  it("refuses when the branch diverged from its upstream", async () => {
    const { local, other } = setup();
    commitFile(other, "b.txt", "two\n", "remote work");
    git(other, "push", "-q", "origin", "main");
    commitFile(local, "c.txt", "three\n", "local work");
    await expect(new GitService().pullFastForward(local)).rejects.toThrow(/have diverged/);
    expect(git(local, "log", "-1", "--format=%s")).toBe("local work");
  });

  it("refuses on a detached HEAD and on a branch without upstream", async () => {
    const { local } = setup();
    git(local, "checkout", "-q", "-b", "solo");
    await expect(new GitService().pullFastForward(local)).rejects.toThrow(/no upstream/);
    git(local, "checkout", "-q", "--detach");
    await expect(new GitService().pullFastForward(local)).rejects.toThrow(/detached/);
  });
});
