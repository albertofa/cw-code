// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clampWidth, loadWidth } from "./useResizableWidth.js";

describe("resizable width", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("clamps and rounds", () => {
    expect(clampWidth(100, 220, 480)).toBe(220);
    expect(clampWidth(999, 220, 480)).toBe(480);
    expect(clampWidth(300.6, 220, 480)).toBe(301);
  });

  it("returns null when nothing valid is stored", () => {
    expect(loadWidth("w", 220, 480)).toBeNull();
    window.localStorage.setItem("w", "wide");
    expect(loadWidth("w", 220, 480)).toBeNull();
  });

  it("loads a stored width within bounds", () => {
    window.localStorage.setItem("w", "360");
    expect(loadWidth("w", 220, 480)).toBe(360);
    window.localStorage.setItem("w", "9000");
    expect(loadWidth("w", 220, 480)).toBe(480);
  });
});
