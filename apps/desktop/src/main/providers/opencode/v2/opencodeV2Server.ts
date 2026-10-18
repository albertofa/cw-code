import { traceHarnessCall, truncateError } from "../../../debug/harnessTrace.js";
import { OPENCODE_HEALTH_TIMEOUT_MS, opencodeFetch } from "../opencodeFetch.js";

const DRAIN_TIMEOUT_MS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function activeSessionIds(payload: unknown): string[] {
  const data = asRecord(payload)?.["data"];
  if (Array.isArray(data)) {
    return data
      .map((entry) => (typeof entry === "string" ? entry : asRecord(entry)?.["id"] ?? asRecord(entry)?.["sessionID"]))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  const record = asRecord(data);
  return record ? Object.keys(record) : [];
}

export async function interruptActiveV2Sessions(handle: { port: number; authHeader: string }): Promise<void> {
  const base = `http://127.0.0.1:${handle.port}`;
  const headers = { Authorization: handle.authHeader };
  try {
    const res = await opencodeFetch(`${base}/api/session/active`, {
      headers,
      timeoutMs: OPENCODE_HEALTH_TIMEOUT_MS,
      port: handle.port
    });
    if (!res.ok) return;
    const ids = activeSessionIds((await res.json()) as unknown);
    await Promise.race([
      Promise.allSettled(
        ids.map((id) =>
          opencodeFetch(`${base}/api/session/${encodeURIComponent(id)}/interrupt`, {
            method: "POST",
            headers,
            timeoutMs: DRAIN_TIMEOUT_MS,
            port: handle.port
          })
        )
      ),
      new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref?.())
    ]);
    if (ids.length > 0) {
      traceHarnessCall({
        harness: "opencode",
        operation: "opencode.serve.drain",
        ok: true,
        extra: { serverPort: handle.port, interrupted: ids.length }
      });
    }
  } catch (err) {
    traceHarnessCall({
      harness: "opencode",
      operation: "opencode.serve.drain",
      ok: false,
      error: truncateError((err as Error).message),
      extra: { serverPort: handle.port }
    });
  }
}
