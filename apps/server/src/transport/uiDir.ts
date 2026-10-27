import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface UiDirEnvironment {
  compiled: boolean;
  execPath: string;
  moduleDir: string;
  exists(path: string): boolean;
}

const COMPILED_MARKERS = ["$bunfs", "~BUN"];
const REPO_UI_DIST = ["..", "..", "..", "ui", "dist"];

function isCompiledEntry(location: string): boolean {
  return COMPILED_MARKERS.some((marker) => location.includes(marker));
}

function defaultEnvironment(): UiDirEnvironment {
  return {
    compiled: isCompiledEntry(Bun.main) || isCompiledEntry(import.meta.url),
    execPath: process.execPath,
    moduleDir: dirname(fileURLToPath(import.meta.url)),
    exists: existsSync
  };
}

export function resolveUiDir(explicit: string | null, env: UiDirEnvironment = defaultEnvironment()): string | null {
  if (explicit) {
    const dir = resolve(explicit);
    if (env.exists(dir)) return dir;
    console.warn(`--ui-dir ${dir} does not exist; the web UI is disabled`);
    return null;
  }
  if (env.compiled) {
    const bundled = join(dirname(env.execPath), "ui");
    return env.exists(bundled) ? resolve(bundled) : null;
  }
  const repoDist = resolve(env.moduleDir, ...REPO_UI_DIST);
  return env.exists(repoDist) ? repoDist : null;
}
