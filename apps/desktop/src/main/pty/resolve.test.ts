import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary, toShellTarget, type ResolveEnv } from "./resolve.js";

function makeBin(): { dir: string; env: ResolveEnv } {
  const dir = mkdtempSync(join(tmpdir(), "cw-bin-"));
  writeFileSync(join(dir, "fakecli.cmd"), "@echo off\r\n", "utf8");
  mkdirSync(join(dir, "sub"), { recursive: true });
  const env: ResolveEnv = { pathDirs: [dir], pathExts: [".COM", ".EXE", ".BAT", ".CMD"], platform: "win32" };
  return { dir, env };
}

describe("resolveBinary", () => {
  it("finds name.cmd via PATHEXT and skips extensionless non-executables", () => {
    const { dir, env } = makeBin();
    writeFileSync(join(dir, "opencode"), "#!/bin/sh\n", "utf8");
    writeFileSync(join(dir, "opencode.cmd"), "@echo off\r\n", "utf8");
    expect(resolveBinary("opencode", env)?.toLowerCase()).toBe(join(dir, "opencode.cmd").toLowerCase());
  });

  it("prefers .exe over .cmd per PATHEXT order", () => {
    const { dir, env } = makeBin();
    writeFileSync(join(dir, "fakecli.exe"), "MZ", "utf8");
    expect(resolveBinary("fakecli", env)?.toLowerCase()).toBe(join(dir, "fakecli.exe").toLowerCase());
  });

  it("finds a .ps1 shim when PATHEXT lacks .PS1", () => {
    const { dir, env } = makeBin();
    writeFileSync(join(dir, "onlyps.ps1"), "Write-Host hi\r\n", "utf8");
    expect(resolveBinary("onlyps", env)?.toLowerCase()).toBe(join(dir, "onlyps.ps1").toLowerCase());
  });

  it("prefers PATHEXT matches over the .ps1 fallback", () => {
    const { dir, env } = makeBin();
    writeFileSync(join(dir, "both.cmd"), "@echo off\r\n", "utf8");
    writeFileSync(join(dir, "both.ps1"), "Write-Host hi\r\n", "utf8");
    expect(resolveBinary("both", env)?.toLowerCase()).toBe(join(dir, "both.cmd").toLowerCase());
  });

  it("returns null when missing", () => {
    expect(resolveBinary("definitely-not-a-binary-xyz", makeBin().env)).toBeNull();
  });
});

describe("toShellTarget", () => {
  it("wraps .cmd in cmd.exe /k", () => {
    const { env } = makeBin();
    expect(toShellTarget("fakecli", [], env)).toEqual({
      file: "cmd.exe",
      args: ["/k", expect.stringContaining("fakecli.cmd")]
    });
  });

  it("spawns .exe directly", () => {
    const { dir, env } = makeBin();
    writeFileSync(join(dir, "fakecli.exe"), "MZ", "utf8");
    expect(toShellTarget("fakecli", ["--foo"], env)).toEqual({
      file: join(dir, "fakecli.exe"),
      args: ["--foo"]
    });
  });

  it("throws a descriptive error when missing", () => {
    expect(() => toShellTarget("nope-missing", [], makeBin().env)).toThrow(/Cannot find 'nope-missing' on PATH/);
  });
});
