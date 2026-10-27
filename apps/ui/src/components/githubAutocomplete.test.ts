import { describe, expect, it } from "bun:test";
import { applyAutocomplete, autocomplete, type SuggestionSource } from "./githubAutocomplete.js";

const SOURCE: SuggestionSource = {
  viewer: "albertofa",
  people: ["lcosta", "albertofa", "dependabot[bot]", "mrodrigues"],
  repos: ["nuria-tech/nuria-hub", "albertofa/cw-code"],
  orgs: ["nuria-tech", "albertofa"],
  labels: ["perf", "bug"],
  milestones: ["v1"],
  workflows: ["CI", "Release"],
  branches: ["main", "feat/x"],
};

describe("autocomplete", () => {
  it("lists qualifier keys in key mode", () => {
    const result = autocomplete("pr", "", 0, SOURCE);
    expect(result.heading).toBe("Qualifiers");
    expect(result.items[0]).toMatchObject({ kind: "key", key: "is", label: "is:" });
    expect(result.items.find((i) => i.key === "has")).toMatchObject({ local: true });
  });

  it("filters keys by prefix and falls back to title search", () => {
    const keys = autocomplete("pr", "re", 2, SOURCE).items.map((i) => i.key);
    expect(keys).toEqual(["review-requested", "reviewed-by", "repo", "review"]);
    const none = autocomplete("pr", "zzz", 3, SOURCE);
    expect(none.items).toEqual([]);
    expect(none.empty).toContain("Searching titles");
    expect(none.invalid).toBe(false);
  });

  it("offers the exclude item first in repo value mode", () => {
    const result = autocomplete("pr", "repo:", 5, SOURCE);
    expect(result.heading).toBe("repo");
    expect(result.items[0]).toMatchObject({ kind: "exclude", key: "repo", label: "Exclude repo" });
    expect(result.items.slice(1).map((i) => i.value)).toEqual(["albertofa/cw-code", "nuria-tech/nuria-hub"]);
  });

  it("does not offer exclude once a partial value is typed or for negated keys", () => {
    expect(autocomplete("pr", "repo:nur", 8, SOURCE).items.map((i) => i.value)).toEqual(["nuria-tech/nuria-hub"]);
    expect(autocomplete("pr", "-repo:", 6, SOURCE).items.every((i) => i.kind === "value" && i.neg)).toBe(true);
  });

  it("lists @me first with the viewer avatar and maps bots to app/", () => {
    const result = autocomplete("pr", "author:", 7, SOURCE);
    expect(result.items[0]).toMatchObject({ value: "@me", avatarLogin: "albertofa" });
    const values = result.items.map((i) => i.value);
    expect(values).toEqual(["@me", "app/dependabot", "lcosta", "mrodrigues"]);
    expect(result.items.find((i) => i.value === "app/dependabot")).toMatchObject({ description: "app", avatarLogin: "dependabot[bot]" });
  });

  it("reports unknown keys as invalid", () => {
    const result = autocomplete("pr", "foo:b", 5, SOURCE);
    expect(result.invalid).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.empty).toContain("foo:");
  });

  it("reports no matching values", () => {
    const result = autocomplete("pr", "status:zzz", 10, SOURCE);
    expect(result.items).toEqual([]);
    expect(result.empty).toContain("zzz");
  });

  it("completes enum values with local flags and label colors", () => {
    expect(autocomplete("pr", "is:unr", 6, SOURCE).items).toMatchObject([{ value: "unread", local: true }]);
    const label = autocomplete("issue", "label:", 6, SOURCE).items.find((i) => i.value === "bug");
    expect(label?.labelColor).toMatch(/^hsl\(\d+,55%,58%\)$/);
  });

  it("autocompletes the standard search qualifiers", () => {
    expect(autocomplete("pr", "crea", 4, SOURCE).items).toMatchObject([{ key: "created", description: "Created date, e.g. >2026-01-01" }]);
    expect(autocomplete("pr", "in:", 3, SOURCE).items.map((i) => i.value)).toEqual(["title", "body", "comments"]);
    expect(autocomplete("pr", "is:lock", 7, SOURCE).items.map((i) => i.value)).toEqual(["locked"]);
    expect(autocomplete("issue", "hea", 3, SOURCE).items).toEqual([]);
    expect(autocomplete("pr", "hea", 3, SOURCE).items.map((i) => i.key)).toEqual(["head"]);
  });

  it("only offers @me for involves on runs", () => {
    expect(autocomplete("run", "involves:", 9, SOURCE).items.map((i) => i.value)).toEqual(["@me"]);
  });

  it("targets the token under the caret", () => {
    const result = autocomplete("pr", "is:pr aut foo", 9, SOURCE);
    expect([result.tokenStart, result.tokenEnd]).toEqual([6, 9]);
  });
});

describe("applyAutocomplete", () => {
  it("inserts a key and keeps the dropdown open", () => {
    const result = autocomplete("pr", "is:pr au", 8, SOURCE);
    const item = result.items[0];
    expect(applyAutocomplete("is:pr au", result, item, "pr")).toEqual({ query: "is:pr author:", caret: 13, reopen: true, switchKind: null });
  });

  it("turns exclude into a negated key and keeps the dropdown open", () => {
    const result = autocomplete("pr", "repo:", 5, SOURCE);
    expect(applyAutocomplete("repo:", result, result.items[0], "pr")).toEqual({ query: "-repo:", caret: 6, reopen: true, switchKind: null });
  });

  it("appends a space after a value unless one follows", () => {
    const result = autocomplete("pr", "author:l", 8, SOURCE);
    const item = result.items.find((i) => i.value === "lcosta");
    expect(item).toBeDefined();
    expect(applyAutocomplete("author:l", result, item!, "pr")).toEqual({ query: "author:lcosta ", caret: 14, reopen: false, switchKind: null });

    const mid = autocomplete("pr", "author:l foo", 8, SOURCE);
    expect(applyAutocomplete("author:l foo", mid, mid.items.find((i) => i.value === "lcosta")!, "pr").query).toBe("author:lcosta foo");
  });

  it("separates a key inserted right before another token", () => {
    const q = "is:pr foo";
    const result = autocomplete("pr", q, 6, SOURCE);
    expect([result.tokenStart, result.tokenEnd]).toEqual([6, 6]);
    const item = result.items.find((i) => i.key === "author")!;
    expect(applyAutocomplete(q, result, item, "pr")).toEqual({ query: "is:pr author: foo", caret: 13, reopen: true, switchKind: null });
  });

  it("replaces only the key when the caret is inside the key of a finished qualifier", () => {
    const q = "author:lcosta";
    const result = autocomplete("pr", q, 3, SOURCE);
    expect([result.tokenStart, result.tokenEnd]).toEqual([0, 7]);
    const item = result.items.find((i) => i.key === "author")!;
    expect(applyAutocomplete(q, result, item, "pr")).toEqual({ query: "author:lcosta", caret: 7, reopen: true, switchKind: null });
    const negated = autocomplete("pr", "-aut:x", 4, SOURCE);
    expect(applyAutocomplete("-aut:x", negated, negated.items[0], "pr").query).toBe("-author:x");
  });

  it("inserts close reasons with quotes", () => {
    const q = "reason:";
    const result = autocomplete("issue", q, 7, SOURCE);
    const item = result.items.find((i) => i.value === "not planned")!;
    expect(applyAutocomplete(q, result, item, "issue").query).toBe('reason:"not planned" ');
  });

  it("quotes values with spaces and keeps negation", () => {
    const result = autocomplete("pr", "-label:", 7, { ...SOURCE, labels: ["good first issue"] });
    expect(applyAutocomplete("-label:", result, result.items[0], "pr").query).toBe('-label:"good first issue" ');
  });

  it("requests a kind switch for is:issue and is:run but not for the current kind", () => {
    const result = autocomplete("pr", "is:", 3, SOURCE);
    const issueItem = result.items.find((i) => i.value === "issue")!;
    expect(applyAutocomplete("is:", result, issueItem, "pr")).toMatchObject({ query: "is:issue ", switchKind: "issue", reopen: false });
    const runItem = result.items.find((i) => i.value === "run")!;
    expect(applyAutocomplete("is:", result, runItem, "pr").switchKind).toBe("run");
    const prItem = result.items.find((i) => i.value === "pr")!;
    expect(applyAutocomplete("is:", result, prItem, "pr").switchKind).toBeNull();
    expect(applyAutocomplete("is:", result, prItem, "issue").switchKind).toBe("pr");
  });
});
