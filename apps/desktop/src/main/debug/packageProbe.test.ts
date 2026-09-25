import { describe, expect, it } from "vitest";
import { buildProbeResult, shapeNodePtyResult } from "./packageProbe.js";

describe("shapeNodePtyResult", () => {
  it("reports a successful load and spawn", () => {
    expect(shapeNodePtyResult({ status: "loaded-spawned", exitCode: 0 })).toEqual({
      loaded: true,
      spawned: true,
      exitCode: 0,
      error: null
    });
  });

  it("reports a spawn that never exited within the timeout", () => {
    expect(shapeNodePtyResult({ status: "loaded-timeout" })).toEqual({
      loaded: true,
      spawned: true,
      exitCode: null,
      error: "pty did not exit within timeout"
    });
  });

  it("reports a module that failed to load", () => {
    expect(shapeNodePtyResult({ status: "load-failed", error: "native module mismatch" })).toEqual({
      loaded: false,
      spawned: false,
      exitCode: null,
      error: "native module mismatch"
    });
  });

  it("reports a module that loaded but failed to spawn", () => {
    expect(shapeNodePtyResult({ status: "spawn-failed", error: "ENOENT" })).toEqual({
      loaded: true,
      spawned: false,
      exitCode: null,
      error: "ENOENT"
    });
  });
});

describe("buildProbeResult", () => {
  it("assembles the full probe contract from raw inputs", () => {
    const result = buildProbeResult({
      appVersion: "0.0.1-alpha.22",
      electronVersion: "36.9.5",
      platform: "win32",
      arch: "x64",
      nodePty: { status: "loaded-spawned", exitCode: 0 },
      rendererLoaded: true,
      cliChecks: [
        { binary: "claude", binaryPath: "claude.exe", minimum: "2.1.260", actual: null, available: false, error: "ENOENT", ok: false }
      ],
      durationMs: 1234
    });
    expect(result).toEqual({
      appVersion: "0.0.1-alpha.22",
      electron: "36.9.5",
      platform: "win32",
      arch: "x64",
      nodePty: { loaded: true, spawned: true, exitCode: 0, error: null },
      rendererLoaded: true,
      cliChecks: [
        { binary: "claude", binaryPath: "claude.exe", minimum: "2.1.260", actual: null, available: false, error: "ENOENT", ok: false }
      ],
      durationMs: 1234
    });
  });

  it("reflects a renderer that failed to load", () => {
    const result = buildProbeResult({
      appVersion: "0.0.1-alpha.22",
      electronVersion: "36.9.5",
      platform: "win32",
      arch: "x64",
      nodePty: { status: "load-failed", error: "boom" },
      rendererLoaded: false,
      cliChecks: [],
      durationMs: 5
    });
    expect(result.rendererLoaded).toBe(false);
    expect(result.nodePty).toEqual({ loaded: false, spawned: false, exitCode: null, error: "boom" });
  });
});
