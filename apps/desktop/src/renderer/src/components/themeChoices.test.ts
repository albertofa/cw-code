import { describe, expect, it } from "vitest";
import { BUNDLED_THEMES } from "../../../shared/themes.js";
import type { CustomTheme } from "../cw.js";
import { activeThemeName, newCustomTheme, tokenLabel, withoutColor } from "./themeChoices.js";

const UUID = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";

const ocean: CustomTheme = { id: "custom-ocean", name: "  Ocean  ", base: "light", colors: { bg: "#e0f0ff", violet: "#2255aa" } };

describe("tokenLabel", () => {
  it("expands abbreviations and capitalizes the first word", () => {
    expect(tokenLabel("panel-head")).toBe("Panel head");
    expect(tokenLabel("diff-add-bg")).toBe("Diff add background");
    expect(tokenLabel("user-msg")).toBe("User message");
    expect(tokenLabel("terminal-fg")).toBe("Terminal foreground");
    expect(tokenLabel("md-link")).toBe("Markdown link");
  });
});

describe("activeThemeName", () => {
  it("names built-ins by their resolved base and custom themes by their trimmed name", () => {
    expect(activeThemeName("dark", [], true)).toBe("Dark");
    expect(activeThemeName("system", [], true)).toBe("Light");
    expect(activeThemeName("system", [], false)).toBe("Dark");
    expect(activeThemeName("custom-ocean", [ocean], false)).toBe("Ocean");
    expect(activeThemeName("custom-ocean", [{ ...ocean, name: " " }], false)).toBe("Untitled theme");
  });

  it("names a bundled theme by its own name", () => {
    expect(activeThemeName("claude", [], false)).toBe("Claude");
  });
});

describe("newCustomTheme", () => {
  it("copies a built-in theme with no color overrides", () => {
    expect(newCustomTheme("system", [], true, UUID)).toEqual({
      id: "custom-3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      name: "Light copy",
      base: "light",
      colors: {}
    });
  });

  it("copies the active custom theme's base and colors without sharing the object", () => {
    const copy = newCustomTheme("custom-ocean", [ocean], false, UUID);
    expect(copy.id).toMatch(/^custom-[a-z0-9-]{1,64}$/);
    expect(copy.name).toBe("Ocean copy");
    expect(copy.base).toBe("light");
    expect(copy.colors).toEqual(ocean.colors);
    expect(copy.colors).not.toBe(ocean.colors);
  });

  it("copies the bundled Claude theme into an editable light theme without sharing the colors", () => {
    const claude = BUNDLED_THEMES.find((theme) => theme.id === "claude");
    const copy = newCustomTheme("claude", [], false, UUID);
    expect(copy).toEqual({
      id: "custom-3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      name: "Claude copy",
      base: "light",
      colors: claude?.colors
    });
    expect(copy.colors).not.toBe(claude?.colors);
  });

  it("keeps the copy name within the name limit", () => {
    const long = { ...ocean, name: "x".repeat(60) };
    expect(newCustomTheme(long.id, [long], false, UUID).name).toBe(`${"x".repeat(55)} copy`);
  });
});

describe("withoutColor", () => {
  it("drops only the given token", () => {
    expect(withoutColor({ bg: "#000000", text: "#ffffff" }, "bg")).toEqual({ text: "#ffffff" });
  });
});
