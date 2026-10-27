import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type StaticResolution = { kind: "file"; path: string; immutable: boolean } | { kind: "bad-request" } | { kind: "not-found" };

const INDEX_FILE = "index.html";
const IMMUTABLE_PREFIX = "/assets/";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function hasUnsafeSegment(decoded: string): boolean {
  if (decoded.includes("\0") || decoded.includes("\\")) return true;
  return decoded.split("/").some((segment) => segment === ".." || segment.includes(":"));
}

function isInside(base: string, target: string): boolean {
  const inside = relative(base, target);
  return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

async function realFileInside(base: string, target: string): Promise<string | null> {
  try {
    const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
    if (!isInside(realBase, realTarget)) return null;
    return (await stat(realTarget)).isFile() ? target : null;
  } catch {
    return null;
  }
}

export async function resolveStaticPath(uiDir: string, pathname: string): Promise<StaticResolution> {
  const decoded = decodePathname(pathname);
  if (decoded === null || !decoded.startsWith("/") || hasUnsafeSegment(decoded)) return { kind: "bad-request" };
  const base = resolve(uiDir);
  const relativePath = decoded === "/" ? INDEX_FILE : decoded.slice(1);
  const target = resolve(join(base, relativePath));
  if (!isInside(base, target)) return { kind: "bad-request" };
  const file = await realFileInside(base, target);
  if (file === null) return { kind: "not-found" };
  return { kind: "file", path: file, immutable: decoded.startsWith(IMMUTABLE_PREFIX) };
}
