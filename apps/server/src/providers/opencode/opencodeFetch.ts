export const OPENCODE_REQUEST_TIMEOUT_MS = 30_000;
export const OPENCODE_HEALTH_TIMEOUT_MS = 5_000;
export const OPENCODE_LIST_TIMEOUT_MS = 15_000;
export const OPENCODE_NO_TIMEOUT = 0;
export const OPENCODE_DIRECTORY_HEADER = "X-Opencode-Directory";

export class OpencodeConnectionError extends Error {
  readonly isConnectionError = true;
  constructor(message: string) {
    super(message);
    this.name = "OpencodeConnectionError";
  }
}

const CONNECTION_HINTS = [
  "fetch failed",
  "failed to fetch",
  "econnrefused",
  "econnreset",
  "enotfound",
  "econnaborted",
  "socket hang up",
  "terminated",
  "network",
  "load failed"
];

export function isConnectionError(err: unknown): boolean {
  if (err instanceof OpencodeConnectionError) return true;
  if (err instanceof DOMException && err.name === "AbortError") return false;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("aborted") || lower.includes("timeout") || lower.includes("timed out")) return false;
  return CONNECTION_HINTS.some((hint) => lower.includes(hint));
}

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return lower.includes("aborted") || lower.includes("timeout") || lower.includes("timed out");
}

function friendlyConnectionMessage(port: number, original: string): string {
  const short = original.slice(0, 200);
  return `opencode server unreachable at 127.0.0.1:${port} (${short}); it may have crashed or been killed, try again to restart it`;
}

export interface OpencodeFetchOptions extends RequestInit {
  timeoutMs?: number;
  port?: number;
  directory?: string;
}

export function withDirectoryQuery(url: string, directory: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}directory=${encodeURIComponent(directory)}`;
}

export async function opencodeFetch(url: string, options: OpencodeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = OPENCODE_REQUEST_TIMEOUT_MS, port, directory, ...init } = options;
  const externalSignal = init.signal;
  if (externalSignal?.aborted) throw new DOMException("aborted", "AbortError");
  const headers: Record<string, string> = {};
  const raw = init.headers;
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(raw)) {
    for (const [key, value] of raw) headers[key] = value;
  } else if (raw) {
    Object.assign(headers, raw);
  }
  if (directory) headers[OPENCODE_DIRECTORY_HEADER] = directory;
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  timer?.unref?.();
  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    return res;
  } catch (err) {
    if (externalSignal?.aborted || controller.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      if (timeoutMs > 0 && !externalSignal?.aborted) {
        throw new Error(`opencode request timed out after ${timeoutMs}ms: ${message.slice(0, 200)}`);
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (port !== undefined && isConnectionError(err)) {
      throw new OpencodeConnectionError(friendlyConnectionMessage(port, message));
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
