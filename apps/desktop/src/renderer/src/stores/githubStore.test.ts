// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { badgeSearchKeys, BUILTIN_VIEWS, evictionCandidates, searchKey } from "./githubStore.js";

describe("evictionCandidates", () => {
  const touched = new Map([
    ["a", 1],
    ["b", 2],
    ["c", 3],
    ["d", 4]
  ]);

  it("keeps everything while under the cap", () => {
    expect(evictionCandidates(["a", "b"], touched, new Set(), 2)).toEqual([]);
  });

  it("evicts the least recently touched keys first", () => {
    expect(evictionCandidates(["d", "b", "a", "c"], touched, new Set(), 2)).toEqual(["a", "b"]);
  });

  it("never evicts protected keys even when they are the oldest", () => {
    expect(evictionCandidates(["a", "b", "c", "d"], touched, new Set(["a", null]), 2)).toEqual(["b", "c"]);
  });

  it("treats untouched keys as oldest", () => {
    expect(evictionCandidates(["a", "z", "c"], touched, new Set(), 2)).toEqual(["z"]);
  });

  it("never evicts the badge keys alongside the current and settled keys", () => {
    const keys = ["a", "b", "c", "d", "e"];
    const protectedKeys = new Set<string | null>(["a", "b", "c", null]);
    expect(evictionCandidates(keys, new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]]), protectedKeys, 3)).toEqual(["d", "e"]);
  });
});

describe("badgeSearchKeys", () => {
  const cloned = [{ host: "github.com", owner: "acme", repo: "widgets" }];

  it("derives the issue inbox and run watching keys from the built-in views", () => {
    const issueQuery = BUILTIN_VIEWS.find((view) => view.id === "issue:inbox")?.query ?? "";
    const runQuery = BUILTIN_VIEWS.find((view) => view.id === "run:watching")?.query ?? "";

    expect(badgeSearchKeys(cloned)).toEqual({
      issue: searchKey("issue", issueQuery, []),
      run: searchKey("run", runQuery, cloned)
    });
  });

  it("changes the run key with the cloned repos but not the issue key", () => {
    expect(badgeSearchKeys([]).issue).toBe(badgeSearchKeys(cloned).issue);
    expect(badgeSearchKeys([]).run).not.toBe(badgeSearchKeys(cloned).run);
  });
});
