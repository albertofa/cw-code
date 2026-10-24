import type { AccountUsageState, UsageBalance, UsageSeverity, UsageWindow } from "@cw-code/contracts";

const UNEXPECTED_RATE_LIMITS_MESSAGE = "Unexpected account/rateLimits/read response";

const PLAN_LABELS: Record<string, string> = {
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Team",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
  go: "ChatGPT Go",
  free: "ChatGPT Free"
};

interface CodexUsageWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

interface CodexUsageSnapshot {
  id: string;
  limitName: string | null;
  planType: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  rateLimitReachedType: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseWindow(value: unknown): CodexUsageWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const usedPercent = record["usedPercent"];
  const windowDurationMins = record["windowDurationMins"];
  const resetsAt = record["resetsAt"];
  if (typeof usedPercent !== "number" || typeof windowDurationMins !== "number" || typeof resetsAt !== "number") {
    return null;
  }
  return { usedPercent, windowDurationMins, resetsAt };
}

function parseSnapshot(value: unknown, id: string): CodexUsageSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const limitName = typeof record["limitName"] === "string" ? record["limitName"] : null;
  const planType = typeof record["planType"] === "string" ? record["planType"] : null;
  const creditsRecord = asRecord(record["credits"]);
  const credits = creditsRecord
    ? {
        hasCredits: creditsRecord["hasCredits"] === true,
        unlimited: creditsRecord["unlimited"] === true,
        balance: typeof creditsRecord["balance"] === "string" ? creditsRecord["balance"] : null
      }
    : null;
  const rateLimitReachedType = typeof record["rateLimitReachedType"] === "string" ? record["rateLimitReachedType"] : null;
  return {
    id,
    limitName,
    planType,
    primary: parseWindow(record["primary"]),
    secondary: parseWindow(record["secondary"]),
    credits,
    rateLimitReachedType
  };
}

function collectSnapshots(rateLimitsRecord: Record<string, unknown> | null): CodexUsageSnapshot[] {
  if (!rateLimitsRecord) return [];
  const byId = asRecord(rateLimitsRecord["rateLimitsByLimitId"]);
  if (byId) {
    const snapshots: CodexUsageSnapshot[] = [];
    for (const [id, value] of Object.entries(byId)) {
      const snapshot = parseSnapshot(value, id);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }
  const snapshot = parseSnapshot(rateLimitsRecord["rateLimits"], "codex");
  return snapshot ? [snapshot] : [];
}

function windowLabel(windowDurationMins: number): string {
  if (windowDurationMins === 300) return "5-hour window";
  if (windowDurationMins === 10080) return "Weekly window";
  if (windowDurationMins < 60) return `${windowDurationMins}m window`;
  const hours = Math.round((windowDurationMins / 60) * 10) / 10;
  const hoursLabel = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${hoursLabel}h window`;
}

function severityFor(percent: number, reached: boolean): UsageSeverity {
  if (reached || percent >= 100) return "blocked";
  if (percent >= 80) return "warning";
  return "normal";
}

function windowsForSnapshot(snapshot: CodexUsageSnapshot, now: number): UsageWindow[] {
  const out: UsageWindow[] = [];
  const slots: Array<["primary" | "secondary", CodexUsageWindow | null]> = [
    ["primary", snapshot.primary],
    ["secondary", snapshot.secondary]
  ];
  for (const [slot, window] of slots) {
    if (!window) continue;
    const resetsAt = window.resetsAt * 1000;
    const isPast = resetsAt <= now;
    const percent = isPast ? 0 : window.usedPercent;
    const base = windowLabel(window.windowDurationMins);
    const label = snapshot.limitName && snapshot.limitName !== "codex" ? `${snapshot.limitName} · ${base}` : base;
    out.push({
      id: `${snapshot.id}:${slot}`,
      label,
      percent,
      resetsAt,
      severity: isPast ? "normal" : severityFor(percent, snapshot.rateLimitReachedType !== null)
    });
  }
  return out;
}

function balancesFor(rateLimitsRecord: Record<string, unknown> | null, snapshots: CodexUsageSnapshot[]): UsageBalance[] {
  const balances: UsageBalance[] = [];
  const creditsSnapshot = snapshots.find((s) => s.credits !== null);
  const credits = creditsSnapshot?.credits ?? null;
  const unlimited = credits?.unlimited === true;
  balances.push({
    id: "credits",
    label: "Credits",
    enabled: unlimited || (credits?.hasCredits ?? false),
    detail: unlimited ? "Unlimited" : (credits?.balance ?? "None")
  });
  const resetCredits = asRecord(rateLimitsRecord?.["rateLimitResetCredits"] ?? null);
  const availableCount = resetCredits?.["availableCount"];
  if (typeof availableCount === "number") {
    balances.push({
      id: "resetCredits",
      label: "Limit reset credits",
      enabled: true,
      detail: `${availableCount} available`
    });
  }
  return balances;
}

function planLabel(planType: string | null): string | undefined {
  if (planType === null) return undefined;
  return PLAN_LABELS[planType] ?? planType;
}

function accountOf(accountRes: unknown): Record<string, unknown> | null {
  const accountRecord = asRecord(accountRes);
  return accountRecord ? asRecord(accountRecord["account"]) : null;
}

function unexpectedRateLimitsShape(): AccountUsageState {
  console.warn(`codex account/rateLimits/read: ${UNEXPECTED_RATE_LIMITS_MESSAGE.toLowerCase()}`);
  return { status: "error", message: UNEXPECTED_RATE_LIMITS_MESSAGE };
}

export function mapCodexAccountGate(accountRes: unknown): AccountUsageState | null {
  const account = accountOf(accountRes);
  if (!account) {
    return { status: "unavailable", reason: "logged-out", message: "Sign in to Codex CLI to see plan usage." };
  }
  if (account["type"] === "apiKey") {
    return { status: "unavailable", reason: "api-key", message: "Signed in with an API key; plan limits aren't available." };
  }
  return null;
}

export function mapCodexUsage(accountRes: unknown, rateLimitsRes: unknown, now: number): AccountUsageState {
  const gate = mapCodexAccountGate(accountRes);
  if (gate) return gate;
  const account = accountOf(accountRes) as Record<string, unknown>;

  const rateLimitsRecord = asRecord(rateLimitsRes);
  const snapshots = collectSnapshots(rateLimitsRecord);
  const windows = snapshots.flatMap((snapshot) => windowsForSnapshot(snapshot, now));
  if (windows.length === 0) return unexpectedRateLimitsShape();

  const balances = balancesFor(rateLimitsRecord, snapshots);
  const accountPlanType = typeof account["planType"] === "string" ? account["planType"] : null;
  const planType = snapshots.find((s) => s.planType !== null)?.planType ?? accountPlanType;

  return {
    status: "ok",
    ...(planLabel(planType) !== undefined ? { plan: planLabel(planType) as string } : {}),
    windows,
    balances,
    notes: []
  };
}
