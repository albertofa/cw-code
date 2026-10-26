import { describe, expect, it } from "bun:test";
import type { SavedGitHubView } from "@cw-code/contracts";
import { BUILTIN_VIEWS, ORG_PLACEHOLDER, SAVED_VIEW_ICON, resolveViews } from "./githubViews.js";

describe("resolveViews", () => {
  const saved: SavedGitHubView[] = [
    { id: "s1", kind: "pr", name: "Mine", query: "is:pr author:@me", group: "none" },
    { id: "s2", kind: "issue", name: "Bugs", query: "is:issue label:bug", group: "none" },
  ];

  it("hides org views until an org is known", () => {
    expect(resolveViews("pr", null, []).some((view) => view.query.includes(ORG_PLACEHOLDER))).toBe(false);
  });

  it("fills the org placeholder in name and query", () => {
    const org = resolveViews("pr", "acme", []).find((view) => view.id === "pr:org");
    expect(org).toMatchObject({ name: "acme · all open", query: "is:pr org:acme state:open", saved: false });
  });

  it("appends the saved views of the kind with the saved icon", () => {
    const views = resolveViews("pr", "acme", saved);
    expect(views.at(-1)).toMatchObject({ id: "s1", icon: SAVED_VIEW_ICON, saved: true });
    expect(views.some((view) => view.id === "s2")).toBe(false);
  });

  it("only returns built-in views of the requested kind", () => {
    expect(resolveViews("run", "acme", []).every((view) => view.kind === "run")).toBe(true);
    expect(BUILTIN_VIEWS.filter((view) => view.kind === "run").length).toBeGreaterThan(0);
  });
});
