import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { rotateIfOversize } from "./logRotation.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export type CrashLogSource = "server" | "shell";

let logPath: string | null = null;
let source: CrashLogSource = "server";
let maxBytes = DEFAULT_MAX_BYTES;
let lastEntry: string | null = null;
let repeats = 0;

export function initCrashLog(logDir: string, tag: CrashLogSource, opts?: { maxBytes?: number }): string {
  logPath = join(logDir, "crash.log");
  source = tag;
  maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  lastEntry = null;
  repeats = 0;
  return logPath;
}

export function getCrashLogPath(): string | null {
  return logPath;
}

export function appendCrashLog(entry: string): void {
  if (!logPath) return;
  if (entry === lastEntry) {
    repeats += 1;
    return;
  }
  const prefix = `${new Date().toISOString()} [${source}]`;
  const summary = repeats > 0 ? `${prefix} previous entry repeated ${repeats} more time${repeats === 1 ? "" : "s"}\n` : "";
  try {
    rotateIfOversize(logPath, maxBytes);
  } catch {
  }
  try {
    appendFileSync(logPath, `${summary}${prefix} ${entry}\n`, "utf8");
  } catch {
    return;
  }
  lastEntry = entry;
  repeats = 0;
}
