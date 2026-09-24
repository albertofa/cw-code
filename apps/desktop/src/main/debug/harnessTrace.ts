import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DriverKind } from "@cw-code/contracts";
import { logsDir } from "../paths/appPaths.js";
import { rotateIfOversize } from "./logRotation.js";

export type HarnessKind = DriverKind | "system";

export interface HarnessTraceCall {
  seq: number;
  ts: string;
  harness: HarnessKind;
  operation: string;
  sessionId?: string;
  turnId?: string;
  cwd?: string;
  binary?: string;
  args?: string[];
  model?: string;
  promptPreview?: string;
  promptLength?: number;
  resumeCursor?: string;
  durationMs?: number;
  ok?: boolean;
  exitCode?: number | null;
  error?: string;
  stderrPreview?: string;
  extra?: Record<string, unknown>;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const ARG_PREVIEW_MAX = 500;

let traceFilePath: string | null = null;
let nextSeq = 0;
let maxBytes = DEFAULT_MAX_BYTES;

export function initHarnessTrace(opts?: { filePath?: string; userDataDir?: string; logDir?: string; maxBytes?: number }): string {
  const filePath = opts?.filePath ?? join(opts?.logDir || opts?.userDataDir || logsDir(), "harness-trace.jsonl");
  if (opts?.maxBytes !== undefined) maxBytes = opts.maxBytes;
  traceFilePath = filePath;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (err) {
    console.warn(`harness trace init failed for ${filePath}: ${(err as Error).message}`);
  }
  return filePath;
}

export function getHarnessTracePath(): string | null {
  return traceFilePath;
}

export function resetHarnessTraceForTests(): void {
  traceFilePath = null;
  nextSeq = 0;
  maxBytes = DEFAULT_MAX_BYTES;
}

export function previewText(text: string, max = 500): { preview: string; length: number } {
  return { preview: text.length <= max ? text : text.slice(0, max), length: text.length };
}

export function truncateError(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[len=${text.length}]`;
}

const BASIC_AUTH_RE = /^Basic\s+\S+$/i;

export function sanitizeArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (BASIC_AUTH_RE.test(arg.trim())) return "Basic [redacted]";
    let out = arg.replace(/(password\s*[:=]\s*)\S+/gi, "$1[redacted]");
    if (out.length > ARG_PREVIEW_MAX) out = `${out.slice(0, ARG_PREVIEW_MAX)}…[len=${arg.length}]`;
    return out;
  });
}

export function traceHarnessCall(entry: Omit<HarnessTraceCall, "seq" | "ts">): void {
  if (!traceFilePath) return;
  const record: HarnessTraceCall = {
    seq: nextSeq++,
    ts: new Date().toISOString(),
    ...entry,
    args: entry.args ? sanitizeArgs(entry.args) : undefined,
    extra: { pid: process.pid, ...entry.extra }
  };
  try {
    rotateIfOversize(traceFilePath, maxBytes);
  } catch (err) {
    console.warn(`harness trace rotation failed: ${(err as Error).message}`);
  }
  try {
    appendFileSync(traceFilePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.warn(`harness trace write failed: ${(err as Error).message}`);
  }
}
