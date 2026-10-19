import { describe, expect, it } from "vitest";
import { terminalTheme } from "./terminalTheme.js";

const COLORS = { background: "#101010", foreground: "#eeeeee", selection: "#334455" };

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
    expect(theme.cursor).toBe("#dfe1e5");
  });

  it("switches to the light ANSI colors for a light base", () => {
    const theme = terminalTheme("light", COLORS);
    expect(theme.red).toBe("#b42318");
    expect(theme.brightWhite).toBe("#3d3d3a");
    expect(theme.cursor).toBe("#1a1d26");
  });
});
