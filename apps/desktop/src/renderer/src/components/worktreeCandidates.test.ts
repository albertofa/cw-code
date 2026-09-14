import { describe, expect, it } from "vitest";
import { worktreeCandidates } from "./worktreeCandidates.js";
import type { Session } from "../cw.js";

function session(overrides: Partial<Session>): Session {
  return {
    id: "s",
    projectId: "p",
    driver: "claude",
    title: "Session",
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

describe("worktreeCandidates", () => {
  it("lists sessions with worktrees, newest first, deduped by path", () => {
    const sessions = [
      session({ id: "old", worktreePath: "C:/wt/a", updatedAt: 1 }),
      session({ id: "new", worktreePath: "C:/wt/a", updatedAt: 5 }),
      session({ id: "other", worktreePath: "C:/wt/b", updatedAt: 3 }),
      session({ id: "plain" })
    ];
    expect(worktreeCandidates(sessions)).toEqual([
      { sessionId: "new", title: "Session", worktreePath: "C:/wt/a" },
      { sessionId: "other", title: "Session", branch: undefined, worktreePath: "C:/wt/b" }
    ]);
  });

  it("excludes archived sessions", () => {
    const sessions = [
      session({ id: "archived", worktreePath: "C:/wt/a", status: "archived", updatedAt: 9 }),
      session({ id: "resolved", worktreePath: "C:/wt/b", status: "resolved", updatedAt: 2 })
    ];
    expect(worktreeCandidates(sessions).map((c) => c.sessionId)).toEqual(["resolved"]);
  });

  it("returns nothing when no eligible session has a worktree", () => {
    expect(worktreeCandidates([session({}), session({ status: "archived", worktreePath: "C:/wt/a" })])).toEqual([]);
  });
});
