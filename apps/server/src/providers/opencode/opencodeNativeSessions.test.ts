import { describe, expect, it } from "bun:test";
import { mapOpencodeNativeSessions, opencodeProjectWorktrees } from "./opencodeNativeSessions.js";

describe("mapOpencodeNativeSessions", () => {
  it("maps root sessions across projects", () => {
    const raw = [
      { id: "ses_1", directory: "C:\Projects\cw-code", title: "Review PR #55", time: { created: 10, updated: 20 }, project: { worktree: "C:\Projects\cw-code" } },
      { id: "ses_2", directory: "C:\Projects\api", title: "", time: { created: 5 } }
    ];
    expect(mapOpencodeNativeSessions(raw)).toEqual([
      { driver: "opencode", resumeCursor: "ses_1", title: "Review PR #55", cwd: "C:\Projects\cw-code", createdAt: 10, updatedAt: 20 },
      { driver: "opencode", resumeCursor: "ses_2", title: "ses_2", cwd: "C:\Projects\api", createdAt: 5, updatedAt: 5 }
    ]);
  });

  it("drops child, archived and malformed sessions", () => {
    const raw = [
      { id: "child", directory: "C:\a", parentID: "ses_1", time: { created: 1 } },
      { id: "archived", directory: "C:\a", time: { created: 1, archived: 2 } },
      { id: "", directory: "C:\a" },
      { id: "nodir" },
      null
    ];
    expect(mapOpencodeNativeSessions(raw)).toEqual([]);
    expect(mapOpencodeNativeSessions({ error: "nope" })).toEqual([]);
  });
});

describe("opencodeProjectWorktrees", () => {
  it("returns distinct project folders without the global project", () => {
    expect(
      opencodeProjectWorktrees([{ id: "global", worktree: "/" }, { worktree: "C:\a" }, { worktree: "C:\a" }, { worktree: "C:\b" }])
    ).toEqual(["C:\a", "C:\b"]);
  });
});
