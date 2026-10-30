import type { ServerInfo } from "@cw-code/contracts";
import { INFO_PATH, MCP_PATH, STOP_PATH, WS_PATH } from "@cw-code/shared/protocol";
import { sameOrigin } from "./originPolicy.js";
import { tokensEqual } from "./ownerToken.js";
import { contentTypeFor, resolveStaticPath } from "./staticFiles.js";

export interface HttpRoutesOptions {
  uiDir: string | null;
  info: ServerInfo;
  ownerToken: string;
  stop(): void;
  mcp?: (req: Request, extendTimeout: (seconds: number) => void) => Promise<Response>;
}

const BEARER_PATTERN = /^bearer\s+(\S+)\s*$/i;
const HOST_PATTERN = /^[a-z0-9.\-:[\]]+$/i;
const UI_NOT_BUNDLED = "web UI is not bundled with this server (build it with bun --filter @cw-code/ui build)";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
};

export function cspFor(host: string): string {
  const socketSources = HOST_PATTERN.test(host) ? ` ws://${host} wss://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    `connect-src 'self'${socketSources}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

export function reply(body: BodyInit | null, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

function methodNotAllowed(allow: string): Response {
  return reply("method not allowed", 405, { Allow: allow });
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export function bearerOf(authorization: string | null | undefined): string | null {
  return BEARER_PATTERN.exec(authorization ?? "")?.[1] ?? null;
}

export function bearerToken(req: Request): string | null {
  return bearerOf(req.headers.get("authorization"));
}

function handleInfo(req: Request, opts: HttpRoutesOptions): Response {
  if (!isReadMethod(req.method)) return methodNotAllowed("GET, HEAD");
  const body = req.method === "HEAD" ? null : JSON.stringify(opts.info);
  return reply(body, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}

function handleStop(req: Request, opts: HttpRoutesOptions): Response {
  if (req.method !== "POST") return methodNotAllowed("POST");
  const origin = req.headers.get("origin");
  if (origin !== null && !sameOrigin(origin, req.headers.get("host"))) return reply("forbidden", 403);
  const token = bearerToken(req);
  if (token === null || !tokensEqual(opts.ownerToken, token)) return reply("unauthorized", 401, { "WWW-Authenticate": "Bearer" });
  opts.stop();
  return reply(null, 202);
}

async function handleStatic(req: Request, pathname: string, opts: HttpRoutesOptions): Promise<Response> {
  if (!isReadMethod(req.method)) return methodNotAllowed("GET, HEAD");
  if (opts.uiDir === null) return reply(pathname === "/" ? UI_NOT_BUNDLED : "not found", 404, { "Content-Type": "text/plain; charset=utf-8" });
  const resolved = await resolveStaticPath(opts.uiDir, pathname);
  if (resolved.kind === "bad-request") return reply("bad request", 400);
  if (resolved.kind === "not-found") return reply("not found", 404);
  const contentType = contentTypeFor(resolved.path);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": resolved.immutable ? IMMUTABLE_CACHE : "no-cache"
  };
  if (contentType.startsWith("text/html")) {
    headers["Content-Security-Policy"] = cspFor(req.headers.get("host") ?? "");
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
  }
  const file = Bun.file(resolved.path);
  if (req.method === "HEAD") return reply(null, 200, { ...headers, "Content-Length": String(file.size) });
  return reply(file, 200, headers);
}

export function handleHttp(
  req: Request,
  opts: HttpRoutesOptions,
  extendTimeout: (seconds: number) => void = () => {}
): Response | Promise<Response> | null {
  const { pathname } = new URL(req.url);
  if (pathname === WS_PATH) return null;
  if (pathname === INFO_PATH) return handleInfo(req, opts);
  if (pathname === STOP_PATH) return handleStop(req, opts);
  if (pathname === MCP_PATH) return opts.mcp ? opts.mcp(req, extendTimeout) : reply("not found", 404);
  return handleStatic(req, pathname, opts);
}
