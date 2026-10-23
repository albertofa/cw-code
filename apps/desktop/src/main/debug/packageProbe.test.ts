import { describe, expect, it } from "bun:test";
import { buildProbeResult, probeSandbox, readApparmorLabel, RendererProbeTracker, shapeNodePtyResult } from "./packageProbe.js";

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
      startupMode: "ready",
      electronVersion: "36.9.5",
      platform: "win32",
      arch: "x64",
      nodePty: { status: "loaded-spawned", exitCode: 0 },
      renderer: { loadCompleted: true, failures: [] },
      cliChecks: [
        { binary: "claude", binaryPath: "claude.exe", minimum: "2.1.260", actual: null, configured: false, found: false, available: false, error: "ENOENT", ok: false }
      ],
      sandbox: null,
      durationMs: 1234
    });
    expect(result).toEqual({
      appVersion: "0.0.1-alpha.22",
      startupMode: "ready",
      electron: "36.9.5",
      platform: "win32",
      arch: "x64",
      nodePty: { loaded: true, spawned: true, exitCode: 0, error: null },
      rendererLoaded: true,
      rendererFailures: [],
      cliChecks: [
        { binary: "claude", binaryPath: "claude.exe", minimum: "2.1.260", actual: null, configured: false, found: false, available: false, error: "ENOENT", ok: false }
      ],
      sandbox: null,
      durationMs: 1234
    });
  });

  it("reflects a renderer that failed to load", () => {
    const result = buildProbeResult({
      appVersion: "0.0.1-alpha.22",
      startupMode: "ready",
      electronVersion: "36.9.5",
      platform: "win32",
      arch: "x64",
      nodePty: { status: "load-failed", error: "boom" },
      renderer: { loadCompleted: false, failures: ["renderer failed to load: ERR_FILE_NOT_FOUND"] },
      cliChecks: [],
      sandbox: null,
      durationMs: 5
    });
    expect(result.rendererLoaded).toBe(false);
    expect(result.rendererFailures).toEqual(["renderer failed to load: ERR_FILE_NOT_FOUND"]);
    expect(result.nodePty).toEqual({ loaded: false, spawned: false, exitCode: null, error: "boom" });
  });

  it("reports a renderer that crashed after loading as not loaded", () => {
    const result = buildProbeResult({
      appVersion: "0.0.1-alpha.22",
      startupMode: "ready",
      electronVersion: "36.9.5",
      platform: "win32",
      arch: "x64",
      nodePty: { status: "loaded-spawned", exitCode: 0 },
      renderer: { loadCompleted: true, failures: ["render-process-gone: reason=crashed exitCode=1"] },
      cliChecks: [],
      sandbox: null,
      durationMs: 5
    });
    expect(result.rendererLoaded).toBe(false);
    expect(result.rendererFailures).toEqual(["render-process-gone: reason=crashed exitCode=1"]);
  });

  it("reports an app that started in metadata recovery mode", () => {
    const result = buildProbeResult({
      appVersion: "0.0.1-alpha.22",
      startupMode: "recovery",
      electronVersion: "36.9.5",
      platform: "win32",
      arch: "x64",
      nodePty: { status: "loaded-spawned", exitCode: 0 },
      renderer: { loadCompleted: true, failures: [] },
      cliChecks: [],
      sandbox: null,
      durationMs: 5
    });
    expect(result.startupMode).toBe("recovery");
    expect(result.rendererLoaded).toBe(true);
  });

  it("carries the Linux sandbox evidence through unchanged", () => {
    const result = buildProbeResult({
      appVersion: "0.0.1-alpha.22",
      startupMode: "ready",
      electronVersion: "36.9.5",
      platform: "linux",
      arch: "x64",
      nodePty: { status: "loaded-spawned", exitCode: 0 },
      renderer: { loadCompleted: true, failures: [] },
      cliChecks: [],
      sandbox: { noSandboxSwitch: false, apparmorLabel: "cw-code (unconfined)" },
      durationMs: 5
    });
    expect(result.sandbox).toEqual({ noSandboxSwitch: false, apparmorLabel: "cw-code (unconfined)" });
  });
});

function fakeProc(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return content;
  };
}

describe("readApparmorLabel", () => {
  it("prefers the AppArmor-specific attribute", () => {
    const read = fakeProc({ "/proc/self/attr/apparmor/current": "cw-code (unconfined)\n", "/proc/self/attr/current": "unconfined\n" });
    expect(readApparmorLabel(read)).toBe("cw-code (unconfined)");
  });

  it("falls back to the generic attribute when the AppArmor one cannot be read", () => {
    expect(readApparmorLabel(fakeProc({ "/proc/self/attr/current": "unconfined\n" }))).toBe("unconfined");
  });

  it("strips the trailing NUL some kernels append", () => {
    expect(readApparmorLabel(fakeProc({ "/proc/self/attr/current": "kernel\0" }))).toBe("kernel");
  });

  it("reports no label when neither attribute is readable or the label is empty", () => {
    expect(readApparmorLabel(fakeProc({}))).toBeNull();
    expect(readApparmorLabel(fakeProc({ "/proc/self/attr/apparmor/current": "\n" }))).toBeNull();
  });
});

describe("probeSandbox", () => {
  it("records the switch and label on Linux", () => {
    expect(probeSandbox("linux", true, fakeProc({ "/proc/self/attr/current": "unconfined" }))).toEqual({
      noSandboxSwitch: true,
      apparmorLabel: "unconfined"
    });
  });

  it("is null on other platforms", () => {
    expect(probeSandbox("win32", false, fakeProc({}))).toBeNull();
  });
});

describe("RendererProbeTracker", () => {
  it("starts as not loaded", () => {
    expect(new RendererProbeTracker().snapshot()).toEqual({ loadCompleted: false, failures: [] });
  });

  it("keeps failures recorded after a successful load", () => {
    const tracker = new RendererProbeTracker();
    tracker.markLoaded();
    tracker.markFailed("render-process-gone: reason=crashed exitCode=1");
    tracker.markFailed("did-fail-load: -6 ERR_FILE_NOT_FOUND");
    expect(tracker.snapshot()).toEqual({
      loadCompleted: true,
      failures: ["render-process-gone: reason=crashed exitCode=1", "did-fail-load: -6 ERR_FILE_NOT_FOUND"]
    });
  });

  it("returns snapshots that later failures do not mutate", () => {
    const tracker = new RendererProbeTracker();
    tracker.markLoaded();
    const before = tracker.snapshot();
    tracker.markFailed("render-process-gone: reason=oom exitCode=-536870904");
    expect(before.failures).toEqual([]);
  });
});
