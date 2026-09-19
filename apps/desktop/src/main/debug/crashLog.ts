import { appendFileSync } from "node:fs";
import { join } from "node:path";

let logPath: string | null = null;

export function initCrashLog(logDir: string): string {
  logPath = join(logDir, "crash.log");
  return logPath;
}

export function getCrashLogPath(): string | null {
  return logPath;
}

export function appendCrashLog(entry: string): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${entry}\n`, "utf8");
  } catch {
    return;
  }
}
