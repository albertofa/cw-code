import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

function opencodeDataDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode");
}

function opencodeDbPath(env: NodeJS.ProcessEnv, home: string): string | null {
  const configured = env.OPENCODE_DB?.trim();
  if (configured === ":memory:") return null;
  if (!configured) return join(opencodeDataDir(env, home), "opencode.db");
  return isAbsolute(configured) ? configured : join(opencodeDataDir(env, home), configured);
}

interface CredentialRow {
  integration_id: string | null;
  value: string;
  active: number | null;
  time_updated: number;
}

function parseCredentialValue(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function opencodeV2Tokens(rows: CredentialRow[], now: number): string[] {
  const ranked = [...rows].sort((a, b) => Number(b.active === 1) - Number(a.active === 1) || b.time_updated - a.time_updated);
  const oauth: string[] = [];
  const apiKeys: string[] = [];
  for (const row of ranked) {
    const value = parseCredentialValue(row.value);
    if (!value) continue;
    if (row.integration_id === "opencode" && value["type"] === "oauth") {
      const access = value["access"];
      const expires = value["expires"];
      if (typeof access === "string" && access && typeof expires === "number" && expires > now) oauth.push(access);
    } else if (row.integration_id === "opencode-go" && typeof value["key"] === "string" && value["key"]) {
      apiKeys.push(value["key"]);
    }
  }
  return [...oauth, ...apiKeys];
}

/** OpenCode v2 keeps sign-ins in its SQLite `credential` table instead of auth.json. Never log or surface the tokens. */
export async function readOpencodeV2Tokens(env: NodeJS.ProcessEnv, home: string, now: number): Promise<string[]> {
  const dbPath = opencodeDbPath(env, home);
  if (!dbPath || !existsSync(dbPath)) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'").get();
      if (!hasTable) return [];
      const rows = db.prepare("SELECT integration_id, value, active, time_updated FROM credential").all() as unknown as CredentialRow[];
      return opencodeV2Tokens(rows, now);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`opencode credential store unreadable, falling back to auth.json: ${(err as Error).message}`);
    return [];
  }
}

/** Never log or surface `key`: it is read only to be placed in the fetch Authorization header. */
export function readOpencodeGoKey(env: NodeJS.ProcessEnv, home: string): OpencodeGoKeyResult {
  const authPath = join(opencodeDataDir(env, home), "auth.json");
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
  const v2Tokens = await readOpencodeV2Tokens(deps.env, deps.home, Date.now());
  const tokens = [...new Set(keyResult.status === "found" ? [...v2Tokens, keyResult.key] : v2Tokens)];
  if (tokens.length === 0) {
    return keyResult.status === "malformed"
      ? { status: "error", message: AUTH_FILE_UNREADABLE_MESSAGE }
      : { status: "unavailable", reason: "no-subscription", message: NO_SUBSCRIPTION_MESSAGE };
  }
  let result: AccountUsageState = { status: "unavailable", reason: "key-rejected", message: KEY_REJECTED_MESSAGE };
  for (const token of tokens) {
    result = await requestOpencodeGoUsage(token, deps.fetchFn);
    if (result.status !== "unavailable" || result.reason !== "key-rejected") return result;
  }
  return result;
}

async function requestOpencodeGoUsage(key: string, fetchFn: typeof fetch): Promise<AccountUsageState> {
  if (!isValidOpencodeGoKey(key)) {
    return { status: "unavailable", reason: "key-rejected", message: KEY_REJECTED_MESSAGE };
  }
  let res: Response;
  try {
    res = await fetchFn(OPENCODE_GO_USAGE_URL, {
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
