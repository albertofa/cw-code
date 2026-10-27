import { statSync } from "node:fs";
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

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveStaticPath(uiDir: string, pathname: string): StaticResolution {
  const decoded = decodePathname(pathname);
  if (decoded === null || !decoded.startsWith("/") || hasUnsafeSegment(decoded)) return { kind: "bad-request" };
  const base = resolve(uiDir);
  const relativePath = decoded === "/" ? INDEX_FILE : decoded.slice(1);
  const target = resolve(join(base, relativePath));
  const inside = relative(base, target);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { kind: "bad-request" };
  if (!isRegularFile(target)) return { kind: "not-found" };
  return { kind: "file", path: target, immutable: decoded.startsWith(IMMUTABLE_PREFIX) };
}
