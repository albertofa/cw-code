import { describe, expect, it } from "bun:test";
import { attentionCountOf, attentionDescription, shouldFlash } from "./attention.js";

describe("shouldFlash", () => {
  it("flashes when the count increases while unfocused", () => {
    expect(shouldFlash(0, 1, false)).toBe(true);
    expect(shouldFlash(2, 5, false)).toBe(true);
  });

  it("never flashes on the first report after a load", () => {
    expect(shouldFlash(null, 3, false)).toBe(false);
    expect(shouldFlash(null, 0, false)).toBe(false);
  });

  it("does not flash when focused", () => {
    expect(shouldFlash(0, 1, true)).toBe(false);
  });

  it("does not flash when the count is unchanged or drops", () => {
    expect(shouldFlash(2, 2, false)).toBe(false);
    expect(shouldFlash(3, 1, false)).toBe(false);
    expect(shouldFlash(1, 0, false)).toBe(false);
  });
});

describe("attentionDescription", () => {
  it("is empty for zero", () => {
    expect(attentionDescription(0)).toBe("");
  });

  it("uses the singular for one", () => {
    expect(attentionDescription(1)).toBe("1 session needs you");
  });

  it("uses the plural above one", () => {
    expect(attentionDescription(2)).toBe("2 sessions need you");
    expect(attentionDescription(12)).toBe("12 sessions need you");
  });
});

describe("attentionCountOf", () => {
  it("reads the count from a ready app topic", () => {
    expect(attentionCountOf({ status: "ready", data: { attention: { count: 3 } } })).toBe(3);
    expect(attentionCountOf({ status: "ready", data: { attention: { count: 0 } } })).toBe(0);
  });

  it("is null until the topic is ready", () => {
    expect(attentionCountOf(undefined)).toBeNull();
    expect(attentionCountOf({ status: "subscribing", data: {} })).toBeNull();
    expect(attentionCountOf({ status: "error", data: { attention: { count: 2 } } })).toBeNull();
  });

  it("is null when the count is missing or invalid", () => {
    expect(attentionCountOf({ status: "ready", data: {} })).toBeNull();
    expect(attentionCountOf({ status: "ready", data: { attention: { count: -1 } } })).toBeNull();
    expect(attentionCountOf({ status: "ready", data: { attention: { count: 1.5 } } })).toBeNull();
    expect(attentionCountOf({ status: "ready", data: { attention: { count: Number.NaN } } })).toBeNull();
  });
});
