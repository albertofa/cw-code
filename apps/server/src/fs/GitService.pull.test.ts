import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, gitFailureReason } from "./GitService.js";

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

  it("reports the real cause when a local change blocks the pull, not the fetch summary", async () => {
    const { local, other } = setup();
    commitFile(other, "a.txt", "two\n", "remote edit");
    git(other, "push", "-q", "origin", "main");
    writeFileSync(join(local, "a.txt"), "local edit\n");
    const failure = await new GitService().pullFastForward(local).then(
      () => "",
      (error: Error) => error.message
    );
    expect(failure).toMatch(/^Pull failed: Your local changes to the following files would be overwritten by merge/);
    expect(failure).toContain("a.txt");
    expect(failure).not.toContain("From ");
  });
});

describe("gitFailureReason", () => {
  it("skips the fetch summary and CRLF warnings and keeps the error with its files", () => {
    const stderr = [
      "warning: in the working copy of 'a.txt', LF will be replaced by CRLF the next time Git touches it",
      "From https://user:secret@example.com/acme/repo",
      "   9b3d0e3..ee2f5b4  main       -> origin/main",
      "error: Your local changes to the following files would be overwritten by merge:",
      "\ta.txt",
      "\tb.txt",
      "Please commit your changes or stash them before you merge."
    ].join("\n");
    const reason = gitFailureReason(stderr, 1);
    expect(reason).toBe("Your local changes to the following files would be overwritten by merge (a.txt, b.txt)");
    expect(reason).not.toContain("secret");
  });

  it("falls back to the first useful line, then to the exit code", () => {
    expect(gitFailureReason("From https://x/y\nsomething odd happened\n", 1)).toBe("something odd happened");
    expect(gitFailureReason("", 128)).toBe("git pull exited with code 128");
  });

  it("redacts credentials in a fatal line", () => {
    expect(gitFailureReason("fatal: unable to access 'https://user:secret@example.com/r.git/': Could not resolve host", 128)).not.toContain("secret");
  });
});

describe("GitService.checkoutBranch", () => {
  it("finds a branch created outside cw-code while the branch list is cached", async () => {
    const { local } = setup();
    const service = new GitService();
    await service.branches(local);
    git(local, "branch", "made-in-terminal");
    await service.checkoutBranch(local, "made-in-terminal");
    expect(git(local, "rev-parse", "--abbrev-ref", "HEAD")).toBe("made-in-terminal");
  });

  it("still rejects a branch that does not exist", async () => {
    const { local } = setup();
    await expect(new GitService().checkoutBranch(local, "missing")).rejects.toThrow("unknown branch 'missing'");
  });
});
