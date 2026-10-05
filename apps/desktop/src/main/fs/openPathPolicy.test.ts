import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOpenablePath } from "./openPathPolicy.js";

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-openpath-"));
  mkdirSync(join(dir, "sub"));
  mkdirSync(join(dir, "folder.exe"));
  for (const name of ["page.html", "PAGE.HTM", "run.exe", "run.bat", "link.lnk", "script.ps1", "note.md", "noext"]) {
    writeFileSync(join(dir, name), "x", "utf8");
  }
  return dir;
}

describe("assertOpenablePath", () => {
  it("allows existing directories", () => {
    const dir = seed();
    expect(assertOpenablePath(dir)).toBe(dir);
    expect(assertOpenablePath(join(dir, "sub"))).toBe(join(dir, "sub"));
    expect(assertOpenablePath(join(dir, "folder.exe"))).toBe(join(dir, "folder.exe"));
  });

  it("allows html files case-insensitively", () => {
    const dir = seed();
    expect(assertOpenablePath(join(dir, "page.html"))).toBe(join(dir, "page.html"));
    expect(assertOpenablePath(join(dir, "PAGE.HTM"))).toBe(join(dir, "PAGE.HTM"));
  });

  it("rejects executables, shortcuts, scripts and other files", () => {
    const dir = seed();
    for (const name of ["run.exe", "run.bat", "link.lnk", "script.ps1", "note.md", "noext"]) {
      expect(() => assertOpenablePath(join(dir, name))).toThrow(/only folders and \.html\/\.htm files/);
    }
  });

  it("rejects UNC and device paths", () => {
    expect(() => assertOpenablePath("\\\\server\\share\\a.html")).toThrow(/network and device paths/);
    expect(() => assertOpenablePath("//server/share/a.html")).toThrow(/network and device paths/);
    expect(() => assertOpenablePath("\\\\?\\C:\\a.html")).toThrow(/network and device paths/);
    expect(() => assertOpenablePath("\\\\.\\PhysicalDrive0")).toThrow(/network and device paths/);
  });

  it("rejects relative, empty and missing paths", () => {
    const dir = seed();
    expect(() => assertOpenablePath("page.html")).toThrow(/absolute path required/);
    expect(() => assertOpenablePath("")).toThrow(/path required/);
    expect(() => assertOpenablePath(join(dir, "missing.html"))).toThrow(/path not found/);
  });

  it("uses the injected stat to classify the target", () => {
    const abs = join(tmpdir(), "virtual.html");
    const dirStat = () => ({ isDirectory: () => true, isFile: () => false });
    const fileStat = () => ({ isDirectory: () => false, isFile: () => true });
    const otherStat = () => ({ isDirectory: () => false, isFile: () => false });
    expect(assertOpenablePath(abs, dirStat)).toBe(abs);
    expect(assertOpenablePath(abs, fileStat)).toBe(abs);
    expect(() => assertOpenablePath(abs, otherStat)).toThrow(/only folders/);
  });
});
