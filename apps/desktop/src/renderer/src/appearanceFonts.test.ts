import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  DEFAULT_MONO_PRIMARY,
  DEFAULT_MONO_REST,
  DEFAULT_MONO_STACK,
  TERMINAL_GLYPH_FALLBACK,
  cssFontFamilies,
  resolveTerminalFont,
  type AppearancePrefs
} from "./appearanceFonts.js";

const GLYPH_TAIL = `${TERMINAL_GLYPH_FALLBACK}, ${DEFAULT_MONO_STACK}`;
const DEFAULT_TERMINAL_STACK = `${DEFAULT_MONO_PRIMARY}, ${TERMINAL_GLYPH_FALLBACK}, ${DEFAULT_MONO_REST}`;

function prefs(overrides: Partial<AppearancePrefs>): AppearancePrefs {
  return { ...DEFAULT_APPEARANCE, ...overrides };
}

describe("cssFontFamilies", () => {
  it("quotes every family in a comma list", () => {
    expect(cssFontFamilies("Cascadia Code, Fira Code")).toBe('"Cascadia Code", "Fira Code"');
  });

  it("trims whitespace and unwraps existing quotes", () => {
    expect(cssFontFamilies('  "Segoe UI Variable Text" ,  \'Fira Code\'  ')).toBe('"Segoe UI Variable Text", "Fira Code"');
  });

  it("drops empty entries", () => {
    expect(cssFontFamilies("Consolas,, ,")).toBe('"Consolas"');
  });

  it("returns null for empty or blank input", () => {
    expect(cssFontFamilies("")).toBeNull();
    expect(cssFontFamilies("   ")).toBeNull();
    expect(cssFontFamilies(" , ")).toBeNull();
  });

  it("leaves generic families unquoted", () => {
    expect(cssFontFamilies("Consolas, monospace")).toBe('"Consolas", monospace');
  });

  it("escapes quotes and backslashes inside a name", () => {
    expect(cssFontFamilies('Bad\\Name')).toBe('"Bad\\\\Name"');
  });
});

describe("resolveTerminalFont", () => {
  it("follows the default monospace stack and code size in simple mode", () => {
    expect(resolveTerminalFont(prefs({}))).toEqual({ family: DEFAULT_TERMINAL_STACK, size: 14 });
  });

  it("puts the primary mono family before the glyph fallback so text matches the code font", () => {
    const { family } = resolveTerminalFont(prefs({}));
    expect(family.startsWith('"JetBrains Mono Variable", "JetBrains Mono", ')).toBe(true);
    expect(family.indexOf("Nerd Font")).toBeGreaterThan(family.indexOf('"JetBrains Mono"'));
    expect(family.indexOf("Nerd Font")).toBeLessThan(family.indexOf('"Cascadia Code"'));
  });

  it("uses the default terminal stack when the chosen family is blank", () => {
    expect(resolveTerminalFont(prefs({ fontFamilyMono: "  " })).family).toBe(DEFAULT_TERMINAL_STACK);
  });

  it("follows the monospace family and code size in simple mode, ignoring terminal values", () => {
    const resolved = resolveTerminalFont(
      prefs({ fontFamilyMono: "Fira Code", fontFamilyTerminal: "Consolas", fontSizeCode: 12, fontSizeTerminal: 18 })
    );
    expect(resolved).toEqual({ family: `"Fira Code", ${GLYPH_TAIL}`, size: 12 });
  });

  it("uses the terminal family and size in advanced mode", () => {
    const resolved = resolveTerminalFont(
      prefs({ typographyAdvanced: true, fontFamilyMono: "Fira Code", fontFamilyTerminal: "Consolas", fontSizeCode: 12, fontSizeTerminal: 18 })
    );
    expect(resolved).toEqual({ family: `"Consolas", ${GLYPH_TAIL}`, size: 18 });
  });

  it("falls back to the monospace family in advanced mode when no terminal family is set", () => {
    const resolved = resolveTerminalFont(
      prefs({ typographyAdvanced: true, fontFamilyMono: "Fira Code", fontFamilyTerminal: "", fontSizeTerminal: 9 })
    );
    expect(resolved).toEqual({ family: `"Fira Code", ${GLYPH_TAIL}`, size: 9 });
  });
});
