import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export type FeedSegments = { ok: true; segments: string[] } | { ok: false; reason: string };

export type FeedFile =
  | { ok: true; path: string; relativePath: string; size: number; mtimeMs: number }
  | { ok: false; status: 400 | 403 | 404; reason: string };

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;
const ENCODED_SEPARATOR_OR_NUL = /%(2f|5c|00)/i;
const MAX_PATH_LENGTH = 512;

function reject(reason: string): FeedSegments {
  return { ok: false, reason };
}

export function feedSegments(urlPath: string): FeedSegments {
  if (urlPath.length > MAX_PATH_LENGTH) return reject("path is too long");
  if (!urlPath.startsWith("/")) return reject("path must start with /");
  if (ENCODED_SEPARATOR_OR_NUL.test(urlPath)) return reject("encoded separators and NUL are not allowed");
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return reject("malformed percent-encoding");
  }
  if (/[\\%\0:]/.test(decoded)) return reject("backslashes, percent signs, colons and NUL are not allowed");
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === "")) return reject("empty path segments are not allowed");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return reject("dot segments are not allowed");
    if (!SAFE_SEGMENT.test(segment)) return reject(`unsupported characters in "${segment}"`);
    if (segment.endsWith(".")) return reject("segments ending with a dot are not allowed");
    if (WINDOWS_DEVICE_NAME.test(segment)) return reject("Windows device names are not allowed");
  }
  return { ok: true, segments };
}

function isInside(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

export async function resolveFeedFile(root: string, urlPath: string): Promise<FeedFile> {
  const parsed = feedSegments(urlPath);
  if (!parsed.ok) return { ok: false, status: 400, reason: parsed.reason };
  const realRoot = await realpath(root);
  const candidate = join(realRoot, ...parsed.segments);
  if (!isInside(realRoot, candidate)) return { ok: false, status: 403, reason: "path escapes the feed root" };
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, status: 404, reason: "not found" };
    throw error;
  }
  if (!isInside(realRoot, realCandidate)) return { ok: false, status: 403, reason: "path resolves outside the feed root" };
  const info = await stat(realCandidate);
  if (!info.isFile()) return { ok: false, status: 404, reason: "not a file" };
  return { ok: true, path: realCandidate, relativePath: parsed.segments.join("/"), size: info.size, mtimeMs: info.mtimeMs };
}
