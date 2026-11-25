import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_PATCH_MAX_CHARS, HistoryService } from "./HistoryService.js";

const sandboxes: string[] = [];
let clock = 1_700_000_000;

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-history-"));
  sandboxes.push(dir);
  return dir;
}

function git(repo: string, ...args: string[]): string {
  clock += 60;
  const date = `${clock} +0000`;
  return execFileSync("git", ["-C", repo, "-c", "user.name=cw-code", "-c", "user.email=test@cw-code.local", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: "utf8"
  }).trim();
}

function initRepo(): string {
  const repo = join(sandbox(), "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  return repo;
}

function commitFile(repo: string, file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content, "utf8");
  git(repo, "add", "--", file);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

const service = new HistoryService(() => "git");

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HistoryService.log", () => {
  it("returns an empty history for a repository without commits", async () => {
    const repo = initRepo();
    const log = await service.log(repo, 10);
    expect(log).toMatchObject({ head: { sha: null, branch: "main", detached: false }, refs: [], commits: [], truncated: false });
    expect(log.worktrees.map((worktree) => [worktree.name, worktree.branch, worktree.isCurrent])).toEqual([["repo", "main", true]]);
  });

  it("walks branches, merges, annotated tags and stashes without stash internals", async () => {
    const repo = initRepo();
    const root = commitFile(repo, "a.txt", "a\n", "root");
    git(repo, "switch", "-q", "-c", "feature");
    const feature = commitFile(repo, "b.txt", "b\n", "feature work");
    git(repo, "switch", "-q", "main");
    const mainWork = commitFile(repo, "c.txt", "c\n", "main work");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    const merge = git(repo, "rev-parse", "HEAD");
    git(repo, "tag", "-a", "v1", "-m", "release", root);
    writeFileSync(join(repo, "a.txt"), "changed\n", "utf8");
    writeFileSync(join(repo, "untracked.txt"), "u\n", "utf8");
    git(repo, "stash", "push", "-q", "-u", "-m", "parked");

    const log = await service.log(repo, 100);

    expect(log.head).toEqual({ sha: merge, branch: "main", detached: false });
    expect(log.truncated).toBe(false);
    expect(log.commits.find((entry) => entry.sha === merge)?.parents).toEqual([mainWork, feature]);
    expect(log.refs.find((ref) => ref.fullName === "refs/tags/v1")?.target).toBe(root);
    expect(log.refs.find((ref) => ref.fullName === "refs/heads/main")?.isCurrent).toBe(true);
    const stash = log.commits.filter((entry) => entry.isStash);
    expect(stash).toHaveLength(1);
    expect(stash[0]?.parents).toEqual([merge]);
    expect(log.refs.find((ref) => ref.kind === "stash")?.name).toBe("stash@{0}");
    expect(log.commits.some((entry) => /^(index on|untracked files on)/.test(entry.subject))).toBe(false);
    expect(log.commits.filter((entry) => !entry.isStash)).toHaveLength(4);
  });

  it("marks the log as truncated past the limit", async () => {
    const repo = initRepo();
    for (let i = 0; i < 4; i++) commitFile(repo, "a.txt", `${i}\n`, `c${i}`);
    const log = await service.log(repo, 2);
    expect(log.truncated).toBe(true);
    expect(log.commits.map((entry) => entry.subject)).toEqual(["c3", "c2"]);
  });

  it("reports a detached HEAD", async () => {
    const repo = initRepo();
    const first = commitFile(repo, "a.txt", "1\n", "one");
    commitFile(repo, "a.txt", "2\n", "two");
    git(repo, "switch", "-q", "--detach", first);
    const { head } = await service.snapshot(repo);
    expect(head).toEqual({ sha: first, branch: null, detached: true });
  });

  it("changes the snapshot when a stash is pushed or an older stash is dropped", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "1\n", "one");
    const empty = await service.snapshot(repo);
    expect(empty.stashes).toEqual([]);

    writeFileSync(join(repo, "a.txt"), "2\n", "utf8");
    git(repo, "stash", "push", "-q", "-m", "first");
    writeFileSync(join(repo, "a.txt"), "3\n", "utf8");
    git(repo, "stash", "push", "-q", "-m", "second");
    const pushed = await service.snapshot(repo);
    expect(pushed.stashes).toHaveLength(2);
    expect(JSON.stringify(pushed)).not.toBe(JSON.stringify(empty));

    git(repo, "stash", "drop", "-q", "stash@{1}");
    const dropped = await service.snapshot(repo);
    expect(dropped.stashes).toEqual([pushed.stashes[0]]);
    expect(dropped.head).toEqual(pushed.head);
    expect(dropped.refs).toEqual(pushed.refs);
  });

  it("fails visibly outside a git repository", async () => {
    await expect(service.snapshot(sandbox())).rejects.toThrow(/not a git repository/i);
  });

  it("never rewrites the index while reading", async () => {
    const repo = initRepo();
    const sha = commitFile(repo, "a.txt", "a\n", "one");
    writeFileSync(join(repo, "a.txt"), "dirty\n", "utf8");
    const before = statSync(join(repo, ".git", "index")).mtimeMs;
    await service.log(repo, 10);
    await service.commit(repo, sha);
    expect(statSync(join(repo, ".git", "index")).mtimeMs).toBe(before);
  });
});

describe("HistoryService.commit", () => {
  it("diffs a root commit against the empty tree", async () => {
    const repo = initRepo();
    const sha = commitFile(repo, "a.txt", "hello\n", "root\n\nbody line");
    const detail = await service.commit(repo, sha);
    expect(detail).toMatchObject({ sha, parents: [], subject: "root", body: "body line", committerName: "cw-code", patchTruncated: false });
    expect(detail.patch).toContain("new file mode");
    expect(detail.patch).toContain("+hello");
  });

  it("diffs a merge against its first parent and keeps renames", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n", "root");
    git(repo, "switch", "-q", "-c", "feature");
    mkdirSync(join(repo, "dir"));
    git(repo, "mv", "a.txt", "dir/renamed.txt");
    git(repo, "commit", "-q", "-m", "rename");
    git(repo, "switch", "-q", "main");
    commitFile(repo, "c.txt", "c\n", "main work");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    const detail = await service.commit(repo, git(repo, "rev-parse", "HEAD"));
    expect(detail.parents).toHaveLength(2);
    expect(detail.patch).toContain("rename from a.txt");
    expect(detail.patch).toContain("rename to dir/renamed.txt");
    expect(detail.patch).not.toContain("c.txt");
  });

  it("truncates a huge patch on a line boundary", async () => {
    const repo = initRepo();
    const big = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const sha = commitFile(repo, "big.txt", `${big}\n`, "big");
    const detail = await service.commit(repo, sha);
    expect(detail.patchTruncated).toBe(true);
    expect(detail.patch.length).toBeLessThanOrEqual(HISTORY_PATCH_MAX_CHARS);
    expect(detail.patch.endsWith("\n")).toBe(true);
  });

  it("rejects an unknown commit", async () => {
    const repo = initRepo();
    commitFile(repo, "a.txt", "a\n", "one");
    await expect(service.commit(repo, "0".repeat(40))).rejects.toThrow(/not found/);
  });
});

describe("HistoryService.log worktrees", () => {
  it("lists every worktree with its branch and marks the one being read", async () => {
    const repo = initRepo();
    const first = commitFile(repo, "a.txt", "a\n", "one");
    git(repo, "branch", "feature");
    const linked = join(sandbox(), "wt-feature");
    git(repo, "worktree", "add", "-q", linked, "feature");
    const detached = join(sandbox(), "wt-detached");
    git(repo, "worktree", "add", "-q", "--detach", detached, first);

    const fromMain = await service.log(repo, 50);
    const rows = fromMain.worktrees.map((worktree) => [worktree.name, worktree.branch, worktree.isMain, worktree.isCurrent]);
    expect([rows[0], ...rows.slice(1).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]).toEqual([
      ["repo", "main", true, true],
      ["wt-detached", null, false, false],
      ["wt-feature", "feature", false, false]
    ]);
    expect(fromMain.worktrees.find((worktree) => worktree.name === "wt-detached")?.head).toBe(first);

    const fromLinked = await service.log(linked, 50);
    expect(fromLinked.worktrees.filter((worktree) => worktree.isCurrent).map((worktree) => worktree.name)).toEqual(["wt-feature"]);
  });
});
