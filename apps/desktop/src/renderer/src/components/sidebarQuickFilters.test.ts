import { describe, expect, it } from "vitest";
import { matchesQuickFilter, quickFilterCounts, toggleQuickFilter, type QuickFilterFacts } from "./sidebarQuickFilters.js";

const facts = (patch: Partial<QuickFilterFacts> = {}): QuickFilterFacts => ({ status: "idle", linkCount: 0, unseen: false, ...patch });

describe("matchesQuickFilter", () => {
  it("lets everything through for all", () => {
    expect(matchesQuickFilter("all", facts())).toBe(true);
  });

  it("matches running and needs-input by status", () => {
    expect(matchesQuickFilter("running", facts({ status: "working" }))).toBe(true);
    expect(matchesQuickFilter("running", facts({ status: "input-required" }))).toBe(false);
    expect(matchesQuickFilter("input", facts({ status: "input-required" }))).toBe(true);
    expect(matchesQuickFilter("input", facts({ status: "done" }))).toBe(false);
  });

  it("matches PR-linked and updated sessions", () => {
    expect(matchesQuickFilter("pr", facts({ linkCount: 2 }))).toBe(true);
    expect(matchesQuickFilter("pr", facts())).toBe(false);
    expect(matchesQuickFilter("updated", facts({ linkCount: 1, unseen: true }))).toBe(true);
    expect(matchesQuickFilter("updated", facts({ linkCount: 1 }))).toBe(false);
  });
});

describe("quickFilterCounts", () => {
  it("counts each filter and skips archived sessions", () => {
    expect(
      quickFilterCounts([
        facts({ status: "working", linkCount: 1, unseen: true }),
        facts({ status: "input-required" }),
        facts({ linkCount: 1 }),
        facts({ status: "archived", linkCount: 1, unseen: true })
      ])
    ).toEqual({ running: 1, input: 1, pr: 2, updated: 1 });
  });
});

describe("toggleQuickFilter", () => {
  it("selects a filter and clears it when picked again", () => {
    expect(toggleQuickFilter("all", "pr")).toBe("pr");
    expect(toggleQuickFilter("pr", "pr")).toBe("all");
    expect(toggleQuickFilter("running", "pr")).toBe("pr");
  });
});
