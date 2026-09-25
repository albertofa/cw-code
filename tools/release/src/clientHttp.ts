import { createHash } from "node:crypto";
import type { AnonymousHttp } from "./publishedCheck.ts";

export const GITHUB_API_ORIGIN = "https://api.github.com/";

export interface FeedMonitorHttp extends AnonymousHttp {
  size(url: string): Promise<{ status: number; size: number | null }>;
  api(url: string): Promise<{ status: number; body: string }>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientHttpOptions {
  fetch: FetchLike;
  apiToken?: string;
  userAgent?: string;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

const DEFAULT_USER_AGENT = "cw-code-release-check";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000;

function errorText(error: unknown): string {
  return `no response: ${error instanceof Error ? error.message : String(error)}`;
}

async function hashBody(response: Response): Promise<{ sha512: string; size: number }> {
  const hash = createHash("sha512");
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
  }
  return { sha512: hash.digest("base64"), size };
}

function totalSizeOf(response: Response): number | null {
  const range = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (response.status === 206 && range) return Number(range[1]);
  const length = response.headers.get("content-length");
  return response.status === 200 && length !== null && /^\d+$/.test(length) ? Number(length) : null;
}

export function createClientHttp(options: ClientHttpOptions): FeedMonitorHttp {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const anonymous = (headers: Record<string, string>, timeoutMs: number): RequestInit => ({
    headers: { ...headers, "User-Agent": userAgent },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });

  return {
    async text(url, accept) {
      try {
        const response = await options.fetch(url, anonymous({ Accept: accept }, requestTimeoutMs));
        return { status: response.status, body: await response.text() };
      } catch (error: unknown) {
        return { status: 0, body: errorText(error) };
      }
    },
    async digest(url) {
      try {
        const response = await options.fetch(url, anonymous({}, downloadTimeoutMs));
        if (response.status !== 200) {
          await response.body?.cancel();
          return { status: response.status, sha512: "", size: 0 };
        }
        return { status: response.status, ...(await hashBody(response)) };
      } catch {
        return { status: 0, sha512: "", size: 0 };
      }
    },
    async size(url) {
      try {
        const response = await options.fetch(url, anonymous({ Range: "bytes=0-0" }, requestTimeoutMs));
        const size = totalSizeOf(response);
        await response.body?.cancel();
        return { status: response.status, size };
      } catch {
        return { status: 0, size: null };
      }
    },
    async api(url) {
      if (!url.startsWith(GITHUB_API_ORIGIN)) throw new Error(`api() only serves ${GITHUB_API_ORIGIN} URLs, got ${url}`);
      const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": userAgent };
      if (options.apiToken) headers.Authorization = `Bearer ${options.apiToken}`;
      try {
        const response = await options.fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs) });
        return { status: response.status, body: await response.text() };
      } catch (error: unknown) {
        return { status: 0, body: errorText(error) };
      }
    }
  };
}
