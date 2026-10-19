// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, isThemeMode, resolveTheme, storedThemeMode, THEME_STORAGE_KEY } from "./theme.js";

describe("resolveTheme", () => {
  it("returns an explicit choice regardless of the system", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("follows the system when asked to", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });
});

describe("isThemeMode", () => {
  it("accepts only the three modes", () => {
    expect(["dark", "light", "system"].every(isThemeMode)).toBe(true);
    expect(isThemeMode("sepia")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

describe("applyTheme", () => {
  afterEach(() => window.localStorage.removeItem(THEME_STORAGE_KEY));

  it("marks the root, sets the color scheme and remembers the mode for the next launch", () => {
    const root = document.createElement("html");
    expect(applyTheme(root, "light", false)).toBe("light");
    expect(root.dataset["theme"]).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(storedThemeMode()).toBe("light");
  });

  it("stores the chosen mode, not the resolved theme, so the system choice survives", () => {
    const root = document.createElement("html");
    expect(applyTheme(root, "system", true)).toBe("light");
    expect(storedThemeMode()).toBe("system");
  });

  it("falls back to dark when nothing valid is stored", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(storedThemeMode()).toBe("dark");
  });
});
