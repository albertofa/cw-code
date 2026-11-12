import { describe, expect, it } from "bun:test";
import { PASTE_COLLAPSE_CHARS, PASTE_COLLAPSE_LINES, insertPaste, pasteSizeLabel, shouldCollapsePaste, withPastes } from "./pastedText.js";

describe("shouldCollapsePaste", () => {
  it("keeps short pastes inline", () => {
    expect(shouldCollapsePaste("hello")).toBe(false);
    expect(shouldCollapsePaste("   \n  ")).toBe(false);
    expect(shouldCollapsePaste("a".repeat(PASTE_COLLAPSE_CHARS - 1))).toBe(false);
  });

  it("collapses long or many-line pastes", () => {
    expect(shouldCollapsePaste("a".repeat(PASTE_COLLAPSE_CHARS))).toBe(true);
    expect(shouldCollapsePaste(Array(PASTE_COLLAPSE_LINES).fill("x").join("\n"))).toBe(true);
    expect(shouldCollapsePaste(Array(PASTE_COLLAPSE_LINES - 1).fill("x").join("\n"))).toBe(false);
  });
});

describe("withPastes", () => {
  it("appends pasted blocks after the typed text", () => {
    expect(withPastes("look at this", ["log 1", "log 2"])).toBe("look at this\n\nlog 1\n\nlog 2");
    expect(withPastes("", ["log"])).toBe("log");
    expect(withPastes("only typed", [])).toBe("only typed");
    expect(withPastes("t", ["  "])).toBe("t");
  });
});

describe("insertPaste", () => {
  it("puts the block on its own line at the caret", () => {
    expect(insertPaste("before after", 7, "BLOCK")).toEqual({ text: "before \nBLOCK\nafter", caret: 13 });
    expect(insertPaste("", 0, "BLOCK")).toEqual({ text: "BLOCK", caret: 5 });
    expect(insertPaste("end", null, "BLOCK")).toEqual({ text: "end\nBLOCK", caret: 9 });
    expect(insertPaste("a\nb", 2, "BLOCK")).toEqual({ text: "a\nBLOCK\nb", caret: 7 });
  });
});

describe("pasteSizeLabel", () => {
  it("summarizes size and lines", () => {
    expect(pasteSizeLabel("one line")).toBe("8 chars · 1 line");
    expect(pasteSizeLabel("x".repeat(2_500) + "\nend")).toBe("2.5k chars · 2 lines");
    expect(pasteSizeLabel("x".repeat(25_000))).toBe("25k chars · 1 line");
  });
});
