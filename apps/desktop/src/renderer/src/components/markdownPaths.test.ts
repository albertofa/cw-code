import { describe, expect, it } from "vitest";
import { parseFilePath } from "./markdownPaths.js";

describe("parseFilePath", () => {
  it("accepts a bare file name", () => {
    expect(parseFilePath("theme.css")).toEqual({ path: "theme.css" });
  });

  it("accepts a nested relative path", () => {
    expect(parseFilePath("apps/desktop/src/App.tsx")).toEqual({ path: "apps/desktop/src/App.tsx" });
  });

  it("reads a line suffix", () => {
    expect(parseFilePath("src/a/b.tsx:12")).toEqual({ path: "src/a/b.tsx", line: 12 });
  });

  it("reads a line range suffix", () => {
    expect(parseFilePath("apps/x.ts:3-9")).toEqual({ path: "apps/x.ts", line: 3, endLine: 9 });
  });

  it("accepts a windows path and keeps the drive colon", () => {
    expect(parseFilePath("C:\\dir\\file.cs")).toEqual({ path: "C:\\dir\\file.cs" });
    expect(parseFilePath("C:\\dir\\file.cs:7")).toEqual({ path: "C:\\dir\\file.cs", line: 7 });
  });

  it("accepts dotfiles with a short extension", () => {
    expect(parseFilePath(".env")).toEqual({ path: ".env" });
  });

  it("rejects versions", () => {
    expect(parseFilePath("1.2.3")).toBeNull();
    expect(parseFilePath("v2.1.0")).toBeNull();
    expect(parseFilePath("3.14")).toBeNull();
  });

  it("rejects css custom properties and flags", () => {
    expect(parseFilePath("--violet")).toBeNull();
    expect(parseFilePath("--verbose")).toBeNull();
    expect(parseFilePath("--out=dist/app.js")).toBeNull();
  });

  it("rejects urls", () => {
    expect(parseFilePath("https://x.y/z.js")).toBeNull();
  });

  it("rejects text with whitespace", () => {
    expect(parseFilePath("pnpm test")).toBeNull();
    expect(parseFilePath("src/a.ts now")).toBeNull();
  });

  it("rejects names without an extension", () => {
    expect(parseFilePath("README")).toBeNull();
    expect(parseFilePath("src/components")).toBeNull();
    expect(parseFilePath("src/components/")).toBeNull();
  });

  it("rejects trailing dots and overlong extensions", () => {
    expect(parseFilePath("e.g.")).toBeNull();
    expect(parseFilePath("archive.extensions")).toBeNull();
  });

  it("rejects calls and globs", () => {
    expect(parseFilePath("foo.bar()")).toBeNull();
    expect(parseFilePath("*.ts")).toBeNull();
  });

  it("accepts known source extensions without a separator", () => {
    expect(parseFilePath("Program.cs")).toEqual({ path: "Program.cs" });
    expect(parseFilePath("Program.CS")).toEqual({ path: "Program.CS" });
    expect(parseFilePath("pnpm-lock.yaml:4")).toEqual({ path: "pnpm-lock.yaml", line: 4 });
  });

  it("accepts unknown extensions only when a separator is present", () => {
    expect(parseFilePath("assets/logo.svgz")).toEqual({ path: "assets/logo.svgz" });
    expect(parseFilePath("logo.svgz")).toBeNull();
  });

  it("rejects dotted identifiers", () => {
    expect(parseFilePath("console.log")).toBeNull();
    expect(parseFilePath("obj.method")).toBeNull();
    expect(parseFilePath("e.g")).toBeNull();
    expect(parseFilePath("process.env.NODE_ENV")).toBeNull();
    expect(parseFilePath("useState.length:3")).toBeNull();
  });

  it("rejects UNC and device paths", () => {
    expect(parseFilePath("\\\\evil\\share\\a.txt")).toBeNull();
    expect(parseFilePath("//evil/share/a.txt")).toBeNull();
    expect(parseFilePath("\\\\.\\pipe\\x.cs")).toBeNull();
    expect(parseFilePath("//./C:/a.ts")).toBeNull();
  });

  it("rejects empty text", () => {
    expect(parseFilePath("")).toBeNull();
  });
});
