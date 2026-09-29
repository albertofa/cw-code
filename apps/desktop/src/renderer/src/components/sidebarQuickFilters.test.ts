import { describe, expect, it } from "vitest";
import { matchesQuickFilter, matchesSessionQuery, quickFilterCounts, toggleQuickFilter, type QuickFilterFacts } from "./sidebarQuickFilters.js";

const facts = (patch: Partial<QuickFilterFacts> = {}): QuickFilterFacts => ({ status: "idle", linkCount: 0, prUpdated: false, ...patch });

describe("matchesQuickFilter", () => {
  it("lets everything through for all", () => {
    expect(matchesQuickFilter("all", facts())).toBe(true);
  });

  it("matches running by status", () => {
    expect(matchesQuickFilter("running", facts({ status: "working" }))).toBe(true);
    expect(matchesQuickFilter("running", facts({ status: "input-required" }))).toBe(false);
    expect(matchesQuickFilter("running", facts({ status: "done" }))).toBe(false);
  });

  it("matches PR-linked and updated sessions", () => {
    expect(matchesQuickFilter("pr", facts({ linkCount: 2 }))).toBe(true);
    expect(matchesQuickFilter("pr", facts())).toBe(false);
    expect(matchesQuickFilter("updated", facts({ linkCount: 1, prUpdated: true }))).toBe(true);
    expect(matchesQuickFilter("updated", facts({ linkCount: 1 }))).toBe(false);
  });
});

describe("quickFilterCounts", () => {
  it("counts each filter and skips resolved and archived sessions", () => {
    expect(
      quickFilterCounts([
        facts({ status: "working", linkCount: 1, prUpdated: true }),
        facts({ status: "input-required" }),
        facts({ linkCount: 1 }),
        facts({ status: "resolved", linkCount: 1, prUpdated: true }),
        facts({ status: "archived", linkCount: 1, prUpdated: true })
      ])
    ).toEqual({ running: 1, pr: 2, updated: 1 });
  });
});

describe("toggleQuickFilter", () => {
  it("selects a filter and clears it when picked again", () => {
    expect(toggleQuickFilter("all", "pr")).toBe("pr");
    expect(toggleQuickFilter("pr", "pr")).toBe("all");
    expect(toggleQuickFilter("running", "pr")).toBe("pr");
  });
});

describe("matchesSessionQuery", () => {
  const fields = { title: "Retry slot sync", project: "scheduler-api", branch: "cw/slot-retry" };

  it("matches everything for an empty query", () => {
    expect(matchesSessionQuery("", fields)).toBe(true);
    expect(matchesSessionQuery("   ", fields)).toBe(true);
  });

  it("matches title, project and branch case-insensitively", () => {
    expect(matchesSessionQuery("RETRY", fields)).toBe(true);
    expect(matchesSessionQuery("Scheduler", fields)).toBe(true);
    expect(matchesSessionQuery("cw/slot", fields)).toBe(true);
  });

  it("rejects a query found in none of the fields", () => {
    expect(matchesSessionQuery("paginate", fields)).toBe(false);
    expect(matchesSessionQuery("main", { ...fields, branch: undefined })).toBe(false);
  });
});
