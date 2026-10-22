import { describe, expect, it } from "bun:test";
import { fuzzyMatch, rankFiles } from "./fuzzy.js";

describe("fuzzyMatch", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "src/index.ts")).toBeNull();
    expect(fuzzyMatch("tsi", "src/index.ts")).toBeNull();
    expect(fuzzyMatch("abcdefghij", "abc")).toBeNull();
  });

  it("matches case-insensitively and reports positions", () => {
    expect(fuzzyMatch("FILE", "src/filePanel.tsx")?.positions).toEqual([4, 5, 6, 7]);
  });

  it("ignores spaces in the query", () => {
    expect(fuzzyMatch("file panel", "src/FilePanel.tsx")?.positions).toEqual(
      fuzzyMatch("filepanel", "src/FilePanel.tsx")?.positions
    );
  });

  it("accepts an empty query with no positions", () => {
    expect(fuzzyMatch("", "a.ts")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("  ", "a.ts")).toEqual({ score: 0, positions: [] });
  });

  it("prefers segment starts over scattered matches", () => {
    expect(fuzzyMatch("fp", "components/FilePanel.tsx")?.positions).toEqual([11, 15]);
  });

  it("scores consecutive matches above split matches", () => {
    const consecutive = fuzzyMatch("pane", "a/panel.ts");
    const split = fuzzyMatch("pane", "a/pxaxnxex.ts");
    expect(consecutive!.score).toBeGreaterThan(split!.score);
  });

  it("scores basename matches above directory matches", () => {
    const basename = fuzzyMatch("util", "src/util.ts");
    const directory = fuzzyMatch("util", "util/src.ts");
    expect(basename!.score).toBeGreaterThan(directory!.score);
  });

  it("handles camelCase boundaries, separators and special-case folding", () => {
    expect(fuzzyMatch("fp", "FilePanel.tsx")?.positions).toEqual([0, 4]);
    expect(fuzzyMatch("sf", "some-file.ts")?.positions).toEqual([0, 5]);
    expect(fuzzyMatch("stan", "İstanbul.ts")).not.toBeNull();
  });
});

describe("rankFiles", () => {
  const paths = [
    "foo/x/panel/a.ts",
    "components/FilePanel.tsx",
    "package.json",
    "packages/contracts/package.json",
    "README.md",
    "src/main/index.ts"
  ];

  it("ranks the basename abbreviation above a deep directory match", () => {
    const ranked = rankFiles("fpanel", paths);
    expect(ranked.map((item) => item.path).slice(0, 2)).toEqual(["components/FilePanel.tsx", "foo/x/panel/a.ts"]);
  });

  it("finds package.json for pkgjson and prefers the shorter path", () => {
    const ranked = rankFiles("pkgjson", paths);
    expect(ranked.map((item) => item.path)).toEqual(["package.json", "packages/contracts/package.json"]);
  });

  it("drops non-matching paths and honors the limit", () => {
    expect(rankFiles("zzz", paths)).toEqual([]);
    expect(rankFiles("a", paths, 2)).toHaveLength(2);
  });

  it("returns positions that point at the matched characters", () => {
    const [top] = rankFiles("readme", paths);
    expect(top.path).toBe("README.md");
    expect(top.positions).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("orders an empty query by path length", () => {
    expect(rankFiles("", ["abc.ts", "a.ts"]).map((item) => item.path)).toEqual(["a.ts", "abc.ts"]);
  });

  it("ranks a contiguous basename match above scattered segment-start matches", () => {
    const ranked = rankFiles("index", ["idx/n/d/e/x.ts", "src/components/IndexPage.tsx", "packages/contracts/src/index.ts"]);
    expect(ranked.map((item) => item.path)).toEqual([
      "packages/contracts/src/index.ts",
      "src/components/IndexPage.tsx",
      "idx/n/d/e/x.ts"
    ]);
  });

  it("penalizes a gap between the first and second matched characters", () => {
    const tight = fuzzyMatch("ab", "x/abxxxxxx");
    const loose = fuzzyMatch("ab", "x/axxxxxbx");
    expect(tight!.score).toBeGreaterThan(loose!.score + 3);
  });

  it("keeps the segment-start bonus across a consecutive run", () => {
    const atStart = fuzzyMatch("read", "docs/readme.md");
    const inside = fuzzyMatch("read", "docs/spreadsheet.md");
    expect(atStart!.score).toBeGreaterThan(inside!.score + 10);
  });

  it("returns positions consistent with a restricted match window", () => {
    expect(fuzzyMatch("abc", "abcabcabc")?.positions).toEqual([0, 1, 2]);
    expect(fuzzyMatch("cba", "abcba")?.positions).toEqual([2, 3, 4]);
    expect(fuzzyMatch("a", "bbbab")?.positions).toEqual([3]);
  });

  it("stays fast on 50k paths with a long query", () => {
    const many = Array.from({ length: 50_000 }, (_, index) => `packages/pkg${index % 500}/src/module${index}/file${index}.ts`);
    const query = "packagespkgsrcmodulefile49";
    const start = performance.now();
    const ranked = rankFiles(query, many);
    expect(performance.now() - start).toBeLessThan(150);
    expect(ranked.length).toBeGreaterThan(0);
  });
});
