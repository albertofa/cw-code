import { describe, expect, it } from "vitest";
import { mergeAwayIds } from "./sidebarOrder.js";

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
