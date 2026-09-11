import { appendFileSync } from "node:fs";
import { join } from "node:path";

let logPath: string | null = null;

export function initCrashLog(userDataDir: string): string {
  logPath = join(userDataDir, "crash.log");
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
