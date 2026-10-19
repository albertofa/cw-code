import { describe, expect, it } from "vitest";
import type { CustomTheme, ThemeBase } from "@cw-code/contracts";
import {
  CURATED_THEME_TOKENS,
  PROJECT_HUES,
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

function baseSeeds(base: ThemeBase): Record<string, string> {
  return Object.fromEntries(CURATED_THEME_TOKENS.map(({ token }) => [token, THEME_PALETTES[base][token]]));
}

function rgbOf(value: string): number[] | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(value);
  if (hex) {
    return hex.slice(1).map((channel) => Number.parseInt(channel, 16));
  }
  const rgba = /^rgba\((\d+), (\d+), (\d+), [\d.]+\)$/.exec(value);
  return rgba ? rgba.slice(1).map(Number) : null;
}

function brightness(hex: string): number {
  return (rgbOf(hex) ?? []).reduce((sum, channel) => sum + channel, 0);
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

describe("THEME_PALETTES", () => {
  it("has identical token keys in dark and light", () => {
    expect(Object.keys(THEME_PALETTES.light).sort()).toEqual(Object.keys(THEME_PALETTES.dark).sort());
  });
});

describe("deriveThemeTokens", () => {
  it("equals the base palette when no colors are set", () => {
    expect(deriveThemeTokens("dark", {})).toEqual(THEME_PALETTES.dark);
    expect(deriveThemeTokens("light", {})).toEqual(THEME_PALETTES.light);
  });

  it("equals the base palette when every seed is set to its base value", () => {
    expect(deriveThemeTokens("dark", baseSeeds("dark"))).toEqual(THEME_PALETTES.dark);
    expect(deriveThemeTokens("light", baseSeeds("light"))).toEqual(THEME_PALETTES.light);
  });

  it("derives the full token set for a custom dark theme", () => {
    expect(deriveThemeTokens("dark", { bg: "#1a1b26", violet: "#7c6af2" })).toEqual({
      ...THEME_PALETTES.dark,
      line: "#232732",
      editor: "#15151f",
      "panel-head": "#171722",
      bg: "#1a1b26",
      panel: "#1a1b26",
      tool: "#1d1e2a",
      "bg-deep": "#1a1c28",
      overlay: "#232535",
      "user-msg": "#272a3b",
      hover: "#22232f",
      raised: "#2b2d3b",
      "border-soft": "#272b39",
      faint: "#9194a0",
      codex: "#b6a5ff",
      "codex-soft": "rgba(182, 165, 255, 0.14)",
      violet: "#7c6af2",
      "violet-strong": "#6352db",
      "violet-ink": "#a394ff",
      "violet-soft": "rgba(124, 106, 242, 0.2)",
      "violet-line": "rgba(163, 148, 255, 0.45)",
      "merged-fill": "#7d77b4",
      "surface-inset": "rgba(3, 2, 5, 0.3)",
      merged: "#b6a5ff",
      "terminal-bg": "#232228",
      "terminal-fg": "#bdbec5",
      "terminal-selection": "#25488a",
      "control-ink": "#9da1a9",
      "control-bg": "#2b2c36",
      "control-bg-hover": "#35363d",
      "control-ring": "#60657c",
      "switch-track": "#2f3140",
      "switch-ring": "#4e5266",
      "menu-surface": "#282832",
      "tooltip-bg": "#303038",
      "modal-bar": "#2b2b33",
      "row-selected": "#2e2f36",
      "table-row-hover": "#26252d",
      "bar-row-hover": "#2b2b32",
      "tag-fill": "#2f2f36",
      "chart-grid": "#323239",
      "avatar-bot": "#3e3f49",
      "diff-add-bg": "#303e33",
      "diff-del-bg": "#412d32",
      "diff-hunk-bg": "#2f3645",
      scrim: "rgba(25, 24, 29, 0.92)"
    });
  });

  it("derives the full token set for a custom light theme", () => {
    expect(deriveThemeTokens("light", { bg: "#f4f4f0" })).toEqual({
      ...THEME_PALETTES.light,
      line: "#dbdee4",
      editor: "#fdfcf5",
      "panel-head": "#eff0ec",
      bg: "#f4f4f0",
      panel: "#f4f4f0",
      tool: "#edeeeb",
      "bg-deep": "#ecedea",
      overlay: "#fdfcf6",
      "user-msg": "#eae8f0",
      hover: "#eaebe9",
      raised: "#e5e5e5",
      "border-soft": "#e2e4e8",
      faint: "#6a6f7d",
      "surface-inset": "rgba(15, 18, 25, 0.04)",
      "terminal-bg": "#fdfdf5",
      "terminal-fg": "#1a1c24",
      "terminal-selection": "#d8d1f0",
      "control-ink": "#6b707f",
      "control-bg": "#ebebea",
      "control-bg-hover": "#e2e3e4",
      "control-ring": "#898d95",
      "switch-track": "#e1e3e3",
      "switch-ring": "#b7bbc3",
      "menu-surface": "#fdfcf6",
      "tooltip-bg": "#fdfdf6",
      "modal-bar": "#f0efed",
      "row-selected": "#e6e8e7",
      "table-row-hover": "#efefed",
      "bar-row-hover": "#ebebea",
      "tag-fill": "#e7e9e7",
      "chart-grid": "#e1e2e3",
      "avatar-bot": "#dadddf",
      "diff-add-bg": "#e1f1dd",
      "diff-del-bg": "#f9e3db",
      "diff-hunk-bg": "#e5eaf3",
      scrim: "rgba(244, 244, 240, 0.92)"
    });
  });

  it("moves every token by at most one step per channel after a one-step bg edit", () => {
    const edits: Record<ThemeBase, string> = { dark: "#161921", light: "#f5f6f9" };
    for (const base of ["dark", "light"] as const) {
      const palette = THEME_PALETTES[base];
      const tokens = deriveThemeTokens(base, { bg: edits[base] });
      for (const [token, value] of Object.entries(tokens)) {
        const before = rgbOf(palette[token]);
        const after = rgbOf(value);
        if (before === null || after === null) {
          expect(value, token).toBe(palette[token]);
          continue;
        }
        after.forEach((channel, index) => {
          expect(Math.abs(channel - before[index]), `${base} ${token}`).toBeLessThanOrEqual(1);
        });
      }
    }
  });

  it("keeps each palette's surface direction after a slight bg edit", () => {
    const light = deriveThemeTokens("light", { bg: "#f2f3f6" });
    for (const token of ["editor", "overlay", "menu-surface", "tooltip-bg", "terminal-bg", "composer-card"]) {
      expect(brightness(light[token]), token).toBeGreaterThan(brightness(light.bg));
    }
    const dark = deriveThemeTokens("dark", { bg: "#191c24" });
    expect(brightness(dark.editor)).toBeLessThan(brightness(dark.bg));
    expect(brightness(dark.raised)).toBeGreaterThan(brightness(dark.bg));
  });

  it("clamps shifted channels to the valid range", () => {
    expect(deriveThemeTokens("light", { bg: "#ffffff" }).editor).toBe("#ffffff");
    expect(deriveThemeTokens("dark", { text: "#ffffff" }).hair).toBe("rgba(255, 255, 255, 0.05)");
  });

  it("leaves tokens that do not read the edited seed untouched", () => {
    const tokens = deriveThemeTokens("dark", { bg: "#ffffff" });
    expect(tokens.bg).toBe("#ffffff");
    expect(tokens.panel).toBe("#ffffff");
    expect(tokens.hover).not.toBe(THEME_PALETTES.dark.hover);
    expect(tokens["violet-soft"]).toBe(THEME_PALETTES.dark["violet-soft"]);
    expect(tokens["violet-ink"]).toBe(THEME_PALETTES.dark["violet-ink"]);
    expect(tokens.text).toBe(THEME_PALETTES.dark.text);
  });

  it("propagates a violet edit to every token that reads violet, keeping base alphas", () => {
    const tokens = deriveThemeTokens("dark", { violet: "#ff0000" });
    expect(tokens["violet-soft"]).toBe("rgba(255, 0, 0, 0.2)");
    expect(tokens["user-msg"]).toBe("#2e1f22");
    expect(tokens.codex).toBe("#ff6066");
    expect(tokens["codex-soft"]).toBe("rgba(255, 96, 102, 0.14)");
  });

  it("derives composer-card from card, keeping the dark base alpha", () => {
    expect(deriveThemeTokens("dark", { card: "#20242f" })["composer-card"]).toBe("rgba(165, 174, 229, 0.06)");
    expect(deriveThemeTokens("light", { card: "#fafafa" })["composer-card"]).toBe("#fafafa");
  });

  it("propagates a text edit to the inks that read text", () => {
    const tokens = deriveThemeTokens("dark", { text: "#ffffff" });
    expect(tokens["violet-ink"]).toBe("#aa94ff");
    expect(tokens["accent-ink"]).toBe("#85acfd");
    expect(tokens.dim).toBe("#c8cbd3");
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
    expect(THEME_COLOR_TOKENS).toContain("on-accent");
    for (const token of THEME_COLOR_TOKENS) {
      expect(THEME_PALETTES.dark[token]).toMatch(/^#[0-9a-f]{6}$/);
      expect(THEME_PALETTES.light[token]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("excludes fixed non-theme colors", () => {
    for (const token of ["win-close", "preview-canvas", "on-avatar", ...PROJECT_HUES.map((hue) => `project-${hue}`)]) {
      expect(THEME_COLOR_TOKENS).not.toContain(token);
      expect(THEME_PALETTES.dark[token]).toBeDefined();
      expect(THEME_PALETTES.light[token]).toBeDefined();
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

  it("treats a custom theme with an invalid base as dark", () => {
    const theme = customTheme({ base: "sepia" as unknown as ThemeBase });
    expect(resolveActiveTheme(theme.id, [theme], true)).toEqual({ base: "dark", tokens: THEME_PALETTES.dark });
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
