import { describe, expect, it } from "bun:test";
import type { Project, SessionMeta } from "@cw-code/contracts";
import { sameRootSessionIds, snapshotTurnMatches } from "./sameRoot.js";

const snapshot = { turnId: "turn-1", sha: "a", capturedAt: 10_700, endSha: "b", endedAt: 50_000 };

describe("snapshotTurnMatches", () => {
  it("matches the live turn by id once it stops running", () => {
    expect(snapshotTurnMatches({ turnId: "turn-1", running: false }, snapshot)).toBe(true);
    expect(snapshotTurnMatches({ turnId: "turn-1", running: true }, snapshot)).toBe(false);
  });

  it("matches a history turn whose prompt falls inside the snapshot window", () => {
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 12_000 }, snapshot)).toBe(true);
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 9_600 }, snapshot)).toBe(false);
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 60_000 }, snapshot)).toBe(false);
  });

  it("tolerates second-precision prompt timestamps just before the snapshot", () => {
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 10_000 }, snapshot)).toBe(true);
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 9_700 }, snapshot)).toBe(true);
  });

  it("does not match a history turn before the turn has ended or without a timestamp", () => {
    const running = { turnId: "turn-1", sha: "a", capturedAt: 1_000 };
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 1_200 }, running)).toBe(false);
    expect(snapshotTurnMatches({ turnId: "uuid", running: false }, snapshot)).toBe(false);
    expect(snapshotTurnMatches(undefined, snapshot)).toBe(false);
    expect(snapshotTurnMatches({ turnId: "turn-1", running: false }, undefined)).toBe(false);
  });
});

describe("sameRootSessionIds", () => {
  const session = (id: string, projectId: string, worktreePath?: string): SessionMeta => ({
    id,
    projectId,
    driver: "claude",
    title: id,
    status: "idle",
    resumeCursor: "",
    createdAt: 0,
    updatedAt: 0,
    ...(worktreePath ? { worktreePath } : {})
  });
  const projects: Project[] = [
    { id: "p1", rootPath: "C:\\Repo\\app", name: "app" },
    { id: "p2", rootPath: "c:/repo/app/", name: "same folder" },
    { id: "p3", rootPath: "C:\\Repo", name: "repo" }
  ];
  const sessionsByProject = {
    p1: [session("a", "p1"), session("wt", "p1", "C:\\wt\\one")],
    p2: [session("b", "p2")],
    p3: [session("c", "p3"), session("d", "p3", "C:/Repo/app")]
  };

  it("groups sessions whose worktree or project root is the same folder", () => {
    expect(sameRootSessionIds(sessionsByProject, projects, "a").sort()).toEqual(["a", "b", "d"]);
    expect(sameRootSessionIds(sessionsByProject, projects, "wt")).toEqual(["wt"]);
    expect(sameRootSessionIds(sessionsByProject, projects, "missing")).toEqual(["missing"]);
  });
});
