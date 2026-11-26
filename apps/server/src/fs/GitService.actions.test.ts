import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, pushFailureReason, stashRefForSha, untrackedCollisions } from "./GitService.js";

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
  const topStash = (local: string): string => git(local, "rev-parse", "stash@{0}");

  it("stashes tracked and untracked changes and pops them back", async () => {
    const { local } = setup();
    writeFileSync(join(local, "a.txt"), "edited\n");
    writeFileSync(join(local, "new.txt"), "fresh\n");
    await new GitService().stashPush(local, "my work");
    expect(git(local, "status", "--porcelain")).toBe("");
    expect(git(local, "stash", "list")).toContain("my work");
    await new GitService().stashPop(local, topStash(local));
    expect(readFileSync(join(local, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(local, "new.txt"), "utf8")).toBe("fresh\n");
    expect(git(local, "stash", "list")).toBe("");
  });

  it("pops the confirmed stash even when another one was pushed on top", async () => {
    const { local } = setup();
    const service = new GitService();
    writeFileSync(join(local, "mine.txt"), "mine\n");
    await service.stashPush(local, "mine");
    const mine = topStash(local);
    writeFileSync(join(local, "theirs.txt"), "theirs\n");
    await service.stashPush(local, "theirs");
    await service.stashPop(local, mine);
    expect(readFileSync(join(local, "mine.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(local, "theirs.txt"))).toBe(false);
    expect(git(local, "stash", "list", "--format=%s")).toBe("On main: theirs");
  });

  it("refuses a stash that is no longer in the list", async () => {
    const { local } = setup();
    writeFileSync(join(local, "a.txt"), "edited\n");
    await new GitService().stashPush(local);
    const gone = topStash(local);
    git(local, "stash", "drop", "-q");
    await expect(new GitService().stashPop(local, gone)).rejects.toThrow("That stash is no longer in the list — refresh and try again");
    await expect(new GitService().stashPop(local, "x")).rejects.toThrow(/full 40-character/);
  });

  it("refuses to stash a clean tree", async () => {
    const { local } = setup();
    await expect(new GitService().stashPush(local)).rejects.toThrow(/Nothing to stash/);
  });

  it("names the conflicting files and keeps the stash", async () => {
    const { local } = setup();
    writeFileSync(join(local, "a.txt"), "stashed\n");
    await new GitService().stashPush(local);
    const sha = topStash(local);
    commitFile(local, "a.txt", "committed\n", "diverge");
    await expect(new GitService().stashPop(local, sha)).rejects.toThrow(/conflicts in a\.txt/);
    expect(git(local, "stash", "list")).not.toBe("");
  });

  it("names untracked files that block the pop and keeps the stash", async () => {
    const { local } = setup();
    writeFileSync(join(local, "u.txt"), "stashed\n");
    await new GitService().stashPush(local);
    const sha = topStash(local);
    writeFileSync(join(local, "u.txt"), "in the way\n");
    await expect(new GitService().stashPop(local, sha)).rejects.toThrow("Pop failed: u.txt already exists in the checkout");
    expect(git(local, "stash", "list")).not.toBe("");
  });
});

describe("stashRefForSha", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);

  it("maps a stash commit to its reflog selector", () => {
    expect(stashRefForSha(`${a}\0stash@{0}\n${b}\0stash@{1}\n`, b.toUpperCase())).toBe("stash@{1}");
    expect(stashRefForSha(`${a}\0stash@{0}\n`, b)).toBeNull();
  });

  it("falls back to the position when the selector is not an index", () => {
    expect(stashRefForSha(`${a}\0stash@{2 hours ago}\n${b}\0stash@{3 hours ago}\n`, b)).toBe("stash@{1}");
  });
});

describe("untrackedCollisions", () => {
  it("keeps the paths git refused to overwrite", () => {
    const stderr = "u.txt already exists, no checkout\nsrc/b c.txt already exists, no checkout\nerror: could not restore untracked files from stash\n";
    expect(untrackedCollisions(stderr)).toEqual(["u.txt", "src/b c.txt"]);
    expect(untrackedCollisions("error: something else\n")).toEqual([]);
  });
});

describe("pushFailureReason", () => {
  it("keeps a non-fast-forward rejection", () => {
    const stderr = [
      "To https://github.com/acme/app.git",
      " ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs to 'https://github.com/acme/app.git'",
      "hint: Updates were rejected because the remote contains work that you do not",
      "hint: have locally. This is usually caused by another repository pushing to"
    ].join("\n");
    expect(pushFailureReason(stderr, 1)).toBe("! [rejected] main -> main (fetch first)");
  });

  it("keeps protected-branch errors from the remote", () => {
    const stderr = [
      "remote: error: GH006: Protected branch update failed for refs/heads/main.        ",
      "remote: error: Changes must be made through a pull request.        ",
      "To https://github.com/acme/app.git",
      " ! [remote rejected] main -> main (protected branch hook declined)",
      "error: failed to push some refs to 'https://github.com/acme/app.git'"
    ].join("\r\n");
    expect(pushFailureReason(stderr, 1)).toBe(
      "GH006: Protected branch update failed for refs/heads/main. Changes must be made through a pull request. ! [remote rejected] main -> main (protected branch hook declined)"
    );
  });

  it("redacts credentials, caps the length and falls back to the push command", () => {
    const long = `remote: error: ${"x".repeat(500)}`;
    expect(pushFailureReason(long, 1).length).toBe(300);
    expect(pushFailureReason("fatal: unable to access 'https://user:secret@example.com/r.git/': denied", 128)).not.toContain("secret");
    expect(pushFailureReason(" ! [rejected] main -> main (https://user:secret@example.com)", 1)).not.toContain("secret");
    expect(pushFailureReason("", 1)).toBe("git push exited with code 1");
  });
});

describe("GitService.push rejection", () => {
  it("explains a non-fast-forward rejection", async () => {
    const { local, other } = setup();
    commitFile(other, "b.txt", "two\n", "theirs");
    git(other, "push", "-q", "origin", "main");
    commitFile(local, "c.txt", "three\n", "mine");
    await expect(new GitService().push(local)).rejects.toThrow(/^Push failed: ! \[rejected\] main -> main \((fetch first|non-fast-forward)\)/);
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

  it("deletes a branch only while it still points at the given commit", async () => {
    const { local } = setup();
    const first = git(local, "rev-parse", "HEAD");
    commitFile(local, "b.txt", "two\n", "second");
    const second = git(local, "rev-parse", "HEAD");
    const service = new GitService();
    await service.createBranch(local, "feature/x", first, false);
    expect(await service.deleteBranchAt(local, "feature/x", second)).toBe(false);
    expect(git(local, "rev-parse", "feature/x")).toBe(first);
    expect(await service.deleteBranchAt(local, "feature/x", first)).toBe(true);
    expect(git(local, "branch", "--list", "feature/x")).toBe("");
    expect(await service.deleteBranchAt(local, "feature/x", first)).toBe(false);
  });
});
