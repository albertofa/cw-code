import { describe, expect, it } from "bun:test";
import type { HistoryCommit } from "@cw-code/contracts";
import { isFullSha, mergeStashes, parseCommitShow, parseHistoryLimit, parseLog, parseRefs, parseStashList, parseWorktreeList, worktreeKey } from "./historyParsers.js";

const R = "\x1e";
const S = "\x1f";
const line = (...fields: string[]) => fields.join(S);
const record = (...fields: string[]) => R + fields.join(S);

function commit(sha: string, committerDate: number, parents: string[] = [], isStash = false): HistoryCommit {
  return { sha, parents, authorName: "n", authorEmail: "e", authorDate: committerDate, committerDate, subject: sha, isStash };
}

describe("parseRefs", () => {
  it("parses a current local branch with upstream ahead and behind", () => {
    const out = line("refs/heads/main", "a".repeat(40), "", "refs/remotes/origin/main", "ahead 2, behind 3", "*");
    expect(parseRefs(`${out}\n`)).toEqual([
      {
        fullName: "refs/heads/main",
        name: "main",
        kind: "local",
        target: "a".repeat(40),
        isCurrent: true,
        upstream: "origin/main",
        ahead: 2,
        behind: 3,
        upstreamGone: false
      }
    ]);
  });

  it("flags a gone upstream", () => {
    const [ref] = parseRefs(line("refs/heads/old", "b".repeat(40), "", "refs/remotes/origin/old", "gone", " "));
    expect(ref).toMatchObject({ upstream: "origin/old", upstreamGone: true, ahead: 0, behind: 0, isCurrent: false });
  });

  it("uses the peeled target for annotated tags and the object for lightweight tags", () => {
    const out = [line("refs/tags/v1", "c".repeat(40), "d".repeat(40), "", "", " "), line("refs/tags/light", "e".repeat(40), "", "", "", " ")].join("\r\n");
    const [annotated, light] = parseRefs(out);
    expect(annotated).toMatchObject({ name: "v1", kind: "tag", target: "d".repeat(40), upstream: null });
    expect(light).toMatchObject({ name: "light", kind: "tag", target: "e".repeat(40) });
  });

  it("drops remote HEAD, including remotes with a slash in the name", () => {
    const out = [
      line("refs/remotes/origin/HEAD", "f".repeat(40), "", "", "", " "),
      line("refs/remotes/team/fork/HEAD", "f".repeat(40), "", "", "", " "),
      line("refs/remotes/team/fork/feature/x", "9".repeat(40), "", "", "", " ")
    ].join("\n");
    expect(parseRefs(out).map((ref) => [ref.kind, ref.name])).toEqual([["remote", "team/fork/feature/x"]]);
  });

  it("returns empty for empty output", () => {
    expect(parseRefs("")).toEqual([]);
  });
});

describe("parseLog", () => {
  it("parses merge and root records", () => {
    const out = `${record("a".repeat(40), `${"b".repeat(40)} ${"c".repeat(40)}`, "Ana", "ana@x.com", "100", "200", "merge")}\n${record("b".repeat(40), "", "Bob", "bob@x.com", "50", "60", "root")}\n`;
    const [merge, root] = parseLog(out);
    expect(merge).toEqual({
      sha: "a".repeat(40),
      parents: ["b".repeat(40), "c".repeat(40)],
      authorName: "Ana",
      authorEmail: "ana@x.com",
      authorDate: 100,
      committerDate: 200,
      subject: "merge",
      isStash: false
    });
    expect(root?.parents).toEqual([]);
  });

  it("keeps accents and a field separator inside the subject", () => {
    const subject = `feat: ação "quotes" | ünïcode${S}right`;
    const [entry] = parseLog(`${record("d".repeat(40), "", "José", "jose@x.com", "1", "2", subject)}\n`);
    expect(entry?.subject).toBe(subject);
    expect(entry?.authorName).toBe("José");
  });

  it("returns empty for empty output", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("parseStashList", () => {
  it("keeps only the first parent and builds the stash ref", () => {
    const out = `${record("s".repeat(40), `${"b".repeat(40)} ${"i".repeat(40)} ${"u".repeat(40)}`, "Ana", "ana@x.com", "10", "20", "stash@{0}", "WIP on main: abc msg")}\n`;
    const [entry] = parseStashList(out);
    expect(entry?.commit).toMatchObject({ sha: "s".repeat(40), parents: ["b".repeat(40)], committerDate: 20, subject: "WIP on main: abc msg", isStash: true });
    expect(entry?.ref).toMatchObject({ kind: "stash", name: "stash@{0}", target: "s".repeat(40) });
  });
});

describe("mergeStashes", () => {
  it("inserts before the first older commit", () => {
    const commits = [commit("c5", 50, ["c4"]), commit("c4", 40, ["c3"]), commit("c3", 30, ["c2"])];
    expect(mergeStashes(commits, [commit("st", 45, ["c3"], true)]).map((entry) => entry.sha)).toEqual(["c5", "st", "c4", "c3"]);
  });

  it("never places a stash below its base commit", () => {
    const commits = [commit("c5", 50, ["c4"]), commit("c4", 40, ["c3"]), commit("c3", 30, [])];
    expect(mergeStashes(commits, [commit("st", 10, ["c4"], true)]).map((entry) => entry.sha)).toEqual(["c5", "st", "c4", "c3"]);
  });

  it("puts an old stash with an unloaded base at the end without mutating the input", () => {
    const commits = [commit("c5", 50, ["c4"]), commit("c4", 40, [])];
    expect(mergeStashes(commits, [commit("st", 5, ["missing"], true)]).map((entry) => entry.sha)).toEqual(["c5", "c4", "st"]);
    expect(commits).toHaveLength(2);
  });
});

describe("parseCommitShow", () => {
  it("parses fields, parents and a multi-line body", () => {
    const out = `${["abc", "p1 p2", "Ana", "a@x.com", "100", "Bob", "b@x.com", "200", "subject", "line1\n\nline2\n"].join(S)}\n`;
    expect(parseCommitShow(out)).toEqual({
      sha: "abc",
      parents: ["p1", "p2"],
      authorName: "Ana",
      authorEmail: "a@x.com",
      authorDate: 100,
      committerName: "Bob",
      committerEmail: "b@x.com",
      committerDate: 200,
      subject: "subject",
      body: "line1\n\nline2"
    });
  });

  it("returns no parents for a root commit", () => {
    const result = parseCommitShow(`${["abc", "", "Ana", "a@x.com", "1", "Ana", "a@x.com", "1", "s", ""].join(S)}\n`);
    expect(result.parents).toEqual([]);
    expect(result.body).toBe("");
  });
});

describe("validation", () => {
  it("accepts only full lowercase shas", () => {
    expect(isFullSha("a".repeat(40))).toBe(true);
    expect(isFullSha("a".repeat(39))).toBe(false);
    expect(isFullSha("A".repeat(40))).toBe(false);
    expect(isFullSha(`--${"a".repeat(38)}`)).toBe(false);
    expect(isFullSha(undefined)).toBe(false);
  });

  it("defaults the limit and rejects out-of-range values", () => {
    expect(parseHistoryLimit(undefined)).toBe(2000);
    expect(parseHistoryLimit(20000)).toBe(20000);
    expect(() => parseHistoryLimit(0)).toThrow();
    expect(() => parseHistoryLimit(20001)).toThrow();
    expect(() => parseHistoryLimit(1.5)).toThrow();
    expect(() => parseHistoryLimit("10")).toThrow();
  });
});

describe("parseWorktreeList", () => {
  const sha = "a".repeat(40);
  const output = [
    `worktree C:/repo/app\nHEAD ${sha}\nbranch refs/heads/main\n`,
    `worktree C:/wt-feature\nHEAD ${sha}\nbranch refs/heads/feature/x\nlocked\n`,
    `worktree C:/tmp/detached\nHEAD ${sha}\ndetached\n`,
    ""
  ].join("\n");

  it("reads branch, head and folder name and marks the main and current worktrees", () => {
    expect(parseWorktreeList(output, "C:/wt-feature")).toEqual([
      { key: worktreeKey("C:/repo/app"), path: "C:/repo/app", name: "app", branch: "main", head: sha, isCurrent: false, isMain: true, sessionId: null },
      { key: worktreeKey("C:/wt-feature"), path: "C:/wt-feature", name: "wt-feature", branch: "feature/x", head: sha, isCurrent: true, isMain: false, sessionId: null },
      { key: worktreeKey("C:/tmp/detached"), path: "C:/tmp/detached", name: "detached", branch: null, head: sha, isCurrent: false, isMain: false, sessionId: null }
    ]);
  });

  it("keys a worktree by its normalized path", () => {
    expect(worktreeKey("C:/wt-feature")).toMatch(/^[0-9a-f]{16}$/);
    expect(worktreeKey("C:/wt-feature/")).toBe(worktreeKey("C:\\wt-feature"));
    expect(worktreeKey("C:/wt-feature")).not.toBe(worktreeKey("C:/wt-other"));
  });

  it("skips a bare main entry without promoting the next one to main", () => {
    const bare = `worktree C:/repo/app.git\nbare\n\nworktree C:/wt\nHEAD ${sha}\nbranch refs/heads/dev\n`;
    expect(parseWorktreeList(bare, "").map((worktree) => [worktree.name, worktree.isMain])).toEqual([["wt", false]]);
  });
});
