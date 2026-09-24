import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { AccountUsageState, UsageBalance, UsageSeverity, UsageWindow } from "@cw-code/contracts";
import { killProcessTree } from "../../processTree.js";

export const CLAUDE_ACCOUNT_USAGE_PROBE_ARGS = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--no-session-persistence"
];

export const CLAUDE_ACCOUNT_USAGE_TIMEOUT_MS = 20_000;

const UNEXPECTED_SHAPE_MESSAGE = "Unexpected get_usage response";

function titleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function severityOf(raw: unknown, percent: number): UsageSeverity {
  if (percent >= 100) return "blocked";
  if (raw === "warning" || raw === "high" || raw === "critical") return "warning";
  return "normal";
}

function scopeModelName(scope: unknown): string | undefined {
  if (scope === null || typeof scope !== "object") return undefined;
  const model = (scope as Record<string, unknown>)["model"];
  if (model === null || typeof model !== "object") return undefined;
  const displayName = (model as Record<string, unknown>)["display_name"];
  return typeof displayName === "string" && displayName ? displayName : undefined;
}

function windowLabel(kind: string, scope: unknown): string {
  if (kind === "session") return "Current session";
  if (kind === "weekly_all") return "Weekly · all models";
  if (kind === "weekly_scoped") {
    const modelName = scopeModelName(scope);
    return modelName ? `Weekly · ${modelName}` : "Weekly";
  }
  return titleCase(kind);
}

function windowId(kind: string, scope: unknown): string {
  const modelName = scopeModelName(scope);
  return modelName ? `${kind}:${modelName}` : kind;
}

interface RateLimitRow {
  kind?: unknown;
  percent?: unknown;
  severity?: unknown;
  resets_at?: unknown;
  scope?: unknown;
  is_active?: unknown;
}

function mapWindow(row: unknown): UsageWindow | null {
  if (row === null || typeof row !== "object") return null;
  const { kind, percent, severity, resets_at: resetsAtRaw, scope, is_active: isActive } = row as RateLimitRow;
  if (typeof kind !== "string" || !kind || typeof percent !== "number") return null;
  const resetsAt = toEpochMs(resetsAtRaw);
  return {
    id: windowId(kind, scope),
    label: windowLabel(kind, scope),
    percent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    severity: severityOf(severity, percent),
    ...(typeof isActive === "boolean" ? { active: isActive } : {})
  };
}

function withUniqueIds(windows: UsageWindow[]): UsageWindow[] {
  const seen = new Map<string, number>();
  return windows.map((window) => {
    const count = seen.get(window.id) ?? 0;
    seen.set(window.id, count + 1);
    return count === 0 ? window : { ...window, id: `${window.id}-${count + 1}` };
  });
}

interface ExtraUsageRow {
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
  currency?: unknown;
}

function mapExtraUsageBalance(extraUsage: unknown): UsageBalance | null {
  if (extraUsage === null || typeof extraUsage !== "object") return null;
  const { is_enabled: isEnabled, monthly_limit: monthlyLimit, used_credits: usedCredits, currency } =
    extraUsage as ExtraUsageRow;
  if (isEnabled !== true) {
    return { id: "extra-usage", label: "Extra usage", enabled: false, detail: "Disabled" };
  }
  const limitMinor = typeof monthlyLimit === "number" ? monthlyLimit : undefined;
  const usedMinor = typeof usedCredits === "number" ? usedCredits : undefined;
  return {
    id: "extra-usage",
    label: "Extra usage",
    enabled: true,
    ...(usedMinor !== undefined ? { usedMinor } : {}),
    ...(limitMinor !== undefined ? { limitMinor } : {}),
    ...(typeof currency === "string" && currency ? { currency } : {})
  };
}

interface GetUsageResponse {
  subscription_type?: unknown;
  rate_limits_available?: unknown;
  rate_limits?: {
    limits?: unknown;
    extra_usage?: unknown;
  };
}

interface ControlResponseEnvelope {
  type?: unknown;
  response?: {
    subtype?: unknown;
    request_id?: unknown;
    response?: unknown;
  };
}

function unexpectedShape(): AccountUsageState {
  console.warn(`claude get_usage: ${UNEXPECTED_SHAPE_MESSAGE.toLowerCase()}`);
  return { status: "error", message: UNEXPECTED_SHAPE_MESSAGE };
}

export function mapClaudeUsage(response: unknown): AccountUsageState {
  if (response === null || typeof response !== "object") return unexpectedShape();
  const envelope = response as ControlResponseEnvelope;
  if (envelope.type !== "control_response" || envelope.response?.subtype !== "success") {
    return {
      status: "unavailable",
      reason: "unsupported-version",
      message: "Claude CLI returned an unexpected response to get_usage."
    };
  }
  const body = envelope.response.response;
  if (body === null || typeof body !== "object") return unexpectedShape();
  const { subscription_type: subscriptionType, rate_limits_available: rateLimitsAvailable, rate_limits: rateLimits } =
    body as GetUsageResponse;
  if (rateLimitsAvailable === false || subscriptionType === null) {
    return {
      status: "unavailable",
      reason: "api-key",
      message: "Claude is signed in with an API key; plan limits aren't available."
    };
  }
  if (typeof subscriptionType !== "string" || !subscriptionType) return unexpectedShape();
  const limits = rateLimits?.limits;
  if (!Array.isArray(limits)) return unexpectedShape();

  let droppedRows = 0;
  const windows: UsageWindow[] = [];
  for (const row of limits) {
    const window = mapWindow(row);
    if (window) windows.push(window);
    else droppedRows += 1;
  }
  const notes: string[] = [];
  if (windows.length === 0) {
    if (droppedRows > 0) console.warn(`claude get_usage: dropped ${droppedRows} malformed rate limit row(s)`);
    notes.push("Claude reported no plan windows for this account");
  }

  const balances: UsageBalance[] = [];
  const extraUsageBalance = mapExtraUsageBalance(rateLimits?.extra_usage);
  if (extraUsageBalance) balances.push(extraUsageBalance);
  return { status: "ok", plan: titleCase(subscriptionType), windows: withUniqueIds(windows), balances, notes };
}

function matchesRequest(line: string, requestId: string): unknown | null {
  if (!line.trim().startsWith("{")) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  const envelope = msg as ControlResponseEnvelope;
  if (envelope.type !== "control_response" || envelope.response?.request_id !== requestId) return null;
  return msg;
}

const STDERR_PREVIEW_MAX = 300;

function previewStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  return trimmed.length <= STDERR_PREVIEW_MAX ? trimmed : `${trimmed.slice(0, STDERR_PREVIEW_MAX)}…`;
}

function spawnErrorState(binary: string, err: NodeJS.ErrnoException): AccountUsageState {
  if (err.code === "ENOENT") {
    return { status: "unavailable", reason: "not-installed", message: "Claude isn't installed. Set its path in Settings → Harnesses → Claude." };
  }
  return { status: "error", message: `failed to spawn ${binary}: ${err.message}` };
}

export function probeClaudeAccountUsage(
  binary: string,
  args: string[],
  spawnFn: typeof spawn = spawn,
  killFn: (proc: ChildProcess | undefined) => void = killProcessTree
): Promise<AccountUsageState> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(binary, args, { cwd: homedir(), windowsHide: true }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      resolve(spawnErrorState(binary, err as NodeJS.ErrnoException));
      return;
    }

    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      const preview = previewStderr(stderr);
      settle({
        status: "error",
        message: `claude get_usage probe timed out after ${CLAUDE_ACCOUNT_USAGE_TIMEOUT_MS}ms${preview ? ` (stderr: ${preview})` : ""}`
      });
    }, CLAUDE_ACCOUNT_USAGE_TIMEOUT_MS);
    timer.unref?.();

    function settle(state: AccountUsageState): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
      }
      if (child.exitCode === null) killFn(child);
      resolve(state);
    }

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const msg = matchesRequest(line, requestId);
      if (msg === null) return;
      settle(mapClaudeUsage(msg));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      settle(spawnErrorState(binary, err as NodeJS.ErrnoException));
    });
    child.on("close", () => {
      const preview = previewStderr(stderr);
      settle({
        status: "error",
        message: `claude get_usage probe exited before responding${preview ? ` (stderr: ${preview})` : ""}`
      });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.write(
      `${JSON.stringify({ type: "control_request", request_id: "i1", request: { subtype: "initialize" } })}\n`
    );
    child.stdin?.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "get_usage", skip_behaviors: true }
      })}\n`
    );
  });
}
