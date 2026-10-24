import { statSync, type Stats } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

const UNC_OR_DEVICE_PREFIX = /^[\\/]{2}/;
const OPENABLE_FILE_EXTS = new Set([".html", ".htm"]);

export type StatFn = (path: string) => Pick<Stats, "isDirectory" | "isFile">;

function isInside(dir: string, abs: string): boolean {
  const rel = relative(resolve(dir), abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function assertOpenablePath(target: string, stat: StatFn = statSync, trustedDirs: string[] = []): string {
  if (typeof target !== "string" || target.length === 0) throw new Error("path required");
  if (UNC_OR_DEVICE_PREFIX.test(target)) throw new Error(`network and device paths cannot be opened: ${target}`);
  if (!isAbsolute(target)) throw new Error(`absolute path required: ${target}`);
  const abs = resolve(target);
  let info: Pick<Stats, "isDirectory" | "isFile">;
  try {
    info = stat(abs);
  } catch {
    throw new Error(`path not found: ${target}`);
  }
  if (info.isDirectory()) return abs;
  if (info.isFile() && OPENABLE_FILE_EXTS.has(extname(abs).toLowerCase())) return abs;
  if (info.isFile() && trustedDirs.some((dir) => isInside(dir, abs))) return abs;
  throw new Error(`only folders and .html/.htm files can be opened: ${target}`);
}
