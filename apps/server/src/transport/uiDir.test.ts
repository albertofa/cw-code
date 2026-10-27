import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { resolveUiDir } from "./uiDir.js";

const MODULE_DIR = resolve("repo", "apps", "server", "src", "transport");
const REPO_DIST = resolve("repo", "apps", "ui", "dist");

function env(execPath: string, existing: string[]) {
  const present = new Set(existing.map((path) => resolve(path)));
  return { execPath, moduleDir: MODULE_DIR, exists: (path: string) => present.has(resolve(path)) };
}

describe("resolveUiDir", () => {
  test("prefers the explicit flag and normalizes it", () => {
    expect(resolveUiDir("some/../ui", env("bun", [REPO_DIST]))).toBe(resolve("ui"));
  });

  test("uses the ui folder next to a compiled binary", () => {
    const exec = resolve("install", "cw-server.exe");
    expect(resolveUiDir(null, env(exec, [join("install", "ui"), REPO_DIST]))).toBe(resolve("install", "ui"));
  });

  test("ignores the folder next to the bun runtime", () => {
    const exec = resolve("tools", "bun.exe");
    expect(resolveUiDir(null, env(exec, [join("tools", "ui"), REPO_DIST]))).toBe(REPO_DIST);
  });

  test("falls back to the repo build and then to null", () => {
    expect(resolveUiDir(null, env(resolve("install", "cw-server"), [REPO_DIST]))).toBe(REPO_DIST);
    expect(resolveUiDir(null, env(resolve("install", "cw-server"), []))).toBeNull();
  });
});
