import { describe, expect, it } from "vitest";
import type { CustomTheme } from "@cw-code/contracts";
import {
  THEME_COLOR_TOKENS,
  THEME_PALETTES,
  deriveThemeTokens,
  mixHex,
  resolveActiveTheme,
  windowBackgroundColor,
  withAlpha
} from "./themes.js";

function customTheme(overrides: Partial<CustomTheme> = {}): CustomTheme {
  return { id: "custom-sample", name: "Sample", base: "dark", colors: {}, ...overrides };
}

describe("mixHex", () => {
  it("interpolates sRGB channels and rounds half up", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#ff0000", "#0000ff", 0.25)).toBe("#4000bf");
  });

  it("returns the first color at full weight and the second at zero", () => {
    expect(mixHex("#795cec", "#101219", 1)).toBe("#795cec");
    expect(mixHex("#795cec", "#101219", 0)).toBe("#101219");
  });

  it("returns lowercase hex", () => {
    expect(mixHex("#ABCDEF", "#ABCDEF", 0.5)).toBe("#abcdef");
  });
});

describe("withAlpha", () => {
  it("formats an rgba string from a hex color", () => {
    expect(withAlpha("#795cec", 0.2)).toBe("rgba(121, 92, 236, 0.2)");
    expect(withAlpha("#ffffff", 0.045)).toBe("rgba(255, 255, 255, 0.045)");
  });
});

describe("deriveThemeTokens", () => {
  it("equals the base palette when no colors are set", () => {
    expect(deriveThemeTokens("dark", {})).toEqual(THEME_PALETTES.dark);
    expect(deriveThemeTokens("light", {})).toEqual(THEME_PALETTES.light);
  });

  it("recomputes only the tokens that depend on an overridden seed", () => {
    const tokens = deriveThemeTokens("dark", { bg: "#ffffff" });
    expect(tokens.bg).toBe("#ffffff");
    expect(tokens.panel).toBe("#ffffff");
    expect(tokens.hover).toBe("#fefefe");
    expect(tokens.hover).not.toBe(THEME_PALETTES.dark.hover);
    expect(tokens.raised).not.toBe(THEME_PALETTES.dark.raised);
    expect(tokens["terminal-bg"]).not.toBe(THEME_PALETTES.dark["terminal-bg"]);
    expect(tokens["violet-soft"]).toBe(THEME_PALETTES.dark["violet-soft"]);
    expect(tokens.text).toBe(THEME_PALETTES.dark.text);
  });

  it("derives alpha tokens from the overridden seed", () => {
    const tokens = deriveThemeTokens("dark", { violet: "#ff0000" });
    expect(tokens["violet-soft"]).toBe("rgba(255, 0, 0, 0.16)");
    expect(tokens["user-msg"]).toBe(THEME_PALETTES.dark["user-msg"]);
  });

  it("ignores unknown keys, non-hex values and non-string values", () => {
    const colors = {
      nope: "#123456",
      bg: "red",
      text: "#12345",
      card: "#1234567",
      border: 123 as unknown as string,
      violet: "#GGGGGG"
    };
    expect(deriveThemeTokens("light", colors)).toEqual(THEME_PALETTES.light);
  });

  it("normalizes override casing to lowercase", () => {
    expect(deriveThemeTokens("dark", { card: "#ABCDEF" }).card).toBe("#abcdef");
  });

  it("lets an Advanced override of a derived token win over derivation", () => {
    const tokens = deriveThemeTokens("dark", { bg: "#ffffff", hover: "#123456" });
    expect(tokens.hover).toBe("#123456");
    expect(tokens.raised).not.toBe(THEME_PALETTES.dark.raised);
  });

  it("keeps the base token key set", () => {
    const everySeed = {
      gutter: "#111111",
      bg: "#222222",
      card: "#333333",
      border: "#444444",
      text: "#eeeeee",
      muted: "#bbbbbb",
      violet: "#8855ff",
      accent: "#3388ff",
      success: "#33aa33",
      warning: "#ddaa33",
      danger: "#dd3333"
    };
    expect(Object.keys(deriveThemeTokens("light", everySeed))).toEqual(Object.keys(THEME_PALETTES.light));
  });
});

describe("THEME_COLOR_TOKENS", () => {
  it("lists only tokens that are #rrggbb in both palettes", () => {
    expect(THEME_COLOR_TOKENS).toContain("bg");
    expect(THEME_COLOR_TOKENS).toContain("terminal-bg");
    expect(THEME_COLOR_TOKENS).not.toContain("hair");
    expect(THEME_COLOR_TOKENS).not.toContain("shadow-float");
    for (const token of THEME_COLOR_TOKENS) {
      expect(THEME_PALETTES.dark[token]).toMatch(/^#[0-9a-f]{6}$/);
      expect(THEME_PALETTES.light[token]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("resolveActiveTheme", () => {
  it("resolves built-in dark and light without tokens", () => {
    expect(resolveActiveTheme("dark", [], true)).toEqual({ base: "dark", tokens: null });
    expect(resolveActiveTheme("light", [], false)).toEqual({ base: "light", tokens: null });
  });

  it("follows the system flag for system", () => {
    expect(resolveActiveTheme("system", [], true)).toEqual({ base: "light", tokens: null });
    expect(resolveActiveTheme("system", [], false)).toEqual({ base: "dark", tokens: null });
  });

  it("derives tokens for a known custom theme", () => {
    const theme = customTheme({ base: "light", colors: { bg: "#ffffff" } });
    const active = resolveActiveTheme(theme.id, [theme], false);
    expect(active.base).toBe("light");
    expect(active.tokens).toEqual(deriveThemeTokens("light", theme.colors));
  });

  it("falls back to dark for an unknown id", () => {
    expect(resolveActiveTheme("custom-missing", [customTheme()], true)).toEqual({ base: "dark", tokens: null });
    expect(resolveActiveTheme("garbage", [], true)).toEqual({ base: "dark", tokens: null });
  });
});

describe("windowBackgroundColor", () => {
  it("returns the palette gutter for built-in themes", () => {
    expect(windowBackgroundColor("dark", [], true)).toBe(THEME_PALETTES.dark.gutter);
    expect(windowBackgroundColor("light", [], false)).toBe(THEME_PALETTES.light.gutter);
    expect(windowBackgroundColor("system", [], true)).toBe(THEME_PALETTES.light.gutter);
    expect(windowBackgroundColor("system", [], false)).toBe(THEME_PALETTES.dark.gutter);
  });

  it("returns the custom gutter when set and the base gutter otherwise", () => {
    const tinted = customTheme({ id: "custom-tinted", colors: { gutter: "#102030" } });
    const plain = customTheme({ id: "custom-plain", base: "light" });
    expect(windowBackgroundColor(tinted.id, [tinted, plain], false)).toBe("#102030");
    expect(windowBackgroundColor(plain.id, [tinted, plain], false)).toBe(THEME_PALETTES.light.gutter);
  });
});
