import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCliVersion, checkCliVersions, isBinaryUnavailableError, meetsMinimum, versionProbeTarget } from "./cliVersions.js";

describe("meetsMinimum", () => {
  it("accepts the exact minimum version", () => {
    expect(meetsMinimum("2.1.260", "2.1.260")).toBe(true);
  });

  it("accepts a newer patch than the minimum (claude 2.1.266 vs 2.1.260)", () => {
    expect(meetsMinimum("2.1.266", "2.1.260")).toBe(true);
  });

  it("accepts newer minor and major versions", () => {
    expect(meetsMinimum("2.2.0", "2.1.260")).toBe(true);
    expect(meetsMinimum("3.0.0", "2.1.260")).toBe(true);
  });

  it("compares numerically, not lexicographically", () => {
    expect(meetsMinimum("2.1.9", "2.1.10")).toBe(false);
    expect(meetsMinimum("2.1.10", "2.1.9")).toBe(true);
  });

  it("rejects an older version (opencode 1.17.14 vs 1.18.23)", () => {
    expect(meetsMinimum("1.17.14", "1.18.23")).toBe(false);
  });

  it("rejects a missing binary", () => {
    expect(meetsMinimum(null, "1.18.23")).toBe(false);
  });

  it("falls back to exact equality for non-semver output", () => {
    expect(meetsMinimum("nightly", "nightly")).toBe(true);
    expect(meetsMinimum("nightly", "1.18.23")).toBe(false);
  });
});

describe("isBinaryUnavailableError", () => {
  it("recognizes missing, inaccessible, and invalid executables", () => {
    for (const code of ["ENOENT", "EACCES", "EINVAL", "EPERM"]) {
      expect(isBinaryUnavailableError({ code })).toBe(true);
    }
  });

  it("does not classify command failures and timeouts as missing executables", () => {
    expect(isBinaryUnavailableError({ code: 1 })).toBe(false);
    expect(isBinaryUnavailableError({ code: "ETIMEDOUT" })).toBe(false);
  });
});

describe("versionProbeTarget", () => {
  it("probes executables directly on any platform", () => {
    expect(versionProbeTarget("/usr/local/bin/opencode", "linux")).toEqual({
      file: "/usr/local/bin/opencode",
      args: ["--version"]
    });
    expect(versionProbeTarget("C:\\tools\\codex.exe", "win32")).toEqual({
      file: "C:\\tools\\codex.exe",
      args: ["--version"]
    });
  });

  it("routes Windows script shims through powershell", () => {
    expect(versionProbeTarget("C:\\nvm4w\\nodejs\\opencode.cmd", "win32")).toEqual({
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `& 'C:\\nvm4w\\nodejs\\opencode.cmd' --version`]
    });
    expect(versionProbeTarget("C:\\tools\\codex.BAT", "win32")).toEqual({
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `& 'C:\\tools\\codex.BAT' --version`]
    });
    expect(versionProbeTarget("C:\\nvm4w\\nodejs\\codex.ps1", "win32")).toEqual({
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `& 'C:\\nvm4w\\nodejs\\codex.ps1' --version`]
    });
    expect(versionProbeTarget("C:\\odd'dir\\tool.cmd", "win32").args[3]).toBe(
      `& 'C:\\odd''dir\\tool.cmd' --version`
    );
  });

  it("ignores extensions on posix", () => {
    expect(versionProbeTarget("/opt/bin/tool.cmd", "linux")).toEqual({
      file: "/opt/bin/tool.cmd",
      args: ["--version"]
    });
  });
});

describe("checkCliVersions", () => {
  it("accepts an executable that responds to --version even when it is below the CLI minimum", async () => {
    const check = await checkCliVersion("claude", process.execPath);
    expect(check).toMatchObject({ binaryPath: process.execPath, available: true, error: null });
    expect(check.actual).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.skipIf(process.platform !== "win32")("probes a Windows .cmd shim through powershell", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cw-version-")), "cli.cmd");
    writeFileSync(file, "@echo 1.2.3\r\n", "utf8");
    const checks = await checkCliVersions({ claudeBinary: file, opencodeBinary: file, codexBinary: file });
    expect(checks).toHaveLength(3);
    expect(checks.every((check) => check.available && check.error === null)).toBe(true);
    expect(checks.every((check) => check.actual === "1.2.3")).toBe(true);
  });
});
