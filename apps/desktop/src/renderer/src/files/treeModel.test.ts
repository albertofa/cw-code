import { describe, expect, it } from "vitest";
import type { DirEntry } from "@cw-code/contracts";
import { ancestorsOf, flattenTree, parentDir, rebasePath } from "./treeModel.js";

const dir = (path: string): DirEntry => ({ name: path.split("/").pop() ?? path, path, isDir: true });
const file = (path: string): DirEntry => ({ name: path.split("/").pop() ?? path, path, isDir: false });

const childrenByDir: Record<string, DirEntry[]> = {
  "": [dir("src"), dir("docs"), file("package.json")],
  src: [dir("src/lib"), file("src/index.ts")],
  "src/lib": [file("src/lib/a.ts")]
};

describe("flattenTree", () => {
  it("lists only the root children when nothing is expanded", () => {
    const rows = flattenTree(childrenByDir, new Set(), new Set(), {});
    expect(rows.map((row) => [row.path, row.depth, row.expanded])).toEqual([
      ["src", 0, false],
      ["docs", 0, false],
      ["package.json", 0, false]
    ]);
  });

  it("walks expanded directories depth-first", () => {
    const rows = flattenTree(childrenByDir, new Set(["src", "src/lib"]), new Set(), {});
    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      "0:src",
      "1:src/lib",
      "2:src/lib/a.ts",
      "1:src/index.ts",
      "0:docs",
      "0:package.json"
    ]);
    expect(rows[0]).toMatchObject({ name: "src", isDir: true, expanded: true, loading: false, error: null });
  });

  it("flags an expanded directory that is loading or failed, without synthetic rows", () => {
    const rows = flattenTree(childrenByDir, new Set(["docs", "src"]), new Set(["docs"]), { src: "denied" });
    expect(rows.find((row) => row.path === "docs")).toMatchObject({ expanded: true, loading: true, error: null });
    expect(rows.find((row) => row.path === "src")).toMatchObject({ expanded: true, loading: false, error: "denied" });
    expect(rows.some((row) => row.path.startsWith("docs/"))).toBe(false);
  });

  it("ignores loading and error flags on collapsed directories and expanded files", () => {
    const rows = flattenTree(childrenByDir, new Set(["package.json"]), new Set(["src"]), { src: "x" });
    expect(rows.find((row) => row.path === "src")).toMatchObject({ expanded: false, loading: false, error: null });
    expect(rows.find((row) => row.path === "package.json")).toMatchObject({ expanded: false });
  });

  it("returns no rows for an empty workspace", () => {
    expect(flattenTree({}, new Set(), new Set(), {})).toEqual([]);
  });
});

describe("path helpers", () => {
  it("computes parent directories", () => {
    expect(parentDir("a/b/c.ts")).toBe("a/b");
    expect(parentDir("a")).toBe("");
    expect(parentDir("")).toBe("");
  });

  it("lists ancestors outermost first, excluding the root", () => {
    expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("a")).toEqual([]);
    expect(ancestorsOf("")).toEqual([]);
  });

  it("rebases exact matches and descendants only", () => {
    expect(rebasePath("a/b", "a/b", "x/y")).toBe("x/y");
    expect(rebasePath("a/b/c.ts", "a/b", "x/y")).toBe("x/y/c.ts");
    expect(rebasePath("a/bc/c.ts", "a/b", "x/y")).toBeNull();
    expect(rebasePath("other", "a/b", "x/y")).toBeNull();
  });
});
