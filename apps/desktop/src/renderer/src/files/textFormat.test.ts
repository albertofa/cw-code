import { describe, expect, it } from "bun:test";
import { detectEol, detectIndent, languageLabelFallback } from "./textFormat.js";

describe("detectEol", () => {
  it("defaults to LF", () => {
    expect(detectEol("")).toBe("\n");
    expect(detectEol("no breaks")).toBe("\n");
  });

  it("detects CRLF and LF", () => {
    expect(detectEol("a\r\nb\r\nc")).toBe("\r\n");
    expect(detectEol("a\nb\nc")).toBe("\n");
  });

  it("takes the majority of mixed endings", () => {
    expect(detectEol("a\r\nb\r\nc\nd")).toBe("\r\n");
    expect(detectEol("a\nb\nc\r\nd")).toBe("\n");
  });

  it("only samples the first 1000 line breaks", () => {
    const text = "x\n".repeat(1000) + "y\r\n".repeat(5000);
    expect(detectEol(text)).toBe("\n");
  });
});

describe("detectIndent", () => {
  it("defaults to two spaces", () => {
    expect(detectIndent("")).toEqual({ unit: "  ", label: "Spaces: 2" });
    expect(detectIndent("a\nb\n")).toEqual({ unit: "  ", label: "Spaces: 2" });
  });

  it("detects tabs", () => {
    expect(detectIndent("a {\n\tb;\n\t\tc;\n}\n")).toEqual({ unit: "\t", label: "Tabs" });
  });

  it("detects two, four and eight spaces from indent increases", () => {
    expect(detectIndent("a:\n  b:\n    c: 1\n  d: 2\n")).toEqual({ unit: "  ", label: "Spaces: 2" });
    expect(detectIndent("if (a) {\n    b();\n    if (c) {\n        d();\n    }\n}\n")).toEqual({
      unit: "    ",
      label: "Spaces: 4"
    });
    expect(detectIndent("a\n        b\n        c\n")).toEqual({ unit: "        ", label: "Spaces: 8" });
  });

  it("ignores blank lines and odd comment alignment", () => {
    const text = "/**\n * doc\n */\nfunction f() {\n\n    return 1;\n}\n";
    expect(detectIndent(text).label).toBe("Spaces: 4");
  });

  it("prefers spaces when tab lines are the minority", () => {
    expect(detectIndent("a\n  b\n  c\n  d\n\te\n").label).toBe("Spaces: 2");
  });

  it("handles CRLF text", () => {
    expect(detectIndent("a\r\n    b\r\n    c\r\n").label).toBe("Spaces: 4");
  });
});

describe("languageLabelFallback", () => {
  it("upper-cases the extension", () => {
    expect(languageLabelFallback("src/index.ts")).toBe("TS");
    expect(languageLabelFallback("archive.tar.gz")).toBe("GZ");
  });

  it("falls back to Plain Text without an extension", () => {
    expect(languageLabelFallback("Makefile")).toBe("Plain Text");
    expect(languageLabelFallback(".gitignore")).toBe("Plain Text");
    expect(languageLabelFallback("dir.d/Makefile")).toBe("Plain Text");
    expect(languageLabelFallback("trailing.")).toBe("Plain Text");
  });
});
