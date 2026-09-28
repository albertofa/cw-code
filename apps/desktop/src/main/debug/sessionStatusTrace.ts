import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionStatus, SessionStatusReason } from "@cw-code/contracts";
import { logsDir } from "../paths/appPaths.js";
import { rotateIfOversize } from "./logRotation.js";

export type { SessionStatusReason };

export interface SessionStatusTransition {
  seq: number;
  ts: string;
  pid: number;
  sessionId: string;
  driver: string;
  from: SessionStatus | null;
  to: SessionStatus;
  reason: SessionStatusReason;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

let statusFilePath: string | null = null;
let nextSeq = 0;
let maxBytes = DEFAULT_MAX_BYTES;

export function initSessionStatusTrace(opts?: { filePath?: string; logDir?: string; maxBytes?: number }): string {
  const filePath = opts?.filePath ?? join(opts?.logDir ?? logsDir(), "session-status.jsonl");
  if (opts?.maxBytes !== undefined) maxBytes = opts.maxBytes;
  statusFilePath = filePath;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (err) {
    console.warn(`session status trace init failed for ${filePath}: ${(err as Error).message}`);
  }
  return filePath;
}

export function getSessionStatusTracePath(): string | null {
  return statusFilePath;
}

export function resetSessionStatusTraceForTests(): void {
  statusFilePath = null;
  nextSeq = 0;
  maxBytes = DEFAULT_MAX_BYTES;
}

export function traceSessionStatus(entry: {
  sessionId: string;
  driver: string;
  from: SessionStatus | null;
  to: SessionStatus;
  reason: SessionStatusReason;
}): void {
  if (!statusFilePath) return;
  const record: SessionStatusTransition = {
    seq: nextSeq++,
    ts: new Date().toISOString(),
    pid: process.pid,
    ...entry
  };
  try {
    rotateIfOversize(statusFilePath, maxBytes);
  } catch (err) {
    console.warn(`session status trace rotation failed: ${(err as Error).message}`);
  }
  try {
    appendFileSync(statusFilePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.warn(`session status trace write failed: ${(err as Error).message}`);
  }
}
