import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { rotateIfOversize } from "./logRotation.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

type ConsoleLevel = "log" | "warn" | "error";

const LEVELS: ConsoleLevel[] = ["log", "warn", "error"];

export function serverLogPath(logDir: string): string {
  return join(logDir, "server.log");
}

function ignoreStreamError(): void {}

export function initServerLog(logDir: string, opts?: { maxBytes?: number }): () => void {
  const path = serverLogPath(logDir);
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const originals = new Map<ConsoleLevel, (...args: unknown[]) => void>();
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.warn(`[cw-code] server log disabled, cannot create ${logDir}: ${String(err)}`);
  }

  function append(level: ConsoleLevel, args: unknown[]): void {
    try {
      rotateIfOversize(path, maxBytes);
      appendFileSync(path, `${new Date().toISOString()} [${level}] ${format(...args)}\n`, "utf8");
    } catch {
      return;
    }
  }

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    originals.set(level, console[level]);
    console[level] = (...args: unknown[]) => {
      append(level, args);
      try {
        original(...args);
      } catch {
        return;
      }
    };
  }
  process.stdout.on("error", ignoreStreamError);
  process.stderr.on("error", ignoreStreamError);

  return () => {
    for (const level of LEVELS) console[level] = originals.get(level)!;
    process.stdout.off("error", ignoreStreamError);
    process.stderr.off("error", ignoreStreamError);
  };
}
