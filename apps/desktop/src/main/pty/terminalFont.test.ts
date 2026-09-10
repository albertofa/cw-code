import { describe, expect, it } from "vitest";
import { extractTerminalFontFace } from "./terminalFont.js";

describe("extractTerminalFontFace", () => {
  it("prefers profiles.defaults font face", () => {
    expect(
      extractTerminalFontFace({
        profiles: {
          defaults: { font: { face: "CaskaydiaCove Nerd Font" } },
          list: [{ name: "PowerShell", font: { face: "Consolas" } }]
        }
      })
    ).toBe("CaskaydiaCove Nerd Font");
  });

  it("falls back to the defaultProfile entry", () => {
    expect(
      extractTerminalFontFace({
        profiles: {
          defaultProfile: "{guid-2}",
          list: [
            { guid: "{guid-1}", name: "cmd", font: { face: "Consolas" } },
            { guid: "{guid-2}", name: "pwsh", font: { face: "JetBrainsMono Nerd Font" } }
          ]
        }
      })
    ).toBe("JetBrainsMono Nerd Font");
  });

  it("falls back to the first profile with a face", () => {
    expect(
      extractTerminalFontFace({
        profiles: { list: [{ name: "cmd" }, { name: "pwsh", font: { face: "FiraCode Nerd Font" } }] }
      })
    ).toBe("FiraCode Nerd Font");
  });

  it("returns null for missing or malformed settings", () => {
    expect(extractTerminalFontFace(null)).toBe(null);
    expect(extractTerminalFontFace({})).toBe(null);
    expect(extractTerminalFontFace({ profiles: { list: [{ name: "cmd" }] } })).toBe(null);
    expect(extractTerminalFontFace({ profiles: { defaults: { font: { face: "  " } } } })).toBe(null);
  });
});
