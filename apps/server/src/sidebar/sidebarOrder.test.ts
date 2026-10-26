import { describe, expect, it } from "bun:test";
import type { SessionMeta, SidebarOrderPrefs } from "@cw-code/contracts";
import { mergeAwayIds, reorderSidebar, sidebarSections } from "./sidebarOrder.js";

describe("mergeAwayIds", () => {
  it("reinserts away ids while applying the new order", () => {
    expect(mergeAwayIds(["B", "A", "C"], ["C", "B"], new Set(["A"]))).toEqual(["C", "B", "A"]);
  });

  it("preserves an away id mid-list when the order is unchanged", () => {
    expect(mergeAwayIds(["A", "W", "B"], ["A", "B"], new Set(["W"]))).toEqual(["A", "W", "B"]);
  });

  it("drops ids absent from both next and away", () => {
    expect(mergeAwayIds(["A", "X", "W", "B"], ["A", "B"], new Set(["W"]))).toEqual(["A", "W", "B"]);
  });

  it("appends next ids missing from prev", () => {
    expect(mergeAwayIds(["A", "B"], ["A", "B", "C"], new Set())).toEqual(["A", "B", "C"]);
  });
});

describe("reorderSidebar", () => {
  const sections = { main: ["a", "b", "c"], resolved: ["r1", "r2"] };

  it("moves within a section without touching pins or status", () => {
    const result = reorderSidebar(null, sections, new Set(), { sessionId: "a", from: "main", to: "main", targetId: "c", before: false });
    expect(result?.order).toEqual({ main: ["b", "c", "a"], resolved: ["r1", "r2"], pinned: [] });
    expect(result?.statusChange).toBeNull();
  });

  it("inserts before the target and appends when the target is missing", () => {
    const before = reorderSidebar(null, sections, new Set(), { sessionId: "c", from: "main", to: "main", targetId: "a", before: true });
    expect(before?.order.main).toEqual(["c", "a", "b"]);
    const appended = reorderSidebar(null, sections, new Set(), { sessionId: "a", from: "main", to: "main", targetId: null, before: true });
    expect(appended?.order.main).toEqual(["b", "c", "a"]);
  });

  it("pins and resolves a session moved from main to resolved", () => {
    const prev: SidebarOrderPrefs = { main: ["a", "b", "c"], resolved: ["r1", "r2"], pinned: ["old"] };
    const result = reorderSidebar(prev, sections, new Set(), { sessionId: "b", from: "main", to: "resolved", targetId: "r1", before: true });
    expect(result?.order).toEqual({ main: ["a", "c"], resolved: ["b", "r1", "r2"], pinned: ["old", "b"] });
    expect(result?.statusChange).toBe("resolved");
  });

  it("restores a session moved from resolved to main", () => {
    const result = reorderSidebar(null, sections, new Set(), { sessionId: "r2", from: "resolved", to: "main", targetId: "b", before: false });
    expect(result?.order).toEqual({ main: ["a", "b", "r2", "c"], resolved: ["r1"], pinned: ["r2"] });
    expect(result?.statusChange).toBe("idle");
  });

  it("keeps away ids where they were stored", () => {
    const prev: SidebarOrderPrefs = { main: ["a", "w", "b", "c"], resolved: ["r1", "r2"], pinned: [] };
    const result = reorderSidebar(prev, sections, new Set(["w"]), { sessionId: "a", from: "main", to: "main", targetId: "c", before: false });
    expect(result?.order.main).toEqual(["b", "c", "a", "w"]);
  });

  it("ignores an unknown session and a drop onto itself", () => {
    const prev: SidebarOrderPrefs = { main: ["a", "b", "c"], resolved: ["r1", "r2"], pinned: ["a"] };
    expect(reorderSidebar(prev, sections, new Set(), { sessionId: "x", from: "main", to: "main", targetId: null, before: true })).toBeNull();
    expect(reorderSidebar(prev, sections, new Set(), { sessionId: "a", from: "main", to: "main", targetId: "a", before: true })).toBeNull();
  });

  it("derives the source section from the server's sections, not the request", () => {
    const result = reorderSidebar(null, sections, new Set(), { sessionId: "b", from: "resolved", to: "resolved", targetId: "r1", before: true });
    expect(result?.statusChange).toBe("resolved");
    expect(result?.order.pinned).toEqual(["b"]);
  });
});

describe("sidebarSections", () => {
  const session = (id: string, status: SessionMeta["status"], updatedAt: number): SessionMeta => ({
    id,
    projectId: "p",
    driver: "claude",
    title: id,
    status,
    resumeCursor: "",
    createdAt: 0,
    updatedAt
  });
  const sessions = [
    session("old", "idle", 1),
    session("new", "idle", 5),
    session("res1", "resolved", 2),
    session("res2", "resolved", 3),
    session("gone", "archived", 9),
    session("busy", "working", 8)
  ];
  const ids = (list: SessionMeta[]) => list.map((s) => s.id);

  it("sorts by recency without a stored order and drops archived and away sessions", () => {
    const result = sidebarSections(sessions, null, new Set(["busy"]));
    expect(ids(result.main)).toEqual(["new", "old"]);
    expect(ids(result.resolved)).toEqual(["res2", "res1"]);
  });

  it("orders resolved by the stored order and puts unknown sessions last", () => {
    const result = sidebarSections(sessions, { main: [], resolved: ["res1"], pinned: [] }, new Set());
    expect(ids(result.resolved)).toEqual(["res1", "res2"]);
  });

  it("honors a pin in the stored section over the status", () => {
    const result = sidebarSections(sessions, { main: ["res1"], resolved: [], pinned: ["res1"] }, new Set());
    expect(ids(result.main)).toContain("res1");
    expect(ids(result.resolved)).toEqual(["res2"]);
  });
});
