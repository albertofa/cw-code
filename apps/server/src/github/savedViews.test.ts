import { describe, expect, it } from "bun:test";
import type { SavedGitHubView } from "@cw-code/contracts";
import { MAX_QUERY_LENGTH, MAX_SAVED_VIEWS, MAX_VIEW_NAME_LENGTH } from "@cw-code/shared/githubViews";
import { addSavedView, deleteSavedView, renameSavedView } from "./savedViews.js";

const VIEW: SavedGitHubView = { id: "v1", kind: "pr", name: "Mine", query: "is:pr author:@me", group: "none" };

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "pr", name: "Review", query: "is:pr   review-requested:@me ", group: "triage", ...overrides };
}

describe("saved GitHub views", () => {
  it("adds a view with a trimmed name and a normalized query", () => {
    const { views, view } = addSavedView([VIEW], input({ name: "  Review  " }), "v2");
    expect(view).toEqual({ id: "v2", kind: "pr", name: "Review", query: "is:pr review-requested:@me", group: "triage" });
    expect(views).toEqual([VIEW, view]);
  });

  it("rejects invalid names, queries, kinds, groups and a full list", () => {
    const fails = (views: SavedGitHubView[], overrides: Record<string, unknown>) => () => addSavedView(views, input(overrides), "id");
    expect(fails([], { name: "   " })).toThrow("View name cannot be empty");
    expect(fails([], { name: "x".repeat(MAX_VIEW_NAME_LENGTH + 1) })).toThrow(`View name is limited to ${MAX_VIEW_NAME_LENGTH} characters`);
    expect(fails([], { query: "  " })).toThrow("Query cannot be empty");
    expect(fails([], { query: `is:pr ${"a".repeat(MAX_QUERY_LENGTH)}` })).toThrow(`Query is limited to ${MAX_QUERY_LENGTH} characters`);
    expect(fails([], { kind: "commit" })).toThrow("kind must be pr, issue or run");
    expect(fails([], { group: "author" })).toThrow("group must be triage, repo or none");
    const full = Array.from({ length: MAX_SAVED_VIEWS }, (_, index) => ({ ...VIEW, id: `v${index}` }));
    expect(fails(full, {})).toThrow(`At most ${MAX_SAVED_VIEWS} saved views are allowed`);
  });

  it("renames and deletes only known views", () => {
    expect(renameSavedView([VIEW], "v1", " Renamed ")).toEqual([{ ...VIEW, name: "Renamed" }]);
    expect(() => renameSavedView([VIEW], "missing", "Name")).toThrow("View not found");
    expect(() => renameSavedView([VIEW], "v1", "")).toThrow("View name cannot be empty");
    expect(deleteSavedView([VIEW, { ...VIEW, id: "v2" }], "v1").map((view) => view.id)).toEqual(["v2"]);
    expect(() => deleteSavedView([VIEW], 7)).toThrow("View not found");
  });
});
