import { describe, expect, it } from "vitest";
import { snapshotKey, snapshotTurnMatches, splitRepoPath, turnTotals } from "./turnChanges.js";

const snapshot = { turnId: "turn-1", sha: "a", capturedAt: 1_000, endSha: "b", endedAt: 5_000 };

describe("snapshotTurnMatches", () => {
  it("matches the live turn by id once it stops running", () => {
    expect(snapshotTurnMatches({ turnId: "turn-1", running: false }, snapshot)).toBe(true);
    expect(snapshotTurnMatches({ turnId: "turn-1", running: true }, snapshot)).toBe(false);
  });

  it("matches a history turn whose prompt falls inside the snapshot window", () => {
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 1_200 }, snapshot)).toBe(true);
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 900 }, snapshot)).toBe(false);
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 6_000 }, snapshot)).toBe(false);
  });

  it("does not match a history turn before the turn has ended or without a timestamp", () => {
    const running = { turnId: "turn-1", sha: "a", capturedAt: 1_000 };
    expect(snapshotTurnMatches({ turnId: "uuid", running: false, promptedAt: 1_200 }, running)).toBe(false);
    expect(snapshotTurnMatches({ turnId: "uuid", running: false }, snapshot)).toBe(false);
    expect(snapshotTurnMatches(undefined, snapshot)).toBe(false);
    expect(snapshotTurnMatches({ turnId: "turn-1", running: false }, undefined)).toBe(false);
  });
});

describe("snapshotKey", () => {
  it("changes when the end snapshot or undo arrives", () => {
    const start = snapshotKey({ turnId: "t", sha: "a", capturedAt: 1 });
    const ended = snapshotKey({ turnId: "t", sha: "a", capturedAt: 1, endSha: "b", endedAt: 2 });
    const undone = snapshotKey({ turnId: "t", sha: "a", capturedAt: 1, endSha: "b", endedAt: 2, undoneAt: 3 });
    expect(new Set([start, ended, undone]).size).toBe(3);
    expect(snapshotKey(undefined)).toBe("");
  });
});

describe("splitRepoPath and turnTotals", () => {
  it("splits dir and name and sums stats", () => {
    expect(splitRepoPath("src/a/b.ts")).toEqual({ dir: "src/a/", name: "b.ts" });
    expect(splitRepoPath("README.md")).toEqual({ dir: "", name: "README.md" });
    expect(
      turnTotals([
        { path: "a", change: "modified", added: 2, deleted: 1, binary: false },
        { path: "b", change: "added", added: 5, deleted: 0, binary: false }
      ])
    ).toEqual({ added: 7, deleted: 1 });
  });
});
