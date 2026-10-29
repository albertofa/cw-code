import { WS_PATH } from "./protocol.js";

export type ParsedServerAddress = { httpUrl: string; wsUrl: string; token: string | null } | { error: string };

const HTTP_SCHEMES: Record<string, string> = { "http:": "http:", "https:": "https:", "ws:": "http:", "wss:": "https:" };
const WS_SCHEMES: Record<string, string> = { "http:": "ws:", "https:": "wss:" };
const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const FILE_SEGMENT = /\/[^/]*\.[^/]*$/;

export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token")?.trim();
  return token ? token : null;
}

function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

export function parseServerAddress(input: string): ParsedServerAddress {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: "not a valid URL" };
  }
  const httpScheme = HTTP_SCHEMES[url.protocol];
  if (!httpScheme) return { error: `unsupported scheme "${url.protocol}"; use http(s):// or ws(s)://` };
  if (url.username || url.password) return { error: "the address must not contain a user name or password" };
  if (!url.hostname) return { error: "the address has no host" };
  let base = trimTrailingSlashes(FILE_SEGMENT.test(url.pathname) ? new URL(".", url).pathname : url.pathname);
  if (httpScheme !== url.protocol && base.endsWith(WS_PATH)) base = base.slice(0, -WS_PATH.length);
  const httpUrl = `${httpScheme}//${url.host}${base}`;
  return { httpUrl, wsUrl: `${WS_SCHEMES[httpScheme]}//${url.host}${base}${WS_PATH}`, token: tokenFromHash(url.hash) };
}

export function wsUrlFromPage(href: string): string {
  const url = new URL(WS_PATH.slice(1), href);
  url.protocol = WS_SCHEMES[url.protocol] ?? url.protocol;
  return url.toString();
}

export function pairingLink(publicUrl: string, token: string): string {
  return `${trimTrailingSlashes(publicUrl)}/#token=${encodeURIComponent(token)}`;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || IPV4_LOOPBACK.test(normalized);
}
