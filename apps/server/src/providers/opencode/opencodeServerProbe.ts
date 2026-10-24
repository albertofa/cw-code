import { randomBytes } from "node:crypto";
import { OPENCODE_HEALTH_TIMEOUT_MS, isConnectionError, opencodeFetch } from "./opencodeFetch.js";

export type OpencodeProtocolVersion = "v1" | "v2";

export interface OpencodeServerIdentity {
  protocol: OpencodeProtocolVersion;
  version: string;
}

export const OPENCODE_SERVER_USERNAME = "opencode";

export function newServerPassword(): string {
  return randomBytes(24).toString("base64url");
}

export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString("base64")}`;
}

export function serverAuthEnv(password: string, protocol: OpencodeProtocolVersion): Record<string, string> {
  if (protocol === "v2") return { OPENCODE_PASSWORD: password };
  return { OPENCODE_SERVER_USERNAME, OPENCODE_SERVER_PASSWORD: password };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isJson(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/json");
}

export function parseV2Info(contentType: string, body: unknown): string | null {
  if (!isJson(contentType)) return null;
  const version = asRecord(body)?.["version"];
  return typeof version === "string" && version ? version : null;
}

export function parseV1Health(contentType: string, body: unknown): string | null {
  if (!isJson(contentType)) return null;
  const record = asRecord(body);
  if (record?.["healthy"] !== true) return null;
  const version = record["version"];
  return typeof version === "string" && version ? version : null;
}

export function protocolOfVersion(version: string | null | undefined): OpencodeProtocolVersion | null {
  const major = /^v?(\d+)\./.exec(version?.trim() ?? "")?.[1];
  if (major === undefined) return null;
  return Number(major) >= 2 ? "v2" : "v1";
}

export function parseStdioServerUrl(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const url = asRecord(JSON.parse(trimmed))?.["url"];
    if (typeof url !== "string") return null;
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

interface ProbeAnswer {
  version: string | null;
  summary: string;
}

async function probeEndpoint(
  port: number,
  authHeader: string,
  path: string,
  parse: (contentType: string, body: unknown) => string | null
): Promise<ProbeAnswer> {
  const res = await opencodeFetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: authHeader, Accept: "application/json" },
    timeoutMs: OPENCODE_HEALTH_TIMEOUT_MS,
    port
  });
  const contentType = res.headers.get("content-type") ?? "";
  const summary = `GET ${path} answered ${res.status} ${contentType.split(";")[0] || "without a content type"}`;
  if (!res.ok || !isJson(contentType)) {
    await res.body?.cancel().catch(() => undefined);
    return { version: null, summary };
  }
  try {
    return { version: parse(contentType, (await res.json()) as unknown), summary };
  } catch {
    return { version: null, summary: `${summary} with an unreadable body` };
  }
}

export class UnsupportedOpencodeServerError extends Error {
  constructor(details: string[]) {
    super(`opencode server speaks no protocol cw-code supports (${details.join("; ")}); install opencode v1 (>= 1.18.31) or v2 (>= 2.0.32)`);
    this.name = "UnsupportedOpencodeServerError";
  }
}

export async function identifyServer(port: number, authHeader: string): Promise<OpencodeServerIdentity> {
  const v2 = await probeEndpoint(port, authHeader, "/api/info", parseV2Info);
  if (v2.version) return { protocol: "v2", version: v2.version };
  const v1 = await probeEndpoint(port, authHeader, "/global/health", parseV1Health);
  if (v1.version) return { protocol: "v1", version: v1.version };
  throw new UnsupportedOpencodeServerError([v2.summary, v1.summary]);
}

export async function waitForServerIdentity(
  port: number,
  authHeader: string,
  timeoutMs: number,
  pauseMs = 1000
): Promise<OpencodeServerIdentity> {
  const start = Date.now();
  let unsupported: UnsupportedOpencodeServerError | null = null;
  let unsupportedStreak = 0;
  for (;;) {
    try {
      return await identifyServer(port, authHeader);
    } catch (err) {
      if (err instanceof UnsupportedOpencodeServerError) {
        unsupported = err;
        unsupportedStreak += 1;
        if (unsupportedStreak >= 3) throw err;
      } else if (!isConnectionError(err)) {
        unsupportedStreak = 0;
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw unsupported ?? new Error(`opencode serve on ${port} did not become healthy`);
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }
}
