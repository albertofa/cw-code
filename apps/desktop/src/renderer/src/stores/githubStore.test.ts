// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { evictionCandidates } from "./githubStore.js";

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
});
