import { describe, expect, it } from "bun:test";
import type { GitFileDecoration } from "@cw-code/contracts";
import { buildDecorationIndex } from "./gitDecorationIndex.js";

const file = (path: string, state: GitFileDecoration["state"]): GitFileDecoration => ({ path, state, isDir: false });
const dir = (path: string, state: GitFileDecoration["state"]): GitFileDecoration => ({ path, state, isDir: true });

describe("buildDecorationIndex", () => {
  it("returns direct entries as not inherited and null for unknown paths", () => {
    const lookup = buildDecorationIndex([file("a/b.ts", "modified")]);
    expect(lookup("a/b.ts", false)).toEqual({ state: "modified", inherited: false });
    expect(lookup("a/c.ts", false)).toBeNull();
    expect(lookup("z", true)).toBeNull();
  });

  it("propagates ignored and untracked directories down to every descendant", () => {
    const lookup = buildDecorationIndex([dir("node_modules", "ignored"), dir("fresh", "untracked")]);
    expect(lookup("node_modules", true)).toEqual({ state: "ignored", inherited: false });
    expect(lookup("node_modules/pkg/index.js", false)).toEqual({ state: "ignored", inherited: true });
    expect(lookup("node_modules/pkg", true)).toEqual({ state: "ignored", inherited: true });
    expect(lookup("fresh/deep/x.ts", false)).toEqual({ state: "untracked", inherited: true });
  });

  it("lets a direct entry win over an inherited one", () => {
    const lookup = buildDecorationIndex([dir("build", "ignored"), file("build/keep.txt", "added")]);
    expect(lookup("build/keep.txt", false)).toEqual({ state: "added", inherited: false });
    expect(lookup("build/other.txt", false)).toEqual({ state: "ignored", inherited: true });
  });

  it("inherits from the nearest cascading ancestor", () => {
    const lookup = buildDecorationIndex([dir("new", "untracked"), dir("new/build", "ignored")]);
    expect(lookup("new/build/o.txt", false)).toEqual({ state: "ignored", inherited: true });
    expect(lookup("new/src/a.ts", false)).toEqual({ state: "untracked", inherited: true });
  });

  it("gives a directory the highest priority state among its changed descendants", () => {
    const lookup = buildDecorationIndex([
      file("src/a.ts", "added"),
      file("src/lib/b.ts", "deleted"),
      file("src/lib/c.ts", "modified"),
      file("src/x/d.ts", "conflict"),
      file("docs/e.md", "untracked"),
      file("docs/f.md", "renamed")
    ]);
    expect(lookup("src", true)).toEqual({ state: "conflict", inherited: true });
    expect(lookup("src/lib", true)).toEqual({ state: "modified", inherited: true });
    expect(lookup("docs", true)).toEqual({ state: "renamed", inherited: true });
    expect(lookup("src/a.ts", false)).toEqual({ state: "added", inherited: false });
  });

  it("orders deleted above renamed above added above untracked", () => {
    const lookup = buildDecorationIndex([
      file("p/a", "untracked"),
      file("p/b", "added"),
      file("q/a", "added"),
      file("q/b", "renamed"),
      file("r/a", "renamed"),
      file("r/b", "deleted")
    ]);
    expect(lookup("p", true)?.state).toBe("added");
    expect(lookup("q", true)?.state).toBe("renamed");
    expect(lookup("r", true)?.state).toBe("deleted");
  });

  it("never propagates ignored upward", () => {
    const lookup = buildDecorationIndex([file("a/b/out.log", "ignored"), dir("a/cache", "ignored")]);
    expect(lookup("a", true)).toBeNull();
    expect(lookup("a/b", true)).toBeNull();
    expect(lookup("a/b/out.log", false)).toEqual({ state: "ignored", inherited: false });
  });

  it("propagates an untracked directory upward to its parents", () => {
    const lookup = buildDecorationIndex([dir("a/new", "untracked")]);
    expect(lookup("a", true)).toEqual({ state: "untracked", inherited: true });
  });

  it("does not decorate files with aggregated descendant states", () => {
    const lookup = buildDecorationIndex([file("a/b.ts", "modified")]);
    expect(lookup("a", false)).toBeNull();
  });
});
