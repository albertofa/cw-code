import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalAbsolutePath, resolveOpenTarget, type OpenTarget } from "./openPathPolicy.js";

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-openpath-"));
  mkdirSync(join(dir, "sub"));
  mkdirSync(join(dir, "folder.exe"));
  for (const name of ["page.html", "PAGE.HTM", "run.exe", "run.bat", "link.lnk", "script.ps1", "note.md", "noext", "trace.jsonl"]) {
    writeFileSync(join(dir, name), "x", "utf8");
  }
  return dir;
}

function seedLogs(): { dir: string; logs: string } {
  const dir = mkdtempSync(join(tmpdir(), "cw-openpath-logs-"));
  const logs = join(dir, "logs");
  mkdirSync(logs);
  for (const name of ["crash.log", "harness-trace.jsonl", "notes.TXT", "run.exe", "run.bat", "link.lnk", "page.html", "data.json"]) {
    writeFileSync(join(logs, name), "x", "utf8");
  }
  writeFileSync(join(dir, "outside.log"), "x", "utf8");
  return { dir, logs };
}

const external = (path: string): OpenTarget => ({ kind: "external", path });

describe("resolveOpenTarget", () => {
  it("allows existing directories", () => {
    const dir = seed();
    expect(resolveOpenTarget(dir)).toEqual(external(dir));
    expect(resolveOpenTarget(join(dir, "sub"))).toEqual(external(join(dir, "sub")));
    expect(resolveOpenTarget(join(dir, "folder.exe"))).toEqual(external(join(dir, "folder.exe")));
  });

  it("allows html files case-insensitively", () => {
    const dir = seed();
    expect(resolveOpenTarget(join(dir, "page.html"))).toEqual(external(join(dir, "page.html")));
    expect(resolveOpenTarget(join(dir, "PAGE.HTM"))).toEqual(external(join(dir, "PAGE.HTM")));
  });

  it("rejects executables, shortcuts, scripts and other files", () => {
    const dir = seed();
    for (const name of ["run.exe", "run.bat", "link.lnk", "script.ps1", "note.md", "noext", "trace.jsonl"]) {
      expect(() => resolveOpenTarget(join(dir, name))).toThrow(/only folders and \.html\/\.htm files/);
    }
  });

  it("opens .log, .jsonl and .txt files under the logs dir as logs", () => {
    const { logs } = seedLogs();
    for (const name of ["crash.log", "harness-trace.jsonl", "notes.TXT"]) {
      expect(resolveOpenTarget(join(logs, name), logs)).toEqual({ kind: "log", path: join(logs, name) });
    }
    expect(resolveOpenTarget(join(logs, "page.html"), logs)).toEqual(external(join(logs, "page.html")));
  });

  it("rejects executables, shortcuts and other types under the logs dir", () => {
    const { logs } = seedLogs();
    for (const name of ["run.exe", "run.bat", "link.lnk", "data.json"]) {
      expect(() => resolveOpenTarget(join(logs, name), logs)).toThrow(/only folders/);
    }
  });

  it("rejects log files outside the logs dir", () => {
    const { dir, logs } = seedLogs();
    expect(() => resolveOpenTarget(join(dir, "outside.log"), logs)).toThrow(/only folders/);
    expect(() => resolveOpenTarget(join(logs, "..", "outside.log"), logs)).toThrow(/only folders/);
  });

  it("rejects UNC and device paths", () => {
    expect(() => resolveOpenTarget("\\\\server\\share\\a.html")).toThrow(/network and device paths/);
    expect(() => resolveOpenTarget("//server/share/a.html")).toThrow(/network and device paths/);
    expect(() => resolveOpenTarget("\\\\?\\C:\\a.html")).toThrow(/network and device paths/);
    expect(() => resolveOpenTarget("\\\\.\\PhysicalDrive0")).toThrow(/network and device paths/);
  });

  it("rejects relative, empty and missing paths", () => {
    const dir = seed();
    expect(() => resolveOpenTarget("page.html")).toThrow(/absolute path required/);
    expect(() => resolveOpenTarget("")).toThrow(/path required/);
    expect(() => resolveOpenTarget(join(dir, "missing.html"))).toThrow(/path not found/);
  });

  it("uses the injected stat to classify the target", () => {
    const abs = join(tmpdir(), "virtual.html");
    const dirStat = () => ({ isDirectory: () => true, isFile: () => false });
    const fileStat = () => ({ isDirectory: () => false, isFile: () => true });
    const otherStat = () => ({ isDirectory: () => false, isFile: () => false });
    expect(resolveOpenTarget(abs, undefined, dirStat)).toEqual(external(abs));
    expect(resolveOpenTarget(abs, undefined, fileStat)).toEqual(external(abs));
    expect(() => resolveOpenTarget(abs, undefined, otherStat)).toThrow(/only folders/);
  });
});

describe("assertLocalAbsolutePath", () => {
  it("returns the resolved absolute path", () => {
    const dir = seed();
    expect(assertLocalAbsolutePath(join(dir, "sub", "..", "page.html"))).toBe(join(dir, "page.html"));
  });

  it("rejects UNC, device, relative and non-string paths", () => {
    expect(() => assertLocalAbsolutePath("\\\\server\\share\\a.txt")).toThrow(/network and device paths/);
    expect(() => assertLocalAbsolutePath("\\\\?\\C:\\a.txt")).toThrow(/network and device paths/);
    expect(() => assertLocalAbsolutePath("relative/a.txt")).toThrow(/absolute path required/);
    expect(() => assertLocalAbsolutePath(undefined)).toThrow(/path required/);
  });
});
