import { describe, expect, spyOn, test } from "bun:test";
import { join, resolve } from "node:path";
import { resolveUiDir } from "./uiDir.js";

const MODULE_DIR = resolve("repo", "apps", "server", "src", "transport");
const REPO_DIST = resolve("repo", "apps", "ui", "dist");

function env(execPath: string, existing: string[], compiled = false) {
  const present = new Set(existing.map((path) => resolve(path)));
  return { compiled, execPath, moduleDir: MODULE_DIR, exists: (path: string) => present.has(resolve(path)) };
}

describe("resolveUiDir", () => {
  test("prefers the explicit flag and normalizes it", () => {
    expect(resolveUiDir("some/../ui", env("bun", ["ui", REPO_DIST]))).toBe(resolve("ui"));
  });

  test("warns and disables the UI when the explicit folder is missing", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveUiDir("missing", env("bun", [REPO_DIST]))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("uses the ui folder next to a compiled binary and skips the repo fallback", () => {
    const exec = resolve("install", "cw-server.exe");
    expect(resolveUiDir(null, env(exec, [join("install", "ui"), REPO_DIST], true))).toBe(resolve("install", "ui"));
    expect(resolveUiDir(null, env(exec, [REPO_DIST], true))).toBeNull();
  });

  test("ignores a ui folder next to the bun runtime when not compiled", () => {
    const exec = resolve("tools", "bun.exe");
    expect(resolveUiDir(null, env(exec, [join("tools", "ui"), REPO_DIST]))).toBe(REPO_DIST);
  });

  test("falls back to the repo build and then to null", () => {
    expect(resolveUiDir(null, env(resolve("tools", "bun"), [REPO_DIST]))).toBe(REPO_DIST);
    expect(resolveUiDir(null, env(resolve("tools", "bun"), []))).toBeNull();
  });
});
