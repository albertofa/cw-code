import { describe, expect, it } from "vitest";
import { THEME_PALETTES } from "../../../shared/themes.js";
import type { ThemeBase } from "../cw.js";
import { terminalTheme } from "./terminalTheme.js";

const COLORS = { background: "#101010", foreground: "#eeeeee", selection: "#334455" };

function baseColors(base: ThemeBase) {
  const palette = THEME_PALETTES[base];
  return { background: palette["terminal-bg"] ?? "", foreground: palette["terminal-fg"] ?? "", selection: palette["terminal-selection"] ?? "" };
}

describe("terminalTheme", () => {
  it("takes background, foreground and selection from the theme tokens", () => {
    const theme = terminalTheme("dark", COLORS);
    expect(theme.background).toBe("#101010");
    expect(theme.foreground).toBe("#eeeeee");
    expect(theme.cursorAccent).toBe("#101010");
    expect(theme.selectionBackground).toBe("#334455");
  });

  it("keeps the dark ANSI colors for a dark base", () => {
    const theme = terminalTheme("dark", COLORS);
    expect(theme.red).toBe("#e06c60");
    expect(theme.brightBlack).toBe("#85888e");
  });

  it("switches to the light ANSI colors for a light base", () => {
    const theme = terminalTheme("light", COLORS);
    expect(theme.red).toBe("#b42318");
    expect(theme.brightWhite).toBe("#3d3d3a");
  });

  it("keeps the built-in cursor colors for the built-in palettes", () => {
    expect(terminalTheme("dark", baseColors("dark")).cursor).toBe("#dfe1e5");
    expect(terminalTheme("light", baseColors("light")).cursor).toBe("#1a1d26");
  });

  it("makes the cursor follow the foreground once the terminal colors differ from the base", () => {
    expect(terminalTheme("dark", { ...baseColors("dark"), background: "#fafafa", foreground: "#202020" }).cursor).toBe("#202020");
    expect(terminalTheme("dark", { ...baseColors("dark"), background: "#fafafa" }).cursor).toBe("#bcbec4");
    expect(terminalTheme("light", COLORS).cursor).toBe("#eeeeee");
  });
});
