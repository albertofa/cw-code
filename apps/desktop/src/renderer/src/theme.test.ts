// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { deriveThemeTokens } from "../../shared/themes.js";
import type { CustomTheme } from "./cw.js";
import { applyTheme, cacheTheme, THEME_STORAGE_KEY, THEME_VARS_ATTRIBUTE, type StoredTheme } from "./theme.js";

const OCEAN: CustomTheme = { id: "custom-ocean", name: "Ocean", base: "light", colors: { bg: "#e0f0ff", gutter: "#c0d8f0" } };

function storedTheme(): StoredTheme | null {
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as StoredTheme);
}

describe("applyTheme", () => {
  afterEach(() => window.localStorage.removeItem(THEME_STORAGE_KEY));

  it("marks the root with the custom theme's base and sets every derived token inline", () => {
    const root = document.createElement("html");
    expect(applyTheme(root, OCEAN.id, [OCEAN], false)).toBe("light");
    const tokens = deriveThemeTokens(OCEAN.base, OCEAN.colors);
    expect(root.dataset["theme"]).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.getPropertyValue("--bg")).toBe("#e0f0ff");
    for (const [name, value] of Object.entries(tokens)) expect(root.style.getPropertyValue(`--${name}`)).toBe(value);
    expect(root.style.backgroundColor).not.toBe("");
  });

  it("removes the custom tokens when switching back to dark and leaves font variables alone", () => {
    const root = document.createElement("html");
    root.style.setProperty("--font-sans", '"Inter", system-ui');
    applyTheme(root, OCEAN.id, [OCEAN], false);
    applyTheme(root, "dark", [OCEAN], false);
    expect(root.dataset["theme"]).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.getPropertyValue("--bg")).toBe("");
    expect(root.style.getPropertyValue("--gutter")).toBe("");
    expect(root.style.backgroundColor).toBe("");
    expect(root.hasAttribute(THEME_VARS_ATTRIBUTE)).toBe(false);
    expect(root.style.getPropertyValue("--font-sans")).toBe('"Inter", system-ui');
  });

  it("clears the tokens painted before settings loaded", () => {
    const root = document.createElement("html");
    root.style.setProperty("--bg", "#123456");
    root.style.setProperty("--sunken", "#654321");
    root.setAttribute(THEME_VARS_ATTRIBUTE, "bg sunken");
    applyTheme(root, "light", [], false);
    expect(root.style.getPropertyValue("--bg")).toBe("");
    expect(root.style.getPropertyValue("--sunken")).toBe("");
  });

  it("never writes the first-paint cache, so a preview cannot leak into the next launch", () => {
    applyTheme(document.createElement("html"), OCEAN.id, [OCEAN], false);
    applyTheme(document.createElement("html"), "system", [], true);
    expect(storedTheme()).toBeNull();
  });
});

describe("cacheTheme", () => {
  afterEach(() => window.localStorage.removeItem(THEME_STORAGE_KEY));

  it("caches the system choice, not the resolved base, for the next launch", () => {
    cacheTheme("system", []);
    expect(storedTheme()).toEqual({ mode: "system", vars: {} });
  });

  it("caches a built-in theme as its base without tokens", () => {
    cacheTheme("light", [OCEAN]);
    expect(storedTheme()).toEqual({ mode: "light", vars: {} });
  });

  it("caches a custom theme as its base with its tokens", () => {
    cacheTheme(OCEAN.id, [OCEAN]);
    expect(storedTheme()).toEqual({ mode: "light", vars: deriveThemeTokens(OCEAN.base, OCEAN.colors) });
  });
});
