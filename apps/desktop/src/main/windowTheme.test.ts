import { describe, expect, it } from "vitest";
import { DARK_WINDOW_BACKGROUND, LIGHT_WINDOW_BACKGROUND, windowBackgroundColor } from "./windowTheme.js";

describe("windowBackgroundColor", () => {
  it("uses the explicit theme regardless of the system", () => {
    expect(windowBackgroundColor("dark", false)).toBe(DARK_WINDOW_BACKGROUND);
    expect(windowBackgroundColor("light", true)).toBe(LIGHT_WINDOW_BACKGROUND);
  });

  it("follows the system when asked to", () => {
    expect(windowBackgroundColor("system", true)).toBe(DARK_WINDOW_BACKGROUND);
    expect(windowBackgroundColor("system", false)).toBe(LIGHT_WINDOW_BACKGROUND);
  });
});
