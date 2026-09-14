import { describe, expect, it } from "vitest";
import { findStaleWorktreeDirs, isWorktreeOrphaned, sameWorktreePath } from "./worktreeCleanup.js";
import type { SessionStatus } from "@cw-code/contracts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Row {
  id: string;
  status: SessionStatus;
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
      { id: "a", status: "idle", worktreePath: worktree },
      { id: "b", status: "idle", worktreePath: "C:/wt/proj/sess2" }
    ];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(true);
  });

  it("is not orphaned when another session references the same worktree", () => {
    const sessions: Row[] = [
      { id: "a", status: "idle", worktreePath: worktree },
      { id: "b", status: "idle", worktreePath: worktree }
    ];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(false);
  });

  it("ignores resolved and archived sessions when counting references", () => {
    const resolved: Row[] = [
      { id: "a", status: "idle", worktreePath: worktree },
      { id: "b", status: "resolved", worktreePath: worktree }
    ];
    expect(isWorktreeOrphaned(resolved, worktree, "a")).toBe(true);
    const archived: Row[] = [
      { id: "a", status: "idle", worktreePath: worktree },
      { id: "b", status: "archived", worktreePath: worktree }
    ];
    expect(isWorktreeOrphaned(archived, worktree, "a")).toBe(true);
  });

  it("ignores the session being resolved itself", () => {
    const sessions: Row[] = [{ id: "a", status: "idle", worktreePath: worktree }];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(true);
  });

  it("is not orphaned when the worktree path is empty", () => {
    expect(isWorktreeOrphaned([{ id: "a", status: "idle" }], "", "a")).toBe(false);
  });

  it("is not orphaned when another session references the worktree with different separators", () => {
    const base = mkdtempSync(join(tmpdir(), "cw-wtnorm-"));
    const worktree = join(base, "proj", "sess1");
    const variant = crossSeparatorVariant(worktree);
    if (variant === worktree) return;
    const sessions: Row[] = [
      { id: "a", status: "idle", worktreePath: worktree },
      { id: "b", status: "idle", worktreePath: variant }
    ];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(false);
  });

  it("ignores sessions without a worktree path", () => {
    const sessions: Row[] = [{ id: "b", status: "idle" }];
    expect(isWorktreeOrphaned(sessions, worktree, "a")).toBe(true);
  });
});

describe("findStaleWorktreeDirs", () => {
  it("keeps referenced dirs and returns unreferenced ones", () => {
    const sessions: Row[] = [{ id: "a", status: "idle", worktreePath: "C:/wt/proj/sess1" }];
    const stale = findStaleWorktreeDirs(sessions, [
      "C:/wt/proj/sess1",
      "C:/wt/proj/sess2",
      "C:/wt/proj/sess3"
    ]);
    expect(stale).toEqual(["C:/wt/proj/sess2", "C:/wt/proj/sess3"]);
  });

  it("treats dirs referenced only by resolved or archived sessions as stale", () => {
    const sessions: Row[] = [
      { id: "a", status: "resolved", worktreePath: "C:/wt/proj/sess1" },
      { id: "b", status: "archived", worktreePath: "C:/wt/proj/sess4" },
      { id: "c", status: "idle", worktreePath: "C:/wt/proj/sess2" }
    ];
    const stale = findStaleWorktreeDirs(sessions, [
      "C:/wt/proj/sess1",
      "C:/wt/proj/sess2",
      "C:/wt/proj/sess3",
      "C:/wt/proj/sess4"
    ]);
    expect(stale).toEqual(["C:/wt/proj/sess1", "C:/wt/proj/sess3", "C:/wt/proj/sess4"]);
  });

  it("returns everything when no session has a worktree", () => {
    expect(findStaleWorktreeDirs([{ id: "a", status: "idle" }], ["C:/wt/proj/sess1"])).toEqual(["C:/wt/proj/sess1"]);
  });
});
