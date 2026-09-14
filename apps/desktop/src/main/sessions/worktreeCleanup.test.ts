import { describe, expect, it } from "vitest";
import { findStaleWorktreeDirs, isWorktreeOrphaned, sameWorktreePath } from "./worktreeCleanup.js";

interface Row {
  id: string;
  worktreePath?: string;
}

describe("sameWorktreePath", () => {
  it("matches paths that differ only by trailing separators", () => {
    expect(sameWorktreePath("C:/wt/proj/sess1", "C:/wt/proj/sess1\\")).toBe(true);
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
