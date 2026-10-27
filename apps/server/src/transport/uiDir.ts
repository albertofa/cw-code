import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface UiDirEnvironment {
  execPath: string;
  moduleDir: string;
  exists(path: string): boolean;
}

const BUN_RUNTIME_NAMES = new Set(["bun", "bun.exe"]);
const REPO_UI_DIST = ["..", "..", "..", "ui", "dist"];

function isCompiled(execPath: string): boolean {
  return !BUN_RUNTIME_NAMES.has(basename(execPath).toLowerCase());
}

export function resolveUiDir(
  explicit: string | null,
  env: UiDirEnvironment = { execPath: process.execPath, moduleDir: dirname(fileURLToPath(import.meta.url)), exists: existsSync }
): string | null {
  if (explicit) return resolve(explicit);
  if (isCompiled(env.execPath)) {
    const bundled = join(dirname(env.execPath), "ui");
    if (env.exists(bundled)) return resolve(bundled);
  }
  const repoDist = resolve(env.moduleDir, ...REPO_UI_DIST);
  return env.exists(repoDist) ? repoDist : null;
}
