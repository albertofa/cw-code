import { describe, expect, it } from "vitest";
import { compareWorkingSet, expiredHoldingIds, isWorkingSetStatus } from "./workingSet.js";
import type { Session, SessionStatus } from "../cw.js";

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

describe("isWorkingSetStatus", () => {
  it("accepts working set statuses", () => {
    for (const status of ["working", "input-required", "done", "holding"] as SessionStatus[]) {
      expect(isWorkingSetStatus(status)).toBe(true);
    }
  });

  it("rejects other statuses", () => {
    for (const status of ["idle", "resolved", "archived"] as SessionStatus[]) {
      expect(isWorkingSetStatus(status)).toBe(false);
    }
  });
});

describe("compareWorkingSet", () => {
  it("orders by rank regardless of recency", () => {
    const sessions = [
      session({ id: "holding", status: "holding", updatedAt: 100 }),
      session({ id: "done", status: "done", updatedAt: 100 }),
      session({ id: "working", status: "working", updatedAt: 100 }),
      session({ id: "input-required", status: "input-required", updatedAt: 100 })
    ];
    expect(sessions.sort(compareWorkingSet).map((s) => s.id)).toEqual([
      "input-required",
      "working",
      "done",
      "holding"
    ]);
  });

  it("breaks rank ties by newest updatedAt first", () => {
    const sessions = [
      session({ id: "old", status: "working", updatedAt: 1 }),
      session({ id: "new", status: "working", updatedAt: 5 }),
      session({ id: "mid", status: "working", updatedAt: 3 })
    ];
    expect(sessions.sort(compareWorkingSet).map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("expiredHoldingIds", () => {
  const HOUR = 3_600_000;
  const now = 10 * HOUR;

  it("returns only holding sessions past the cutoff", () => {
    const sessions = [
      session({ id: "fresh", status: "holding", updatedAt: now - HOUR }),
      session({ id: "stale", status: "holding", updatedAt: now - 7 * HOUR }),
      session({ id: "done-stale", status: "done", updatedAt: now - 7 * HOUR }),
      session({ id: "idle-stale", status: "idle", updatedAt: now - 7 * HOUR })
    ];
    expect(expiredHoldingIds(sessions, 6, now)).toEqual(["stale"]);
  });

  it("treats the cutoff as inclusive", () => {
    const sessions = [
      session({ id: "just-under", status: "holding", updatedAt: now - 6 * HOUR + 1 }),
      session({ id: "at-cutoff", status: "holding", updatedAt: now - 6 * HOUR }),
      session({ id: "over", status: "holding", updatedAt: now - 6 * HOUR - 1 })
    ];
    expect(expiredHoldingIds(sessions, 6, now)).toEqual(["at-cutoff", "over"]);
  });

  it("returns nothing when holding is disabled", () => {
    const sessions = [session({ id: "stale", status: "holding", updatedAt: 0 })];
    expect(expiredHoldingIds(sessions, 0, now)).toEqual([]);
  });
});
