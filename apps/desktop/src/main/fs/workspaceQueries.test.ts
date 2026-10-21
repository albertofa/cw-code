import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextSearchQuery } from "@cw-code/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildGrepArgs,
  gitBaseline,
  gitDecorations,
  listWorkspaceFiles,
  matchRanges,
  parseGitDecorations,
  parseGrepOutput,
  buildStatusArgs,
  parseNulList,
  searchText,
  trimPreview
} from "./workspaceQueries.js";

const HASH = "d675fa44e50606caa705c3f48de02cf129c7f9a2";
const ZERO = "0000000000000000000000000000000000000000";

function ordinary(xy: string, path: string): string {
  return `1 ${xy} N... 100644 100644 100644 ${HASH} ${HASH} ${path}`;
}

function status(...records: string[]): string {
  return records.map((record) => `${record}\0`).join("");
}

function query(overrides: Partial<TextSearchQuery> = {}): TextSearchQuery {
  return { query: "foo", isRegex: false, matchCase: false, wholeWord: false, ...overrides };
}

describe("parseGitDecorations", () => {
  it("maps ordinary records by XY", () => {
    const out = status(ordinary(".M", "a.ts"), ordinary("A.", "b.ts"), ordinary(".D", "c.ts"), ordinary("D.", "d.ts"), ordinary("MM", "e.ts"));
    expect(parseGitDecorations(out, "")).toEqual([
      { path: "a.ts", state: "modified", isDir: false },
      { path: "b.ts", state: "added", isDir: false },
      { path: "c.ts", state: "deleted", isDir: false },
      { path: "d.ts", state: "deleted", isDir: false },
      { path: "e.ts", state: "modified", isDir: false }
    ]);
  });

  it("consumes the original path of a rename record", () => {
    const rename = `2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 new name.ts\0old.ts`;
    const out = status(rename, ordinary(".M", "after.ts"));
    expect(parseGitDecorations(out, "")).toEqual([
      { path: "new name.ts", state: "renamed", isDir: false },
      { path: "after.ts", state: "modified", isDir: false }
    ]);
  });

  it("keeps spaces inside paths", () => {
    expect(parseGitDecorations(status(ordinary(".M", "my dir/my file.ts")), "")).toEqual([
      { path: "my dir/my file.ts", state: "modified", isDir: false }
    ]);
  });

  it("maps untracked and ignored entries and strips the trailing slash of directories", () => {
    const out = status("? new.ts", "? fresh/", "! dist/", "! debug.log");
    expect(parseGitDecorations(out, "")).toEqual([
      { path: "new.ts", state: "untracked", isDir: false },
      { path: "fresh", state: "untracked", isDir: true },
      { path: "dist", state: "ignored", isDir: true },
      { path: "debug.log", state: "ignored", isDir: false }
    ]);
  });

  it("maps unmerged records to conflict", () => {
    const unmerged = `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${ZERO} conflicted.ts`;
    expect(parseGitDecorations(status(unmerged), "")).toEqual([{ path: "conflicted.ts", state: "conflict", isDir: false }]);
  });

  it("keeps only paths under the prefix and strips it", () => {
    const out = status(ordinary(".M", "apps/desktop/src/a.ts"), ordinary(".M", "apps/web/b.ts"), "? apps/desktop/new/", "? apps/desktop/");
    expect(parseGitDecorations(out, "apps/desktop/")).toEqual([
      { path: "src/a.ts", state: "modified", isDir: false },
      { path: "new", state: "untracked", isDir: true }
    ]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseGitDecorations("", "")).toEqual([]);
  });
});

describe("parseNulList", () => {
  it("splits on NUL and drops empty items", () => {
    expect(parseNulList("a.ts\0dir/b.ts\0")).toEqual(["a.ts", "dir/b.ts"]);
    expect(parseNulList("")).toEqual([]);
  });
});

describe("buildGrepArgs", () => {
  const base = ["--no-optional-locks", "grep", "-n", "-z", "-I", "--no-color", "--no-column", "--no-full-name"];

  it("uses --untracked in a repo and --no-index with --exclude-standard outside", () => {
    expect(buildGrepArgs(query({ matchCase: true }), true, true)).toEqual([...base, "--untracked", "-F", "-e", "foo", "--"]);
    expect(buildGrepArgs(query({ matchCase: true }), false, true)).toEqual([...base, "--no-index", "--exclude-standard", "-F", "-e", "foo", "--"]);
  });

  it("never takes optional locks", () => {
    expect(buildGrepArgs(query(), true, true).slice(0, 2)).toEqual(["--no-optional-locks", "grep"]);
    expect(buildStatusArgs()).toEqual(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignored=matching"]);
  });

  it("adds -i unless matching case", () => {
    expect(buildGrepArgs(query({ matchCase: false }), true, true)).toContain("-i");
    expect(buildGrepArgs(query({ matchCase: true }), true, true)).not.toContain("-i");
  });

  it("adds -w for whole word", () => {
    expect(buildGrepArgs(query({ wholeWord: true }), true, true)).toContain("-w");
    expect(buildGrepArgs(query({ wholeWord: false }), true, true)).not.toContain("-w");
  });

  it("picks the pattern flag from regex and pcre", () => {
    const flags = (isRegex: boolean, pcre: boolean) => buildGrepArgs(query({ isRegex }), true, pcre).filter((arg) => ["-F", "-P", "-E"].includes(arg));
    expect(flags(false, true)).toEqual(["-F"]);
    expect(flags(false, false)).toEqual(["-F"]);
    expect(flags(true, true)).toEqual(["-P"]);
    expect(flags(true, false)).toEqual(["-E"]);
  });

  it("passes the query after -e so leading dashes are safe", () => {
    const args = buildGrepArgs(query({ query: "-x" }), true, true);
    expect(args.slice(args.indexOf("-e"))).toEqual(["-e", "-x", "--"]);
  });

  it("builds include pathspecs, anchoring globs without a slash to any depth", () => {
    const args = buildGrepArgs(query({ include: "*.ts, src/**" }), true, true);
    expect(args.slice(args.indexOf("--") + 1)).toEqual([":(glob)**/*.ts", ":(glob)**/*.ts/**", ":(glob)src/**"]);
  });

  it("builds exclude pathspecs and searches everything when only excludes are set", () => {
    const args = buildGrepArgs(query({ exclude: "node_modules, dist/, test/fixtures" }), true, true);
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      ".",
      ":(exclude,glob)**/node_modules",
      ":(exclude,glob)**/node_modules/**",
      ":(exclude,glob)**/dist",
      ":(exclude,glob)**/dist/**",
      ":(exclude,glob)test/fixtures",
      ":(exclude,glob)test/fixtures/**"
    ]);
  });

  it("combines includes and excludes without the dot pathspec", () => {
    const args = buildGrepArgs(query({ include: "src/**", exclude: "**/*.test.ts" }), true, true);
    expect(args.slice(args.indexOf("--") + 1)).toEqual([":(glob)src/**", ":(exclude,glob)**/*.test.ts", ":(exclude,glob)**/*.test.ts/**"]);
  });

  it("ignores blank glob entries", () => {
    const args = buildGrepArgs(query({ include: " , ", exclude: "" }), true, true);
    expect(args.slice(args.indexOf("--") + 1)).toEqual([]);
  });
});

describe("parseGrepOutput", () => {
  it("parses path, line and text", () => {
    const out = "src/a.ts\x0012\x00const foo = 1;\nb.ts\x003\x00foo\n";
    expect(parseGrepOutput(out, 10)).toEqual({
      lines: [
        { path: "src/a.ts", line: 12, text: "const foo = 1;" },
        { path: "b.ts", line: 3, text: "foo" }
      ],
      truncated: false
    });
  });

  it("keeps colons in paths and text", () => {
    const out = "dir:name/we:ird.txt\x001\x00a:b:foo\n";
    expect(parseGrepOutput(out, 10).lines).toEqual([{ path: "dir:name/we:ird.txt", line: 1, text: "a:b:foo" }]);
  });

  it("strips carriage returns from CRLF lines", () => {
    const out = "a.txt\x001\x00foo\r\na.txt\x002\x00bar foo\r\n";
    expect(parseGrepOutput(out, 10).lines.map((line) => line.text)).toEqual(["foo", "bar foo"]);
  });

  it("drops results outside the root", () => {
    const out = "../secret.txt\x001\x00foo\nok.txt\x002\x00foo\n";
    expect(parseGrepOutput(out, 10).lines).toEqual([{ path: "ok.txt", line: 2, text: "foo" }]);
  });

  it("keeps lines with empty text", () => {
    expect(parseGrepOutput("a.txt\x005\x00\n", 10).lines).toEqual([{ path: "a.txt", line: 5, text: "" }]);
  });

  it("truncates at the limit and flags it", () => {
    const out = "a\x001\x00x\na\x002\x00x\na\x003\x00x\n";
    expect(parseGrepOutput(out, 2)).toEqual({
      lines: [
        { path: "a", line: 1, text: "x" },
        { path: "a", line: 2, text: "x" }
      ],
      truncated: true
    });
    expect(parseGrepOutput(out, 3).truncated).toBe(false);
  });

  it("returns nothing for empty output", () => {
    expect(parseGrepOutput("", 10)).toEqual({ lines: [], truncated: false });
  });
});

describe("matchRanges", () => {
  it("matches literal text with special characters", () => {
    expect(matchRanges("a.b a+b (x)", query({ query: "a.b" }))).toEqual([[0, 3]]);
    expect(matchRanges("call(x) call(y)", query({ query: "(x)" }))).toEqual([[4, 7]]);
    expect(matchRanges("1+1 and 1+1", query({ query: "1+1" }))).toEqual([
      [0, 3],
      [8, 11]
    ]);
  });

  it("honors case sensitivity", () => {
    expect(matchRanges("Foo foo FOO", query({ matchCase: false }))).toHaveLength(3);
    expect(matchRanges("Foo foo FOO", query({ matchCase: true }))).toEqual([[4, 7]]);
  });

  it("honors whole word", () => {
    expect(matchRanges("foo foobar barfoo foo", query({ wholeWord: true }))).toEqual([
      [0, 3],
      [18, 21]
    ]);
  });

  it("keeps regex alternations inside the word boundaries", () => {
    expect(matchRanges("cat category dog", query({ query: "cat|dog", isRegex: true, wholeWord: true }))).toEqual([
      [0, 3],
      [13, 16]
    ]);
  });

  it("supports regex queries and skips zero-length matches", () => {
    expect(matchRanges("ab12 cd345", query({ query: "\\d+", isRegex: true }))).toEqual([
      [2, 4],
      [7, 10]
    ]);
    expect(matchRanges("abc", query({ query: "x*", isRegex: true }))).toEqual([]);
  });

  it("returns no ranges for an invalid regex or an empty query", () => {
    expect(matchRanges("abc (", query({ query: "(", isRegex: true }))).toEqual([]);
    expect(matchRanges("abc", query({ query: "" }))).toEqual([]);
  });
});

describe("trimPreview", () => {
  it("returns short lines untouched", () => {
    expect(trimPreview("hello foo", [[6, 9]])).toEqual({ preview: "hello foo", ranges: [[6, 9]] });
  });

  it("starts the window 40 chars before the first range and shifts ranges", () => {
    const text = `${"x".repeat(100)}foo${"y".repeat(500)}`;
    const result = trimPreview(text, [[100, 103]]);
    expect(result.preview).toHaveLength(400);
    expect(result.preview.startsWith(`${"x".repeat(40)}foo`)).toBe(true);
    expect(result.ranges).toEqual([[40, 43]]);
  });

  it("drops ranges outside the window and clamps the one crossing its end", () => {
    const text = `${"a".repeat(10)}foo${"b".repeat(600)}foo`;
    const result = trimPreview(text, [[10, 13], [613, 616]], 100);
    expect(result.ranges).toEqual([[10, 13]]);
    const crossing = trimPreview(`${"a".repeat(10)}foobar${"c".repeat(200)}`, [[10, 16]], 12);
    expect(crossing.preview).toHaveLength(12);
    expect(crossing.ranges).toEqual([[10, 12]]);
  });

  it("starts at zero when the first range is near the start", () => {
    const text = `foo${"z".repeat(900)}`;
    const result = trimPreview(text, [[0, 3]]);
    expect(result.preview).toHaveLength(400);
    expect(result.ranges).toEqual([[0, 3]]);
  });

  it("starts at zero when there are no ranges", () => {
    const result = trimPreview("q".repeat(900), []);
    expect(result.preview).toHaveLength(400);
    expect(result.ranges).toEqual([]);
  });
});

describe("against a real git repository", () => {
  let repo: string;
  let plain: string;

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "cw-workspace-queries-"));
    repo = join(base, "repo");
    plain = join(base, "plain");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(repo, "dist"));
    mkdirSync(plain);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    writeFileSync(join(repo, "src", "a.ts"), "const foo = 1;\r\nconst Foobar = 2;\r\n");
    writeFileSync(join(repo, "src", "b.md"), "foo in markdown\n");
    writeFileSync(join(repo, "node_modules", "pkg", "i.js"), "foo\n");
    writeFileSync(join(repo, "dist", "out.js"), "foo\n");
    writeFileSync(join(repo, "bin.dat"), Buffer.from("foo\0bar"));
    writeFileSync(join(repo, "src", "gone.ts"), "export {};\n");
    git(repo, "add", "-f", ".gitignore", "src", "node_modules");
    git(repo, "commit", "-qm", "init");
    rmSync(join(repo, "src", "gone.ts"));
    writeFileSync(join(repo, "src", "a.ts"), "const foo = 1;\r\nconst Foobar = 2;\r\nchanged\r\n");
    writeFileSync(join(repo, "untracked.txt"), "foo untracked\n");
    writeFileSync(join(plain, "note.txt"), "foo outside\n");
  });

  afterAll(() => {
    rmSync(join(repo, ".."), { recursive: true, force: true });
  });

  it("returns the HEAD version of a tracked file", async () => {
    expect(await gitBaseline("git", repo, "src/a.ts")).toEqual({ kind: "tracked", content: "const foo = 1;\r\nconst Foobar = 2;\r\n" });
    expect(await gitBaseline("git", join(repo, "src"), "a.ts")).toEqual({ kind: "tracked", content: "const foo = 1;\r\nconst Foobar = 2;\r\n" });
  });

  it("reports untracked files and treats ignored files and non-repos as having no baseline", async () => {
    expect(await gitBaseline("git", repo, "untracked.txt")).toEqual({ kind: "untracked" });
    expect(await gitBaseline("git", repo, "dist/out.js")).toEqual({ kind: "none" });
    expect(await gitBaseline("git", plain, "note.txt")).toEqual({ kind: "none" });
  });

  it("reports decorations for a work tree", async () => {
    const result = await gitDecorations("git", repo);
    expect(result.available).toBe(true);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { path: "src/a.ts", state: "modified", isDir: false },
        { path: "untracked.txt", state: "untracked", isDir: false },
        { path: "dist", state: "ignored", isDir: true },
        { path: "bin.dat", state: "untracked", isDir: false }
      ])
    );
  });

  it("strips the prefix when the root is a subfolder", async () => {
    const result = await gitDecorations("git", join(repo, "src"));
    expect(result.available).toBe(true);
    expect(result.entries).toEqual([
      { path: "a.ts", state: "modified", isDir: false },
      { path: "gone.ts", state: "deleted", isDir: false }
    ]);
  });

  it("reports unavailable outside a work tree", async () => {
    expect(await gitDecorations("git", plain)).toEqual({ available: false, entries: [] });
  });

  it("throws when git cannot be run", async () => {
    await expect(gitDecorations("git-does-not-exist-xyz", repo)).rejects.toThrow(/could not run git/);
  });

  it("lists tracked and untracked files without ignored ones", async () => {
    const files = await listWorkspaceFiles("git", repo, () => ["fallback"]);
    expect(files).toEqual(expect.arrayContaining(["src/a.ts", "untracked.txt", ".gitignore"]));
    expect(files).not.toContain("dist/out.js");
    expect(files).not.toContain("src/gone.ts");
    expect(new Set(files).size).toBe(files.length);
  });

  it("falls back outside a work tree", async () => {
    expect(await listWorkspaceFiles("git", plain, () => ["note.txt"])).toEqual(["note.txt"]);
  });

  it("falls back when the git binary cannot be spawned", async () => {
    expect(await listWorkspaceFiles("git-does-not-exist-xyz", repo, () => ["fallback"])).toEqual(["fallback"]);
  });

  it("searches text with ranges, ignoring binary files", async () => {
    const result = await searchText("git", repo, query({ include: "*.ts" }));
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([
      { path: "src/a.ts", line: 1, preview: "const foo = 1;", ranges: [[6, 9]] },
      { path: "src/a.ts", line: 2, preview: "const Foobar = 2;", ranges: [[6, 9]] }
    ]);
  });

  it("includes untracked files and respects whole word and case", async () => {
    const all = await searchText("git", repo, query({ exclude: "node_modules" }));
    expect(all.matches.map((match) => match.path).sort()).toEqual(["src/a.ts", "src/a.ts", "src/b.md", "untracked.txt"]);
    const strict = await searchText("git", repo, query({ query: "Foo", matchCase: true, wholeWord: true }));
    expect(strict.matches).toEqual([]);
    expect(strict.error).toBeNull();
  });

  it("excludes whole directories by name", async () => {
    const result = await searchText("git", repo, query({ exclude: "node_modules" }));
    expect(result.matches.some((match) => match.path.startsWith("node_modules"))).toBe(false);
  });

  it("truncates at maxResults", async () => {
    const result = await searchText("git", repo, query({ maxResults: 2 }));
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("truncates broad searches instead of failing", async () => {
    writeFileSync(join(repo, "big.txt"), "foo line\n".repeat(30_000));
    const result = await searchText("git", repo, query());
    rmSync(join(repo, "big.txt"));
    expect(result.error).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.matches).toHaveLength(2000);
  });

  it.each(["../outside", "src/../../x", "/etc", "\\share", "C:\\Users", "c:foo", "ok/*.ts, ..\\x"])("rejects the include glob %s", async (include) => {
    const result = await searchText("git", repo, query({ include }));
    expect(result).toEqual({ matches: [], truncated: false, error: "include/exclude patterns must be relative to the workspace" });
  });

  it("rejects unsafe exclude globs", async () => {
    const result = await searchText("git", repo, query({ exclude: "node_modules, ../x" }));
    expect(result.error).toBe("include/exclude patterns must be relative to the workspace");
  });

  it("supports regex through PCRE or the ERE fallback", async () => {
    const result = await searchText("git", repo, query({ query: "Foo\\w+", isRegex: true, matchCase: true }));
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ path: "src/a.ts", line: 2, preview: "const Foobar = 2;", ranges: [[6, 12]] }]);
  });

  it("reports an invalid regex as an error", async () => {
    const result = await searchText("git", repo, query({ query: "(", isRegex: true }));
    expect(result.matches).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("returns an empty result for an empty query", async () => {
    expect(await searchText("git", repo, query({ query: "" }))).toEqual({ matches: [], truncated: false, error: null });
  });

  it("searches plain folders outside a work tree", async () => {
    const result = await searchText("git", plain, query());
    expect(result.error).toBeNull();
    expect(result.matches.map((match) => match.path)).toEqual(["note.txt"]);
  });

  it("reports a spawn failure as an error", async () => {
    const result = await searchText("git-does-not-exist-xyz", repo, query());
    expect(result.matches).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
