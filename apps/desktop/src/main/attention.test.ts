import { describe, expect, it } from "vitest";
import { MAX_ATTENTION_COUNT, attentionDescription, parseAttentionState, resetsAttention, shouldFlash } from "./attention.js";

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

describe("parseAttentionState", () => {
  const png = "data:image/png;base64,AAAA";

  it("accepts a count with a png badge or null", () => {
    expect(parseAttentionState({ count: 3, badgeDataUrl: png })).toEqual({ count: 3, badgeDataUrl: png });
    expect(parseAttentionState({ count: 0, badgeDataUrl: null })).toEqual({ count: 0, badgeDataUrl: null });
  });

  it("forces a null badge when the count is zero", () => {
    expect(parseAttentionState({ count: 0, badgeDataUrl: png })).toEqual({ count: 0, badgeDataUrl: null });
  });

  it("caps the count", () => {
    expect(parseAttentionState({ count: MAX_ATTENTION_COUNT, badgeDataUrl: null })).toEqual({ count: MAX_ATTENTION_COUNT, badgeDataUrl: null });
    expect(parseAttentionState({ count: MAX_ATTENTION_COUNT + 1, badgeDataUrl: null })).toBeNull();
  });

  it("rejects invalid counts", () => {
    expect(parseAttentionState({ count: -1, badgeDataUrl: null })).toBeNull();
    expect(parseAttentionState({ count: 1.5, badgeDataUrl: null })).toBeNull();
    expect(parseAttentionState({ count: Number.NaN, badgeDataUrl: null })).toBeNull();
    expect(parseAttentionState({ count: Number.POSITIVE_INFINITY, badgeDataUrl: null })).toBeNull();
    expect(parseAttentionState({ count: "2", badgeDataUrl: null })).toBeNull();
  });

  it("rejects invalid badges", () => {
    expect(parseAttentionState({ count: 1, badgeDataUrl: "data:image/jpeg;base64,AAAA" })).toBeNull();
    expect(parseAttentionState({ count: 1, badgeDataUrl: "https://example.com/a.png" })).toBeNull();
    expect(parseAttentionState({ count: 1, badgeDataUrl: `${png}${"A".repeat(64 * 1024)}` })).toBeNull();
    expect(parseAttentionState({ count: 1 })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseAttentionState(null)).toBeNull();
    expect(parseAttentionState("x")).toBeNull();
  });
});

describe("resetsAttention", () => {
  it("resets only on a cross-document main-frame navigation", () => {
    expect(resetsAttention({ isMainFrame: true, isSameDocument: false })).toBe(true);
    expect(resetsAttention({ isMainFrame: false, isSameDocument: false })).toBe(false);
    expect(resetsAttention({ isMainFrame: true, isSameDocument: true })).toBe(false);
    expect(resetsAttention({ isMainFrame: false, isSameDocument: true })).toBe(false);
  });
});
