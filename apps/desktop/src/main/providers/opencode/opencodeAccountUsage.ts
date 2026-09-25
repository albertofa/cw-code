import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountUsageState, UsageSeverity, UsageWindow } from "@cw-code/contracts";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_TIMEOUT_MS = 15_000;
const NO_SUBSCRIPTION_MESSAGE = "No OpenCode Go subscription found";
const KEY_REJECTED_MESSAGE = "Run `opencode auth login` and pick OpenCode Go";
const AUTH_FILE_UNREADABLE_MESSAGE = "Couldn't read OpenCode's auth file";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type OpencodeGoKeyResult =
  | { status: "not-found" }
  | { status: "malformed" }
  | { status: "found"; key: string };

/** Never log or surface `key`: it is read only to be placed in the fetch Authorization header. */
export function readOpencodeGoKey(env: NodeJS.ProcessEnv, home: string): OpencodeGoKeyResult {
  const base = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const authPath = join(base, "opencode", "auth.json");
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch {
    return { status: "not-found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed" };
  }
  const root = asRecord(parsed);
  if (!root || !("opencode-go" in root)) return { status: "not-found" };
  const entry = asRecord(root["opencode-go"]);
  const key = entry?.["key"];
  if (typeof key !== "string" || !key) return { status: "malformed" };
  return { status: "found", key };
}

function isValidOpencodeGoKey(key: string): boolean {
  return key.length > 0 && !/[\s\x00-\x1F\x7F]/.test(key);
}

function networkErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "OpenCode Go usage request timed out";
  return "Couldn't reach opencode.ai";
}

const WINDOW_DEFS: Array<{ key: string; id: string; label: string }> = [
  { key: "rolling", id: "rolling", label: "5-hour" },
  { key: "weekly", id: "weekly", label: "Weekly" },
  { key: "monthly", id: "monthly", label: "Monthly" }
];

export function mapOpencodeGoUsage(body: unknown): AccountUsageState {
  const usage = asRecord(asRecord(body)?.["usage"]);
  if (!usage) return { status: "error", message: "Unexpected OpenCode Go usage response" };
  const windows: UsageWindow[] = [];
  for (const def of WINDOW_DEFS) {
    const raw = asRecord(usage[def.key]);
    if (!raw) continue;
    const percent = typeof raw["percent"] === "number" ? raw["percent"] : undefined;
    if (percent === undefined) continue;
    const status = typeof raw["status"] === "string" ? raw["status"] : undefined;
    const resetsAtRaw = typeof raw["resetsAt"] === "string" ? raw["resetsAt"] : undefined;
    const resetsAtMs = resetsAtRaw ? Date.parse(resetsAtRaw) : NaN;
    const severity: UsageSeverity = status === "rate-limited" || percent >= 100 ? "blocked" : percent >= 80 ? "warning" : "normal";
    windows.push({
      id: def.id,
      label: def.label,
      percent,
      ...(Number.isFinite(resetsAtMs) ? { resetsAt: resetsAtMs } : {}),
      severity
    });
  }
  if (windows.length === 0) return { status: "error", message: "Unexpected OpenCode Go usage response" };
  return {
    status: "ok",
    plan: "OpenCode Go",
    windows,
    balances: [],
    notes: ["Percent only. Dollar caps depend on the model."]
  };
}

export interface OpencodeGoUsageDeps {
  fetchFn: typeof fetch;
  env: NodeJS.ProcessEnv;
  home: string;
}

export async function fetchOpencodeGoUsage(enabled: boolean, deps: OpencodeGoUsageDeps): Promise<AccountUsageState> {
  if (!enabled) {
    return {
      status: "unavailable",
      reason: "consent-required",
      message: "Allow cw-code to read your OpenCode Go key to show plan limits"
    };
  }
  const keyResult = readOpencodeGoKey(deps.env, deps.home);
  if (keyResult.status === "not-found") {
    return { status: "unavailable", reason: "no-subscription", message: NO_SUBSCRIPTION_MESSAGE };
  }
  if (keyResult.status === "malformed") {
    return { status: "error", message: AUTH_FILE_UNREADABLE_MESSAGE };
  }
  const key = keyResult.key;
  if (!isValidOpencodeGoKey(key)) {
    return { status: "unavailable", reason: "key-rejected", message: KEY_REJECTED_MESSAGE };
  }
  let res: Response;
  try {
    res = await deps.fetchFn(OPENCODE_GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "cw-code" },
      redirect: "error",
      signal: AbortSignal.timeout(OPENCODE_GO_TIMEOUT_MS)
    });
  } catch (err) {
    return { status: "error", message: networkErrorMessage(err) };
  }
  if (res.status === 401) {
    return { status: "unavailable", reason: "key-rejected", message: KEY_REJECTED_MESSAGE };
  }
  if (res.status === 403) {
    return { status: "unavailable", reason: "no-subscription", message: NO_SUBSCRIPTION_MESSAGE };
  }
  if (!res.ok) {
    return { status: "error", message: `OpenCode Go usage request failed: ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "error", message: "Unexpected OpenCode Go usage response" };
  }
  return mapOpencodeGoUsage(body);
}
