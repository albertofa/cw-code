import { describe, expect, it } from "bun:test";
import { isContentDrift } from "./threadFollow.js";

describe("isContentDrift", () => {
  it("treats content growing under a still or anchored viewport as drift", () => {
    expect(isContentDrift(0, 800)).toBe(true);
    expect(isContentDrift(120, 800)).toBe(true);
  });

  it("treats the offset clamping down while content shrinks as drift", () => {
    expect(isContentDrift(-600, -600)).toBe(true);
    expect(isContentDrift(-300, -2000)).toBe(true);
  });

  it("treats an upward move while content streams as the user scrolling away", () => {
    expect(isContentDrift(-40, 18)).toBe(false);
    expect(isContentDrift(-400, -100)).toBe(false);
  });

  it("is never drift when the content did not change", () => {
    expect(isContentDrift(0, 0)).toBe(false);
    expect(isContentDrift(-200, 0)).toBe(false);
  });
});
