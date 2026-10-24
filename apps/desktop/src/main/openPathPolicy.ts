import { statSync, type Stats } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

const UNC_OR_DEVICE_PREFIX = /^[\\/]{2}/;
const OPENABLE_FILE_EXTS = new Set([".html", ".htm"]);
const OPENABLE_LOG_EXTS = new Set([".log", ".jsonl", ".txt"]);

export type StatFn = (path: string) => Pick<Stats, "isDirectory" | "isFile">;

export interface OpenTarget {
  kind: "external" | "log";
  path: string;
}

function isInside(dir: string, abs: string): boolean {
  const rel = relative(resolve(dir), abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function assertLocalAbsolutePath(target: unknown): string {
  if (typeof target !== "string" || target.length === 0) throw new Error("path required");
  if (UNC_OR_DEVICE_PREFIX.test(target)) throw new Error(`network and device paths cannot be opened: ${target}`);
  if (!isAbsolute(target)) throw new Error(`absolute path required: ${target}`);
  return resolve(target);
}

export function resolveOpenTarget(target: string, logsDir?: string, stat: StatFn = statSync): OpenTarget {
  const abs = assertLocalAbsolutePath(target);
  let info: Pick<Stats, "isDirectory" | "isFile">;
  try {
    info = stat(abs);
  } catch {
    throw new Error(`path not found: ${target}`);
  }
  if (info.isDirectory()) return { kind: "external", path: abs };
  const ext = info.isFile() ? extname(abs).toLowerCase() : "";
  if (OPENABLE_FILE_EXTS.has(ext)) return { kind: "external", path: abs };
  if (logsDir && OPENABLE_LOG_EXTS.has(ext) && isInside(logsDir, abs)) return { kind: "log", path: abs };
  throw new Error(`only folders and .html/.htm files can be opened: ${target}`);
}
