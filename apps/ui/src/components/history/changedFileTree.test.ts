import { describe, expect, it } from "bun:test";
import { changedFileTree } from "./changedFileTree.js";

const compact = (paths: string[]): string[] =>
  changedFileTree(paths).map((row) => `${"  ".repeat(row.depth)}${row.kind === "dir" ? `${row.name}/` : row.name}`);

describe("changedFileTree", () => {
  it("lists directories before files, sorted by name", () => {
    expect(compact(["README.md", "src/b.ts", "src/a.ts", "docs/x.md"])).toEqual(["docs/", "  x.md", "src/", "  a.ts", "  b.ts", "README.md"]);
  });

  it("folds a chain of single-child directories into one row", () => {
    expect(compact(["aws/lib/stacks/infra/a.ts", "aws/lib/stacks/infra/b.ts", "aws/docs/c.md"])).toEqual([
      "aws/",
      "  docs/",
      "    c.md",
      "  lib/stacks/infra/",
      "    a.ts",
      "    b.ts"
    ]);
  });

  it("keeps full paths on rows", () => {
    const rows = changedFileTree(["a/b/c.ts"]);
    expect(rows).toEqual([
      { kind: "dir", path: "a/b", name: "a/b", depth: 0 },
      { kind: "file", path: "a/b/c.ts", name: "c.ts", depth: 1 }
    ]);
  });

  it("handles no files", () => {
    expect(changedFileTree([])).toEqual([]);
  });
});
