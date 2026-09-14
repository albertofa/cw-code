import { describe, expect, it } from "vitest";
import { findStaleWorktreeDirs, isWorktreeOrphaned, sameWorktreePath } from "./worktreeCleanup.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Row {
  id: string;
  worktreePath?: string;
}

function crossSeparatorVariant(path: string): string {
  return path.includes("\\") ? path.split("\\").join("/") : path;
}

describe("sameWorktreePath", () => {
  it("matches paths that differ only by trailing separators", () => {
    expect(sameWorktreePath("C:/wt/proj/sess1", "C:/wt/proj/sess1\\")).toBe(true);
  });
  it("matches paths that string-differ but resolve to the same location", () => {
    const base = mkdtempSync(join(tmpdir(), "cw-wtnorm-"));
    const worktree = join(base, "proj", "sess1");
    const variant = crossSeparatorVariant(worktree);
    if (variant === worktree) return;
    expect(sameWorktreePath(worktree, variant)).toBe(true);
  });
  it("matches unresolved relative segments against resolved paths", () => {
    const base = mkdtempSync(join(tmpdir(), "cw-wtnorm-"));
    expect(sameWorktreePath(join(base, "wt"), join(base, ".", "wt"))).toBe(true);
  });
  it("does not match different paths", () => {
    expect(sameWorktreePath("C:/wt/proj/sess1", "C:/wt/proj/sess2")).toBe(false);
  });
});

describe("isWorktreeOrphaned", () => {
  const worktree = "C:/wt/proj/sess1";

  it("is orphaned when no other session references the worktree", () => {
    const sessions: Row[] = [
      { id: "a", worktreePath: worktree },
      { id: "b", worktreePath: "C:/wt/proj/sess2" }
    ];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(true);
  });

  it("is not orphaned when another session references the same worktree", () => {
    const sessions: Row[] = [
      { id: "a", worktreePath: worktree },
      { id: "b", worktreePath: worktree }
    ];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(false);
  });

  it("ignores the session being resolved itself", () => {
    const sessions: Row[] = [{ id: "a", worktreePath: worktree }];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(true);
  });

  it("is not orphaned when the worktree path is empty", () => {
    expect(isWorktreeOrphaned([{ id: "a" }], "", "a")).toBe(false);
  });

  it("is not orphaned when another session references the worktree with different separators", () => {
    const base = mkdtempSync(join(tmpdir(), "cw-wtnorm-"));
    const worktree = join(base, "proj", "sess1");
    const variant = crossSeparatorVariant(worktree);
    if (variant === worktree) return;
    const sessions: Row[] = [
      { id: "a", worktreePath: worktree },
      { id: "b", worktreePath: variant }
    ];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(false);
  });

  it("ignores sessions without a worktree path", () => {
    const sessions: Row[] = [{ id: "b" }];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(true);
  });
});

describe("findStaleWorktreeDirs", () => {
  it("keeps referenced dirs and returns unreferenced ones", () => {
    const sessions: Row[] = [{ id: "a", worktreePath: "C:/wt/proj/sess1" }];
    const stale = findStaleWorktreeDirs(sessions, [
      "C:/wt/proj/sess1",
      "C:/wt/proj/sess2",
      "C:/wt/proj/sess3"
    ]);
    expect(stale).toEqual(["C:/wt/proj/sess2", "C:/wt/proj/sess3"]);
  });

  it("returns everything when no session has a worktree", () => {
    expect(findStaleWorktreeDirs([{}], ["C:/wt/proj/sess1"])).toEqual(["C:/wt/proj/sess1"]);
  });
});
